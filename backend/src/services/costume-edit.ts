/**
 * 换装定妆板生成（2026-10-14）
 *
 * 把「基准角色的定妆板」当参考图，走 服务器中转的**图像编辑**端点
 * （`POST /v1/images/edits`，模型 `qwen-image-2.1-edit`）—— 只换衣服、脸一点不动，四格必须是同一套。
 * 实测：苏清禾原板 → 正装，52 秒出图，脸一致（用户 2026-10-14 验收）。
 *
 * 为什么**不**复用 generation.ts 的图片任务通道（两条都是实测坑）：
 *   ① 那条路把参考图压到 768px（`readImageAsCompressedDataUrl` maxWidth/Height 768, quality 68）——
 *      1920×1056 的四格板每格只剩 ~192px 宽，脸与文字全糊，换装编辑的输入质量直接崩；
 *   ② OpenAI 适配器发的是 `image[]` 字段，而中转 `/images/edits` 只认 `image`（实测会 400「缺参考图」）。
 * 所以这里直连中转、发全分辨率原图（与 `services/refmod.ts` 抽卡同一种做法）。
 */
import { getActiveConfig } from './ai.js'
import { parseDataUrl, readImageAsDataUrl, saveBase64Image } from '../utils/storage.js'

/** 换装编辑模型（中转 `/v1/models` 里的图像编辑档） */
export const COSTUME_EDIT_MODEL = 'qwen-image-2.1-edit'

/**
 * 换装编辑指令。要点：
 *  - 四格**必须是同一套**衣服（否则板上两套衣服 → 抽卡时卡里混两套 → 成片服装乱飘）；
 *  - 第 1 格（最左脸部特写）**只换衣服、脸一点不动**（脸型/五官/发型/肤色/表情/位置大小）；
 *  - 第 2/3/4 格保持原来的「无头」处理；
 *  - 布局/白底/画风/线条/尺寸不变（定妆板的硬规格）。
 */
export function costumeEditPrompt(label: string, desc?: string): string {
  const outfit = String(desc || '').trim() || String(label || '').trim()
  return [
    `把这张角色参考板里人物的服装全部换成：${outfit}。`,
    '四格必须是同一套衣服：颜色、款式、纽扣、口袋、面料质感完全一致。',
    '第1格（最左，脸部与上半身特写）只换衣服：领口、肩部、胸口部分换成这套服装；脸部必须完全保持原样——脸型、五官、眼睛、眉毛、鼻子、嘴唇、发型、发饰、肤色、表情、头部位置与大小一点都不要改。',
    '第2、3、4格的全身服装同样换成这套服装，并保持原来的处理方式（不出现头、脸、五官、头发、耳朵）。',
    '去掉原来那套服装与它的配饰，画面里不再出现旧服装的元素。',
    '四格布局、白色背景、画风、线条粗细、画面尺寸与构图一律保持不变。',
  ].join('\n')
}

export interface CostumeBoardResult {
  /** 落盘后的相对路径（static/images/xxx.png） */
  relativePath: string
  bytes: number
}

/**
 * 生成换装定妆板。
 * @param referenceImage 参考图（基准角色定妆板）：`static/images/x.png` 相对路径、绝对路径或 data URL
 * @param prompt 编辑指令（用 `costumeEditPrompt()` 拼）
 * @param model 覆盖模型（默认 COSTUME_EDIT_MODEL）
 */
export async function generateCostumeBoard(opts: {
  referenceImage: string
  prompt: string
  model?: string
}): Promise<CostumeBoardResult> {
  const cfg = await getActiveConfig('image')
  // ⚠️ 配置里的 baseUrl 常常带 OpenAI 风格的 `/v1`（图片/文本服务都这么存），而中转的编辑端点是
  //    `/v1/images/edits` —— 不去掉尾部版本号就会拼成 `/v1/v1/images/edits`，中转直接 404「未知路径」
  //    （2026-10-15 实测踩：换装图生成失败 HTTP 404 {"error":"未知路径"}）
  const base = String(cfg?.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/(v1|v2)$/i, '')
  if (!base) throw new Error('没有可用的图片服务配置，拿不到中转地址')

  const raw = String(opts.referenceImage || '').trim()
  if (!raw) throw new Error('缺参考图')
  // 参考图**不做压缩**：定妆板四格是身份与服装的唯一来源，压到 768 会糊
  const dataUrl = raw.startsWith('data:')
    ? raw
    : readImageAsDataUrl(raw.replace(/^\/+/, ''))
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) throw new Error('参考图无法解析为 data URL')

  const form = new FormData()
  form.append('model', opts.model || COSTUME_EDIT_MODEL)
  form.append('prompt', opts.prompt)
  form.append('n', '1')
  // 🔴 字段名必须是 `image`（不是 `image[]`）—— 中转 /images/edits 只按这个字段名收集参考图
  form.append('image', new Blob([Buffer.from(parsed.data, 'base64')], { type: parsed.mimeType }), 'board.png')

  const resp = await fetch(`${base}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg?.apiKey || 'not-required'}` },
    body: form,
    signal: AbortSignal.timeout(600_000),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`换装图生成失败 HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }
  const out: any = await resp.json().catch(() => null)
  const b64 = String(out?.data?.[0]?.b64_json || '')
  if (!b64) throw new Error('换装图返回为空')
  const buf = Buffer.from(b64, 'base64')
  if (buf.length < 1024) throw new Error(`换装图异常（只有 ${buf.length} 字节）`)
  const relativePath = await saveBase64Image(b64, 'image/png', 'images')
  return { relativePath, bytes: buf.length }
}
