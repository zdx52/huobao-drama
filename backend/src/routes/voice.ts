/**
 * 角色声音路由（2026-10-08）
 *   GET  /voice/bases                    → 底样本库清单（下拉用）
 *   GET  /voice/bases/:id/audio          → 底样本 wav 试听（内嵌播放器用）
 *   POST /voice/preview {base,desc}      → 只试听：4080 TTS 出 wav（不落卡）
 *   POST /voice/generate {id,base,desc,force} → 生成/重抽声音卡（落 Mac 主副本）
 *   GET  /voice/status?id=15             → 单角色状态 {name,ready,pending,size}
 *   GET  /voice/status?ids=15,16         → 批量状态
 *   DELETE /voice?id=15                  → 清掉该角色的声音（卡+wav+参数）
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  extractVoiceCard,
  listVoiceBases,
  previewVoice,
  removeVoice,
  voiceBaseWavPath,
  voiceCardName,
  voiceStatus,
  voiceWavPath,
} from '../services/voice.js'
import { success, badRequest, notFound, serverError } from '../utils/response.js'
import { logTaskError } from '../utils/task-logger.js'
// ⚠️ 音色描述（ensureVoiceDesc/readVoicePrompt/saveVoicePrompt）住在 services/voice-prompt.js，
//    不是 services/voice.js。漏了这行 = 运行时 ReferenceError（AI 生成按钮报「音色描述生成失败」），
//    而 esbuild 打包**不会**报错（未声明的标识符按全局处理）→ CI 绿、点按钮才炸。
import { ensureVoiceDesc, readVoicePrompt, saveVoicePrompt } from '../services/voice-prompt.js'
import fs from 'fs'

const app = new Hono()

app.get('/bases', (c) => success(c, listVoiceBases()))

// 角色提示词生成时顺带产出的音色描述（声音面板自动带出；可手改）
app.get('/prompt', (c) => {
  const id = Number(c.req.query('id') || 0)
  if (!id) return badRequest(c, 'id 必填')
  return success(c, { desc: readVoicePrompt(id) })
})

// 用户手改音色描述（落文件，source=user）——只改描述，不动已有的声音卡
app.put('/prompt', async (c) => {
  try {
    const body = await c.req.json()
    const id = Number(body?.id || 0)
    if (!id) return badRequest(c, 'id 必填')
    const desc = String(body?.desc ?? '').trim().slice(0, 300)
    saveVoicePrompt(id, desc, 'user')
    return success(c, { desc })
  } catch (err: any) {
    logTaskError('VoiceDesc', 'save', { error: err?.message })
    return serverError(c, err?.message || '保存音色描述失败')
  }
})

// 让 AI（重新）生成音色描述并落盘；force=true 时忽略已有的重出
app.post('/prompt', async (c) => {
  try {
    const body = await c.req.json()
    const id = Number(body?.id || 0)
    if (!id) return badRequest(c, 'id 必填')
    const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
    if (!char) return badRequest(c, '角色不存在')
    const desc = await ensureVoiceDesc(char, Boolean(body?.force), {
      model: body?.text_model,
      configId: body?.text_config_id ?? undefined,
    })
    if (!desc) return serverError(c, '音色描述生成失败（检查文本模型配置）')
    return success(c, { desc })
  } catch (err: any) {
    logTaskError('VoiceDesc', 'generate', { error: err?.message })
    return serverError(c, err?.message || '生成音色描述失败')
  }
})

app.get('/bases/:id/audio', (c) => {
  const p = voiceBaseWavPath(c.req.param('id'))
  if (!p) return badRequest(c, '底样本不存在')
  const buf = fs.readFileSync(p)
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': 'audio/wav',
    'Cache-Control': 'public, max-age=86400',
  })
})

// 已生成声音卡的源 wav 试听（Mac 主副本 <data>/voices/<卡名>.wav；没生成过就 404）
// 面板里「生成声音」完成后 / 再次打开面板时，前端拿这个地址直接播刚生成的那条
app.get('/audio', (c) => {
  const id = Number(c.req.query('id') || 0)
  if (!id) return badRequest(c, 'id 必填')
  const p = voiceWavPath(voiceCardName(id))
  if (!fs.existsSync(p)) return notFound(c, '这个角色还没有生成声音')
  const buf = fs.readFileSync(p)
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': 'audio/wav',
    'Cache-Control': 'no-store',
  })
})

app.post('/preview', async (c) => {
  try {
    const body = await c.req.json()
    const base = String(body?.base || '').trim()
    if (!base) return badRequest(c, 'base（底样本 id）必填')
    const wav = await previewVoice(base, String(body?.desc || ''))
    return c.body(new Uint8Array(wav), 200, {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
    })
  } catch (err: any) {
    logTaskError('Voice', 'preview', { error: err?.message })
    return serverError(c, err?.message || '试听失败')
  }
})

app.post('/generate', async (c) => {
  try {
    const body = await c.req.json()
    const id = Number(body?.id ?? body?.characterId ?? 0)
    const base = String(body?.base || '').trim()
    if (!id) return badRequest(c, 'id（角色 id）必填')
    if (!base) return badRequest(c, 'base（底样本 id）必填')
    const out = await extractVoiceCard(id, base, String(body?.desc || ''), Boolean(body?.force))
    return success(c, out)
  } catch (err: any) {
    logTaskError('Voice', 'generate', { error: err?.message })
    return serverError(c, err?.message || '生成声音失败')
  }
})

app.get('/status', (c) => {
  const idRaw = c.req.query('id')
  const idsRaw = c.req.query('ids')
  if (idsRaw) {
    const out: Record<string, any> = {}
    for (const one of String(idsRaw).split(',').map((s) => Number(s.trim())).filter((n) => n > 0).slice(0, 60)) {
      out[String(one)] = voiceStatus(one)
    }
    return success(c, out)
  }
  const id = Number(idRaw || 0)
  if (!id) return badRequest(c, 'id 或 ids 必填')
  return success(c, voiceStatus(id))
})

app.delete('/', (c) => {
  const id = Number(c.req.query('id') || 0)
  if (!id) return badRequest(c, 'id 必填')
  return success(c, { removed: removeVoice(id) })
})

export default app
