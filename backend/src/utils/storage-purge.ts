import fs from 'node:fs'
import path from 'node:path'
import { STORAGE_ROOT } from './paths.js'

/**
 * 存储文件清理工具（2026-10-10）
 *
 * 背景：删集/删剧原本只给「集/剧」打删除标记，分镜、关联、生成的图片与视频全都不动，
 * 结果每次删除都在库里留下一堆不可达的孤儿（实测：6 个已删集留下 127 条孤儿分镜 +
 * 1.5G 图片/视频；已删剧 drama 2/3 留下 21 个僵尸资产 + 258 条任务记录）。
 *
 * 本模块提供两件事：
 *   1. collectStoryboardFiles() —— 从一个集的全部分镜里收集其引用的所有存储文件
 *   2. purgeStorageFiles()      —— 按开关删除这些文件（默认调用方传 purge=false 就只收集不删）
 *
 * 删除是不可逆的：调用方必须先拿到用户确认（前端弹窗里的勾选框）。
 */

/** 分镜表里所有可能指向存储文件的字段 */
const STORYBOARD_FILE_FIELDS = [
  'composedImage',
  'firstFrameImage',
  'lastFrameImage',
  'videoUrl',
  'subtitleUrl',
  'composedVideoUrl',
] as const

/** 从一批分镜行里收集全部文件路径（去重） */
export function collectStoryboardFiles(rows: Array<Record<string, unknown>>): string[] {
  const out = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.add(v.trim())
  }
  for (const row of rows || []) {
    for (const f of STORYBOARD_FILE_FIELDS) add(row[f])
    // reference_images 存的是 JSON 数组
    const refs = row.referenceImages
    if (typeof refs === 'string' && refs.trim()) {
      try {
        const arr = JSON.parse(refs)
        if (Array.isArray(arr)) for (const x of arr) add(x)
      } catch {
        /* 非 JSON 就忽略 */
      }
    }
  }
  return [...out]
}

/** 把库里的相对路径（static/xxx 或 /static/xxx）解析成磁盘绝对路径 */
function resolveStoragePath(p: string): string | null {
  if (!p) return null
  if (path.isAbsolute(p) && fs.existsSync(p)) return p
  const rel = p.replace(/^\/+/, '').replace(/^static\//, '')
  const abs = path.join(STORAGE_ROOT, rel)
  return abs
}

/**
 * 删除存储文件。返回实际删掉的数量。
 * 只删 STORAGE_ROOT 下的文件，绝不越界；单个失败不影响其它。
 */
export function purgeStorageFiles(files: string[]): number {
  let removed = 0
  const root = path.resolve(STORAGE_ROOT)
  for (const f of new Set(files || [])) {
    try {
      const abs = resolveStoragePath(f)
      if (!abs) continue
      const resolved = path.resolve(abs)
      // 安全护栏：只允许删 STORAGE_ROOT 内
      if (!resolved.startsWith(root + path.sep)) continue
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        fs.unlinkSync(resolved)
        removed++
      }
    } catch {
      /* 单个文件失败不中断 */
    }
  }
  return removed
}

/** 只统计不删（用于前端预检/日志） */
export function countExistingFiles(files: string[]): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const f of new Set(files || [])) {
    try {
      const abs = resolveStoragePath(f)
      if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        count++
        bytes += fs.statSync(abs).size
      }
    } catch {
      /* ignore */
    }
  }
  return { count, bytes }
}
