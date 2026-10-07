/**
 * RefMod 卡服务（2026-10-08）
 *  - 「生成卡」：把资产（角色/场景/道具）的定妆图发给 4080 中转抽卡，卡回传后落盘到 **Mac 主副本** `<data>/refmods/`
 *  - 卡名规则：`refmod_<kind>-<id>_v1.safetensors`（kind = character | scene | prop），与前端下发的资产身份一一对应
 *  - 覆盖策略：同一资产重复抽卡 → **覆盖同一张**（用户 2026-10-08 拍板）
 *  - 卡是可选的：没有卡时生成照旧走老路（前端负责提示"先抽卡"）
 */
import path from 'path'
import fs from 'fs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { getAbsolutePath } from '../utils/storage.js'
import { getActiveConfig } from './ai.js'
import { logTaskError, logTaskSuccess } from '../utils/task-logger.js'

export type RefmodKind = 'character' | 'scene' | 'prop'

export function isRefmodKind(v: any): v is RefmodKind {
  return v === 'character' || v === 'scene' || v === 'prop'
}

/** 卡名（不含扩展名）：refmod_character-15_v1 */
export function refmodCardName(kind: RefmodKind, id: number): string {
  return `refmod_${kind}-${Number(id)}_v1`
}

/** 卡在 Mac 上的绝对路径（主副本） */
export function refmodCardPath(name: string): string {
  return path.join(STORAGE_ROOT, '..', 'refmods', `${name}.safetensors`)
}

/** 卡状态（UI 显示"是否已生成卡"） */
export function refmodStatus(kind: RefmodKind, id: number): { name: string; ready: boolean; size: number } {
  const name = refmodCardName(kind, id)
  try {
    const st = fs.statSync(refmodCardPath(name))
    return { name, ready: st.isFile() && st.size > 1024, size: st.size }
  } catch {
    return { name, ready: false, size: 0 }
  }
}

/**
 * 抽卡：读资产定妆图 → 4080 中转 `/v2/refmod/extract` → 卡回传 → 落盘（覆盖）
 * 说明：抽卡不训练、只需 H3 视频 VAE，4080 侧分钟级完成。
 */
export async function extractRefmod(kind: RefmodKind, id: number): Promise<{ name: string; size: number }> {
  const cardName = refmodCardName(kind, id)

  // 1) 资产定妆图（按 kind 分支查表，避免 drizzle 联合类型问题）
  let row: any
  if (kind === 'character') {
    row = (await db.select().from(schema.characters).where(eq(schema.characters.id, Number(id))))[0]
  } else if (kind === 'scene') {
    row = (await db.select().from(schema.scenes).where(eq(schema.scenes.id, Number(id))))[0]
  } else {
    row = (await db.select().from(schema.props).where(eq(schema.props.id, Number(id))))[0]
  }
  if (!row) throw new Error(`找不到 ${kind} id=${id}`)
  const imageUrl = String(row.imageUrl || '').trim()
  if (!imageUrl) throw new Error('该资产还没有定妆图，请先生成定妆图再抽卡')
  const abs = getAbsolutePath(imageUrl)
  const buf = await fs.promises.readFile(abs)
  const mime = path.extname(abs).toLowerCase() === '.jpg' || path.extname(abs).toLowerCase() === '.jpeg' ? 'jpeg' : 'png'
  const dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`

  // 2) 4080 中转地址（取现役视频配置的 baseUrl）
  const cfg = await getActiveConfig('video')
  const base = String(cfg?.baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('没有可用的视频服务配置，拿不到 4080 中转地址')

  // 3) 抽卡（角色用 identity；场景/道具用 style）
  const resp = await fetch(`${base}/v2/refmod/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: cardName,
      image: dataUrl,
      concept_type: kind === 'character' ? 'identity' : 'style',
    }),
    signal: AbortSignal.timeout(900_000),
  })
  if (!resp.ok) {
    throw new Error(`抽卡失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  const out: any = await resp.json()
  const cardB64 = String(out?.data || '')
  if (!cardB64) throw new Error('抽卡返回为空')
  const card = Buffer.from(cardB64, 'base64')
  if (card.length < 1024) throw new Error(`抽卡结果异常（只有 ${card.length} 字节）`)

  // 4) 落盘 Mac 主副本（覆盖同一张）
  const outPath = refmodCardPath(cardName)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, card)
  logTaskSuccess('Refmod', 'extract', { kind, id, name: cardName, size: card.length })
  return { name: cardName, size: card.length }
}

/** 删除资产时同步清卡（批次4：删除联动用） */
export function removeRefmod(kind: RefmodKind, id: number): boolean {
  try {
    fs.unlinkSync(refmodCardPath(refmodCardName(kind, id)))
    return true
  } catch (err: any) {
    if (err?.code !== 'ENOENT') logTaskError('Refmod', 'remove', { kind, id, error: err?.message })
    return false
  }
}
