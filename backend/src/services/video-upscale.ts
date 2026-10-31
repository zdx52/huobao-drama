/**
 * 成片超分 — 等比例放大到短边 1080（lanczos + 轻锐化）
 *
 * 口径：原始什么比例就用什么比例。
 * 竖屏源 768×1344 → 1080×1890；横屏源 1344×768 → 1890×1080。
 * 不裁切、不补黑边，比例与原片完全一致。
 *
 * 不用 ffmpeg 的 scale=-2:1080：那是锁高度，横竖不能通用
 * （竖屏源会被缩到 1080 宽，反而变小）。
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'

export interface VideoDim {
  w: number
  h: number
  duration: number
}

/** 探测视频画面尺寸与时长 */
export function probeVideo(filePath: string): Promise<VideoDim> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
      if (err) return reject(new Error(`读不到视频信息：${err.message}`))
      const v = (metadata?.streams || []).find((s: any) => s.codec_type === 'video')
      resolve({
        w: Number(v?.width) || 0,
        h: Number(v?.height) || 0,
        duration: Number(metadata?.format?.duration) || 0,
      })
    })
  })
}

/**
 * 算等比例放大后的目标尺寸：短边放到 1080，长边按原比例推。
 * 宽高都必须为偶数（h264 yuv420p 要求）。
 */
export function targetSize(w: number, h: number, shortSide = 1080): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  if (w >= h) {
    // 横屏（含正方形）：高锁 1080
    const outH = shortSide
    const outW = even((w / h) * outH)
    return { w: outW, h: even(outH) }
  }
  // 竖屏：宽锁 1080
  const outW = shortSide
  const outH = even((h / w) * outW)
  return { w: even(outW), h: outH }
}

/**
 * 超分一条成片，产出新文件。
 * outRelDir：存储用的相对目录（短剧 'static/merged'，MV 'mv/pN'），
 *             各模块成片路径前缀口径不同，由调用方按本模块惯例传。
 * 返回输出文件的相对路径与新尺寸。
 */
export async function upscaleVideo(
  srcRel: string,
  outRelDir: string,
  outNamePrefix = '',
): Promise<{ outRel: string; from: VideoDim; to: { w: number; h: number } }> {
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法超分（删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN 指向有效的 ffmpeg 可执行文件后重启服务）')
  }

  const srcAbs = getAbsolutePath(srcRel)
  if (!fs.existsSync(srcAbs)) throw new Error('成片文件已丢失，无法超分')

  const dim = await probeVideo(srcAbs)
  if (!dim.w || !dim.h) throw new Error('读不到成片画面尺寸')

  const to = targetSize(dim.w, dim.h)
  // 已经是目标尺寸（短边 ≥1080）就不必再放大
  if (Math.min(dim.w, dim.h) >= 1080) {
    throw new Error(`这条已经是 ${dim.w}×${dim.h}，短边 ≥1080，不用再超分`)
  }

  const outDir = path.join(STORAGE_ROOT, outRelDir.replace(/^static\//, ''))
  fs.mkdirSync(outDir, { recursive: true })
  const outName = `${outNamePrefix}${uuid()}.mp4`
  const outAbs = path.join(outDir, outName)

  await new Promise<void>((resolve, reject) => {
    ffmpeg(srcAbs)
      // lanczos 比默认双线性锐；unsharp 补一点边缘（放大后不明显）
      .outputOptions([
        // 锐化幅度 0.5 → 0.8：lanczos 放大后原本偏软，0.5 几乎看不出来；
        // 0.8 是「看得出来但不炸」的档（色度通道保持 0 锐化，避免彩色镶边）。
        '-vf', `scale=${to.w}:${to.h}:flags=lanczos,unsharp=5:5:0.8:5:5:0`,
        '-c:v', 'libx264',
        '-crf', '18',
        '-preset', 'medium',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
      ])
      .on('end', () => resolve())
      .on('error', (e: Error) => reject(new Error(`超分失败：${e.message}`)))
      .save(outAbs)
  })

  const outRel = `${outRelDir}/${outName}`
  // 成片海报帧（导出页封面用；失败不阻断）
  await extractVideoPoster(outRel)
  return { outRel, from: dim, to }
}
