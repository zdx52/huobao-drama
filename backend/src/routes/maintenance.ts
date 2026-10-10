import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { eq, isNull, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { collectStoryboardFiles, purgeStorageFiles } from '../utils/storage-purge.js'

/**
 * 维护接口（2026-10-10 用户拍板 B：加「清理历史遗留数据」入口）
 *
 * 背景：删集/删剧过去只打删除标记，图片视频全留在磁盘 → 越堆越多。
 * 虽然删集/删剧已改成级联清理（?purge_files=1），但**历史遗留**的孤儿文件
 * 还得有个手动入口扫一遍。
 *
 * 判定口径（保守）：一个文件只要被下列任一「活着的记录」引用，就算在用：
 *   - 资产图（characters/scenes/props.image_url，且资产未删）
 *   - 分镜字段（composed/first/last/video/subtitle/reference_images，且分镜未删）
 *   - 合并视频（video_merges.merged_url / scenes）
 *   - 任务产物（sys_task.local_path/result_url，且所属剧未删）
 * 其余即孤儿。**只扫 static/ 下的文件，绝不越界。**
 */

const app = new Hono()

/** 收集「活着的记录」引用的全部文件名（basename 口径） */
async function collectAliveRefs(): Promise<Set<string>> {
  const refs = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) refs.add(path.basename(v.trim().replace(/\\/g, '/')))
  }
  const addJson = (v: unknown) => {
    if (typeof v !== 'string' || !v.trim()) return
    try {
      const arr = JSON.parse(v)
      if (Array.isArray(arr)) for (const x of arr) add(x)
    } catch { /* 非 JSON 忽略 */ }
  }

  // 资产图（只算未删资产）
  for (const t of ['characters', 'scenes', 'props'] as const) {
    const rows = await db.select().from(schema[t]).where(isNull(schema[t].deletedAt))
    for (const r of rows as Array<Record<string, unknown>>) add(r.imageUrl)
  }

  // 分镜（只算未删分镜）
  const sbs = await db.select().from(schema.storyboards).where(isNull(schema.storyboards.deletedAt))
  for (const f of collectStoryboardFiles(sbs as unknown as Array<Record<string, unknown>>)) add(f)

  // 合并视频
  for (const m of await db.select().from(schema.videoMerges)) {
    add(m.mergedUrl)
    addJson(m.scenes)
  }

  // 任务产物（只算所属剧未删的）
  const aliveDramas = (await db.select({ id: schema.dramas.id }).from(schema.dramas).where(isNull(schema.dramas.deletedAt))).map(r => r.id)
  const aliveEps = (await db.select({ id: schema.episodes.id, dramaId: schema.episodes.dramaId }).from(schema.episodes).where(isNull(schema.episodes.deletedAt)))
  const aliveEpIds = new Set(aliveEps.map(e => e.id))
  const aliveDramaSet = new Set(aliveDramas)
  for (const t of await db.select().from(schema.sysTask)) {
    // 任务归属：剧活着 或 其分镜所属集活着
    const alive = (t.dramaId && aliveDramaSet.has(t.dramaId)) || (t.storyboardId && aliveEpIds.size > 0)
    if (!alive) continue
    add(t.localPath)
    add(t.resultUrl)
  }
  return refs
}

/** 扫描 STORAGE_ROOT 下的孤儿文件 */
async function scanOrphans() {
  const refs = await collectAliveRefs()
  const out: Array<{ rel: string; abs: string; bytes: number }> = []
  const walk = (dir: string) => {
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const abs = path.join(dir, e.name)
      // 跳过非「生成物」目录：debug/ 是诊断日志（还在被写入）、uploads/ 是用户上传的原始素材
      if (e.isDirectory() && (e.name === 'debug' || e.name === 'uploads')) continue
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) {
        if (refs.has(e.name)) continue
        let bytes = 0
        try { bytes = fs.statSync(abs).size } catch { /* ignore */ }
        out.push({ rel: path.relative(STORAGE_ROOT, abs).replace(/\\/g, '/'), abs, bytes })
      }
    }
  }
  walk(STORAGE_ROOT)
  return out
}

// GET /maintenance/orphans — 扫描孤儿文件（只读，不删）
app.get('/orphans', async (c) => {
  const items = await scanOrphans()
  const bytes = items.reduce((s, x) => s + x.bytes, 0)
  // 只返回汇总 + 前 200 条明细，避免响应过大
  return success(c, {
    count: items.length,
    bytes,
    sample: items.slice(0, 200).map(x => ({ path: x.rel, bytes: x.bytes })),
  })
})

// POST /maintenance/orphans/purge — 删除孤儿文件（不可逆，前端二次确认）
app.post('/orphans/purge', async (c) => {
  const items = await scanOrphans()
  const removed = purgeStorageFiles(items.map(x => x.abs))
  return success(c, { removed, scanned: items.length })
})

export default app
