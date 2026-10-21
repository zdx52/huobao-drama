/**
 * MV 段提示词流水线（2026-10-19）——**照短剧 `services/video-prompts.ts` 的精髓移植**，
 * 不引短剧的 Agent / 不改短剧任何文件；语义闸直接复用短剧那几个纯函数模块（只读）。
 *
 * 短剧那套「能出对」的原因不是提示词写得长，而是这条链：
 *   ① 中文工作版**先出**（它是本次时间轴的基准）
 *   ② 英文六段**整稿**生成（给目标长度，不只给上限）
 *   ③ 缺段补写 → 逐组配额核定 → **只压超标组**（带硬欠账数字、两个零削减就早停）
 *   ④ 六段齐全闸 → 拍数闸 → 英文语言闸 → 中英时间轴一致性
 *   ⑤ 语义闸：道具引用 / retention / 画外音锁嘴 / 颜色（发色·服装色）
 *   ⑥ 落库前机械清理（分组标题、【】行）
 * 每道闸的形状都一样：**发现问题 → 把那几段连问题一起交回模型重写 → 改长了就回滚**，最多 2 轮。
 *
 * MV 与短剧的差异：MV 的拍点时间存在库里（`mv_shots.beats`），所以英文按 beats 对齐，
 * 不靠中文稿的秒数去猜。**MV 的音频是「原曲 1:1 复用」**（shim 把歌切成段喂给模型，
 * 成片再换成原曲音轨）⇒ 提示词按官方 audio-reuse 口径写 `<Audio 1>` + `fully_copy` + `(S1)`，
 * **不写歌词、不写 `<d>`**（歌里本来就有词，写 `<d>` 会变成另唱一遍）。
 */
import { findChineseOutsideDialogue } from './en-cn-gate.js'
import { findDanglingPropRef } from './prop-text-gates.js'
import { findRetentionMismatch } from './retention-gate.js'
import { findVoiceoverOnscreenLock } from './voiceover-onscreen-gate.js'
import { findColourGaps, shouldRewriteForColour, colourRewriteNote, type CommunityAsset } from './asset-colour-gate.js'

export const MV_SEGS = [
  'subject_definitions', 'summary', 'retention_analysis',
  'detailed_description', 'overall_soundscape', 'non_diegetic_music',
] as const
export type MvSeg = typeof MV_SEGS[number]

/** 六段配额（与短剧 EN_SECTION_QUOTA 同源）：合计 5020，全文硬上限 6200（H3 官方 7000，留余量） */
export const MV_QUOTA: Record<MvSeg, number> = {
  subject_definitions: 1000, summary: 340, retention_analysis: 760,
  detailed_description: 2500, overall_soundscape: 300, non_diegetic_music: 120,
}
export const MV_LIMIT = 6200

export interface MvPicture { n: number; name: string; kind: string; assetText: string }
export interface MvBeat { start: number; end: number; size: string; camera: string; action: string; action_zh: string }

export interface MvShotInput {
  skillZh: string
  skillEn: string
  styleHead: string
  styleRulesZh: string
  styleRulesEn: string
  roster: string
  pictures: MvPicture[]
  outlineText: string
  beats: MvBeat[]
  seconds: number
  start: number
  frames: number
  vocalActive: boolean
  lyric?: string
  extra?: string
  shotNumber?: number
  aspectRatio?: string
  /** 真实步骤进度（前端轮询显示「第 X/Y 步 · 在做什么」，不是假动画条） */
  onProgress?: (step: number, total: number, label: string) => void
}

/** 一次文本模型调用（由 mv.ts 注入，避免本模块依赖它的 HTTP 细节） */
export type MvAsk = (system: string, user: string) => Promise<string>

/** 中文稿拍行判定（放宽）：`0-7.29秒：` / `0.00–7.292 秒` / `第1拍 0-7.29s` 都算一拍；
 *  2026-10-19 修：原来只认「数字-数字秒」，模型写 `0秒-7.29秒` 或 `[0-7.29s]` 就一律判 0 拍 → 两次都不达标。 */
const ZH_BEAT_RE = /^\s*(?:第\s*\d+\s*拍[：:\s]*)?\[?\s*\d+(?:\.\d+)?\s*(?:秒|s)?\s*[-–—~至到]\s*\d+(?:\.\d+)?\s*(?:秒|s)/gim
const countZhBeats = (t: string) => (String(t || '').match(ZH_BEAT_RE) || []).length
const countEnShots = (t: string) => (String(t || '').match(/\[Shot \d+\]/g) || []).length
const looksChinese = (t: string) => (String(t || '').match(/[\u4e00-\u9fa5]/g) || []).length >= 20
/** 秒 → `00:06.500`（短剧 [Shot N] At 的写法） */
const mmss = (sec: number) => {
  const s = Math.max(0, Number(sec) || 0)
  const m = Math.floor(s / 60)
  const rest = (s - m * 60).toFixed(3).padStart(6, '0')
  return `${String(m).padStart(2, '0')}:${rest}`
}
/** 砍掉 AI 回复里的思考前言/代码块 */
const clean = (raw: string) => {
  let t = String(raw || '').trim()
  t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
  const lines = t.split('\n')
  const first = lines.findIndex((l) => /(subject_definitions|出场人物)/.test(l))
  if (first > 0 && first < 6) t = lines.slice(first).join('\n').trim()
  return t
}
const splitSections = (text: string): Map<MvSeg, string> => {
  // 逐行解析（**别用正则 + $ 做段尾**：`m` 标志下 `$` 是行尾，惰性量词会在第一行就停，
  // 段内第二行起全被丢掉 —— 干跑实测过，英文正文的 [Shot 2] 和第二个主体就是这么没的）
  const out = new Map<MvSeg, string>()
  let cur: MvSeg | null = null
  let buf: string[] = []
  const flush = () => { if (cur) out.set(cur, `${cur}:\n${buf.join('\n').trim()}`) }
  for (const line of String(text || '').split('\n')) {
    const m = line.match(new RegExp(`^\\s*(${MV_SEGS.join('|')})\\s*:\\s*(.*)$`))
    if (m) { flush(); cur = m[1] as MvSeg; buf = m[2] ? [m[2]] : [] }
    else if (cur) buf.push(line)
  }
  flush()
  return out
}
const assemble = (parts: Map<MvSeg, string>) =>
  MV_SEGS.map((s) => parts.get(s) || '').filter(Boolean).join('\n').replace(/^【.*】$/gm, '').trim()

// ─── 官方 Ref2VA 格式闸的纯函数部分（检测便宜就机械修，不花模型调用） ───
/** 否定句：动作 / 运镜类（cfg=1 无负向分支，否定词会被当成正面描述演出来）。
 *  例外清单（音频声明 / 画风头 avoid / 数量与外观锁）先遮蔽掉再扫。 */
const NEG_OK = /\b(?:no human voice|no dialogue|no one speaks|no voice|no words|no singing|no humming|no narration|no subtitles?|no watermark|no readable text|no text|no gradients|no gloss|no reflections?|no blur|no depth-of-field blur|no new light source|no repeated identical outfits|no second|no extra|no jewellery|never duplicated|never a repeated face|never detailed faces|never a second|avoid [a-z-]+(?: [a-z-]+)?)\b/gi
const NEG_BAD = /\b(?:no|not|never|without|nobody)\s+(?:[a-z'-]+\s+){0,2}(?:push|pan|tilt|zoom|dolly|track|move|moves|moving|movement|turn|turns|turning|stop|stops|stopping|slow|slows|slowing|look|looks|looking|blink|blinks|blinking|speak|speaks|speaking|open|opens|opening|close|closes|closing|mouth|head|camera|shift|sway|sways|react|reacts)\b/gi
const findNegatedAction = (en: string) => {
  const hits = (String(en || '').replace(NEG_OK, ' ').match(NEG_BAD) || []).map((s) => s.trim().toLowerCase().replace(/\s+/g, ' '))
  return [...new Set(hits)]
}
/** 官方 fixed 格式：`<Subject N> (appears in [Shot 1], [Shot 3]): fully_preserved - ...`。
 *  纯格式 ⇒ 机械补齐（从 detailed_description 的 [Shot N] 块里找该主体出现在哪几拍）。 */
const fixRetentionFormat = (en: string, retention: string) => {
  const det = (en.split(/^detailed_description:\s*$/m)[1] || '').split(/^overall_soundscape:/m)[0]
  const blocks = det.split(/(?=\[Shot \d+\])/).filter((b) => /^\s*\[Shot \d+\]/.test(b))
  const shotsOf = (k: string) => blocks.map((b, i) => (b.includes(`<Subject ${k}>`) ? i + 1 : 0)).filter(Boolean)
  return retention.split('\n').map((line) => {
    // 模型常写成 `<Subject 1> fully_preserved — …`（没有冒号、没有 appears in）→ 也要能重排
    const m = line.match(/^\s*<Subject (\d+)>\s*(\([^)]*\))?\s*[:：\-—–]?\s*(.*)$/)
    if (!m) return line
    const k = m[1]
    // 一律按正文重算（模型常写成 `(appears in Shot 1)` 少方括号，官方要求 `(appears in [Shot 1])`）
    const where = `(appears in ${(shotsOf(k).length ? shotsOf(k) : [1]).map((n) => `[Shot ${n}]`).join(', ')})`
    // 关系标记后面统一用 ASCII ` - `（模型爱写 em dash）；描述尾部自带的 (appears in …) 去掉，避免重复
    const rest = m[3].replace(/\s*[—–]\s*/, ' - ').replace(/\s*\((?:appears in|appears throughout)[^)]*\)\s*$/i, '').trim()
    return `<Subject ${k}> ${where}: ${rest}`
  }).join('\n')
}
/** summary 里不许有画风/介质词，且必须引用 <Subject N> 标签 */
const SUMMARY_STYLE = /\b(photorealistic|photoreal|cinematic|35mm|16mm|film grain|grain|colour grading|color grading|desaturated|shallow depth of field|film still|live-action)\b/i
const summaryBad = (summary: string) =>
  !/<Subject \d+>/.test(summary) || (summary.match(SUMMARY_STYLE) || [])[0] || ''


/** 服务器体检的禁词表（命中即拒收） */
const BANNED_RE = /\b(?:screen|screens|phone|phones|smartphone|tablet|mirror|mirrors|reflection|reflections|projection|projections|poster|posters|portrait|portraits|painting|paintings|photograph|photographs|photo|photos|crowd|television|clone|duplicate|ghost)\b/gi

/** 机械洗掉常见命中（2026-10-19 实测：模型爱写 "reads on screen from the first frame" → 体检报「危险词: screen」） */
/** 中→英景别固定译法（模型爱把「近景」写成 close-up，中英就打架了） */
const SIZE_EN: Record<string, string> = {
  大特写: 'extreme close-up', 特写: 'close-up', 近景: 'medium close-up',
  中景: 'medium shot', 中远景: 'medium wide shot', 远景: 'wide shot', 全景: 'full shot',
}
const SIZE_EN_RE = /extreme close-up|medium close-up|medium wide shot|close-up|medium shot|wide shot|full shot/i

/**
 * 英文稿景别机械对齐：detailed_description 里第 N 块的**首句**景别，强制改成中文第 N 拍的景别。
 * 只动首句、只动第一个景别词 —— 正文里的 "close-up of her hand" 之类不碰。
 */
function alignShotSizes(en: string, sizes: string[]): string {
  const i = en.indexOf('detailed_description:')
  if (i < 0 || !sizes.some((s) => SIZE_EN[s])) return en
  const rest = en.slice(i)
  const nxt = rest.search(/\n(overall_soundscape|non_diegetic_music)\s*:/)
  const body = nxt >= 0 ? rest.slice(0, nxt) : rest
  const tail = nxt >= 0 ? rest.slice(nxt) : ''
  let k = 0
  const fixedBody = body.replace(/\[Shot\s+\d+\][\s\S]*?(?=\[Shot\s+\d+\]|$)/g, (blk) => {
    const want = SIZE_EN[sizes[k] ?? ''] || ''
    k++
    if (!want) return blk
    const cut = blk.search(/(?<=[a-z0-9)\"']\.\s)/) // 首句结束位置
    const head = cut > 0 ? blk.slice(0, cut + 1) : blk
    const tailPart = cut > 0 ? blk.slice(cut + 1) : ''
    const fixed = SIZE_EN_RE.test(head) ? head.replace(SIZE_EN_RE, want) : head
    return fixed + tailPart
  })
  return en.slice(0, i) + fixedBody + tail
}

function scrubBanned(text: string) {
  return String(text || '')
    .replace(/\boff[- ]?screen\b/gi, 'off-camera')
    .replace(/\bon[- ]?screen\b/gi, 'in frame')
    .replace(/\b(screen|screens)\b/gi, 'frame')
}

/** 删掉「四格板 / headless」这类参考板元描述（模型会把头当独立一块拼，实测出「头飞出来」），
 *  再统一补一句正向的头颈肩连贯声明。 */
/** MV 直接读**短剧**的 video-prompt 规范（单一来源：短剧改了这边自动跟着改），
 *  但把只有短剧才用的台词条款剔掉（MV 是原曲 1:1，没有台词/对白/旁白）。 */
export function mvSpecFromDrama(dramaSpec: string): string {
  const DIALOG = /(<d>|台词|对白|旁白|画外音|voiceover|scenetrans|cutoff|对话窗|口播|配音|\bsays?\b|\(S\d\)|续拍链|verbatim_lock|出声|发声)/i
  const KEEP = /(补头|四格|参考板|完整头|景别|运镜|镜头|画风|颜色|服装|屏幕|retention|subject_definitions|Picture)/i
  const out: string[] = []
  for (const line of String(dramaSpec || '').split('\n')) {
    if (/^##\s*(续拍链|保存)/.test(line)) continue
    if (DIALOG.test(line) && !KEEP.test(line)) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** MV 没有台词：技能照抄短剧，模型可能顺手写 <d> 台词 / says / voiceover —— 一律机械剥掉。
 *  只保留 <Audio 1> 的原曲复用声明。 */
function stripDialogue(text: string) {
  return String(text || '')
    .replace(/<d>[\s\S]*?<\/d>/gi, '')                       // <d>…</d> 整块
    .replace(/[^.!?]*\b(says?|said|speaks?|narrates?|voiceover|voice-over)\b[^.!?]*[.!?]/gi, '')  // 含 says/voiceover 的整句
    .replace(/[^.!?]*<d>[^.!?]*/gi, '')
    .replace(/[^.!?]*\b(off-screen|on-screen) voice\b[^.!?]*/gi, '')
    .replace(/\s{2,}/g, ' ')
}

/** 裸 `Subject 1` 补上尖括号 —— H3 只认 <Subject N>，漏尖括号等于身份绑定失效（实测分镜2：
 *  subject_definitions 里写成 `Subject 1 is the female lead`，出片就变成两个女主 / 头部乱套）。 */
function normalizeSubjectTags(text: string) {
  return String(text || '')
    .replace(/(^|[^<\w])(Subject\s+(\d+))(?![^<]*>)/g, (_m, pre, _whole, n) => `${pre}<Subject ${n}>`)
    .replace(/<<Subject (\d+)>>/g, '<Subject $1>')
}

/** 机械补齐 MV 契约（服务器体检的硬 token / 前缀 / fully_copy / 唱段嘴部三词）——
 *  这些**全是固定字符串**，用代码拼比让模型重写快一个数量级（重写一次 30~90 秒，还可能改坏别的段）。 */
function completeContract(parts: Map<MvSeg, string>, vocalActive: boolean) {
  // subject_definitions：<Audio 1> 行 + (S1)
  let sd = parts.get('subject_definitions') || 'subject_definitions:'
  const audioLine = '<Audio 1> is the supplied song excerpt for this entire clip and is reused as the synchronized vocal track for <Subject 1> (S1).'
  // 已有 <Audio 1> 行就整行替换成标准句（保证带 (S1)），没有就补一行 —— 幂等
  sd = /<Audio 1>/.test(sd) ? sd.replace(/^\s*<Audio 1>[^\n]*$/m, audioLine) : `${sd.replace(/\s+$/, '')}\n${audioLine}`
  parts.set('subject_definitions', sd)

  // summary：任务类型前缀 + 至少引用一个标签
  let sm = parts.get('summary') || 'summary:'
  if (!/\[reference generation/.test(sm)) sm = `summary:\n[reference generation + audio reuse] ${sm.replace(/^summary:\s*/, '')}`
  else sm = sm.replace('[reference generation]', '[reference generation + audio reuse]')
  if (!/<Subject \d+>/.test(sm)) sm = `${sm.replace(/\s+$/, '')} The clip follows <Subject 1>.`
  parts.set('summary', sm)

  // retention_analysis：<Audio 1>: fully_copy 行
  const copyLine = '<Audio 1>: fully_copy - the supplied song excerpt is reused 1:1 across the clip.'
  let rt = parts.get('retention_analysis') || 'retention_analysis:'
  rt = /<Audio 1>/.test(rt) ? rt.replace(/^\s*<Audio 1>[^\n]*$/m, copyLine) : `${rt.replace(/\s+$/, '')}\n${copyLine}`
  parts.set('retention_analysis', rt)

  // 音频声明只允许出现在 subject_definitions：模型常把它抄进 detailed_description，
  // 还改写成 `<Subject 1> is the supplied song excerpt…`（等于把主唱说成音频）——整行删掉。
  {
    const det0 = parts.get('detailed_description')
    if (det0) {
      const lines = String(det0).split('\n').filter((l) =>
        !/^\s*<(?:Subject \d+|Audio 1)>\s+is the supplied song excerpt/i.test(l))
      parts.set('detailed_description', lines.join('\n'))
    }
  }

  // 唱段：只有 <Subject 1>（主唱）张嘴；画面里其他人一律闭嘴（MV 单主唱铁律）
  if (vocalActive) {
    let det = parts.get('detailed_description') || 'detailed_description:'
    if (!/lead singer/i.test(det) || !/phoneme/i.test(det) || !/unobstructed/i.test(det)) {
      det = `${det.replace(/\s+$/, '')} ` +
        `<Subject 1> is the lead singer: only <Subject 1>'s face and an unobstructed mouth stay visible, and only <Subject 1>'s lips articulate every audible phoneme in sync with <Audio 1>. ` +
        `Every other person in frame keeps the mouth closed and stays silent — no lip-sync, no singing, no mouthing the words.`
    }
    parts.set('detailed_description', det)
  } else {
    // 非唱段（间奏）：谁都不许对嘴
    let det = parts.get('detailed_description') || 'detailed_description:'
    if (!/nobody sings|mouths stay closed/i.test(det)) {
      det = `${det.replace(/\s+$/, '')} Nobody sings in this clip: every mouth stays closed and no one mouths the words, <Audio 1> plays as the soundtrack.`
    }
    parts.set('detailed_description', det)
  }
}

/** 一条流水线的硬上限：正常 2 次（中文+英文），最多 4 次（各自重试 1 + 断尾修 1）。
 *  2026-10-19：原来 6~12 次带闸循环，实测一段要几分钟、前端会等到以为失败 —— 砍成有界。 */
export async function generateMvShotPrompt(inp: MvShotInput, ask: MvAsk): Promise<{ zh: string; en: string }> {
  const { beats } = inp
  const beatN = Math.max(1, beats.length)
  const secs = Number(inp.seconds) || 6
  const end = inp.start + secs
  const subjN = Math.max(1, inp.pictures.length)
  const perSubj = Math.max(120, Math.floor(MV_QUOTA.subject_definitions / subjN / 10) * 10)
  const perBeat = Math.floor(MV_QUOTA.detailed_description / beatN)
  const order = inp.pictures.map((p) => `<Picture ${p.n}> = ${p.name}（${p.kind === 'character' ? '人物' : p.kind === 'scene' ? '场景' : '道具'}）`).join('；')
  const assetLines = inp.pictures.map((p) => `- <Picture ${p.n}> ${p.name} 的外观原文：${p.assetText || '(没有外观描述)'}`).join('\n')
  const beatLines = beats.map((b, i) =>
    `  拍${i + 1}：${b.start.toFixed(2)}-${b.end.toFixed(2)}s｜${b.size}｜${b.camera}｜中：${b.action_zh}｜英(参考)：${b.action}`).join('\n')
  const zhTimeline = beats.map((b, i) => `${i + 1}. [Shot ${i + 1}] At ${mmss(b.start)}（${b.start.toFixed(2)}-${b.end.toFixed(2)}秒）`).join('\n')

  const ctx = [
    '【本段落上下文 —— 这就是你要写的分镜，信息已完整】',
    `- 段落：第 ${inp.shotNumber || 1} 段，时间 ${inp.start.toFixed(2)}-${end.toFixed(2)} 秒，共 ${secs} 秒（${inp.frames} 帧）`,
    `- 拍数：${beatN} 拍（**一个不多一个不少**）`,
    `- 主体清单（逐字照抄）：${inp.roster}`,
    `- 参考图顺序：${order || '（无）'}`,
    `- 画幅：${inp.aspectRatio || '16:9'}；${inp.vocalActive ? '本段有唱：脸和嘴全程可见、口型跟原曲' : '本段无唱（间奏），嘴自然闭合'}`,
    inp.lyric ? `- 本段歌词（给人看的参考，**不要写进英文提示词**）：${inp.lyric}` : '',
    inp.outlineText ? `- 本段画面稿（粗分镜原文，剧情以它为准，不要另编）：\n${inp.outlineText}` : '',
    beatLines ? `- 本段拍点编排（拍数与起止秒必须照它写）：\n${beatLines}` : '',
    assetLines ? `- 各参考图资产的外观原文（subject_definitions 里 with 后面的外观和服装颜色必须从这里取，**不许自己编衣服颜色**）：\n${assetLines}` : '',
    inp.extra ? `- 🔴 导演修正意见（**这是对这一段提示词的修改要求**：与下面的中文稿/拍点冲突时，以修正意见为准；把修改落到受影响的那一拍里，**不要另起一句、不要追加在结尾**）：${inp.extra}` : '',
  ].filter(Boolean).join('\n')

  const zhSys = `你是影视分镜视频提示词写手。下面是你必须遵守的规范：\n\n${inp.skillZh}`
  const enSys = `You are a video-prompt writer for MiniMax H3 (Ref2VA). Follow this spec strictly:\n\n${inp.skillEn}` +
    (inp.styleHead ? `\n\n[Project style — the medium words MUST appear in the prose]\n${inp.styleHead}` : '')

  // 进度一共 8 步：模型调用占 3~5，剩下是机械处理 —— 每一步都是真实发生的，不是假动画
  const TOTAL = 8
  inp.onProgress?.(1, TOTAL, '读取规范与素材，拼上下文')
  // ── ① 中文工作版：**机械生成，不调模型**（2026-10-19：这正是最慢的那一半，而中文稿只是给人看的）
  //    内容 = 首行 roster + 每拍一行（起止秒·景别·机位 + 该拍动作 + 本段画面稿 + 有无唱/环境声）
  // 画面稿：**剥掉 `[0-12s]` 这种整首歌的绝对时间标签**（那是粗分镜自己的时间轴，不是本段拍点，
  // 原样贴进来会被误读成分镜时长 —— 2026-10-19 用户「[0-12s] 是啥意思」就是这里）
  const stripTime = (t: string) => String(t || '').replace(/\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim()
  const sceneBlurb = stripTime(String(inp.outlineText || '').replace(/\n+/g, ' '))
  /** 中文各拍景别（英文生成后用它做机械对齐 —— 模型老把「近景」意译成 close-up） */
  const zhSizes = beats.map((b: any) => String(b.size || '').trim())
  const zhLines = beats.map((b, i) => {
    const act = String(b.action_zh || b.action || '').trim().replace(/[。.]+$/, '')
    const parts: string[] = []
    if (i === beats.length - 1) {
      if (sceneBlurb) parts.push(`环境与光线：${sceneBlurb.replace(/[。.]+$/, '')}`)
      parts.push(inp.vocalActive ? '本段有唱：脸和嘴全程可见、口型跟原曲' : '本段无任何人声，只有环境底噪')
    }
    const tail = parts.length ? parts.join('；') + '。' : ''
    return `${b.start.toFixed(2)}-${b.end.toFixed(2)}秒：${b.size || ''}${b.camera ? `·${b.camera}` : ''}。${act}。${tail}`
  })
  // 修正意见单独成块（不进某一拍）：它是「怎么改」，不是「再加一句画面」
  const extraBlock = inp.extra
    ? `\n【本段修正意见（覆盖上文与之冲突的描写，改到对应那拍里去，不要追加新句）】${String(inp.extra).replace(/\s+$/, '')}`
    : ''
  const zh = [inp.roster, ...zhLines].filter(Boolean).join('\n') + extraBlock
  // 参考板是四格（短剧同款）：按本段景别只点一格 —— 近景/特写点脸部特写格，其余点正面全身格；
// 三格无头，所以必须同时声明"有完整头部与脸"，否则模型照无头参考板画。
  const closeUpShot = /近景|特写/.test(String(inp.beats?.[0]?.size || ''))
  const panelRule = closeUpShot
    ? '`with her face and complete head taken from the face close-up panel (leftmost)` '
    : '`with her body following the front full-body panel (second from left) and a complete head and face` '

  inp.onProgress?.(2, TOTAL, '中文工作版（本地拼稿，不占模型时间）')

  /** 定稿中文稿（每拍一行：起止秒·景别·机位·动作·环境）——
   *  2026-10-20 用户报「英文跟中文对不上」：之前英文只拿到 outline+beats 自己重新创作，
   *  所以必须把这份中文原样交给模型，并要求逐行对译（一个画面都不许增删）。 */
  const zhDraft = zh

  // ── ② 英文六段（最多 2 次：只有段名不全才重试） ──
  inp.onProgress?.(3, TOTAL, '英文六段稿（第 1 次调用，通常 1~2 分钟）')
  const enAsk = `${ctx}\n\n` +
    `🔴 已定稿的中文工作版（**英文必须逐行照它翻译**：拍数、景别、机位、动作、道具、环境光线全部以它为准，` +
    `一个画面都不许新增、不许省略、不许换动作）：\n${zhDraft}\n\n` +
    `Task: write the **English send version** video_prompt_en — official six sections, fixed order:\n` +
    `subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music\n\n` +
    `🔴 Length: aim for ${Math.round(MV_LIMIT * 0.74 / 50) * 50}~${Math.round(MV_LIMIT * 0.9 / 50) * 50} characters total; ` +
    `per section: ${MV_SEGS.map((s) => `${s} ≈${MV_QUOTA[s]}`).join(' / ')}; hard cap ${MV_LIMIT}.\n` +
    `🔴 subject_definitions: one line per subject — \`<Subject N> is the <type> in <Picture N>, with <appearance + outfit colours>\`; ` +
    `take appearance from the asset text above, always name an explicit colour word (black / off-white / navy — not 'dark'); ` +
    `🔴 the character card is a FOUR-PANEL sheet (left→right: face close-up / front full-body / 90° left side / back) and the three body panels carry NO head. ` +
    `Name **exactly one** panel and always declare a complete head: ${panelRule}. Never point at two panels at once, never invent other panels.\n` +
    `🔴 THIS IS A MUSIC-VIDEO SHOT: the song excerpt is supplied as \`<Audio 1>\` and reused 1:1. **Never write lyrics, <d> blocks or invented speech.** ` +
    `The spec has no dialogue rules for MV — the song is the only audio source. Required verbatim:\n` +
    `  · \`<Audio 1> is the supplied song excerpt for this entire clip and is reused as the synchronized vocal track for <Subject 1> (S1).\`\n` +
    `  · summary starts with \`[reference generation + audio reuse]\`\n` +
    `  · \`<Audio 1>: fully_copy - the supplied song excerpt is reused 1:1 across the clip.\` in retention_analysis\n` +
    (inp.vocalActive
      ? `  · singing beat: ONLY <Subject 1> sings — its full face and unobstructed mouth stay visible and its lips articulate every audible phoneme in sync with <Audio 1>; every other person in frame keeps the mouth closed, silent, no lip-sync.\n`
      : `  · non-vocal beat: the mouth stays naturally closed and <Subject 1> moves with the rhythm of <Audio 1>.\n`) +
    `🔴 detailed_description: style sentence first, then **${beatN}** block(s):\n${zhTimeline}\n` +
    `- block 1 starts \`[Shot 1] \` with no timestamp; every later block starts \`[Shot N] At MM:SS.mmm, the camera cuts to …\` (cut verb mandatory), each ≤ ${perBeat} chars\n` +
    `- block N must be the English of line N of the Chinese draft above — same shot size, same camera, same action, same props, same environment; do not merge, split or reorder beats.\n` +
    (inp.extra
      ? `- 🔴 DIRECTOR'S CORRECTIONS (the 【本段修正意见】 block) OVERRIDE the draft wherever they conflict: rewrite the affected beat block itself (same beat count), never append a new trailing sentence and never add a 7th/8th shot.\n`
      : '') +
    `🔴 No negated actions or camera moves (no push / not opened her mouth …) — write what the frame shows. Audio declarations (no human voice) and style "avoid …" lines are fine.\n` +
    `🔴 Banned words (the MV checker rejects the prompt on any): screen, phone, tablet, mirror, reflection, projection, poster, portrait, painting, photograph, photo, crowd, television, clone, duplicate, ghost.\n` +
    `🔴 All English. No Chinese characters. Output the six sections only: no explanation, no preamble, no code fence.`

  // 只缺 soundscape / music 不算失败（下面机械补默认值）⇒ 循环只看「有内容的四段」齐不齐
  const CORE: readonly MvSeg[] = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description'] as const
  let parts = new Map<MvSeg, string>()
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) inp.onProgress?.(4, TOTAL, '英文稿段名不全，重试第 2 次')
    parts = splitSections(clean(await ask(enSys, enAsk)))
    if (CORE.every((x) => parts.get(x))) break
  }
  if (!parts.size) throw new Error('英文稿没写出段名（六段格式）')

  // ②b 只缺「有内容的四段」才补一次；soundscape / music 缺了**直接机械补默认值**
  //     （MV 里这两段本来就是固定语义：声音只有 <Audio 1>、配乐 N/A —— 让模型再跑一次纯浪费）
  const missCore = CORE.filter((x) => !parts.get(x))
  if (missCore.length) {
    inp.onProgress?.(5, TOTAL, `补写缺段：${missCore.join(', ')}`)
    const raw = clean(await ask(enSys,
      `The draft is missing these sections: ${missCore.join(', ')}. Write ONLY them (same rules and length limits as above, ` +
      `one <Audio 1> line, summary prefix \`[reference generation + audio reuse]\`, no lyrics, no <d>), keeping every subject number and timestamp. No explanation.`))
    for (const [k, v] of splitSections(raw)) if (missCore.includes(k)) parts.set(k, v)
  }
  if (!parts.get('overall_soundscape')) {
    parts.set('overall_soundscape', 'overall_soundscape:\nThe clip is heard dry and close: the supplied song excerpt carried by <Audio 1> is the entire soundtrack, with room tone captured tight around the performer.')
  }
  if (!parts.get('non_diegetic_music')) parts.set('non_diegetic_music', 'non_diegetic_music:\nN/A')

  inp.onProgress?.(6, TOTAL, '补齐 soundscape / music 默认段（机械）')
  const stillMissing = MV_SEGS.filter((s) => !parts.get(s))
  if (stillMissing.length) throw new Error(`英文六段不全，缺：${stillMissing.join(' ')}`)

  // ── ③ 契约 / 格式：全部机械补齐（不调模型） ──
  inp.onProgress?.(7, TOTAL, '机械补齐契约、retention 格式')
  completeContract(parts, !!inp.vocalActive)
  const sdText = parts.get('subject_definitions')
  if (sdText) {
    let cleaned = String(sdText)
    if (!/close-up panel|full-body panel/i.test(cleaned)) {
      cleaned = `${cleaned.replace(/\s+$/, '')} ${closeUpShot ? 'Her face and complete head are taken from the face close-up panel.' : 'Her body follows the front full-body panel and she has a complete head and face.'}`
    }
    parts.set('subject_definitions', cleaned)
  }
  const ret = parts.get('retention_analysis')!
  parts.set('retention_analysis', fixRetentionFormat(assemble(parts), ret))
  let en = assemble(parts).replace(/\n{2,}/g, '\n').trim()
    .replace(/\s*except the dialogue lines?\s+(?:explicitly\s+)?written below;?\s*/gi, ' ')

  // ── ④ 断尾：只补一次（这是唯一会再花一次调用的地方） ──
  // 禁词：先机械洗（off-screen / on screen / screen），洗完还有才补一次
  for (const k of MV_SEGS) { const v = parts.get(k); if (v) parts.set(k, scrubBanned(v)) }
  let bannedLeft = [...new Set((assemble(parts).match(BANNED_RE) || []).map((x) => x.toLowerCase()))]
  if (bannedLeft.length) {
    inp.onProgress?.(7, TOTAL, `去禁词（会多一次模型调用）：${bannedLeft.join(', ')}`)
    try {
      const raw = clean(await ask(enSys,
        `The MV checker rejects these words: ${bannedLeft.join(', ')}. Rewrite ONLY the sentences containing them so the same visual meaning is kept without those words ` +
        `(e.g. "on screen" → "in frame", "off-screen" → "off-camera"). Output the full six sections, everything else unchanged.\n\n${assemble(parts)}`))
      const fp2 = splitSections(raw)
      if (fp2.size >= 4) { parts = fp2; completeContract(parts, !!inp.vocalActive) }
    } catch { /* 洗不掉就交给人看，不整条作废 */ }
    for (const k of MV_SEGS) { const v = parts.get(k); if (v) parts.set(k, scrubBanned(v)) }
    bannedLeft = [...new Set((assemble(parts).match(BANNED_RE) || []).map((x) => x.toLowerCase()))]
  }
  en = assemble(parts).replace(/\n{2,}/g, '\n').trim()   // 洗过禁词要重新拼（不然返回的还是旧文本）

  inp.onProgress?.(8, TOTAL, '收尾校验（断尾补句、剥台词、补尖括号）')
  // 断尾要看**正文**末尾：⑥ 已把「lead singer / Nobody sings」契约句补在结尾，
  // 那句自带句号 → 以前永远判"完整"，中间被截断（"…reveal the chair backrest, the windows"）也放过去了
  const detBody = (parts.get('detailed_description') || '')
    .replace(/\s*<Subject 1> is the lead singer:[\s\S]*$/i, '')
    .replace(/\s*Nobody sings in this clip:[\s\S]*$/i, '')
    .trim()
  const detTail = detBody
  if (!/[.!?…”")]\s*$/.test(detTail)) {
    try {
      const fixed = clean(await ask(enSys,
        `The text below ends in the middle of its final sentence. Finish ONLY that final sentence so it closes with a period, ` +
        `then output the full six sections unchanged otherwise. No new shots, no new timestamps.\n\n${en}`))
      const fp = splitSections(fixed)
      if (fp.size >= MV_SEGS.length) {
        completeContract(fp, !!inp.vocalActive)
        en = assemble(fp).replace(/\n{2,}/g, '\n').trim()
      }
    } catch { /* 补不上就用原稿，不整条作废 */ }
  }

  
  en = alignShotSizes(en, zhSizes)
  en = normalizeSubjectTags(en)
  en = stripDialogue(en)
  if (!/subject_definitions\s*:/.test(en) || !/detailed_description\s*:/.test(en)) throw new Error('英文稿最终不是六段式')
  return { zh, en }
}
