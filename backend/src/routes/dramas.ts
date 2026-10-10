import { Hono } from 'hono'
import { and, eq, isNull, like, desc, inArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, badRequest, notFound, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { removeRefmod } from '../services/refmod.js'
import { removeVoice } from '../services/voice.js'
import { collectStoryboardFiles, purgeStorageFiles } from '../utils/storage-purge.js'

const app = new Hono()

// GET /dramas - List dramas
app.get('/', async (c) => {
  const page = Number(c.req.query('page') || 1)
  const pageSize = Number(c.req.query('page_size') || 20)
  const status = c.req.query('status')
  const keyword = c.req.query('keyword')

  const allRows = await db.select().from(schema.dramas)
    .where(isNull(schema.dramas.deletedAt))
    .orderBy(desc(schema.dramas.updatedAt))
  let filtered = allRows

  if (status) filtered = filtered.filter(d => d.status === status)
  if (keyword) filtered = filtered.filter(d => d.title.includes(keyword))

  const total = filtered.length
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  // Attach episode/character/scene counts
  const enriched = await Promise.all(items.map(async (drama) => {
    const eps = await db.select().from(schema.episodes)
      .where(and(eq(schema.episodes.dramaId, drama.id), isNull(schema.episodes.deletedAt)))
    const chars = await db.select().from(schema.characters)
      .where(and(eq(schema.characters.dramaId, drama.id), isNull(schema.characters.deletedAt)))
    const scns = await db.select().from(schema.scenes)
      .where(and(eq(schema.scenes.dramaId, drama.id), isNull(schema.scenes.deletedAt)))
    return {
      ...toSnakeCase(drama),
      tags: drama.tags ? JSON.parse(drama.tags) : [],
      total_episodes: eps.length,
      episodes: toSnakeCaseArray(eps),
      characters: toSnakeCaseArray(chars),
      scenes: toSnakeCaseArray(scns),
    }
  }))

  return success(c, {
    items: enriched,
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
  })
})

// POST /dramas - Create drama
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  const res = await db.insert(schema.dramas).values({
    title: body.title,
    description: body.description,
    genre: body.genre,
    style: body.style,
    aspectRatio: body.aspect_ratio || '16:9',
    tags: body.tags ? JSON.stringify(body.tags) : null,
    metadata: body.metadata,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  })

  const [result] = await db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, getInsertId(res)))

  // 不再预建集 — 用户通过「添加集」流程创建（该流程会锁定图片/视频生成配置）
  return created(c, toSnakeCase(result))
})


// GET /dramas/stats — must be before /:id
app.get('/stats', async (c) => {
  const all = await db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt))
  const byStatus = Object.entries(
    all.reduce((acc, d) => {
      acc[d.status || 'draft'] = (acc[d.status || 'draft'] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  ).map(([status, count]) => ({ status, count }))
  return success(c, { total: all.length, by_status: byStatus })
})

// GET /dramas/:id - Get drama detail
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, id))
  if (!drama) return notFound(c, '剧本不存在')

  const eps = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, id), isNull(schema.episodes.deletedAt)))
  const chars = await db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, id), isNull(schema.characters.deletedAt)))
  const scns = await db.select().from(schema.scenes)
    .where(and(eq(schema.scenes.dramaId, id), isNull(schema.scenes.deletedAt)))
  const prps = await db.select().from(schema.props)
    .where(and(eq(schema.props.dramaId, id), isNull(schema.props.deletedAt)))

  return success(c, {
    ...toSnakeCase(drama),
    tags: drama.tags ? JSON.parse(drama.tags) : [],
    episodes: toSnakeCaseArray(eps),
    characters: toSnakeCaseArray(chars),
    scenes: toSnakeCaseArray(scns),
    props: toSnakeCaseArray(prps),
  })
})

// PUT /dramas/:id - Update drama
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.genre !== undefined) updates.genre = body.genre
  if (body.style !== undefined) updates.style = body.style
  if (body.aspect_ratio !== undefined) updates.aspectRatio = body.aspect_ratio
  if (body.status !== undefined) updates.status = body.status
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)
  if (body.metadata !== undefined) updates.metadata = body.metadata
  await db.update(schema.dramas).set(updates).where(eq(schema.dramas.id, id))
  return success(c)
})

// DELETE /dramas/:id?purge_files=1
// 2026-10-10 用户拍板：级联清理（原来只标记剧本身 → 已删剧留下 21 个僵尸资产 + 258 条任务 + 图片视频）
// purge_files=1 时连同该剧所有集的图片/视频/资产图一起删（不可逆，前端弹窗勾选确认）。
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const purge = c.req.query('purge_files') === '1'
  const ts = now()

  // 2026-10-08 删项目连带清卡：先取出该剧全部资产 id，再删对应的 RefMod 卡（Mac 主副本）
  const chars = await db.select({ id: schema.characters.id }).from(schema.characters).where(eq(schema.characters.dramaId, id))
  const scns = await db.select({ id: schema.scenes.id }).from(schema.scenes).where(eq(schema.scenes.dramaId, id))
  const prps = await db.select({ id: schema.props.id }).from(schema.props).where(eq(schema.props.dramaId, id))
  for (const r of chars) {
    removeRefmod('character', r.id)
    removeVoice(r.id) // 2026-10-08 删项目连带清声音
  }
  for (const r of scns) removeRefmod('scene', r.id)
  for (const r of prps) removeRefmod('prop', r.id)

  // ① 收集该剧的全部存储文件（分镜 + 资产图 + 合并视频 + 任务产物）
  const eps = await db.select({ id: schema.episodes.id }).from(schema.episodes).where(eq(schema.episodes.dramaId, id))
  const epIds = eps.map(e => e.id)
  const files: string[] = []
  if (epIds.length) {
    const sbs = await db.select().from(schema.storyboards).where(inArray(schema.storyboards.episodeId, epIds))
    files.push(...collectStoryboardFiles(sbs as unknown as Array<Record<string, unknown>>))
  }
  for (const r of await db.select().from(schema.characters).where(eq(schema.characters.dramaId, id))) if (r.imageUrl) files.push(r.imageUrl)
  for (const r of await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, id))) if (r.imageUrl) files.push(r.imageUrl)
  for (const r of await db.select().from(schema.props).where(eq(schema.props.dramaId, id))) if (r.imageUrl) files.push(r.imageUrl)
  for (const m of await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.dramaId, id))) {
    if (m.mergedUrl) files.push(m.mergedUrl)
    try {
      const arr = JSON.parse(m.scenes || '[]')
      if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string' && x.trim()) files.push(x.trim())
    } catch { /* 非 JSON 忽略 */ }
  }
  for (const t of await db.select().from(schema.sysTask).where(eq(schema.sysTask.dramaId, id))) {
    if (t.localPath) files.push(t.localPath)
    if (t.resultUrl) files.push(t.resultUrl)
  }

  // ② 级联软删：集 / 分镜 / 资产；任务记录物理删（无 deleted_at）
  await db.update(schema.episodes).set({ deletedAt: ts }).where(eq(schema.episodes.dramaId, id))
  if (epIds.length) {
    await db.update(schema.storyboards).set({ deletedAt: ts }).where(inArray(schema.storyboards.episodeId, epIds))
  }
  await db.update(schema.characters).set({ deletedAt: ts }).where(eq(schema.characters.dramaId, id))
  await db.update(schema.scenes).set({ deletedAt: ts }).where(eq(schema.scenes.dramaId, id))
  await db.update(schema.props).set({ deletedAt: ts }).where(eq(schema.props.dramaId, id))
  await db.delete(schema.sysTask).where(eq(schema.sysTask.dramaId, id))

  // ③ 可选删文件（不可逆）
  const removed = purge ? purgeStorageFiles(files) : 0

  await db.update(schema.dramas).set({ deletedAt: ts }).where(eq(schema.dramas.id, id))
  return success(c, { purged: purge, files_total: files.length, files_removed: removed })
})

// PUT /dramas/:id/characters - Save characters
app.put('/:id/characters', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const chars = body.characters || []
  const ts = now()

  for (const char of chars) {
    if (char.id) {
      await db.update(schema.characters).set({ ...char, updatedAt: ts }).where(eq(schema.characters.id, char.id))
    } else {
      await db.insert(schema.characters).values({ ...char, dramaId, createdAt: ts, updatedAt: ts })
    }
  }
  return success(c)
})

// PUT /dramas/:id/episodes - Save episodes
app.put('/:id/episodes', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const episodes = body.episodes || []
  const ts = now()

  for (const ep of episodes) {
    if (ep.id) {
      await db.update(schema.episodes).set({ ...ep, updatedAt: ts }).where(eq(schema.episodes.id, ep.id))
    } else {
      await db.insert(schema.episodes).values({
        ...ep,
        dramaId,
        episodeNumber: ep.episode_number || ep.episodeNumber || 1,
        title: ep.title || '未命名',
        createdAt: ts,
        updatedAt: ts,
      })
    }
  }
  return success(c)
})

export default app
