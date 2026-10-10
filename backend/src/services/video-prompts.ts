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
 *  配额之和 = 6120（+ 7 个连接换行 = 6127）≤ 6200 = 全文上限 → 「每组达标 ⇒ 必然不超」。
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
  // 2026-10-10 重新分配：原 CAST 220 + BLOCKING 420 实测压不下来
  // （AI 把 head 组压到 817 仍超 640 —— CAST 的数量锁句 + BLOCKING 的站位/朝向/180 轴线
  //  本身就是硬内容，砍不动）。改为按"实际需要"分配，总量 5920 仍远低于 6200。
  ['CAST:', 320],
  ['BLOCKING:', 560],
  ['subject_definitions:', 1700],
  ['summary:', 340],
  ['retention_analysis:', 760],
  ['detailed_description:', 1900],
  ['overall_soundscape:', 300],
  ['non_diegetic_music:', 40],
]

/** 核定/重写分组：相邻段一起处理，limit = 组内配额之和。
 *  八段配额相加 = 6120；全部达标后拼接总长 ≤ 6127 < 6200 = PROMPT_EN_LIMIT。 */
const EN_STAGES: Array<{ key: string; label: string; segs: string[]; limit: number }> = [
  { key: 'head', label: 'CAST 和 BLOCKING 两段', limit: 880, segs: ['CAST:', 'BLOCKING:'] },
  { key: 'subj', label: 'subject_definitions 段', limit: 1700, segs: ['subject_definitions:'] },
  { key: 'summ', label: 'summary 和 retention_analysis 两段', limit: 1100, segs: ['summary:', 'retention_analysis:'] },
  {
    key: 'detail',
    label: 'detailed_description、overall_soundscape、non_diegetic_music 三段',
    limit: 2240,
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

/** 第 1 轮指令：照技能写完整八段（与技能「六段固定、顺序固定」一致，不冲突）。
 *  ⚠️ 关键设计：**给"目标长度"而不是只给"上限"** —— 实测 Agent 对"≤6200"无感
 *  （写成 7746 仍以为没问题），但对"这段约 1500 字符"有明确落点，一次就能写到位。
 *  目标值取配额的 ~80%，合计约 4900，远低于硬上限，留足余量、也避免回头压缩（压缩要重跑，很慢）。 */
function buildFullPrompt(sb: { id: number; storyboardNumber: number | null }, videoLabel: string, extra?: string): string {
  const targets = EN_SECTION_QUOTA
    .map(([s, q]) => `${s.replace(':', '')} 约${Math.round(q * 0.8 / 10) * 10}`)
    .join(' / ')
  return `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词 video_prompt_en（H3 官方 Ref2VA 六段式 + 前置 CAST/BLOCKING）。视频模型:${videoLabel}。

请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长；格式与规则见 video-prompt 技能「英文发送版」节。

🔴 长度要求（**一开始就写到位，不要写完再回头压** —— 压缩必须重跑一遍，很浪费）：
- **目标长度 4600~5600 字符**（完整提示词，含换行与标点）。
- 逐段目标：${targets}
- **硬上限 6200 字符**：写入时后端会校验，超了直接拒绝并要求重写。MiniMax H3 上限 7000，发送时还要拼 591 字符风格头。
- **宁可精炼**：每段只说必要的，形容词能省则省，但必须保住下面这些不许砍的内容。

绝不许为了压长度而砍：<d> 台词、retention_analysis 的 fully_preserved、<Picture N> 的 with 外观、CAST 数量锁、BLOCKING 的 180 轴线。

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
): string {
  const segQuota = stage.segs
    .map(s => `${s.replace(':', '')} ≤${(EN_SECTION_QUOTA.find(([k]) => k === s) || ['', 0])[1]}`)
    .join(' / ')
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
): Promise<{ text: string; ok: boolean }> {
  // ① 整体生成**一次**（指令已要求一次写到位）。不做整体重试：
  //    实测重试产出的长度几乎一样（7823 → 7823 → 7823，纯等待），
  //    真正有效的压缩是下面「按组局部重写」——代价小得多。
  const res = (await agent.generate(
    [{ role: 'user', content: buildFullPrompt(sb, videoLabel, extra) }],
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
        [{ role: 'user', content: buildRewritePrompt(sb, stage, cur, problem, attempt + 1, extra) }],
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
  const ordered = EN_SECTION_QUOTA.map(([s]) => parts.get(s) || '').filter(Boolean)
  const text = ordered.join('\n')
  const under = text.length > 0 && text.length <= PROMPT_EN_LIMIT
  debugLog(episodeId, sb.id, 'assembled', text, {
    segments: ordered.length, under, failedStages: failedStages.map(f => f.key),
  })
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
        // 1) 英文版：整体生成 → 逐组核定（超标组单独重写）→ 全达标才拼
        const en = await generateEnByStages(agent, sb, videoLabel, requestContext, episodeId, opts.extra)
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
        // 2) 中文工作版
        const zh = await generateZhPrompt(agent, sb, videoLabel, requestContext)
        if (!zh) {
          task.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: '中文工作版生成为空' })
          continue
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
