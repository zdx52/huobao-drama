/**
 * 音乐 MV 路由（2026-10-18 新增，独立模块）
 *
 * 与短剧链路彻底隔离：不写 storyboards / characters / scenes，只用自己的三张表
 * （mv_projects / mv_assets / mv_shots）+ 服务器 shim 的 /v2/mv/* 接口。
 * 生成全部走 App 现成的三条通道（不写死地址和模型）：
 *   文本 = getTextConfig()｜图片 = generateImage()｜视频 = generateVideo(model=minimax-h3-mv)
 *
 * 流程（与短剧同构）：
 *   建项目（歌 + 风格 + 分镜提示词）→ 从分镜提示词提取人物/场景（mv_assets）
 *   → 逐个出图 → 逐个抽卡 → 粗分镜（与歌等长）→ 详细分镜（景别/机位/歌词）
 *   → 编译六段式提示词 → 逐段出片 → 无音轨拼接 + 原曲整段混入
 *
 * 服务器侧只用 shim 的 MV 专属接口（地址取自「视频通道」配置）：
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
import { generateMvShotPrompt } from '../services/mv-shot-prompt.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { loadAgentPromptFile } from '../agents/prompts.js'
import { readSkillFile } from '../agents/skills.js'
import { extractChatText } from '../services/asset-describe-prompt.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { success, created, badRequest, notFound, serverError, now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger'
import { buildAss, parseLrc } from '../services/mv-subtitles'
import { upscaleVideo } from '../services/video-upscale.js'
import os from 'os'

/** ffmpeg filtergraph 里的路径转义：反斜杠换正斜杠，转义冒号和单引号，空格用 \ 转（避免参数被截断） */
function assFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/ /g, '\\ ')
}
import { ffmpeg } from '../utils/ffmpeg.js'
// 2026-10-19：MV 提示词完全走自己的链路（askText + 只读技能文本），**不引短剧的任何服务/Agent**

// 服务器模板 mv_shot.api.json 节点14 的音频窗口 warmup_seconds（那边改了这里要同步）
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
const KINDS = ['character', 'scene', 'prop'] as const   // 2026-10-20 加道具（照短剧：关键道具要单独出图、单独生卡）
type Kind = typeof KINDS[number]

// ---------------------------------------------------------------- 基础工具

/** 服务器地址：优先 MV_SHIM_BASE，其次「视频通道」的 baseUrl（不写死）
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

/**
 * 这一段时间窗对应的初步分镜（去重）
 *
 * 2026-10-21：用户在初步分镜里「改一段」时常常是**复制出新段**、旧段没删，
 * 再加上下一段起点可能正好落在本段结束前（如 104.46 < 104.625）——
 * 直接 filter+join 会把三条重复描写全塞进中文稿（分镜 16 就是这样：
 * 靠在电梯厢壁上 / 手机屏幕… / 电梯门开… 叠在一起）。
 * 规则：按「起点离本段起点最近」优先，与已选段重叠超过 50% 的丢掉。
 */
export function outlineForWindow(outline: any[], start: number, end: number): any[] {
  // 交集不足 0.5 秒的段不要：那只是段边界没对齐的尾巴（分镜 16 就是被下一段的 0.16 秒带进了「电梯门开」）
  const ov = (outline || []).filter((o: any) => {
    const inter = Math.min(Number(o?.end), end) - Math.max(Number(o?.start), start)
    return inter >= 0.5
  })
  const overlapRatio = (a: any, b: any) => {
    const from = Math.max(Number(a.start), Number(b.start))
    const to = Math.min(Number(a.end), Number(b.end))
    const inter = Math.max(0, to - from)
    const shorter = Math.min(Number(a.end) - Number(a.start), Number(b.end) - Number(b.start)) || 1
    return inter / shorter
  }
  const chosen: any[] = []
  for (const o of ov.slice().sort((a: any, b: any) => Math.abs(Number(a.start) - start) - Math.abs(Number(b.start) - start))) {
    if (chosen.every((c) => overlapRatio(o, c) < 0.5)) chosen.push(o)
  }
  return chosen.sort((a: any, b: any) => Number(a.start) - Number(b.start))
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
 * 2026-10-19：用 **MV 自己的** `skills/mv/video-prompt` 给 MV 段出提示词（中文工作版 + 英文发送版）。
 * 与短剧彻底隔离：不读 `prompt-generator/*`、不改短剧任何文件（用户 2026-10-19 明确要求）。
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
/**
 * MV 段提示词 = **照短剧那一套**（2026-10-19 用户要求「先看短剧怎么写的」，逐项对齐）：
 * ① 技能文本全给（原来截到 12000 字，正好把英文六段规范裁掉）
 * ② 注入项目画风规范（风格头 = 画风介质词必须写进正文；正文渲染语言中/英各一份）
 * ③ 主体清单 + 逐主体字数预算（短剧 rosterBlock 的做法）
 * ④ 给「目标长度」而不是只给上限 + 六段配额
 * ⑤ detailed_description 按拍写 [Shot N]（第 1 拍无时间戳，其后 `At MM:SS.mmm`）
 * ⑥ 超 6200 字压一轮（短剧 buildRewritePrompt 的「怎么压」清单）
 * ⑦ 中文工作版由英文六段稿 + 拍点写成逐拍详细稿
 */
/** 最近一次 MV 段提示词失败的真实原因（流水线里各道闸的消息，报给用户看） */
let lastShotPromptError = ''

/** 段提示词的真实步骤进度：{shotId: {step,total,label,at,done}}。前端轮询显示「第 X/Y 步 · 在做什么」 */
const shotPromptProgress = new Map<number, { step: number; total: number; label: string; at: number; done: boolean }>()

async function mvShotPromptSkill(
  project: any, shot: any, picked: any[], character: any, sc: any,
): Promise<{ zh: string; en: string } | null> {
  try {
    // MV 自己的那份（独立副本，短剧改动影响不到 MV）
    const full = String(readSkillFile('mv/video-prompt') || '')
    const enIdx = full.indexOf('## 英文发送版')
    const spec = await getStyleSpecByValue(project?.style)
      .catch(() => ({ head: '', bodyRules: '', bodyRulesEn: '' }) as any)
    let beats: any[] = []
    try { beats = JSON.parse(String(shot.beats || '[]')) } catch { beats = [] }
    const secs = Number(shot.seconds) || 6
    const start = Number(shot.startSeconds) || 0
    const end = Number(shot.endSeconds) || (start + secs)
    let outline: any[] = []
    try { outline = JSON.parse(String(project?.outline || '[]')) } catch { outline = [] }
    const out = await generateMvShotPrompt({
      // 技能按「## 英文发送版」切两份：中文任务吃中文规则、英文任务吃六段规范（原来整段截断 12000 字，正好把这节裁掉）
      skillZh: enIdx > 0 ? full.slice(0, enIdx) : full,
      skillEn: enIdx > 0 ? full.slice(enIdx) : full,
      styleHead: String(spec?.head || ''),
      styleRulesZh: String(spec?.bodyRules || ''),
      styleRulesEn: String(spec?.bodyRulesEn || ''),
      // 出场 = **这一段自己绑定的参考素材**（不是项目主人物）：绑了谁就写谁，没绑才回退主素材
      roster: (() => {
        const chars = (picked || []).filter((a: any) => a.kind === 'character' && a.name)
        const cast = (chars.length ? chars : (character?.name ? [character] : []))
          .map((a: any) => '@' + String(a.name)).join('、') || '@主角'
        const scene2 = (picked || []).find((a: any) => a.kind === 'scene' && a.name) || sc
        const props2 = (picked || []).filter((a: any) => a.kind === 'prop' && a.name)
          .map((a: any) => '@' + String(a.name)).join('、')
        return `出场人物：${cast}；场景：@${scene2?.name || '主场景'}${props2 ? `；道具：${props2}` : ''}`
      })(),
      pictures: (picked || []).map((a: any, i: number) => ({
        n: i + 1, name: a.name, kind: a.kind,
        // 资产外观/妆造原文：短剧的 read_characters 会给模型这些，MV 只给名字的话模型就自己编衣服颜色
        assetText: [a.appearance, a.styling, a.description]
          .map((x: any) => String(x || '').trim()).filter(Boolean).join(' / ').slice(0, 900),
      })),
      outlineText: outlineForWindow(outline, start, end)
        .map((o: any) => `[${o.start}-${o.end}s] ${o.what}`).join('\n'),
      beats: beats.map((b: any) => ({
        start: Number(b.start) || 0, end: Number(b.end) || 0,
        // 2026-10-21：段级景别（shot.shotSize）优先 —— 用户改了「景别」却被 beats 里的旧值盖回去，
        //            中文稿永远不变（英文又自己译成 close-up），中英就分叉了
        size: String(shot.shotSize || b.size || ''), camera: String(b.camera || ''),
        action: String(b.action || ''), action_zh: String(b.action_zh || ''),
      })),
      seconds: secs, start, frames: Number(shot.frames) || 0,
      vocalActive: !['non_vocal', 'silent'].includes(String(shot.vocalState || '')),
      lyric: shot.lyric ? String(shot.lyric) : '',
      extra: shot.promptExtra ? String(shot.promptExtra) : '',
      shotNumber: Number(shot.shotNumber) || 0,
      aspectRatio: String(project?.aspectRatio || '16:9'),
      onProgress: (step, total, label) => {
        shotPromptProgress.set(Number(shot.id), { step, total, label, at: Date.now(), done: false })
      },
    }, (system, user) => askText(system, user, 4000, project.textConfigId))
    shotPromptProgress.set(Number(shot.id), { step: 8, total: 8, label: '完成', at: Date.now(), done: true })
    return out
  } catch (err: any) {
    lastShotPromptError = String(err?.message || err)
    shotPromptProgress.set(Number(shot.id), { step: 0, total: 8, label: `失败：${lastShotPromptError.slice(0, 80)}`, at: Date.now(), done: true })
    logTaskError('MV', 'shot-prompt', { sid: shot.id, error: lastShotPromptError })
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
const STATIC_ACT_RE = /\b(stand|stands|standing|still|breathe|breathes|breathing|wait|waits|rests?|lean|lazy)\b/i
const actClass = (a: string) => (STATIC_ACT_RE.test(String(a || '')) ? 'static' : 'dynamic')

function fitBeats(raw: any, seconds: number, size: string, camera: string, shotNumber = 1, vocal = true, prevActClass = ''): any[] {
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
    'she breathes quietly, shoulders relaxing, gaze drifting off the lens',       // 静
    'she turns toward the microphone and rests one hand on its stand',            // 动
    'she stands still and lets the room breathe, only her hair moving slightly',   // 静
    'she lifts one hand and tucks her hair behind her ear',                       // 动
  ]
  const ACT_NV_ZH_CYCLE = [
    '她安静呼吸，肩膀放松，视线自然移开',
    '她转向麦克风，一只手扶上支架',
    '她一语不发地站着，只有发丝轻轻动',
    '她抬起一只手把发丝别到耳后',
  ]
  const idx0 = Math.max(1, shotNumber) - 1
  const ENC = vocal ? ACT_CYCLE : ACT_NV_CYCLE
  const ZHC = vocal ? ACT_ZH_CYCLE : ACT_NV_ZH_CYCLE
  let pick = idx0 % ENC.length
  // 相邻段动作类型必须换：上段静、这段也静 → 顺延到下一个「动」的动作（拼起来不会像同一个镜头）
  if (prevActClass && actClass(ENC[pick]) === prevActClass && ENC.length > 1) {
    for (let k = 1; k <= ENC.length; k++) {
      const cand = (pick + k) % ENC.length
      if (actClass(ENC[cand]) !== prevActClass) { pick = cand; break }
    }
  }
  const actFallback = ENC[pick]
  const actZhFallback = ZHC[pick % ZHC.length]
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

/** 道具名的可匹配写法：全名 + 去掉类目后缀 + 前两个字（歌词里常只写简称，如「宵夜」） */
function propNameKeys(name: any): string[] {
  const n = String(name || '').replace(/\s+/g, '')
  const keys = new Set<string>()
  if (n.length >= 2) keys.add(n)
  const stripped = n.replace(/(保温袋|包装袋|手提袋|纸袋|塑料袋|礼物盒|盒子|杯子|瓶子|袋子|袋|盒|杯)$/, '')
  if (stripped.length >= 2) keys.add(stripped)
  if (n.length > 2) keys.add(n.slice(0, 2))
  return [...keys].filter((k) => k.length >= 2)
}

async function assetsOf(projectId: number, kind?: Kind) {
  // 2026-10-20：资产**只认这首歌自己**（projectId）。早前按 mv_assets.series_id 合并同系列，
  // 导致新歌一导入就显示上一首歌的人物/场景；现在必须「提取人物和场景」后才有。
  // 想复用旧角色 → 提取到同名角色时前端会问「用素材库现有的吗」，或从公共素材库 import。
  const mine = eq(schema.mvAssets.projectId, projectId)
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
  mv_prop_map: '判断每个分镜段落里出现了哪些道具，只输出 JSON。',
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
    if (row.status === 'canceled') throw new Error('已停止')
    if (row.status === 'failed') throw new Error(row.errorMsg || `任务 ${taskId} 失败`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`任务 ${taskId} 超时未完成`)
}

/** 本地读时长（ffprobe），建项目时就能给粗分镜用，不必先送 服务器 */
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
 * 原曲送 服务器 —— **只在第一次真正需要时做**（切分镜 / 提交片段），建项目时只落本地。
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
  // GPU 是串行排队：一条任务的「真实开始时间」= max(它自己的 createdAt, 上一条完成的时间)。
  // 不做这个换算，运行中的那行会从「提交时间」开始算，看起来像全片总耗时（实测分镜21 排了 38 分钟）。
  const ordered = [...tasks].sort((a: any, b: any) => Number(a.id) - Number(b.id))
  const effStart = new Map<number, string>()
  let lastDone = ''
  for (const t of ordered as any[]) {
    const c0 = String(t.createdAt || '')
    const start = lastDone && Date.parse(lastDone) > Date.parse(c0) ? lastDone : c0
    effStart.set(Number(t.id), start)
    const c1 = String(t.completedAt || '')
    if (c1 && (!lastDone || Date.parse(c1) > Date.parse(lastDone))) lastDone = c1
  }
  return success(c, {
    project, assets: await assetsOf(id), libraryAssets: await libraryAssetsOf(), shots, merges,
    videoTasks: tasks.map((t: any) => ({
      id: t.id, shotId: ownerShotId(t.id), url: t.localPath || t.resultUrl || '',
      status: t.status, createdAt: t.createdAt, startedAt: effStart.get(Number(t.id)) || t.createdAt,
      error: t.errorMsg || null,
    })),
  })
})

app.delete('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.mvProjects).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  return success(c, null)
})

/** 建项目：只做本地的事（落库 + 存歌 + 读时长），不碰 服务器 */
app.post('/projects', async (c) => {
  let body: any
  try { body = await c.req.json() } catch (err: any) { return badRequest(c, `请求体不是 JSON: ${err?.message}`) }
  const kind = String(body?.kind || 'song') === 'dance' ? 'dance' : 'song'
  if (kind === 'song' && !body?.song?.data) return badRequest(c, '缺 song.data（歌的 base64/data URL）')
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
      kind,
      aspectRatio: String(body.aspect_ratio || '16:9').slice(0, 10),   // 2026-10-19 新建默认 16:9（横屏）
      maxShotSeconds: maxShot,
      status: 'draft',
      createdAt: ts, updatedAt: ts,
    })
    const id = getInsertId(res)
    const rel = mvDir(id)
    if (kind === 'dance') {
      logTaskSuccess('MV', 'create-project', { id, kind })
      return created(c, { id, kind, song_seconds: 0 })
    }
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


/** 舞蹈 MV：上传参考视频 → 自动适配备份（全尺寸源片 + 半分辨率参考）→ 推 4080 → 按视频自然切段 */
app.post('/projects/:id/dance', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  let body: any
  try { body = await c.req.json() } catch (err: any) { return badRequest(c, `请求体不是 JSON: ${err?.message}`) }
  if (!body?.video?.data) return badRequest(c, '缺 video.data（参考视频 base64/data URL）')
  const [W, H] = videoSize(project)
  try {
    const rel = mvDir(id)
    const ext = (String(body.video.name || '').toLowerCase().match(/\.(mp4|mov|mkv|webm)$/) || [, 'mp4'])[1]
    const origRel = `${rel}/dance_orig.${ext}`
    fs.writeFileSync(getAbsolutePath(origRel), b64ToBuffer(String(body.video.data)))
    const full = getAbsolutePath(origRel)
    const meta = await probeVideoMeta(full)
    if (!meta.seconds) return badRequest(c, '读不出视频时长（文件可能损坏）')
    const totalFrames = Math.max(24, Math.round(meta.seconds * 24))
    if (totalFrames < 124) return badRequest(c, '参考视频太短：H3 单段最少 124 帧（5.17 秒）')
    const srcRel = `${rel}/dance_src.mov`
    const refRel = `${rel}/dance_ref.mov`
    await toDanceMov(full, getAbsolutePath(srcRel), W, H)
    await toDanceMov(full, getAbsolutePath(refRel), Math.round(W * DANCE_REF_SCALE), Math.round(H * DANCE_REF_SCALE))
    const srcName = `mv_p${id}_dance_src.mov`
    const refName = `mv_p${id}_dance_ref.mov`
    await shimPost('/v2/mv/video', { name: srcName, data: readAsDataUrl(srcRel, 'video/quicktime') })
    await shimPost('/v2/mv/video', { name: refName, data: readAsDataUrl(refRel, 'video/quicktime') })
    await db.update(schema.mvProjects).set({
      kind: 'dance', danceSource: srcName, danceRefSource: refName, danceFrames: totalFrames,
      songSeconds: Math.round((totalFrames / 24) * 1000) / 1000, updatedAt: now(),
    } as any).where(eq(schema.mvProjects.id, id))
    // 自然切段：清旧段 → 按 17n+5 网格 + 每段 ≤345 帧重排
    const segs = planDanceSegments(totalFrames)
    const ts = now()
    await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, id))
    for (const g of segs) {
      await db.insert(schema.mvShots).values({
        projectId: id, shotNumber: g.index,
        startSeconds: g.startFrame / 24, endSeconds: (g.startFrame + g.frames) / 24,
        frames: g.frames, seconds: Math.round((g.frames / 24) * 1000) / 1000,
        shotSize: 'medium-wide', camera: 'static', vocalState: 'non_vocal',
        status: 'pending', createdAt: ts, updatedAt: ts,
      } as any)
    }
    logTaskSuccess('MV', 'dance-upload', { id, frames: totalFrames, shots: segs.length })
    return success(c, {
      frames: totalFrames, seconds: Math.round((totalFrames / 24) * 1000) / 1000,
      source: srcName, ref: refName, shots: segs,
    })
  } catch (err: any) {
    logTaskError('MV', 'dance-upload', { id, error: err?.message })
    return serverError(c, err?.message || '舞蹈视频适配失败')
  }
})

/** 舞蹈 MV：用项目里的人物/场景提示词，给每段编译英文六段稿（动作来源写死 <Video 1>） */
app.post('/projects/:id/dance-prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const shots = await db.select().from(schema.mvShots)
    .where(eq(schema.mvShots.projectId, id)).orderBy(schema.mvShots.shotNumber)
  if (!shots.length) return badRequest(c, '还没有段，先上传参考视频')
  const total = shots.length
  let n = 0
  for (const sh of shots) {
    const en = compileDancePrompt({
      characterPrompt: project.characterPrompt || '', scenePrompt: project.scenePrompt || '',
      style: project.style || '', frames: Number(sh.frames) || 124,
      shotNo: Number(sh.shotNumber) || 1, totalShots: total,
    })
    const zh = compileDancePromptZh({ frames: Number(sh.frames) || 124,
      shotNo: Number(sh.shotNumber) || 1, totalShots: total })
    await db.update(schema.mvShots).set({ promptEn: en, prompt: zh, updatedAt: now() })
      .where(eq(schema.mvShots.id, sh.id))
    n++
  }
  logTaskSuccess('MV', 'dance-prompts', { id, shots: n })
  return success(c, { count: n })
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
  // 2026-10-20 用户报「资产提取的场景跟初步分镜对不上」：以前只喂全局的分镜提示词，
  // 而初步分镜（outline）每段已经写了具体地点/光线/氛围 —— 提取必须以它为准。
  let outlineTxt = ''
  try {
    const rows = JSON.parse(String(project.outline || '[]'))
    if (Array.isArray(rows) && rows.length) {
      outlineTxt = rows.map((x: any) => `[${Number(x.start).toFixed(2)}-${Number(x.end).toFixed(2)}s] ${String(x.what || '')}`).join('\n')
    }
  } catch { outlineTxt = '' }
  const outlineBlock = outlineTxt
    ? `\n这支 MV 的**初步分镜**（已定稿，每段就是实际要拍的画面，场景必须照它来）：\n"""\n${outlineTxt.slice(0, 8000)}\n"""\n`
    : ''
  const ask = `下面是这支 MV 的分镜提示词（用户写的）：

"""
${story.slice(0, 12000)}
"""
${outlineBlock}
请从中提取**人物**和**场景**，**严格按上面那份规范**填字段（规范里要求的四项颜色、禁模糊词、字数都要照做）：
1) **人物**只提取这份分镜提示词/初步分镜里真实出现过的，不要自己发明人物、不要补充没写的人。
1a) 🔴 **MV 是单人演唱，人物宁少不多**：最多 4 个，按重要性排序，**第一个必须是把这首歌唱出来的主角**（后面按 sortOrder 第一个即主唱）。只传一个就只提一个；写「路人/观众/乐队」这类群体时不单独建人物。配角只写它在这支 MV 里的身份（朋友/观众/乐队），并在 description 末尾注明「画面里不唱歌、不对嘴、嘴一直闭着」。
1b) 🔴 **场景以上面的初步分镜为准**：把初步分镜里出现的地点归并成 1~3 个场景，**名字和 description 直接用分镜里写的那个地点/光线/氛围**（分镜写「海边黄昏」就不要写成「海边·日」），不许换地方、不许只按全局提示词编。
1c) 场景**至少 1 个**：初步分镜和分镜提示词都没点名地点时（例如只写「按歌词适配合适的场景」），才根据歌词和画面自己定 1~3 个最合适的场景（用户要求的适配，不算发明），名字写成「地点+时间」。
1d) **道具（props）**：只提**关键道具**——必须同时满足「删掉它剧情/画面就不成立」和「值得单独出图（会被特写或反复出现，需要固定外观）」。判定三问，任一答否就放弃：① 删掉它画面是否依然成立？成立 → 不提；② 只是随手用的日常物品（手机、杯子、筷子、烟）吗？是 → 不提；③ 是场景陈设（桌椅、灯具、门窗、装饰）吗？是 → 不提。
   例外：某个日常物品**本身承载关键信息**（纸条上的字、证件、通知书、屏幕上的通知）且分镜会给它特写时**要提**，此时判定的对象是「信息载体」而不是「手机」这个物品——name 写清载体（如「录取通知书」），description 里把要显示的文字逐字写出来（加英文双引号，单行中文 ≤6 字）。
   **宁可少提**：0~3 个，按重要性只留前 3 个；没有就返回空数组，不许凑数。
   🔴 道具 description 只写**物品本身的物理外观**（材质、颜色、形状、大小、新旧磨损），**不写剧情用途、不写和人物的关系、不写它怎么被使用**；**不许写姿态/朝向**（躺平、立着、正面朝上），姿态交给视频。
   🔴 场景 description 里**不要写这些道具**（它们有自己的资产和参考图，写进场景图会把道具画进空镜里）。
2) 人物 appearance（样貌）按规范写成 **300~500 字**：性别、年龄感、五官、发型发色、**肤色的色阶与明暗**、体态、气质（性格要转成外在神态写，不要直接写性格词）。
3) 人物 styling（妆造）：发型、服装、妆面、配饰 —— **每件单品都要写颜色**（外套/上衣/裤子/鞋），配饰写颜色或材质。
4) 人物 description = 样貌 + 妆造的完整合并描述（同样写长写具体，不要只有一句）。
5) 🔴 四项颜色（发色 / 肤色 / 服装颜色 / 配饰颜色或材质）一个都不能少；**禁止「或」「或者」「可能」「皆可」这类二选一**，原文带「或」就当场挑定一个写死。
6) 场景 description：地点、时间、光线、色调、氛围、前景/中景/后景层次（写具体，不要一句话带过）。
7) name 用简短中文名（人物用名字或代称，场景用「地点+时间」）；同一个人的不同叫法合并成一个人。
7b) 🔴 **道具名必须用歌词/初步分镜里出现过的那个词**（歌词写「宵夜」就命名「宵夜」，别写成「外卖保温袋」这种类别名）——下游是按名字把道具绑到分镜上的，名字对不上就绑不上。确实没有原词的才用最常见的日常叫法。
8) 没有人物就返回空的人物数组，但 **scenes 不许为空**（至少 1 个）。

只输出 JSON：
{"characters":[{"name":"","description":"","appearance":"","styling":""}],"scenes":[{"name":"","description":""}],"props":[{"name":"","description":""}]}
appearance 只写脸/身形容貌，styling 只写服装配饰；拆不出来就留空。`
  try {
    const out = pickJson<{ characters?: any[]; scenes?: any[]; props?: any[] }>(
      await askText(
        await mvPrompt('mv_extractor'),
        ask, 6000, project.textConfigId))
    // 兜底：模型还是没给场景 → 只问一次「这首歌词该配什么场景」（有界 1 次，不循环）
    if (!Array.isArray(out.scenes) || !out.scenes.length) {
      try {
        const lyricBlock = String(project.lyrics || '').slice(0, 3000) || '（无）'
        const fix = pickJson<{ scenes?: any[] }>(await askText(
          await mvPrompt('mv_extractor'),
          `这支 MV 用户没有点名场景，只要求「按歌词适配合适的场景」。下面是分镜提示词和歌词：\n\n"""\n${story.slice(0, 8000)}\n"""\n\n${outlineTxt ? `初步分镜（场景以它为准）：\n"""\n${outlineTxt.slice(0, 6000)}\n"""\n\n` : ''}歌词：\n${lyricBlock}\n\n` +
          `请据此定 1~2 个最合适的场景（名字写成「地点+时间」），每个按规范写 description（地点、时间、光线、色调、氛围、前景/中景/后景层次）。` +
          `只输出 JSON：{"scenes":[{"name":"","description":""}]}`, 3000, project.textConfigId))
        if (Array.isArray(fix?.scenes) && fix.scenes.length) out.scenes = fix.scenes
      } catch (e: any) {
        logTaskError('MV', 'extract-scene-fallback', { id, error: e?.message })
      }
    }
    if (!Array.isArray(out.scenes) || !out.scenes.length) {
      return serverError(c, '场景没提取出来（模型只给了人物）。把分镜提示词里的地点写具体一点，或再点一次「提取人物和场景」。')
    }
    const ts = now()
    await db.delete(schema.mvAssets).where(eq(schema.mvAssets.projectId, id))
    let sort = 0
    for (const kind of KINDS) {
      const list = (kind === 'character' ? out.characters : kind === 'prop' ? (out as any).props : out.scenes) || []
      for (const a of list) {
        const desc = String(a?.description || '').trim()
        const name = String(a?.name || '').trim()
        if (!desc && !name) continue
        await db.insert(schema.mvAssets).values({
          seriesId: Number((project as any)?.seriesId) || null,
          projectId: id,
          kind,
          name: name.slice(0, 60) || (kind === 'character' ? `人物${sort + 1}` : kind === 'prop' ? `道具${sort + 1}` : `场景${sort + 1}`),
          description: desc.slice(0, 4000),
          appearance: String(a?.appearance || '').slice(0, 2000),
          styling: String(a?.styling || '').slice(0, 2000),
          sortOrder: sort++,
          createdAt: ts, updatedAt: ts,
        })
      }
    }
    logTaskSuccess('MV', 'extract', { id, characters: out.characters?.length || 0, scenes: out.scenes?.length || 0 })
    const fresh = await assetsOf(id)
    // 同名提醒：素材库里已经有同名角色/场景时**不擅自决定**，交前端问一句「用库里的还是新提取的」
    const libs = await libraryAssetsOf()
    const key = (s: any) => String(s || '').replace(/\s+/g, '').trim()
    const conflicts = fresh
      .filter((a: any) => !a.image && libs.some((l: any) => key(l.name) === key(a.name) && l.kind === a.kind))
      .map((a: any) => {
        const l = libs.find((x: any) => key(x.name) === key(a.name) && x.kind === a.kind) as any
        return { assetId: a.id, name: a.name, kind: a.kind, libraryId: l.id, libraryName: l.name, hasImage: !!l.image }
      })
    return success(c, { assets: fresh, conflicts })
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
  // 素材库(scope='library')里的条目不许从「资产制作」删掉 —— 这里只是取消本项目的卡片：
  // 把 project_id 摘成 0（0 = 不隶属任何项目，纯库条目），素材库和其他 MV 都不受影响。
  if (String((doomed as any).scope || 'project') === 'library') {
    await db.update(schema.mvAssets).set({ projectId: 0, seriesId: null, updatedAt: now() } as any)
      .where(eq(schema.mvAssets.id, aid))
    return success(c, { assets: await assetsOf(id), keptInLibrary: true })
  }
  await db.delete(schema.mvAssets).where(eq(schema.mvAssets.id, aid))
  return success(c, { assets: await assetsOf(id) })
})

/** 资产提示词规则：直接用短剧的那两份 skill（人物板 / 场景），读不到才回退 MV 自己的指令 */
async function assetRule(kind: string): Promise<string> {
  // 2026-10-19：MV 只读**自己那份**（skills/mv/*），不再借短剧的 prompt-generator（用户要求两边彻底隔离）
  const own = readSkillFile(kind === 'character' ? 'mv/character-prompt' : kind === 'prop' ? 'mv/prop-prompt' : 'mv/scene-prompt')
  return own || (await mvPrompt('mv_asset_image'))
}

/**
 * 给资产生成「生图提示词」（照短剧：描述 → 生成提示词 → 出图）
 *
 * 规则来自 MV 自己的 skill（skills/mv/character-prompt、skills/mv/scene-prompt —— 与短剧彻底隔离），
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
        ? '一帧画面里从左到右四个竖版画格、纯白背景——格1 脸部特写（只画头到肩颈、正对镜头）；格2 正面全身、格3 左侧面全身、格4 背面全身，这三格**必须用规范里的原话「头部被干净地移除」（head cleanly removed）**，并写明「这一格只画衣服本身，衣领以上直接是纯白背景：没有头、没有脸、没有五官、没有头发、没有后脑、没有耳朵，也没有脖子、没有下巴、没有下颌、没有颈部断口、没有裸露皮肤」；'
        : '固定视角，前景/中景/后景分层，画面里不出现任何人'}。\n` +
      `   ⚠️ 三视图**禁止写「无头」「不要头」「颈部裁切」这类词** —— 规范里明写：这样写模型照旧会画头。\n` +
      `   ⚠️ 人物板最后必须照抄这句收尾：「整张参考板只有格1 一处面部，格2格3格4一律头部被干净地移除、只画衣服本身（领口以上是纯白背景，没有脖子、没有下巴、没有皮肤）」——**别改写成「无头」「没有头」**（实测会画回头、或留下一半脖子和下巴）。\n` +
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
  kind === 'character' ? CHAR_BOARD_SIZE
    : kind === 'prop' ? '1024x1024'          // 道具 = 白底单品，方形（字更清楚，2026-10-20 用户拍板）
      : imageSizeForAspect(project?.aspectRatio)

/**
 * 成片画幅：H3 只认 9:16 / 16:9，其它比例按横竖就近映射。
 * ponytail: 想支持更多画幅得先让 H3 支持，别在这里造轮子。
 */
function videoSize(project: any): [number, number] {
  return String(project?.aspectRatio || '16:9') === '16:9' ? [1344, 768] : [768, 1344]
}

// ---------------------------------------------------------------- 舞蹈 MV（V2V 复刻，2026-10-23）
// 机制：源片压 latent 后只去噪 99.95% → 动作来自原片像素；参考视频另给一份半分辨率副本
// 只提供编排/节奏线索（省一半注意力开销）；人物靠 RefMods 卡锁；主生成完中转自动接修脸。
const DANCE_MODEL = 'minimax-h3-mv-dance'
const DANCE_MAX_FRAMES = 345          // 14.375s（H3 单段上限内最大的 17n+5 档）
const DANCE_REF_SCALE = 0.5           // 参考副本 = 生成尺寸的一半

function probeVideoMeta(file: string): Promise<{ seconds: number; frames: number; fps: number }> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err: any, meta: any) => {
      if (err) return resolve({ seconds: 0, frames: 0, fps: 0 })
      const seconds = Number(meta?.format?.duration) || 0
      let frames = 0
      let fps = 24
      for (const s of meta?.streams || []) {
        if (s.codec_type !== 'video') continue
        frames = Number(s.nb_frames) || 0
        const r = String(s.r_frame_rate || '24/1').split('/')
        fps = Number(r[0]) / (Number(r[1]) || 1) || 24
      }
      if (!frames) frames = Math.round(seconds * fps)
      resolve({ seconds, frames, fps })
    })
  })
}

/** 源片 → H3 用的 24fps CFR mov（PCM 32k 单声道），按目标尺寸等比放大后居中裁切 */
function toDanceMov(input: string, output: string, w: number, h: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions([
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
        '-r', '24', '-pix_fmt', 'yuv420p', '-crf', '16',
      ])
      .videoCodec('libx264')
      .audioCodec('pcm_s16le').audioFrequency(32000).audioChannels(1)
      .format('mov')
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(output)
  })
}

/**
 * 按参考视频自然切段：每段吸附 17n+5 网格、≤345 帧、尽量等长。
 * 注意 H3 只认网格帧数，源片总帧数一般不在网格上 → 末尾不足一段的零头**直接丢弃**
 * （最多 123 帧 ≈ 5.1 秒），不做「合并进上一段」——那会把上一段顶出网格（自检抓到的 bug）。
 */
function planDanceSegments(total: number): { index: number; startFrame: number; frames: number; dropped: number }[] {
  const snapUp = (frames: number) => {
    const k = Math.max(7, Math.round((frames - 5) / 17))
    return Math.min(DANCE_MAX_FRAMES, 5 + 17 * k)
  }
  const snapDown = (frames: number) => {
    const k = Math.max(7, Math.floor((frames - 5) / 17))
    return Math.min(DANCE_MAX_FRAMES, 5 + 17 * k)
  }
  const out: { index: number; startFrame: number; frames: number; dropped: number }[] = []
  let start = 0
  while (total - start >= 124) {
    const remain = total - start
    const left = Math.ceil(remain / DANCE_MAX_FRAMES)
    let frames = snapUp(Math.round(Math.min(remain / left, DANCE_MAX_FRAMES)))
    if (frames > remain) frames = snapDown(remain)
    if (frames < 124) break
    out.push({ index: out.length + 1, startFrame: start, frames, dropped: 0 })
    start += frames
  }
  out.forEach((g) => { g.dropped = 0 })
  if (out.length) out[out.length - 1].dropped = Math.max(0, total - start)
  return out
}

/**
 * 舞蹈段提示词（英文六段式）：动作来源写死 <Video 1>，人物/场景措辞直接沿用项目里那套字段，
 * 音频声明 <Audio 1>（分段 = 源片同一时间窗的原音，成片顺序拼接即成完整原声）。
 */
/** 舞蹈段的中文导演分镜稿（界面显示用）：动作/机位全部来自源片，所以只交代「复刻参考视频」。 */
function compileDancePromptZh(p: { frames: number; shotNo: number; totalShots: number }): string {
  const end = ((Number(p.frames) || 124) / 24).toFixed(2)
  return [
    `出场人物：参考图里的同一人物（身份由身份卡锁定）；场景：见场景参考图；机位：完全复刻参考视频`,
    `0.00-${end}秒：机位与运镜完全复刻参考视频（无额外推拉摇移）。她逐帧复刻参考视频的舞步——脚步落点、屈膝幅度、胯部路径、躯干转向、手臂弧线与手腕高度、头部朝向、重心转移都与参考视频同一帧对同一帧；服装与发型与参考图一致；本段声音为参考视频原音。`,
  ].join('\n')
}

function compileDancePrompt(p: { characterPrompt?: string; scenePrompt?: string; style?: string; frames: number; shotNo: number; totalShots: number }): string {
  const who = String(p.characterPrompt || '').replace(/\s+/g, ' ').trim()
    || 'a young woman, short black chin-length hair parted to one side, calm steady gaze'
  const scene = String(p.scenePrompt || '').replace(/\s+/g, ' ').trim()
    || 'a clean outdoor location with even overcast daylight'
  const style = String(p.style || '').trim() || 'photoreal'
  const secs = (p.frames / 24).toFixed(2)
  const part = `segment ${p.shotNo} of ${p.totalShots}`
  return [
    'subject_definitions:',
    `<Subject 1> is the performer whose identity is locked by the identity card and whose body, outfit and styling come from <Picture 1>: ${who}. She has a complete head, a full face and her own hair in every frame — the reference board shows the outfit only, so the head comes from the identity card and from this description.`,
    `<Video 1> is the source dance video for the target edit, providing the choreography, body motion, expression timing, subject positioning, camera framing, camera movement, perspective, pacing and temporal structure.`,
    `<Audio 1> is the synchronized audio track of <Video 1> and is reused as the complete final audio track.`,
    'summary:',
    `[video editing + reference generation + audio reuse] The target video is an edited ${part} (${secs} seconds) of <Video 1>. The original performer is replaced throughout by <Subject 1>, whose identity comes from the identity card and whose body, outfit and styling come from <Picture 1>, while her motion and performance follows <Video 1>. The location is ${scene}.`,
    'retention_analysis:',
    '<Subject 1> (appears in [Shot 1]): fully_preserved - identity from the identity card, body, outfit and styling from <Picture 1>, unchanged from the first frame to the last.',
    '<Video 1> (appears in [Shot 1]): fully_preserved - choreography, body motion, expression timing, subject positioning, camera framing, camera movement and pacing are retained unchanged in every frame.',
    '<Audio 1> (appears in [Shot 1]): fully_copy - the audio of <Audio 1> is reused unchanged as the complete final audio track.',
    'detailed_description:',
    `The target video is a ${style} dance clip in even overcast daylight with soft shadowless light.`,
    `[Shot 1] A static medium-wide shot frames <Subject 1> from head to feet at the same distance, height and angle as <Video 1>, with ${scene} behind her.`,
    `She wears exactly the outfit of <Picture 1>, and the fabric creases and folds move the way they move on the real garment.`,
    `Throughout the whole take she performs the exact choreography of <Video 1>: her feet land on the same frames and on the same spots, her knees bend and straighten through the same amplitude, her hips travel the same path and distance, her torso turns and counter-turns at the same instants, her arms open and close through the same arcs at the same height, her wrists and hands reach the same positions relative to her body, her head follows the same directions, and her weight shifts from one leg to the other on the same frames, so every body position in every frame matches the corresponding frame of <Video 1>.`,
    'The camera holds the framing of <Video 1> for the whole take with the same height, distance and background layout, at the same framing amplitude and the same static speed, so there is no added pan, no tilt, no zoom and no push in.',
    'Her hair and loose cuffs swing with each direction change, her soft diffuse shadow slides across the ground under her shoes, and she keeps a calm steady expression throughout the take.',
    'The light stays flat and shadowless for the whole take, the sky fills the same portion of the frame as in <Video 1>, and the background elements hold the same positions and the same scale in every frame, so the location reads as one continuous place.',
    'Her silhouette matches <Video 1> frame for frame, the hem, pockets and rolled cuffs of the outfit keep their shape while she moves, the cloth wrap stays on the same wrist, and skin tones and fabric colours stay consistent with <Picture 1> from the first frame to the last.',
    'The image stays clean and sharp, the limbs stay intact through the fast passages, the joints hold their shape at the extremes of each pose, and only <Subject 1> is present in the frame from beginning to end.',
    'overall_soundscape:',
    'The complete audio of <Audio 1> is reused unchanged as the final audio track, including its music, its room tone and its ambient sound, with no added or regenerated sound.',
    'non_diegetic_music:',
    'The complete music of <Audio 1> is reused unchanged and is the only music track in the target video.',
  ].join('\n')
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

/** 提取到同名资产时，选择「用素材库现有的」→ 把库里那套图片/描述/提示词并进这一行（不新建重复记录） */
app.post('/projects/:id/assets/:aid/use-library', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const body = await c.req.json().catch(() => ({} as any))
  const a0 = await assetInProject(id, aid)
  if (!a0) return notFound(c, '资产不存在')
  const [src] = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.id, Number(body.libraryId || 0)))
  if (!src) return notFound(c, '素材库里没有这条')
  if (String((src as any).scope || '') !== 'library') return badRequest(c, '不是素材库里的资产')
  const patch = {
    image: (src as any).image, card: (src as any).card, prompt: (src as any).prompt,
    appearance: (src as any).appearance, styling: (src as any).styling,
    description: (src as any).description || (a0 as any).description,
    imageStatus: (src as any).imageStatus, sourceAssetId: (src as any).id,
    updatedAt: now(),
  } as any
  await db.update(schema.mvAssets).set(patch).where(eq(schema.mvAssets.id, aid))
  return success(c, { id: aid, assets: await assetsOf(id) })
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
  const assetPromptRaw = String(body.prompt ?? asset.prompt ?? '').trim()
  // 2026-10-20 用户报「侧面格还是出头」：老提示词里写着「鼻尖朝画面左边」——朝向里带五官词，
  // 模型就把那一格的头画出来了。这里机械替换成纯朝向（幂等，老卡「重绘」也能修好）。
  const assetPrompt = assetPromptRaw
    .replace(/鼻尖朝画面左(?:边|侧)?/g, '身体侧身 90 度，对着画面左侧')
    .replace(/鼻尖朝左/g, '身体侧身 90 度，对着画面左侧')
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
/** 从模型回复里抢救出 n 条「画面描述」：JSON 优先，坏了就按行剥序号/引号/逗号 */
function salvageWhat(text: string, n: number): string[] {
  const out: string[] = []
  try {
    const arr = pickJson<any[]>(text)
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const v = typeof it === 'string' ? it : (it?.what ?? it?.画面 ?? it?.desc ?? it?.description ?? '')
        const s = String(v || '').trim()
        if (s) out.push(s)
      }
    }
  } catch { /* 下面是按行抢救 */ }
  // 坏 JSON 抢救：直接把所有 "what":"…" 抠出来（线上真实翻车就是「属性值后缺逗号」这种）
  if (out.length < n) {
    for (const m of String(text || '').matchAll(/"(?:what|画面|desc|description)"\s*:\s*"([^"]{2,200})"/g)) {
      const s = m[1].trim()
      if (s) out.push(s)
    }
  }
  if (out.length < n) {
    for (const raw of String(text || '').split('\n')) {
      let s = raw.trim()
      if (!s) continue
      if (/^[[\]{}]/.test(s) && s.length < 4) continue
      s = s.replace(/^[\s\-*•]+/, '').replace(/^\d+[.、)]\s*/, '')          // 去序号
      s = s.replace(/^["'“]|["'”],?$/g, '').replace(/[,，]\s*$/, '')          // 去引号/尾逗号
      s = s.replace(/^\{?\s*"?what"?\s*:\s*"?/i, '').replace(/"?\s*\}?,?$/, '')
      if (s.length >= 4 && !/^(json|数组|输出)/i.test(s)) out.push(s.trim())
    }
  }
  return out.slice(0, n)
}

/** 解析对轴 LRC → 每句的起止秒（末句用 songSeconds 收尾） */
function parseLrcLines(lrc: string, total: number): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  for (const raw of String(lrc || '').split('\n')) {
    const m = raw.match(/\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\](.*)/)
    if (!m) continue
    const t = Number(m[1]) * 60 + Number(m[2])
    const text = String(m[3] || '').trim()
    if (text) out.push({ start: t, end: 0, text })
  }
  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length; i++) out[i].end = i + 1 < out.length ? out[i + 1].start : total
  return out
}

/** 与 [a,b) 有交集的歌词句子 */
function lyricsInWindow(lines: { start: number; end: number; text: string }[], a: number, b: number): string[] {
  return lines.filter((l) => l.end > a + 0.15 && l.start < b - 0.15).map((l) => l.text)
}

/**
 * 句界吸附切段：候选切点 = 每句起点；每段在 [min,target,max] 里挑离 target 最近的句界。
 * 没有合适句界时退回 start+max（这句会被切在中间，允许）。
 */
function planSegmentsByLines(lines: { start: number; end: number; text: string }[], total: number,
  minS = 5.2, targetS = 7, maxS = 8): { start: number; end: number; lyric: string[] }[] {
  // 候选切点 = 每句起点；但**起点必须从 0 开始** —— 前奏（第一句之前那段伴奏）也要有自己的镜头，
  // 不然整条 MV 缺开头（实测漏了 0~15.1s）。
  const cuts = lines.map((l) => l.start).filter((t) => t > minS && t < total - minS)
  const segs: { start: number; end: number; lyric: string[] }[] = []
  let start = 0
  while (start < total - 1) {
    const ok = cuts.filter((c) => c - start >= minS && c - start <= maxS)
    const end = ok.length
      ? ok.reduce((best, c) => (Math.abs(c - start - targetS) < Math.abs(best - start - targetS) ? c : best), ok[0])
      : Math.min(total, start + maxS)
    segs.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, lyric: lyricsInWindow(lines, start, end) })
    if (end <= start + 0.1) break
    start = end
  }
  return segs
}

app.post('/projects/:id/plan', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  if (!project.songSeconds) return badRequest(c, '还没拿到歌曲时长')
  // 有对轴时间轴：段的时间窗由代码按句界算死（不再让模型猜），模型只管每段「画面发生什么」
  const lrcLines = parseLrcLines(String(project.lyricLrc || ''), Number(project.songSeconds) || 0)
  if (lrcLines.length >= 3) {
    const segs = planSegmentsByLines(lrcLines, Number(project.songSeconds) || 0, 5.2, 7, 8)
    const askByLines = `歌长 ${project.songSeconds} 秒，歌名《${project.title}》。
${project.storyPrompt
  ? `分镜提示词（用户写的，主角/场景/风格都在里面）：\n"""\n${String(project.storyPrompt).slice(0, 8000)}\n"""`
  : `MV 想法：${project.idea || '(没写，按歌名发挥)'}`}

下面是已经按**歌词句界**切好的 ${segs.length} 段（时间与段数不许改，每段标了它唱的那几句）：
${segs.map((s, i) => `${i + 1}. ${s.start}-${s.end}s（${(s.end - s.start).toFixed(2)}s）：${s.lyric.join(' / ') || '(无人声，间奏)'}`).join('\n')}

请逐段写「这一段的画面发生什么」：场景/人物动作/情绪/关键道具，**一句话**，必须贴合这一段唱的内容，也要符合上面的分镜提示词（主角/场景/风格照它写）。
不许写景别、不许写运镜（下一步才配）。不许改段数、不许合并段。**不许把歌词原文当画面描述抄回来。**
只输出一个 JSON 数组，每项只要 what 一个字段（不要 start/end，时间由程序算）：
[{"what":"她低头翻相册，指尖停在那张旧照片上"}, …]`
    const sys = await mvPrompt('mv_storyboard')
    let whats: string[] = []
    let modelErr = ''
    for (let attempt = 1; attempt <= 2 && whats.filter(Boolean).length < segs.length; attempt++) {
      const strict = attempt === 1 ? '' : '\n\n注意：上一次输出不是合法 JSON。这次只输出 JSON 数组本身，不要任何说明文字、不要代码块标记。'
      try {
        const raw = await askText(sys, askByLines + strict, 3000, project.textConfigId)
        whats = salvageWhat(raw, segs.length)
        if (whats.filter(Boolean).length < segs.length) modelErr = `只解析出 ${whats.filter(Boolean).length}/${segs.length} 段`
      } catch (err: any) {
        modelErr = String(err?.message || err)
        logTaskError('MV', 'plan-outline-attempt', { id, attempt, error: modelErr })
      }
    }
    const good = whats.filter(Boolean).length
    // 一条都没拿到就明确报错 —— 绝不能把歌词当画面描述写进分镜（那样用户写了分镜提示词也等于没起作用）
    if (!good) return serverError(c, `AI 没返回可用的画面描述（${modelErr || '空回复'}）。点「AI 改写成分镜」再试一次；连续失败就换个文本模型。`)
    const outline = segs.map((s, i) => ({
      start: s.start, end: s.end,
      what: String(whats[i] || '').slice(0, 200),
    }))
    await db.update(schema.mvProjects).set({ outline: JSON.stringify(outline), status: 'planned', updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'plan-outline', { id, segments: outline.length, by: 'lyrics', got: good })
    return success(c, {
      outline, by: 'lyrics',
      warning: good < segs.length ? `${good}/${segs.length} 段拿到画面描述，其余为空 —— 可以手填，或再点一次重写` : undefined,
    })
  }
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

/** 详细分镜：服务器按能量/句界切硬时间轴（H3 帧网格），MV 侧按镜头语言配景别/机位/歌词 */
app.post('/projects/:id/shots', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  // 分镜的唱/非唱要靠人声轨判，没分离就切会全标成「唱」
  if (!project.vocalStem) return badRequest(c, '先点顶栏「人声分离」—— 分镜的唱/非唱要用人声轨判断')
  const body = await c.req.json().catch(() => ({} as any))
  const maxS = Math.min(HARD_MAX_S, Number(body.max_seconds || project.maxShotSeconds) || DEFAULT_MAX_S)
  // 到这一步才第一次把原曲转 32k 送 服务器（建项目时不碰它）
  let remoteSong = ''
  try {
    remoteSong = await ensureRemoteSong(project)
  } catch (err: any) {
    return serverError(c, `原曲上传失败：${err?.message || err}`)
  }
  // 有对轴时间轴就把「每句起点」当候选切点传下去：切点落在句界，唱词不会被腰斩。
  // 段长口径 5.2~8s、目标 7s（实测：一句一段平均只有 4.69s，29 句里 20 句短于 服务器的 5.167s 下限）。
  const shotLines = parseLrcLines(String(project.lyricLrc || ''), Number(project.songSeconds) || 0)
  const useLineCuts = shotLines.length >= 3
  const cutMax = useLineCuts ? Math.min(maxS, 8) : maxS
  let plan: { shots: any[]; grid?: number[] }
  try {
    plan = await shimPost('/v2/mv/plan', {
      audio_file: remoteSong, max_seconds: cutMax, target_seconds: 7,
      ...(useLineCuts ? { min_seconds: 5.2, boundaries: shotLines.map((l) => l.start) } : {}),
      vocal_stem: project.vocalStem || undefined,
    })
  } catch (err: any) {
    return serverError(c, `切段失败：${err?.message}`)
  }
  const raw = plan?.shots || []
  if (!raw.length) return serverError(c, '切段结果为空')
  // 2026-10-20 用户报「提取了两张场景，但没有任何分镜用到其中一张」：
  // 以前每段的参考图默认只有「第一个人物 + 第一个场景」，第二张场景永远用不上。
  // 现在按时间把场景铺开（第 k 段落在哪个场景窗口就绑哪个），角色默认第一个，写进 ref_ids。
  const shotAssets = await assetsOf(id)
  const charDefault = shotAssets.find((a) => a.kind === 'character') || null
  const sceneList = shotAssets.filter((a) => a.kind === 'scene')
  const totalForScene = Number((plan as any)?.total_seconds) || Number(project.songSeconds) || 0
  const propList = shotAssets.filter((a) => a.kind === 'prop' && String(a.name || '').trim())
  const squash = (t: any) => String(t || '').replace(/\s+/g, '')
  const propKeys = propNameKeys
  /** 这一段提到哪几个道具就绑哪几个（最多 2 个，按道具库顺序）——分镜文字里没提的绝不绑 */
  const propsInText = (text: string) => {
    const t = squash(text)
    if (!t) return [] as any[]
    return propList.filter((a) => propKeys(a.name).some((k) => t.includes(k))).slice(0, 2)
  }
  const sceneAt = (start: number) => {
    if (!sceneList.length) return null
    if (sceneList.length === 1 || !totalForScene) return sceneList[0]
    const idx = Math.min(sceneList.length - 1, Math.max(0, Math.floor((start / totalForScene) * sceneList.length)))
    return sceneList[idx]
  }
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
${useLineCuts
  ? `每段唱的词（**lyric 字段必须原样照抄这一段这几句**，无人声的段留空字符串）：\n${raw.map((s, i) => `${i}: ${(lyricsInWindow(shotLines, Number(s.start), Number(s.end)).join(' / ') || '(无人声，间奏)')}`).join('\n')}`
  : (lyricLines.length ? `歌词行：\n${lyricLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : '')}

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
    // 相邻段景别必须「跨两档」（用户口径：中远景→中景 在他眼里就是同一个景，拼起来一定跳）。
    // 档位：中远景/远景=0 · 中景=1 · 近景=2 · 特写=3，相邻段差值必须 ≥2。
    const SIZE_LV: Record<string, number> = { '远景': 0, '中远景': 0, '中景': 1, '近景': 2, '特写': 3 }
    const LV_SIZE: Record<number, string> = { 0: '中远景', 1: '中景', 2: '近景', 3: '特写' }
    // 冲突时不要一律推向最近档（那样中远景↔近景会死循环，中景/特写永远不出现）：
    // 按 0(中远景)→2(近景)→0→3(特写)→1(中景)→3 这个循环取下一个合格档，四档都能轮到。
    const CYCLE = [0, 2, 0, 3, 1, 3]
    let cyc = 0
    let prevPrevLv = -99
    const pickFar = (want: number, prev: number, minLv = 0) => {
      // 合格 = 跨两档，且不是 A→B→A 来回弹（弹来弹去等于只有两种景别），且不低于 minLv
      const ok = (lv: number) => Math.abs(lv - prev) >= 2 && lv !== prevPrevLv && lv >= minLv
      if (ok(want)) {
        const at = CYCLE.indexOf(want)
        cyc = at >= 0 ? (at + 1) % CYCLE.length : cyc
        return want
      }
      for (let k = 0; k < CYCLE.length; k++) {
        const c = CYCLE[(cyc + k) % CYCLE.length]
        if (ok(c)) { cyc = (cyc + k + 1) % CYCLE.length; return c }
      }
      // 放宽「跨两档」：仍必须满足 minLv（上段拉远 ⇒ 本段不能回中远景/中景），挑与上段差得最远的。
      // 注：上段是特写+拉远时，「跨两档」与「拉远后不许回中远景/中景」天然冲突（无解）——
      // 此时以「拉远后不许回中远景/中景」为准（用户 2026-10-21 定的硬规则），跨两档让步。
      if (minLv > 0) {
        const allowed = [0, 1, 2, 3].filter((c) => c >= minLv && c !== want)
        if (allowed.length) {
          const best = allowed.sort((a, b) => Math.abs(b - prev) - Math.abs(a - prev))[0]
          const at = CYCLE.indexOf(best)
          cyc = at >= 0 ? (at + 1) % CYCLE.length : cyc
          return best
        }
      } else {
        // 放宽一轮：只要求跨两档（宁可 A→B→A，也不能只差一档）
        for (const c of [0, 1, 2, 3]) if (Math.abs(c - prev) >= 2 && c !== want) return c
      }
      return want
    }
    let prevLv = -99
    let lastActClass = ''
    // 2026-10-21 用户口径：「上一段末拍是**逐渐拉远**时，下一段不能是中远景/中景」——
    // 拉远后画面已经退到远景，下一段又切回中远景/中景 ⇒ 视觉上「跳一下」。
    // 反过来「上一段是逐渐推进」时，下一段可以回到中远景/中景（观众刚被推进，再拉开是顺的）。
    // 判据取**上一段最后一拍的机位**（拉远/推近写在那儿），不是整段。
    const endsWithPull = (cam: string) => /拉远|后拉|后退|拉走|zoom\s*out|pull\s*(back|out)|dolly\s*out/i.test(String(cam || ''))
    let prevEndCam = ''
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i]
      const extra = (Array.isArray(perShot) ? perShot : []).find((x: any) => Number(x?.index) === i) || {}
      let prevActClass = i > 0 ? (lastActClass || '') : ''
      let sizeEff = SIZES.includes(String(extra?.shot_size || '')) ? String(extra.shot_size) : (sizes[i] || '中景')
      let lv = SIZE_LV[sizeEff] ?? 1
      if (i > 0) {
        // 上段末拍在拉远 → 本段不许落在「中远景/中景」（档位 0/1），必须 ≥2（近景/特写）
        const minLv = endsWithPull(prevEndCam) ? 2 : 0
        lv = pickFar(lv, prevLv, minLv)
      }
      sizeEff = LV_SIZE[lv]
      prevPrevLv = prevLv
      prevLv = lv
      const bet = fitBeats(extra?.beats, Number(s.seconds) || 5.167, sizeEff, String(extra?.camera || ''), i + 1, String(s.vocal_state || '') === 'vocal_active', prevActClass)
      // 记下本段最后一拍的机位，给下一段判断用
      prevEndCam = String(bet[bet.length - 1]?.camera || extra?.camera || '')
      const scenePick = sceneAt(Number(s.start) || 0)
      const segStart = Number(s.start) || 0
      const segEnd = Number(s.end) || segStart
      const segWhat = (() => {
        try {
          return outlineForWindow(JSON.parse(String(project.outline || '[]')) as any[], segStart, segEnd)
            .map((o: any) => String(o.what || '')).join(' ')
        } catch { return '' }
      })()
      const segLyric = useLineCuts
        ? lyricsInWindow(shotLines, segStart, segEnd).join(' ')
        : String(extra?.lyric || '')
      const propsHere = propsInText([segWhat, segLyric, String(extra?.prompt_extra || '')].join(' '))
      // 顺序保持「人物 → 场景 → 道具」（老段没有道具，编号不变）；道具排在最后与短剧一致
      const refIds = [charDefault?.id, scenePick?.id, ...propsHere.map((a: any) => a.id)].filter(Boolean)
      await db.insert(schema.mvShots).values({
        projectId: id, shotNumber: i + 1,
        startSeconds: Number(s.start), endSeconds: Number(s.end),
        frames: Number(s.frames), seconds: Number(s.seconds),
        shotSize: sizeEff,
        camera: String(extra?.camera || '').slice(0, 300),
        beats: JSON.stringify(bet),
        vocalState: String(s.vocal_state || 'vocal_active'),
        // 库里存「这一段真正唱的句子」：模型漏填/填错都以后端按时间窗算出来的为准
        lyric: (useLineCuts
          ? lyricsInWindow(shotLines, Number(s.start), Number(s.end)).join(' / ')
          : String(extra?.lyric || '')).slice(0, 300),
        status: 'pending', createdAt: ts, updatedAt: ts,
        refIds: refIds.length ? JSON.stringify(refIds) : null,
      })
      lastActClass = actClass(bet[0]?.action || '')
    }
    await db.update(schema.mvProjects).set({ status: 'shots', maxShotSeconds: maxS, updatedAt: ts }).where(eq(schema.mvProjects.id, id))
    // 2026-10-21 用户要求：**拆分完就把道具绑好**（不用再点「重新绑道具」）
    let boundProps = 0
    try {
      const madeShots = await shotsOf(id)
      boundProps = (await bindPropsToShots({ ...project, outline: JSON.stringify(outline) }, madeShots)).touched
    } catch (e: any) {
      logTaskError('MV', 'shots-bind-props', { id, error: e?.message })
    }
    logTaskSuccess('MV', 'shots', { id, count: raw.length, maxS, boundProps })
    return success(c, { count: raw.length, max_seconds: maxS, grid: plan.grid || [], bound_props: boundProps, shots: await shotsOf(id) })
  } catch (err: any) {
    logTaskError('MV', 'shots', { id, error: err?.message })
    return serverError(c, err?.message || '写分镜表失败')
  }
})

/** 停止某一段的生成：还没轮到的（仍排队的）直接作废；已在跑的也会在下一轮轮询时收尾 */
app.post('/projects/:id/shots/:sid/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  let ids: number[] = []
  try { ids = JSON.parse(String(shot.taskIds || '[]')).map(Number).filter(Boolean) } catch { ids = [] }
  if (shot.taskId) ids.push(Number(shot.taskId))
  ids = [...new Set(ids.filter(Boolean))]
  // 只作废还在排队的（processing）；已完成的保持原样
  let killed = 0
  for (const tid of ids) {
    const [t] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, tid))
    if (t && t.status === 'processing') {
      await db.update(schema.sysTask).set({ status: 'canceled', errorMsg: '手动停止', updatedAt: now() })
        .where(eq(schema.sysTask.id, tid))
      killed++
    }
  }
  await db.update(schema.mvShots).set({ status: 'pending', taskId: null, errorMsg: null, updatedAt: now() })
    .where(eq(schema.mvShots.id, sid))
  logTaskSuccess('MV', 'cancel', { id, sid, killed })
  return success(c, { id: sid, canceled_tasks: killed, shots: await shotsOf(id) })
})

/** 按名字 + 一次模型判定，把道具绑到给定分镜上（只动道具那部分，人物/场景保持原样）。
 *  拆分分镜后会自动调它（2026-10-21 用户要求「拆分时就绑好」），也可由按钮重跑。 */
async function bindPropsToShots(project: any, shots: any[]): Promise<{ touched: number; props: number }> {
  const id = Number(project?.id)
  const allA = await assetsOf(id)
  const props = allA.filter((a) => a.kind === 'prop')
  if (!props.length || !shots.length) return { touched: 0, props: props.length }
  const propIds = new Set(props.map((a) => a.id))
  const ready = props.filter((a) => a.image)          // 有图才绑（没图绑了也没参考图）
  if (!ready.length) return { touched: 0, props: props.length }
  let outline: any[] = []
  try { outline = JSON.parse(String(project.outline || '[]')) } catch { outline = [] }
  const whatOf = (s: any) => outline
    .filter((o: any) => Number(o?.end) > Number(s.startSeconds || 0) && Number(o?.start) < Number(s.endSeconds || 0))
    .map((o: any) => String(o.what || '')).join(' ')
  const hitMap = new Map<number, number[]>()
  for (const s of shots) {
    const txt = String([s.lyric, whatOf(s)].join(' ')).replace(/\s+/g, '')
    hitMap.set(s.id, ready.filter((a) => propNameKeys(a.name).some((k) => txt.includes(k))).slice(0, 2).map((a) => a.id))
  }
  // 名字对不上的（歌词写「宵夜」、道具叫「外卖保温袋」）交给模型判一次：有界 1 次调用
  const needAI = shots.filter((s) => !(hitMap.get(s.id) || []).length)
  if (needAI.length && ready.length) {
    try {
      const propList2 = ready.map((a, i) => `${i + 1}. ${a.name} —— ${String(a.description || '').slice(0, 80)}`).join('\n')
      const segList = needAI.map((s) => `第${s.shotNumber}段：${String([whatOf(s), s.lyric].filter(Boolean).join(' ')).slice(0, 140)}`).join('\n')
      const raw = await askText(await mvPrompt('mv_prop_map'),
        `下面是这支 MV 的道具清单和分镜段落。判断**每一段画面里真的出现/被使用时**是哪些道具（没出现就别填，宁缺勿滥，每段最多 2 个）。\n\n` +
        `道具清单：\n${propList2}\n\n分镜段落（只列需要判断的）：\n${segList}\n\n` +
        `只输出 JSON：{"segments":[{"n":段号,"props":[道具序号]}]}`, 1500, project.textConfigId)
      const got = pickJson<{ segments?: any[] }>(raw)?.segments || []
      for (const it of got) {
        const s = needAI.find((x: any) => Number(x.shotNumber) === Number(it?.n))
        if (!s) continue
        const ids = (Array.isArray(it?.props) ? it.props : []).map((k: any) => ready[Number(k) - 1]?.id).filter(Boolean).slice(0, 2)
        if (ids.length) hitMap.set(s.id, ids as number[])
      }
    } catch (e: any) {
      logTaskError('MV', 'shots-bind-props-ai', { id, error: e?.message })
    }
  }
  let touched = 0
  for (const s of shots) {
    let ids: number[] = []
    try { ids = JSON.parse(String(s.refIds || '[]')).map(Number).filter(Boolean) } catch { ids = [] }
    const keep = ids.filter((x) => !propIds.has(x))
    const next = [...keep, ...(hitMap.get(s.id) || [])]
    if (JSON.stringify(next) !== JSON.stringify(ids)) {
      await db.update(schema.mvShots).set({ refIds: next.length ? JSON.stringify(next) : null, updatedAt: now() })
        .where(eq(schema.mvShots.id, s.id))
      touched++
    }
  }
  return { touched, props: ready.length }
}

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
  // 2026-10-21：以前漏了这两个 —— 前端打了字、PUT 静默丢弃 → 轮询一刷新就"自动清空"
  if (body.prompt_extra !== undefined) patch.promptExtra = String(body.prompt_extra || '').slice(0, 1200)
  if (body.ref_ids !== undefined) patch.refIds = JSON.stringify(
    (Array.isArray(body.ref_ids) ? body.ref_ids : []).map(Number).filter(Boolean)).slice(0, 4000)
  await db.update(schema.mvShots).set(patch).where(eq(schema.mvShots.id, sid))
  return success(c, { id: sid })
})

/** 编译六段式提示词（服务器侧编译 + 硬校验，一条不过整批不发） */
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
  // 2026-10-19：先走 MV 自己的 video-prompt 规范（skills/mv/video-prompt）。
  // 任一条失败 → 整批回退下面的中转编译，保证同一批口径一致。
  try {
    const got: { zh: string; en: string }[] = []
    for (const s0 of shots) {
      const pickedS = (await shotRefs(id, s0)).filter((a0: any) => a0.image)
      const scS = pickedS.find((a0: any) => a0.kind === 'scene') || scene
      const r = await mvShotPromptSkill(project, s0, pickedS, character, scS)
      if (!r) throw new Error(`第 ${(s0 as any).shotNumber} 段生成失败：${lastShotPromptError || '流水线未返回有效内容'}`)
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
  // 2026-10-19：先走 MV 自己的 video-prompt 规范；失败如实报错
  // 2026-10-19 用户拍板：生成失败就如实报失败，**不偷偷回退旧编译**
  const skill = await mvShotPromptSkill(project, shot, picked, character, sc)
  if (!skill) return serverError(c, `提示词生成失败：${lastShotPromptError || '流水线未返回有效内容'}`)
  await db.update(schema.mvShots).set({ prompt: skill.zh, promptEn: skill.en, updatedAt: now() })
    .where(eq(schema.mvShots.id, sid))
  return success(c, { id: sid, prompt: skill.zh, promptEn: skill.en, engine: 'skill' })
})

/** 改「初步分镜」里某一段的文字（按起止秒匹配那一条；没有就追加）—— 画稿是提示词的剧情依据，必须能改 */
app.post('/projects/:id/outline', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const start = Number(body?.start), end = Number(body?.end)
  const what = String(body?.what ?? '').trim()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return badRequest(c, '缺 start / end')
  let list: any[] = []
  try { list = JSON.parse(String(project.outline || '[]')) } catch { list = [] }
  if (!Array.isArray(list)) list = []
  const i = list.findIndex((o: any) => Math.abs(Number(o.start) - start) < 0.01 && Math.abs(Number(o.end) - end) < 0.01)
  if (i >= 0) list[i] = { ...list[i], what }
  else list.push({ start, end, what })
  list.sort((a: any, b: any) => Number(a.start) - Number(b.start))
  await db.update(schema.mvProjects).set({ outline: JSON.stringify(list), updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  logTaskSuccess('MV', 'outline-edit', { id, start, end, chars: what.length })
  return success(c, { outline: list })
})

/** 单段提示词生成的真实进度（前端轮询用） */
app.get('/projects/:id/shots/:sid/prompt-progress', async (c) => {
  const sid = Number(c.req.param('sid'))
  const p = shotPromptProgress.get(sid)
  if (!p) return success(c, { step: 0, total: 8, label: '等待开始', done: false, age: 0 })
  return success(c, { step: p.step, total: p.total, label: p.label, done: p.done, age: Date.now() - p.at })
})

/** 本地机械体检：查 服务器那套没覆盖、但我们真踩过的坑（只读，不改动任何内容） */
function localPromptProblems(shot: any, mode: 'song' | 'dance' = 'song'): string[] {
  const en = String(shot?.promptEn || '')
  const out: string[] = []
  if (!en.trim()) return out
  if (mode === 'dance') {
    // 舞蹈段口径：动作来自 <Video 1>，没有唱段，不套 lead singer / 谁都不唱 那套
    if (!en.includes('<Video 1>')) out.push('舞蹈提示词没点名 <Video 1> 作为动作来源')
    if (!en.includes('[video editing + reference generation + audio reuse]')) out.push('舞蹈提示词模式头不对（应为 video editing + reference generation + audio reuse）')
    if (!/complete head/i.test(en)) out.push('舞蹈提示词没声明「有完整头部」（参考板是无头的，必须补头）')
    if (!/fully_copy/.test(en)) out.push('音频必须是 fully_copy（整段复用源片原音）')
    if (/<d>|<\/d>/.test(en)) out.push('出现 <d> 台词块（MV 不许写台词/歌词）')
    const bannedD = [...new Set((en.match(/\b(?:screen|screens|phone|phones|smartphone|tablet|mirror|mirrors|reflection|reflections|projection|poster|photograph|crowd|television|clone|duplicate|ghost)\b/gi) || []).map((x) => x.toLowerCase()))]
    if (bannedD.length) out.push(`含禁区词：${bannedD.slice(0, 4).join(', ')}`)
    return out
  }
  const det = (en.split(/^detailed_description:\s*$/m)[1] || '').split(/^overall_soundscape:/m)[0]
  if (/^\s*<(?:Subject \d+|Audio 1)>\s+is the supplied song excerpt/im.test(det)) {
    out.push('音频声明混进了 detailed_description（只能出现在 subject_definitions）')
  }
  const ret = (en.split(/^retention_analysis:\s*$/m)[1] || '').split(/^detailed_description:/m)[0]
  if (/<Subject \d+>/.test(ret) && !/\(appears in \[Shot \d+\]\)/.test(ret)) {
    out.push('retention_analysis 缺 (appears in [Shot N]) 标注')
  }
  const vocal = String(shot?.vocalState || '') === 'vocal_active'
  if (vocal && !/lead singer/i.test(en)) out.push('唱段缺「只有 <Subject 1> 唱」的 lead singer 句')
  if (vocal && !/only <Subject 1>'s lips/i.test(en)) out.push('唱段没点名只有 <Subject 1> 对嘴')
  if (!vocal && !/Nobody sings/i.test(en)) out.push('非唱段缺「谁都不唱」声明')
  if (/<d>|<\/d>/.test(en)) out.push('出现 <d> 台词块（MV 不许写台词/歌词）')
  const banned = [...new Set((en.match(/\b(?:screen|screens|phone|phones|smartphone|tablet|mirror|mirrors|reflection|reflections|projection|poster|portrait|painting|photograph|crowd|television|clone|duplicate|ghost)\b/gi) || []).map((x) => x.toLowerCase()))]
  if (banned.length) out.push(`含禁区词：${banned.slice(0, 4).join(', ')}`)
  return out
}

/** 单段体检 */
app.post('/projects/:id/shots/:sid/check', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  const project = await loadProject(id)
  try {
    if (!String(shot.promptEn || '').trim()) {
      return success(c, { shotNumber: shot.shotNumber, ok: false, problems: ['这一段的英文提示词还没生成 —— 点该段的「AI 生成」'] })
    }
    const mode = String(project.kind || 'song') === 'dance' ? 'dance' : 'song'
    const out = await shimPost<{ rows: any[] }>('/v2/mv/check', {
      mode,
      shots: [{ prompt: shot.promptEn || '', vocal_state: shot.vocalState || 'vocal_active' }],
    })
    const row = out?.rows?.[0] || { ok: false, problems: ['体检无返回'] }
    const problems = [...(row.problems || []), ...localPromptProblems(shot, mode)]
    return success(c, { shotNumber: shot.shotNumber, ok: !problems.length, problems })
  } catch (err: any) {
    logTaskError('MV', 'shot-check', { id, sid, error: err?.message })
    return serverError(c, err?.message || '体检失败')
  }
})

/**
 * 超分到 1080p：等比例放大（原始什么比例就用什么比例），落一条新成片记录。
 * 2026-10-22：原来锁高度 scale=-2:1080 + 判 height≥1080 ⇒ 竖屏源反而被缩小。
 * 改为短边放到 1080：竖屏 768×1344 → 1080×1890，横屏 1344×768 → 1890×1080。
 */
app.post('/projects/:id/upscale', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body: any = await c.req.json().catch(() => ({}))
  const srcRel = String(body.url || project.outputUrl || '')
  if (!srcRel || !fs.existsSync(getAbsolutePath(srcRel))) return badRequest(c, '还没有成片可超分 —— 先拼接')
  try {
    const rel = mvDir(id)
    const r = await upscaleVideo(srcRel, rel, 'mv_1080_')
    await db.insert(schema.mvMerges).values({
      // shot_ids 里打 `upscaled` 标记：前端据此把这条的「超分 1080p」按钮置灰，不用再去探一次分辨率
      projectId: id, shotIds: JSON.stringify(['upscaled']), mergedUrl: r.outRel,
      seconds: Number(r.from.duration || 0), status: 'completed', createdAt: now(),
    })
    logTaskSuccess('MV', 'upscale', { id, from: `${r.from.w}x${r.from.h}`, to: `${r.to.w}x${r.to.h}` })
    return success(c, { output_url: r.outRel, seconds: Number(r.from.duration || 0), width: r.to.w, height: r.to.h })
  } catch (err: any) {
    logTaskError('MV', 'upscale', { id, error: err?.message })
    return badRequest(c, err?.message || '超分失败')
  }
})

/** 歌词自动对轴：把纯歌词 + 人声轨送到 服务器跑 Whisper，回传 LRC（存在项目上，合成时烧字幕） */
app.post('/projects/:id/align', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  if (!project.vocalStem) return badRequest(c, '先点顶栏「人声分离」—— 对轴要用人声轨')
  const lyrics = String(project.lyrics || '').trim()
  if (!lyrics) return badRequest(c, '先把歌词填进「原始内容」的歌词框')
  try {
    const b: any = await c.req.json().catch(() => ({}))
    // 兼容旧版前端（不传 job）：直接同步对轴并返回 lrc。
    // 新前端传 job:true → 走异步任务，显卡被占用时排队、界面显示「排队中」。
    if (!b?.job) {
      const out = await shimPost<{ lrc: string; lines?: number; unmatched?: number; cover?: number; seconds?: number }>(
        '/v2/mv/align', { audio_file: project.vocalStem, lyrics, tag: `p${id}` },
      )
      const lrc = String(out?.lrc || '')
      if (!lrc.trim()) throw new Error('对轴没有返回时间轴')
      await db.update(schema.mvProjects).set({ lyricLrc: lrc, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
      logTaskSuccess('MV', 'align', { id, lines: out?.lines, cover: out?.cover })
      return success(c, { lrc, lines: out?.lines || 0, unmatched: out?.unmatched || 0, cover: out?.cover || 0, cached: Number(out?.seconds || 0) === 0 })
    }
    // 2026-10-21：改成异步 job —— 显卡被视频任务占用时服务器会排队，前端要能看到「排队中」
    const out = await shimPost<{ job_id?: string; state?: string; message?: string; lrc?: string; lines?: number; unmatched?: number; seconds?: number }>(
      '/v2/mv/align', { audio_file: project.vocalStem, lyrics, tag: `p${id}`, job: true },
    )
    const jobId = String(out?.job_id || '')
    if (!jobId) throw new Error('服务器没有返回对轴任务号')
    logTaskStart('MV', 'align', { id, job: jobId })
    // 服务器缓存命中时直接回 lrc（不再让前端绕一圈轮询）→ 这里就落库
    const lrc0 = String(out?.lrc || '')
    if (out?.state === 'done' && lrc0.trim()) {
      await db.update(schema.mvProjects).set({ lyricLrc: lrc0, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
      logTaskSuccess('MV', 'align', { id, lines: out?.lines })
      return success(c, { job_id: jobId, state: 'done', lrc: lrc0, lines: out?.lines || 0, unmatched: out?.unmatched || 0, seconds: out?.seconds || 0 })
    }
    return success(c, { job_id: jobId, state: out?.state || 'queued', message: out?.message || '' })
  } catch (err: any) {
    logTaskError('MV', 'align', { id, error: err?.message })
    return serverError(c, err?.message || '对轴失败')
  }
})

/** 对轴进度轮询：排队中 / 对轴中 / 完成（完成时才落库） */
app.post('/projects/:id/align/status', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const b: any = await c.req.json().catch(() => ({}))
  const jobId = String(b?.job_id || '')
  if (!jobId) return badRequest(c, '缺 job_id')
  try {
    const out = await shimPost<{ state?: string; message?: string; lrc?: string; lines?: number; unmatched?: number; seconds?: number; error?: string }>(
      '/v2/mv/align/status', { job_id: jobId },
    )
    const state = String(out?.state || 'queued')
    if (state === 'done') {
      const lrc = String(out?.lrc || '')
      if (!lrc.trim()) throw new Error('对轴没有返回时间轴')
      await db.update(schema.mvProjects).set({ lyricLrc: lrc, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
      logTaskSuccess('MV', 'align', { id, lines: out?.lines })
      return success(c, { state: 'done', lrc, lines: out?.lines || 0, unmatched: out?.unmatched || 0, seconds: out?.seconds || 0 })
    }
    if (state === 'failed') {
      logTaskError('MV', 'align', { id, error: out?.error })
      return success(c, { state: 'failed', error: String(out?.error || '对轴失败') })
    }
    return success(c, { state, message: String(out?.message || '') })
  } catch (err: any) {
    return serverError(c, err?.message || '查询对轴状态失败')
  }
})

/** 人声分离（demucs）：产出 vocals.wav，给唱/非唱判据用；幂等，已分离直接返回 */
app.post('/projects/:id/separate', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  // 人声分离已经挪到「上传完歌的第一步」，那时候还没走过详细分镜 → 这里先把歌推上去（幂等：有名字直接返回）
  let remote = String(project.songRemoteName || '')
  if (!remote) {
    try {
      remote = await ensureRemoteSong(project)
    } catch (err: any) {
      return serverError(c, `原曲上传失败：${err?.message || err}`)
    }
  }
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
    const mode = String(project.kind || 'song') === 'dance' ? 'dance' : 'song'
    const out = await shimPost<{ rows: any[]; ok: number; bad: number }>('/v2/mv/check', {
      mode,
      shots: shots.map((s) => ({ prompt: s.promptEn || '', vocal_state: s.vocalState || 'vocal_active' })),
    })
    const rows = (out?.rows || []).map((r: any, i: number) => {
      const noEn = !String(shots[i]?.promptEn || '').trim()
      const problems = noEn
        ? ['这一段的英文提示词还没生成 —— 点「编译全部提示词」或该段的「AI 生成」']
        : [...(r.problems || []), ...localPromptProblems(shots[i], mode)]
      return {
        shotNumber: shots[i]?.shotNumber ?? i + 1,
        ok: !noEn && !!r.ok && !localPromptProblems(shots[i], mode).length,
        problems,
      }
    })
    const okN = rows.filter((x) => x.ok).length
    logTaskSuccess('MV', 'check', { id, ok: okN, bad: rows.length - okN })
    return success(c, { ok: okN, bad: rows.length - okN, rows })
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
  const isDance = String(project.kind || 'song') === 'dance'
  const frames = Number(shot.frames) || snapFrames(Number(shot.seconds) || 5.167)
  const [VW, VH] = videoSize(project)
  if (isDance && (!project.danceSource || !project.danceRefSource)) {
    return badRequest(c, '舞蹈 MV 还没上传参考视频（先上传，后台会自动适配备份）')
  }
  // 舞蹈段：提示词缺失就现场按项目的人物/场景字段编译（动作来源写死 <Video 1>）
  if (isDance && !String(shot.promptEn || '').includes('<Video 1>')) {
    const all = await db.select().from(schema.mvShots).where(eq(schema.mvShots.projectId, id))
    const danceEn = compileDancePrompt({
      characterPrompt: project.characterPrompt || '', scenePrompt: project.scenePrompt || '',
      style: project.style || '', frames,
      shotNo: Number(shot.shotNumber) || 1, totalShots: all.length || 1,
    })
    const danceZh = compileDancePromptZh({ frames, shotNo: Number(shot.shotNumber) || 1, totalShots: all.length || 1 })
    await db.update(schema.mvShots).set({ promptEn: danceEn, prompt: danceZh, updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
    shot.promptEn = danceEn
  }
  try {
    const taskId = await generateVideo({
      prompt: String(shot.promptEn || shot.prompt || ''),
      model: isDance ? DANCE_MODEL : MV_MODEL,
      configId: project.videoConfigId ?? undefined,
      duration: Math.max(5.167, frames / 24),
      aspectRatio: project.aspectRatio || '16:9',
      resolution: `${VW}x${VH}`,
      referenceImageUrls: refs,
      seed: body.seed ? Number(body.seed) : undefined,
      // MV 专用字段（适配器原样并进请求体；短剧路径不传这些）
      mvExtras: isDance ? {
        dance_source: project.danceSource,
        dance_ref_source: project.danceRefSource,
        dance_start_frame: Math.round((Number(shot.startSeconds) || 0) * 24),
        // 段序号（0 起）：第 2 段起服务端会把上一段末 39 帧钉成本段前缀，接缝不跳
        dance_seg_index: Math.max(0, (Number(shot.shotNumber) || 1) - 1),
        mv_frames: frames,
        mv_width: VW, mv_height: VH,
        refmod_files: cards,
      } : {
        mv_audio: { name: await ensureRemoteSong(project) },
        mv_start_seconds: Number(shot.startSeconds) || 0,
        mv_frames: frames,
        mv_width: VW, mv_height: VH,
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
/** 生成 ASS 字幕文件；既没有主创也没有歌词时间轴时返回 null（不烧字幕，保持纯 copy） */
async function makeAss(project: any, videoOnly: string, start: number, total: number, assPath: string): Promise<string | null> {
  const credits = { songTitle: project.songTitle, lyricist: project.lyricist, composer: project.composer }
  const lines = parseLrc(String(project.lyricLrc || ''))
  if (!credits.songTitle && !credits.lyricist && !credits.composer && !lines.length) return null
  const dim = await new Promise<{ w: number; h: number }>((res) =>
    ffmpeg.ffprobe(videoOnly, (e: any, m: any) => {
      const v = (m?.streams || []).find((x: any) => x.codec_type === 'video')
      res({ w: Number(v?.width) || 768, h: Number(v?.height) || 1344 })
    }))
  const ass = buildAss({ width: dim.w, height: dim.h, totalSeconds: total, credits, lyrics: lines, offset: start })
  if (!ass) return null
  fs.writeFileSync(assPath, ass, 'utf8')
  return ass
}

/** 主创三项（曲名/作词/作曲）：随时可改，合成时用 */
app.post('/projects/:id/credits', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const b: any = await c.req.json().catch(() => ({}))
  const patch: Record<string, any> = { updatedAt: now() }
  if ('song_title' in b || 'songTitle' in b) patch.songTitle = String(b.song_title ?? b.songTitle ?? '').trim() || null
  if ('lyricist' in b) patch.lyricist = String(b.lyricist ?? '').trim() || null
  if ('composer' in b) patch.composer = String(b.composer ?? '').trim() || null
  await db.update(schema.mvProjects).set(patch).where(eq(schema.mvProjects.id, id))
  return success(c, { ok: true })
})

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
  const isDance = String(project.kind || 'song') === 'dance'
  if (isDance) {
    // 舞蹈 MV：各段自带参考视频原音 → 顺序拼接即可，不混原曲、不烧字幕
    const relD = mvDir(id)
    const outNameD = `mv_dance_final_${Date.now()}.mp4`
    const outAbsD = path.join(STORAGE_ROOT, relD, outNameD)
    const FPS = 24
    const durOfD = (f: string) => new Promise<number>((res) =>
      ffmpeg.ffprobe(f, (e: any, m: any) =>
        res(e ? 0 : Number((m?.streams || []).find((x: any) => x.codec_type === 'video')?.duration) || 0)))
    try {
      const filesD: string[] = []
      const chainsD: string[] = []
      let totalD = 0
      for (let i = 0; i < done.length; i++) {
        const abs = getAbsolutePath(done[i].videoUrl as string)
        filesD.push(abs)
        const sec = Number(done[i].seconds) || (Number(done[i].frames) || 124) / FPS
        const dur = await durOfD(abs)
        const need = Math.max(1, Math.round(Math.min(sec, dur || sec) * FPS))
        chainsD.push(`[${i}:v]trim=start_frame=0,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=3,trim=end_frame=${need},setpts=PTS-STARTPTS,fps=${FPS},setsar=1[v${i}]`)
        chainsD.push(`[${i}:a]atrim=start=0:duration=${(need / FPS).toFixed(4)},asetpts=PTS-STARTPTS,aresample=32000[a${i}]`)
        totalD += need / FPS
      }
      const graphD = `${chainsD.join(';')};${done.map((_: any, i: number) => `[v${i}][a${i}]`).join('')}concat=n=${done.length}:v=1:a=1[vout][aout]`
      await new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg()
        for (const f of filesD) cmd = cmd.input(f)
        cmd.complexFilter(graphD)
          .outputOptions(['-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '20',
            '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart'])
          .on('end', () => resolve()).on('error', (e: Error) => reject(new Error(`拼接失败：${e.message}`)))
          .save(outAbsD)
      })
    } catch (err: any) {
      logTaskError('MV', 'assemble-dance', { id, error: err?.message })
      return serverError(c, err?.message)
    }
    const outRelD = `${mvDir(id)}/${outNameD}`
    await db.insert(schema.mvMerges).values({
      projectId: id, shotIds: JSON.stringify(done.map((s) => s.id)), mergedUrl: outRelD,
      seconds: done.reduce((a, s) => a + (Number(s.seconds) || 0), 0), status: 'completed', createdAt: now(),
    } as any)
    await db.update(schema.mvProjects).set({ outputUrl: outRelD, status: 'done', updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'assemble-dance', { id, shots: done.length })
    return success(c, { output_url: outRelD, seconds: done.reduce((a, s) => a + (Number(s.seconds) || 0), 0) })
  }
  // 原曲文件丢了（实测 mv/p1/song_src.mp3 被清掉过）→ 先找同目录的 song_src.wav / .mp3 兜底，再报人话
  const songRel = (() => {
    const cur = String(project.songFile || '')
    if (cur && fs.existsSync(getAbsolutePath(cur))) return cur
    const dir = mvDir(id)
    for (const name of ['song_src.wav', 'song_src.mp3', 'song_32k.wav', 'song_32k.mp3']) {
      const rel2 = `${dir}/${name}`
      if (fs.existsSync(getAbsolutePath(rel2))) return rel2
    }
    return cur
  })()
  if (!songRel || !fs.existsSync(getAbsolutePath(songRel))) return badRequest(c, '原曲文件丢了（' + (project.songFile || '未设置') + '）：请重新导入这首歌再混音')
  if (songRel !== project.songFile) {
    await db.update(schema.mvProjects).set({ songFile: songRel, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'song-file-fallback', { id, from: project.songFile, to: songRel })
    project.songFile = songRel
  }
  const rel = mvDir(id)
  const listPath = path.join(STORAGE_ROOT, rel, 'concat.txt')
  fs.writeFileSync(listPath, done.map((s) => `file '${getAbsolutePath(s.videoUrl as string)}'`).join('\n'))
  const videoOnly = path.join(STORAGE_ROOT, rel, 'video_only.mp4')
  const outName = `mv_final_${Date.now()}.mp4`
  const outAbs = path.join(STORAGE_ROOT, rel, outName)
  const start = Number(done[0].startSeconds) || 0
  const total = done.reduce((a, s) => a + (Number(s.seconds) || 0), 0)
  try {
    // 每段视频实际时长常比它的时间窗长（trim 只在 got>want 时裁、还按帧取整）→ 直接 -c copy 拼会把富余时长
    // 累加成错位（实测 3 段就差 1.4s，嘴形全错）。这里按每段自己声明的秒数精确裁，总长必然 = sum(seconds) = 音频窗口。
    const durOf = (f: string) => new Promise<number>((res) =>
      ffmpeg.ffprobe(f, (e: any, m: any) =>
        res(e ? 0 : Number((m?.streams || []).find((x: any) => x.codec_type === 'video')?.duration) || 0)))
    const files: string[] = []
    const chains: string[] = []
    const FPS = 24
    let acc = 0   // 累计秒；按绝对帧网格取整，段间误差不累积（按秒裁每段最多丢/多 1 帧，21 段能累积到 0.9s）
    for (let i = 0; i < done.length; i++) {
      const abs = getAbsolutePath(done[i].videoUrl as string)
      const sec = Number(done[i].seconds) || 0
      const dur = await durOf(abs)
      // 老片段开头带 0.5s 预热（实测：shot1 音频相对原曲偏 +0.5s、时长 7.30 vs 窗口 6.58；新生成的 shot2 偏移 0.000）
      // ⇒ 只要比窗口多出 0.3~1.2s 就按带预热处理，跳掉 0.5s；新片段 extra≈0，不动。零累积由下面的帧网格保证。
      const extra = dur - sec
      const skip = extra > 0.3 && extra < 1.2 ? MV_WARMUP_SECONDS : 0
      const f0 = Math.round(acc * FPS)
      acc += sec
      const f1 = Math.round(acc * FPS)
      const skipF = Math.round(skip * FPS)
      files.push(abs)
      // 先用 tpad 克隆末帧兜底再按帧数截断：某些段文件比应得帧数少 1~2 帧（实测 16 段少 6 帧 = 0.25s，
      // 拼到第 10 段以后就明显错位）——直接 end_frame 会被截断到源文件帧数，缺口累积。
      const need = Math.max(1, f1 - f0)
      chains.push(`[${i}:v]trim=start_frame=${skipF},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=3,trim=end_frame=${need},setpts=PTS-STARTPTS,fps=${FPS},setsar=1[v${i}]`)
    }
    const graph = `${chains.join(';')};${done.map((_: any, i: number) => `[v${i}]`).join('')}concat=n=${done.length}:v=1:a=0[vout]`
    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg()
      for (const f of files) cmd = cmd.input(f)
      cmd.complexFilter(graph)
        .outputOptions(['-map', '[vout]', '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
        .on('end', () => resolve()).on('error', (e: Error) => reject(new Error(`拼接失败：${e.message}`))).save(videoOnly)
    })
    // 字幕：主创（曲名/作词/作曲）+ 歌词逐句。有 ASS 才烧，没有就保持原来的 -c:v copy 直接混音。
    // ASS 必须放在**无空格**的路径：放 data/static 下会被 "Application Support" 里的空格切断
    // filtergraph 参数（实测报 subtitles.ass': Invalid argument）。
    const assPath = path.join(os.tmpdir(), `mv_sub_${id}_${Date.now()}.ass`)
    const assText = await makeAss(project, videoOnly, start, total, assPath)
    await new Promise<void>((resolve, reject) => {
      const mix = ffmpeg(videoOnly).input(getAbsolutePath(project.songFile as string)).inputOptions([`-ss ${start}`])
      const base = ['-map 0:v', '-map 1:a', '-c:a aac', '-b:a 192k', '-t', String(total), '-movflags +faststart']
      const out = assText
        // 烧字幕要重编码画面（字幕是画进像素的）；preset veryfast + crf 20 与拼接同档，画质不变
        // 路径交给 filtergraph 要做两级转义：先 \ 转 /，再转义 : 和 '（空格上一步已避开）
        ? ['-vf', `subtitles=filename=${assFilterPath(assPath)}`, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...base]
        : ['-c:v', 'copy', ...base]
      mix.outputOptions(out)
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
export { parseLrcLines, planSegmentsByLines, lyricsInWindow, salvageWhat, localPromptProblems, propNameKeys,
         planDanceSegments, compileDancePrompt, compileDancePromptZh }   // 给自检脚本用
