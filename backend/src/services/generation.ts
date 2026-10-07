/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
 */
import { db, getInsertId, schema } from '../db/index.js'
import { eq, inArray } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, getAbsolutePath, readImageAsCompressedDataUrl, readImageAsDataUrl, saveBase64Image } from '../utils/storage.js'
import sharp from 'sharp'
import { extractVideoPoster } from '../utils/video-poster.js'
import { getImageAdapter, getVideoAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'

type TaskType = 'image' | 'video'

const taskLabel = (type: TaskType) => (type === 'image' ? 'ImageTask' : 'VideoTask')

// 轮询节奏：图片 5s×120（上限 10 分钟）；视频 10s×300
const POLL_PROFILES: Record<TaskType, { attempts: number; intervalMs: number; maxDurationMs: number | null }> = {
  image: { attempts: 120, intervalMs: 5000, maxDurationMs: 600_000 },
  video: { attempts: 300, intervalMs: 10_000, maxDurationMs: null },
}

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
}

/** 续拍 airlock 头（runner 在第 2 段起自动前置）：hold 上段结尾构图约 2 秒（无台词 + 微动作）再切新构图。
 *  对齐作者口径（README「Writing prompts for a chain」）：不要在同一时刻同时要"变化"和"延续"；
 *  跳过 airlock 的接缝会像两个房间拼在一起；hold 段必须无台词，只给呼吸/重心/视线微动作。
 *  2026-10-07：删掉自加的"首句重复上段尾词"（作者无此条，且换场景段没有文字落点）。 */
const AIRLOCK_HEAD =
  '[续拍] Open holding the exact closing framing of the previous segment for about 2 seconds: ' +
  'no camera move, no dialogue, performers keep a breath/weight-shift/eyeline micro-motion, ' +
  'then cut to the new setup. '

interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  referenceFileUrl?: string
  referenceLinkUrl?: string
  generateAudio?: boolean
  duration?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  promptExtend?: boolean
  watermark?: boolean
  configId?: number
  /** 续拍链（可选）：同场景多镜头链式生成时透传给供应商 */
  chainId?: string
  chainSegment?: number
  chainSegments?: number
  /** 续拍链计划（仅首段携带）：按序的分镜 payload 数组，runner 逐段取用 */
  chainPlan?: ChainSegmentPayload[]
}

/** 链内单段 payload（与 tasks 入口字段对齐的子集） */
export interface ChainSegmentPayload {
  storyboard_id?: number
  drama_id?: number
  prompt: string
  model?: string
  reference_image_urls?: string[]
  reference_video_urls?: string[]
  reference_audio_urls?: string[]
  image_url?: string
  first_frame_url?: string
  last_frame_url?: string
  generate_audio?: boolean
  duration?: number
  aspect_ratio?: string
  resolution?: string
  seed?: number
  config_id?: number
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置，避免生成被旧引用卡死
  const config = params.configId
    ? (await getConfigById(params.configId)) ?? await getActiveConfig('image')
    : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')

  const id = await createTask('image', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    size: params.size || '1920x1080',
    frameType: params.frameType,
    referenceImages: params.referenceImages,
  })

  logTaskStart('ImageTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

/** 该分镜绑定的角色行（按绑定顺序；查库失败返回空数组，不阻断生成） */
async function storyboardCharacterRows(storyboardId?: number): Promise<any[]> {
  const sid = Number(storyboardId)
  if (!Number.isFinite(sid) || sid <= 0) return []
  try {
    const links = await db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, sid))
    const ids = [...new Set(links.map((l) => Number(l.characterId)).filter((v) => Number.isFinite(v) && v > 0))]
    if (!ids.length) return []
    const rows = await db.select().from(schema.characters).where(inArray(schema.characters.id, ids))
    return ids.map((id) => rows.find((r: any) => Number(r.id) === id)).filter((r: any) => !!r)
  } catch {
    return []
  }
}

/** 该分镜的环境音字段 → 官方 overall_soundscape 段（防模型在安静镜头里自己脑补人声）。
 *  官方指南原话：安静的镜头若冒出你没要求的人声，就把音频字段写明再重跑。
 *  配乐字段 bgm_prompt 默认**不带**（写 N/A），避免模型自由加配乐；将来要 H3 出配乐再把 music 传进来。 */
async function storyboardAudioFields(storyboardId?: number): Promise<{ ambience: string; music: string }> {
  const sid = Number(storyboardId)
  if (!Number.isFinite(sid) || sid <= 0) return { ambience: '', music: '' }
  try {
    const rows = await db
      .select({ amb: schema.storyboards.soundEffect, mus: schema.storyboards.bgmPrompt })
      .from(schema.storyboards)
      .where(eq(schema.storyboards.id, sid))
    const r: any = rows[0]
    return { ambience: String(r?.amb || '').trim(), music: String(r?.mus || '').trim() }
  } catch {
    return { ambience: '', music: '' }
  }
}

/** 参考板脸格裁切（2026-10-07）：角色板是「一帧四格」（正/左侧/背 无头 + 脸部特写，脸在最右），
 *  另切出最右 1/4 当独立参考图，把脸部像素信息量放大 4 倍（整块板仍照常发送）。
 *  视频参考图走原尺寸不压缩（readImageAsDataUrl），所以切出的脸格是原始像素。 */
async function facePanelDataUrl(imageUrl?: string | null): Promise<string> {
  const raw = String(imageUrl || '').trim()
  if (!raw.startsWith('static/') && !raw.startsWith('/static/')) return ''
  try {
    const abs = getAbsolutePath(raw.startsWith('/static/') ? raw.slice(1) : raw)
    const meta = await sharp(abs).metadata()
    const w = Number(meta.width || 0)
    const h = Number(meta.height || 0)
    if (w < 40 || h < 40) return ''
    const cw = Math.max(16, Math.round(w * 0.25))
    const buf = await sharp(abs)
      .extract({ left: w - cw, top: 0, width: cw, height: h })
      .jpeg({ quality: 92 })
      .toBuffer()
    return 'data:image/jpeg;base64,' + buf.toString('base64')
  } catch {
    return ''
  }
}

/** 拼 verbatim_lock 块：角色 styling/appearance 原文 + 新增脸图的编号说明。
 *  LLM 写提示词时会漏句/调序/改写（同一套规则实测"好一段坏一段"），这里在提交前用数据库原文兜底。
 *  块以 `verbatim_lock：` 起头；中转（shim）会把它保留成独立段落、不并入镜头。
 *  budget 内按「脸图 → styling → appearance、整行取舍」截断，避免撞上供应商 7000 字符上限。 */
function buildVerbatimLock(
  rows: any[],
  faceRefs: { name: string; picNo: number }[],
  audio: { ambience: string; music: string },
  budget: number,
): string {
  if (!rows.length) return ''
  const head =
    '\nverbatim_lock：以下妆造/外观字符串取自角色资产原文，逐字使用——不得改写、不得省略任何从句、不得调整顺序；' +
    '脸、发型、发色、服装、配饰、剪裁以此为准（本段正文若与这里不一致，以这里的原文为准）：\n'
  const styl: string[] = []
  const app: string[] = []
  for (const c of rows) {
    const nm = String(c.name || '').trim()
    const st = String(c.styling || '').trim()
    const ap = String(c.appearance || '').trim()
    if (st) styl.push(`${nm} styling：${st}`)
    if (ap) app.push(`${nm} appearance：${ap}`)
  }
  const face = faceRefs.map(
    (f) => `face_ref：<Picture ${f.picNo}> 是 ${f.name} 的脸部特写裁切（面部身份以此为准；服装与体型仍以角色板为准）`,
  )
  const audioLine = audio.ambience
    ? `audio_lock：overall_soundscape=${audio.ambience}｜non_diegetic_music=N/A`
    : ''
  const picked: string[] = []
  let used = head.length
  for (const line of [...(audioLine ? [audioLine] : []), ...face, ...styl, ...app]) {
    if (used + line.length + 1 > budget) break
    picked.push(line)
    used += line.length + 1
  }
  return picked.length ? head + picked.join('\n') : ''
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置
  const config = params.configId
    ? (await getConfigById(params.configId)) ?? await getActiveConfig('video')
    : await getActiveConfig('video')
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')

  // 妆造/外观机械兜底 + 脸格加强 + 链上第 2 段起的 hold 头：仅在 prompt 非空时处理
  const basePrompt = String(params.prompt || '')
  // 单段重拍（chainSegment>=2）同样钉着上一段尾音频 → 也要 hold 头；
  // 链 runner 侧不再自己加（避免重复前置）。
  const holdHead = Number(params.chainSegment || 0) >= 2 ? AIRLOCK_HEAD : ''
  const body0 = holdHead + basePrompt
  const refUrls = [...(params.referenceImageUrls || [])]
  let lock = ''
  if (body0.trim()) {
    const rows = await storyboardCharacterRows(params.storyboardId)
    const faceRefs: { name: string; picNo: number }[] = []
    for (const c of rows) {
      if (refUrls.length >= 9) break // 供应商参考图上限 9
      const dataUrl = await facePanelDataUrl(c.imageUrl)
      if (!dataUrl || refUrls.includes(dataUrl)) continue
      refUrls.push(dataUrl)
      faceRefs.push({ name: String(c.name || '').trim(), picNo: refUrls.length })
    }
    lock = buildVerbatimLock(rows, faceRefs, await storyboardAudioFields(params.storyboardId), Math.max(240, 6800 - body0.length))
  }
  const finalPrompt = body0 + lock

  const id = await createTask('video', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    prompt: finalPrompt,
    model: params.model || config.model,
  }, {
    referenceMode: params.referenceMode || 'reference',
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: refUrls,
    referenceVideoUrls: params.referenceVideoUrls,
    referenceAudioUrls: params.referenceAudioUrls,
    referenceFileUrl: params.referenceFileUrl,
    referenceLinkUrl: params.referenceLinkUrl,
    generateAudio: params.generateAudio === false ? 0 : 1,
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    // 统一存为项目内部格式，各适配器再转换为官方大小写与枚举。
    resolution: normalizeStoredVideoResolution(params.resolution),
    seed: params.seed,
    promptExtend: params.promptExtend,
    watermark: params.watermark,
    chainId: params.chainId,
    chainSegment: params.chainSegment,
    chainSegments: params.chainSegments,
    chainPlan: params.chainPlan,
  })

  logTaskStart('VideoTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode: params.referenceMode || 'reference',
    duration: params.duration || 5,
  })
  logTaskPayload('VideoTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

/**
 * 续拍链声明：按序分镜一次建链，交第 1 段；成功后 runner 在 handleVideoComplete 里续交。
 * 单段失败整链停（靠 failTask 自然停），重试=重交失败段（同 chainId/段号）。
 */
export async function startChain(segments: ChainSegmentPayload[], chainEnabled = true): Promise<{ chainId: string; taskId: number }> {
  const list = (Array.isArray(segments) ? segments : []).filter(
    (s) => s && (String(s.prompt || '').trim() || ((s.reference_image_urls || []).length > 0)),
  )
  if (!list.length) throw new Error('续拍链至少需要 1 个有效分镜（prompt 或参考图）')
  // 总闸关=不建 chainId：走官方老路单发（兼容升级，默认开）
  const useChain = chainEnabled !== false
  // 2026-10-07 稳定链身份（支持单段重拍）：chainId 按「剧+集」推导，重跑复用同一目录、新存覆盖旧存；
  // 段号绑定分镜在本集的序号（不再按选中顺序从 1 数），重拍第 k 段时 LOAD=k-1 才能命中上次存的 clip_(k-1)。
  let chainId = ''
  let startSeg = 1
  let plan: (ChainSegmentPayload | null)[] = list
  let first = list[0]
  if (useChain) {
    const ord = await episodeOrdinals(list)
    const withSeg = list
      .map((s, i) => ({ s, seg: ord.get(Number(s.storyboard_id)) ?? (i + 1) }))
      .sort((a, b) => a.seg - b.seg)
    startSeg = withSeg[0].seg
    first = withSeg[0].s
    chainId = 'ch-' + Number(first.drama_id ?? 0) + '-' + (ord.episodeId ?? 0)
    // plan 按段号就位（前面补空位）：runner 只在 plan[seg] 存在时才续交，单段重拍立即收链
    plan = new Array(startSeg + withSeg.length - 1).fill(null)
    withSeg.forEach(({ s, seg }) => { plan[seg - 1] = s })
  }
  const taskId = await generateVideo({
    storyboardId: first.storyboard_id,
    dramaId: first.drama_id,
    prompt: first.prompt,
    model: first.model,
    referenceMode: 'reference',
    imageUrl: first.image_url,
    firstFrameUrl: first.first_frame_url,
    lastFrameUrl: first.last_frame_url,
    referenceImageUrls: first.reference_image_urls,
    referenceVideoUrls: first.reference_video_urls,
    referenceAudioUrls: first.reference_audio_urls,
    generateAudio: first.generate_audio,
    duration: first.duration,
    aspectRatio: first.aspect_ratio,
    resolution: first.resolution,
    seed: first.seed,
    configId: first.config_id,
    chainId,
    chainSegment: useChain ? startSeg : undefined,
    chainSegments: useChain ? plan.length : undefined,
    chainPlan: useChain ? (plan as ChainSegmentPayload[]) : undefined,
  })
  logTaskStart('VideoTask', 'chain', { chainId: chainId || '(off)', taskId, segments: list.length, startSeg })
  return { chainId, taskId }
}

/** 分镜在本集的序号（1 起，按 storyboard_number 排序）+ 该集 episodeId（供稳定 chainId 用） */
async function episodeOrdinals(list: ChainSegmentPayload[]): Promise<Map<number, number> & { episodeId?: number }> {
  const out = new Map<number, number>() as Map<number, number> & { episodeId?: number }
  const ids = list.map((s) => Number(s.storyboard_id)).filter((n) => Number.isFinite(n) && n > 0)
  if (!ids.length) return out
  const rows = await db
    .select({ id: schema.storyboards.id, episodeId: schema.storyboards.episodeId })
    .from(schema.storyboards)
    .where(inArray(schema.storyboards.id, ids))
  out.episodeId = rows.find((r) => r.id === Number(list[0].storyboard_id))?.episodeId ?? rows[0]?.episodeId
  if (!out.episodeId) return out
  const all = await db
    .select({ id: schema.storyboards.id })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, out.episodeId))
    .orderBy(schema.storyboards.storyboardNumber, schema.storyboards.id)
  all.forEach((r, i) => out.set(r.id, i + 1))
  return out
}

async function createTask(
  type: TaskType,
  config: AIConfig,
  fields: {
    storyboardId?: number
    dramaId?: number
    sceneId?: number
    characterId?: number
    propId?: number
    prompt: string
    model?: string | null
  },
  params: Record<string, unknown>,
): Promise<number> {
  const ts = now()
  const res = await db.insert(schema.sysTask).values({
    type,
    ...fields,
    provider: config.provider,
    params: JSON.stringify(params),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })

  const id = getInsertId(res)
  processTask(id, config).catch(err => {
    logTaskError(taskLabel(type), 'process', { id, error: err.message })
    console.error(`${taskLabel(type)} ${id} failed:`, err)
  })
  return id
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

async function processTask(id: number, config: AIConfig) {
  try {
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!record) return
    const type = record.type as TaskType
    const label = taskLabel(type)
    const params = parseTaskParams(record.params)
    logTaskProgress(label, 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
    })

    let url: string, method: string, headers: Record<string, string>, body: unknown

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const resolvedReferenceImages = await normalizeReferenceImages(params.referenceImages)
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: params.size,
        frameType: params.frameType,
        referenceImages: resolvedReferenceImages.length ? JSON.stringify(resolvedReferenceImages) : null,
      }))
    } else {
      const adapter = getVideoAdapter(config.provider)
      const resolvedImageUrl = await normalizeVideoReferenceUrl(params.imageUrl)
      const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(params.firstFrameUrl)
      const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(params.lastFrameUrl)
      const resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(params.referenceImageUrls)
      // 参考视频/音频文件较大，不适合 dataURL 内联，需解析为公网可访问 URL
      const resolvedReferenceVideoUrls = resolvePublicMediaUrls(params.referenceVideoUrls, 'video')
      const resolvedReferenceAudioUrls = resolvePublicMediaUrls(params.referenceAudioUrls, 'audio')
      const resolvedReferenceFileUrl = resolvePublicMediaUrl(params.referenceFileUrl, 'file')
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        referenceMode: params.referenceMode,
        imageUrl: resolvedImageUrl,
        firstFrameUrl: resolvedFirstFrameUrl,
        lastFrameUrl: resolvedLastFrameUrl,
        referenceImageUrls: resolvedReferenceImageUrls.length ? JSON.stringify(resolvedReferenceImageUrls) : null,
        referenceVideoUrls: resolvedReferenceVideoUrls.length ? JSON.stringify(resolvedReferenceVideoUrls) : null,
        referenceAudioUrls: resolvedReferenceAudioUrls.length ? JSON.stringify(resolvedReferenceAudioUrls) : null,
        referenceFileUrl: resolvedReferenceFileUrl,
        referenceLinkUrl: params.referenceLinkUrl,
        generateAudio: params.generateAudio,
        duration: params.duration,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        seed: params.seed,
        promptExtend: params.promptExtend,
        watermark: params.watermark,
        chainId: params.chainId,
        chainSegment: params.chainSegment,
        chainSegments: params.chainSegments,
      }))
    }

    logTaskProgress(label, 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })

    const isMultipart = body instanceof FormData
    logTaskPayload(label, 'request payload', {
      id, method, url, headers,
      // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
      body: isMultipart ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]` : body,
    })

    const resp = await fetch(url, {
      method,
      headers,
      body: isMultipart ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
    const result = await resp.json() as any
    logTaskPayload(label, 'response payload', { id, provider: config.provider, result })

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

      if (!isAsync && imageUrl) {
        logTaskProgress(label, 'sync-complete', { id, imageUrl })
        await handleImageComplete(record, imageUrl)
        return
      }

      if (!isAsync && !imageUrl) {
        // 同步模式但无 URL（Gemini 等返回 base64）
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskProgress(label, 'sync-base64-complete', { id, mimeType: b64.mimeType })
          await handleImageCompleteBase64(record, b64.data, b64.mimeType)
          return
        }
        throw new Error('No image URL or base64 data in response')
      }

      await markPolling(id, taskId)
      pollTask(record, config, taskId!)
      return
    }

    const adapter = getVideoAdapter(config.provider)
    const { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && videoUrl) {
      logTaskProgress(label, 'sync-complete', { id, videoUrl })
      await handleVideoComplete(record, videoUrl, params.duration)
      return
    }

    await markPolling(id, taskId)
    pollTask(record, config, taskId!)
  } catch (err: any) {
    await failTask(id, err.message)
  }
}

async function markPolling(id: number, taskId: string | undefined) {
  await db.update(schema.sysTask)
    .set({ taskId, status: 'processing', updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
  logTaskProgress('SysTask', 'poll-start', { id, taskId })
}

async function failTask(id: number, message: string) {
  logTaskError('SysTask', 'failed', { id, error: message })
  await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: message, updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

async function pollTask(record: SysTaskRecord, config: AIConfig, taskId: string) {
  const type = record.type as TaskType
  const label = taskLabel(type)
  const profile = POLL_PROFILES[type]
  const adapter = type === 'image' ? getImageAdapter(config.provider) : getVideoAdapter(config.provider)
  const startedAt = Date.now()

  for (let i = 0; i < profile.attempts; i++) {
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await failTask(record.id, 'Timeout: Polling exceeded 10 minutes')
      return
    }
    await new Promise(r => setTimeout(r, profile.intervalMs))
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress(label, 'poll-request', {
        id: record.id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = profile.maxDurationMs
        ? Math.max(1_000, profile.maxDurationMs - (Date.now() - startedAt))
        : 600_000
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) continue
      const result = await resp.json() as any

      // 图片/视频 PollResponse 结构不同，这里统一按 any 取值后按 type 分支
      const pollResp: any = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed') {
        if (type === 'image') {
          if (pollResp.imageUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, imageUrl: pollResp.imageUrl })
            await handleImageComplete(record, pollResp.imageUrl)
            return
          }
          if (adapter.provider === 'gemini') {
            // Gemini 可能返回 base64
            const b64 = (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64(result)
            if (b64) {
              logTaskSuccess(label, 'poll-base64-complete', { id: record.id, taskId, mimeType: b64.mimeType })
              await handleImageCompleteBase64(record, b64.data, b64.mimeType)
              return
            }
          }
        } else if (pollResp.videoUrl) {
          logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, videoUrl: pollResp.videoUrl })
          await handleVideoComplete(record, pollResp.videoUrl, pollResp.duration)
          return
        }
      }
      if (pollResp.status === 'failed') {
        // 上游明确失败（如内容审核拦截）属终态：立即落库，不重试不等待超时
        await failTask(record.id, pollResp.error || 'Generation failed')
        return
      }
    } catch (err: any) {
      const exhausted = i === profile.attempts - 1
        || (profile.maxDurationMs != null && Date.now() - startedAt >= profile.maxDurationMs)
      if (exhausted) {
        await failTask(record.id, `Timeout: ${err.message}`)
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await failTask(record.id, 'Timeout: polling attempts exhausted')
}

async function handleImageComplete(record: SysTaskRecord, imageUrl: string) {
  const localPath = await downloadFile(imageUrl, 'images')
  // 列表页缩略图（前端按命名约定推导地址，失败不影响主流程）
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ resultUrl: imageUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })

  await writeBackImageAssets(record, localPath)
}

async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'saved-base64', { id: record.id, provider: record.provider, mimeType, localPath })

  await writeBackImageAssets(record, localPath)
}

// 图片完成后回写业务表：分镜(按 frameType)、角色、场景、道具
async function writeBackImageAssets(record: SysTaskRecord, localPath: string) {
  const params = parseTaskParams(record.params)
  if (record.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (params.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (params.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    await db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId))
  }
  if (record.characterId) {
    await db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId))
  }
  if (record.sceneId) {
    await db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId))
  }
  if (record.propId) {
    await db.update(schema.props).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId))
  }
}

async function handleVideoComplete(record: SysTaskRecord, videoUrl: string, duration: number | null | undefined) {
  const localPath = await downloadFile(videoUrl, 'videos')
  // 海报帧供列表/封面展示，避免前端为显示首帧缓冲整个视频
  await extractVideoPoster(localPath)
  await db.update(schema.sysTask)
    .set({ resultUrl: videoUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('VideoTask', 'downloaded', { id: record.id, localPath, storyboardId: record.storyboardId, duration })

  if (record.storyboardId) {
    await db.update(schema.storyboards)
      .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
      .where(eq(schema.storyboards.id, record.storyboardId))
  }

  // 续拍链 runner：本段成功后自动交下一段（串行；失败走 failTask 自然停链）
  try {
    const p = parseTaskParams(record.params)
    const plan: ChainSegmentPayload[] | null = Array.isArray(p.chainPlan) ? p.chainPlan : null
    const seg = Number(p.chainSegment || 0)
    if (plan && p.chainId && seg >= 1 && seg < plan.length && plan[seg]) {
      const next = plan[seg] // plan[0] 是第 1 段；空位=该段没被选中，链到此收
      await generateVideo({
        storyboardId: next.storyboard_id,
        dramaId: next.drama_id ?? record.dramaId,
        prompt: String(next.prompt || ''),
        model: next.model,
        referenceMode: 'reference',
        imageUrl: next.image_url,
        firstFrameUrl: next.first_frame_url,
        lastFrameUrl: next.last_frame_url,
        referenceImageUrls: next.reference_image_urls,
        referenceVideoUrls: next.reference_video_urls,
        referenceAudioUrls: next.reference_audio_urls,
        generateAudio: next.generate_audio,
        duration: next.duration,
        aspectRatio: next.aspect_ratio,
        resolution: next.resolution,
        seed: next.seed,
        configId: next.config_id,
        chainId: String(p.chainId),
        chainSegment: seg + 1,
        chainSegments: plan.length,
        chainPlan: plan,
      })
      logTaskSuccess('VideoTask', 'chain-next', { chainId: p.chainId, fromSeg: seg, toSeg: seg + 1 })
    } else if (plan && p.chainId && seg >= plan.length && plan.length > 0) {
      logTaskSuccess('VideoTask', 'chain-done', { chainId: p.chainId, segments: plan.length })
    }
  } catch (err: any) {
    // runner 自身异常：下一段没建，链停在当前段，前端按失败段重试即可
    logTaskError('VideoTask', 'chain-runner', { id: record.id, error: err?.message })
  }
}

// ─── 参考素材归一化 ───────────────────────────────────────────────

async function normalizeReferenceImages(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    // 远程 URL：下载压缩为 data URL，保证 multipart 上传（OpenAI edits）/ inline_data（Gemini）都可用
    if (/^https?:\/\//.test(value)) {
      try {
        return await fetchImageAsCompressedDataUrl(value, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-fetch-failed', { url: value, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      // 视频参考图直接编码原文件，保留原始尺寸、格式、透明通道和画质。
      return readImageAsDataUrl(localPath)
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

/**
 * 将参考视频/音频解析为 Seedance API 可访问的 URL。
 * http(s)/dataURL 直通；本地 static 路径需要 PUBLIC_BASE_URL 拼成公网地址，
 * 未配置时抛出可操作的中文错误（落入 catch 写入 error_msg 供前端展示）。
 */
function resolvePublicMediaUrl(value: string | null | undefined, kind: 'video' | 'audio' | 'file'): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (!base) {
      const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
      throw new Error(
        `参考${label}为本地路径 ${raw}，但后端未配置 PUBLIC_BASE_URL，上游视频生成 API 无法访问内网地址。` +
        `请在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试，或改用公网 URL。`,
      )
    }
    const p = raw.startsWith('/') ? raw : `/${raw}`
    return `${base}${p}`
  }
  return raw
}

function resolvePublicMediaUrls(refs: string[] | null | undefined, kind: 'video' | 'audio'): string[] {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  return items.map((item) => resolvePublicMediaUrl(item, kind)).filter((item): item is string => !!item)
}

function normalizeStoredVideoResolution(resolution: string | null | undefined): string | undefined {
  const value = String(resolution || '').trim().toLowerCase()
  if (value === '480p' || value === '720p' || value === '1080p') return value
  if (value === '2k') return '2K'
  return undefined
}
