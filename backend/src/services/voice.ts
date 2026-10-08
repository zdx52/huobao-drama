/**
 * 角色声音（voice 卡）服务 —— 2026-10-08 用户拍板：生产走 RefMod 声音卡
 *
 * 流程：「生成声音」= 底样本(必选) + 音色描述(可选)
 *   → 4080 中转 POST /v2/tts/voice 出 wav（CosyVoice，一次性进程，不常驻）
 *   → 4080 中转 POST /v2/refmod/extract_voice 抽成 refmod_voice-character-<id>_v1 卡
 *   → 卡落 Mac 主副本 <data>/refmods/（与图片卡同构），来源 wav + 参数落 <data>/voices/
 * 生成视频时：声音卡**排在图片卡之后**同序下发（中转识别 voice-* 前缀 → 只贡献 Audio 分量
 *   + 骨架补 <Audio j> is the voice-timbre reference for <Subject K>）。
 *
 * 设计取舍（有据）：
 *  - **不新增数据库列**：`initSqliteSchema` 只有 `CREATE TABLE IF NOT EXISTS`，没有加列迁移，
 *    给已有库加列会让查询直接报错 → 声音状态一律用**文件**表达（与卡方案一致，零 schema 风险）。
 *  - **两层缓存**（用户 2026-10-08 拍板 A）：① 内存 in-flight 去重：同名卡在抽 → 复用同一个 Promise；
 *    ② 内容指纹：底样本+描述+文本没变且卡已存在 → 直接返回（不重抽）；force=true 才强制重抽。
 */
import path from 'path'
import fs from 'fs'
import { STORAGE_ROOT } from '../utils/paths.js'
import { refmodCardPath } from './refmod.js'
import { getActiveConfig } from './ai.js'
import { logTaskError, logTaskSuccess } from '../utils/task-logger.js'

/** 抽卡用的固定中性文本（比音色不比内容；与底样本库同一句，便于对比试听） */
export const VOICE_DEFAULT_TEXT =
  '今天天气不错，风也小，咱们去公园转转，顺便把菜买了，晚上早点回家。'

/** 声音卡名（与图片卡同命名规则，两边逐字一致，中转按 voice- 前缀识别） */
export function voiceCardName(id: number): string {
  return `refmod_voice-character-${Number(id)}_v1`
}

function voicesDir(): string {
  return path.join(STORAGE_ROOT, '..', 'voices')
}
function basesDir(): string {
  return path.join(STORAGE_ROOT, '..', 'voice_bases')
}
export function voiceWavPath(name: string): string {
  return path.join(voicesDir(), `${name}.wav`)
}
export function voiceMetaPath(name: string): string {
  return path.join(voicesDir(), `${name}.json`)
}

export interface VoiceBase {
  id: string
  label: string
  voice: string
  sex: string
  age: string
  quality: string
  seconds: number
  md5: string
}

/** 底样本库清单（Mac 主副本 <data>/voice_bases/manifest.json，edge-tts 预生成） */
export function listVoiceBases(): { line: string; bases: VoiceBase[] } {
  try {
    const raw = fs.readFileSync(path.join(basesDir(), 'manifest.json'), 'utf8')
    const j = JSON.parse(raw)
    return {
      line: String(j?.line || VOICE_DEFAULT_TEXT),
      bases: Array.isArray(j?.bases) ? (j.bases as VoiceBase[]) : [],
    }
  } catch {
    return { line: VOICE_DEFAULT_TEXT, bases: [] }
  }
}

/** 底样本 wav 的绝对路径（试听用）；不存在返回 null */
export function voiceBaseWavPath(id: string): string | null {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '')
  if (!safe) return null
  const p = path.join(basesDir(), `${safe}.wav`)
  return fs.existsSync(p) ? p : null
}

/** 状态：文件为准（ready=卡在），另叠加内存里的"正在抽" */
export function voiceStatus(id: number): {
  name: string
  ready: boolean
  pending: boolean
  size: number
  base: string
  desc: string
} {
  const name = voiceCardName(id)
  let ready = false
  let size = 0
  let base = ''
  let desc = ''
  try {
    const st = fs.statSync(refmodCardPath(name))
    ready = st.isFile() && st.size > 1024
    size = st.size
  } catch {
    /* 没有卡 */
  }
  try {
    const m = JSON.parse(fs.readFileSync(voiceMetaPath(name), 'utf8'))
    base = String(m?.base || '')
    desc = String(m?.desc || '')
  } catch {
    /* 没有参数记录 */
  }
  return { name, ready, pending: pending.has(name), size, base, desc }
}

/** 在抽中的任务（App 重启即丢；状态查询把它与文件状态合并） */
const pending = new Map<string, Promise<{ name: string; size: number }>>()

/** 取 4080 中转地址（现役视频配置的 baseUrl；App 配的是裸地址） */
async function shimBase(): Promise<string> {
  const cfg = await getActiveConfig('video')
  const base = String(cfg?.baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('没有可用的视频服务配置，拿不到 4080 中转地址')
  return base
}

/**
 * 调 4080 TTS，返回 { wav, seconds }。
 *
 * ⚠️ 2026-10-08 修的坑：原来把 `base` 字段塞成中转网址（`{base: shimUrl}`），
 * 而 4080 的 `base` 是「底样本文件名」语义 → 匹配不到 → **静默回落到 CosyVoice 自带女声底**，
 * 用户选的底一次也没生效（男角色拿到女声底）。现在改为**上传底样本本体**（base_wav, base64），
 * 不依赖 4080 本地目录里是否有同 id 的文件；底不存在才退回按 id 找。
 */
async function callTts(
  shimUrl: string,
  baseId: string,
  desc: string,
  text: string,
): Promise<{ wav: Buffer; seconds: number | null }> {
  const payload: Record<string, unknown> = { desc, text }
  const p = voiceBaseWavPath(baseId)
  if (p) payload.base_wav = fs.readFileSync(p).toString('base64')
  else if (baseId) payload.base = baseId
  const resp = await fetch(`${shimUrl}/v2/tts/voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(900_000),
  })
  if (!resp.ok) {
    throw new Error(`TTS 失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  const out: any = await resp.json()
  const b64 = String(out?.wav || '')
  if (!b64) throw new Error('TTS 返回为空')
  const wav = Buffer.from(b64, 'base64')
  if (wav.length < 4096) throw new Error(`TTS 结果异常（只有 ${wav.length} 字节）`)
  const seconds = Number(out?.seconds)
  return { wav, seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null }
}

/** 只试听：底样本 + 描述 → wav（不落卡、不落盘） */
export async function previewVoice(baseId: string, desc: string): Promise<Buffer> {
  const shimUrl = await shimBase()
  const text = listVoiceBases().line || VOICE_DEFAULT_TEXT
  const { wav } = await callTts(shimUrl, String(baseId || '').trim(), desc || '', text)
  return wav
}

/** 生成声音卡：TTS → 落 wav/参数 → 抽卡 → 落卡。force=true 强制重抽 */
export async function extractVoiceCard(
  id: number,
  baseId: string,
  desc: string,
  force = false,
): Promise<{ name: string; size: number }> {
  const name = voiceCardName(id)
  const existing = pending.get(name)
  if (existing && !force) return existing // ① 同名在抽 → 复用同一结果（连点不重复起进程）
  const task = (async () => {
    const shimUrl = await shimBase()
    const text = listVoiceBases().line || VOICE_DEFAULT_TEXT
    const cleanDesc = String(desc || '').trim()
    const cleanBase = String(baseId || '').trim()
    if (!cleanBase) throw new Error('缺底样本（base）——先在面板里选一个底')

    // ② 内容指纹：底样本+描述+文本都没变且卡在 → 直接复用，不重抽
    if (!force) {
      try {
        const m = JSON.parse(fs.readFileSync(voiceMetaPath(name), 'utf8'))
        const st = fs.statSync(refmodCardPath(name))
        if (
          st.isFile() &&
          st.size > 1024 &&
          String(m?.base || '') === cleanBase &&
          String(m?.desc || '') === cleanDesc &&
          String(m?.text || '') === text
        ) {
          return { name, size: st.size }
        }
      } catch {
        /* 没有记录 → 正常重抽 */
      }
    }

    const { wav, seconds } = await callTts(shimUrl, cleanBase, cleanDesc, text)
    fs.mkdirSync(voicesDir(), { recursive: true })
    fs.writeFileSync(voiceWavPath(name), wav)
    fs.writeFileSync(
      voiceMetaPath(name),
      JSON.stringify(
        { base: cleanBase, desc: cleanDesc, text, seconds, updated_at: new Date().toISOString() },
        null,
        1,
      ),
    )

    const resp = await fetch(`${shimUrl}/v2/refmod/extract_voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        audio: wav.toString('base64'),
        description: cleanDesc,
        concept_type: 'voice',
        force,
      }),
      signal: AbortSignal.timeout(900_000),
    })
    if (!resp.ok) {
      throw new Error(`抽声音卡失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    }
    const out: any = await resp.json()
    const cardB64 = String(out?.data || '')
    if (!cardB64) throw new Error('抽声音卡返回为空')
    const card = Buffer.from(cardB64, 'base64')
    if (card.length < 1024) throw new Error(`抽声音卡结果异常（只有 ${card.length} 字节）`)
    const outPath = refmodCardPath(name)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, card)
    logTaskSuccess('Voice', 'extract', { id, name, size: card.length, wav: wav.length })
    return { name, size: card.length }
  })()
  pending.set(name, task)
  try {
    return await task
  } catch (err: any) {
    logTaskError('Voice', 'extract', { id, error: err?.message })
    throw err
  } finally {
    pending.delete(name)
  }
}

/**
 * 取这些角色的声音卡（下发给 4080 用）。
 * 缺卡 → **抛错中止**（与图片卡同一纪律：绝不静默降级出一版没带声音卡的片子）。
 */
export async function voiceCardsForCharacters(
  ids: number[],
): Promise<Array<{ name: string; data: string }>> {
  const list = Array.from(new Set((ids || []).map((i) => Number(i)).filter((i) => i > 0))).slice(
    0,
    3, // 2026-10-08 拍板：单段说话人 >3 时只带前 3 条
  )
  if (!list.length) return []
  const out: Array<{ name: string; data: string }> = []
  const missing: string[] = []
  for (const id of list) {
    const name = voiceCardName(id)
    // 没有做声音的角色（没有参数记录）→ 跳过，不要求带卡
    if (!fs.existsSync(voiceMetaPath(name))) continue
    try {
      const buf = await fs.promises.readFile(refmodCardPath(name))
      out.push({ name, data: buf.toString('base64') })
    } catch {
      missing.push(`角色 ${id}（卡名 ${name}）`)
    }
  }
  if (missing.length) {
    throw new Error(
      `以下角色还没有生成声音，已中止本次生成：${missing.join('、')}。` +
        `请先到角色上点「生成声音」，或取消本段的声音绑定后重试。`,
    )
  }
  return out
}

/** 删角色时清声音（卡 + wav + 参数） */
export function removeVoice(id: number): boolean {
  const name = voiceCardName(id)
  let ok = false
  for (const p of [refmodCardPath(name), voiceWavPath(name), voiceMetaPath(name)]) {
    try {
      fs.unlinkSync(p)
      ok = true
    } catch (err: any) {
      if (err?.code !== 'ENOENT') logTaskError('Voice', 'remove', { id, error: err?.message })
    }
  }
  return ok
}
