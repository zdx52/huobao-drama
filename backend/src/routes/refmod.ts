import { Hono } from 'hono'
import { extractRefmod, isRefmodKind, refmodStatus, removeRefmod } from '../services/refmod.js'
import { success, badRequest, serverError } from '../utils/response.js'
import { logTaskError } from '../utils/task-logger.js'

const app = new Hono()

// GET /refmod/status?kind=character&id=15 → { name, ready, size }
app.get('/status', (c) => {
  const kind = c.req.query('kind')
  const id = Number(c.req.query('id') || 0)
  if (!isRefmodKind(kind) || !id) return badRequest(c, 'kind 必须是 character|scene|prop，id 必填')
  return success(c, refmodStatus(kind, id))
})

// GET /refmod/statuses?keys=character-15,scene-3,prop-7 → { '<key>': { name, ready, size } }
app.get('/statuses', (c) => {
  const raw = String(c.req.query('keys') || '')
  const out: Record<string, { name: string; ready: boolean; size: number }> = {}
  for (const key of raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60)) {
    const [kind, idStr] = key.split('-')
    const id = Number(idStr)
    if (!isRefmodKind(kind) || !Number.isFinite(id) || id <= 0) continue
    out[key] = refmodStatus(kind, id)
  }
  return success(c, out)
})

// POST /refmod/extract { kind, id } → 抽卡并落盘到 Mac 主副本（覆盖同一张）
app.post('/extract', async (c) => {
  try {
    const body = await c.req.json()
    const kind = body?.kind
    const id = Number(body?.id || 0)
    if (!isRefmodKind(kind) || !id) return badRequest(c, 'kind 必须是 character|scene|prop，id 必填')
    const out = await extractRefmod(kind, id)
    return success(c, out)
  } catch (err: any) {
    logTaskError('Refmod', 'extract', { error: err?.message })
    return serverError(c, err?.message || '抽卡失败')
  }
})

// DELETE /refmod?kind=character&id=15 → 清掉该资产的卡
app.delete('/', (c) => {
  const kind = c.req.query('kind')
  const id = Number(c.req.query('id') || 0)
  if (!isRefmodKind(kind) || !id) return badRequest(c, 'kind 必须是 character|scene|prop，id 必填')
  return success(c, { removed: removeRefmod(kind, id) })
})

export default app
