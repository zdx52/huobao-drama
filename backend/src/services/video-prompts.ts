/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 进程内内存态：按集跟踪一份任务，运行中不重复启动；重启后状态丢失
 *
 * 2026-10-10 长度治理的最终形态（前两版都失败，教训留在这里）：
 *  v1 全文一次写完 → Agent 不数字符数（sb147 写到 7823 仍以为没超）→ 拼上风格头 8414 → 被 7000 拒
 *  v2 逼 Agent「只输出本轮那几段」→ 与技能「六个段名固定、顺序固定」正面冲突，
 *     Agent 每轮照技能输出完整八段 → 每轮都超配额 → 全部重试失败 → 整条放弃、不落库
 *     （表现：用户点了重新生成，但库里的英文版一字未改，测试还照旧报 8414）
 *  v3（本版）不与 Agent 的固有行为较劲：
 *     ① 第 1 轮照技能写**完整八段**（这本来就是它最自然的输出）
 *     ② 后端按段名切段、逐组实测
 *     ③ **只对超标的那一组**下发「压缩这一组」的重写，并容错抽取
 *        （Agent 若又输出全文，后端只取那几段，不判失败）
 *     ④ 八段全部达标才拼起来落库；任一组压不下去才整条记失败
 *  配额之和 = 5920（含换行）≤ 6200 = 全文上限 → 「每组达标 ⇒ 必然不超」。
 */
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface VideoPromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
}

const tasks = new Map<number, VideoPromptBatchStatus>()

/** video_prompt_en 全文硬上限（含换行与标点），与 video-prompt 技能「英文发送版」节一致：
 *  MiniMax H3 官方 7000 字符 hard limit − 发送时拼的风格头 591 − 余量 ≈ 6200。 */
export const PROMPT_EN_LIMIT = 6200
/** 每一层（整体生成 / 单组重写）的重试次数上限 */
const MAX_SEG_RETRY = 3

/** 段名 → 字符配额（顺序即文档顺序） */
const EN_SECTION_QUOTA: Array<[string, number]> = [
  // 2026-10-10 晚：撤掉自加的 CAST/BLOCKING 顶层段，回到官方 Ref2VA 六段（官方只有这六段）。
  // 配额按官方口径重配：detailed_description 官方要 350–500 英文词（≈1750–2500 字符），
  // 原 1900 卡在下限偏少 → 提到 2500；non_diegetic_music 官方要 1–3 句，原 40 写不完 → 120。
  // 合计 5720（+ 5 个换行 = 5725）≤ 6200 = 全文硬上限。
  ['subject_definitions:', 1700],
  ['summary:', 340],
  ['retention_analysis:', 760],
  ['detailed_description:', 2500],
  ['overall_soundscape:', 300],
  ['non_diegetic_music:', 120],
]

/** 核定/重写分组：相邻段一起处理，limit = 组内配额之和。
 *  六段配额相加 = 5720；全部达标后拼接总长 ≤ 5725 < 6200 = PROMPT_EN_LIMIT。 */
const EN_STAGES: Array<{ key: string; label: string; segs: string[]; limit: number }> = [
  { key: 'subj', label: 'subject_definitions 段', limit: 1700, segs: ['subject_definitions:'] },
  { key: 'summ', label: 'summary 和 retention_analysis 两段', limit: 1100, segs: ['summary:', 'retention_analysis:'] },
  {
    key: 'detail',
    label: 'detailed_description、overall_soundscape、non_diegetic_music 三段',
    limit: 2920,
    segs: ['detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'],
  },
]

/** 段名标记（正则片段），用于把 Agent 输出里段名之前的解释性前言裁掉 */
const SEG_MARKERS = EN_SECTION_QUOTA.map(([s]) => s).join('|')

/** 清洗 Agent 输出：去代码块围栏、去段名之前的废话、去尾部结语。循环跑到稳定
 *  （围栏与前言同时出现时单趟清理会残留尾部围栏）。 */
function cleanSegText(raw: string): string {
  let s = String(raw || '').trim()
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s.replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    s = s.replace(/\n?\s*```\s*$/, '')
    const at = s.search(new RegExp(`(?:^|\\n)(?:${SEG_MARKERS})`))
    if (at > 0) s = s.slice(at)
    s = s.replace(/\n+(?:以上[^\n]{0,80}|希望对[^\n]{0,80}|如需[^\n]{0,80})\s*$/, '')
    s = s.trim()
    if (s === before) break
  }
  return s
}

/** 按段名切段 → Map<段名, 内容>（段名优先按行首匹配，切不出任何段返回空 Map） */
function splitEnSections(t: string): Map<string, string> {
  const found = EN_SECTION_QUOTA
    .map(([seg]) => {
      const at = t.indexOf('\n' + seg)
      return { seg, i: at >= 0 ? at + 1 : t.indexOf(seg) }
    })
    .filter(x => x.i >= 0)
    .sort((a, b) => a.i - b.i)
  const m = new Map<string, string>()
  found.forEach((p, n) => {
    const end = n + 1 < found.length ? found[n + 1].i - 1 : t.length
    m.set(p.seg, t.slice(p.i, end).trim())
  })
  return m
}

/** 从任意输出里抽出指定几段（Agent 不听话又输出全文也能救回来；缺任一指定段返回 null） */
function extractSections(raw: string, segs: string[]): string | null {
  const m = splitEnSections(raw)
  const picked: string[] = []
  for (const s of segs) {
    const v = m.get(s)
    if (!v) return null
    picked.push(v)
  }
  return picked.join('\n')
}

/** 某组内容是否合格：非空、段名齐全、且不超该组配额 */
function groupProblem(text: string, stage: { segs: string[]; limit: number }): string | null {
  if (!text) return '这一组没有内容'
  const missing = stage.segs.filter(mk => !text.includes(mk))
  if (missing.length) return `缺少这些段：${missing.join(' ')}`
  if (text.length > stage.limit) return `实测 ${text.length} 字符，超 ${stage.limit} 上限 ${text.length - stage.limit} 字符`
  return null
}

/** 中英一致性程序校验：返回问题描述（null = 通过）。
 *  2026-10-10 立：英文版是 H3 唯一消费的版本，中文工作版只是给人看的 —— 两边必须逐拍对齐。
 *  否则中文版改对了时间轴、英文版还是旧的，成片照旧出问题（sb302 实测：中文 0/2/5/8 秒，
 *  英文 0/3/6/8 秒 → 第 3 拍只剩 2 秒窗口装 11 字 → 旁白拖尾原样复现）。 */
function zhEnConsistency(enText: string, zhPrompt?: string): string | null {
  if (!enText) return '英文版为空'
  // ① HTML 实体：模型偶发把 <Subject 1> 写成 &lt;Subject 1&gt;，H3 会完全不认识 → 身份绑定失效
  if (/&lt;|&gt;|&amp;/.test(enText)) {
    return '英文版出现 HTML 实体（&lt; / &gt; / &amp;）：<Subject N>/<Picture N>/<Audio N>/<d> 必须用裸尖括号'
  }
  if (!zhPrompt) return null
  // ② 时间轴逐拍对齐：中文「X-Y秒」的起点序列 = 英文第 2 拍起的 At 00:XX.000 序列（第 1 拍无时间戳）
  const zhStarts = [...zhPrompt.matchAll(/^\s*(\d+)\s*-\s*\d+\s*秒\s*[：:]/gm)].map(m => Number(m[1]))
  const enStarts = [...enText.matchAll(/\[Shot \d+\]\s*At\s*00:(\d+)\.000/g)].map(m => Number(m[1]))
  const expect = zhStarts.slice(1)
  if (expect.length && enStarts.length && expect.join(',') !== enStarts.join(',')) {
    return `英文版每拍起始秒数 [${enStarts.join(',')}] 与中文工作版 [${zhStarts.join(',')}] 不一致；英文第 2 拍起应依次为 [${expect.join(',')}]`
  }
  // ③ 台词条数一致：中文「旁白/X说：「…」」句数 = 英文 <d> 条数
  const zhLines = (zhPrompt.match(/(?:旁白|说)[^「\n]{0,30}「/g) || []).length
  const enLines = (enText.match(/<d>/g) || []).length
  if (zhLines !== enLines) {
    return `中英台词条数不一致：中文工作版 ${zhLines} 句，英文版 <d> ${enLines} 条（必须逐条对应，一句不多一句不少）`
  }
  return null
}

/** 第 1 轮指令：照技能写完整八段（与技能「六段固定、顺序固定」一致，不冲突）。
 *  ⚠️ 关键设计：**给"目标长度"而不是只给"上限"** —— 实测 Agent 对"≤6200"无感
 *  （写成 7746 仍以为没问题），但对"这段约 1500 字符"有明确落点，一次就能写到位。
 *  目标值取配额的 ~80%，合计约 4900，远低于硬上限，留足余量、也避免回头压缩（压缩要重跑，很慢）。 */
function buildFullPrompt(sb: { id: number; storyboardNumber: number | null }, videoLabel: string, extra?: string, zhPrompt?: string): string {
  const targets = EN_SECTION_QUOTA
    .map(([s, q]) => `${s.replace(':', '')} 约${Math.round(q * 0.8 / 10) * 10}`)
    .join(' / ')
  // 2026-10-10：中文工作版先于英文版生成，其时间轴就是本次的基准。
  // 只把「X-Y秒」那几行抽出来给英文版，避免把整份中文塞进 prompt 稀释注意力。
  const zhTimeline = zhPrompt
    ? (zhPrompt.match(/^\s*\d+\s*-\s*\d+\s*秒[：:].*$/gm) || []).join('\n')
    : ''
  return `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词 video_prompt_en（H3 官方 Ref2VA 六段式 + 前置 CAST/BLOCKING）。视频模型:${videoLabel}。

请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长；格式与规则见 video-prompt 技能「英文发送版」节。

🔴 长度要求（**一开始就写到位，不要写完再回头压** —— 压缩必须重跑一遍，很浪费）：
- **目标长度 4600~5600 字符**（完整提示词，含换行与标点）。
- 逐段目标：${targets}
- **硬上限 6200 字符**：写入时后端会校验，超了直接拒绝并要求重写。MiniMax H3 上限 7000，发送时还要拼 591 字符风格头。
- **宁可精炼**：每段只说必要的，形容词能省则省，但必须保住下面这些不许砍的内容。

绝不许为了压长度而砍：<d> 台词、retention_analysis 的 fully_preserved、<Picture N> 的 with 外观、CAST 数量锁、BLOCKING 的 180 轴线。
${zhTimeline ? `
🔴🔴 **时间轴基准（本次中文工作版已定，必须逐拍对齐，绝不许自己另算）**：
中文工作版每一拍的起止秒数如下 —— 英文版第 N 拍的 \`[Shot N] At MM:SS.mmm\` **起始秒数必须与中文第 N 拍的起点逐拍一致**（例：中文第 2 拍 \`2-5秒\` → 英文 \`[Shot 2] At 00:02.000\`；中文第 3 拍 \`5-8秒\` → 英文 \`[Shot 3] At 00:05.000\`）。第 1 拍不带时间戳。**中文版改了时间轴，英文版就必须跟着改。**

${zhTimeline}
` : ''}
${extra ? `\n\n【补充说明 — 必须在生成时逐条满足】\n${extra}\n（若该分镜已有 video_prompt_en，read_storyboard_context 会返回现值，请在其基础上按补充说明改写，不要把补充说明当新剧情编造。）` : ''}

**直接输出提示词正文**：不要解释、前言、结语；不要用代码块围栏；不要调用任何保存工具（后端负责落库）。`
}

/** 单组重写指令：只压这一组，其他组已定稿。
 *  ⚠️ 关键是**告诉它怎么砍**：早先只写"绝不许砍 XXX"，Agent 什么都不敢删 →
 *  反复重写仍是 7746（实测 sb147 卡了 10 分钟一个字没改进去）。 */
function buildRewritePrompt(
  sb: { id: number; storyboardNumber: number | null },
  stage: { label: string; segs: string[]; limit: number },
  current: string,
  problem: string,
  attempt: number,
  extra?: string,
  zhPrompt?: string,
): string {
  const segQuota = stage.segs
    .map(s => `${s.replace(':', '')} ≤${(EN_SECTION_QUOTA.find(([k]) => k === s) || ['', 0])[1]}`)
    .join(' / ')
  const zhTimeline = zhPrompt
    ? (zhPrompt.match(/^\s*\d+\s*-\s*\d+\s*秒[：:].*$/gm) || []).join('\n')
    : ''
  return `分镜 #${sb.storyboardNumber}(ID:${sb.id}) 的 video_prompt_en 需要局部压缩（第 ${attempt} 次）。

问题：${stage.label} 这一组，${problem}。

**怎么压（照做，这些都是安全的）**：
1. 删修饰性形容词与程度词：\`wind-and-oil weathered wheat-toned skin\` → \`weathered skin\`；\`slightly\` / \`very\` / \`gently\` / \`faintly\` 一律删
2. 同一件事只说一遍：BLOCKING 里写过的站位与朝向，detailed_description 里不再重复
3. \`subject_definitions\` 每个主体只留 5~6 个辨识特征（脸型 / 发型 / 服装主色 / 关键道具），其余删
4. \`retention_analysis\` 每条压成一句话：\`<Subject N> (appears in ...): fully_preserved - <一句>\`，不要重述外观细节
5. 镜头描述去掉氛围补充：\`soft modelling\`、\`light level unchanged\`、\`consistent exposure\` 这类删掉
6. \`overall_soundscape\` 只留 3~5 个主要音效，其余删
7. 删掉所有重复的 "stays identical to the reference" 类尾句，保留一次即可

**必须保留（砍了会穿帮）**：
- <d>…</d> 里的台词原文（一个字都不能改）
- 每个 Subject 的 fully_preserved 字样（retention 状态不能降级）
- <Picture N> 编号（参考图绑定）
- CAST 里的数量锁（exactly one / no duplicates 那几句）
- BLOCKING 里的 180 轴线句
- 主体编号与名称的对应关系
${zhTimeline ? `\n**🔴 时间轴必须与中文工作版逐拍一致（压缩时不许改动任何秒数）**：\n${zhTimeline}\n` : ''}
${extra ? `\n**压缩时仍必须继续满足补充说明**：${extra}\n` : ''}输出要求：**只压缩【${stage.label}】**并压到 ≤ ${stage.limit} 字符（组内逐段：${segQuota}）；输出这一组内容（保留段名行）；其他组不用输出；不要解释、前言、结语；不要代码块围栏；不要调用任何保存工具。

【待压缩的原文】
${current}`
}

/** 诊断日志：把每轮 Agent 的原始输出记到 data/debug/video-prompt.log，便于事后复盘 */
export function debugLog(episodeId: number, sbId: number, tag: string, text: string, extra?: Record<string, unknown>) {
  try {
    const dir = path.join(STORAGE_ROOT, 'debug')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'video-prompt.log'),
      JSON.stringify({ t: new Date().toISOString(), episodeId, storyboardId: sbId, tag, len: text.length, head: text.slice(0, 200), ...(extra || {}) }) + '\n',
      'utf-8',
    )
  } catch {
    /* 诊断日志失败不影响主流程 */
  }
}

/** 生成完整 video_prompt_en：整体生成 → 逐组核定 → 只重写超标组 */
async function generateEnByStages(
  agent: { generate: (m: unknown, o: unknown) => Promise<unknown> },
  sb: { id: number; storyboardNumber: number | null },
  videoLabel: string,
  requestContext: unknown,
  episodeId: number,
  extra?: string,
  zhPrompt?: string,
): Promise<{ text: string; ok: boolean }> {
  // ① 整体生成**一次**（指令已要求一次写到位）。不做整体重试：
  //    实测重试产出的长度几乎一样（7823 → 7823 → 7823，纯等待），
  //    真正有效的压缩是下面「按组局部重写」——代价小得多。
  const res = (await agent.generate(
    [{ role: 'user', content: buildFullPrompt(sb, videoLabel, extra, zhPrompt) }],
    { maxSteps: 4, requestContext },
  )) as { text?: string } | undefined
  const full = cleanSegText(res?.text || '')
  debugLog(episodeId, sb.id, 'full', full, { under: full.length <= PROMPT_EN_LIMIT })
  const parts = splitEnSections(full)
  if (!parts.size) {
    logTaskError('VideoPrompt', 'segment-give-up', { episodeId, storyboardId: sb.id, stage: 'full', error: '整体生成无有效段（切不出任何段名）' })
    return { text: '', ok: false }
  }

  // ② 逐组核定：超标/缺失的组单独重写（容错抽取：Agent 又输出全文也只取该组）
  const failedStages: Array<{ key: string; problem: string }> = []
  for (const stage of EN_STAGES) {
    let cur = stage.segs.map(s => parts.get(s) || '').filter(Boolean).join('\n')
    let problem = groupProblem(cur, stage)
    for (let attempt = 0; problem && attempt < MAX_SEG_RETRY; attempt++) {
      logTaskProgress('VideoPrompt', 'segment-retry', {
        episodeId, storyboardId: sb.id, stage: stage.key, attempt: attempt + 1, problem, len: cur.length, limit: stage.limit,
      })
      const res = (await agent.generate(
        [{ role: 'user', content: buildRewritePrompt(sb, stage, cur, problem, attempt + 1, extra, zhPrompt) }],
        { maxSteps: 4, requestContext },
      )) as { text?: string } | undefined
      const raw = cleanSegText(res?.text || '')
      debugLog(episodeId, sb.id, `rewrite-${stage.key}-${attempt + 1}`, raw, { under: raw.length <= stage.limit })
      const got = extractSections(raw, stage.segs)
      if (!got) continue   // Agent 没给全这几段 → 再来一次
      cur = got
      problem = groupProblem(cur, stage)
    }
    if (problem) {
      // 不立刻放弃：记录这一组没压到位，继续处理其他组 —— 最后按「全文是否 ≤ 硬上限」
      // 统一裁决（个别组略超自己的配额是可以容忍的，不该让整条作废）
      failedStages.push({ key: stage.key, problem })
      logTaskProgress('VideoPrompt', 'segment-over-quota', { episodeId, storyboardId: sb.id, stage: stage.key, problem })
    }
    // 核定后的组内容写回（没压到位也写回最后一次的输出，保证拼接时有内容）
    for (const s of stage.segs) {
      const one = extractSections(cur, [s])
      if (one) parts.set(s, one)
    }
  }

  // ③ 按文档顺序拼接 + 统一裁决
  const assemble = () => EN_SECTION_QUOTA.map(([s]) => parts.get(s) || '').filter(Boolean).join('\n')
  let text = assemble()
  debugLog(episodeId, sb.id, 'assembled', text, {
    segments: EN_SECTION_QUOTA.filter(([s]) => parts.get(s)).length,
    under: text.length > 0 && text.length <= PROMPT_EN_LIMIT,
    failedStages: failedStages.map(f => f.key),
  })

  // ③.5 中英一致性程序校验（时间轴逐拍对齐 / 台词条数一致 / 无 HTML 实体）
  //      不合格 → 自动重写对应的组（时间轴/台词在 detail 组；HTML 实体在它出现的组），
  //      最多 2 轮；仍不达标则留痕放行（不硬拦，避免像 sb147 那样卡死）
  {
    let problem = zhEnConsistency(text, zhPrompt)
    for (let attempt = 0; problem && attempt < 2; attempt++) {
      logTaskProgress('VideoPrompt', 'zh-en-fix', {
        episodeId, storyboardId: sb.id, attempt: attempt + 1, problem,
      })
      // 选要重写的组：HTML 实体散落在哪段就重写哪段（实体常见于 subject_definitions）；
      // 时间轴 / 台词条数的问题都在 detailed_description 所在的 detail 组。
      const targets = /HTML 实体/.test(problem)
        ? EN_STAGES.filter(st => st.segs.some(sg => /&lt;|&gt;|&amp;/.test(parts.get(sg) || '')))
        : [EN_STAGES[EN_STAGES.length - 1]]
      const list = targets.length ? targets : [EN_STAGES[EN_STAGES.length - 1]]
      for (const st of list) {
        const cur = extractSections(text, st.segs) || ''
        const res2 = (await agent.generate(
          [{ role: 'user', content: buildRewritePrompt(sb, st, cur, problem, attempt + 1, extra, zhPrompt) }],
          { maxSteps: 4, requestContext },
        )) as { text?: string } | undefined
        const raw = cleanSegText(res2?.text || '')
        debugLog(episodeId, sb.id, `fix-zhen-${attempt + 1}-${st.key}`, raw, { problem })
        const got = extractSections(raw, st.segs)
        if (!got) continue
        for (const s of st.segs) {
          const one = extractSections(got, [s])
          if (one) parts.set(s, one)
        }
      }
      text = assemble()
      problem = zhEnConsistency(text, zhPrompt)
    }
    if (problem) {
      logTaskProgress('VideoPrompt', 'zh-en-unresolved', { episodeId, storyboardId: sb.id, problem })
    }
  }

  const under = text.length > 0 && text.length <= PROMPT_EN_LIMIT
  if (!text) {
    logTaskError('VideoPrompt', 'segment-give-up', { episodeId, storyboardId: sb.id, stage: 'all', error: '拼接结果为空' })
    return { text: '', ok: false }
  }
  if (!under) {
    // 全文仍超硬上限 → 真失败（超了会被 H3 拒收，不能落库）
    logTaskError('VideoPrompt', 'segment-give-up', {
      episodeId, storyboardId: sb.id, stage: 'all',
      error: `全文 ${text.length} > ${PROMPT_EN_LIMIT}；未达标的组：${failedStages.map(f => `${f.key}(${f.problem})`).join('; ') || '无'}`,
    })
    return { text: '', ok: false }
  }
  // 全文在硬上限内 → 接受（个别组略超自身配额可容忍，避免"差一点就全盘失败"）
  if (failedStages.length) {
    logTaskProgress('VideoPrompt', 'accepted-with-over-quota', {
      episodeId, storyboardId: sb.id, len: text.length,
      stages: failedStages.map(f => `${f.key}: ${f.problem}`),
    })
  }
  return { text, ok: true }
}

/** 中文工作版（给人看的分镜说明，不直接发给视频模型，无长度压力） */
async function generateZhPrompt(
  agent: { generate: (m: unknown, o: unknown) => Promise<unknown> },
  sb: { id: number; storyboardNumber: number | null },
  videoLabel: string,
  requestContext: unknown,
): Promise<string> {
  const res = (await agent.generate(
    [
      {
        role: 'user',
        content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成中文工作版视频提示词(video_prompt)。视频模型:${videoLabel},请根据该模型的特性和时长限制生成。
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长。
这份是给人看的工作版（不直接发给视频模型，无长度限制），写法见 video-prompt 技能的中文工作版章节。
**只输出正文**：不要输出解释、前言、结语；不要用代码块围栏；不要调用任何保存工具。`,
      },
    ],
    { maxSteps: 4, requestContext },
  )) as { text?: string } | undefined
  return cleanSegText(res?.text || '')
}

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number; extra?: string } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (tasks.get(episodeId)?.status === 'running') return { started: false, total: -1 }

  const sbs = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const pending = storyboardIds?.length
    ? sbs.filter(sb => storyboardIds.includes(sb.id))
    // 2026-10-09：中英文**任一**缺失都算缺。英文版是视频生成唯一可用的那份
    // （前端已硬保护：缺英文版直接报错不发送），只判中文版会出现
    // 后端说"已齐"、前端说"发不了"的死锁。
    : sbs.filter(sb => !((sb.videoPrompt || '').trim() && (sb.videoPromptEn || '').trim()))
  if (!pending.length) return { started: false, total: 0 }

  // 视频模型标签：跟随该集锁定的视频配置，供 Agent 按模型特性生成
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  let videoLabel = '默认'
  if (ep?.videoConfigId) {
    const [cfg] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.videoConfigId))
    if (cfg) videoLabel = `${cfg.name} (${cfg.provider})`
  }

  const task: VideoPromptBatchStatus = {
    status: 'running',
    total: pending.length,
    completed: 0,
    failed: 0,
    started_at: new Date().toISOString(),
  }
  tasks.set(episodeId, task)

  logTaskStart('VideoPrompt', 'batch', {
    episodeId, dramaId, total: pending.length, model: opts.model || undefined, prompt_en_limit: PROMPT_EN_LIMIT,
  })
  ;(async () => {
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('视频提示词 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
    })
    for (const sb of pending) {
      task.current_storyboard_id = sb.id
      logTaskProgress('VideoPrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: task.completed + task.failed + 1, total: task.total })
      try {
        // 1) 中文工作版（**先生成** —— 它是本次时间轴的基准，英文版必须逐拍对齐它）
        const zh = await generateZhPrompt(agent, sb, videoLabel, requestContext)
        if (!zh) {
          task.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: '中文工作版生成为空' })
          continue
        }
        // 2) 英文版：以中文版时间轴为基准整体生成 → 逐组核定 → 中英一致性程序校验（不合格自动重写）
        const en = await generateEnByStages(agent, sb, videoLabel, requestContext, episodeId, opts.extra, zh)
        if (!en.ok) {
          task.failed++
          continue
        }
        if (en.text.length > PROMPT_EN_LIMIT) {
          // 各组都已达标，理论上不会走到这里；留痕便于发现配额表与技能不一致
          logTaskError('VideoPrompt', 'batch-shot', {
            storyboardId: sb.id,
            error: `各组达标但拼接后仍超 ${en.text.length} > ${PROMPT_EN_LIMIT}（请核对 EN_SECTION_QUOTA 与技能配额）`,
          })
        }
        // 3) 后端落库（Agent 不落库，避免它顺手写别的字段）
        await db.update(schema.storyboards)
          .set({ videoPrompt: zh, videoPromptEn: en.text })
          .where(eq(schema.storyboards.id, sb.id))
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        const freshEn = (fresh?.videoPromptEn || '').trim()
        if ((fresh?.videoPrompt || '').trim() && freshEn) {
          task.completed++
          logTaskProgress('VideoPrompt', 'batch-shot-saved', {
            episodeId, storyboardId: sb.id, en_len: freshEn.length, zh_len: (fresh?.videoPrompt || '').length,
          })
        } else {
          task.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: '落库后读回为空' })
        }
      } catch (err: any) {
        task.failed++
        logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: err?.message })
      }
    }
  })()
    .then(() => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
      task.current_storyboard_id = undefined
      logTaskSuccess('VideoPrompt', 'batch', { episodeId, total: task.total, completed: task.completed, failed: task.failed })
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '批量生成失败'
      logTaskError('VideoPrompt', 'batch', { episodeId, error: err?.message })
    })
  return { started: true, total: pending.length }
}

export function getVideoPromptBatchStatus(episodeId: number): VideoPromptBatchStatus | null {
  return tasks.get(episodeId) || null
}
