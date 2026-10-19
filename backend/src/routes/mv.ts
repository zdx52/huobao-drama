/**
 * 音乐 MV 路由（2026-10-18 新增，独立模块）
 *
 * 与短剧链路彻底隔离：不写 storyboards / characters / scenes，只用自己的三张表
 * （mv_projects / mv_assets / mv_shots）+ 4080 shim 的 /v2/mv/* 接口。
 * 生成全部走 App 现成的三条通道（不写死地址和模型）：
 *   文本 = getTextConfig()｜图片 = generateImage()｜视频 = generateVideo(model=minimax-h3-mv)
 *
 * 流程（与短剧同构）：
 *   建项目（歌 + 风格 + 分镜提示词）→ 从分镜提示词提取人物/场景（mv_assets）
 *   → 逐个出图 → 逐个抽卡 → 粗分镜（与歌等长）→ 详细分镜（景别/机位/歌词）
 *   → 编译六段式提示词 → 逐段出片 → 无音轨拼接 + 原曲整段混入
 *
 * 4080 侧只用 shim 的 MV 专属接口（地址取自「视频通道」配置）：
 *   POST /v2/mv/audio        原曲 32k wav 落盘（只推一次）
 *   POST /v2/mv/plan         按能量/句界切段（H3 帧网格 5.167~14.375s，命中上限）
 *   POST /v2/mv/prompts      六段式提示词编译 + 硬校验
 *   POST /v2/refmod/extract  资产抽卡（卡保证人物和场景锁住；声音卡不接，音轨就是原曲）
 */
import { Hono } from 'hono'
import { extractVideoPoster } from '../utils/video-poster.js'
import { eq, desc, and, or, isNull, inArray } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'
import { db, schema, getInsertId } from '../db/index.js'
import { generateImage, generateVideo, imageSizeForAspect } from '../services/generation.js'
import { getTextConfig, getTextProviderBaseUrl, getActiveConfig, getConfigById } from '../services/ai.js'
import { getStyleSpecByValue } from '../services/style-preset.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { loadAgentPromptFile } from '../agents/prompts.js'
import { readSkillFile } from '../agents/skills.js'
import { extractChatText } from '../services/asset-describe-prompt.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { success, created, badRequest, notFound, serverError, now } from '../utils/response.js'
import { logTaskStart, logTaskSuccess, logTaskError } from '../utils/task-logger.js'
import { ffmpeg } from '../utils/ffmpeg.js'
// 2026-10-19：MV 提示词完全走自己的链路（askText + 只读技能文本），**不引短剧的任何服务/Agent**

// 4080 模板 mv_shot.api.json 节点14 的音频窗口 warmup_seconds（那边改了这里要同步）
const MV_WARMUP_SECONDS = 0.5

/** 音频窗口带 warmup 前导 → 成片开头多 warmup、总长按帧网格取整变长（192 帧 vs 声明 175）。
 *  按「跳过 warmup + 只取声明帧数」裁一遍：本段画面 0 秒才对齐它在原曲里的起点，
 *  否则拼接时画面比音轨长，口型错位（实测分镜2/3 各多 17 帧 = 0.708s）。 */
async function trimToSegment(rel: string, shot: any, songRel: string): Promise<string> {
  const want = Number(shot?.frames) || 0
  const sec = Number(shot?.seconds) || 0
  const start = Number(shot?.startSeconds) || 0
  if (!rel || !want || !sec) return rel
  const abs = getAbsolutePath(rel)
  const got = await new Promise<number>((res) =>
    ffmpeg.ffprobe(abs, (e: any, m: any) =>
      res(e ? 0 : Number((m?.streams || []).find((x: any) => x.codec_type === 'video')?.nb_frames) || 0)))
  if (!got || got <= want) return rel
  const tmpV = abs.replace(/\.mp4$/i, '.v.mp4')
  const tmpA = abs.replace(/\.mp4$/i, '.a.m4a')
  const tmpO = abs.replace(/\.mp4$/i, '.out.mp4')
  const run = (p: string, inOpts: string[], outOpts: string[], out: string) => new Promise<void>((resolve, reject) => {
    ffmpeg(p).inputOptions(inOpts).outputOptions(outOpts)
      .on('end', () => resolve()).on('error', (e: Error) => reject(e)).save(out)
  })
  try {
    // 步1：跳过 warmup 前导，只取本段声明帧数
    await run(abs, [`-ss ${MV_WARMUP_SECONDS}`],
      ['-frames:v', String(want), '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-y'], tmpV)
    // 步2：音轨从原曲按本段起点切窗（和拼接口径一致，也避免原文件没音轨时丢声）
    if (songRel) {
      await run(getAbsolutePath(songRel), [`-ss ${start}`],
        ['-t', String(sec), '-c:a', 'aac', '-b:a', '192k', '-y'], tmpA)
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tmpV).input(tmpA)
          .outputOptions(['-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', '-y'])
          .on('end', () => resolve()).on('error', (e: Error) => reject(e)).save(tmpO)
      })
      fs.renameSync(tmpO, abs)
      fs.rmSync(tmpV, { force: true }); fs.rmSync(tmpA, { force: true })
    } else {
      fs.renameSync(tmpV, abs)
    }
  } catch (err: any) {
    logTaskError('MV', 'trim', { rel, error: err?.message })
    for (const f of [tmpV, tmpA, tmpO]) { try { fs.rmSync(f, { force: true }) } catch { /* 忽略 */ } }
    return rel
  }
  return rel
}

const app = new Hono()

const MV_MODEL = 'minimax-h3-mv'   // 中转按 model 名走 mv_shot.api.json
const HARD_MAX_S = 15              // H3 单段极限（页面填的「最长切分」不得超）
const DEFAULT_MAX_S = 10
const KINDS = ['character', 'scene'] as const
type Kind = typeof KINDS[number]

// ---------------------------------------------------------------- 基础工具

/** 4080 地址：优先 MV_SHIM_BASE，其次「视频通道」的 baseUrl（不写死）
 *  末尾可能被填成 …:8100/v1（BeefTV 的口径）→ 去掉 v1/v2 段，MV 自己拼 /v2/mv/… */
async function shimBase(): Promise<string> {
  const env = String(process.env.MV_SHIM_BASE || '').trim()
  const raw = env || String((await getActiveConfig('video'))?.baseUrl || '').trim()
  if (!raw) throw new Error('没配视频服务地址（设置页的视频通道），MV 提交不了')
  return raw.replace(/\/(v1|v2)\/?$/i, '').replace(/\/+$/, '')
}

async function shimPost<T = any>(p: string, body: any): Promise<T> {
  const cfg = await getActiveConfig('video')
  const base = await shimBase()
  let resp: Response
  try {
    resp = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg?.apiKey || ''}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1800_000),
    })
  } catch (err: any) {
    // 网络层失败（服务器关机/掉线/Tailscale 断）——说人话，别把 fetch failed 甩给用户
    const msg = String(err?.message || err)
    throw new Error(`生成服务连不上（${base}）—— 检查那台机器是否开机、Tailscale 是否在线。原始错误: ${msg}`)
  }
  const text = await resp.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!resp.ok || json?.error) throw new Error(json?.error || `中转 ${p} HTTP ${resp.status}：${text.slice(0, 160)}`)
  return json as T
}

/** 中文稿 = 导演分镜稿：镜头编号 + 时间码 + 景别 + 机位 + 画面内容（给用户看和改） */
function renderZhStoryboard(shot: any, beats: any[], outlineText?: string): string {
  const list = Array.isArray(beats) && beats.length ? beats : [{
    start: 0, end: Number(shot.seconds) || 5.167,
    size: shot.shotSize || '中景', camera: shot.camera || '', action_zh: '', action: '',
  }]
  const lines = list.map((b: any, i: number) => {
    const head = `【镜头${i + 1}】${Number(b.start).toFixed(3)}–${Number(b.end).toFixed(3)}秒｜${b.size || ''}${b.camera ? '｜' + b.camera : ''}`
    const act = String(b.action_zh || b.action || '').trim()
    return act ? `${head}｜${act}` : head
  })
  const vocal = String(shot.vocalState || '') === 'non_vocal'
    ? '本段无唱（间奏），嘴保持自然闭合，只做情绪与律动。'
    : '本段有唱：脸和嘴全程可见、不遮挡、不出画，口型跟着原曲走。'
  const extra = String(shot.promptExtra || '').trim()
  const head = outlineText ? `【段落内容】${outlineText}` : ''
  return [head, ...lines, `【人声】${vocal}`, extra ? `【补充】${extra}` : ''].filter(Boolean).join('\n')
}

/** 中文稿 = 详细《中文导演分镜稿》：让模型把英文六段稿 + 拍点编排写成逐镜头的中文分镜（分块 2 条 + 失败逐条重试） */
type ZhItem = { en: string, beats: any[], seconds: number, vocalState?: string }

const ZH_FORMAT = `格式（严格，不要多余说明）：
【镜头N】起-止秒｜景别｜机位
画面：2~4 句，写清这一拍里——环境长什么样、谁在画面里、穿什么、在做什么动作/什么表情、光线与色调、镜头怎么动。必须具体可拍，不要堆抽象形容词
…
【声音】……`

/**
 * 2026-10-19：用 App 内的 video-prompt 技能给 MV 段出提示词（中文工作版 + 英文发送版），
 * 规则链与短剧**完全同一套**（首行出场 header `出场人物：@A；场景：@B` + 正文每实体 @ 引用 + 英文六段式骨架）。
 * 与短剧的唯一差别：上下文由本函数直接拼进指令，**不调用 read_storyboard_context**
 * （那是读短剧表的工具，MV 段不在其中）；短剧链路 services/video-prompts.ts 一行未动。
 * 失败返回 null，调用方回退到中转编译（旧行为）。
 */
/** MV 自己的中文判定/清洗（不引短剧的 zh-lang） */
function mvLooksChinese(text: string): boolean {
  const t = String(text || '').replace(/\s/g, '')
  if (!t) return false
  return ((t.match(/[\u4e00-\u9fa5]/g) || []).length / t.length) >= 0.3
}
function mvCleanText(raw: string): string {
  let t = String(raw || '').trim()
  t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
  // 砍掉正文前的英文闲聊/思考（首个含中文的行之前，最多 6 行）
  const lines = t.split('\n')
  const startIdx = lines.findIndex((l) => /[\u4e00-\u9fa5]/.test(l))
  if (startIdx > 0 && startIdx < 6) t = lines.slice(startIdx).join('\n').trim()
  return t
}

/**
 * 2026-10-19：MV 段提示词 —— **完全走 MV 自己的链路**：
 * 只读视频提示词技能文本（readSkillFile 是只读）+ 用 mv.ts 自己的 askText 调文本模型，
 * **不引短剧的 services/video-prompts、不引 mastra Agent、不改短剧任何文件**。
 */
async function mvShotPromptSkill(
  project: any, shot: any, picked: any[], character: any, sc: any,
): Promise<{ zh: string; en: string } | null> {
  try {
    const skill = String(await readSkillFile('prompt-generator/video-prompt') || '').slice(0, 12000)
    let beats: any[] = []
    try { beats = JSON.parse(String(shot.beats || '[]')) } catch { beats = [] }
    const order = (picked || []).map((a: any, i: number) => `@图片${i + 1} ${a.name}`).join(' → ')
    const secs = Number(shot.seconds) || 6
    const ctx = [
      '【本段落上下文 —— 这就是你要写的分镜，信息已完整】',
      `- 段落：第 ${shot.shotNumber} 段，时长 ${secs} 秒（${shot.frames} 帧）`,
      `- 景别：${shot.shotSize || '未指定'}；运镜：${shot.camera || '未指定'}；${shot.vocalState === 'silent' ? '本段无人生' : '本段有人声'}`,
      `- 出场人物：@${character?.name || '主角'}`,
      `- 场景：@${sc?.name || '主场景'}`,
      `- 参考图顺序（出场 header 必须与它一致）：${order || '（本段无参考图）'}`,
      shot.lyric ? `- 本段歌词/台词：${String(shot.lyric)}` : '',
      beats.length ? `- 拍点：${JSON.stringify(beats)}` : '',
      `- 本段画面稿（已定稿，按它写，不要另编剧情）：${String(shot.description || '')}`,
      shot.promptExtra ? `- 补充说明（逐条满足）：${String(shot.promptExtra)}` : '',
    ].filter(Boolean).join('\n')
    const sys = `你是影视分镜视频提示词写手。下面是你必须严格遵守的技能规范：\n\n${skill}`
    const zhRaw = await askText(sys,
      `${ctx}\n\n任务：按规范写**中文工作版** video_prompt。首行必须是出场 header（\`出场人物：@…；场景：@…\`，有道具再加），正文按 0-${secs} 秒分拍、每拍用 @名 引用出场实体。只输出正文，不要解释、不要代码块。`,
      4000, project.textConfigId)
    const zh = mvCleanText(zhRaw)
    if (!zh || !mvLooksChinese(zh)) throw new Error('中文工作版无效')
    const enRaw = await askText(sys,
      `${ctx}\n\n任务：按规范写**英文发送版** video_prompt_en（官方六段式骨架，全英文），实体用 @名 引用、顺序与 header 一致。只输出正文，不要解释、不要代码块。`,
      4000, project.textConfigId)
    const en = mvCleanText(enRaw).replace(/[\u4e00-\u9fa5]/g, '')
    if (!en) throw new Error('英文发送版为空')
    return { zh, en }
  } catch (err: any) {
    logTaskError('MV', 'shot-prompt', { sid: shot.id, error: err?.message })
    return null
  }
}

async function toChineseStoryboards(items: ZhItem[], configId?: number | null): Promise<string[]> {
  const out = new Array(items.length).fill('')
  const body = (it: ZhItem) => `时长: ${it.seconds}s（${it.vocalState === 'non_vocal' ? '本段无唱/间奏' : '本段有唱'}）
英文提示词：
${it.en}
镜头编排：
${JSON.stringify(it.beats)}`

  const runOne = async (it: ZhItem): Promise<string> => {
    try {
      const ask = `你是这支 MV 的导演。把这一段整理成中文导演分镜稿。\n\n${ZH_FORMAT}\n\n要求：\n- 逐拍写，起止秒/景别/机位与「镜头编排」完全一致\n- 画面描述要把英文提示词里的场面、人物、服装、光影、运镜细节搬进来\n- 有唱写"脸和嘴全程可见、口型跟着原曲"；间奏写"嘴自然闭合"\n- 只输出中文\n\n${body(it)}\n\n只输出 JSON 对象：{"zh":"…"}（zh 内用 \\n 换行）`
      const o = pickJson<any>(await askText('你是 MV 导演，只输出 JSON。', ask, 4000, configId))
      return String(o?.zh || '').trim()
    } catch { return '' }
  }

  for (let i = 0; i < items.length; i += 2) {
    const chunk = items.slice(i, i + 2)
    try {
      const ask = `你是这支 MV 的导演。下面 ${chunk.length} 段视频，每段给「英文提示词 + 镜头编排」，逐段写成中文导演分镜稿。\n\n${ZH_FORMAT}\n\n要求：起止秒/景别/机位与编排一致；画面描述具体（环境/人物/服装/动作表情/光线色调/镜头运动）；只输出中文。\n\n${chunk.map((it, k) => `--- ${k} ---\n${body(it)}`).join('\n\n')}\n\n只输出 JSON 数组：[{"index":0,"zh":"…"}]`
      const arr = pickJson<any>(await askText('你是 MV 导演，只输出 JSON。', ask, 8000, configId))
      for (const o of Array.isArray(arr) ? arr : []) {
        const k = Number(o?.index)
        if (Number.isFinite(k) && k >= 0 && k < chunk.length) out[i + k] = String(o?.zh || '').trim()
      }
    } catch { /* 整块失败，逐条补 */ }
    for (let k = 0; k < chunk.length; k++) {
      if (!out[i + k]) out[i + k] = await runOne(chunk[k])
    }
  }
  return out
}

/** 把中文补充说明整批翻成英文（一条 LLM 调用；失败返回空数组，编译照常跑） */
async function translateExtras(list: string[], configId?: number | null): Promise<string[]> {
  const idx = list.map((t, i) => [t, i] as const).filter(([t]) => t)
  if (!idx.length) return []
  try {
    const ask = `把下面每条「视频补充说明」翻成英文（电影摄影/画面约束用语，简短，不解释、不加序号）：
${idx.map(([t, i]) => `${i}: ${t}`).join('\n')}

只输出 JSON 数组：[{"index":0,"en":"…"}]`
    const out = pickJson<any[]>(await askText('你是影视提示词翻译，只输出 JSON。', ask, 2000, configId))
    const arr = new Array(list.length).fill('')
    for (const o of Array.isArray(out) ? out : []) {
      const i = Number(o?.index)
      if (Number.isFinite(i) && i >= 0 && i < arr.length) arr[i] = String(o?.en || '').trim()
    }
    return arr
  } catch { return [] }
}

/** 调当前文本模型（OpenAI 形状 /chat/completions；不用 Agent，避免它的提示词风格污染） */
async function askText(system: string, user: string, maxTokens = 2500, configId?: number | null): Promise<string> {
  const cfg = (configId ? await getConfigById(Number(configId)) : null) ?? await getTextConfig()
  let model = ''
  try { model = (JSON.parse(cfg.model || '[]') as string[])[0] || '' } catch { model = String(cfg.model || '') }
  const resp = await fetch(joinProviderUrl(getTextProviderBaseUrl(cfg), '/v1', '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || ''}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens }),
  })
  if (!resp.ok) throw new Error(`文本模型返回 ${resp.status}：${(await resp.text()).slice(0, 200)}`)
  const text = extractChatText(await resp.json())
  if (!text.trim()) throw new Error('文本模型返回空内容（换一个文本模型再试）')
  return text
}

/** 从模型回复里抠 JSON（容忍 ```json 围栏和前后废话） */
function pickJson<T>(text: string): T {
  const s = String(text).replace(/```(?:json)?/gi, '').trim()
  const i = s.search(/[[{]/)
  const j = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'))
  if (i < 0 || j <= i) throw new Error(`模型没回 JSON：${s.slice(0, 160)}`)
  return JSON.parse(s.slice(i, j + 1)) as T
}

function mvDir(projectId: number) {
  const rel = `mv/p${projectId}`
  fs.mkdirSync(path.join(STORAGE_ROOT, rel), { recursive: true })
  return rel
}

function b64ToBuffer(dataUrl: string): Buffer {
  const raw = String(dataUrl || '')
  const b64 = raw.startsWith('data:') ? raw.split(',').slice(1).join(',') : raw
  return Buffer.from(b64, 'base64')
}

function readAsDataUrl(rel: string, mime: string): string {
  return `data:${mime};base64,${fs.readFileSync(getAbsolutePath(rel)).toString('base64')}`
}

/** 音频转 32kHz 单声道 PCM16 wav（H3 音频锁定只认这个；24k 实测无效） */
function to32kWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input).noVideo().audioCodec('pcm_s16le').audioFrequency(32000).audioChannels(1).format('wav')
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(output)
  })
}

/** 帧网格 5+17k（H3 只认这个）：5.167s ~ 14.375s */
function snapFrames(seconds: number): number {
  const f = Math.round(seconds * 24)
  const k = Math.round((f - 5) / 17)
  return Math.min(345, Math.max(124, 5 + 17 * k))
}

const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
void stamp   // 保留：出图/上传文件名可能用到

async function loadProject(id: number) {
  const [row] = await db.select().from(schema.mvProjects).where(and(eq(schema.mvProjects.id, id), isNull(schema.mvProjects.deletedAt)))
  return row || null
}

async function shotsOf(projectId: number) {
  return db.select().from(schema.mvShots).where(eq(schema.mvShots.projectId, projectId)).orderBy(schema.mvShots.shotNumber)
}

/** 把 LLM 给的拍点夹进段内：首尾相接、正好铺满 seconds（1~3 拍） */
function fitBeats(raw: any, seconds: number, size: string, camera: string, shotNumber = 1, vocal = true): any[] {
  const list = Array.isArray(raw) ? raw : []
  const total = Math.max(0.5, seconds)
  const cuts: number[] = []
  for (const b of list) {
    const e = Number(b?.end)
    if (Number.isFinite(e) && e > 0.2 && e < total - 0.2) cuts.push(e)
  }
  const uniq = [...new Set(cuts.map((c) => Math.round(c * 1000) / 1000))].sort((a, b) => a - b).slice(0, 3)
  const bounds = [0, ...uniq, total]
  // 运镜兜底：按段号交替「固定 → 缓慢推近 → 固定 → 缓慢拉远」，别整片一个机位
  const CAM_CYCLE = ['固定机位', '缓慢推近', '固定机位', '缓慢拉远']
  const camFallback = camera || CAM_CYCLE[(Math.max(1, shotNumber) - 1) % CAM_CYCLE.length]
  // 动作兜底必须按段轮换：写死同一句会让每一段动作完全一样（实测分镜1/2 都"往镜头走"）
  const ACT_CYCLE = [
    'she sings steadily into the lens, swaying gently with the beat',
    'she turns to a three-quarter angle and keeps singing, one hand rising with the phrase',
    'she closes her eyes for a moment mid-line, shoulders easing with the beat',
    'she tilts her head toward the light and sings, hair drifting across her cheek',
    'she shifts her weight and sings on, chin lifting slightly on the phrase',
  ]
  const ACT_ZH_CYCLE = [
    '她对着镜头稳稳唱，随节拍轻轻摆动',
    '她转向三分之四侧继续唱，一只手随乐句抬起',
    '她唱到一半轻轻闭眼，肩膀随节拍放松',
    '她微微偏头朝光而唱，发丝扫过脸颊',
    '她换了个重心继续唱，唱到乐句时下巴轻抬',
  ]
  const ACT_NV_CYCLE = [
    'she breathes quietly, shoulders relaxing, gaze drifting off the lens',
    'she stands still and lets the room breathe, only her hair moving slightly',
  ]
  const ACT_NV_ZH_CYCLE = [
    '她安静呼吸，肩膀放松，视线自然移开',
    '她一语不发地站着，只有发丝轻轻动',
  ]
  const idx0 = Math.max(1, shotNumber) - 1
  const actFallback = vocal
    ? ACT_CYCLE[idx0 % ACT_CYCLE.length]
    : ACT_NV_CYCLE[idx0 % ACT_NV_CYCLE.length]
  const actZhFallback = vocal
    ? ACT_ZH_CYCLE[idx0 % ACT_ZH_CYCLE.length]
    : ACT_NV_ZH_CYCLE[idx0 % ACT_NV_ZH_CYCLE.length]
  return bounds.slice(1).map((end, k) => {
    const start = bounds[k]
    const src = Array.isArray(list) ? list[k] || {} : {}
    return {
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      size: String(src.size || size).slice(0, 10),
      // 编排模型经常把动作/机位留空（实测：beats 里 action/camera 全空 → 画面全靠模型自由发挥）
      camera: String(src.camera || camFallback).slice(0, 200),
      action: String(src.action || actFallback).slice(0, 300),
      action_zh: String(src.action_zh || actZhFallback).slice(0, 300),
    }
  })
}

/** 这一段的参考图：绑了就用绑的（按 id 顺序），没绑沿用「第一个人物 + 第一个场景」 */
async function shotRefs(projectId: number, shot: any) {
  const rows = await assetsOf(projectId)
  let ids: number[] = []
  try { const v = JSON.parse(String(shot?.refIds || '[]')); if (Array.isArray(v)) ids = v.map(Number).filter(Boolean) } catch { ids = [] }
  let picked = ids.length ? ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as any[] : []
  if (!picked.length) picked = [rows.find((r) => r.kind === 'character'), rows.find((r) => r.kind === 'scene')].filter(Boolean) as any[]
  return picked
}

/** 2026-10-19：公共素材库（scope='library'，所有 MV 共用） */
async function libraryAssetsOf(kind?: Kind) {
  const rows = await db.select().from(schema.mvAssets).where(
    kind ? and(eq(schema.mvAssets.scope, 'library'), eq(schema.mvAssets.kind, kind)) : eq(schema.mvAssets.scope, 'library'))
  return rows.sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || a.id - b.id)
}

async function assetsOf(projectId: number, kind?: Kind) {
  // 2026-10-19：资产库挂**上一级 MV 项目**（照短剧 characters.drama_id）——同一项目下的歌共用同一套人物/场景。
  const [pj0] = await db.select().from(schema.mvProjects).where(eq(schema.mvProjects.id, projectId))
  const sid = Number((pj0 as any)?.seriesId) || 0
  const mine = sid
    ? or(eq(schema.mvAssets.seriesId, sid), eq(schema.mvAssets.projectId, projectId))
    : eq(schema.mvAssets.projectId, projectId)
  const rows = await db.select().from(schema.mvAssets).where(
    kind ? and(mine, eq(schema.mvAssets.kind, kind)) : mine)
  return rows.sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || a.id - b.id)
}

/**
 * 按「项目上下文」取一条资产行。
 * 资产库挂项目级（series_id），同一项目下的歌共用 ⇒ 只要同系列就算可见；
 * 老数据没有 series_id 的按 project_id 判。
 */
async function assetInProject(projectId: number, assetId: number) {
  const [asset] = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.id, assetId))
  if (!asset) return null
  if (Number(asset.projectId) === Number(projectId)) return asset
  const sid = Number(asset.seriesId) || 0
  if (!sid) return null
  const [pj] = await db.select().from(schema.mvProjects).where(eq(schema.mvProjects.id, Number(projectId)))
  return Number((pj as any)?.seriesId) === sid ? asset : null
}

/** 出片用的「主」资产：每一类取第一个 */
async function primaryAssets(projectId: number) {
  const rows = await assetsOf(projectId)
  return {
    character: rows.find((r) => r.kind === 'character') || null,
    scene: rows.find((r) => r.kind === 'scene') || null,
  }
}

/**
 * 项目的画风头（资产图片提示词的第一段）。
 * 项目没选画风（老项目）时兜底用预设里排序第一个 —— 风格那里本来就有默认值，别让提示词裸奔。
 */
async function styleHead(project: any): Promise<string> {
  try {
    const head = (await getStyleSpecByValue(project?.style)).head
    if (head) return head
    const [first] = await db.select().from(schema.stylePresets)
      .where(eq(schema.stylePresets.isActive, true))
      .orderBy(schema.stylePresets.sortOrder).limit(1)
    return first ? (await getStyleSpecByValue(first.value)).head : ''
  } catch { return '' }
}

/**
 * MV 自己的最小兜底指令（2026-10-19）：正常路径是「设置 → Agent 配置」里的
 * workspace/prompts/<type>.md（见 mvPrompt），这里只在读不到文件时用一句最小指令顶上 ——
 * 为的是**不引短剧的 agents/index**，把 MV 后端对短剧的依赖彻底断开。
 */
const MV_FALLBACK_PROMPTS: Record<string, string> = {
  mv_extractor: '从给定内容里提取人物和场景，只输出 JSON。',
  mv_asset_image: '为人物或场景写生图提示词，只输出提示词正文。',
  mv_storyboard: '按歌曲把内容切成带起止时间的段落（每段 3~10 秒），只输出 JSON 数组。',
  mv_camera: '为每个段落补景别与运镜，相邻段避免重复，只输出 JSON 数组。',
}

/**
 * MV 的可自定义指令：优先用「设置 → Agent 配置」里改过的 workspace/prompts/<type>.md，
 * 没有就用 MV 自己的最小兜底（MV_FALLBACK_PROMPTS）。
 */
async function mvPrompt(type: string): Promise<string> {
  try {
    const f = await loadAgentPromptFile(type)
    if (f?.instructions) return f.instructions
  } catch { /* 读不到就用默认 */ }
  return MV_FALLBACK_PROMPTS[type] || ''
}

/** 等 sys_task 跑完（图片/视频同一张表；MV 借它拿结果） */
async function waitTask(taskId: number, timeoutMs = 600_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!row) throw new Error(`任务 ${taskId} 不存在`)
    if (row.status === 'completed') return row
    if (row.status === 'failed') throw new Error(row.errorMsg || `任务 ${taskId} 失败`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`任务 ${taskId} 超时未完成`)
}

/** 本地读时长（ffprobe），建项目时就能给粗分镜用，不必先送 4080 */
function probeSeconds(file: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      ffmpeg.ffprobe(file, (err: any, meta: any) => {
        const d = Number(meta?.format?.duration)
        resolve(err || !Number.isFinite(d) ? 0 : Math.round(d * 1000) / 1000)
      })
    } catch { resolve(0) }
  })
}

/**
 * 原曲送 4080 —— **只在第一次真正需要时做**（切分镜 / 提交片段），建项目时只落本地。
 * 做一次就记住文件名，之后每段只带名字。
 */
async function ensureRemoteSong(project: any): Promise<string> {
  if (project?.songRemoteName) return String(project.songRemoteName)
  if (!project?.songFile) throw new Error('项目里没有歌文件')
  const rel = mvDir(Number(project.id))
  const wavRel = `${rel}/song_32k.wav`
  await to32kWav(getAbsolutePath(project.songFile), getAbsolutePath(wavRel))
  const name = `mv_p${project.id}_song_32k.wav`
  const info = await shimPost<{ name: string; seconds: number }>('/v2/mv/audio', {
    name, data: readAsDataUrl(wavRel, 'audio/wav'),
  })
  const remote = String(info?.name || name)
  await db.update(schema.mvProjects).set({
    songRemoteName: remote,
    songSeconds: Number(info?.seconds || project.songSeconds || 0),
    updatedAt: now(),
  }).where(eq(schema.mvProjects.id, Number(project.id)))
  project.songRemoteName = remote
  logTaskSuccess('MV', 'song-pushed', { id: project.id, name: remote, seconds: info?.seconds })
  return remote
}

// ---------------------------------------------------------------- 项目

/**
 * 当前启用的三条通道（顶部标签栏展示用；MV 不单独锁通道，改在「设置 → AI 服务」）
 */
/**
 * 2026-10-19 照短剧结构补「上一级 MV 项目」：
 * MV 项目(mv_series) → 歌(mv_projects) → 段(mv_shots)；人物/场景资产库挂项目级（mv_assets.series_id），
 * 所以同一个 MV 项目下换一首歌，人物和场景照样共用。
 */
app.get('/series', async (c) => {
  const rows = await db.select().from(schema.mvSeries).orderBy(desc(schema.mvSeries.id))
  const allAssets = await db.select().from(schema.mvAssets)
  const out: any[] = []
  for (const r of rows) {
    const songs = await db.select().from(schema.mvProjects)
      .where(and(eq(schema.mvProjects.seriesId, r.id), isNull(schema.mvProjects.deletedAt)))
    const assets = allAssets.filter((a) => a.seriesId === r.id)
    out.push({
      ...r,
      songCount: songs.length,
      assetCount: assets.length,
      // 封面 = 项目里第一张已出的**场景图**（照短剧首页口径：场景图是单幅完整画面，适合当封面；人物图是四格参考板不拿来当封面）。
      // 没有场景图就用首字兜底。状态按「有没有 MV」派生（不加列）
      cover: assets.find((a) => a.kind === 'scene' && !!a.image)?.image || null,
      status: songs.length ? 'active' : 'empty',
      songs: songs.map((x) => ({ id: x.id, title: x.title })),
    })
  }
  return success(c, { series: out })
})

/**
 * 项目详情（照短剧 GET /dramas/:id）：一次返回项目 + 下面的 MV（歌）+ 项目级素材库。
 * 素材的增删改仍走 /projects/:id/assets/:aid（资产行自带 projectId，前端拿它当上下文）——
 * 不另开一套 series 级 CRUD，避免两条路径写同一张表。
 */
app.get('/series/:sid', async (c) => {
  const sid = Number(c.req.param('sid'))
  const [series] = await db.select().from(schema.mvSeries).where(eq(schema.mvSeries.id, sid))
  if (!series) return notFound(c, 'MV 项目不存在')
  const songs = await db.select().from(schema.mvProjects)
    .where(and(eq(schema.mvProjects.seriesId, sid), isNull(schema.mvProjects.deletedAt)))
    .orderBy(desc(schema.mvProjects.id))
  const assets = (await db.select().from(schema.mvAssets))
    .filter((a) => a.seriesId === sid || songs.some((s) => s.id === a.projectId))
    .sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || a.id - b.id)
  const shots = await db.select().from(schema.mvShots)
  const items = songs.map((p) => {
    const mine = assets.filter((a) => a.projectId === p.id)
    return {
      ...p,
      cover: mine.find((a) => !!a.image)?.image || p.outputUrl || null,
      characters: mine.filter((a) => a.kind === 'character').length,
      scenes: mine.filter((a) => a.kind === 'scene').length,
      shots: shots.filter((s) => s.projectId === p.id).length,
    }
  })
  return success(c, { series, songs: items, assets })
})


app.post('/series', async (c) => {
  const body = await c.req.json().catch(() => ({} as any))
  const nowIso = now()
  const ins = await db.insert(schema.mvSeries).values({
    title: String(body.title || '未命名 MV 项目').slice(0, 80),
    style: body.style ? String(body.style) : null,
    aspectRatio: String(body.aspect_ratio || '16:9').slice(0, 10),
    createdAt: nowIso, updatedAt: nowIso,
  } as any)
  return created(c, { id: getInsertId(ins) })
})

app.put('/series/:sid', async (c) => {
  const sid = Number(c.req.param('sid'))
  const body = await c.req.json().catch(() => ({} as any))
  const patch: any = { updatedAt: now() }
  if (body.title !== undefined) patch.title = String(body.title).slice(0, 80)
  if (body.style !== undefined) patch.style = String(body.style)
  if (body.aspect_ratio !== undefined) patch.aspectRatio = String(body.aspect_ratio).slice(0, 10)
  await db.update(schema.mvSeries).set(patch).where(eq(schema.mvSeries.id, sid))
  return success(c, { id: sid })
})

/**
 * 删 MV 项目 = 连项目下的歌一起删（照短剧删剧级联）。
 * 只删 mv_series 会留一堆看不见的歌/资产/分镜（列表按 series 取，界面看不出残留）。
 */
app.delete('/series/:sid', async (c) => {
  const sid = Number(c.req.param('sid'))
  const songs = await db.select().from(schema.mvProjects).where(eq(schema.mvProjects.seriesId, sid))
  for (const s of songs) {
    await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, s.id))
    await db.delete(schema.mvAssets).where(eq(schema.mvAssets.projectId, s.id))
    await db.delete(schema.mvProjects).where(eq(schema.mvProjects.id, s.id))
  }
  // 项目级资产（series_id 挂上、但 project_id 属于别的歌或已不存在）一并清
  await db.delete(schema.mvAssets).where(eq(schema.mvAssets.seriesId, sid))
  await db.delete(schema.mvSeries).where(eq(schema.mvSeries.id, sid))
  logTaskSuccess('MV', 'delete-series', { id: sid, songs: songs.length })
  return success(c, { ok: true, songs: songs.length })
})

app.get('/channels', async (c) => {
  const name = (cfg: any) => {
    if (!cfg) return ''
    try {
      const arr = JSON.parse(cfg.model || '[]')
      return Array.isArray(arr) ? String(arr[0] || '') : String(cfg.model || '')
    } catch { return String(cfg.model || '') }
  }
  const [text, image, video] = await Promise.all([
    getTextConfig().catch(() => null),
    getActiveConfig('image').catch(() => null),
    getActiveConfig('video').catch(() => null),
  ])
  return success(c, { text: name(text), image: name(image), video: name(video) })
})

app.get('/projects', async (c) => {
  const rows = await db.select().from(schema.mvProjects).where(isNull(schema.mvProjects.deletedAt)).orderBy(desc(schema.mvProjects.id))
  // 列表卡片要封面和「N 人物 · M 场景 · K 段」，一次性算好（表小，直接全取内存里归并）
  const assets = await db.select().from(schema.mvAssets)
  const shots = await db.select().from(schema.mvShots)
  const items = rows.map((p) => {
    const mine = assets.filter((a) => a.projectId === p.id)
    return {
      ...p,
      cover: mine.find((a) => !!a.image)?.image || p.outputUrl || null,
      characters: mine.filter((a) => a.kind === 'character').length,
      scenes: mine.filter((a) => a.kind === 'scene').length,
      shots: shots.filter((s) => s.projectId === p.id).length,
    }
  })
  return success(c, { items })
})

/** 删除 MV 项目：连人物/场景/分镜记录一起删（不动磁盘上的 static 文件） */
app.delete('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, id))
  await db.delete(schema.mvAssets).where(eq(schema.mvAssets.projectId, id))
  await db.delete(schema.mvProjects).where(eq(schema.mvProjects.id, id))
  logTaskSuccess('MV', 'delete-project', { id })
  return success(c, { ok: true })
})

app.get('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const shots = await shotsOf(id)
  // 顺手把在跑的任务状态同步进来（页面只轮询这一个接口）
  for (const s of shots) {
    if (s.status === 'processing' && s.taskId) {
      const [t] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(s.taskId)))
      if (t && t.status !== 'processing') {
        const patch: Record<string, any> = { status: t.status, updatedAt: now() }
        if (t.localPath) {
          // 旧的那条推进历史（预览区「历史视频」用），再换成本次结果
          if (s.videoUrl && s.videoUrl !== t.localPath) {
            let hist: string[] = []
            try { hist = JSON.parse(String(s.history || '[]')) } catch { hist = [] }
            patch.history = JSON.stringify([s.videoUrl, ...hist.filter((h) => h !== s.videoUrl)].slice(0, 20))
          }
          patch.videoUrl = await trimToSegment(t.localPath, s, project.songFile as string)   // 多给的 warmup 前导帧裁掉，否则拼接口型错位
          // 耗时口径照短剧：优先用中转/ComfyUI 回报的真值 timing.genSeconds（纯生成），没有才退回挂钟差
          let genSec = 0
          try {
            const pp = JSON.parse(String((t as any).params || '{}'))
            const g = Number(pp?.timing?.genSeconds)
            if (Number.isFinite(g) && g > 0) genSec = Math.round(g)
          } catch { genSec = 0 }
          if (!genSec) {
            const c0 = Date.parse(String((t as any).createdAt || ''))
            const c1 = Date.parse(String((t as any).completedAt || ''))
            if (Number.isFinite(c0) && Number.isFinite(c1) && c1 > c0) genSec = Math.round((c1 - c0) / 1000)
          }
          if (genSec) patch.elapsedSeconds = genSec
          // 任务列表的缩略图 = 视频首帧（抽帧失败不阻断，前端按 404 兜底）
          try { await extractVideoPoster(t.localPath) } catch { /* 忽略 */ }
        }
        if (t.errorMsg) patch.errorMsg = t.errorMsg
        await db.update(schema.mvShots).set(patch).where(eq(schema.mvShots.id, s.id))
        Object.assign(s, patch)
      }
    }
  }
  // 历史视频：只认本段 task_ids 里记的任务（短剧分镜 id 与 MV 段 id 会撞号，不能用 storyboard_id 反查）
  const taskOwner = new Map<number, number>()
  const allTaskIds: number[] = []
  for (const x of shots as any[]) {
    try {
      for (const t of JSON.parse(String(x.taskIds || '[]'))) {
        const n = Number(t)
        if (Number.isFinite(n)) { allTaskIds.push(n); taskOwner.set(n, x.id) }
      }
    } catch { /* 脏数据忽略 */ }
  }
  const ownerShotId = (tid: number) => taskOwner.get(Number(tid)) ?? null
  const tasks = allTaskIds.length
    ? await db.select().from(schema.sysTask)
      .where(and(eq(schema.sysTask.type, 'video'), inArray(schema.sysTask.id, allTaskIds)))
      .orderBy(desc(schema.sysTask.id)).limit(500)
    : []
  const merges = await db.select().from(schema.mvMerges)
    .where(and(eq(schema.mvMerges.projectId, id), isNull(schema.mvMerges.deletedAt)))
    .orderBy(desc(schema.mvMerges.id)).limit(200)
  return success(c, {
    project, assets: await assetsOf(id), libraryAssets: await libraryAssetsOf(), shots, merges,
    videoTasks: tasks.map((t: any) => ({
      id: t.id, shotId: ownerShotId(t.id), url: t.localPath || t.resultUrl || '',
      status: t.status, createdAt: t.createdAt, error: t.errorMsg || null,
    })),
  })
})

app.delete('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.mvProjects).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  return success(c, null)
})

/** 建项目：只做本地的事（落库 + 存歌 + 读时长），不碰 4080 */
app.post('/projects', async (c) => {
  let body: any
  try { body = await c.req.json() } catch (err: any) { return badRequest(c, `请求体不是 JSON: ${err?.message}`) }
  if (!body?.song?.data) return badRequest(c, '缺 song.data（歌的 base64/data URL）')
  const maxShot = Math.min(HARD_MAX_S, Math.max(5, Number(body.max_shot_seconds) || DEFAULT_MAX_S))
  const ts = now()
  try {
    let useSeries = Number(body.series_id) || 0
    if (!useSeries) {
      const ins0 = await db.insert(schema.mvSeries).values({
        title: String(body.title || '未命名 MV 项目').slice(0, 80),
        style: String(body.style || '') || null,
        aspectRatio: String(body.aspect_ratio || '16:9').slice(0, 10),
        createdAt: ts, updatedAt: ts,
      } as any)
      useSeries = getInsertId(ins0)
    }
    const res = await db.insert(schema.mvProjects).values({
      seriesId: useSeries,
      title: String(body.title || '未命名 MV').slice(0, 80),
      idea: String(body.idea || '').slice(0, 2000),
      lyrics: String(body.lyrics || '').slice(0, 8000),
      style: String(body.style || '').slice(0, 60),
      storyPrompt: String(body.story_prompt || '').slice(0, 20000),
      aspectRatio: String(body.aspect_ratio || '16:9').slice(0, 10),   // 2026-10-19 新建默认 16:9（横屏）
      maxShotSeconds: maxShot,
      status: 'draft',
      createdAt: ts, updatedAt: ts,
    })
    const id = getInsertId(res)
    const rel = mvDir(id)
    const srcExt = String(body.song.name || '').toLowerCase().endsWith('.wav') ? '.wav' : '.mp3'
    const songRel = `${rel}/song_src${srcExt}`
    fs.writeFileSync(getAbsolutePath(songRel), b64ToBuffer(String(body.song.data)))
    const seconds = await probeSeconds(getAbsolutePath(songRel))
    await db.update(schema.mvProjects).set({ songFile: songRel, songSeconds: seconds, updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'create-project', { id, seconds })
    return created(c, { id, song_seconds: seconds })
  } catch (err: any) {
    logTaskError('MV', 'create-project', { error: err?.message })
    return serverError(c, err?.message || '建 MV 项目失败')
  }
})

/** 改项目（标题 / 风格 / 分镜提示词 / 想法 / 歌词 / 最长切分） */
app.put('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body = await c.req.json().catch(() => ({} as any))
  let seriesId = Number(body?.series_id) || 0
  const patch: Record<string, any> = { updatedAt: now() }
  if (body.title !== undefined) {
    const t = String(body.title).trim().slice(0, 80)
    if (!t) return badRequest(c, '标题不能为空')
    patch.title = t
  }
  if (body.style !== undefined) patch.style = String(body.style).slice(0, 60)
  if (body.aspect_ratio !== undefined) patch.aspectRatio = String(body.aspect_ratio).slice(0, 10)
  for (const [k, col] of [['text_config_id', 'textConfigId'], ['image_config_id', 'imageConfigId'], ['video_config_id', 'videoConfigId']] as const) {
    if (body[k] !== undefined) patch[col] = body[k] === null || body[k] === '' ? null : Number(body[k]) || null
  }
  if (body.story_prompt !== undefined) patch.storyPrompt = String(body.story_prompt).slice(0, 20000)
  if (body.idea !== undefined) patch.idea = String(body.idea).slice(0, 2000)
  if (body.lyrics !== undefined) patch.lyrics = String(body.lyrics).slice(0, 8000)
  if (body.max_shot_seconds !== undefined) {
    patch.maxShotSeconds = Math.min(HARD_MAX_S, Math.max(5, Number(body.max_shot_seconds) || DEFAULT_MAX_S))
  }
  await db.update(schema.mvProjects).set(patch).where(eq(schema.mvProjects.id, id))
  return success(c, { project: await loadProject(id) })
})

// ---------------------------------------------------------------- 人物 / 场景（MV 自己的资产表）

/** 从分镜提示词提取人物 + 场景（覆盖式重建；不动短剧的 characters / scenes） */
app.post('/projects/:id/extract', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const story = String(body.story_prompt ?? project.storyPrompt ?? '').trim()
  if (!story) return badRequest(c, '先填分镜提示词，再提取人物和场景')
  const ask = `下面是这支 MV 的分镜提示词（用户写的）：

"""
${story.slice(0, 12000)}
"""

请从中提取**人物**和**场景**，**严格按上面那份规范**填字段（规范里要求的四项颜色、禁模糊词、字数都要照做）：
1) 只提取这份分镜提示词里真实出现过的，不要自己发明、不要补充没写的东西。
2) 人物 appearance（样貌）按规范写成 **300~500 字**：性别、年龄感、五官、发型发色、**肤色的色阶与明暗**、体态、气质（性格要转成外在神态写，不要直接写性格词）。
3) 人物 styling（妆造）：发型、服装、妆面、配饰 —— **每件单品都要写颜色**（外套/上衣/裤子/鞋），配饰写颜色或材质。
4) 人物 description = 样貌 + 妆造的完整合并描述（同样写长写具体，不要只有一句）。
5) 🔴 四项颜色（发色 / 肤色 / 服装颜色 / 配饰颜色或材质）一个都不能少；**禁止「或」「或者」「可能」「皆可」这类二选一**，原文带「或」就当场挑定一个写死。
6) 场景 description：地点、时间、光线、色调、氛围、前景/中景/后景层次（写具体，不要一句话带过）。
7) name 用简短中文名（人物用名字或代称，场景用「地点+时间」）；同一个人的不同叫法合并成一个人。
8) 没有人物就返回空数组。

只输出 JSON：
{"characters":[{"name":"","description":"","appearance":"","styling":""}],"scenes":[{"name":"","description":""}]}
appearance 只写脸/身形容貌，styling 只写服装配饰；拆不出来就留空。`
  try {
    const out = pickJson<{ characters?: any[]; scenes?: any[] }>(
      await askText(
        readSkillFile('extractor') || (await mvPrompt('mv_extractor')),
        ask, 6000, project.textConfigId))
    const ts = now()
    await db.delete(schema.mvAssets).where(eq(schema.mvAssets.projectId, id))
    let sort = 0
    for (const kind of KINDS) {
      const list = (kind === 'character' ? out.characters : out.scenes) || []
      for (const a of list) {
        const desc = String(a?.description || '').trim()
        const name = String(a?.name || '').trim()
        if (!desc && !name) continue
        await db.insert(schema.mvAssets).values({
          seriesId: Number((project as any)?.seriesId) || null,
          projectId: id,
          kind,
          name: name.slice(0, 60) || (kind === 'character' ? `人物${sort + 1}` : `场景${sort + 1}`),
          description: desc.slice(0, 4000),
          appearance: String(a?.appearance || '').slice(0, 2000),
          styling: String(a?.styling || '').slice(0, 2000),
          sortOrder: sort++,
          createdAt: ts, updatedAt: ts,
        })
      }
    }
    logTaskSuccess('MV', 'extract', { id, characters: out.characters?.length || 0, scenes: out.scenes?.length || 0 })
    return success(c, { assets: await assetsOf(id) })
  } catch (err: any) {
    logTaskError('MV', 'extract', { id, error: err?.message })
    return serverError(c, `提取失败：${err?.message}`)
  }
})

/** 改单个资产（名字 / 描述 / 容貌 / 服装） */
app.put('/projects/:id/assets/:aid', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const asset = await assetInProject(id, aid)
  if (!asset) return notFound(c, '资产不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const patch: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) patch.name = String(body.name).slice(0, 60)
  if (body.description !== undefined) patch.description = String(body.description).slice(0, 4000)
  if (body.appearance !== undefined) patch.appearance = String(body.appearance).slice(0, 2000)
  if (body.styling !== undefined) patch.styling = String(body.styling).slice(0, 2000)
  if (body.prompt !== undefined) patch.prompt = String(body.prompt)
  if (body.prompt_extra !== undefined) patch.promptExtra = String(body.prompt_extra || '').slice(0, 1200)
  if (body.ref_ids !== undefined) patch.refIds = JSON.stringify(
    (Array.isArray(body.ref_ids) ? body.ref_ids : []).map(Number).filter(Boolean)).slice(0, 4000)
  await db.update(schema.mvAssets).set(patch).where(eq(schema.mvAssets.id, aid))
  return success(c, { assets: await assetsOf(id) })
})

app.delete('/projects/:id/assets/:aid', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const doomed = await assetInProject(id, aid)
  if (!doomed) return notFound(c, '资产不存在')
  await db.delete(schema.mvAssets).where(eq(schema.mvAssets.id, aid))
  return success(c, { assets: await assetsOf(id) })
})

/** 资产提示词规则：直接用短剧的那两份 skill（人物板 / 场景），读不到才回退 MV 自己的指令 */
async function assetRule(kind: string): Promise<string> {
  const drama = readSkillFile(kind === 'character' ? 'prompt-generator/character-prompt' : 'prompt-generator/scene-prompt')
  return drama || (await mvPrompt('mv_asset_image'))
}

/**
 * 给资产生成「生图提示词」（照短剧：描述 → 生成提示词 → 出图）
 *
 * 规则来自短剧自己的 skill（人物 = prompt-generator/character-prompt，场景 = scene-prompt），
 * 输出＝**风格头在最前 + 中文资产描述 + skill 规定的构图**（与短剧 final_prompt 同款），存进 mv_assets.prompt。
 */
app.post('/projects/:id/assets/:aid/prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const asset = await assetInProject(id, aid)
  if (!asset) return notFound(c, '资产不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const desc = String(body.description ?? asset.description ?? '').trim()
  if (!desc) return badRequest(c, '这个资产还没有描述 —— 先写清外貌/场景，再生成提示词')
  if (body.description !== undefined || body.name !== undefined) {
    await db.update(schema.mvAssets).set({
      description: desc.slice(0, 4000),
      name: String(body.name ?? asset.name ?? '').slice(0, 60),
      updatedAt: now(),
    }).where(eq(schema.mvAssets.id, aid))
  }
  const rule = await assetRule(asset.kind)
  const head = await styleHead(project)
  try {
    const text = await askText(
      `${rule}\n\n` +
      `【本次任务】把这个资产写成**一条可以直接出图**的最终提示词，按下面的顺序：\n` +
      `1. **第一段必须是画风（原样照抄，一个字都不要改、不要翻译）**：${head || '（这个项目没选画风，用写实电影感代替）'}\n` +
      `2. **画风之后用中文写资产本身**：名字 → 样貌（脸/身形，颜色写死唯一值）→ 妆造（服装/配饰，颜色与款式逐字保留）→ 场景（地点/时间/光线/色调/氛围，人物资产才写，场景资产写描述里的全部要点）。\n` +
      `3. 构图按上面那份规范逐字落地：${asset.kind === 'character'
        ? '一帧画面里从左到右四个竖版画格、纯白背景——格1 脸部特写（只画头到肩颈、正对镜头）；格2 正面全身、格3 左侧面全身、格4 背面全身，这三格**必须用规范里的原话「头部被干净地移除」（head cleanly removed）**，并写明「画面里没有头、没有脸、没有五官、没有头发、没有后脑、没有耳朵，颈部以上直接是背景」；'
        : '固定视角，前景/中景/后景分层，画面里不出现任何人'}。\n` +
      `   ⚠️ 三视图**禁止写「无头」「不要头」「颈部裁切」这类词** —— 规范里明写：这样写模型照旧会画头。\n` +
      `   ⚠️ 人物板最后必须照抄这句收尾：「整张参考板只有格1 一处面部，格2格3格4一律头部被干净地移除」——**别改写成「无头」「没有头」**（实测会画回头）。\n` +
      `4. 画风段照抄，后面中文字段必须完整保留；最后可以再跟一小段英文关键词（可选）。\n` +
      `只输出提示词本身，不要解释、不要标题、不要编号、不要 markdown、不要引号包裹。`,
      `资产类型：${asset.kind === 'character' ? '人物' : '场景'}\n` +
      `名字：${asset.name || '（未命名）'}\n` +
      `样貌：${asset.appearance || '（未填）'}\n` +
      `妆造：${asset.styling || '（未填）'}\n` +
      `描述：${desc}`,
      2000,
      project.textConfigId,
    )
    const prompt = text.trim()
    if (!prompt) throw new Error('文本模型返回空')
    await db.update(schema.mvAssets).set({ prompt: prompt.slice(0, 4000), updatedAt: now() })
      .where(eq(schema.mvAssets.id, aid))
    logTaskSuccess('MV', 'asset-prompt', { id, aid, kind: asset.kind, chars: prompt.length })
    return success(c, { assets: await assetsOf(id) })
  } catch (err: any) {
    logTaskError('MV', 'asset-prompt', { id, aid, error: err?.message })
    return serverError(c, `生成提示词失败：${err?.message}`)
  }
})

/**
 * 给资产出图（走 App 图片通道）
 * 人物 = 四格定妆板（左1 正脸特写 + 正视/左侧/背面全身，纯白底，只出现一张脸），尺寸固定 16:9
 * 场景 = 一张场景图，尺寸跟随项目画幅；两者都拼上项目的风格头
 * 用的是上一步「生成提示词」存下来的那条提示词（没生成过不许出图）
 */
/**
 * 资产出图尺寸（照短剧）：人物板固定 16:9 = 2048x1152；场景图跟随项目画幅。
 */
const CHAR_BOARD_SIZE = '2048x1152'
const imageSizeForAsset = (project: any, kind: string): string =>
  kind === 'character' ? CHAR_BOARD_SIZE : imageSizeForAspect(project?.aspectRatio)

/**
 * 成片画幅：H3 只认 9:16 / 16:9，其它比例按横竖就近映射。
 * ponytail: 想支持更多画幅得先让 H3 支持，别在这里造轮子。
 */
function videoSize(project: any): [number, number] {
  return String(project?.aspectRatio || '16:9') === '16:9' ? [1344, 768] : [768, 1344]
}

/**
 * 后台出图排队：同一个项目里的出图请求按点击顺序**串行**跑（图片通道一次只吃一个任务），
 * 每个资产各自记状态，所以一张卡在出图时别的卡照样能点。
 */
const renderQueue = new Map<number, Promise<unknown>>()
function enqueueRender(pid: number, job: () => Promise<unknown>) {
  const prev = renderQueue.get(pid) ?? Promise.resolve()
  const next = prev.then(job, job)
  renderQueue.set(pid, next.catch(() => { }))
  return next
}

/**
 * 2026-10-19 素材库（MV 侧实现，短剧那边一行不改）：
 * - import：把公共素材库里的资产引用到本项目 —— 插一条本项目记录，图片文件共用，不复制
 * - share：把本项目资产存进公共素材库 —— scope 置 library，所有 MV 都能看到/引用
 */
app.post('/projects/:id/assets/:aid/import', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const [src] = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.id, aid))
  if (!src) return notFound(c, '素材不存在')
  if (String((src as any).scope || 'project') !== 'library') return badRequest(c, '不是素材库里的资产')
  const [dup] = await db.select().from(schema.mvAssets).where(and(
    eq(schema.mvAssets.projectId, id), eq(schema.mvAssets.sourceAssetId, aid)))
  if (dup) return success(c, { id: dup.id, skipped: true })
  const nowIso = now()
  const ins = await db.insert(schema.mvAssets).values({
    projectId: id, kind: (src as any).kind, name: (src as any).name,
    description: (src as any).description, appearance: (src as any).appearance,
    styling: (src as any).styling, image: (src as any).image, card: (src as any).card,
    prompt: (src as any).prompt, imageStatus: (src as any).imageStatus,
    scope: 'project', sourceAssetId: aid, sortOrder: 999,
    createdAt: nowIso, updatedAt: nowIso,
  } as any)
  return success(c, { id: getInsertId(ins) })
})

app.post('/projects/:id/assets/:aid/share', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const a0 = await assetInProject(id, aid)
  if (!a0) return notFound(c, '资产不存在')
  await db.update(schema.mvAssets).set({ scope: 'library', updatedAt: now() } as any)
    .where(eq(schema.mvAssets.id, aid))
  return success(c, { id: aid, scope: 'library' })
})

app.post('/projects/:id/assets/:aid/image', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const asset = await assetInProject(id, aid)
  if (!asset) return notFound(c, '资产不存在')
  const body = await c.req.json().catch(() => ({} as any))
  if (body.description !== undefined || body.name !== undefined) {
    await db.update(schema.mvAssets).set({
      description: String(body.description ?? asset.description ?? '').slice(0, 4000),
      name: String(body.name ?? asset.name ?? '').slice(0, 60),
      updatedAt: now(),
    }).where(eq(schema.mvAssets.id, aid))
  }
  const assetPrompt = String(body.prompt ?? asset.prompt ?? '').trim()
  if (!assetPrompt) return badRequest(c, '先点「生成提示词」，再出图')
  if (body.prompt !== undefined && assetPrompt !== asset.prompt) {
    await db.update(schema.mvAssets).set({ prompt: assetPrompt.slice(0, 4000), updatedAt: now() })
      .where(eq(schema.mvAssets.id, aid))
  }
  const head = await styleHead(project)
  // 提示词里已经含画风头（生成时就照抄进去了，与短剧 final_prompt 一致）⇒ 这里不再重复拼风格头；
  // 万一是手写的、不含风格头，就补一次
  const prompt = assetPrompt.includes(head.slice(0, 20)) || !head ? assetPrompt : [head, assetPrompt].join('\n')
  const imgSize = imageSizeForAsset(project, asset.kind)
  const kind = asset.kind
  const assetId = asset.id
  // 立刻回「已排队」，真实出图在后台按项目串行跑（接口不再阻塞一分钟）
  await db.update(schema.mvAssets).set({ imageStatus: 'processing', updatedAt: now() })
    .where(eq(schema.mvAssets.id, aid))
  enqueueRender(id, async () => {
    try {
      const size = imgSize      // 人物板固定 2048x1152（16:9）；场景图跟随项目画幅
      const taskId = await generateImage({ prompt, size, configId: project.imageConfigId ?? undefined })
      const task = await waitTask(taskId)
      if (!task.localPath) throw new Error('图片任务完成但没拿到文件路径')
      // 文件名带时间戳：重绘后路径变了，界面才会真的换成新图（同路径会被浏览器缓存成旧图）
      const imageRel = `${mvDir(id)}/${kind}-${assetId}-${Date.now()}.png`
      fs.copyFileSync(getAbsolutePath(task.localPath), getAbsolutePath(imageRel))
      await db.update(schema.mvAssets).set({ image: imageRel, imageStatus: null, updatedAt: now() })
        .where(eq(schema.mvAssets.id, aid))
      logTaskSuccess('MV', 'asset-image', { id, aid, kind, task: taskId })
    } catch (err: any) {
      await db.update(schema.mvAssets).set({ imageStatus: `failed: ${String(err?.message ?? err).slice(0, 160)}`, updatedAt: now() })
        .where(eq(schema.mvAssets.id, aid))
      logTaskError('MV', 'asset-image', { id, aid, error: err?.message })
    }
  })
  return success(c, { assets: await assetsOf(id) })
})

/** 给资产生卡（卡保证人物/场景锁得住；声音卡不接，音轨就是原曲） */
app.post('/projects/:id/assets/:aid/card', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const asset = await assetInProject(id, aid)
  if (!asset) return notFound(c, '资产不存在')
  if (!asset.image) return badRequest(c, '先出图，再生卡')
  const cardName = `refmod_${asset.kind}-mv${id}a${aid}_v1`
  try {
    await shimPost('/v2/refmod/extract', {
      name: cardName,
      image: readAsDataUrl(asset.image, 'image/png'),
      concept_type: asset.kind === 'character' ? 'identity' : 'background',  // extract_mod 只认 background（'scene' 会 invalid choice 报错）
    })
    await db.update(schema.mvAssets).set({ card: cardName, updatedAt: now() }).where(eq(schema.mvAssets.id, aid))
    logTaskSuccess('MV', 'asset-card', { id, aid, cardName })
    return success(c, { assets: await assetsOf(id) })
  } catch (err: any) {
    logTaskError('MV', 'asset-card', { id, aid, error: err?.message })
    return serverError(c, `抽卡失败：${err?.message}`)
  }
})
// ---------------------------------------------------------------- 分镜

/** 粗分镜：与歌等长的内容时间轴（只写画什么，不写景别运镜） */
app.post('/projects/:id/plan', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  if (!project.songSeconds) return badRequest(c, '还没拿到歌曲时长')
  const ask = `歌长 ${project.songSeconds} 秒，歌名《${project.title}》。
${project.storyPrompt
  ? `分镜提示词（用户写的）：\n"""\n${String(project.storyPrompt).slice(0, 8000)}\n"""`
  : `MV 想法：${project.idea || '(没写，按歌名发挥)'}`}
${project.lyrics ? `\n歌词（行，时间未知）：\n${String(project.lyrics).slice(0, 2000)}` : ''}

请给一条「与歌等长」的粗分镜：把 0 到 ${project.songSeconds} 秒分成若干段，前后衔接、不重叠、不留空。
每段只写「画面发生什么」（场景/动作/情绪，一句话），**不要写景别、不要写运镜**（下一步才配）。
段长参考歌曲结构（前奏/主歌/副歌/桥段/尾奏），每段 5~20 秒。
只输出 JSON 数组：[{"start":0,"end":8.5,"what":"…"}, …]`
  try {
    const outline = pickJson<any[]>(await askText(await mvPrompt('mv_storyboard'), ask, 3000, project.textConfigId))
    if (!Array.isArray(outline) || !outline.length) throw new Error('粗分镜为空')
    await db.update(schema.mvProjects).set({ outline: JSON.stringify(outline), status: 'planned', updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'plan-outline', { id, segments: outline.length })
    return success(c, { outline })
  } catch (err: any) {
    logTaskError('MV', 'plan-outline', { id, error: err?.message })
    return serverError(c, err?.message || '粗分镜失败')
  }
})

/** 详细分镜：4080 按能量/句界切硬时间轴（H3 帧网格），MV 侧按镜头语言配景别/机位/歌词 */
app.post('/projects/:id/shots', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  // 分镜的唱/非唱要靠人声轨判，没分离就切会全标成「唱」
  if (!project.vocalStem) return badRequest(c, '先点顶栏「人声分离」—— 分镜的唱/非唱要用人声轨判断')
  const body = await c.req.json().catch(() => ({} as any))
  const maxS = Math.min(HARD_MAX_S, Number(body.max_seconds || project.maxShotSeconds) || DEFAULT_MAX_S)
  // 到这一步才第一次把原曲转 32k 送 4080（建项目时不碰它）
  let remoteSong = ''
  try {
    remoteSong = await ensureRemoteSong(project)
  } catch (err: any) {
    return serverError(c, `原曲上传失败：${err?.message || err}`)
  }
  let plan: { shots: any[]; grid?: number[] }
  try {
    plan = await shimPost('/v2/mv/plan', {
      audio_file: remoteSong, max_seconds: maxS, target_seconds: 7,
      vocal_stem: project.vocalStem || undefined,
    })
  } catch (err: any) {
    return serverError(c, `切段失败：${err?.message}`)
  }
  const raw = plan?.shots || []
  if (!raw.length) return serverError(c, '切段结果为空')
  // 景别按 MV 分镜规范定（由模型按歌词情绪/音乐节奏选），这里只留兜底：有唱默认近景、间奏默认中景、首尾可中远景
  const SIZES = ['中远景', '中景', '近景', '特写']
  const fallbackSize = (i: number, n: number, vocal: string) =>
    (i === 0 || i === n - 1) ? '中远景' : (vocal === 'vocal_active' ? '近景' : '中景')
  const sizes = raw.map((s, i) => fallbackSize(i, raw.length, String(s.vocal_state || '')))
  let outline: any[] = []
  try { outline = JSON.parse(project.outline || '[]') } catch { outline = [] }
  const outlineLine = outline.map((o: any, i: number) => `${i + 1}. ${o.start}-${o.end}s：${o.what}`).join('\n')
  const lyricLines = String(project.lyrics || '').split('\n').map((l) => l.trim()).filter(Boolean)
  let perShot: any[] = []
  try {
    const ask = `下面是已经切好的镜头时间轴（秒/帧/是否在唱），**时间不许改、段数不许改**：
${raw.map((s, i) => `${i}: ${s.start}s 起 ${s.seconds}s（${s.frames}帧） ${s.vocal_state === 'vocal_active' ? '有唱' : '无唱(间奏)'}`).join('\n')}

对应内容（粗分镜）：
${outlineLine || '(无)'}
${lyricLines.length ? `歌词行：\n${lyricLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : ''}

你就是这支 MV 的导演。给每段做**镜头编排**（beat），按这一段时长切成 2~4 个镜头，**每拍 2~3.5 秒**（5~6s 段 2 拍；7~9s 段 2~3 拍；10s 以上 3~4 拍）：
- 每个镜头要有起始秒、结束秒（必须首尾相接、从 0 开始、正好铺满这一段时长）
- 景别/机位用**中文**写（机位像 "固定机位，平视，正脸三分之四"，允许 "缓慢推近" 这类运镜）
- **action 和 camera 一律不许留空**（留空等于让模型自由发挥画面）
- action 是这一段镜头里人物/画面**在做什么**，用英文一句短语（如 "she looks down and smiles"），action_zh 给同一句的中文
- **景别要跳**：相邻两拍不要同一个景别（例：中景 → 特写 → 中景），景别在 中远景/中景/近景/特写 里选
- **机位/角度每拍都要换**（正面 → 四分之三侧 → 侧脸過肩），运镜也跟着换（固定 ↗ 缓慢推近 ↗ 固定）
- **段级景别必须交替（硬规则）**：全曲所有段的 shot_size（整段主导景别）**不许连续 3 段相同** —— 严禁一路都是「近景」（现在实测就是这么错的：分镜3/4/5/6 全是近景，拼起来整片怼脸）。按「中远景 → 中景 → 近景 → 特写 → 中景 → 中远景 …」交替推进；副歌可以近景/特写为主，但每 2~3 段必须插一段中景或中远景换气；首尾段用中远景收放
- **相邻段的 action（人物动作）也不许重复或近似**：连着两段都写"往镜头走""对着镜头唱"这类同一动作是**不允许**的 —— 每段的动作要换（例：对镜头唱 → 侧身唱手随乐句抬起 → 闭眼投入 → 偏头朝光 → 换重心下巴抬起），整首歌要有动作起伏
- **相邻段不许重复同样的推进方式**：通篇看一遍你排的所有段，连着两段都是"中景 → 特写"这类同样的景别走向是**不允许**的（拼在一起会跳）；相邻段的景别顺序、机位角度、运镜方向都要明显不同（例：上段「中景 → 特写」，这段就写「近景 → 中远景」或「特写 → 近景」），整首歌的景别要有交替推进的节奏
- 有唱段：**每一拍都必须看得见脸和嘴**（只换角度/景别，不许切背影、手部、空镜）；间奏段才可以切空镜/背影/手部/环境
- 不管怎么切，段内**只能是同一个场景**，不许换地方

只输出 JSON 数组，长度必须等于 ${raw.length}：
[{"index":0,"shot_size":"中景","beats":[{"start":0,"end":2.9,"size":"中景","camera":"固定机位，平视，正脸","action":"she looks up slowly","action_zh":"她缓缓抬头"},{"start":2.9,"end":5.8,"size":"特写","camera":"侧脸过肩，微微俯视","action":"her lips part as she sings","action_zh":"她张嘴唱出第一句"},{"start":5.8,"end":8.0,"size":"中景","camera":"固定机位，四分之三侧","action":"she turns to the light","action_zh":"她转向光"}]}, …]`
    perShot = pickJson<any[]>(await askText(await mvPrompt('mv_camera'), ask, 3000, project.textConfigId))
  } catch { perShot = [] }

  try {
    const ts = now()
    await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, id))
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i]
      const extra = (Array.isArray(perShot) ? perShot : []).find((x: any) => Number(x?.index) === i) || {}
      await db.insert(schema.mvShots).values({
        projectId: id, shotNumber: i + 1,
        startSeconds: Number(s.start), endSeconds: Number(s.end),
        frames: Number(s.frames), seconds: Number(s.seconds),
        shotSize: SIZES.includes(String(extra?.shot_size || '')) ? String(extra.shot_size) : (sizes[i] || '中景'),
        camera: String(extra?.camera || '').slice(0, 300),
        beats: JSON.stringify(fitBeats(extra?.beats, Number(s.seconds) || 5.167, String(extra?.shot_size || sizes[i] || '中景'), String(extra?.camera || ''), i + 1, String(s.vocal_state || '') === 'vocal_active')),
        vocalState: String(s.vocal_state || 'vocal_active'), lyric: String(extra?.lyric || '').slice(0, 300),
        status: 'pending', createdAt: ts, updatedAt: ts,
      })
    }
    await db.update(schema.mvProjects).set({ status: 'shots', maxShotSeconds: maxS, updatedAt: ts }).where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'shots', { id, count: raw.length, maxS })
    return success(c, { count: raw.length, max_seconds: maxS, grid: plan.grid || [], shots: await shotsOf(id) })
  } catch (err: any) {
    logTaskError('MV', 'shots', { id, error: err?.message })
    return serverError(c, err?.message || '写分镜表失败')
  }
})

/** 手改单段（景别/机位/歌词/提示词） */
app.put('/projects/:id/shots/:sid', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const patch: Record<string, any> = { updatedAt: now() }
  if (body.shot_size !== undefined) patch.shotSize = String(body.shot_size).slice(0, 20)
  if (body.camera !== undefined) patch.camera = String(body.camera).slice(0, 300)
  if (body.vocal_state !== undefined) patch.vocalState = String(body.vocal_state).slice(0, 20)
  if (body.lyric !== undefined) patch.lyric = String(body.lyric).slice(0, 300)
  // 把历史视频里选中的那一版设为当前（照短剧 setAsMainVideo）
  if (body.video_url !== undefined || body.videoUrl !== undefined) {
    patch.videoUrl = String(body.video_url ?? body.videoUrl) || null
  }
  if (body.prompt !== undefined) patch.prompt = String(body.prompt)
  await db.update(schema.mvShots).set(patch).where(eq(schema.mvShots.id, sid))
  return success(c, { id: sid })
})

/** 编译六段式提示词（4080 侧编译 + 硬校验，一条不过整批不发） */
app.post('/projects/:id/prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const allShots = await shotsOf(id)
  if (!allShots.length) return badRequest(c, '还没有分镜表，先切分详细分镜')
  // 批量「补齐」：默认只补没有英文稿的段，已生成的不重写（要重写请点该段的「重新生成」）
  const body = await c.req.json().catch(() => ({} as any))
  const missingOnly = body?.missing_only !== false
  // 只补勾选的段（前端多选时传 shot_ids；不传=全部缺的段）
  const pickedIds: number[] = Array.isArray(body?.shot_ids) ? body.shot_ids.map(Number).filter(Number.isFinite) : []
  let shots = missingOnly ? allShots.filter((x: any) => !String(x.promptEn || '').trim()) : allShots
  if (pickedIds.length) shots = shots.filter((x: any) => pickedIds.includes(x.id))
  if (!shots.length) {
    return success(c, { ok: true, done: 0, skipped: allShots.length, message: '每一段都已有提示词，没有需要补齐的' })
  }
  const { character, scene } = await primaryAssets(id)
  if (!character) return badRequest(c, '还没有人物资产（先提取人物并出图）')
  // 2026-10-19：先走 App 内 video-prompt 技能（与短剧同一套规则：@ 出场 header + @ 引用）。
  // 任一条失败 → 整批回退下面的中转编译，保证同一批口径一致。
  try {
    const got: { zh: string; en: string }[] = []
    for (const s0 of shots) {
      const pickedS = (await shotRefs(id, s0)).filter((a0: any) => a0.image)
      const scS = pickedS.find((a0: any) => a0.kind === 'scene') || scene
      const r = await mvShotPromptSkill(project, s0, pickedS, character, scS)
      if (!r) throw new Error(`第 ${(s0 as any).shotNumber} 段技能生成失败`)
      got.push(r)
    }
    for (let i = 0; i < shots.length; i++) {
      await db.update(schema.mvShots).set({ prompt: got[i].zh, promptEn: got[i].en, updatedAt: now() })
        .where(eq(schema.mvShots.id, (shots[i] as any).id))
    }
    return success(c, { ok: true, done: shots.length, skipped: allShots.length - shots.length, engine: 'skill' })
  } catch (err: any) {
    // 2026-10-19 用户拍板：失败就如实报失败，不再回退中转编译
    logTaskError('MV', 'batch-prompt-failed', { id, error: err?.message })
    return serverError(c, err?.message || '提示词生成失败')
  }
})

/** 单段提示词生成/重新生成（照短剧每段的「AI 生成 / 重新生成」） */
app.post('/projects/:id/shots/:sid/prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  const { character, scene } = await primaryAssets(id)
  if (!character) return badRequest(c, '还没有人物资产（先提取人物并出图）')
  const picked = (await shotRefs(id, shot)).filter((a) => a.image)
  const sc = picked.find((a) => a.kind === 'scene') || scene
  // 2026-10-19：先走 App 内 video-prompt 技能（同名规则链）；失败回退中转编译
  // 2026-10-19 用户拍板：生成失败就如实报失败，**不偷偷回退旧编译**
  const skill = await mvShotPromptSkill(project, shot, picked, character, sc)
  if (!skill) return serverError(c, '提示词生成失败（技能未返回有效内容）')
  await db.update(schema.mvShots).set({ prompt: skill.zh, promptEn: skill.en, updatedAt: now() })
    .where(eq(schema.mvShots.id, sid))
  return success(c, { id: sid, prompt: skill.zh, promptEn: skill.en, engine: 'skill' })
})

/** 单段体检 */
app.post('/projects/:id/shots/:sid/check', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  try {
    if (!String(shot.promptEn || '').trim()) {
      return success(c, { shotNumber: shot.shotNumber, ok: false, problems: ['这一段的英文提示词还没生成 —— 点该段的「AI 生成」'] })
    }
    const out = await shimPost<{ rows: any[] }>('/v2/mv/check', {
      shots: [{ prompt: shot.promptEn || '', vocal_state: shot.vocalState || 'vocal_active' }],
    })
    const row = out?.rows?.[0] || { ok: false, problems: ['体检无返回'] }
    return success(c, { shotNumber: shot.shotNumber, ok: !!row.ok, problems: row.problems || [] })
  } catch (err: any) {
    logTaskError('MV', 'shot-check', { id, sid, error: err?.message })
    return serverError(c, err?.message || '体检失败')
  }
})

/** 人声分离（demucs）：产出 vocals.wav，给唱/非唱判据用；幂等，已分离直接返回 */
app.post('/projects/:id/separate', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const remote = String(project.songRemoteName || '')
  if (!remote) return badRequest(c, '这首歌还没上传到生成服务（先做详细分镜，会自动上传）')
  try {
    const out = await shimPost<{ vocals: string; no_vocals?: string; seconds?: number; cached?: boolean }>(
      '/v2/mv/separate', { audio_file: remote, tag: `p${id}`, force: !!project.vocalStem && false },
    )
    const stem = String(out?.vocals || '')
    // 新分离出来的音轨 = 旧的切分判据失效 → 清掉旧分镜（分镜/提示词/生成记录），让用户重切
    let cleared = 0
    if (!out?.cached) {
      const rows = await shotsOf(id)
      cleared = rows.length
      if (cleared) await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, id))
      await db.update(schema.mvProjects).set({ status: 'outline', updatedAt: now() }).where(eq(schema.mvProjects.id, id))
    }
    await db.update(schema.mvProjects).set({ vocalStem: stem, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'separate', { id, seconds: out?.seconds, cached: out?.cached, cleared })
    return success(c, { vocalStem: stem, noVocals: out?.no_vocals || null, seconds: out?.seconds || 0, cached: !!out?.cached, cleared })
  } catch (err: any) {
    logTaskError('MV', 'separate', { id, error: err?.message })
    return serverError(c, err?.message || '人声分离失败')
  }
})

/** 体检：把每段提示词发给中转跑硬校验，回问题清单（不生成、不改数据） */
app.post('/projects/:id/check', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const shots = await shotsOf(id)
  if (!shots.length) return badRequest(c, '还没有分镜')
  try {
    // 体检检查的是【英文稿 promptEn】——那是真正发给 H3 的；中文稿是给人看的导演分镜稿，不含官方六段
    const out = await shimPost<{ rows: any[]; ok: number; bad: number }>('/v2/mv/check', {
      shots: shots.map((s) => ({ prompt: s.promptEn || '', vocal_state: s.vocalState || 'vocal_active' })),
    })
    const rows = (out?.rows || []).map((r: any, i: number) => {
      const noEn = !String(shots[i]?.promptEn || '').trim()
      return {
        shotNumber: shots[i]?.shotNumber ?? i + 1,
        ok: noEn ? false : !!r.ok,
        problems: noEn ? ['这一段的英文提示词还没生成 —— 点「编译全部提示词」或该段的「AI 生成」'] : (r.problems || []),
      }
    })
    logTaskSuccess('MV', 'check', { id, ok: out?.ok, bad: out?.bad })
    return success(c, { ok: out?.ok || 0, bad: out?.bad || 0, rows })
  } catch (err: any) {
    logTaskError('MV', 'check', { id, error: err?.message })
    return serverError(c, err?.message || '体检失败')
  }
})

/** 删掉成片（分段视频都留着，只清成片文件 + 字段） */
app.delete('/projects/:id/output', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  if (!project.outputUrl) return badRequest(c, '还没有成片')
  const rel = String(project.outputUrl)
  await db.update(schema.mvProjects).set({ outputUrl: null, status: 'ready', updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  try { fs.rmSync(getAbsolutePath(rel), { force: true }) } catch { /* 文件不在就算了 */ }
  logTaskSuccess('MV', 'delete-output', { id, rel })
  return success(c, { ok: true })
})

/** 本项目所有成片（一次拼接一条，多家并存） */
app.get('/projects/:id/merges', async (c) => {
  const id = Number(c.req.param('id'))
  const rows = await db.select().from(schema.mvMerges)
    .where(and(eq(schema.mvMerges.projectId, id), isNull(schema.mvMerges.deletedAt)))
    .orderBy(desc(schema.mvMerges.id)).limit(200)
  return success(c, { merges: rows })
})

/** 删一条成片：删记录 + 文件；删的若是当前那条，项目成片指回剩下最新 */
app.delete('/projects/:id/merges/:mid', async (c) => {
  const id = Number(c.req.param('id'))
  const mid = Number(c.req.param('mid'))
  const [m] = await db.select().from(schema.mvMerges)
    .where(and(eq(schema.mvMerges.id, mid), eq(schema.mvMerges.projectId, id)))
  if (!m) return notFound(c, '成片不存在')
  await db.delete(schema.mvMerges).where(eq(schema.mvMerges.id, mid))
  try { fs.rmSync(getAbsolutePath(String(m.mergedUrl)), { force: true }) } catch { /* 文件不在就算了 */ }
  const [p0] = await db.select().from(schema.mvProjects).where(eq(schema.mvProjects.id, id))
  if (p0 && String(p0.outputUrl || '') === String(m.mergedUrl || '')) {
    const [next] = await db.select().from(schema.mvMerges)
      .where(and(eq(schema.mvMerges.projectId, id), isNull(schema.mvMerges.deletedAt)))
      .orderBy(desc(schema.mvMerges.id)).limit(1)
    await db.update(schema.mvProjects).set({ outputUrl: next?.mergedUrl || null, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  }
  logTaskSuccess('MV', 'delete-merge', { id, mid })
  return success(c, { ok: true })
})

/** 删掉某一段的某一版视频：删任务记录 + 文件；删的若是当前版本，自动把当前指回剩下最新的一条（照短剧） */
app.delete('/projects/:id/shots/:sid/video', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const url = String(c.req.query('url') || '')
  if (!url) return badRequest(c, '缺 url')
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  let tids: number[] = []
  try { tids = (JSON.parse(String(shot.taskIds || '[]')) as any[]).map(Number).filter(Number.isFinite) } catch { tids = [] }
  const rows = tids.length
    ? await db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, tids))
    : []
  const hit = rows.find((t: any) => (t.localPath || t.resultUrl) === url)
  if (hit) {
    await db.delete(schema.sysTask).where(eq(schema.sysTask.id, hit.id))
    const keep = tids.filter((x) => Number(x) !== Number(hit.id))
    await db.update(schema.mvShots).set({ taskIds: JSON.stringify(keep), updatedAt: now() }).where(eq(schema.mvShots.id, sid))
  }
  try { fs.rmSync(getAbsolutePath(url), { force: true }) } catch { /* 文件不在就算了 */ }
  // 当前版本被删 → 指回剩下最新的一条
  if (String(shot.videoUrl || '') === url) {
    const rest = rows.filter((t: any) => (t.localPath || t.resultUrl) !== url)
    await db.update(schema.mvShots).set({ videoUrl: rest[0]?.localPath || null, updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
  }
  logTaskSuccess('MV', 'delete-video', { id, sid })
  return success(c, { ok: true })
})

// ---------------------------------------------------------------- 出片

/** 提交单段：走 App 视频通道 → 中转按 model=minimax-h3-mv 走 MV 模板 */
app.post('/projects/:id/shots/:sid/render', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  if (!shot.prompt && !shot.promptEn) return badRequest(c, '这一段还没提示词，先编译提示词')
  const body = await c.req.json().catch(() => ({} as any))
  // 这一段自己绑定的参考图（人物/场景/其它都可能），没绑就用人物卡+场景卡
  const picked = (await shotRefs(id, shot)).filter((a) => a.image)
  if (!picked.length) return badRequest(c, '这一段还没有可用的参考图（先给人物/场景出图，或在这一段勾选绑定）')
  const refs: string[] = picked.map((a) => readAsDataUrl(a.image, 'image/png'))
  const cards = picked.map((a) => a.card).filter(Boolean) as string[]
  try {
    const taskId = await generateVideo({
      prompt: String(shot.promptEn || shot.prompt || ''),
      model: MV_MODEL,
      configId: project.videoConfigId ?? undefined,
      duration: Math.max(5.167, Number(shot.seconds) || 5.167),
      aspectRatio: project.aspectRatio || '16:9',
      resolution: `${videoSize(project)[0]}x${videoSize(project)[1]}`,
      referenceImageUrls: refs,
      seed: body.seed ? Number(body.seed) : undefined,
      // MV 专用字段（适配器原样并进请求体；短剧路径不传这些）
      mvExtras: {
        mv_audio: { name: await ensureRemoteSong(project) },
        mv_start_seconds: Number(shot.startSeconds) || 0,
        mv_frames: Number(shot.frames) || snapFrames(Number(shot.seconds) || 5.167),
        mv_width: videoSize(project)[0], mv_height: videoSize(project)[1],
        refmod_files: cards,
      },
    })
    // 历史视频只认本段自己的任务 id（存 task_ids），不再用 storyboard_id —— 短剧分镜 id 与 MV 段 id 会撞号（实测 145/146/147）
    let prevTasks: string[] = []
    try { prevTasks = JSON.parse(String(shot.taskIds || '[]')) } catch { prevTasks = [] }
    const mergedTasks = [String(taskId), ...prevTasks.filter((x) => String(x) !== String(taskId))].slice(0, 50)
    await db.update(schema.mvShots).set({ taskId: String(taskId), taskIds: JSON.stringify(mergedTasks), status: 'processing', errorMsg: null, updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
    await db.update(schema.mvProjects).set({ status: 'rendering', updatedAt: now() }).where(eq(schema.mvProjects.id, id))
    logTaskStart('MV', 'render', { id, sid, task: taskId, frames: shot.frames })
    return success(c, { task_id: taskId })
  } catch (err: any) {
    await db.update(schema.mvShots).set({ status: 'failed', errorMsg: String(err?.message || err).slice(0, 500), updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
    logTaskError('MV', 'render', { id, sid, error: err?.message })
    return serverError(c, `提交失败：${err?.message}`)
  }
})

/** 成片：无音轨拼接 + 混原曲整段（听到的就是原歌，不是各段自己的音轨） */
app.post('/projects/:id/assemble', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const shots = await shotsOf(id)
  const body = await c.req.json().catch(() => ({} as any))
  const ids: number[] = Array.isArray(body?.shot_ids) ? body.shot_ids.map(Number).filter(Number.isFinite) : []
  const ready = shots.filter((s) => s.videoUrl)
  const done = ids.length ? ready.filter((s) => ids.includes(s.id)) : ready
  if (!done.length) return badRequest(c, ids.length ? '勾选的镜头里没有已生成的分段' : '还没有生成好的分段')
  if (!project.songFile) return badRequest(c, '找不到原曲文件')
  const rel = mvDir(id)
  const listPath = path.join(STORAGE_ROOT, rel, 'concat.txt')
  fs.writeFileSync(listPath, done.map((s) => `file '${getAbsolutePath(s.videoUrl as string)}'`).join('\n'))
  const videoOnly = path.join(STORAGE_ROOT, rel, 'video_only.mp4')
  const outName = `mv_final_${Date.now()}.mp4`
  const outAbs = path.join(STORAGE_ROOT, rel, outName)
  const start = Number(done[0].startSeconds) || 0
  const total = done.reduce((a, s) => a + (Number(s.seconds) || 0), 0)
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(listPath).inputOptions(['-f concat', '-safe 0']).outputOptions(['-c copy', '-an'])
        .on('end', () => resolve()).on('error', (e: Error) => reject(new Error(`拼接失败：${e.message}`))).save(videoOnly)
    })
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoOnly).input(getAbsolutePath(project.songFile as string)).inputOptions([`-ss ${start}`])
        .outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-c:a aac', '-b:a 192k', '-t', String(total + 0.5), '-shortest', '-movflags +faststart'])
        .on('end', () => resolve()).on('error', (e: Error) => reject(new Error(`混音失败：${e.message}`))).save(outAbs)
    })
  } catch (err: any) {
    logTaskError('MV', 'assemble', { id, error: err?.message })
    return serverError(c, err?.message)
  }
  const outRel = `${rel}/${outName}`
  // 每拼一次就留一条记录，多家并存（照短剧 video_merges）
  await db.insert(schema.mvMerges).values({
    projectId: id, shotIds: JSON.stringify(done.map((s) => s.id)), mergedUrl: outRel,
    seconds: total, status: 'completed', createdAt: now(),
  })
  await db.update(schema.mvProjects).set({ outputUrl: outRel, status: 'done', updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  logTaskSuccess('MV', 'assemble', { id, seconds: total })
  return success(c, { output_url: outRel, seconds: total })
})

export default app
