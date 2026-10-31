/**
 * 音乐 MV 路由（2026-10-18 新增，独立模块）
 *
 * 与短剧链路彻底隔离：不写 storyboards / characters / scenes，只用自己的三张表
 * （mv_projects / mv_assets / mv_shots）+ 服务器 shim 的 /v2/mv/* 接口。
 * 生成全部走 App 现成的三条通道（不写死地址和模型）：
 *   文本 = getTextConfig()｜图片 = generateImage()｜视频 = generateVideo(model=minimax-h3-mv)
 *
 * 流程（与短剧同构）：
 *   建项目（歌 + 风格 + 分镜提示词）→ 从分镜提示词提取人物/场景（mv_assets）
 *   → 逐个出图 → 逐个抽卡 → 粗分镜（与歌等长）→ 详细分镜（景别/机位/歌词）
 *   → 编译六段式提示词 → 逐段出片 → 无音轨拼接 + 原曲整段混入
 *
 * 服务器侧只用 shim 的 MV 专属接口（地址取自「视频通道」配置）：
 *   POST /v2/mv/audio        原曲 32k wav 落盘（只推一次）
 *   POST /v2/mv/plan         按能量/句界切段（H3 帧网格 5.167~14.375s，命中上限）
 *   POST /v2/mv/prompts      六段式提示词编译 + 硬校验
 *   POST /v2/refmod/extract  资产抽卡（卡保证人物和场景锁住；声音卡不接，音轨就是原曲）
 */
import { Hono } from 'hono'
import { extractVideoPoster } from '../utils/video-poster.js'
import { eq, desc, and, or, isNull, inArray } from 'drizzle-orm'
import fs from 'fs'
import { execFile } from 'child_process'
import path from 'path'
import { db, schema, getInsertId } from '../db/index.js'
import { generateImage, generateVideo, imageSizeForAspect } from '../services/generation.js'
import { generateCostumeBoard, costumeEditPrompt } from '../services/costume-edit.js'
import { getTextConfig, getTextProviderBaseUrl, getActiveConfig, getConfigById } from '../services/ai.js'
import { getStyleSpecByValue } from '../services/style-preset.js'
import { generateMvShotPrompt } from '../services/mv-shot-prompt.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { loadAgentPromptFile } from '../agents/prompts.js'
import { readSkillFile } from '../agents/skills.js'
import { extractChatText } from '../services/asset-describe-prompt.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT, DATA_ROOT } from '../utils/paths.js'
import { success, created, badRequest, notFound, serverError, now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger'
import { buildAss, parseLrc } from '../services/mv-subtitles'
import { upscaleVideo } from '../services/video-upscale.js'
import os from 'os'

/** ffmpeg filtergraph 里的路径转义：反斜杠换正斜杠，转义冒号和单引号，空格用 \ 转（避免参数被截断） */
function assFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/ /g, '\\ ')
}
import { ffmpeg, ffmpegPath, ffprobePath } from '../utils/ffmpeg.js'
// 2026-10-19：MV 提示词完全走自己的链路（askText + 只读技能文本），**不引短剧的任何服务/Agent**

// 服务器模板 mv_shot.api.json 节点14 的音频窗口 warmup_seconds（那边改了这里要同步）
const MV_WARMUP_SECONDS = 0.5

/** 音频窗口带 warmup 前导 → 成片开头多 warmup、总长按帧网格取整变长（192 帧 vs 声明 175）。
 *  按「跳过 warmup + 只取声明帧数」裁一遍：本段画面 0 秒才对齐它在原曲里的起点，
 *  否则拼接时画面比音轨长，口型错位（实测分镜2/3 各多 17 帧 = 0.708s）。 */
async function trimToSegment(rel: string, shot: any, songRel: string): Promise<string> {
  const want = Number(shot?.frames) || 0
  const sec = Number(shot?.seconds) || 0
  const start = Number(shot?.startSeconds) || 0
  if (!rel || !want || !sec) return rel
  const abs = getAbsolutePath(rel)
  const got = await new Promise<number>((res) =>
    ffmpeg.ffprobe(abs, (e: any, m: any) =>
      res(e ? 0 : Number((m?.streams || []).find((x: any) => x.codec_type === 'video')?.nb_frames) || 0)))
  if (!got || got <= want) return rel
  const tmpV = abs.replace(/\.mp4$/i, '.v.mp4')
  const tmpA = abs.replace(/\.mp4$/i, '.a.m4a')
  const tmpO = abs.replace(/\.mp4$/i, '.out.mp4')
  const run = (p: string, inOpts: string[], outOpts: string[], out: string) => new Promise<void>((resolve, reject) => {
    ffmpeg(p).inputOptions(inOpts).outputOptions(outOpts)
      .on('end', () => resolve()).on('error', (e: Error) => reject(e)).save(out)
  })
  try {
    // 步1：跳过 warmup 前导，只取本段声明帧数
    await run(abs, [`-ss ${MV_WARMUP_SECONDS}`],
      ['-frames:v', String(want), '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-y'], tmpV)
    // 步2：音轨从原曲按本段起点切窗（和拼接口径一致，也避免原文件没音轨时丢声）
    if (songRel) {
      await run(getAbsolutePath(songRel), [`-ss ${start}`],
        ['-t', String(sec), '-c:a', 'aac', '-b:a', '192k', '-y'], tmpA)
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tmpV).input(tmpA)
          .outputOptions(['-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', '-y'])
          .on('end', () => resolve()).on('error', (e: Error) => reject(e)).save(tmpO)
      })
      fs.renameSync(tmpO, abs)
      fs.rmSync(tmpV, { force: true }); fs.rmSync(tmpA, { force: true })
    } else {
      fs.renameSync(tmpV, abs)
    }
  } catch (err: any) {
    logTaskError('MV', 'trim', { rel, error: err?.message })
    for (const f of [tmpV, tmpA, tmpO]) { try { fs.rmSync(f, { force: true }) } catch { /* 忽略 */ } }
    return rel
  }
  return rel
}


/** 舞蹈 MV 续段：中转返回的是 latent 拼接后的整片（如 396 帧），
 *  这里只取最后 want 帧（= 本段内容），保留音轨。首段 got≈want 时直接返回。 */
/** 用「上一段的尾部音频」在整片音频里反解本段起点（能量包络互相关，5ms 精度）。
 *  返回本段在整片里的起始秒；解不出或相关太低返回 -1。
 *  为什么必须实测：整片里前段占多少帧取决于中转的 CTX 预热和 17k+5 取整，
 *  实测段2 占 170 帧、段3 占 182 帧 —— 同一个公式两种结果。猜错就是整段晚 0.5 秒（音乐错位）。*/
async function danceSeamStart(wholeAbs: string, prevAbs: string, guessSec = -1): Promise<number> {
  const SR = 32000, HOP = 160, TAIL = 0.4        // 5ms 一格，模板取上一段最后 0.4 秒
  // 用 execFile 而不是 fluent 的 .pipe()：pipe 流在多段并发解码时会抛
  // 'Output stream closed'（自检里直接崩进程，destroy 也压不住）。
  const run = (args: string[]) => new Promise<Buffer>((res) => {
    try {
      execFile(ffmpegPath || 'ffmpeg', args, { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' as any },
        (e: any, out: any) => res(!e && out ? (out as Buffer) : Buffer.alloc(0)))
    } catch { res(Buffer.alloc(0)) }
  })
  const pcm = (f: string) => run(['-v', 'error', '-i', f, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'])
  const env = (b: Buffer) => {
    const n = Math.floor(b.length / 2 / HOP), r = new Float32Array(Math.max(0, n))
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let j = 0; j < HOP; j++) { const k = (i * HOP + j) * 2; if (k + 1 < b.length) { const v = b.readInt16LE(k) / 32768; s += v * v } }
      r[i] = Math.sqrt(s / HOP)
    }
    return r
  }
  const [w, p] = await Promise.all([pcm(wholeAbs), pcm(prevAbs)])
  const we = env(w), pe = env(p)
  const tn = Math.round(TAIL * SR / HOP)
  if (pe.length < tn * 2 || we.length < tn * 3) return -1
  const tpl = pe.subarray(pe.length - tn)
  let tm = 0; for (const v of tpl) tm += v; tm /= tn
  let tv = 0; for (const v of tpl) tv += (v - tm) ** 2
  if (tv < 1e-9) return -1                       // 上一段尾巴是静音，没法定位
  let best = -2, bestAt = -1
  // 只在「公式值 ±1 秒」内搜：舞蹈音乐段落相似度高，全片搜会在别处找到假峰
  // （实测负例：拿不相干的段3 当上一段，全片搜返回 8.37s 且相关度 > 0.5）。
  const from = guessSec > 0 ? Math.max(0, Math.round((guessSec - 1) * SR / HOP)) : 0
  const to = guessSec > 0 ? Math.min(we.length - tn, Math.round((guessSec + 1) * SR / HOP)) : we.length - tn
  for (let i = from; i <= to; i++) {
    let m = 0; for (let j = 0; j < tn; j++) m += we[i + j]; m /= tn
    let num = 0, dv = 0
    for (let j = 0; j < tn; j++) { const a = we[i + j] - m, b = tpl[j] - tm; num += a * b; dv += a * a }
    if (dv < 1e-9) continue
    const c = num / Math.sqrt(dv * tv)
    if (c > best) { best = c; bestAt = i }
  }
  // 阈值 0.9：真匹配实测 0.9999（正例1/正例2 都是），不相干素材最高只有 0.69（负例），
  // 中间没有过渡值。达不到就退回公式，宁可保守也不乱跳。
  if (bestAt < 0 || best < 0.9) return -1
  return (bestAt + tn) * HOP / SR                 // 模板尾 = 上一段结束 = 本段起点
}

/** 用「上一段尾部的画面运动量」在整片里反解本段的**画面**起点（逐帧精度）。
 *  为什么不能用音频值：中转整片里音画本身就差 4 帧。实测 p11 段3 ——
 *  段2 的画面结束在整片第 162 帧，音频结束在第 158 帧（两者相关度都是 1.000）。
 *  只用音频反解（158）→ 画面多带前一段 4 帧 → 接缝处动作重放一拍（用户说的「多了一拍」）。
 *  返回本段画面起点（秒）；解不出返回 -1。 */
async function danceMotionSeam(wholeAbs: string, prevAbs: string, guessSec = -1): Promise<number> {
  const W = 160, H = 288, FPS = 24
  const motion = (f: string) => new Promise<Float32Array>((res) => {
    execFile(ffmpegPath || 'ffmpeg',
      ['-v', 'error', '-i', f, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'],
      { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' as any },
      (e: any, out: any) => {
        if (e || !out) return res(new Float32Array(0))
        const a = out as Buffer, sz = W * H
        const n = Math.floor(a.length / sz)
        const m = new Float32Array(Math.max(0, n - 1))
        for (let i = 1; i < n; i++) {
          const cur = a.subarray(i * sz, (i + 1) * sz), prev = a.subarray((i - 1) * sz, i * sz)
          let s = 0
          for (let j = 0; j < sz; j++) s += Math.abs(cur[j] - prev[j])
          m[i - 1] = s / sz
        }
        res(m)
      })
  })
  const [mw, mp] = await Promise.all([motion(wholeAbs), motion(prevAbs)])
  const TPL = 24                                    // 取上一段最后 1 秒的运动量当模板
  if (mp.length < TPL * 2 || mw.length < TPL * 3) return -1
  const tpl = mp.subarray(mp.length - TPL)
  let tm = 0; for (const v of tpl) tm += v; tm /= TPL
  let tv = 0; for (const v of tpl) tv += (v - tm) ** 2
  if (tv < 1e-6) return -1                          // 上一段最后 1 秒几乎不动，没法定位
  // 窗口 ±1.5 秒（±36 帧）：画面和音频只差几帧，但要对齐「差的那几帧」得留够余量；
  // 实测 ±1 秒时正确点会落在窗口下界之外 1 帧（合成用例 i=47 vs 窗口 from=48 → 解不出）。
  const from = guessSec > 0 ? Math.max(0, Math.round((guessSec - 1.5) * FPS)) : 0
  const to = guessSec > 0 ? Math.min(mw.length - TPL, Math.round((guessSec + 1.5) * FPS)) : mw.length - TPL
  let best = -2, bestAt = -1
  for (let i = from; i <= to; i++) {
    let m = 0; for (let j = 0; j < TPL; j++) m += mw[i + j]; m /= TPL
    let num = 0, dv = 0
    for (let j = 0; j < TPL; j++) { const a = mw[i + j] - m, b = tpl[j] - tm; num += a * b; dv += a * a }
    if (dv < 1e-6) continue
    const c = num / Math.sqrt(dv * tv)
    if (c > best) { best = c; bestAt = i }
  }
  if (bestAt < 0 || best < 0.9) return -1
  // 模板尾 = 上一段画面结束 = 本段画面起点
  return (bestAt + TPL) / FPS
}

/** 数视频真帧数（-count_frames；mp4 的 nb_frames 会少报 5 帧，不能信） */
function countVideoFrames(abs: string): Promise<number> {
  return new Promise<number>((res) => {
    execFile(ffprobePath || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', abs], (e: any, out: any) => {
      if (e) return res(0)
      res(Number(String(out).trim()) || 0)
    })
  })
}

async function trimDanceSegmentTail(rel: string, shot: any, prevFrames: number, prevAbs?: string, genFrames = 0): Promise<string> {
  if (!rel) return rel
  const abs = getAbsolutePath(rel)
  // 🔴 必须用 `-count_frames` 真数：mp4 的 nb_frames 实测会**少报**（本机少报 5 帧），
  // 于是 skip=got-target 少裁 5 帧 → 段2 开头把段1 结尾的 5 帧原样重复一遍（用户看到"跳一下/卡一下"）。
  // 🔴 2026-10-27：ffprobe 失败时原来直接 `return rel` —— 等于把中转整片（345 帧）当成本段交出去，
  //    成片里塞进前面所有段、音轨整段错位。实测段3 就是这样（345 帧、无 .seg.wav、无日志）。
  //    改成三级降级：execFile 失败 → fluent ffprobe（用的同一个 ffprobePath）→ 再失败按 target 帧数走。
  const probeFrames = (f: string) => new Promise<number>((res) => {
    execFile(ffprobePath || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f],
      (e: any, out: any) => {
        if (e) console.log('[trim-probe-err]', f, '|', String(e).slice(0, 300))
        res(e ? 0 : Number(String(out).trim()) || 0)
      })
  })
  let got = await probeFrames(abs)
  if (!got) {
    got = await new Promise<number>((res) => {
      ffmpeg.ffprobe(abs, (e: any, m: any) => {
        if (e) return res(0)
        const st = (m?.streams || []).find((x: any) => x.codec_type === 'video')
        res(Number(st?.nb_frames) || Math.round(Number(st?.duration) * 24) || 0)
      })
    })
    if (got) console.log('[trim-probe-fallback] fluent ffprobe 数到', got, '帧:', path.basename(abs))
  }
  const targetHint = Math.max(2, Math.round(Number(shot.frames) || 0) || 0)
  if (!got) {
    if (!targetHint) return rel
    // 数不出帧数但知道本段该多长：按 target 从末尾取，宁可少一点也别把整片交出去
    got = targetHint + Math.max(0, prevFrames)
    console.log('[trim-probe-missing]', path.basename(abs), '用 target+prevFrames 推算 got =', got)
  }
  // 🔴 首段（前面没有段）：视频不用裁，但要做两件事——
  // ① 导一份 PCM 音轨（.seg.wav）给拼接用；
  // ② 把 mp4 音轨统一转成 aac。中转可能给 alac（无损），而 Electron 的 <video> 解不了 ALAC
  //    → 用户看到画面但完全没声音（实测 1319 段1 就是这样）。视频流 copy，不重编码，很快。
  if (prevFrames <= 2) {
    // 🔴 段2+ 拿不到上一段帧数 = 数据链断了，宁可失败报错也不交付没裁的整片。
    //   2026-10-30 教训：这条判定原来没区分「第一段」—— 段1 天然 prevFrames=0，
    //   于是段1 下载完就抛异常，任务记为 completed 但 mv_shots 卡在 processing
    //   （用户看到的「段1 跑完了但界面不动」）。段1 必须走下面的原逻辑。
    if (Number(shot?.shotNumber) > 1) {
      throw new Error(
        `段${Number(shot?.shotNumber) || 0} 裁切缺少上一段帧数（prevFrames=${prevFrames}，上一段 videoUrl 为空或读不出帧数）`
        + ` —— 不交付未裁切的整片。先确认上一段已生成完成，再重跑本段。`)
    }
    // 首段（前面没有段）：视频不用裁，但要做两件事——
    // ① 导一份 PCM 音轨（.seg.wav）给拼接用；
    // ② 把 mp4 音轨统一转成 aac。中转可能给 alac（无损），而 Electron 的 <video> 解不了 ALAC
    //    → 用户看到画面但完全没声音（实测 1319 段1 就是这样）。视频流 copy，不重编码，很快。
    const wavOut = abs.replace(/\.mp4$/i, '.seg.wav')
    // 中转落的是 PCM（mov 容器，音频比视频多 0.5s），本段需要的采样数源里直接有。
    // 别再回退：aac 每 1024 采样一块，158 帧 = 210666.7 采样编不满 → 段音频短 747 个采样，接缝处 23ms 空洞；
    // apad 补静音是洞，atempo 拉伸是改音乐。
    const samples = Math.round((got / 24) * 32000)
    try {
      await new Promise<void>((resolve) => {
        ffmpeg(abs).outputOptions(['-vn', '-t', (samples / 32000).toFixed(6),
          '-c:a', 'pcm_s16le', '-ar', '32000', '-ac', '1', '-y'])
          .on('end', () => resolve()).on('error', () => resolve()).save(wavOut)
      })
    } catch { /* 拼接会退回 mp4 音轨 */ }
    try {
      const tmpA = abs.replace(/\.mp4$/i, '.aac.mp4')
      await new Promise<void>((resolve, reject) => {
        ffmpeg(abs).outputOptions(['-map', '0:v', '-map', '0:a?', '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', '-y'])
          .on('end', () => resolve()).on('error', (e: Error) => reject(e)).save(tmpA)
      })
      fs.renameSync(tmpA, abs)
    } catch { /* 转码失败就保留原文件 */ }
    return rel
  }
  // 取最后「本段目标帧数」帧：中转返回的整片 = 前面各段 + 本段（含提前起跑的前置帧），
  // 前置帧数由中转的 CTX 决定（模板里的预热帧），不能拿 it 反推 want——
  // 以前用 got-prevFrames 算，CTX 一放大就会把预热帧留在片子里（多出 1 秒重复内容）。
  // 🔴 段2 在整片里的起点就是「前面各段总帧数」：concat 已经把重叠帧吃掉，
  // 从这里往后就是本段自己的内容。绝不能拿 got-target 反推 —— 实测整片实际只有
  // 396 帧（段2 想要 192+5 重叠，但 H3 帧数只认 17k+5：192 的下一个是 209，
  // 209 又会超出源片长度被降档回 192），于是段2 的干净内容只有 187 帧，
  // 用 got-192 算 skip 会少跳 5 帧 → 段2 开头把段1 的最后 5 帧原样重放一遍（用户看到"跳一下/卡一下"）。
  // 宁可再生段短 5 帧（0.2 秒），也不要重复帧。
  // 2026-10-25 修：原来 skip=prevFrames（前面各段 shot.frames 之和）。只要中转把 gen_frames 向上取到
  // 17k+5（209→226）或按源片长度降档（226→209），整片里"前面各段占的帧数"就不等于 frames 之和 ——
  // 实测 p11 段3：整片 430 帧，frames 之和 418 → want=12（0.5 秒，等于废片）。
  // 改成按本段声明的 frames 从尾部往前取，与整片长度解耦：skip = got - frames，want = frames。
  const target = Math.max(2, Math.round(Number(shot.frames) || 0) || (got - prevFrames))
  // 🔴 2026-10-27：skip 改成「用上一段尾部音频在整片里反解」。
  //    公式猜不准的实锤：段2 的整片里前段占 170 帧、段3 的整片里前段占 182 帧
  //    （中转为 17k+5 取整和 CTX 预热各留了不同余量）。上一版用统一公式 170 →
  //    段3 整段晚 12 帧 = 0.5 秒，实测音频相关度 1.000 精确偏 +0.500s，用户听成「少了一段音乐」。
  //    prevAbs 传进来就用音频反解；解不出（静音尾巴/相关低）才退回 resnapFrameCount 公式。
  let skip = Math.max(0, Math.min(prevFrames, got - 2))
  // 2026-10-28：拿到本段真实生成帧数时，音频起点也是物理真值（= 上一段交付帧数），
  //   不让包络反解再在 ±6 里挪（实测它反解失败回退、或锚到旁边的峰值，都会让音乐早/晚几帧）。
  if (prevAbs && prevFrames > 2 && genFrames <= 5) {
    let seamSec = -1
    try {
      seamSec = await danceSeamStart(abs, prevAbs, prevFrames / 24)
    } catch (e: any) {
      console.log('[dance-seam] 反解异常，退回公式:', String(e?.message || e).slice(0, 160))
      seamSec = -1
    }
    if (seamSec >= 0) {
      // 2026-10-28：护栏从 ±24 帧收到 ±6 帧。基线已经是「上一段交付帧数」这个物理真值，
      // 反解只该微调几帧（整片里音画本身就差 4 帧）；放宽到 ±24 时它会锚到「上一段尾部音频的结束处」
      // （实测段4 反解出 170 = 基线+12，正好把 0.5 秒错位又找回来）。
      const lo = Math.max(0, prevFrames - 6)
      const hi = Math.min(got - 2, prevFrames + 6)
      skip = Math.min(hi, Math.max(lo, Math.round(seamSec * 24)))
      console.log(`[dance-seam] ${path.basename(abs)} 实测起点 ${seamSec.toFixed(3)}s (${Math.round(seamSec * 24)} 帧)，公式值 ${prevFrames} 帧 → 用 ${skip} 帧`)
    } else {
      console.log(`[dance-seam] ${path.basename(abs)} 反解失败，退回公式 ${prevFrames} 帧`)
    }
  }
  // 🔴 2026-10-27：画面和音频必须**各用各的起点**。整片里音画本身就差 4 帧（实测 p11 段3：
  //    段2 画面结束在整片第 162 帧、音频结束在第 158 帧，两者相关度都是 1.000）。
  //    只用音频值 → 画面多带前一段 4 帧 → 接缝处动作重放一拍（用户说的「多了一拍」）。
  //    画面起点用运动量反解（逐帧），音频起点用包络反解（逐采样）。
  // 🔴 2026-10-28（用户报「段4 画面跳一下」后实测）：画面起点默认比音频**早 5 帧**。
  //    接续机制只把上一段末尾 5 帧钉在整片的前 5 帧（AddLatentGuide guide_frames=5, frame_idx=0），
  //    如果画面也从音频那个点（= 上一段结束后一帧）开始切，这 5 帧钉住的画面就被裁掉 →
  //    交付的第一帧是模型自由采样的，和上一段毫无像素关系（实测段4 接缝残差 18.4，正常应 2~3）。
  //    留 5 帧 → 画面与上一段重叠 0.2 秒（衔接无缝），音频仍按 skip 精确对位（音画差 0.2 秒，
  //    舞蹈 MV 无口型对位，肉眼基本看不出）。这正是「画面/音频各用各的起点」的设计本意。
  // 2026-10-28（latent 实测量出来的规则）：整片 = 上一段 latent + 本段 latent − 5 帧（concat 丢第二段前 5 帧/2 token）
  //   → 本段内容在整片里的起点 = 整片帧数 − 本段生成帧数 + 5。
  //   例：段4 整片 328、gen 158 → 起点 175（原来按「音频-5」取 158，早 17 帧 = 0.7 秒，所以接缝跳）。
  // 🔴 2026-10-30（用户拍板回 latent 拼接方式，App 侧同步回滚）：
  //   **重叠量取决于续接方式，不是固定值**。
  //   · AddGuide（1 帧锚，10-26~10-30 用过）：实测重叠 2 帧 —— 段2[0]≈段1[122] 0.763、
  //     段2[1]≈段1[123] 0.732、段2[2] 起 0.698/0.656 = 新内容（用户看片：skip=0「手臂重复一下」、skip=2 正确）。
  //   · latent 拼接（NativeLatentTimelineConcatT8Advanced，现在这套）：整片 = 上一段 latent + 本段 latent
  //     − 5 帧（concat 丢第二段前 5 帧 / 2 token）⇒ 重新用 10-28 定案的公式，`got − genFrames + 5`。
  //     例：段4 整片 328、gen 158 → 起点 175（按「音频−5」取 158 会早 17 帧 = 0.7 秒，所以接缝跳）。
  // 🔴 2026-10-30（方案 B：AddGuide 22 帧硬锚）：guide 现在是「上一段末 22 帧的 mp4」，
  //   官方把多云帧 batch 当 clip 锚定，前 22 帧逐帧等于上一段成品 ⇒ 段2+ 交付前必须裁掉这 22 帧。
  //   （latent 拼接时代是 5 帧；AddGuide 1 帧时代实测重叠 2 帧；现在 22。）
  let frameSkip = genFrames > 5
    ? DANCE_GUIDE_FRAMES
    : Math.max(0, skip - DANCE_GUIDE_FRAMES)
  if (genFrames > 5) console.log(`[dance-motion] ${path.basename(abs)} 画面起点 = CTX ${frameSkip} 帧（整片 ${got}，请求 gen ${genFrames}）；交付 ${Math.max(2, got - frameSkip)} 帧`)
  // 🔴 2026-10-28（用户第四次听出跳，改实测定案）：整片的**音频和画面同基** —— 两者都从 PREV_START − 5 起
  //   （mv_core.py 里 src_start = start_frame − DANCE_CTX_FRAMES，音轨也按同一基点贴）。
  //   所以音频起点不是「上一段交付帧数」，而是和画面同一个数：skip = frameSkip。
  //   实测三段全部吻合（ncc 0.98~0.99，采样级对齐）：段3 skip163 → 153+163 = 316（旧值）；
  //   段4 skip163 → 311+163 = 474；本次段3 skip170 → 153+170 = 323（段2 结束 327 → 重复 4 帧 = 用户听到的跳）。
  if (genFrames > 5) skip = frameSkip
  // 2026-10-28（用户质询「段4 怎么裁和段3 无关吧」后的定论）：只要拿到了本段真实生成帧数，
  //   起点由 latent 算出来的就是物理真值，**不再让运动反解去覆盖它**（那个窗口以音频为中心，
  //   会把 175 拽回 163~169，等于把上一段内容又切进来）。
  if (prevAbs && prevFrames > 2 && genFrames <= 5) {
    let motSec = -1
    try {
      // 中心用「音频反解值」（skip），不是公式值 prevFrames：
      // 画面和音频只差几帧，而公式值可能偏 12 帧以上（实测 170 vs 真实 158），
      // 用公式值当中心会把真匹配点挤出窗口（实测 345 帧整片：真点在 133，窗口 146~194 找不到）。
      motSec = await danceMotionSeam(abs, prevAbs, skip / 24)
    } catch (e: any) {
      console.log('[dance-motion] 反解异常，画面用音频值-5:', String(e?.message || e).slice(0, 160))
      motSec = -1
    }
    if (motSec >= 0) {
      // 2026-10-28：同样从 ±36 收到 ±6 —— 基线已经是真值，画面只该比音频差几帧（实测 4~5 帧）
      const lo = Math.max(DANCE_GUIDE_FRAMES, skip - 6)
      const hi = Math.min(got - 2, skip + 6)
      frameSkip = Math.min(hi, Math.max(lo, Math.round(motSec * 24)))
      console.log(`[dance-motion] ${path.basename(abs)} 画面起点 ${motSec.toFixed(3)}s (${Math.round(motSec * 24)} 帧)；音频起点 ${skip} 帧；差 ${frameSkip - skip} 帧`)
    } else {
      console.log(`[dance-motion] ${path.basename(abs)} 画面反解失败，沿用「音频起点-5」${frameSkip} 帧（保留钉住的接缝帧）`)
    }
  }
  // 2026-10-28 定论：交付 = 本段生成的内容「全拿走」（got − 画面起点）。
  //   中转的 gen_frames = 17k+5 网格上 ≥ REQ+5 的值（实测：请求 158 → 生成 175 = 5 帧衔接前缀 + 170 新内容），
  //   所以每段真正的内容比请求多 12 帧。按请求帧数截，接缝处就会缺 12 帧（实测段2→段3 残差 18.8、相邻帧基线 1.5）。
  //   段起点改成「前几段实际交付帧数累加」后（见 render 里 dance_start_frame），全拿走才能首尾严格相接。
  const want = genFrames > 5
    ? Math.max(2, got - frameSkip)
    : Math.max(2, Math.min(target, got - skip))
  if (prevFrames > 2 && want <= 2) return rel   // 整片比本段还短（异常）→ 原样返回，别裁成空片
  const tmp = abs.replace(/\.mp4$/i, '.tail.mp4')
  try {
    await new Promise<void>((resolve, reject) => {
      // 画面用 trim=start_frame（帧精确），音频用 atrim=start（采样精确）—— 两者起点可以不同。
      // 同一文件喂两个 input：[0] 取画面、[1] 取音频，互不影响。
      // 2026-10-26 的教训仍有效：mp4 里的 aac 只能给 209920 采样（少 747），所以音频另出一份 .seg.wav。
      ffmpeg(abs).input(abs)
        .complexFilter([
          `[0:v]trim=start_frame=${frameSkip}:end_frame=${frameSkip + want},setpts=PTS-STARTPTS[v]`,
          `[1:a]atrim=start=${(skip / 24).toFixed(6)}:end=${((skip + want) / 24).toFixed(6)},asetpts=PTS-STARTPTS,aresample=32000[a]`,
        ])
        .outputOptions(['-map', '[v]', '-map', '[a]',
          '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y'])
        .on('end', () => resolve()).on('error', (e: Error) => reject(e)).save(tmp)
    })
    // 额外写一份 PCM 音轨给拼接用：MP4 里的 aac/alac 都按固定样本块存（1024/4096），
    // 装不下 158/24 = 210666.7 这种非整数采样长度，每段音频会短几十~上百毫秒，拼起来后半段就卡。
    // 必须在这里做 —— rename 之前 abs 还是原始整片。
    try {
      const wavOut = abs.replace(/\.mp4$/i, '.seg.wav')
      await new Promise<void>((resolve) => {
        ffmpeg(abs).outputOptions([`-ss ${(skip / 24).toFixed(6)}`, `-t ${(want / 24).toFixed(6)}`,
          '-vn', '-c:a', 'pcm_s16le', '-ar', '32000', '-ac', '1', '-y'])
          .on('end', () => resolve()).on('error', () => resolve()).save(wavOut)
      })
    } catch { /* 拼接会退回 mp4 音轨 */ }
    // 🔴 2026-10-28：空片保护 —— 并发裁剪时 ffmpeg 可能读到被换掉的旧文件，产出几百字节的空 mp4
    //    并把成品覆盖掉（实测段4 变成 261 字节）。小于 10KB 一律当失败，保留原文件。
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 10000) {
      throw new Error(`裁切产出异常（${fs.existsSync(tmp) ? fs.statSync(tmp).size : 0} 字节），保留原片`)
    }
    fs.renameSync(tmp, abs)
  } catch (err: any) {
    logTaskError('MV', 'trim-dance-tail', { rel, error: err?.message })
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  }
  return rel
}

const app = new Hono()

const MV_MODEL = 'minimax-h3-mv'   // 中转按 model 名走 mv_shot.api.json
const HARD_MAX_S = 15              // H3 单段极限（页面填的「最长切分」不得超）
const DEFAULT_MAX_S = 10
const KINDS = ['character', 'scene', 'prop'] as const   // 2026-10-20 加道具（照短剧：关键道具要单独出图、单独生卡）
type Kind = typeof KINDS[number]

// ---------------------------------------------------------------- 基础工具

/** 服务器地址：优先 MV_SHIM_BASE，其次「视频通道」的 baseUrl（不写死）
 *  末尾可能被填成 …:8100/v1（BeefTV 的口径）→ 去掉 v1/v2 段，MV 自己拼 /v2/mv/… */
async function shimBase(): Promise<string> {
  const env = String(process.env.MV_SHIM_BASE || '').trim()
  const raw = env || String((await getActiveConfig('video'))?.baseUrl || '').trim()
  if (!raw) throw new Error('没配视频服务地址（设置页的视频通道），MV 提交不了')
  return raw.replace(/\/(v1|v2)\/?$/i, '').replace(/\/+$/, '')
}

async function shimPost<T = any>(p: string, body: any): Promise<T> {
  const cfg = await getActiveConfig('video')
  const base = await shimBase()
  let resp: Response
  try {
    resp = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg?.apiKey || ''}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1800_000),
    })
  } catch (err: any) {
    // 网络层失败（服务器关机/掉线/Tailscale 断）——说人话，别把 fetch failed 甩给用户
    const msg = String(err?.message || err)
    throw new Error(`生成服务连不上（${base}）—— 检查那台机器是否开机、Tailscale 是否在线。原始错误: ${msg}`)
  }
  const text = await resp.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!resp.ok || json?.error) throw new Error(json?.error || `中转 ${p} HTTP ${resp.status}：${text.slice(0, 160)}`)
  return json as T
}

/**
 * 这一段时间窗对应的初步分镜（去重）
 *
 * 2026-10-21：用户在初步分镜里「改一段」时常常是**复制出新段**、旧段没删，
 * 再加上下一段起点可能正好落在本段结束前（如 104.46 < 104.625）——
 * 直接 filter+join 会把三条重复描写全塞进中文稿（分镜 16 就是这样：
 * 靠在电梯厢壁上 / 手机屏幕… / 电梯门开… 叠在一起）。
 * 规则：按「起点离本段起点最近」优先，与已选段重叠超过 50% 的丢掉。
 */
export function outlineForWindow(outline: any[], start: number, end: number): any[] {
  // 交集不足 0.5 秒的段不要：那只是段边界没对齐的尾巴（分镜 16 就是被下一段的 0.16 秒带进了「电梯门开」）
  const ov = (outline || []).filter((o: any) => {
    const inter = Math.min(Number(o?.end), end) - Math.max(Number(o?.start), start)
    return inter >= 0.5
  })
  const overlapRatio = (a: any, b: any) => {
    const from = Math.max(Number(a.start), Number(b.start))
    const to = Math.min(Number(a.end), Number(b.end))
    const inter = Math.max(0, to - from)
    const shorter = Math.min(Number(a.end) - Number(a.start), Number(b.end) - Number(b.start)) || 1
    return inter / shorter
  }
  const chosen: any[] = []
  for (const o of ov.slice().sort((a: any, b: any) => Math.abs(Number(a.start) - start) - Math.abs(Number(b.start) - start))) {
    if (chosen.every((c) => overlapRatio(o, c) < 0.5)) chosen.push(o)
  }
  return chosen.sort((a: any, b: any) => Number(a.start) - Number(b.start))
}

/** 中文稿 = 导演分镜稿：镜头编号 + 时间码 + 景别 + 机位 + 画面内容（给用户看和改） */
function renderZhStoryboard(shot: any, beats: any[], outlineText?: string): string {
  const list = Array.isArray(beats) && beats.length ? beats : [{
    start: 0, end: Number(shot.seconds) || 5.167,
    size: shot.shotSize || '中景', camera: shot.camera || '', action_zh: '', action: '',
  }]
  const lines = list.map((b: any, i: number) => {
    const head = `【镜头${i + 1}】${Number(b.start).toFixed(3)}–${Number(b.end).toFixed(3)}秒｜${b.size || ''}${b.camera ? '｜' + b.camera : ''}`
    const act = String(b.action_zh || b.action || '').trim()
    return act ? `${head}｜${act}` : head
  })
  const vocal = String(shot.vocalState || '') === 'non_vocal'
    ? '本段无唱（间奏），嘴保持自然闭合，只做情绪与律动。'
    : '本段有唱：脸和嘴全程可见、不遮挡、不出画，口型跟着原曲走。'
  const extra = String(shot.promptExtra || '').trim()
  const head = outlineText ? `【段落内容】${outlineText}` : ''
  return [head, ...lines, `【人声】${vocal}`, extra ? `【补充】${extra}` : ''].filter(Boolean).join('\n')
}

/** 中文稿 = 详细《中文导演分镜稿》：让模型把英文六段稿 + 拍点编排写成逐镜头的中文分镜（分块 2 条 + 失败逐条重试） */
type ZhItem = { en: string, beats: any[], seconds: number, vocalState?: string }

const ZH_FORMAT = `格式（严格，不要多余说明）：
【镜头N】起-止秒｜景别｜机位
画面：2~4 句，写清这一拍里——环境长什么样、谁在画面里、穿什么、在做什么动作/什么表情、光线与色调、镜头怎么动。必须具体可拍，不要堆抽象形容词
…
【声音】……`

/**
 * 2026-10-19：用 **MV 自己的** `skills/mv/video-prompt` 给 MV 段出提示词（中文工作版 + 英文发送版）。
 * 与短剧彻底隔离：不读 `prompt-generator/*`、不改短剧任何文件（用户 2026-10-19 明确要求）。
 * 与短剧的唯一差别：上下文由本函数直接拼进指令，**不调用 read_storyboard_context**
 * （那是读短剧表的工具，MV 段不在其中）；短剧链路 services/video-prompts.ts 一行未动。
 * 失败返回 null，调用方回退到中转编译（旧行为）。
 */
/** MV 自己的中文判定/清洗（不引短剧的 zh-lang） */
function mvLooksChinese(text: string): boolean {
  const t = String(text || '').replace(/\s/g, '')
  if (!t) return false
  return ((t.match(/[\u4e00-\u9fa5]/g) || []).length / t.length) >= 0.3
}
function mvCleanText(raw: string): string {
  let t = String(raw || '').trim()
  t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
  // 砍掉正文前的英文闲聊/思考（首个含中文的行之前，最多 6 行）
  const lines = t.split('\n')
  const startIdx = lines.findIndex((l) => /[\u4e00-\u9fa5]/.test(l))
  if (startIdx > 0 && startIdx < 6) t = lines.slice(startIdx).join('\n').trim()
  return t
}

/**
 * 2026-10-19：MV 段提示词 —— **完全走 MV 自己的链路**：
 * 只读视频提示词技能文本（readSkillFile 是只读）+ 用 mv.ts 自己的 askText 调文本模型，
 * **不引短剧的 services/video-prompts、不引 mastra Agent、不改短剧任何文件**。
 */
/**
 * MV 段提示词 = **照短剧那一套**（2026-10-19 用户要求「先看短剧怎么写的」，逐项对齐）：
 * ① 技能文本全给（原来截到 12000 字，正好把英文六段规范裁掉）
 * ② 注入项目画风规范（风格头 = 画风介质词必须写进正文；正文渲染语言中/英各一份）
 * ③ 主体清单 + 逐主体字数预算（短剧 rosterBlock 的做法）
 * ④ 给「目标长度」而不是只给上限 + 六段配额
 * ⑤ detailed_description 按拍写 [Shot N]（第 1 拍无时间戳，其后 `At MM:SS.mmm`）
 * ⑥ 超 6200 字压一轮（短剧 buildRewritePrompt 的「怎么压」清单）
 * ⑦ 中文工作版由英文六段稿 + 拍点写成逐拍详细稿
 */
/** 最近一次 MV 段提示词失败的真实原因（流水线里各道闸的消息，报给用户看） */
let lastShotPromptError = ''

/** 段提示词的真实步骤进度：{shotId: {step,total,label,at,done}}。前端轮询显示「第 X/Y 步 · 在做什么」 */
const shotPromptProgress = new Map<number, { step: number; total: number; label: string; at: number; done: boolean }>()

async function mvShotPromptSkill(
  project: any, shot: any, picked: any[], character: any, sc: any,
): Promise<{ zh: string; en: string } | null> {
  try {
    // MV 自己的那份（独立副本，短剧改动影响不到 MV）
    const full = String(readSkillFile('mv/video-prompt') || '')
    const enIdx = full.indexOf('## 英文发送版')
    const spec = await getStyleSpecByValue(project?.style)
      .catch(() => ({ head: '', bodyRules: '', bodyRulesEn: '' }) as any)
    let beats: any[] = []
    try { beats = JSON.parse(String(shot.beats || '[]')) } catch { beats = [] }
    const secs = Number(shot.seconds) || 6
    const start = Number(shot.startSeconds) || 0
    const end = Number(shot.endSeconds) || (start + secs)
    let outline: any[] = []
    try { outline = JSON.parse(String(project?.outline || '[]')) } catch { outline = [] }
    const out = await generateMvShotPrompt({
      // 技能按「## 英文发送版」切两份：中文任务吃中文规则、英文任务吃六段规范（原来整段截断 12000 字，正好把这节裁掉）
      skillZh: enIdx > 0 ? full.slice(0, enIdx) : full,
      skillEn: enIdx > 0 ? full.slice(enIdx) : full,
      styleHead: String(spec?.head || ''),
      styleRulesZh: String(spec?.bodyRules || ''),
      styleRulesEn: String(spec?.bodyRulesEn || ''),
      // 出场 = **这一段自己绑定的参考素材**（不是项目主人物）：绑了谁就写谁，没绑才回退主素材
      roster: (() => {
        const chars = (picked || []).filter((a: any) => a.kind === 'character' && a.name)
        const cast = (chars.length ? chars : (character?.name ? [character] : []))
          .map((a: any) => '@' + String(a.name)).join('、') || '@主角'
        const scene2 = (picked || []).find((a: any) => a.kind === 'scene' && a.name) || sc
        const props2 = (picked || []).filter((a: any) => a.kind === 'prop' && a.name)
          .map((a: any) => '@' + String(a.name)).join('、')
        return `出场人物：${cast}；场景：@${scene2?.name || '主场景'}${props2 ? `；道具：${props2}` : ''}`
      })(),
      pictures: (picked || []).map((a: any, i: number) => ({
        n: i + 1, name: a.name, kind: a.kind,
        // 资产外观/妆造原文：短剧的 read_characters 会给模型这些，MV 只给名字的话模型就自己编衣服颜色
        assetText: [a.appearance, a.styling, a.description]
          .map((x: any) => String(x || '').trim()).filter(Boolean).join(' / ').slice(0, 900),
      })),
      outlineText: outlineForWindow(outline, start, end)
        .map((o: any) => `[${o.start}-${o.end}s] ${o.what}`).join('\n'),
      beats: beats.map((b: any) => ({
        start: Number(b.start) || 0, end: Number(b.end) || 0,
        // 2026-10-21：段级景别（shot.shotSize）优先 —— 用户改了「景别」却被 beats 里的旧值盖回去，
        //            中文稿永远不变（英文又自己译成 close-up），中英就分叉了
        size: String(shot.shotSize || b.size || ''), camera: String(b.camera || ''),
        action: String(b.action || ''), action_zh: String(b.action_zh || ''),
      })),
      seconds: secs, start, frames: Number(shot.frames) || 0,
      vocalActive: !['non_vocal', 'silent'].includes(String(shot.vocalState || '')),
      lyric: shot.lyric ? String(shot.lyric) : '',
      extra: shot.promptExtra ? String(shot.promptExtra) : '',
      shotNumber: Number(shot.shotNumber) || 0,
      aspectRatio: String(project?.aspectRatio || '16:9'),
      onProgress: (step, total, label) => {
        shotPromptProgress.set(Number(shot.id), { step, total, label, at: Date.now(), done: false })
      },
    }, (system, user) => askText(system, user, 4000, project.textConfigId))
    shotPromptProgress.set(Number(shot.id), { step: 8, total: 8, label: '完成', at: Date.now(), done: true })
    return out
  } catch (err: any) {
    lastShotPromptError = String(err?.message || err)
    shotPromptProgress.set(Number(shot.id), { step: 0, total: 8, label: `失败：${lastShotPromptError.slice(0, 80)}`, at: Date.now(), done: true })
    logTaskError('MV', 'shot-prompt', { sid: shot.id, error: lastShotPromptError })
    return null
  }
}

async function toChineseStoryboards(items: ZhItem[], configId?: number | null): Promise<string[]> {
  const out = new Array(items.length).fill('')
  const body = (it: ZhItem) => `时长: ${it.seconds}s（${it.vocalState === 'non_vocal' ? '本段无唱/间奏' : '本段有唱'}）
英文提示词：
${it.en}
镜头编排：
${JSON.stringify(it.beats)}`

  const runOne = async (it: ZhItem): Promise<string> => {
    try {
      const ask = `你是这支 MV 的导演。把这一段整理成中文导演分镜稿。\n\n${ZH_FORMAT}\n\n要求：\n- 逐拍写，起止秒/景别/机位与「镜头编排」完全一致\n- 画面描述要把英文提示词里的场面、人物、服装、光影、运镜细节搬进来\n- 有唱写"脸和嘴全程可见、口型跟着原曲"；间奏写"嘴自然闭合"\n- 只输出中文\n\n${body(it)}\n\n只输出 JSON 对象：{"zh":"…"}（zh 内用 \\n 换行）`
      const o = pickJson<any>(await askText('你是 MV 导演，只输出 JSON。', ask, 4000, configId))
      return String(o?.zh || '').trim()
    } catch { return '' }
  }

  for (let i = 0; i < items.length; i += 2) {
    const chunk = items.slice(i, i + 2)
    try {
      const ask = `你是这支 MV 的导演。下面 ${chunk.length} 段视频，每段给「英文提示词 + 镜头编排」，逐段写成中文导演分镜稿。\n\n${ZH_FORMAT}\n\n要求：起止秒/景别/机位与编排一致；画面描述具体（环境/人物/服装/动作表情/光线色调/镜头运动）；只输出中文。\n\n${chunk.map((it, k) => `--- ${k} ---\n${body(it)}`).join('\n\n')}\n\n只输出 JSON 数组：[{"index":0,"zh":"…"}]`
      const arr = pickJson<any>(await askText('你是 MV 导演，只输出 JSON。', ask, 8000, configId))
      for (const o of Array.isArray(arr) ? arr : []) {
        const k = Number(o?.index)
        if (Number.isFinite(k) && k >= 0 && k < chunk.length) out[i + k] = String(o?.zh || '').trim()
      }
    } catch { /* 整块失败，逐条补 */ }
    for (let k = 0; k < chunk.length; k++) {
      if (!out[i + k]) out[i + k] = await runOne(chunk[k])
    }
  }
  return out
}

/** 把中文补充说明整批翻成英文（一条 LLM 调用；失败返回空数组，编译照常跑） */
async function translateExtras(list: string[], configId?: number | null): Promise<string[]> {
  const idx = list.map((t, i) => [t, i] as const).filter(([t]) => t)
  if (!idx.length) return []
  try {
    const ask = `把下面每条「视频补充说明」翻成英文（电影摄影/画面约束用语，简短，不解释、不加序号）：
${idx.map(([t, i]) => `${i}: ${t}`).join('\n')}

只输出 JSON 数组：[{"index":0,"en":"…"}]`
    const out = pickJson<any[]>(await askText('你是影视提示词翻译，只输出 JSON。', ask, 2000, configId))
    const arr = new Array(list.length).fill('')
    for (const o of Array.isArray(out) ? out : []) {
      const i = Number(o?.index)
      if (Number.isFinite(i) && i >= 0 && i < arr.length) arr[i] = String(o?.en || '').trim()
    }
    return arr
  } catch { return [] }
}

/** 调当前文本模型（OpenAI 形状 /chat/completions；不用 Agent，避免它的提示词风格污染） */
async function askText(system: string, user: string, maxTokens = 2500, configId?: number | null): Promise<string> {
  const cfg = (configId ? await getConfigById(Number(configId)) : null) ?? await getTextConfig()
  let model = ''
  try { model = (JSON.parse(cfg.model || '[]') as string[])[0] || '' } catch { model = String(cfg.model || '') }
  const resp = await fetch(joinProviderUrl(getTextProviderBaseUrl(cfg), '/v1', '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || ''}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens }),
  })
  if (!resp.ok) throw new Error(`文本模型返回 ${resp.status}：${(await resp.text()).slice(0, 200)}`)
  const text = extractChatText(await resp.json())
  if (!text.trim()) throw new Error('文本模型返回空内容（换一个文本模型再试）')
  return text
}

/** 从模型回复里抠 JSON（容忍 ```json 围栏和前后废话） */
function pickJson<T>(text: string): T {
  const s = String(text).replace(/```(?:json)?/gi, '').trim()
  const i = s.search(/[[{]/)
  const j = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'))
  if (i < 0 || j <= i) throw new Error(`模型没回 JSON：${s.slice(0, 160)}`)
  return JSON.parse(s.slice(i, j + 1)) as T
}

function mvDir(projectId: number) {
  const rel = `mv/p${projectId}`
  fs.mkdirSync(path.join(STORAGE_ROOT, rel), { recursive: true })
  return rel
}

function b64ToBuffer(dataUrl: string): Buffer {
  const raw = String(dataUrl || '')
  const b64 = raw.startsWith('data:') ? raw.split(',').slice(1).join(',') : raw
  return Buffer.from(b64, 'base64')
}

function readAsDataUrl(rel: string, mime: string): string {
  return `data:${mime};base64,${fs.readFileSync(getAbsolutePath(rel)).toString('base64')}`
}

/** 音频转 32kHz 单声道 PCM16 wav（H3 音频锁定只认这个；24k 实测无效） */
function to32kWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input).noVideo().audioCodec('pcm_s16le').audioFrequency(32000).audioChannels(1).format('wav')
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(output)
  })
}

/** 续接段在中转整片里实际占的帧数：中转按 snap17(frames + DANCE_CTX) 生成、再减掉 CTX。
 *  段2/3 实测：frames=158 → snap17(163)=175 → 占 170 帧（整片 345 = 170 + 175 可验）。
 *  拼接裁切必须用这个数当起点，用请求帧数会少跳 12 帧、片头重复上一段画面。 */
/** AddGuide 锚定的帧数（喂给节点的 IMAGE batch 长度）。官方合法值 5 / 22 / 39（17k+5）。 */
const DANCE_GUIDE_FRAMES = 22
const DANCE_CTX = 5
function resnapFrameCount(frames: number): number {
  const f = Math.max(2, Math.round(frames || 0))
  const k = Math.ceil((f + DANCE_CTX - 5) / 17)   // 中转是 _snap17_up（向上取整）
  const gen = Math.min(3600, Math.max(5, 5 + 17 * k))
  return Math.max(2, gen - DANCE_CTX)
}

/** 帧网格 5+17k（H3 只认这个）：5.167s ~ 14.375s */
function snapFrames(seconds: number): number {
  const f = Math.round(seconds * 24)
  const k = Math.round((f - 5) / 17)
  return Math.min(345, Math.max(124, 5 + 17 * k))
}

const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
void stamp   // 保留：出图/上传文件名可能用到

async function loadProject(id: number) {
  const [row] = await db.select().from(schema.mvProjects).where(and(eq(schema.mvProjects.id, id), isNull(schema.mvProjects.deletedAt)))
  return row || null
}

async function shotsOf(projectId: number) {
  return db.select().from(schema.mvShots).where(eq(schema.mvShots.projectId, projectId)).orderBy(schema.mvShots.shotNumber)
}

/** 把 LLM 给的拍点夹进段内：首尾相接、正好铺满 seconds（1~3 拍） */
const STATIC_ACT_RE = /\b(stand|stands|standing|still|breathe|breathes|breathing|wait|waits|rests?|lean|lazy)\b/i
const actClass = (a: string) => (STATIC_ACT_RE.test(String(a || '')) ? 'static' : 'dynamic')

function fitBeats(raw: any, seconds: number, size: string, camera: string, shotNumber = 1, vocal = true, prevActClass = ''): any[] {
  const list = Array.isArray(raw) ? raw : []
  const total = Math.max(0.5, seconds)
  const cuts: number[] = []
  for (const b of list) {
    const e = Number(b?.end)
    if (Number.isFinite(e) && e > 0.2 && e < total - 0.2) cuts.push(e)
  }
  const uniq = [...new Set(cuts.map((c) => Math.round(c * 1000) / 1000))].sort((a, b) => a - b).slice(0, 3)
  const bounds = [0, ...uniq, total]
  // 运镜兜底：按段号交替「固定 → 缓慢推近 → 固定 → 缓慢拉远」，别整片一个机位
  const CAM_CYCLE = ['固定机位', '缓慢推近', '固定机位', '缓慢拉远']
  const camFallback = camera || CAM_CYCLE[(Math.max(1, shotNumber) - 1) % CAM_CYCLE.length]
  // 动作兜底必须按段轮换：写死同一句会让每一段动作完全一样（实测分镜1/2 都"往镜头走"）
  const ACT_CYCLE = [
    'she sings steadily into the lens, swaying gently with the beat',
    'she turns to a three-quarter angle and keeps singing, one hand rising with the phrase',
    'she closes her eyes for a moment mid-line, shoulders easing with the beat',
    'she tilts her head toward the light and sings, hair drifting across her cheek',
    'she shifts her weight and sings on, chin lifting slightly on the phrase',
  ]
  const ACT_ZH_CYCLE = [
    '她对着镜头稳稳唱，随节拍轻轻摆动',
    '她转向三分之四侧继续唱，一只手随乐句抬起',
    '她唱到一半轻轻闭眼，肩膀随节拍放松',
    '她微微偏头朝光而唱，发丝扫过脸颊',
    '她换了个重心继续唱，唱到乐句时下巴轻抬',
  ]
  const ACT_NV_CYCLE = [
    'she breathes quietly, shoulders relaxing, gaze drifting off the lens',       // 静
    'she turns toward the microphone and rests one hand on its stand',            // 动
    'she stands still and lets the room breathe, only her hair moving slightly',   // 静
    'she lifts one hand and tucks her hair behind her ear',                       // 动
  ]
  const ACT_NV_ZH_CYCLE = [
    '她安静呼吸，肩膀放松，视线自然移开',
    '她转向麦克风，一只手扶上支架',
    '她一语不发地站着，只有发丝轻轻动',
    '她抬起一只手把发丝别到耳后',
  ]
  const idx0 = Math.max(1, shotNumber) - 1
  const ENC = vocal ? ACT_CYCLE : ACT_NV_CYCLE
  const ZHC = vocal ? ACT_ZH_CYCLE : ACT_NV_ZH_CYCLE
  let pick = idx0 % ENC.length
  // 相邻段动作类型必须换：上段静、这段也静 → 顺延到下一个「动」的动作（拼起来不会像同一个镜头）
  if (prevActClass && actClass(ENC[pick]) === prevActClass && ENC.length > 1) {
    for (let k = 1; k <= ENC.length; k++) {
      const cand = (pick + k) % ENC.length
      if (actClass(ENC[cand]) !== prevActClass) { pick = cand; break }
    }
  }
  const actFallback = ENC[pick]
  const actZhFallback = ZHC[pick % ZHC.length]
  return bounds.slice(1).map((end, k) => {
    const start = bounds[k]
    const src = Array.isArray(list) ? list[k] || {} : {}
    return {
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      size: String(src.size || size).slice(0, 10),
      // 编排模型经常把动作/机位留空（实测：beats 里 action/camera 全空 → 画面全靠模型自由发挥）
      camera: String(src.camera || camFallback).slice(0, 200),
      action: String(src.action || actFallback).slice(0, 300),
      action_zh: String(src.action_zh || actZhFallback).slice(0, 300),
    }
  })
}

/** 这一段的参考图：绑了就用绑的（按 id 顺序），没绑沿用「第一个人物 + 第一个场景」 */
async function shotRefs(projectId: number, shot: any) {
  const rows = await assetsOf(projectId)
  let ids: number[] = []
  try { const v = JSON.parse(String(shot?.refIds || '[]')); if (Array.isArray(v)) ids = v.map(Number).filter(Boolean) } catch { ids = [] }
  let picked = ids.length ? ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as any[] : []
  if (!picked.length) picked = [rows.find((r) => r.kind === 'character'), rows.find((r) => r.kind === 'scene')].filter(Boolean) as any[]
  return picked
}

/**
 * 本段的中文舞步描述（取自项目 outline 里与本段时间窗重叠的条目）。
 * dance 模板要把它翻成英文点名进 detailed_description：只写「逐帧复刻参考视频」时
 * 动作跟随会松（官方 Ref 指南要求 dd 写清 actions and state changes；社区实测「动作跟不住要 direct prompting」）。
 */
function danceActionText(project: any, shot: any): string {
  let list: any[] = []
  try { const v = JSON.parse(String(project?.outline || '[]')); if (Array.isArray(v)) list = v } catch { return '' }
  const s0 = Number(shot?.startSeconds) || 0
  const s1 = Number(shot?.endSeconds) || (s0 + (Number(shot?.seconds) || 0))
  // 🔴 2026-10-26：每条前面带「它在本段里实际占几秒」。
  //    原来是等量平铺 —— 实测段3（13.17~19.75s）跨 outline 三条：
  //      第3条 只占 0.83s → 分到 60 字符
  //      第4条 占 4.50s（高抬腿踢腿+双臂甩臂，全片动作最猛）→ 只分到 48 字符
  //    结果成片 2.5~4.5s（= 第4条那 4.5 秒）SSIM 掉到 0.309~0.389，模型在那段自己补出一张脸；
  //    前后两条都正常（0.42~0.47）。带 span 交给翻译按占比分配篇幅。
  return list
    .filter((o) => Number(o?.end) > s0 + 0.2 && Number(o?.start) < s1 - 0.2 && String(o?.what || '').trim())
    .sort((a, b) => Number(a.start) - Number(b.start))
    .map((o) => {
      const span = Math.min(Number(o.end), s1) - Math.max(Number(o.start), s0)
      return `${Math.max(0.1, Math.round(span * 10) / 10)}s: ${String(o.what).trim()}`
    })
    .join('\n')
    .slice(0, 320)
}

/**
 * 场景图在 `referenceImageUrls` 里的序号（1 起）—— dance 模板要用它把场景钉成 `<Subject N>`。
 * 缺失时退回 2（shotRefs 默认顺序 = 人物、场景）。
 */
function danceScenePic(picked: any[]): number {
  const i = (picked || []).findIndex((a) => String(a?.kind) === 'scene')
  return i >= 0 ? i + 1 : 2
}

/**
 * 素材库口径：同一张卡只列一次（kind + 名字 + 图片都相同就算同一张）。
 * 2026-10-28：从素材库「选择已有人物/场景」挑进来的是副本行，按行列出就会「挑一次多一张一样的卡」。
 */
function dedupeAssets<T extends any>(rows: T[]): T[] {
  const seen = new Set<string>()
  return [...rows]
    .sort((a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || a.id - b.id)
    .filter((a: any) => {
      const k = `${a.kind}|${a.name || ''}|${a.image || ''}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }) as T[]
}

/**
 * 公共素材库（scope='library'，所有 MV 共用）。
 * 2026-10-28：带上 seriesId 时一并返回本项目（同系列各首歌）的人物/场景 —— 「选择已有人物/场景」
 * 看到的就是 MV 素材库 Tab 里那批，不再只有公共库里那一条；excludeProjectId 排掉当前这首歌已有的。
 */
async function libraryAssetsOf(kind?: Kind, seriesId?: number, excludeProjectId?: number) {
  const rows = (await db.select().from(schema.mvAssets)).filter((a) => (
    (!kind || a.kind === kind)
    && (!excludeProjectId || a.projectId !== excludeProjectId)
    && (a.scope === 'library' || (seriesId != null && a.seriesId === seriesId))
  ))
  return dedupeAssets(rows)
}

/** 道具名的可匹配写法：全名 + 去掉类目后缀 + 前两个字（歌词里常只写简称，如「宵夜」） */
function propNameKeys(name: any): string[] {
  const n = String(name || '').replace(/\s+/g, '')
  const keys = new Set<string>()
  if (n.length >= 2) keys.add(n)
  const stripped = n.replace(/(保温袋|包装袋|手提袋|纸袋|塑料袋|礼物盒|盒子|杯子|瓶子|袋子|袋|盒|杯)$/, '')
  if (stripped.length >= 2) keys.add(stripped)
  if (n.length > 2) keys.add(n.slice(0, 2))
  return [...keys].filter((k) => k.length >= 2)
}

async function assetsOf(projectId: number, kind?: Kind) {
  // 2026-10-20：资产**只认这首歌自己**（projectId）。早前按 mv_assets.series_id 合并同系列，
  // 导致新歌一导入就显示上一首歌的人物/场景；现在必须「提取人物和场景」后才有。
  // 想复用旧角色 → 提取到同名角色时前端会问「用素材库现有的吗」，或从公共素材库 import。
  const mine = eq(schema.mvAssets.projectId, projectId)
  const rows = await db.select().from(schema.mvAssets).where(
    kind ? and(mine, eq(schema.mvAssets.kind, kind)) : mine)
  return rows.sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || a.id - b.id)
}

/**
 * 按「项目上下文」取一条资产行。
 * 资产库挂项目级（series_id），同一项目下的歌共用 ⇒ 只要同系列就算可见；
 * 老数据没有 series_id 的按 project_id 判。
 */
async function assetInProject(projectId: number, assetId: number) {
  const [asset] = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.id, assetId))
  if (!asset) return null
  if (Number(asset.projectId) === Number(projectId)) return asset
  const sid = Number(asset.seriesId) || 0
  if (!sid) return null
  const [pj] = await db.select().from(schema.mvProjects).where(eq(schema.mvProjects.id, Number(projectId)))
  return Number((pj as any)?.seriesId) === sid ? asset : null
}

/** 出片用的「主」资产：每一类取第一个 */
async function primaryAssets(projectId: number) {
  const rows = await assetsOf(projectId)
  return {
    character: rows.find((r) => r.kind === 'character') || null,
    scene: rows.find((r) => r.kind === 'scene') || null,
  }
}

/**
 * 项目的画风头（资产图片提示词的第一段）。
 * 项目没选画风（老项目）时兜底用预设里排序第一个 —— 风格那里本来就有默认值，别让提示词裸奔。
 */
async function styleHead(project: any): Promise<string> {
  try {
    const head = (await getStyleSpecByValue(project?.style)).head
    if (head) return head
    const [first] = await db.select().from(schema.stylePresets)
      .where(eq(schema.stylePresets.isActive, true))
      .orderBy(schema.stylePresets.sortOrder).limit(1)
    return first ? (await getStyleSpecByValue(first.value)).head : ''
  } catch { return '' }
}

/**
 * MV 自己的最小兜底指令（2026-10-19）：正常路径是「设置 → Agent 配置」里的
 * workspace/prompts/<type>.md（见 mvPrompt），这里只在读不到文件时用一句最小指令顶上 ——
 * 为的是**不引短剧的 agents/index**，把 MV 后端对短剧的依赖彻底断开。
 */
const MV_FALLBACK_PROMPTS: Record<string, string> = {
  mv_extractor: '从给定内容里提取人物和场景，只输出 JSON。',
  mv_asset_image: '为人物或场景写生图提示词，只输出提示词正文。',
  mv_storyboard: '按歌曲把内容切成带起止时间的段落（每段 3~10 秒），只输出 JSON 数组。',
  mv_camera: '为每个段落补景别与运镜，相邻段避免重复，只输出 JSON 数组。',
  mv_prop_map: '判断每个分镜段落里出现了哪些道具，只输出 JSON。',
}

/**
 * MV 的可自定义指令：优先用「设置 → Agent 配置」里改过的 workspace/prompts/<type>.md，
 * 没有就用 MV 自己的最小兜底（MV_FALLBACK_PROMPTS）。
 */
async function mvPrompt(type: string): Promise<string> {
  try {
    const f = await loadAgentPromptFile(type)
    if (f?.instructions) return f.instructions
  } catch { /* 读不到就用默认 */ }
  return MV_FALLBACK_PROMPTS[type] || ''
}

/** 等 sys_task 跑完（图片/视频同一张表；MV 借它拿结果） */
async function waitTask(taskId: number, timeoutMs = 600_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!row) throw new Error(`任务 ${taskId} 不存在`)
    if (row.status === 'completed') return row
    if (row.status === 'canceled') throw new Error('已停止')
    if (row.status === 'failed') throw new Error(row.errorMsg || `任务 ${taskId} 失败`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`任务 ${taskId} 超时未完成`)
}

/** 本地读时长（ffprobe），建项目时就能给粗分镜用，不必先送 服务器 */
function probeSeconds(file: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      ffmpeg.ffprobe(file, (err: any, meta: any) => {
        const d = Number(meta?.format?.duration)
        resolve(err || !Number.isFinite(d) ? 0 : Math.round(d * 1000) / 1000)
      })
    } catch { resolve(0) }
  })
}

/**
 * 原曲送 服务器 —— **只在第一次真正需要时做**（切分镜 / 提交片段），建项目时只落本地。
 * 做一次就记住文件名，之后每段只带名字。
 */
async function ensureRemoteSong(project: any): Promise<string> {
  if (project?.songRemoteName) return String(project.songRemoteName)
  if (!project?.songFile) throw new Error('项目里没有歌文件')
  const rel = mvDir(Number(project.id))
  const wavRel = `${rel}/song_32k.wav`
  await to32kWav(getAbsolutePath(project.songFile), getAbsolutePath(wavRel))
  const name = `mv_p${project.id}_song_32k.wav`
  const info = await shimPost<{ name: string; seconds: number }>('/v2/mv/audio', {
    name, data: readAsDataUrl(wavRel, 'audio/wav'),
  })
  const remote = String(info?.name || name)
  await db.update(schema.mvProjects).set({
    songRemoteName: remote,
    songSeconds: Number(info?.seconds || project.songSeconds || 0),
    updatedAt: now(),
  }).where(eq(schema.mvProjects.id, Number(project.id)))
  project.songRemoteName = remote
  logTaskSuccess('MV', 'song-pushed', { id: project.id, name: remote, seconds: info?.seconds })
  return remote
}

// ---------------------------------------------------------------- 项目

/**
 * 当前启用的三条通道（顶部标签栏展示用；MV 不单独锁通道，改在「设置 → AI 服务」）
 */
/**
 * 2026-10-19 照短剧结构补「上一级 MV 项目」：
 * MV 项目(mv_series) → 歌(mv_projects) → 段(mv_shots)；人物/场景资产库挂项目级（mv_assets.series_id），
 * 所以同一个 MV 项目下换一首歌，人物和场景照样共用。
 */
app.get('/series', async (c) => {
  const rows = await db.select().from(schema.mvSeries).orderBy(desc(schema.mvSeries.id))
  const allAssets = await db.select().from(schema.mvAssets)
  const out: any[] = []
  for (const r of rows) {
    const songs = await db.select().from(schema.mvProjects)
      .where(and(eq(schema.mvProjects.seriesId, r.id), isNull(schema.mvProjects.deletedAt)))
    const assets = dedupeAssets(allAssets.filter((a) => a.seriesId === r.id))
    out.push({
      ...r,
      songCount: songs.length,
      assetCount: assets.length,
      // 封面 = 项目里第一张已出的**场景图**（照短剧首页口径：场景图是单幅完整画面，适合当封面；人物图是三格参考板不拿来当封面）。
      // 没有场景图就用首字兜底。状态按「有没有 MV」派生（不加列）
      cover: assets.find((a) => a.kind === 'scene' && !!a.image)?.image || null,
      status: songs.length ? 'active' : 'empty',
      songs: songs.map((x) => ({ id: x.id, title: x.title })),
    })
  }
  return success(c, { series: out })
})

/**
 * 项目详情（照短剧 GET /dramas/:id）：一次返回项目 + 下面的 MV（歌）+ 项目级素材库。
 * 素材的增删改仍走 /projects/:id/assets/:aid（资产行自带 projectId，前端拿它当上下文）——
 * 不另开一套 series 级 CRUD，避免两条路径写同一张表。
 */
app.get('/series/:sid', async (c) => {
  const sid = Number(c.req.param('sid'))
  const [series] = await db.select().from(schema.mvSeries).where(eq(schema.mvSeries.id, sid))
  if (!series) return notFound(c, 'MV 项目不存在')
  const songs = await db.select().from(schema.mvProjects)
    .where(and(eq(schema.mvProjects.seriesId, sid), isNull(schema.mvProjects.deletedAt)))
    .orderBy(desc(schema.mvProjects.id))
  const rows = await db.select().from(schema.mvAssets)
  const assets = dedupeAssets(rows.filter((a) => a.seriesId === sid || songs.some((s) => s.id === a.projectId)))
  const shots = await db.select().from(schema.mvShots)
  const items = songs.map((p) => {
    const mine = rows.filter((a) => a.projectId === p.id)
    return {
      ...p,
      cover: mine.find((a) => !!a.image)?.image || p.outputUrl || null,
      characters: mine.filter((a) => a.kind === 'character').length,
      scenes: mine.filter((a) => a.kind === 'scene').length,
      shots: shots.filter((s) => s.projectId === p.id).length,
    }
  })
  return success(c, { series, songs: items, assets })
})


app.post('/series', async (c) => {
  const body = await c.req.json().catch(() => ({} as any))
  const nowIso = now()
  const ins = await db.insert(schema.mvSeries).values({
    title: String(body.title || '未命名 MV 项目').slice(0, 80),
    style: body.style ? String(body.style) : null,
    aspectRatio: String(body.aspect_ratio || '16:9').slice(0, 10),
    createdAt: nowIso, updatedAt: nowIso,
  } as any)
  return created(c, { id: getInsertId(ins) })
})

app.put('/series/:sid', async (c) => {
  const sid = Number(c.req.param('sid'))
  const body = await c.req.json().catch(() => ({} as any))
  const patch: any = { updatedAt: now() }
  if (body.title !== undefined) patch.title = String(body.title).slice(0, 80)
  if (body.style !== undefined) patch.style = String(body.style)
  if (body.aspect_ratio !== undefined) patch.aspectRatio = String(body.aspect_ratio).slice(0, 10)
  await db.update(schema.mvSeries).set(patch).where(eq(schema.mvSeries.id, sid))
  return success(c, { id: sid })
})

/**
 * 删 MV 项目 = 连项目下的歌一起删（照短剧删剧级联）。
 * 只删 mv_series 会留一堆看不见的歌/资产/分镜（列表按 series 取，界面看不出残留）。
 */
app.delete('/series/:sid', async (c) => {
  const sid = Number(c.req.param('sid'))
  const songs = await db.select().from(schema.mvProjects).where(eq(schema.mvProjects.seriesId, sid))
  for (const s of songs) {
    await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, s.id))
    await db.delete(schema.mvAssets).where(eq(schema.mvAssets.projectId, s.id))
    await db.delete(schema.mvProjects).where(eq(schema.mvProjects.id, s.id))
  }
  // 项目级资产（series_id 挂上、但 project_id 属于别的歌或已不存在）一并清
  await db.delete(schema.mvAssets).where(eq(schema.mvAssets.seriesId, sid))
  await db.delete(schema.mvSeries).where(eq(schema.mvSeries.id, sid))
  logTaskSuccess('MV', 'delete-series', { id: sid, songs: songs.length })
  return success(c, { ok: true, songs: songs.length })
})

app.get('/channels', async (c) => {
  const name = (cfg: any) => {
    if (!cfg) return ''
    try {
      const arr = JSON.parse(cfg.model || '[]')
      return Array.isArray(arr) ? String(arr[0] || '') : String(cfg.model || '')
    } catch { return String(cfg.model || '') }
  }
  const [text, image, video] = await Promise.all([
    getTextConfig().catch(() => null),
    getActiveConfig('image').catch(() => null),
    getActiveConfig('video').catch(() => null),
  ])
  return success(c, { text: name(text), image: name(image), video: name(video) })
})

app.get('/projects', async (c) => {
  const rows = await db.select().from(schema.mvProjects).where(isNull(schema.mvProjects.deletedAt)).orderBy(desc(schema.mvProjects.id))
  // 列表卡片要封面和「N 人物 · M 场景 · K 段」，一次性算好（表小，直接全取内存里归并）
  const assets = await db.select().from(schema.mvAssets)
  const shots = await db.select().from(schema.mvShots)
  const items = rows.map((p) => {
    const mine = assets.filter((a) => a.projectId === p.id)
    return {
      ...p,
      cover: mine.find((a) => !!a.image)?.image || p.outputUrl || null,
      characters: mine.filter((a) => a.kind === 'character').length,
      scenes: mine.filter((a) => a.kind === 'scene').length,
      shots: shots.filter((s) => s.projectId === p.id).length,
    }
  })
  return success(c, { items })
})

/** 删除 MV 项目：连人物/场景/分镜记录一起删（不动磁盘上的 static 文件） */
app.delete('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, id))
  await db.delete(schema.mvAssets).where(eq(schema.mvAssets.projectId, id))
  await db.delete(schema.mvProjects).where(eq(schema.mvProjects.id, id))
  logTaskSuccess('MV', 'delete-project', { id })
  return success(c, { ok: true })
})

/**
 * 把在跑的生成任务状态同步回 mv_shots（含舞蹈段裁切、落库、耗时、封面）。
 * 🔴 原来这段逻辑只写在 GET /projects/:id 里 —— 只有页面轮询才触发，没人打开那一页就永远不裁
 *    （2026-10-28 实测：段4 两次都交付 328 帧整片、库里 videoUrl 不更新、日志里连 dance-seam 都没有）。
 *    现在抽成函数：路由调它（保持原行为），下面的定时器也调它（不依赖前端）。
 */
async function syncShotTasks(project: any): Promise<void> {
  // 🔴 2026-10-28：定时器和页面轮询会同时进来（实测 19:58:09 / 19:58:11 两次同时裁同一个文件 →
  //    第二次读到被 rename 掉的旧 inode，产出 261 字节空片并覆盖了成品）。同一项目串行。
  const _pid = Number(project.id)
  if (_syncBusy.has(_pid)) return
  _syncBusy.add(_pid)
  try {
  const shots = await shotsOf(Number(project.id))
  for (const s of shots) {
    if (s.status === 'processing' && s.taskId) {
      const [t] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(s.taskId)))
      if (t && t.status !== 'processing') {
        const patch: Record<string, any> = { status: t.status, updatedAt: now() }
        if (t.localPath) {
          // 旧的那条推进历史（预览区「历史视频」用），再换成本次结果
          if (s.videoUrl && s.videoUrl !== t.localPath) {
            let hist: string[] = []
            try { hist = JSON.parse(String(s.history || '[]')) } catch { hist = [] }
            patch.history = JSON.stringify([s.videoUrl, ...hist.filter((h) => h !== s.videoUrl)].slice(0, 20))
          }
          // 舞蹈 MV 不能按 shot.frames 裁：续段拿回来的是 latent 拼接后的整片（396 帧），
          // 裁成 192 帧就变成「首段画面 + 无音轨」（trimToSegment 里 -an 且舞蹈没有原曲可切）。
          // 舞蹈续段拿到的是整片（latent 拼接结果）→ 只取尾部本段那一段，保留音轨；
          // 首段长度本来就等于本段，函数里会直接返回原文件。
          const _isDanceShot = String(project.kind || 'song') === 'dance'
          // 前面各段的帧数之和 = 本段在整片里的起始帧（不能拿整片长度减本段长度倒推，
          // 那会用 DB 里的旧 frames 算出偏移，实测多裁 12 帧、段2 错位）
          // 整片只含「上一段 + 本段」两段（31 节点只载入最后一段 latent），不是全部前序段。
          // 所以本段在整片里的起点 = 紧邻上一段的帧数，累加所有前序段会多减（段3 会从 316 起裁 → 只剩 29 帧）。
          const _prevShot = _isDanceShot
            ? shots.filter((x) => (Number(x.shotNumber) || 0) < (Number(s.shotNumber) || 0))
                .sort((a, b) => (Number(b.shotNumber) || 0) - (Number(a.shotNumber) || 0))[0]
            : undefined
          // 🔴 2026-10-26 修接缝重复帧：原来直接拿上一段的 shot.frames（App 请求帧数，
          //    如 158）当起点，但中转整片里上一段实际占的是 snap17(frames+CTX)-CTX。
          //    实测段3：整片 345 帧 = 上一段 170 + 本段 175，而 skip 取 158 →
          //    取到「段2 尾部多 12 帧 + 本段前 146 帧」，成片开头重复段2 画面
          //    （量接缝：段2 末帧 vs 段3 0.167s 的 SSIM 0.972）。
          // 🔴 2026-10-28（用户听出「段3 音乐跳了一下」后实测）：基线必须是上一段**真实交付帧数**。
          //    原来 `resnapFrameCount(frames)` 把 158 抬成 170，反解一失败就退回 170 →
          //    整段（含音轨）后移 12 帧 = 0.49s（实测段3 音轨落在源片 13.66s，应 13.17s；
          //    段4 落在 20.24s，应 19.75s；段2 只偏 1 帧所以听不出来）。
          //    算式实锤：整片音频从 PREV_START 起，skip 170 → 6.58+170/24 = 13.663s = 实测值，
          //    所以本段在整片里的起点就等于上一段交付帧数（158），17 帧吸附多出来的量不该算进来。
          // 🔴 2026-10-28（用户「段3 和段2 音乐又不连续」）：基线必须是上一段**实际交付帧数**，
          //    不能再用 shot.frames（计划值 158）。算式：整片音轨从 PREV_START 起，音频 skip 的物理真值
          //    = 本段起点 S_n − PREV_START = 上一段交付帧数（段3 = 170）。用计划的 158+5=163 当基线，
          //    音频就落在源片 321 帧、画面在 328 帧 → 音乐比画面早 7 帧（0.29s）= 听着跳一下。
          const _prevFrames = _prevShot
            ? (await countVideoFrames(getAbsolutePath(String(_prevShot.videoUrl || ''))) ||
               Math.max(0, Math.round(Number(_prevShot.frames) || 0)))
            : 0
          // 上一段的绝对路径：裁切时用它尾部音频反解本段在整片里的真实起点（方案 A）
          const _prevAbs = _prevShot?.videoUrl ? getAbsolutePath(String(_prevShot.videoUrl)) : undefined
          let _genFrames = 0
          try {
            const _pp = JSON.parse(String((t as any).params || '{}'))
            const _gf = Number(_pp?.timing?.genFrames)
            if (Number.isFinite(_gf) && _gf > 0) _genFrames = Math.round(_gf)
          } catch { _genFrames = 0 }
          patch.videoUrl = _isDanceShot
            ? await trimDanceSegmentTail(t.localPath, s, _prevFrames, _prevAbs, _genFrames)
            : await trimToSegment(t.localPath, s, project.songFile as string)   // 多给的 warmup 前导帧裁掉，否则拼接口型错位
          // 耗时口径照短剧：优先用中转/ComfyUI 回报的真值 timing.genSeconds（纯生成），没有才退回挂钟差
          let genSec = 0
          try {
            const pp = JSON.parse(String((t as any).params || '{}'))
            const g = Number(pp?.timing?.genSeconds)
            if (Number.isFinite(g) && g > 0) genSec = Math.round(g)
          } catch { genSec = 0 }
          if (!genSec) {
            const c0 = Date.parse(String((t as any).createdAt || ''))
            const c1 = Date.parse(String((t as any).completedAt || ''))
            if (Number.isFinite(c0) && Number.isFinite(c1) && c1 > c0) genSec = Math.round((c1 - c0) / 1000)
          }
          if (genSec) patch.elapsedSeconds = genSec
          // 任务列表的缩略图 = 视频首帧（抽帧失败不阻断，前端按 404 兜底）
          try { await extractVideoPoster(t.localPath) } catch { /* 忽略 */ }
        }
        if (t.errorMsg) patch.errorMsg = t.errorMsg
        await db.update(schema.mvShots).set(patch).where(eq(schema.mvShots.id, s.id))
        Object.assign(s, patch)
      }
    }
  }
  } finally { _syncBusy.delete(_pid) }
}

// 不依赖前端轮询：每 12 秒自己扫一遍「有段在 processing」的项目跑同一套同步。
// 唯一代价是偶发并发（页面轮询 + 定时器同时进来）会各裁一次；裁切函数对已裁过的文件是幂等的
// （skip 超界时 want ≤ 2 直接原样返回），不会把片子越裁越短。
const _syncBusy = new Set<number>()
setInterval(() => {
  void (async () => {
    try {
      const rows = await db.select().from(schema.mvShots).where(eq(schema.mvShots.status, 'processing'))
      const ids = [...new Set(rows.map((r: any) => Number(r.projectId)).filter(Boolean))]
      for (const pid of ids) {
        // 锁在 syncShotTasks 里面（它自己也加锁）—— 这里再加一层会让内层直接 return，定时器永远不干活
        const p = await loadProject(pid)
        if (p) await syncShotTasks(p)
      }
    } catch (e: any) {
      console.log('[mv-sync] 定时同步失败', String(e?.message || e).slice(0, 200))
    }
  })()
}, 12000)

app.get('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  await syncShotTasks(project)
  const shots = await shotsOf(id)
  // 历史视频：只认本段 task_ids 里记的任务（短剧分镜 id 与 MV 段 id 会撞号，不能用 storyboard_id 反查）
  const taskOwner = new Map<number, number>()
  const allTaskIds: number[] = []
  for (const x of shots as any[]) {
    try {
      for (const t of JSON.parse(String(x.taskIds || '[]'))) {
        const n = Number(t)
        if (Number.isFinite(n)) { allTaskIds.push(n); taskOwner.set(n, x.id) }
      }
    } catch { /* 脏数据忽略 */ }
  }
  const ownerShotId = (tid: number) => taskOwner.get(Number(tid)) ?? null
  const tasks = allTaskIds.length
    ? await db.select().from(schema.sysTask)
      .where(and(eq(schema.sysTask.type, 'video'), inArray(schema.sysTask.id, allTaskIds)))
      .orderBy(desc(schema.sysTask.id)).limit(500)
    : []
  const merges = await db.select().from(schema.mvMerges)
    .where(and(eq(schema.mvMerges.projectId, id), isNull(schema.mvMerges.deletedAt)))
    .orderBy(desc(schema.mvMerges.id)).limit(200)
  // GPU 是串行排队：一条任务的「真实开始时间」= max(它自己的 createdAt, 上一条完成的时间)。
  // 不做这个换算，运行中的那行会从「提交时间」开始算，看起来像全片总耗时（实测分镜21 排了 38 分钟）。
  const ordered = [...tasks].sort((a: any, b: any) => Number(a.id) - Number(b.id))
  const effStart = new Map<number, string>()
  let lastDone = ''
  for (const t of ordered as any[]) {
    const c0 = String(t.createdAt || '')
    const start = lastDone && Date.parse(lastDone) > Date.parse(c0) ? lastDone : c0
    effStart.set(Number(t.id), start)
    const c1 = String(t.completedAt || '')
    if (c1 && (!lastDone || Date.parse(c1) > Date.parse(lastDone))) lastDone = c1
  }
  return success(c, {
    project, assets: await assetsOf(id),
    libraryAssets: await libraryAssetsOf(undefined, Number((project as any).seriesId) || undefined, id),
    shots, merges,
    videoTasks: tasks.map((t: any) => ({
      id: t.id, shotId: ownerShotId(t.id), url: t.localPath || t.resultUrl || '',
      status: t.status, createdAt: t.createdAt, startedAt: effStart.get(Number(t.id)) || t.createdAt,
      error: t.errorMsg || null,
    })),
  })
})

app.delete('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.mvProjects).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  return success(c, null)
})

/** 建项目：只做本地的事（落库 + 存歌 + 读时长），不碰 服务器 */
app.post('/projects', async (c) => {
  let body: any
  try { body = await c.req.json() } catch (err: any) { return badRequest(c, `请求体不是 JSON: ${err?.message}`) }
  const kind = String(body?.kind || 'song') === 'dance' ? 'dance' : 'song'
  if (kind === 'song' && !body?.song?.data) return badRequest(c, '缺 song.data（歌的 base64/data URL）')
  const maxShot = Math.min(HARD_MAX_S, Math.max(5, Number(body.max_shot_seconds) || DEFAULT_MAX_S))
  const ts = now()
  try {
    let useSeries = Number(body.series_id) || 0
    if (!useSeries) {
      const ins0 = await db.insert(schema.mvSeries).values({
        title: String(body.title || '未命名 MV 项目').slice(0, 80),
        style: String(body.style || '') || null,
        aspectRatio: String(body.aspect_ratio || '16:9').slice(0, 10),
        createdAt: ts, updatedAt: ts,
      } as any)
      useSeries = getInsertId(ins0)
    }
    const res = await db.insert(schema.mvProjects).values({
      seriesId: useSeries,
      title: String(body.title || '未命名 MV').slice(0, 80),
      idea: String(body.idea || '').slice(0, 2000),
      lyrics: String(body.lyrics || '').slice(0, 8000),
      style: String(body.style || '').slice(0, 60),
      storyPrompt: String(body.story_prompt || '').slice(0, 20000),
      kind,
      aspectRatio: String(body.aspect_ratio || '16:9').slice(0, 10),   // 2026-10-19 新建默认 16:9（横屏）
      maxShotSeconds: maxShot,
      status: 'draft',
      createdAt: ts, updatedAt: ts,
    })
    const id = getInsertId(res)
    const rel = mvDir(id)
    if (kind === 'dance') {
      logTaskSuccess('MV', 'create-project', { id, kind })
      return created(c, { id, kind, song_seconds: 0 })
    }
    const srcExt = String(body.song.name || '').toLowerCase().endsWith('.wav') ? '.wav' : '.mp3'
    const songRel = `${rel}/song_src${srcExt}`
    fs.writeFileSync(getAbsolutePath(songRel), b64ToBuffer(String(body.song.data)))
    const seconds = await probeSeconds(getAbsolutePath(songRel))
    await db.update(schema.mvProjects).set({ songFile: songRel, songSeconds: seconds, updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'create-project', { id, seconds })
    return created(c, { id, song_seconds: seconds })
  } catch (err: any) {
    logTaskError('MV', 'create-project', { error: err?.message })
    return serverError(c, err?.message || '建 MV 项目失败')
  }
})


/** 舞蹈 MV：上传参考视频 → 自动适配备份（全尺寸源片 + 半分辨率参考）→ 推 4080 → 按视频自然切段 */
app.post('/projects/:id/dance', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  let body: any
  try { body = await c.req.json() } catch (err: any) { return badRequest(c, `请求体不是 JSON: ${err?.message}`) }
  if (!body?.video?.data) return badRequest(c, '缺 video.data（参考视频 base64/data URL）')
  const [W, H] = videoSize(project)
  try {
    const rel = mvDir(id)
    const ext = (String(body.video.name || '').toLowerCase().match(/\.(mp4|mov|mkv|webm)$/) || [, 'mp4'])[1]
    const origRel = `${rel}/dance_orig.${ext}`
    fs.writeFileSync(getAbsolutePath(origRel), b64ToBuffer(String(body.video.data)))
    const full = getAbsolutePath(origRel)
    const meta = await probeVideoMeta(full)
    if (!meta.seconds) return badRequest(c, '读不出视频时长（文件可能损坏）')
    const totalFrames = Math.max(24, Math.round(meta.seconds * 24))
    if (totalFrames < 124) return badRequest(c, '参考视频太短：H3 单段最少 124 帧（5.17 秒）')
    const srcRel = `${rel}/dance_src.mov`
    const refRel = `${rel}/dance_ref.mov`
    await toDanceMov(full, getAbsolutePath(srcRel), W, H)
    await toDanceMov(full, getAbsolutePath(refRel), Math.round(W * DANCE_REF_SCALE), Math.round(H * DANCE_REF_SCALE))
    const srcName = `mv_p${id}_dance_src.mov`
    const refName = `mv_p${id}_dance_ref.mov`
    await shimPost('/v2/mv/video', { name: srcName, data: readAsDataUrl(srcRel, 'video/quicktime') })
    await shimPost('/v2/mv/video', { name: refName, data: readAsDataUrl(refRel, 'video/quicktime') })
    await db.update(schema.mvProjects).set({
      kind: 'dance', danceSource: srcName, danceRefSource: refName, danceFrames: totalFrames,
      songSeconds: Math.round((totalFrames / 24) * 1000) / 1000, updatedAt: now(),
    } as any).where(eq(schema.mvProjects.id, id))
    // 自然切段：清旧段 → 按 17n+5 网格 + 每段 ≤「最长分镜」重排
    const segs = planDanceSegments(totalFrames, danceMaxFrames(project.maxShotSeconds))
    await rebuildDanceShots(id, segs)
    logTaskSuccess('MV', 'dance-upload', { id, frames: totalFrames, shots: segs.length })
    return success(c, {
      frames: totalFrames, seconds: Math.round((totalFrames / 24) * 1000) / 1000,
      source: srcName, ref: refName, shots: segs,
      dropped: segs.length ? segs[segs.length - 1].dropped : totalFrames,
    })
  } catch (err: any) {
    logTaskError('MV', 'dance-upload', { id, error: err?.message })
    return serverError(c, err?.message || '舞蹈视频适配失败')
  }
})

/** 舞蹈 MV：按页面填的「最长分镜」重切（不重传视频，源片帧数已存库里） */
app.post('/projects/:id/dance-split', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  if (String(project.kind || 'song') !== 'dance') return badRequest(c, '这不是舞蹈 MV 项目')
  const totalFrames = Number(project.danceFrames) || 0
  if (totalFrames < DANCE_MIN_FRAMES) return badRequest(c, '还没上传参考视频（先上传，后台会自动切段）')
  const body = await c.req.json().catch(() => ({} as any))
  const maxS = Math.min(HARD_MAX_S, Math.max(5, Number(body.max_seconds || project.maxShotSeconds) || DEFAULT_MAX_S))
  try {
    const segs = planDanceSegments(totalFrames, danceMaxFrames(maxS))
    if (!segs.length) return badRequest(c, '源片太短，切不出合法段')
    await rebuildDanceShots(id, segs)
    await db.update(schema.mvProjects).set({ maxShotSeconds: maxS, status: 'shots', updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'dance-split', { id, frames: totalFrames, shots: segs.length, maxS })
    return success(c, { max_seconds: maxS, shots: segs, dropped: segs[segs.length - 1].dropped })
  } catch (err: any) {
    logTaskError('MV', 'dance-split', { id, error: err?.message })
    return serverError(c, err?.message || '重新切段失败')
  }
})

/** 舞蹈 MV：用项目里的人物/场景提示词，给每段编译英文六段稿（动作来源写死 <Video 1>） */
app.post('/projects/:id/dance-prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const shots = await db.select().from(schema.mvShots)
    .where(eq(schema.mvShots.projectId, id)).orderBy(schema.mvShots.shotNumber)
  if (!shots.length) return badRequest(c, '还没有段，先上传参考视频')
  const body: any = await c.req.json().catch(() => ({}))
  // 每次点「编译舞蹈提示词」都真调模型翻译（body.regenerate 只是显式声明；不传也按 true 走）
  // —— 否则同一段中文第二次编译直接命中内存缓存，点了像没执行（用户 2026-10-24 报的）
  const regen = body?.regenerate === undefined ? true : !!body.regenerate
  const total = shots.length
  let n = 0
  // 服装/场景以资产为准：项目层 characterPrompt/scenePrompt 大多为空，靠它们会退化成通用兜底句，
  // 模型每段各理解一遍服装 → 跨段换衣。这里与出片路由取同一来源，保证「点编译」和「出片」一致。
  const assets = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.projectId, id))
  const charAsset = assets.find((a) => a.kind === 'character')
  const sceneAsset = assets.find((a) => a.kind === 'scene')
  const outfit = String(charAsset?.styling || charAsset?.appearance || '').trim()
  // 🔴 三份描述**只翻一次**，全部段共用同一份英文：
  //    每段各翻一次的话，模型每次措辞都不同 → 段1 和段2 的人物/服装描述对不上 → 跨段漂移。
  const whoRaw = danceWhoText(project, charAsset)
  const sceneRaw = project.scenePrompt || sceneAsset?.description || ''
  // 串行：三并发容易撞超时（见 compileDancePromptEn 注释）
  const whoEn = await toEnglish(whoRaw, project.textConfigId ?? null, false, regen)
  const outfitEn = await toEnglish(outfit, project.textConfigId ?? null, false, regen)
  const sceneEn = await toEnglish(sceneRaw, project.textConfigId ?? null, true, regen)
  // 画风预设的英文风格头（只取标记之前那段）；查不到就是空串 → 模板退回「a <key> dance clip」
  const styleHead = (await getStyleSpecByValue(project.style)).head
  for (const sh of shots) {
    const en = await compileDancePromptEn({
      characterPrompt: whoEn, outfit: outfitEn, scenePrompt: sceneEn,
      style: project.style || '', styleHead, frames: Number(sh.frames) || 124,
      shotNo: Number(sh.shotNumber) || 1, totalShots: total,
      // 🔴 2026-10-26：原来这里没传 actionZh ——「编译舞蹈提示词」编出来的稿子天生
      //    没有 `the sequence of moves` 那句，界面显示 6821 字符/四段完全一样，
      //    而点「生成视频」走的是另一条带 actionZh 的路径、会重新编译覆盖。
      //    于是界面上核对到的提示词 ≠ 实际出片用的提示词（段1/段2 成片好、界面看不到动作句）。
      //    补上，让两条路径编出同一份。
      actionZh: danceActionText(project, sh),
      force: false,                  // 译文已在上面翻好，这里不再翻
    })
    const zh = compileDancePromptZh({ frames: Number(sh.frames) || 124,
      shotNo: Number(sh.shotNumber) || 1, totalShots: total })
    await db.update(schema.mvShots).set({ promptEn: en, prompt: zh, updatedAt: now() })
      .where(eq(schema.mvShots.id, sh.id))
    n++
  }
  logTaskSuccess('MV', 'dance-prompts', { id, shots: n })
  return success(c, { count: n })
})

/** 改项目（标题 / 风格 / 分镜提示词 / 想法 / 歌词 / 最长切分） */
app.put('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body = await c.req.json().catch(() => ({} as any))
  let seriesId = Number(body?.series_id) || 0
  const patch: Record<string, any> = { updatedAt: now() }
  if (body.title !== undefined) {
    const t = String(body.title).trim().slice(0, 80)
    if (!t) return badRequest(c, '标题不能为空')
    patch.title = t
  }
  if (body.style !== undefined) patch.style = String(body.style).slice(0, 60)
  if (body.aspect_ratio !== undefined) patch.aspectRatio = String(body.aspect_ratio).slice(0, 10)
  for (const [k, col] of [['text_config_id', 'textConfigId'], ['image_config_id', 'imageConfigId'], ['video_config_id', 'videoConfigId']] as const) {
    if (body[k] !== undefined) patch[col] = body[k] === null || body[k] === '' ? null : Number(body[k]) || null
  }
  if (body.story_prompt !== undefined) patch.storyPrompt = String(body.story_prompt).slice(0, 20000)
  if (body.idea !== undefined) patch.idea = String(body.idea).slice(0, 2000)
  if (body.lyrics !== undefined) patch.lyrics = String(body.lyrics).slice(0, 8000)
  if (body.max_shot_seconds !== undefined) {
    patch.maxShotSeconds = Math.min(HARD_MAX_S, Math.max(5, Number(body.max_shot_seconds) || DEFAULT_MAX_S))
  }
  await db.update(schema.mvProjects).set(patch).where(eq(schema.mvProjects.id, id))
  return success(c, { project: await loadProject(id) })
})

// ---------------------------------------------------------------- 人物 / 场景（MV 自己的资产表）

/** 从分镜提示词提取人物 + 场景（覆盖式重建；不动短剧的 characters / scenes） */
app.post('/projects/:id/extract', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const story = String(body.story_prompt ?? project.storyPrompt ?? '').trim()
  if (!story) return badRequest(c, '先填分镜提示词，再提取人物和场景')
  // 2026-10-20 用户报「资产提取的场景跟初步分镜对不上」：以前只喂全局的分镜提示词，
  // 而初步分镜（outline）每段已经写了具体地点/光线/氛围 —— 提取必须以它为准。
  let outlineTxt = ''
  try {
    const rows = JSON.parse(String(project.outline || '[]'))
    if (Array.isArray(rows) && rows.length) {
      outlineTxt = rows.map((x: any) => `[${Number(x.start).toFixed(2)}-${Number(x.end).toFixed(2)}s] ${String(x.what || '')}`).join('\n')
    }
  } catch { outlineTxt = '' }
  const outlineBlock = outlineTxt
    ? `\n这支 MV 的**初步分镜**（已定稿，每段就是实际要拍的画面，场景必须照它来）：\n"""\n${outlineTxt.slice(0, 8000)}\n"""\n`
    : ''
  const ask = `下面是这支 MV 的分镜提示词（用户写的）：

"""
${story.slice(0, 12000)}
"""
${outlineBlock}
请从中提取**人物**和**场景**，**严格按上面那份规范**填字段（规范里要求的四项颜色、禁模糊词、字数都要照做）：
1) **人物**只提取这份分镜提示词/初步分镜里真实出现过的，不要自己发明人物、不要补充没写的人。
1a) 🔴 **MV 是单人演唱，人物宁少不多**：最多 4 个，按重要性排序，**第一个必须是把这首歌唱出来的主角**（后面按 sortOrder 第一个即主唱）。只传一个就只提一个；写「路人/观众/乐队」这类群体时不单独建人物。配角只写它在这支 MV 里的身份（朋友/观众/乐队），并在 description 末尾注明「画面里不唱歌、不对嘴、嘴一直闭着」。
1b) 🔴 **场景以上面的初步分镜为准**：把初步分镜里出现的地点归并成 1~3 个场景，**名字和 description 直接用分镜里写的那个地点/光线/氛围**（分镜写「海边黄昏」就不要写成「海边·日」），不许换地方、不许只按全局提示词编。
1c) 场景**至少 1 个**：初步分镜和分镜提示词都没点名地点时（例如只写「按歌词适配合适的场景」），才根据歌词和画面自己定 1~3 个最合适的场景（用户要求的适配，不算发明），名字写成「地点+时间」。
1d) **道具（props）**：只提**关键道具**——必须同时满足「删掉它剧情/画面就不成立」和「值得单独出图（会被特写或反复出现，需要固定外观）」。判定三问，任一答否就放弃：① 删掉它画面是否依然成立？成立 → 不提；② 只是随手用的日常物品（手机、杯子、筷子、烟）吗？是 → 不提；③ 是场景陈设（桌椅、灯具、门窗、装饰）吗？是 → 不提。
   例外：某个日常物品**本身承载关键信息**（纸条上的字、证件、通知书、屏幕上的通知）且分镜会给它特写时**要提**，此时判定的对象是「信息载体」而不是「手机」这个物品——name 写清载体（如「录取通知书」），description 里把要显示的文字逐字写出来（加英文双引号，单行中文 ≤6 字）。
   **宁可少提**：0~3 个，按重要性只留前 3 个；没有就返回空数组，不许凑数。
   🔴 道具 description 只写**物品本身的物理外观**（材质、颜色、形状、大小、新旧磨损），**不写剧情用途、不写和人物的关系、不写它怎么被使用**；**不许写姿态/朝向**（躺平、立着、正面朝上），姿态交给视频。
   🔴 场景 description 里**不要写这些道具**（它们有自己的资产和参考图，写进场景图会把道具画进空镜里）。
2) 人物 appearance（样貌）按规范写成 **300~500 字**：性别、年龄感、五官、发型发色、**肤色的色阶与明暗**、体态、气质（性格要转成外在神态写，不要直接写性格词）。
3) 人物 styling（妆造）：发型、服装、妆面、配饰 —— **每件单品都要写颜色**（外套/上衣/裤子/鞋），配饰写颜色或材质。
4) 人物 description = 样貌 + 妆造的完整合并描述（同样写长写具体，不要只有一句）。
5) 🔴 四项颜色（发色 / 肤色 / 服装颜色 / 配饰颜色或材质）一个都不能少；**禁止「或」「或者」「可能」「皆可」这类二选一**，原文带「或」就当场挑定一个写死。
6) 场景 description：地点、时间、光线、色调、氛围、前景/中景/后景层次（写具体，不要一句话带过）。
7) name 用简短中文名（人物用名字或代称，场景用「地点+时间」）；同一个人的不同叫法合并成一个人。
7b) 🔴 **道具名必须用歌词/初步分镜里出现过的那个词**（歌词写「宵夜」就命名「宵夜」，别写成「外卖保温袋」这种类别名）——下游是按名字把道具绑到分镜上的，名字对不上就绑不上。确实没有原词的才用最常见的日常叫法。
8) 没有人物就返回空的人物数组，但 **scenes 不许为空**（至少 1 个）。

只输出 JSON：
{"characters":[{"name":"","description":"","appearance":"","styling":""}],"scenes":[{"name":"","description":""}],"props":[{"name":"","description":""}]}
appearance 只写脸/身形容貌，styling 只写服装配饰；拆不出来就留空。`
  try {
    const out = pickJson<{ characters?: any[]; scenes?: any[]; props?: any[] }>(
      await askText(
        await mvPrompt('mv_extractor'),
        ask, 6000, project.textConfigId))
    // 兜底：模型还是没给场景 → 只问一次「这首歌词该配什么场景」（有界 1 次，不循环）
    if (!Array.isArray(out.scenes) || !out.scenes.length) {
      try {
        const lyricBlock = String(project.lyrics || '').slice(0, 3000) || '（无）'
        const fix = pickJson<{ scenes?: any[] }>(await askText(
          await mvPrompt('mv_extractor'),
          `这支 MV 用户没有点名场景，只要求「按歌词适配合适的场景」。下面是分镜提示词和歌词：\n\n"""\n${story.slice(0, 8000)}\n"""\n\n${outlineTxt ? `初步分镜（场景以它为准）：\n"""\n${outlineTxt.slice(0, 6000)}\n"""\n\n` : ''}歌词：\n${lyricBlock}\n\n` +
          `请据此定 1~2 个最合适的场景（名字写成「地点+时间」），每个按规范写 description（地点、时间、光线、色调、氛围、前景/中景/后景层次）。` +
          `只输出 JSON：{"scenes":[{"name":"","description":""}]}`, 3000, project.textConfigId))
        if (Array.isArray(fix?.scenes) && fix.scenes.length) out.scenes = fix.scenes
      } catch (e: any) {
        logTaskError('MV', 'extract-scene-fallback', { id, error: e?.message })
      }
    }
    if (!Array.isArray(out.scenes) || !out.scenes.length) {
      return serverError(c, '场景没提取出来（模型只给了人物）。把分镜提示词里的地点写具体一点，或再点一次「提取人物和场景」。')
    }
    const ts = now()
    await db.delete(schema.mvAssets).where(eq(schema.mvAssets.projectId, id))
    let sort = 0
    for (const kind of KINDS) {
      const list = (kind === 'character' ? out.characters : kind === 'prop' ? (out as any).props : out.scenes) || []
      for (const a of list) {
        const desc = String(a?.description || '').trim()
        const name = String(a?.name || '').trim()
        if (!desc && !name) continue
        await db.insert(schema.mvAssets).values({
          seriesId: Number((project as any)?.seriesId) || null,
          projectId: id,
          kind,
          name: name.slice(0, 60) || (kind === 'character' ? `人物${sort + 1}` : kind === 'prop' ? `道具${sort + 1}` : `场景${sort + 1}`),
          description: desc.slice(0, 4000),
          appearance: String(a?.appearance || '').slice(0, 2000),
          styling: String(a?.styling || '').slice(0, 2000),
          sortOrder: sort++,
          createdAt: ts, updatedAt: ts,
        })
      }
    }
    logTaskSuccess('MV', 'extract', { id, characters: out.characters?.length || 0, scenes: out.scenes?.length || 0 })
    const fresh = await assetsOf(id)
    // 同名提醒：素材库里已经有同名角色/场景时**不擅自决定**，交前端问一句「用库里的还是新提取的」
    const libs = await libraryAssetsOf()
    const key = (s: any) => String(s || '').replace(/\s+/g, '').trim()
    // 同名判定放宽到「一方包含另一方」：库里「林小雅」要能对上提取出的「小雅」，
    // 否则名字稍有差别就漏掉，用户就会重复建人（2026-10-24 用户点名要优先用库里的）。
    const sameName = (x: any, y: any) => {
      const a = key(x), b2 = key(y)
      if (!a || !b2) return false
      if (a === b2) return true
      const [short, long] = a.length <= b2.length ? [a, b2] : [b2, a]
      return short.length >= 2 && long.includes(short)
    }
    const conflicts = fresh
      .filter((a: any) => !a.image && libs.some((l: any) => sameName(l.name, a.name) && l.kind === a.kind))
      .map((a: any) => {
        const l = libs.find((x: any) => sameName(x.name, a.name) && x.kind === a.kind) as any
        return { assetId: a.id, name: a.name, kind: a.kind, libraryId: l.id, libraryName: l.name, hasImage: !!l.image }
      })
    return success(c, { assets: fresh, conflicts })
  } catch (err: any) {
    logTaskError('MV', 'extract', { id, error: err?.message })
    return serverError(c, `提取失败：${err?.message}`)
  }
})

/** 改单个资产（名字 / 描述 / 容貌 / 服装） */
app.put('/projects/:id/assets/:aid', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const asset = await assetInProject(id, aid)
  if (!asset) return notFound(c, '资产不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const patch: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) patch.name = String(body.name).slice(0, 60)
  if (body.description !== undefined) patch.description = String(body.description).slice(0, 4000)
  if (body.appearance !== undefined) patch.appearance = String(body.appearance).slice(0, 2000)
  if (body.styling !== undefined) patch.styling = String(body.styling).slice(0, 2000)
  if (body.prompt !== undefined) patch.prompt = String(body.prompt)
  if (body.prompt_extra !== undefined) patch.promptExtra = String(body.prompt_extra || '').slice(0, 1200)
  if (body.ref_ids !== undefined) patch.refIds = JSON.stringify(
    (Array.isArray(body.ref_ids) ? body.ref_ids : []).map(Number).filter(Boolean)).slice(0, 4000)
  await db.update(schema.mvAssets).set(patch).where(eq(schema.mvAssets.id, aid))
  return success(c, { assets: await assetsOf(id) })
})

app.delete('/projects/:id/assets/:aid', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const doomed = await assetInProject(id, aid)
  if (!doomed) return notFound(c, '资产不存在')
  // 2026-10-28：这里的删除只管「这首 MV 里的卡片」。素材库条目、别人歌里的行、图/卡文件一律不动：
  // 只把 project_id 摘成 0（0 = 不隶属任何歌），series_id 保留，所以项目素材库 Tab 里照旧看得见。
  const owned = Number((doomed as any).projectId) === id
  if (!owned || String((doomed as any).scope || 'project') === 'library') {
    await db.update(schema.mvAssets).set({ projectId: 0, updatedAt: now() } as any)
      .where(eq(schema.mvAssets.id, aid))
    return success(c, { assets: await assetsOf(id), keptInLibrary: true })
  }
  await db.delete(schema.mvAssets).where(eq(schema.mvAssets.id, aid))
  return success(c, { assets: await assetsOf(id) })
})

/** 资产提示词规则：直接用短剧的那两份 skill（人物板 / 场景），读不到才回退 MV 自己的指令 */
async function assetRule(kind: string): Promise<string> {
  // 2026-10-19：MV 只读**自己那份**（skills/mv/*），不再借短剧的 prompt-generator（用户要求两边彻底隔离）
  const own = readSkillFile(kind === 'character' ? 'mv/character-prompt' : kind === 'prop' ? 'mv/prop-prompt' : 'mv/scene-prompt')
  return own || (await mvPrompt('mv_asset_image'))
}

/**
 * 给资产生成「生图提示词」（照短剧：描述 → 生成提示词 → 出图）
 *
 * 规则来自 MV 自己的 skill（skills/mv/character-prompt、skills/mv/scene-prompt —— 与短剧彻底隔离），
 * 输出＝**风格头在最前 + 中文资产描述 + skill 规定的构图**（与短剧 final_prompt 同款），存进 mv_assets.prompt。
 */
app.post('/projects/:id/assets/:aid/prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const asset = await assetInProject(id, aid)
  if (!asset) return notFound(c, '资产不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const desc = String(body.description ?? asset.description ?? '').trim()
  if (!desc) return badRequest(c, '这个资产还没有描述 —— 先写清外貌/场景，再生成提示词')
  if (body.description !== undefined || body.name !== undefined) {
    await db.update(schema.mvAssets).set({
      description: desc.slice(0, 4000),
      name: String(body.name ?? asset.name ?? '').slice(0, 60),
      updatedAt: now(),
    }).where(eq(schema.mvAssets.id, aid))
  }
  const rule = await assetRule(asset.kind)
  const head = await styleHead(project)
  try {
    const text = await askText(
      `${rule}\n\n` +
      `【本次任务】把这个资产写成**一条可以直接出图**的最终提示词，按下面的顺序：\n` +
      `1. **第一段必须是画风（原样照抄，一个字都不要改、不要翻译）**：${head || '（这个项目没选画风，用写实电影感代替）'}\n` +
      `2. **画风之后用中文写资产本身**：名字 → 样貌（脸/身形，颜色写死唯一值）→ 妆造（服装/配饰，颜色与款式逐字保留）→ 场景（地点/时间/光线/色调/氛围，人物资产才写，场景资产写描述里的全部要点）。\n` +
      `3. 构图按上面那份规范逐字落地：${asset.kind === 'character'
        ? '一帧画面里从左到右三个竖版画格、纯白背景——格1 正面全身、格2 左侧面全身、格3 背面全身，三格都是完整人物：头、脸、五官、发型正常画出，头顶到脚底完整入镜（含鞋），三格景别完全一致、都是全身，不许出现胸像/半身/特写；'
        : '固定视角，前景/中景/后景分层，画面里不出现任何人'}。\n` +
      `   ⚠️ 三格一律全身：**禁止写「特写」「胸像」「半身」「大头照」** —— 特写格会被视频模型当成一个镜头照抄，成片开头就出大脸。\n` +
      `   ⚠️ 人物板最后必须照抄这句收尾：「三个画格都是同一个人的完整全身：同一个脸型、同一套五官、同一个发型与发色，头顶到脚底完整入镜，三格景别一致」。\n` +
      `4. 画风段照抄，后面中文字段必须完整保留；最后可以再跟一小段英文关键词（可选）。\n` +
      `只输出提示词本身，不要解释、不要标题、不要编号、不要 markdown、不要引号包裹。`,
      `资产类型：${asset.kind === 'character' ? '人物' : '场景'}\n` +
      `名字：${asset.name || '（未命名）'}\n` +
      `样貌：${asset.appearance || '（未填）'}\n` +
      `妆造：${asset.styling || '（未填）'}\n` +
      `描述：${desc}`,
      2000,
      project.textConfigId,
    )
    const prompt = text.trim()
    if (!prompt) throw new Error('文本模型返回空')
    await db.update(schema.mvAssets).set({ prompt: prompt.slice(0, 4000), updatedAt: now() })
      .where(eq(schema.mvAssets.id, aid))
    logTaskSuccess('MV', 'asset-prompt', { id, aid, kind: asset.kind, chars: prompt.length })
    return success(c, { assets: await assetsOf(id) })
  } catch (err: any) {
    logTaskError('MV', 'asset-prompt', { id, aid, error: err?.message })
    return serverError(c, `生成提示词失败：${err?.message}`)
  }
})

/**
 * 给资产出图（走 App 图片通道）
 * 人物 = 三格定妆板（正面/左侧/背面三个完整全身，每格都有头有脸，纯白底），尺寸固定 16:9
 * 场景 = 一张场景图，尺寸跟随项目画幅；两者都拼上项目的风格头
 * 用的是上一步「生成提示词」存下来的那条提示词（没生成过不许出图）
 */
/**
 * 资产出图尺寸（照短剧）：人物板固定 16:9 = 2048x1152；场景图跟随项目画幅。
 */
const CHAR_BOARD_SIZE = '2048x1152'
const imageSizeForAsset = (project: any, kind: string): string =>
  kind === 'character' ? CHAR_BOARD_SIZE
    : kind === 'prop' ? '1024x1024'          // 道具 = 白底单品，方形（字更清楚，2026-10-20 用户拍板）
      : imageSizeForAspect(project?.aspectRatio)

/**
 * 成片画幅：H3 只认 9:16 / 16:9，其它比例按横竖就近映射。
 * ponytail: 想支持更多画幅得先让 H3 支持，别在这里造轮子。
 */
function videoSize(project: any): [number, number] {
  return String(project?.aspectRatio || '16:9') === '16:9' ? [1344, 768] : [768, 1344]
}

// ---------------------------------------------------------------- 舞蹈 MV（V2V 复刻，2026-10-23）
// 机制：源片压 latent 后只去噪 99.95% → 动作来自原片像素；参考视频另给一份半分辨率副本
// 只提供编排/节奏线索（省一半注意力开销）；人物靠 RefMods 卡锁；主生成完中转自动接修脸。
const DANCE_MODEL = 'minimax-h3-mv-dance'
const DANCE_MAX_FRAMES = 345          // 14.375s（H3 单段上限内最大的 17n+5 档）
const DANCE_MIN_FRAMES = 124          // 5+17×7，H3 单段下限（5.17s）
const DANCE_REF_SCALE = 0.5           // 参考副本 = 生成尺寸的一半

/** 页面填的「最长分镜」（秒）→ H3 帧网格上限（17n+5，夹在 124~345 帧） */
function danceMaxFrames(seconds?: number | null): number {
  const s = Math.min(HARD_MAX_S, Math.max(5, Number(seconds) || DEFAULT_MAX_S))
  const k = Math.floor((Math.round(s * 24) - 5) / 17)
  return Math.min(DANCE_MAX_FRAMES, Math.max(DANCE_MIN_FRAMES, 5 + 17 * k))
}

function probeVideoMeta(file: string): Promise<{ seconds: number; frames: number; fps: number }> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err: any, meta: any) => {
      if (err) return resolve({ seconds: 0, frames: 0, fps: 0 })
      const seconds = Number(meta?.format?.duration) || 0
      let frames = 0
      let fps = 24
      for (const s of meta?.streams || []) {
        if (s.codec_type !== 'video') continue
        frames = Number(s.nb_frames) || 0
        const r = String(s.r_frame_rate || '24/1').split('/')
        fps = Number(r[0]) / (Number(r[1]) || 1) || 24
      }
      if (!frames) frames = Math.round(seconds * fps)
      resolve({ seconds, frames, fps })
    })
  })
}

/** 源片 → H3 用的 24fps CFR mov（PCM 32k 单声道），按目标尺寸等比放大后居中裁切 */
function toDanceMov(input: string, output: string, w: number, h: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions([
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
        '-r', '24', '-pix_fmt', 'yuv420p', '-crf', '16',
        // 音频补 1 秒静音：转 24fps 后视频会多出约 1.6 帧，音频不补就会比视频短几十毫秒，
        // 顶到片尾时被 V2V 拒（source audio is N samples short）；多给比少给安全，V2V 会按目标截断
        '-af', 'apad=pad_dur=1',
      ])
      .videoCodec('libx264')
      .audioCodec('pcm_s16le').audioFrequency(32000).audioChannels(1)
      .format('mov')
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(output)
  })
}

/**
 * 按参考视频自然切段：每段吸附 17n+5 网格、≤345 帧、尽量等长。
 * 注意 H3 只认网格帧数，源片总帧数一般不在网格上 → 末尾不足一段的零头**直接丢弃**
 * （最多 123 帧 ≈ 5.1 秒），不做「合并进上一段」——那会把上一段顶出网格（自检抓到的 bug）。
 */
function planDanceSegments(total: number, maxFrames = DANCE_MAX_FRAMES): { index: number; startFrame: number; frames: number; dropped: number }[] {
  const cap = Math.min(DANCE_MAX_FRAMES, Math.max(DANCE_MIN_FRAMES, Math.round(maxFrames)))
  // 🔴 2026-10-30（源片不够用）：续接段每段**实际交付 = 规划 + 12 帧左右**（10-28 定案
  //   「交付 = 整片里本段的内容全拿走，不按规划截短」的代价），最后一个段还多要 5 帧 CTX 窗口。
  //   按 100% 规划会让前几段把源片吃光：实测 522 帧切 4 段（124/141/124/133），前 3 段实际
  //   交付 124+153+136 = 413，段4 只剩 522−413 = 109 帧 → ComfyUI 报
  //   "source becomes 115 frames at 24 fps but target needs 124"，整段失败。
  //   按 92% 规划，留出的余量（约 8%）刚好覆盖这 12 帧/段 + 5 帧尾巴。
  const usable = Math.max(DANCE_MIN_FRAMES, Math.floor(total * 0.92))
  const snapUp = (frames: number) => {
    const k = Math.max(7, Math.round((frames - 5) / 17))
    return Math.min(cap, 5 + 17 * k)
  }
  const out: { index: number; startFrame: number; frames: number; dropped: number }[] = []
  let start = 0
  while (usable - start >= DANCE_MIN_FRAMES) {
    const remain = usable - start
    // 段数按 cap 算，但均分后每段会低于 H3 下限（124 帧）时就少切一段 ——
    // 否则 240 帧/最长 10s 会切出「1 段 124 帧 + 丢弃 116 帧」（实测：源片一半没了）
    let left = Math.ceil(remain / cap)
    while (left > 1 && Math.floor(remain / left) < DANCE_MIN_FRAMES) left--
    let frames = snapUp(Math.round(Math.min(remain / left, cap)))
    if (frames > remain) frames = remain   // 不 snapDown：向下取整会漏掉末尾几帧（203→192 漏 11 帧）；中转 _snap17_up 会收口
    if (frames < DANCE_MIN_FRAMES) break
    out.push({ index: out.length + 1, startFrame: start, frames, dropped: 0 })
    start += frames
  }
  out.forEach((g) => { g.dropped = 0 })
  if (out.length) out[out.length - 1].dropped = Math.max(0, total - start)
  return out
}

/** 清掉旧段 → 按 planDanceSegments 的结果重建分镜表（上传和「重新切分」共用） */
async function rebuildDanceShots(projectId: number, segs: ReturnType<typeof planDanceSegments>) {
  const ts = now()
  await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, projectId))
  for (const g of segs) {
    await db.insert(schema.mvShots).values({
      projectId, shotNumber: g.index,
      startSeconds: g.startFrame / 24, endSeconds: (g.startFrame + g.frames) / 24,
      frames: g.frames, seconds: Math.round((g.frames / 24) * 1000) / 1000,
      shotSize: 'medium-wide', camera: 'static', vocalState: 'non_vocal',
      status: 'pending', createdAt: ts, updatedAt: ts,
    } as any)
  }
}

/**
 * 舞蹈段提示词（英文六段式）：动作来源写死 <Video 1>，人物/场景措辞直接沿用项目里那套字段，
 * 音频声明 <Audio 1>（分段 = 源片同一时间窗的原音，成片顺序拼接即成完整原声）。
 */
/** 舞蹈段的中文导演分镜稿（界面显示用）：动作/机位全部来自源片，所以只交代「复刻参考视频」。 */
/** 中文 → 英文（内存缓存；纯英文直接返回、不调 LLM）。
 *  为什么要翻：H3 的六段式是英文骨架，而资产的 appearance/styling/scene 都是中文，
 *  实测一条 5000 字符提示词里塞了 609 个中文字 —— 背景/服装约束权重被削，模型回头看源片。 */
const _enCache = new Map<string, string>()
/**
 * 翻译结果落盘缓存（按原文做 key）：内存缓存一重启就空，同一份场景中文每次生成都重译，
 * 而翻译是随机的 —— 实测同一个场景，一次翻出 351 字符（含装饰条纹/地面纹理/拱门/糖果色），
 * 背景锁住一半；另一次翻出 230 字符笼统版（只剩 outdoor plaza / colorful storefronts），
 * 背景整块变回源片。落盘后同一资产永远用同一个英文版。
 */
const _EN_CACHE_FILE = path.join(DATA_ROOT, 'cache', 'en-translations.json')
let _enDiskMemo: Record<string, string> | null = null
function enDiskRead(): Record<string, string> {
  if (_enDiskMemo) return _enDiskMemo
  try { _enDiskMemo = JSON.parse(fs.readFileSync(_EN_CACHE_FILE, 'utf8')) || {} } catch { _enDiskMemo = {} }
  return _enDiskMemo!
}
function enDiskWrite(k: string, v: string) {
  try {
    const d = enDiskRead()
    if (d[k] === v) return
    d[k] = v
    fs.mkdirSync(path.dirname(_EN_CACHE_FILE), { recursive: true })
    fs.writeFileSync(_EN_CACHE_FILE, JSON.stringify(d))
  } catch { /* 缓存写失败不影响生成 */ }
}
const _TR_FULL = 'You are a translator for a video-generation prompt. Translate the Chinese into concise, concrete English. ' +
  // 🔴 2026-10-30：这条指令同时喂给 who / outfit / 非舞蹈 scene。原来紧跟在后面的
  //   `Preserve EVERY detail — never summarise and never omit: walls, windows, doors, furniture...`
  //   与下面的 "skip performance" 直接对打，模型选了「一项都不许省」，结果把
  //   「when she begins to sing, the gaze gradually opens...」「a thin layer of mist...」
  //   「a stillness that holds feeling inward」整句翻进人物描述 → H3 照着演。
  //   现在：(1) 先立"只写看得见的外形"这条铁律；(2) 场景类名词从必保清单里拿掉（本字段不是场景）；
  //   (3) 把实测漏网的词点名禁掉。
  'Describe ONLY what is visible on the person: face, hair, skin, build, outfit, makeup. ' +
  'Never translate anything that would become an ACTION on screen: singing, humming, grinning, smiling, ' +
  'tilting the head, breathing, nodding, winking, blinking, laughing, frowning, pouting, glancing around, ' +
  'when she moves, at the close, throughout the take. Such sentences must NOT appear in your output. ' +
  // 🔴 2026-10-30：静态神态（目光/气质/沉静）是她「长什么样」的一部分，必须保留 ——
  //   上一轮连这些一起禁掉，人物段只剩虹膜+肤色+发型，实测段1 出大脸、后段人脸不稳。
  'Static descriptions of her looks and temperament ARE part of her appearance — keep them ' +
  '(e.g. "steady calm gaze", "quiet contained expression", "the features carry a stillness"). ' +
  'Preserve every detail OF THE PERSON — never summarise and never omit: garment parts, colours, materials, ' +
  'body proportions, hairstyle, and every number. ' +
  'If the source has three sentences about her look, the output must also cover all three (same order). ' +
  'Drop nothing, add nothing else. Output only the translation, no explanation.'
// 场景专用：**压缩**翻译 —— 7000 字符的硬上限下，场景全文（实测 807 字符）装不进去，
// 而「氛围、情绪、装饰性从句」对背景锁定毫无用处，真正有用的是这几个识别要素。
// 实测这条路 173 字符就把「室内 / 磨光木地板 / 落地镜墙 / 把杆 / 天花板面板灯 / 暖白色调」全带上了。
const _TR_SCENE = 'Extract the visual identifiers of this scene. Output ONLY a JSON object, no prose:\n' +
  // 2026-10-28：字段提示里的 (mirror wall / barre) 是舞蹈室偏向，用户会换各种背景 → 改成中性举例。
  '{"setting":"indoor, or outdoor + how open it is",' +
  '"walls":"walls and wall surfaces incl. windows, doors or large panels; for an open outdoor scene write what bounds the view (open horizon line, open sky)",' +
  '"floor":"floor material and finish",' +
  '"fixtures":"main fixtures or furniture in the scene",' +
  '"light":"light source + its direction + its INTENSITY (bright / soft / dim)",' +
  '"palette":"dominant colours, each one named together with what carries it — e.g. warm white stone, light blue sky, green hedges"}\n' +
  // 🔴 2026-10-30：原来的「list EVERY … 一项都不许省 + 写 sky/dusk tone」让模型自己编内容：
  //   实测编出 `distant blurred city building outlines`（画到天空成了灰蓝色模糊块）和
  //   `soft breeze`（风被写进 fixtures，画面发飘）；多出来的词又挤爆 60 词预算，把 palette 顶掉
  //   → 色温锚点丢失、整片暗 15~20 灰度。现在改成「只写真实存在的实体 + 硬禁摄影/天气词 + 六项必填」。
  'Every item matters: name the concrete objects that are really there. Never drop a real item. ' +
  'Name objects, never a general category: write "square stone tiles with thin joint lines" ' +
  'instead of "light-colored ground". ' +
  // 🔴 2026-10-30：`walls` 允许留空 —— 10-29 那份能锁背景的提示词里**根本没有 walls 项**。
  //   硬逼六项必填的后果实测是 `walls: European light-colored stone lamp posts in the background`，
  //   把灯柱当墙（语义错位），模型拿到一个错的空间结构。
  'HARD RULES: (1) setting, floor, fixtures, light and palette are all mandatory. ' +
  'walls may be an empty string ONLY when the scene is open outdoors with nothing bounding the view. ' +
  // 🔴 2026-10-30 三次修正（对照 10-29 那份能锁住背景的提示词）：
  //   那版是 `palette: warm white stones, clear light blue sky, soft green hedges` ——
  //   **每个颜色都绑着它附着的东西，而且有 sky**；`light: bright natural daylight …` 带强度词。
  //   现在这版退化成 `palette: warm white, light gray, pale blue, green`（纯色板，没有天空、没有实体）
  //   + `light: natural sunlight from the upper side direction`（没有强度）→ 场景等于没锚，背景回源片。
  '(1b) palette must name every colour WITH what carries it — "warm white stone, light blue sky, green hedges", ' +
  'never a bare colour list. For an outdoor scene the sky colour is mandatory. ' +
  '(1c) light must include an intensity word: bright / strong / soft / dim. ' +
  '(2) Describe ONLY solid physical things the camera can see. Never describe weather, wind, temperature, ' +
  'mood, atmosphere or camera optics — never write breeze, wind, draft, mist, haze, fog, dust, ' +
  'distant, blurred, out of focus, bokeh, depth of field, atmosphere. ' +
  '(3) fixtures means furniture, lamps and installed fittings only — never air, light, or the open floor area. ' +
  '(4) Do not invent objects the source does not mention. ' +
  // 🔴 2026-10-30 二次修正：原来写 4-10 词，模型给 setting 只写 "outdoor" 一个词 ——
  //   实测场景句从 54 词掉到 45 词后，段1 出大脸特写（背景锚点太弱，模型自己重构图）。
  //   setting 必须写「地点类型 + 空间开阔/封闭」，其余项 8-16 词。
  'Each value is an English phrase of 8-16 words, no Chinese characters. ' +
  'The "setting" field must name the place type AND its openness or enclosure — ' +
  'write "open urban outdoor city square with wide open horizon edges", never just "outdoor". '

async function toEnglish(text: string | undefined | null, configId?: number | null, compact = false, force = false): Promise<string> {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (!/[\u4e00-\u9fa5]/.test(t)) return t          // 本来就是英文
  // 🔴 2026-10-30：key 带上版本号。翻译指令改过（_TR_SCENE 加 HARD RULES、场景六项必填 palette），
  //   旧 key 命中的是**旧指令翻出来的坏稿**（缺 palette、带 blurred/breeze）—— 不改 key 的话
  //   「代码修好了、出来的还是旧坏结果」，而且缓存是磁盘级的，重启也不消。改版本号 = 旧条目自然失效。
  const ck = (compact ? 'S3|' : 'F2|') + t
  // force = 用户勾了「重新生成」：跳过缓存、真调一次模型（否则同段中文第二次编译直接吃缓存，看着像没执行）
  if (!force) {
    const hit = _enCache.get(ck) || enDiskRead()[ck]
    if (hit) { _enCache.set(ck, hit); return hit }
  }
  const call = () => askText(compact ? _TR_SCENE : _TR_FULL,
    t, compact ? 600 : Math.min(1600, Math.max(400, t.length * 3)), configId)
  /** 场景 JSON → 带标签的一句（六项齐全才用，否则退回清洗版） */
  const cleanScene = (raw0: string): string => {
    const raw = String(raw0 || '').replace(/```(?:json)?/gi, ' ').trim()
    let labelled = ''
    try {
      const j: any = pickJson<any>(raw) || {}
      const FIELDS: Array<[string, string]> = [
        ['setting', ''], ['walls', 'walls'], ['floor', 'floor'],
        ['fixtures', 'fixtures'], ['light', 'light'], ['palette', 'palette'],
      ]
      const bits: string[] = []
      // 每项限词：六项加起来必须塞得进 capWords(sceneLine, 68) 的预算，
      // 否则靠后的 palette 会被整段砍掉（2026-10-30 实测：walls/floor/fixtures/light 写了 65 词，palette 直接消失 → 画面暗 15 灰度）。
      const LIMIT: Record<string, number> = { setting: 10, walls: 16, floor: 16, fixtures: 16, light: 16, palette: 14 }
      let hasPalette = false
      for (const [k, label] of FIELDS) {
        let v = String(j?.[k] || '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
        if (!v || /[\u4e00-\u9fa5]/.test(v)) continue
        const words = v.split(' ').filter(Boolean)
        const lim = LIMIT[k] || 10
        if (words.length > lim) v = words.slice(0, lim).join(' ').replace(/[,;.\s]+$/, '')
        if (k === 'palette') hasPalette = true
        bits.push(label ? `${label}: ${v}` : v)
      }
      // palette 是唯一的色温锚点：缺了整片会变灰变暗（实测 15~20 灰度）⇒ 不完整就整条不采用，
      // 交给调用方重试一次；仍不完整才退回清洗版。
      if (bits.length >= 4 && hasPalette) labelled = bits.join('; ') + '.'
    } catch { /* 解析失败 → 兜底清洗 */ }
    const clean = raw
      .replace(/["[\]{}]/g, ' ')                       // 先去引号/括号，否则 `"walls":` 里的键名删不掉
      .replace(/\s+/g, ' ')
      .replace(/\b(setting|walls|floor|fixtures|light|palette)\b\s*:/gi, ' ')
      .replace(/\s*,\s*/g, ', ')
      .replace(/^[\s,;]+|[\s,;.]+$/g, '')
    return labelled || (clean ? clean + '.' : '')
  }
  try {
    let r = await call().catch(() => null)
    if (!r) r = await call().catch(() => null)      // 翻译偶发超时：重试一次再判失败
    if (!r) throw new Error('translate-empty')
    let en = String(r || '').replace(/\s+/g, ' ').trim()
    if (compact) {
      // 2026-10-25 改：原来六个字段用逗号拍平（"indoor, glass curtain wall, polished marble, …"），
      // 读不成句、光的来源与色温被摊成关键词。现在每个字段带标签成句，光的灯/方向/色调都保住。
      en = cleanScene(r)
      // 🔴 场景太笼统 = 背景不锁：实测同一段中文一次翻 351 字符（含装饰条纹/地面纹理/拱门/糖果色）
      //    → 背景锁住一半；另一次翻 230 字符笼统版 → 背景整块回源片。词数不够就再要一次，取更具体的。
      // 🔴 2026-10-30：词数够也不一定合格 —— 实测某次返回把场景卡里的「远处模糊的城市建筑轮廓」
      //   忠实译成 `walls: distant urban building outlines`（H3 会画成画面上方一团灰蓝块），
      //    还出现 `light` 项残成 `tural daylight from upper side`。指令写了禁词也挡不住模型不听话，
      //    所以这里做**出口验收**：缺 palette 或命中禁词都算不合格，重译一次。
      const SCENE_BAD = /\b(distant|blurr\w*|out[- ]of[- ]focus|soft[- ]focus|bokeh|depth[- ]of[- ]field|breeze|wind|draft|gust|mist|haze|fog|dust|atmospher\w*|vignette|glow)\b/i
      const sceneOk = (x: string) => /\bpalette\s*:/.test(x) && !SCENE_BAD.test(x)
      if (t.length >= 100 && (!sceneOk(en) || en.split(/\s+/).length < 40)) {
        const r2 = await call().catch(() => null)
        if (r2) {
          const en2 = cleanScene(r2)
          // 先比合格（干净且带 palette 优先），同级再比词数（更具体）。
          const q1 = (sceneOk(en) ? 2 : 0) + (/\bpalette\s*:/.test(en) ? 1 : 0)
          const q2 = (sceneOk(en2) ? 2 : 0) + (/\bpalette\s*:/.test(en2) ? 1 : 0)
          const w1 = en.split(/\s+/).length
          const w2 = en2.split(/\s+/).length
          if (q2 > q1 || (q2 === q1 && w2 > w1)) en = en2
        }
      }
    }
    // who/outfit：模型偶尔只译半句（实测 2026-10-25：208 字中文 appearance → 137 字符英文，
    // 眼睛/鼻梁/唇形/头发/肤色/身形全丢）→ 太短就再要一次（只多一次文本调用），仍短就接受。
    if (!compact && t.length >= 80 && en.length < t.length * 0.8) {
      const r2 = await call().catch(() => null)
      const en2 = String(r2 || '').replace(/\s+/g, ' ').trim()
      if (en2.length > en.length) en = en2
    }
    if (en && !/[\u4e00-\u9fa5]/.test(en)) {
      _enCache.set(ck, en)
      // 场景版太笼统（<40 词）不落盘：否则一次翻车就被永久固定，下次连重试机会都没有
      if (!compact || en.split(/\s+/).length >= 40) enDiskWrite(ck, en)
      return en
    }
    throw new Error('translate-not-english')
  } catch (e: any) {
    // 🔴 绝不再把中文原样返回：H3 收到中文描述会完全压不住背景（实测段2 的 who 是中文
    //    → 第 13 秒起源片背景整片回魂）。宁可让这一段的提交失败并提示重试，也不静默降级。
    throw new Error(`提示词翻译失败（${e?.message || 'unknown'}）—— 点「全部重写」重试这一段`)
  }
}

/**
 * 舞步描述专用翻译：不能复用 toEnglish 的 _TR_FULL —— 那条指令明确要求
 * 「跳过表演/表情/肢体动作描述」，正好会把这句要的舞步全删掉。
 * 失败返回 ''（宁可不写，也不让中文混进 H3 提示词）。
 */
/** 最近一次舞步翻译失败的原因（给接口响应带出去，不再静默丢句） */
let danceActionError = ''

const _TR_DANCE = 'Translate one dance move into concise, concrete English. '
  + 'The input is one line: the seconds that move occupies inside the clip, then a Chinese description. '
  + 'A move that fills most of the clip gets more detail (up to 30 words); a move that only clips the edge gets one short clause (about 8 words). '
  + 'Keep every movement of a body part — feet, legs, knees, hips, torso, arms, hands, head — including stepping, standing still at the end of a move, turning and shifting weight. Only mood, appearance and smile words may be dropped. '
  + 'A description of where the feet or the body end up is part of the move. '
  // 🔴 2026-10-28 通用规则：H3 是 cfg=1、没有负向分支，负向/缺失式描写等于把那个词喂给模型
  //    （实测「蜷缩在地、黑暗里」翻成 `in darkness` 后，画面按"黑"去理解，反而丢掉背景与光）。
  //    舞步只描述**画面里有的**身体动作与方位；光暗、缺失、否定一律不写。
  + 'Describe only what is VISIBLE: body parts, positions and directions. Never write about light, darkness, ' +
  'shadow, emptiness or anything that is absent, and never write a negation (no / not / without / none). '
  + 'Output one clause of at most 30 words: no number, no seconds, no timestamp prefix, no Chinese.'
/** 剔掉礼节性头部动作（颔首/点头/致意/鞠躬）+ 不点名会诱发特写的部位。
 *  🔴 2026-10-27 实测根因（段4，稳定复现的 3~5s 大脸）：
 *  ① 段4 是四段里唯一动作句带 `nodding slightly` 的 → 要表现点头只能给到脸。
 *  ② `clap at her chest` 里的 chest 把注意力上移到上半身；`still stance` 把"站定"说成"姿态静止"
 *     → 模型收到"这段不动"，用特写填画面。段1 同为站定但有"摇摆肩膀"的动作托着，所以没出问题。
 *  处理：头部礼节动作直接删；chest/breast → in front of her body（动作照做、不点名胸口）；
 *  still stance / still position → 去掉 still 修饰（站定照做，不说"姿态静止"）。*/
export function stripHeadActions(text: string): string {
  return String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[，、；;,]?\s*(微微?颔首|轻轻?点头|颔首|点头|致意|鞠躬)/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 英文动作句落盘前的最后一道清洗：不点名胸口、不强调"静止姿态"、不带时间戳、不写光暗/缺失。
 *  2026-10-28：这三类是通用的「负向/元信息」污染，跟具体素材无关 ——
 *  ① `6s: …` 秒数前缀（LLM 把输入里的时间戳照抄进来）；
 *  ② `in darkness / in the dark`（写"黑暗"=把黑暗喂给模型，画面按黑理解、背景光丢失）；
 *  ③ `none mentioned / not mentioned / n/a`（缺失占位，模型会把占位当描述）。 */
export function scrubDanceActionEn(en: string): string {
  return String(en || '')
    .replace(/\b(?:at|in|on|to|of|in\s+front\s+of)\s+(?:her|the)\s+chest(?:-level|level)?\b/gi, 'in front of her body')
    .replace(/\b(?:at|to|on|in)\s+chest\b/gi, 'in front of her body')
    .replace(/\bchest[- ]level\b/gi, 'in front of her body')
    .replace(/\b(?:to\s+a\s+|in\s+a\s+|into\s+a\s+)?still\s+(stance|position|pose)\b/gi, 'to a $1')
    .replace(/\b(?:and\s+)?stands?\s+still\s+at\s+the\s+(?:end|close)\b/gi, 'closes the move')
    .replace(/(^|[;]\s*)\d+(?:\.\d+)?\s*s\s*:\s*/gi, '$1')          // 秒数前缀
    .replace(/\b(?:in|within)\s+(?:complete\s+|total\s+|pitch[- ])?(?:darkness|the\s+dark)\b/gi, '')  // 光暗
    .replace(/\b(?:none|not)\s+mentioned\b/gi, '')
    .replace(/\bn\/?a\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[;,]\s*;/g, ';').trim()
}
async function translateDanceAction(text: string, configId?: number | null): Promise<string> {
  // 🔴 2026-10-26：这里原来用 /\s+/g 把换行也压掉了 —— 动作句输入是多行（每条一行「N.Ns: …」），
  //    压成一行后模型看不出有几条，实测段1 丢「起势」、段3 丢「侧身延伸」。只压行内空白。
  // 🔴 2026-10-27：`微微颔首`（nod）这类礼节性头部动作不能进英文动作句 ——
  //    实测段4 是四段里唯一带 `nodding slightly` 的，也是唯一出大脸特写的（段1/2/3 动作句零头部词）。
  //    要表现"点头"模型只能把镜头给到脸。这里先剔掉，不影响"站定/拍手/并步"。
  const t = String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[，、；;,]?\s*(微微?颔首|轻轻?点头|颔首|点头|致意|鞠躬)/g, '')
    .replace(/\n{2,}/g, '\n').trim()
  if (!t) return ''
  if (!/[\u4e00-\u9fa5]/.test(t)) return t
  const ck = 'D|' + t
  const hit = _enCache.get(ck)
  if (hit) return hit
  // 🔴 2026-10-26：四段一起点重编 = 20 次 LLM 调用并发打到同一台文本模型，
  //    而 action 是每段最后一次调用、最容易超时 —— 失败原来是静默返回 '',
  //    结果四段提示词整段没有动作句（实测 00:24 那批 4 段全是 6821 字符、无 moves 句），
  //    生成出来后 260 字符处之后模型自己编。改成重试 3 次并把失败暴露到接口响应里。
  // 🔴 2026-10-26：实测翻译会静默丢条（段1 丢「起势」、段3 丢「侧身延伸」），
  //    250 字符根本够（三条压完约 145），是模型偷懒。按输入条数校验，不匹配就重试。
  const expect = t.split('\n').filter((x) => x.trim()).length
  // 🔴 2026-10-26：整段一起翻救不回来 —— 实测这个 flash 模型会把两条合并成一条（段1/段2/段4 全丢）、
  //    把一条切成三条（段4 回 6 段）、还会删条目；「数 ;」和「按编号对号」两种校验都被它绕过。
  //    改成每条单独翻一次并发跑：条数由输入决定，物理上不可能丢条或合并。
  const rows = t.split('\n').map((x) => x.trim()).filter(Boolean)
  // 串行：并发 2~3 个请求打同一中转会被限流（实测最后一条必失败 → 动作句少一条），
  // 单段最多 3 条、串行只多花 2~3 秒，换稳定。
  const outfits: string[] = []
  const outs: string[] = []
  for (const line of rows) {
    try {
      const raw = String((await askText(_TR_DANCE, line, 220, configId)) || '')
      outfits.push(raw)
      outs.push(raw)
    } catch (e: any) {
      danceActionError = `舞步翻译失败：${String(e?.message || e || '').slice(0, 120)}`
      console.error('[dance-tr]', danceActionError, '| input:', line.slice(0, 40))
      outfits.push('')
      outs.push('')
    }
  }
  if (process.env.DANCE_TR_DEBUG) console.error('[dance-tr-raw]', JSON.stringify(outfits))
  const cl = outs.map((o) => String(o || '')
    .replace(/^\s*(?:\d{1,2}\s*[).:]|[-•*])\s*/gm, '')
    .replace(/[;,\s]+$/, '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (cl.length < rows.length) {
    danceActionError = danceActionError || `舞步翻译缺口（${rows.length} 条只回了 ${cl.length} 条）`
    if (!cl.length) return ''
  }
  // 🔴 2026-10-27：落盘前过最后一道清洗 —— chest → in front of her body、去掉 still stance。
  //    实测段4 稳定复现的 3~5s 大脸就出在 `clap at her chest ... to a still stance` 这句上。
  const r: string | null = cl.length ? scrubDanceActionEn(cl.join('; ')) : null
  let en = String(r || '').replace(/\s+/g, ' ')
    .replace(/[.;,]\s*;\s*/g, '; ')          // 模型爱写「beat. ; She…」→ 清成「beat; She…」
    .replace(/;/g, '; ').replace(/\s+/g, ' ')
    .replace(/^["“]\s*|\s*["”]$/g, '').trim()
  if (!en || /[\u4e00-\u9fa5]/.test(en)) return ''
  // 🔴 2026-10-26：删掉原来的「末尾没标点就回退到最后一个 . 或 ;」保护。
  //    它是为「整段翻一次、可能被 max_tokens 截半句」设计的；改成逐条翻译后每条本身完整，
  //    拼起来末尾没标点就一路回退到第 1 条末尾的 `;`，把后面所有条目整条切掉
  //    （实测段1/段2/段4 都只活下第 1 条）。每条已在 askText 层由 finish_reason 保证完整。
  if (!en) {
    danceActionError = danceActionError || '舞步翻译返回空（模型超时或输出含中文）'
    return ''
  }
  danceActionError = ''
  _enCache.set(ck, en)
  return en
}

/** 编译舞蹈英文提示词：先把中文资产描述译成英文，再交给模板 */
async function compileDancePromptEn(p: {
  characterPrompt?: string; outfit?: string; scenePrompt?: string; style?: string; styleHead?: string
  frames: number; shotNo: number; totalShots: number; configId?: number | null
  scenePic?: number      // 场景图在 <Picture N> 里的序号（1 起），默认 2
  actionZh?: string      // 本段中文舞步（来自 outline），翻成英文点名进 dd
  force?: boolean          // true = 强制重新翻译（勾了「重新生成」时）
}): Promise<string> {
  // 串行翻译（原来是 Promise.all 三并发 —— 并发撞超时时会有一段失败，
  // 而失败的翻译以前会静默返回中文，导致段1 英文 / 段2 中文，背景直接失守）。
  const who = await toEnglish(p.characterPrompt, p.configId, false, p.force)
  const outfit = await toEnglish(p.outfit, p.configId, false, p.force)
  // 🔴 2026-10-27（段4 结尾"背景上隐约两次人脸"）：场景卡里那句
  //    `full-height frameless floor-to-ceiling mirror wall reflecting dancers` ——
  //    dancers 是复数、泛指，模型据此在镜面背景里浮出陌生人的脸。
  //    渲染时把"反射舞者/人"这类泛指改写成"反射房间"（不动用户在场景卡里填的原文）。
  const sceneRaw = await toEnglish(p.scenePrompt, p.configId, true, p.force)
  // 场景清洗统一走 scrubSceneEn（缺失占位/否定小句/「反射舞者」泛指都在那里处理）
  const scene = scrubSceneEn(sceneRaw)
  // 2026-10-28（用户拍板 A）：不再把大纲里的动作翻成英文塞进提示词 —— 动作由 <Video 1> 提供，
  // per-段动作句是猜的、写偏就与源片打架。这里省掉一次 LLM 调用；translateDanceAction 保留不删，恢复只需
  // 把下面这行改回 `await translateDanceAction(...)`。`action` 仍传空串给 compileDancePrompt（模板不再输出它）。
  const action = ''
  return compileDancePrompt({ ...p, characterPrompt: who, outfit, scenePrompt: scene, action })
}

function compileDancePromptZh(p: { frames: number; shotNo: number; totalShots: number }): string {
  const end = ((Number(p.frames) || 124) / 24).toFixed(2)
  return [
    `出场人物：参考图里的同一人物（身份由身份卡锁定）；场景：见场景参考图；机位：完全复刻参考视频`,
    `0.00-${end}秒：机位与运镜完全复刻参考视频（无额外推拉摇移）。她逐帧复刻参考视频的舞步——脚步落点、屈膝幅度、胯部路径、躯干转向、手臂弧线与手腕高度、头部朝向、重心转移都与参考视频同一帧对同一帧；服装与发型与参考图一致；本段声音为参考视频原音。`,
  ].join('\n')
}

// 表演/表情/动作类描述不能进 who 段：H3 会照着演。
// 实测（2026-10-24）人物资产里带「at the close she tilts her head with a sweet smile, chest rising...」，
// 段2 后半段模型就去演这个动作，脱离源片舞步、人物直接脱锁。这类是镜头表演，不属于「她长什么样」。
// 只禁**会诱导动作**的词。🔴 2026-10-30 修正：上一轮把 gaze / calm / quiet / serene / stillness
// 这些**静态气质**词也塞进来了 —— 结果 `gaze steady and calm like a still deep pool`、
// `a stillness that holds feeling inward` 这类描述人物神态的句子被整句删掉，人物段只剩
// 虹膜颜色+肤色+发型，人物的"气质锚点"没了，实测段1 出大脸、后段人脸不稳定。
// 静态气质 = 长什么样的延伸，必须留；会变成动作的才删。
const PERFORM_RE = /\b(smil\w*|tilt\w*|breath\w*|post-effort|aura|livel\w*|glanc\w*|wink\w*|blink\w*|laugh\w*|frown\w*|pout\w*|nod\w*|sing\w*|hum\w*|grin\w*|when movements|at the close|at the end|throughout the take|gradually (?:opens|widens|turns)|slowly (?:opens|widens|turns))\b/i

/** 只留静态外貌句：按句切分，丢掉含表演/表情词的句子；全被丢光就退回原文 */
function staticAppearance(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const parts = t.split(/(?<=[.!?;])\s+/).filter(Boolean)
  const kept = parts.filter((x) => !PERFORM_RE.test(x))
  return (kept.length ? kept.join(' ') : t).trim()
}

/** 人物段的输入：脸/身材取资产 appearance —— 服装由 outfit 单独一句写，别在 who 里再写一遍（白占 ~450 字符且出现重复句号） */
// 2026-10-26：**不过滤五官**。用户确认五官/肤色/妆造的颜色描述是画面色温的锚点，
// 删掉之后画面从 R/B 1.16 漂到 1.42（明显发黄）。特写的真因是「参考图描述」把那张拼图
// 当成可复现的画面（见 <Subject 1> 段），五官内容本身没问题。
function danceWhoText(project: any, asset: any): string {
  return String(asset?.appearance || project?.characterPrompt || asset?.description || '').trim()
}

/** 舞蹈提示词里的否定短语检测（纯函数，自检脚本用）。
 *  🔴 2026-10-26 用户口径：H3 是 BasicGuider + cfg=1，**没有负向分支** —— 否定句不扣分，
 *  只是把被否定的那个词喂给正向描述。官方 base-en.txt / ref-en.txt 的示例提示词里
 *  一句否定句都没有：机位不动写 `The camera holds a static shot`，嘴不动写
 *  `while his lips remain completely closed`，没有音乐写 `N/A`。
 *  所以我们原来那三句 `Framing is locked: no close-up, no facial shot` /
 *  `no added pan, no tilt, no zoom and no push in` / `must not change`
 *  实际效果是往提示词里塞了 close-up、facial shot、pan、tilt、zoom、push in 这些词。
 *  只查「否定词 + 名词/运镜词」——动作动词那套由 services/video-prompts.ts 的 findNegatedAction 管。
 *  例外：`N/A` 字段值与画风头 `avoid …` 是官方写法，不算。 */
const DANCE_NEG_OK = /\b(?:N\/A)\b|\bavoid [a-z][a-z-]*(?: [a-z][a-z-]*)?/gi
const DANCE_NEG_BAD = /\b(?:no|not|never|without|must not|do not|does not)\s+(?:[a-z'-]+\s+){0,2}?(?:close-?ups?|facial shots?|pan|tilt|zoom|push[\s-]?in|dolly|truck|changes?|changing|added|extra|subtitles?|captions?)\b/gi
// 2026-10-28 通用：缺失占位 / 光暗描写也属「非正向写法」——`none mentioned` 等于写了那个名词，
// `in darkness` 等于把黑暗喂给模型。这两类以前会漏检（只核机位那 12 个词）。
const DANCE_NEG_META = /\b(?:(?:none|not)\s+mentioned|in\s+(?:complete\s+|total\s+|pitch[- ])?(?:darkness|the\s+dark)|n\/a)\b/gi
export function findDanceNegations(en: string): string[] {
  const body = String(en || '').replace(DANCE_NEG_OK, ' ')
  const hits = [...(body.match(DANCE_NEG_BAD) || []), ...(body.match(DANCE_NEG_META) || [])]
    .map((x) => x.trim().replace(/\s+/g, ' ').toLowerCase())
  return [...new Set(hits)]
}

/** 只留「颜色 / 发型 / 体型」这类可锁锚点；纯形状级细描（额头、双眼皮、鼻梁、唇形、脸型）对身份锁定没有增量，
 *  却吃掉 600+ 字符（2026-10-28 实测：真实稿 <Subject 1> 2873 字符 = 全提示词的 41%）。
 *  ⚠️ 颜色类一律保留：10-26 实测删掉颜色锚点后画面发黄（R/B 1.16 → 1.42）。
 *  ⚠️ 必须按**短语**判，不能按句：同一段资产两次翻译的分句不一样（一次把形状和颜色拆成两句、
 *     一次写成「Soft oval face shape, …, deep-brown almost black irises, …」一整句），
 *     句子级过滤在后者上会整句保留 → 又长回 1450 字符（2026-10-28 实测到的坑）。 */
const SHAPE_RE = /\b(foreheads?|eyelids?|eyes?|brows?|eyebrows?|noses?|nostrils?|bridge|lips?|mouth[- ]corners?|corners? of the mouth|ovals?|cheekbones?|jawlines?|chins?|pupils?)\b/i
const COLOUR_RE = /\b(black|brown|white|grey|gray|pink|red|blue|green|yellow|purple|orange|beige|fair|pale|tan|olive|dark|light|cool|warm|skin|hair|tone|undertone|cm|tall)\b/i
/** 删句后接缝处会出现「. pupils」这种小写开头，统一把句首字母大写（分号后不动 —— 英文分号后本来就小写）。 */
const fixSentenceStart = (t: string) => t.replace(/([.!?]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())

export function trimShapeDetail(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return t
  // 连标点一起切（保留句末标点），否则删掉一句后前后会粘成一句
  const parts = t.match(/[^.!?;]+[.!?;]*/g) || [t]
  const trimmed = parts.map((raw) => {
    const body = raw.trim().replace(/[.!?;]+$/, '')
    const punc = raw.trim().slice(body.length) || '.'
    if (!body || !SHAPE_RE.test(body)) return body ? body + punc : ''
    // 整句都在讲形状 → 整句删；形状与颜色混在一句 → 只删形状短语，颜色短语留着
    if (!COLOUR_RE.test(body)) return ''
    const kept = body.split(/,\s*/).filter((phrase) => !(SHAPE_RE.test(phrase) && !COLOUR_RE.test(phrase))).join(', ')
    return kept ? kept + punc : ''
  }).filter(Boolean).join(' ')
  return fixSentenceStart(trimmed || t)
}

/** 妆造/指甲/首饰这类句子从服装描述里剔掉：脸和妆容由身份卡 + <Picture 1> 决定，写进提示词既不锁人也白占字符。
 *  2026-10-28：原正则只有 `nails?`，实测漏掉 `Fingernails are trimmed short…`（一个词、且前面没词边界）→ 补 finger/toe nail。 */
const MAKEUP_RE = /\b(make-?up|foundation|eyeliner|eyebrows?|lip (?:tint|gloss|stick|balm)|lipstick|blush|nail polish|(?:finger|toe)?nails?|earrings?|necklaces?|bracelets?|jewell?ery|jewelry)\b/i
export function trimMakeup(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return t
  const parts = t.split(/(?<=[.!?;])\s+/).filter(Boolean)
  const kept = parts.filter((s) => !MAKEUP_RE.test(s))
  return fixSentenceStart((kept.length ? kept.join(' ') : t).trim())
}

/** 场景文本的唯一清洗入口（编译期、纯函数，便于自检）：把「缺失/否定」写法从场景里剔干净。
 *  H3 是 cfg=1、没有负向分支 —— 写 `walls: none mentioned` 或 `no close vertical walls` 等于正面写了那个名词。
 *  三类实测过的写法：① 项首 `walls: none/not mentioned|n/a`；② 项首 `walls: no …`；③ 中间夹 `, no …` 小句。 */
export function scrubSceneEn(scene: string): string {
  const cleaned = String(scene || '')
    .replace(/\breflecting\s+(?:the\s+)?(?:dancers?|people|persons?|dancers?\s+and\s+\w+|others|figures?)\b/gi, 'reflecting the room')
    // 🔴 2026-10-30：H3 会把摄影/天气/氛围词真的画出来 —— 实测 `distant blurred city building
    //   outlines` 成了画面上方一团灰蓝模糊块，`soft breeze` 让画面整体发飘。这里是编译期第二道闸：
    //   就算翻译模型没听指令编了，也要在进提示词前删掉。`distant blurred …` 整段删（只删 blurred 会留下悬空的 distant）。
    .replace(/\b(?:distant\s+)?(?:blurred|blurry|out[- ]of[- ]focus|soft[- ]focus|bokeh|depth[- ]of[- ]field)\b[^,;.]*/gi, '')
    // 🔴 2026-10-30：`distant` 裸词也要删。实测场景卡中文「远处模糊的城市建筑轮廓」有一次被译成
    //   `distant urban building outlines`（没带 blurred）→ 上面那条不匹配 → 留着被画成画面上方远景块。
    .replace(/\bdistant\b[^,;.]*/gi, '')
    // 🔴 2026-10-30：远景建筑轮廓同理 —— 场景卡「远处模糊的城市建筑轮廓」会被译成
    //   `city building silhouettes bounding the view`，实测画到画面上方成灰蓝团。
    .replace(/\b(?:city\s+)?building\s+(?:outlines?|silhouettes?)\b[^,;.]*/gi, '')
    .replace(/\b(?:soft\s+)?(?:breeze|wind|draft|gust)\b[^,;.]*/gi, '')
    .replace(/\b(?:light\s+)?(?:haze|mist|fog|dust|atmospher\w*|vignette|glow)\b[^,;.]*/gi, '')
    .replace(/\b(?:setting|walls?|floor|fixtures?|light|lighting|palette|props?|furniture)\s*:\s*(?:none|not)\s+mentioned\s*[,;]?\s*/gi, '')
    // 🔴 2026-10-30 抓到的真凶：`n\/?a` 少了词边界，`/` 又可选 ⇒ 等价于 `na`，
    //   会把 `light: natural daylight …` 吃成 `tural daylight …`（连续两版提示词都断在这里）。
    //   加 `\b` 后只有独立的 `n/a` / `na` 才被当成「未提及」删掉。
    .replace(/\b(?:setting|walls?|floor|fixtures?|light|lighting|palette|props?|furniture)\s*:\s*n\/?a\b\s*[,;]?\s*/gi, '')
    .replace(/\b(?:setting|walls?|floor|fixtures?|light|lighting|palette|props?|furniture)\s*:\s*(?:no|without|none)\b[^,;.]*[,;]?\s*/gi, '')
    // 🔴 2026-10-30：删完禁词会留下空标签（`walls: ;`）—— 空标签等于正面写了「墙＝空」，
    //   和 `walls: none mentioned` 同类毛病。这里连标签一起删，再收拾残留分隔符。
    .replace(/\b(?:setting|walls?|floor|fixtures?|light|lighting|palette|props?|furniture)\s*:\s*(?=[;,]|\.|$)/gi, '')
    .replace(/\s*;\s*;/g, '; ')
    .replace(/\s*[,;]?\s*\b(?:no|without)\s+[^,;.]{1,60}(?=[,;.]|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
  // 2026-10-28：同一项里重复出现的短语去掉（实测 LLM 翻译把
  // `wide open dance-area stone paving in mid-ground` 在同一行贴了两遍，白占 50+ 字符）
  return cleaned.split(/;\s*/).map((seg) => {
    const seen = new Set<string>()
    return seg.split(/,\s*/).filter((phrase) => {
      const key = phrase.trim().toLowerCase()
      if (!key) return false
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).join(', ')
  }).join('; ')
}

function compileDancePrompt(p: { characterPrompt?: string; outfit?: string; scenePrompt?: string; style?: string; styleHead?: string; frames: number; shotNo: number; totalShots: number; scenePic?: number; action?: string }): string {
  // 场景图序号：dance 的参考图固定是「人物图 → 场景图」，但用户可以在分镜里手绑顺序，
  // 所以由调用侧按实际顺序传进来，别在模板里写死 2。
  const sp = Math.max(1, Math.floor(Number(p.scenePic) || 2))
  // 本段舞步（英文，已翻译）；空串时模板里那句整条不出现。
  // 限 260 字符：真实素材已占 6700+，留给舞步的预算有限。
  // 🔴 2026-10-25 修：原来按词边界硬切，实测切出残句「The female lead executes a series of fast.」
  //    —— 半句话会被模型当指令，后段直接跑飞。现在切到最后一个句号/分号，切不出整句就整条不用。
  // 🔴 2026-10-26 实测（段2 在 4s 出大脸，段1 正常）：LLM 写出的舞步是**编号列表**
  //    （1. … 2. … 3. …），而 260 字符预算只装得下第 1 条。第 1 条是"开场姿势"，
  //    后面的条目被整条丢掉 ⇒ 6.58 秒里只有开头有动作，从第 4 秒起模型没动作可依就自己编，编成一张大脸。
  //    修法两条：① 先剥掉 `1.` `2.` 这类编号（对模型无意义还吃预算）
  //              ② 超长时按「首 / 中 / 尾」均匀抽样句组，而不是只留最前面那几句
  const action = (() => {
    // ① 先剥掉 `1.` `2.` 编号（对模型无意义还吃预算）
    const t = String(p.action || '').replace(/\s+/g, ' ').replace(/^(?:\d+[.)]\s*)+/, '').replace(/[.\s]+$/, '').trim()
    if (t.length <= 260) return t
    const parts = t.split(/(?<=[.;])\s+/).map((x) => x.trim()).filter(Boolean)
    // ② 只有 1~2 句还超长：切到最后一个完整句；切不出整句就整条不用（不许出残句）
    if (parts.length <= 2) {
      const m = t.slice(0, 260).match(/^[\s\S]*[.;]/)
      return m ? m[0].replace(/[\s,;.]+$/, '').trim() : ''
    }
    // ③ 句组很多：优先保「首 + 尾」，有余量再补「中」。
    //    顺序刻意不按时间 —— 丢的必须是中间那条：原来只留最前面几句 ⇒ 6.58 秒里只有开头
    //    有动作，从第 4 秒起模型自己编，编成一张大脸；只保首+中同样会把最靠后那段丢掉。
    const pick = [parts[0], parts[parts.length - 1], parts[Math.floor(parts.length / 2)]]
    let out = ''
    for (const seg of pick) {
      const cand = out ? `${out} ${seg}` : seg
      if (cand.length > 260) break
      out = cand
    }
    if (!out) {
      const m = t.slice(0, 260).match(/^[\s\S]*[.;]/)
      out = m ? m[0] : ''
    }
    return out.replace(/[\s,;.]+$/, '').trim()
  })()
  // 🔴 2026-10-26 实测（1310 验收版 vs 1330 出大脸版逐句 diff）：
  //   同一份中文资产，翻译出来的 who 描述 908 字符时段1 没大脸；1271 字符（多了独立成句的
  //   「Her nose bridge…」「Her lips are…」「the mouth corners…」）时两次都从第 1 帧就是脸部特写。
  //   解剖细节一旦拆成整句，模型就把它们当成「要拍这些部位」的镜头指令。
  //   所以这里只删**形状级细描**（鼻/唇/嘴/嘴角/下巴），颜色类（瞳色/肤色/眉色）全部保留 ——
  //   那些是色温锚点，删了画面发黄（实测 R/B 1.16 → 1.42）。
  const who = trimShapeDetail((staticAppearance(String(p.characterPrompt || ''))
    // 2026-10-28：原来这里兜底写死「a young woman, short black chin-length hair…」——
    // 换人物时（男/长发/儿童）会凭这句话另画一个人。兜底只指向参考图，不描述长相。
    || 'the performer shown in <Picture 1>')
    .replace(/(^|(?<=[.!?]\s))(?:Her|The) nose[^.]*\.\s*/gi, '$1')
    .replace(/(^|(?<=[.!?]\s))(?:Her|The) lips?[^.]*\.\s*/gi, '$1')
    .replace(/;?\s*when closed,? the mouth corners[^.;]*/gi, '')
    .replace(/;?\s*the mouth corners[^.;]*/gi, '')
    .replace(/;?\s*soft,? non-aggressive edges/gi, '')
    .replace(/\.{2,}/g, '.').replace(/\s+([.;,])/g, '$1').replace(/[.\s]+$/, ''))
  // 服装单独成句钉进提示词：只写「衣服来自 <Picture 1>」模型会每段自己重新理解一遍，
  // 跨段必然漂移（实测段1/段2 换成两套衣服）。把角色资产的造型原文写进来才有硬约束。
  // 🔴 2026-10-26：outfit 里混着妆造（Makeup: ... dark gray eyebrows ... eyeliner ... lips coated ...），
  // 这些词会把注意力拽到脸上，实测提示词里出现就出特写。同样按句剔掉五官句，只留衣服和鞋。
  // 🔴 2026-10-30：服装描述也要过 staticAppearance —— 它同样会混进表演句
  //   （「裙摆随呼吸起伏」「转身时会轻轻飘起」这类），而 H3 会照着演。原来只有 who 段过滤。
  const outfit = trimMakeup(staticAppearance(String(p.outfit || '').replace(/\s+/g, ' ').trim()))
  // 🔴 2026-10-26 用户反馈「衣服不按参考图走」：原来是 `fixed by this description and must not
  // change`，把文字描述钉成衣服的最高优先级 → 模型照文字重新画一套，参考图里那身衣服失效。
  // 改成参考图为权威、文字只补细节（不得覆盖），两者冲突时以 <Picture 1> 为准。
  const outfitLine = outfit
    ? `The garment in <Picture 1> is authoritative for its cut, colour and fabric: reproduce that exact outfit. The board wins wherever the two differ; the following description adds detail: ${outfit}`
    : 'Her outfit comes from <Picture 1> and stays the same in every frame.'
  // 场景只取第一句：完整 description 有 236 字符，全塞进六段式会把动作描述挤到后面（实测段1 动作跟随从准变松）
  const sceneFull = scrubSceneEn(String(p.scenePrompt || '').replace(/\s+/g, ' ').trim())
  // 场景句：**整段都用**（不再只取第一句）。
  // 2026-10-24 实测：译文有三句（「舞蹈室/木地板…」「白色墙面…」「自然光从左侧大窗射入…」），
  // 老的「只取第一句」把后两句切掉了 —— 而那两句正是背景（墙+光）的核心信息，切掉就只能跟源片。
  // 上限 740 字符：104 词 × 约 7 字符 ≈ 730，palette 在最后也必须活下来。
  let sceneLine = sceneFull
  if (sceneLine.length > 740) {
    const cut = sceneLine.slice(0, 740)
    const m2 = cut.match(/^[\s\S]*[,;.](\s|$)/)
    sceneLine = (m2 ? m2[0] : cut).replace(/[\s,;.]+$/, '').trim()
  }
  // 单词数硬上限 104：LIMIT 之和（10 + 16×4 + 14 = 88 值词）+ 5 个标签 = 93，留 11 词余量。
  const capWords = (t: string, n: number) => {
    const w = t.split(/\s+/).filter(Boolean)
    if (w.length <= n) return t
    return w.slice(0, n).join(' ').replace(/[,;.\s]+$/, '')
  }
  sceneLine = capWords(sceneLine, 104)
  const sceneOf = (line: string) => {
    // 2026-10-28：兜底原来写死「a clean outdoor location with even overcast daylight」——
    // 换室内/夜景背景时会凭空给一个户外阴天。场景为空就只指向场景参考图。
    if (!line) return 'the location shown in the scene reference image'
    // 统一去掉尾部所有点：模板里 `featuring ${scene}.` 会补一个，否则出现 `…trees..`（实测 2026-10-28）
    return line.replace(/[.\s]+$/, '')
  }
  const style = String(p.style || '').trim() || 'photoreal'
  // 画风：优先用画风预设里的英文风格头（画风才真的跟得住），只留前 ~18 个词（官方 dd 350–500 词，其余句子已占满）。
  // 预设查不到 / 是旧预设 → 退回原来那句「a <key> dance clip」。
  const styleHeadRaw = String(p.styleHead || '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
  const styleHead = (() => {
    const w = styleHeadRaw.split(' ').filter(Boolean)
    if (!w.length) return ''
    const cut = w.length > 18 ? w.slice(0, 18).join(' ').replace(/[\s,;.]+$/, '') : styleHeadRaw
    return cut.charAt(0).toUpperCase() + cut.slice(1)
  })()
  const styleLine = styleHead
    ? `${styleHead}. The target video is a dance clip lit by the same lighting as <Subject ${sp}>.`
    // 2026-10-28：兜底去掉 `, its light soft and even` —— 那是写死的光质，户外强光/夜景霓虹都跟它打架。
    : `The target video is a ${style} dance clip lit by the same lighting as <Subject ${sp}>.`
  const secs = (p.frames / 24).toFixed(2)
  const part = `segment ${p.shotNo} of ${p.totalShots}`
  const build = (scene: string, whoNow = who) => [
    'subject_definitions:',
    // 🔴 2026-10-26：这里**不能提"人像/肖像面板（portrait panel）"**。
    // 实测：写成 "one portrait panel supplies likeness only" 之后，段1 开头的第一帧直接就是
    // 参考图左侧那张大脸（用户实测反馈），而且衣服颜色也没锁住（服装约束被稀释）。
    // 正确写法只有一句：只说"从这块板取服装的版型、颜色、布料"，一个字不提脸/头/肖像。
    // 昨天那版写 "the reference board shows the outfit only" 时没这问题；4.0.334 写
    // "take the garment's cut, colour and fabric from that board" 也没特写。
    // 另外五官/肤色/妆造描述一个字都不删 —— 删了画面发黄（实测 R/B 1.16 → 1.42）。
    // 官方 §2.1（双源句式）+ §2.3：可见内容（动作/表情/站位）必须归 <Subject N>，<Video N> 只承担
    // 「整片结构源」。原来动作只写在 dd 里、Subject 定义只交代外观 → 属标签职责越界，现已按官方原文补上。
    `<Subject 1> is the performer whose identity is locked by the identity card, whose body, outfit and styling come from <Picture 1>, and whose dance motion, body movement and positions in the frame come from <Video 1>: ${whoNow.replace(/[.;:,\s]+$/, '')}. ${outfitLine} She has a complete head and her own hair, both taken from the identity card — the reference board shows the outfit only, so the head follows that card and this description. <Picture 1> is a multi-panel wardrobe and identity board: its panels serve as clothing and facial reference only, they are not a shot list, and their crops, scales and camera distances are not to be reproduced. The video carries one framing only, the one <Video 1> gives, and she appears once in every frame at that size and distance, from the first frame to the last.`,
    `<Subject ${sp}> is the environment in <Picture ${sp}>, featuring ${scene}.`,
        // 🔴 2026-10-26 官方「编辑视频」口径（Runware API 文档 MiniMax H3 › Editing video）：
    //    prompt 是「指令」而不是「描述」，且 Editing keeps whatever you do not mention ⇒
    //    「最常见的失败是欠说明，必须把要保留的东西写进 keep 那一半」。
    //    我们原来只写了它「提供什么」，没写「这些必须不变」⇒ 段2 第 4 秒起画面偏开源片
    //    （成片 vs 源片同刻 SSIM 0.47 → 0.34 且一路不回来；源片那一刻是全身景）。
    `<Video 1> is the source video for the target video edit, providing its camera framing, camera movement, cuts, pacing and temporal structure.`,
    `<Audio 1> is the synchronized audio track of <Video 1> and is reused as the complete final audio track.`,
    'summary:',
    `[video editing + reference generation + audio reuse] The target video is an edited ${part} (${secs} seconds) of <Video 1>. The original performer is replaced throughout by <Subject 1>, whose identity comes from the identity card and whose body, outfit and styling come from <Picture 1>, while her dance motion and performance follow <Video 1>.`,
    'retention_analysis:',
    // 2026-10-28 瘦身：这五行原来 820 字符，句子级压缩到 ~560，信息不丢（标记值/标签/出现镜次全保留）。
    '<Subject 1> (appears in [Shot 1]): fully_preserved - identity from the identity card; body, outfit and styling from <Picture 1>; motion as described below.',
    // 🔴 2026-10-26：这里只钉墙/地/固定件的几何与材质，光源统一由场景卡给（写死「光也逐帧保留」会与场景卡打架）。
    // 2026-10-28（用户指模板不该写死「地板/墙」——场景可能是草地、沙滩、舞台）：
    //   改成「每个元素都按 <Picture N> 原位保留」，不点名任何具体构件类别。
    `<Subject ${sp}> (appears in [Shot 1]): fully_preserved - every element of <Picture ${sp}> stays as it is, in the same place and at the same scale, under the light described in <Subject ${sp}>.`,
    '<Video 1> (framing, cuts, pacing): fully_preserved - camera framing, camera movement, cuts, pacing and temporal structure kept as they are.',
    'camera framing: fully_preserved - same framing, angle and distance to her body in every frame as <Video 1>.',
    '<Audio 1> (appears in [Shot 1]): fully_copy - reused unchanged as the complete final audio track.',
    'detailed_description:',
    // 🔴 2026-10-24 修：原来这里写死「even overcast daylight + soft shadowless light」（阴天日光），
    //    跟场景卡的「even panel lighting from ceiling」（天花面板灯）互相打架 → 模型混出偏暖怪光，
    //    地板高光被抹成一片片橙色波纹（用户看到「火焰一样的纹络」）。现在只要求「跟场景参考同一套灯、均匀不刺眼」，不写死光源类型。
    styleLine,
    // 2026-10-28：去掉写死的 `A static medium-wide shot … from head to feet`（机位/景别跟着源片走，
    // 换横屏、半身、有运镜的源片时这句话会跟 <Video 1> 打架）。防大脸靠「取景与占比跟源片一致」。
    // 官方 §5.2：风格句在 `[Shot 1]` 之前一到两句，正文由 `[Shot 1]` 起头（一段 = 一个镜头，无时间码）。
    // 2026-10-28（用户报「段2 出特写，源片没有特写」）：身份段有 ~800 字符的脸部级细节（肤色/额头反光/鼻翼/锁骨），
    //   模型会把「描述得这么细」当成「要拍脸」→ 自发生成特写。同款故障 10-27 在 p11 段1 出现过。
    //   修法（照 p11 当时定的）：在 [Shot 1] 正面写死全程全身在框内（正向描述，不用禁词），并点明上面那些细节只管身份。
    `[Shot 1] The shot frames <Subject 1> with the same framing, angle and distance as <Video 1> in every frame: her whole body stays inside the frame from head to feet from the first frame to the last, the framing holds wide enough for that and never tightens in on her. The details above describe her identity only.`,
    // 场景句回到 dd（p6/p8 的有效位置）：实测 4.0.316~318 把场景搬进 <Subject 2> 定义后，
    // 背景反而整块回到源片（舞蹈5 07:15 那条 6974 字符）。p6 那版背景生效时，场景就是写在这里。
    `The location of the take is <Subject ${sp}>.`,
    // 纯正向声明：H3 对否定句不敏感（否定会被当正向描述），所以只说"始终是同一个地方"，不提"不要跟源片"。
    // 🔴 2026-10-25 回补（关键）：p6 那两版都有下面这两句，p8 起被删掉了 ——
    //    「the background is that place」直指背景、「background elements hold the same positions and the same scale」
    //    把背景元素的落位与尺度钉死。删掉之后背景就只能靠源片（实测 p8 锁一半、p10 整块回源片）。
    `The background elements keep the same positions and scale in every frame.`,
    // 🔴 2026-10-26 实测（段1 成片按 6×8=48 块量 R/B）：最黄的三块横坐标全是 0（画面最左 1/6），
    //    纵向 gy=2..7，R/B 2.25~2.64（(88,62,34) 这种暖棕）—— 那一竖条正是场景卡里的落地镜面墙 +
    //    黑色把杆。镜面是画面里唯一「不承载具体物体」的大块区域，只写 matching the saturation of
    //    <Subject 2> 压不住它，模型自己在镜子里刷了一层暖色。这里把镜子反射的颜色钉到同房间。
    `The colour grading stays neutral, matching the white balance and saturation of <Subject ${sp}>.`, 
    // 🔴 2026-10-27（段4 结尾"背景上隐约两次人脸"）：场景卡里写的是 `mirror wall reflecting dancers`
    //    —— dancers 是复数、泛指，等于告诉模型"镜子里可以出现别人"，于是背景镜面里浮出陌生人的脸。
    //    这里把镜子钉死成"只有她自己这一份倒影"，正向写（H3 无负向分支，不能写 no other people）。
    // 🔴 2026-10-28：这句只在**场景里真有镜墙**时才加。舞蹈7 的场景是户外广场（无镜墙、无浅色地板），
    //    硬写这句 = 模型找不到镜面，只能拿源视频背景顶 → 段1 背景整块回源片、还带上源片的人脸痕迹。
    /\bmirror\b/i.test(scene) ? `The mirror wall shows nothing but her own reflection, at the same size as her body, in the same light and over the surface of <Subject ${sp}>.` : '',
    // 🔴 2026-10-26 实测：4.0.366 把这段清单压成两句、同时砍掉 LLM 动作句后，段1 火焰纹 + 大脸全回来了
    //    ⇒ 这段逐项清单确实是有效约束（模型靠它维持肢体结构），别再当冗余删。
    `Throughout the whole take she keeps dancing on the beat: her feet land on the beat and keep their spots, her knees bend and straighten through the same amplitude, her hips travel the same path and distance, her torso turns and counter-turns at the same instants, her arms open and close through the same arcs at the same height, her wrists and hands reach the same positions relative to her body, and her weight shifts from one leg to the other on the same beats. The amplitude of each move matches <Video 1> frame by frame, and whatever its size the whole body stays inside the frame at the same distance.`,
    // 2026-10-25：点名本段具体舞步。官方 Ref 指南要求 dd 写清 actions and state changes；
    // 只写「逐帧复刻」时动作跟随会松（社区实测：动作跟不住要 direct prompting）。
    // 同帧/同幅度已由上面那句 choreography 声明，这里不再重复（省 100 字符给舞步本身）。
    // 2026-10-28 用户拍板（A）：**删掉 per-段动作句**。它来自 `mv_projects.outline`（分镜大纲，LLM 写的），
    // 不是从源片读出来的 —— 大纲写偏（这次「蜷在地上」「in darkness」）就跟 <Video 1> 打架。
    // 动作由 <Video 1> 提供，模板里那段逐项肢体清单 + 「matches <Video 1> frame by frame」就是固定动作锁。
    // 保留 action 入参与下方裁剪逻辑：要恢复只需把这一行加回来。
    // 🔴 2026-10-25 回补（段2 后半段冒人脸特写的根因）：p6 两版都有下面这句的
    //    「no added pan, no tilt, no zoom and no push in」，p8 起被换成弱版 ⇒ 模型在后段自由推近到脸。
    // 2026-10-28：这两句原来分开（一句管机位、一句管距离/占比），合计 ~290 字符；本版加了官方的
    // 「动作归属 + [Shot 1]」后总量顶到 6933/6980，第 4 段 6975 ⇒ 一涨就会触发压缩循环先砍 who
    // （砍人物描述会掉脸锁）。合并成一句，信息不丢、省 ~120 字符。
    'The camera holds the same height, distance and background layout as <Video 1> for the whole take, so she fills the same part of the frame in every frame as in <Video 1>. The words above name the picture and the motion; <Video 1> carries every frame at the same timecode, and her body keeps moving.',
    // 同理：p6 说「keeps a calm steady expression」，p8 起改成「her face stays calm and steady」——
    // 提示词里点名 face 会把注意力引到脸，正是特写的诱因。
    // 🔴 2026-10-27 二次定位：段4 掉点区间帧间差 8.22（比全片均值 5.94 还高），
    //    且 2.58s / 4.75s 各有一个 61 / 67 的硬切峰 ⇒ 不是「画面太静」，是模型自己切了个特写镜头。
    //    所以这里要的是「一镜到底」的正向声明（H3 无负向分支，不能写 no cut）。
    //    原来那句「减速时锁机位」实测两轮都没挡住，删掉换这句；净省 12 字符。
    // 🔴 2026-10-27（用户要求：用正向提示词保证不写大脸）把那两句「距离恒定 + 占比恒定」合并进上面
    //    那条机位句了（2026-10-28 减负），这里不再单独出一句 —— 防特写的作用不变：特写=距离变了。
    // 🔴 2026-10-27：删掉 `Her hair and cuffs ... her expression stays calm.` 这句。
    //    两个原因：① 点名 expression 会把注意力引到脸（和这次的大脸特写同源）；
    //    ② 腾字符 —— 新增的「距离/占比恒定」那句比原来的「一镜到底」长 42 字符，
    //    真实段4 数据会到 7015（超上限 35），必须让出来。
    `She wears exactly the outfit of <Picture 1>, with the fabric creasing as the real garment does.`,
    // 2026-10-25：删掉原 silhouette 句（hem/seams/jewellery 与上面 outfit 句重复，白占 240 字符）——
    // 腾出的预算给舞步句（实测舞蹈5 段2 加了 260 字符舞步后只余 8 字符，必然触发压缩、先砍 who）。
    'The limbs stay intact through fast passages and <Subject 1> is the only performer in frame.',
    // 🔴 2026-10-26：删掉「The final frame shows the same full-body framing and distance as the first frame.」
    //    实测（4.0.363 跑段1）：片头、片尾都出大脸，中间正常 —— 提示词里只在「首帧/末帧」两处反复强调构图一致
    //    （retention 的 'from the first frame to the last'、镜头句的 'from the first frame to the last'、这句末帧回指），
    //    模型就把这两处当成需要单独处理的位置、画成特写。改为全片口径后不再点名首尾。
    'overall_soundscape:',
    // 2026-10-26：模板层的最后一句否定句也改正面（用户口径：否定句模型听不懂，越写越反）。
    'The complete audio of <Audio 1> is reused unchanged as the final audio track.',
    'non_diegetic_music:',
    'The complete music of <Audio 1> is reused unchanged and is the only music track in the target video.',
  ].filter(Boolean).join('\n')

  // H3 提示词硬上限 7000 字符（用户 2026-10-24 指出；实测整段场景句版本会到 7071 —— 已超）。
  // 场景句是唯一弹性部分：超了就按超出量收紧它，并在切点退回最近的标点，绝不切半句。
  const MAX_PROMPT = 6980
  const cutWords = (t: string, budget: number) => {
    const cut = t.slice(0, Math.max(0, budget))
    return cut.replace(/\s+\S*$/, '').replace(/[\s,;.]+$/, '').trim()
  }
  // 腾地方的第一顺位是**人物描述**，不是场景句：
  // who 有身份卡 + <Picture 1> 双重兜底，压掉几十个字符不丢锁定；
  // 场景句是用户明确要复现的六要素（墙/地/光/灯/色调），砍它=场景开飘（2026-10-24 实测只剩三项）。
  let whoNow = who
  let out = build(sceneOf(sceneLine), whoNow)
  while (out.length > MAX_PROMPT && whoNow.length > 400) {
    whoNow = cutWords(whoNow, whoNow.length - (out.length - MAX_PROMPT) - 2)
    out = build(sceneOf(sceneLine), whoNow)
  }
  // 最后手段：人物描述已压到 400 底限还超，才收场景句（先退标点，再退整词）
  while (out.length > MAX_PROMPT && sceneLine.length > 60) {
    const over = out.length - MAX_PROMPT
    const budget = Math.max(60, sceneLine.length - over - 2)
    const cut = sceneLine.slice(0, budget)
    const m = cut.match(/^[\s\S]*[,;.](\s|$)/)
    sceneLine = (m ? m[0] : cut).replace(/[\s,;.]+$/, '').trim()
    out = build(sceneOf(sceneLine), whoNow)
  }
  return out
}


/**
 * 后台出图排队：同一个项目里的出图请求按点击顺序**串行**跑（图片通道一次只吃一个任务），
 * 每个资产各自记状态，所以一张卡在出图时别的卡照样能点。
 */
const renderQueue = new Map<number, Promise<unknown>>()
function enqueueRender(pid: number, job: () => Promise<unknown>) {
  const prev = renderQueue.get(pid) ?? Promise.resolve()
  const next = prev.then(job, job)
  renderQueue.set(pid, next.catch(() => { }))
  return next
}

/**
 * 2026-10-19 素材库（MV 侧实现，短剧那边一行不改）：
 * - import：把公共素材库里的资产引用到本项目 —— 插一条本项目记录，图片文件共用，不复制
 * - share：把本项目资产存进公共素材库 —— scope 置 library，所有 MV 都能看到/引用
 */
app.post('/projects/:id/assets/:aid/import', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const [src] = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.id, aid))
  if (!src) return notFound(c, '素材不存在')
  if (String((src as any).scope || 'project') !== 'library') return badRequest(c, '不是素材库里的资产')
  const [dup] = await db.select().from(schema.mvAssets).where(and(
    eq(schema.mvAssets.projectId, id), eq(schema.mvAssets.sourceAssetId, aid)))
  if (dup) return success(c, { id: dup.id, skipped: true })
  const nowIso = now()
  const ins = await db.insert(schema.mvAssets).values({
    projectId: id, kind: (src as any).kind, name: (src as any).name,
    description: (src as any).description, appearance: (src as any).appearance,
    styling: (src as any).styling, image: (src as any).image, card: (src as any).card,
    prompt: (src as any).prompt, imageStatus: (src as any).imageStatus,
    scope: 'project', sourceAssetId: aid, sortOrder: 999,
    createdAt: nowIso, updatedAt: nowIso,
  } as any)
  return success(c, { id: getInsertId(ins) })
})

/** 提取到同名资产时，选择「用素材库现有的」→ 把库里那套图片/描述/提示词并进这一行（不新建重复记录） */
/** 换装造型变体（照短剧 `POST /characters/:id/costume-variant`）：
 *  ① 变体是**独立资产行**（自带图/提示词/卡），基准角色一个字都不动；
 *  ② 变体的 appearance **逐字复制**基准 → 脸的文字描述不可能被改坏；
 *  ③ 出图走**图像编辑** `qwen-image-2.1-edit` + 全分辨率原图 → 只换衣服、脸不动。
 *  body: { costume_label, costume_desc? } */
app.post('/projects/:id/assets/:aid/costume-variant', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const base = await assetInProject(id, aid)
  if (!base) return notFound(c, '资产不存在')
  if (String(base.kind) !== 'character') return badRequest(c, '只有人物能换装')
  if (!base.image) return badRequest(c, '这个人物还没有形象图 —— 先点「出图」，再换装')
  const body: any = await c.req.json().catch(() => ({}))
  const label = String(body.costume_label || '').trim()
  if (!label) return badRequest(c, '造型名必填（如「正装」「晚礼服」）')
  const desc = String(body.costume_desc || '').trim() || label
  const baseId = Number((base as any).variantOf || aid)   // 从变体再换装时，始终挂在原始基准下
  const vname = `${base.name}·${label}`.slice(0, 60)
  const ts = now()

  // 同名变体已存在 → 复用该行（只刷新妆造），不重复建
  const sibs = await db.select().from(schema.mvAssets)
    .where(and(eq(schema.mvAssets.projectId, id), eq(schema.mvAssets.variantOf, baseId)))
  let variant = sibs.find((x: any) => String(x.name) === vname && !x.deletedAt)
  if (variant) {
    await db.update(schema.mvAssets).set({
      appearance: String(base.appearance || ''),   // 🔴 每次对齐基准的脸（文字层）
      styling: desc, costumeLabel: label, updatedAt: ts,
    }).where(eq(schema.mvAssets.id, variant.id))
    logTaskProgress('MV', 'costume-reuse', { id, assetId: variant.id, label })
  } else {
    const res = await db.insert(schema.mvAssets).values({
      seriesId: Number((base as any).seriesId) || null,
      projectId: id, kind: 'character', name: vname,
      description: String(base.description || ''),
      appearance: String(base.appearance || ''),    // 🔴 逐字复制 = 脸不变的文字保证
      styling: desc,
      variantOf: baseId, costumeLabel: label,
      sortOrder: Number((base as any).sortOrder || 0) + 1,
      createdAt: ts, updatedAt: ts,
    })
    const newId = Number((res as any)?.lastInsertRowid || 0)
    variant = (await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.id, newId)))[0] as any
    logTaskProgress('MV', 'costume-created', { id, assetId: newId, label, name: vname })
  }
  if (!variant) return serverError(c, '变体创建失败')

  // 出图：图像编辑（同步，约 50 秒）
  try {
    await db.update(schema.mvAssets).set({ imageStatus: 'processing', updatedAt: now() })
      .where(eq(schema.mvAssets.id, variant.id))
    const r = await generateCostumeBoard({
      referenceImage: String(base.image),
      prompt: costumeEditPrompt(label, desc),
    })
    await db.update(schema.mvAssets).set({
      image: r.relativePath, imageStatus: null, updatedAt: now(),
    }).where(eq(schema.mvAssets.id, variant.id))
    logTaskSuccess('MV', 'costume-image', { id, assetId: variant.id, bytes: r.bytes })
  } catch (err: any) {
    await db.update(schema.mvAssets).set({ imageStatus: `failed:${String(err?.message || err).slice(0, 200)}`, updatedAt: now() })
      .where(eq(schema.mvAssets.id, variant.id))
    logTaskError('MV', 'costume-image', { id, assetId: variant.id, error: err?.message })
    return serverError(c, `造型行已建好，但换装出图失败：${err?.message || err}`)
  }
  const fresh = await assetInProject(id, variant.id) || variant
  return success(c, { asset: fresh })
})

app.post('/projects/:id/assets/:aid/use-library', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const body = await c.req.json().catch(() => ({} as any))
  const a0 = await assetInProject(id, aid)
  if (!a0) return notFound(c, '资产不存在')
  const [src] = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.id, Number(body.libraryId || 0)))
  if (!src) return notFound(c, '素材库里没有这条')
  if (String((src as any).scope || '') !== 'library') return badRequest(c, '不是素材库里的资产')
  const patch = {
    image: (src as any).image, card: (src as any).card, prompt: (src as any).prompt,
    appearance: (src as any).appearance, styling: (src as any).styling,
    description: (src as any).description || (a0 as any).description,
    imageStatus: (src as any).imageStatus, sourceAssetId: (src as any).id,
    updatedAt: now(),
  } as any
  await db.update(schema.mvAssets).set(patch).where(eq(schema.mvAssets.id, aid))
  return success(c, { id: aid, assets: await assetsOf(id) })
})

/**
 * 从公共素材库直接取一张已有人物/场景，在本项目建一行（2026-10-25）。
 * 和 /assets/:aid/use-library 的区别：那条是「本项目已有这行，把库形象套上去」；
 * 这条是「本项目还没有，直接从库里挑一个」—— 用户要的「选择已有人物/场景」按钮走这里。
 */
app.post('/projects/:id/assets/from-library', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const libId = Number(body.libraryId || 0)
  if (!libId) return badRequest(c, '缺少 libraryId')
  const [src] = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.id, libId))
  if (!src) return notFound(c, '素材库里没有这条')
  // 2026-10-28：源行可以是公共库条目，也可以是本项目其他歌的资产（选择框两批都列）
  const kind = String((src as any).kind || '')
  if (kind !== 'character' && kind !== 'scene') return badRequest(c, '只支持人物/场景')
  // 本项目已经挂过同一张库卡 → 直接返回，不重复建（连点两下不出两张）
  const dup = await db.select().from(schema.mvAssets)
    .where(and(eq(schema.mvAssets.projectId, id), eq(schema.mvAssets.sourceAssetId, libId)))
  if (dup.length) return success(c, { id: dup[0].id, assets: await assetsOf(id), existed: true })
  const rows = await assetsOf(id)
  const sameKind = rows.filter((r) => String((r as any).kind) === kind)
  const ts = now()
  const [inserted] = await db.insert(schema.mvAssets).values({
    projectId: id,
    kind,
    name: (src as any).name,
    description: (src as any).description,
    appearance: (src as any).appearance,
    styling: (src as any).styling,
    image: (src as any).image,
    card: (src as any).card,
    prompt: (src as any).prompt,
    imageStatus: (src as any).imageStatus,
    scope: 'project',
    sourceAssetId: libId,
    seriesId: Number((project as any).seriesId) || null,
    sortOrder: 100 + sameKind.length,
    createdAt: ts, updatedAt: ts,
  } as any).returning()
  logTaskSuccess('MV', 'asset-from-library', { id, libraryId: libId, kind, assetId: (inserted as any)?.id })
  return success(c, { id: (inserted as any)?.id, assets: await assetsOf(id) })
})

app.post('/projects/:id/assets/:aid/share', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const a0 = await assetInProject(id, aid)
  if (!a0) return notFound(c, '资产不存在')
  await db.update(schema.mvAssets).set({ scope: 'library', updatedAt: now() } as any)
    .where(eq(schema.mvAssets.id, aid))
  // 2026-10-25：把 assets 一起回，前端点「存到素材库」后按钮立刻变「已在素材库」，不用等下一次整页刷新
  return success(c, { id: aid, scope: 'library', assets: await assetsOf(id) })
})

app.post('/projects/:id/assets/:aid/image', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const asset = await assetInProject(id, aid)
  if (!asset) return notFound(c, '资产不存在')
  const body = await c.req.json().catch(() => ({} as any))
  if (body.description !== undefined || body.name !== undefined) {
    await db.update(schema.mvAssets).set({
      description: String(body.description ?? asset.description ?? '').slice(0, 4000),
      name: String(body.name ?? asset.name ?? '').slice(0, 60),
      updatedAt: now(),
    }).where(eq(schema.mvAssets.id, aid))
  }
  const assetPromptRaw = String(body.prompt ?? asset.prompt ?? '').trim()
  // 2026-10-20 用户报「侧面格还是出头」：老提示词里写着「鼻尖朝画面左边」——朝向里带五官词，
  // 模型就把那一格的头画出来了。这里机械替换成纯朝向（幂等，老卡「重绘」也能修好）。
  const assetPrompt = assetPromptRaw
    .replace(/鼻尖朝画面左(?:边|侧)?/g, '身体侧身 90 度，对着画面左侧')
    .replace(/鼻尖朝左/g, '身体侧身 90 度，对着画面左侧')
  if (!assetPrompt) return badRequest(c, '先点「生成提示词」，再出图')
  if (body.prompt !== undefined && assetPrompt !== asset.prompt) {
    await db.update(schema.mvAssets).set({ prompt: assetPrompt.slice(0, 4000), updatedAt: now() })
      .where(eq(schema.mvAssets.id, aid))
  }
  const head = await styleHead(project)
  // 提示词里已经含画风头（生成时就照抄进去了，与短剧 final_prompt 一致）⇒ 这里不再重复拼风格头；
  // 万一是手写的、不含风格头，就补一次
  const prompt = assetPrompt.includes(head.slice(0, 20)) || !head ? assetPrompt : [head, assetPrompt].join('\n')
  const imgSize = imageSizeForAsset(project, asset.kind)
  const kind = asset.kind
  const assetId = asset.id
  // 立刻回「已排队」，真实出图在后台按项目串行跑（接口不再阻塞一分钟）
  await db.update(schema.mvAssets).set({ imageStatus: 'processing', updatedAt: now() })
    .where(eq(schema.mvAssets.id, aid))
  enqueueRender(id, async () => {
    try {
      const size = imgSize      // 人物板固定 2048x1152（16:9）；场景图跟随项目画幅
      const taskId = await generateImage({ prompt, size, configId: project.imageConfigId ?? undefined })
      const task = await waitTask(taskId)
      if (!task.localPath) throw new Error('图片任务完成但没拿到文件路径')
      // 文件名带时间戳：重绘后路径变了，界面才会真的换成新图（同路径会被浏览器缓存成旧图）
      const imageRel = `${mvDir(id)}/${kind}-${assetId}-${Date.now()}.png`
      fs.copyFileSync(getAbsolutePath(task.localPath), getAbsolutePath(imageRel))
      await db.update(schema.mvAssets).set({ image: imageRel, imageStatus: null, updatedAt: now() })
        .where(eq(schema.mvAssets.id, aid))
      logTaskSuccess('MV', 'asset-image', { id, aid, kind, task: taskId })
    } catch (err: any) {
      await db.update(schema.mvAssets).set({ imageStatus: `failed: ${String(err?.message ?? err).slice(0, 160)}`, updatedAt: now() })
        .where(eq(schema.mvAssets.id, aid))
      logTaskError('MV', 'asset-image', { id, aid, error: err?.message })
    }
  })
  return success(c, { assets: await assetsOf(id) })
})

/** 给资产生卡（卡保证人物/场景锁得住；声音卡不接，音轨就是原曲） */
app.post('/projects/:id/assets/:aid/card', async (c) => {
  const id = Number(c.req.param('id'))
  const aid = Number(c.req.param('aid'))
  const asset = await assetInProject(id, aid)
  if (!asset) return notFound(c, '资产不存在')
  if (!asset.image) return badRequest(c, '先出图，再生卡')
  const cardName = `refmod_${asset.kind}-mv${id}a${aid}_v1`
  try {
    await shimPost('/v2/refmod/extract', {
      name: cardName,
      image: readAsDataUrl(asset.image, 'image/png'),
      concept_type: asset.kind === 'character' ? 'identity' : 'background',  // extract_mod 只认 background（'scene' 会 invalid choice 报错）
    })
    await db.update(schema.mvAssets).set({ card: cardName, updatedAt: now() }).where(eq(schema.mvAssets.id, aid))
    logTaskSuccess('MV', 'asset-card', { id, aid, cardName })
    return success(c, { assets: await assetsOf(id) })
  } catch (err: any) {
    logTaskError('MV', 'asset-card', { id, aid, error: err?.message })
    return serverError(c, `抽卡失败：${err?.message}`)
  }
})
// ---------------------------------------------------------------- 分镜

/** 粗分镜：与歌等长的内容时间轴（只写画什么，不写景别运镜） */
/** 从模型回复里抢救出 n 条「画面描述」：JSON 优先，坏了就按行剥序号/引号/逗号 */
function salvageWhat(text: string, n: number): string[] {
  const out: string[] = []
  try {
    const arr = pickJson<any[]>(text)
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const v = typeof it === 'string' ? it : (it?.what ?? it?.画面 ?? it?.desc ?? it?.description ?? '')
        const s = String(v || '').trim()
        if (s) out.push(s)
      }
    }
  } catch { /* 下面是按行抢救 */ }
  // 坏 JSON 抢救：直接把所有 "what":"…" 抠出来（线上真实翻车就是「属性值后缺逗号」这种）
  if (out.length < n) {
    for (const m of String(text || '').matchAll(/"(?:what|画面|desc|description)"\s*:\s*"([^"]{2,200})"/g)) {
      const s = m[1].trim()
      if (s) out.push(s)
    }
  }
  if (out.length < n) {
    for (const raw of String(text || '').split('\n')) {
      let s = raw.trim()
      if (!s) continue
      if (/^[[\]{}]/.test(s) && s.length < 4) continue
      s = s.replace(/^[\s\-*•]+/, '').replace(/^\d+[.、)]\s*/, '')          // 去序号
      s = s.replace(/^["'“]|["'”],?$/g, '').replace(/[,，]\s*$/, '')          // 去引号/尾逗号
      s = s.replace(/^\{?\s*"?what"?\s*:\s*"?/i, '').replace(/"?\s*\}?,?$/, '')
      if (s.length >= 4 && !/^(json|数组|输出)/i.test(s)) out.push(s.trim())
    }
  }
  return out.slice(0, n)
}

/** 解析对轴 LRC → 每句的起止秒（末句用 songSeconds 收尾） */
function parseLrcLines(lrc: string, total: number): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  for (const raw of String(lrc || '').split('\n')) {
    const m = raw.match(/\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\](.*)/)
    if (!m) continue
    const t = Number(m[1]) * 60 + Number(m[2])
    const text = String(m[3] || '').trim()
    if (text) out.push({ start: t, end: 0, text })
  }
  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length; i++) out[i].end = i + 1 < out.length ? out[i + 1].start : total
  return out
}

/** 与 [a,b) 有交集的歌词句子 */
function lyricsInWindow(lines: { start: number; end: number; text: string }[], a: number, b: number): string[] {
  return lines.filter((l) => l.end > a + 0.15 && l.start < b - 0.15).map((l) => l.text)
}

/**
 * 句界吸附切段：候选切点 = 每句起点；每段在 [min,target,max] 里挑离 target 最近的句界。
 * 没有合适句界时退回 start+max（这句会被切在中间，允许）。
 */
function planSegmentsByLines(lines: { start: number; end: number; text: string }[], total: number,
  minS = 5.2, targetS = 7, maxS = 8): { start: number; end: number; lyric: string[] }[] {
  // 候选切点 = 每句起点；但**起点必须从 0 开始** —— 前奏（第一句之前那段伴奏）也要有自己的镜头，
  // 不然整条 MV 缺开头（实测漏了 0~15.1s）。
  const cuts = lines.map((l) => l.start).filter((t) => t > minS && t < total - minS)
  const segs: { start: number; end: number; lyric: string[] }[] = []
  let start = 0
  while (start < total - 1) {
    const ok = cuts.filter((c) => c - start >= minS && c - start <= maxS)
    const end = ok.length
      ? ok.reduce((best, c) => (Math.abs(c - start - targetS) < Math.abs(best - start - targetS) ? c : best), ok[0])
      : Math.min(total, start + maxS)
    segs.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, lyric: lyricsInWindow(lines, start, end) })
    if (end <= start + 0.1) break
    start = end
  }
  return segs
}

app.post('/projects/:id/plan', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  if (!project.songSeconds) return badRequest(c, '还没拿到歌曲时长')
  // 有对轴时间轴：段的时间窗由代码按句界算死（不再让模型猜），模型只管每段「画面发生什么」
  const lrcLines = parseLrcLines(String(project.lyricLrc || ''), Number(project.songSeconds) || 0)
  if (lrcLines.length >= 3) {
    const segs = planSegmentsByLines(lrcLines, Number(project.songSeconds) || 0, 5.2, 7, 8)
    const askByLines = `歌长 ${project.songSeconds} 秒，歌名《${project.title}》。
${project.storyPrompt
  ? `分镜提示词（用户写的，主角/场景/风格都在里面）：\n"""\n${String(project.storyPrompt).slice(0, 8000)}\n"""`
  : `MV 想法：${project.idea || '(没写，按歌名发挥)'}`}

下面是已经按**歌词句界**切好的 ${segs.length} 段（时间与段数不许改，每段标了它唱的那几句）：
${segs.map((s, i) => `${i + 1}. ${s.start}-${s.end}s（${(s.end - s.start).toFixed(2)}s）：${s.lyric.join(' / ') || '(无人声，间奏)'}`).join('\n')}

请逐段写「这一段的画面发生什么」：场景/人物动作/情绪/关键道具，**一句话**，必须贴合这一段唱的内容，也要符合上面的分镜提示词（主角/场景/风格照它写）。
不许写景别、不许写运镜（下一步才配）。不许改段数、不许合并段。**不许把歌词原文当画面描述抄回来。**
只输出一个 JSON 数组，每项只要 what 一个字段（不要 start/end，时间由程序算）：
[{"what":"她低头翻相册，指尖停在那张旧照片上"}, …]`
    const sys = await mvPrompt('mv_storyboard')
    let whats: string[] = []
    let modelErr = ''
    for (let attempt = 1; attempt <= 2 && whats.filter(Boolean).length < segs.length; attempt++) {
      const strict = attempt === 1 ? '' : '\n\n注意：上一次输出不是合法 JSON。这次只输出 JSON 数组本身，不要任何说明文字、不要代码块标记。'
      try {
        const raw = await askText(sys, askByLines + strict, 3000, project.textConfigId)
        whats = salvageWhat(raw, segs.length)
        if (whats.filter(Boolean).length < segs.length) modelErr = `只解析出 ${whats.filter(Boolean).length}/${segs.length} 段`
      } catch (err: any) {
        modelErr = String(err?.message || err)
        logTaskError('MV', 'plan-outline-attempt', { id, attempt, error: modelErr })
      }
    }
    const good = whats.filter(Boolean).length
    // 一条都没拿到就明确报错 —— 绝不能把歌词当画面描述写进分镜（那样用户写了分镜提示词也等于没起作用）
    if (!good) return serverError(c, `AI 没返回可用的画面描述（${modelErr || '空回复'}）。点「AI 改写成分镜」再试一次；连续失败就换个文本模型。`)
    const outline = segs.map((s, i) => ({
      start: s.start, end: s.end,
      what: String(whats[i] || '').slice(0, 200),
    }))
    await db.update(schema.mvProjects).set({ outline: JSON.stringify(outline), status: 'planned', updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'plan-outline', { id, segments: outline.length, by: 'lyrics', got: good })
    return success(c, {
      outline, by: 'lyrics',
      warning: good < segs.length ? `${good}/${segs.length} 段拿到画面描述，其余为空 —— 可以手填，或再点一次重写` : undefined,
    })
  }
  const ask = `歌长 ${project.songSeconds} 秒，歌名《${project.title}》。
${project.storyPrompt
  ? `分镜提示词（用户写的）：\n"""\n${String(project.storyPrompt).slice(0, 8000)}\n"""`
  : `MV 想法：${project.idea || '(没写，按歌名发挥)'}`}
${project.lyrics ? `\n歌词（行，时间未知）：\n${String(project.lyrics).slice(0, 2000)}` : ''}

请给一条「与歌等长」的粗分镜：把 0 到 ${project.songSeconds} 秒分成若干段，前后衔接、不重叠、不留空。
每段只写「画面发生什么」（场景/动作/情绪，一句话），**不要写景别、不要写运镜**（下一步才配）。
段长参考歌曲结构（前奏/主歌/副歌/桥段/尾奏），每段 5~20 秒。
只输出 JSON 数组：[{"start":0,"end":8.5,"what":"…"}, …]`
  try {
    const outline = pickJson<any[]>(await askText(await mvPrompt('mv_storyboard'), ask, 3000, project.textConfigId))
    if (!Array.isArray(outline) || !outline.length) throw new Error('粗分镜为空')
    await db.update(schema.mvProjects).set({ outline: JSON.stringify(outline), status: 'planned', updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'plan-outline', { id, segments: outline.length })
    return success(c, { outline })
  } catch (err: any) {
    logTaskError('MV', 'plan-outline', { id, error: err?.message })
    return serverError(c, err?.message || '粗分镜失败')
  }
})

/** 详细分镜：服务器按能量/句界切硬时间轴（H3 帧网格），MV 侧按镜头语言配景别/机位/歌词 */
app.post('/projects/:id/shots', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  // 分镜的唱/非唱要靠人声轨判，没分离就切会全标成「唱」
  // 舞蹈 MV 没有歌也没有人声轨，切段走参考视频，不受这条约束
  if (String(project.kind || 'song') !== 'dance' && !project.vocalStem) {
    return badRequest(c, '先点顶栏「人声分离」—— 分镜的唱/非唱要用人声轨判断')
  }
  const body = await c.req.json().catch(() => ({} as any))
  const maxS = Math.min(HARD_MAX_S, Number(body.max_seconds || project.maxShotSeconds) || DEFAULT_MAX_S)
  // 到这一步才第一次把原曲转 32k 送 服务器（建项目时不碰它）
  let remoteSong = ''
  try {
    remoteSong = await ensureRemoteSong(project)
  } catch (err: any) {
    return serverError(c, `原曲上传失败：${err?.message || err}`)
  }
  // 有对轴时间轴就把「每句起点」当候选切点传下去：切点落在句界，唱词不会被腰斩。
  // 段长口径 5.2~8s、目标 7s（实测：一句一段平均只有 4.69s，29 句里 20 句短于 服务器的 5.167s 下限）。
  const shotLines = parseLrcLines(String(project.lyricLrc || ''), Number(project.songSeconds) || 0)
  const useLineCuts = shotLines.length >= 3
  const cutMax = useLineCuts ? Math.min(maxS, 8) : maxS
  let plan: { shots: any[]; grid?: number[] }
  try {
    plan = await shimPost('/v2/mv/plan', {
      audio_file: remoteSong, max_seconds: cutMax, target_seconds: 7,
      ...(useLineCuts ? { min_seconds: 5.2, boundaries: shotLines.map((l) => l.start) } : {}),
      vocal_stem: project.vocalStem || undefined,
    })
  } catch (err: any) {
    return serverError(c, `切段失败：${err?.message}`)
  }
  const raw = plan?.shots || []
  if (!raw.length) return serverError(c, '切段结果为空')
  // 2026-10-20 用户报「提取了两张场景，但没有任何分镜用到其中一张」：
  // 以前每段的参考图默认只有「第一个人物 + 第一个场景」，第二张场景永远用不上。
  // 现在按时间把场景铺开（第 k 段落在哪个场景窗口就绑哪个），角色默认第一个，写进 ref_ids。
  const shotAssets = await assetsOf(id)
  const charDefault = shotAssets.find((a) => a.kind === 'character') || null
  const sceneList = shotAssets.filter((a) => a.kind === 'scene')
  const totalForScene = Number((plan as any)?.total_seconds) || Number(project.songSeconds) || 0
  const propList = shotAssets.filter((a) => a.kind === 'prop' && String(a.name || '').trim())
  const squash = (t: any) => String(t || '').replace(/\s+/g, '')
  const propKeys = propNameKeys
  /** 这一段提到哪几个道具就绑哪几个（最多 2 个，按道具库顺序）——分镜文字里没提的绝不绑 */
  const propsInText = (text: string) => {
    const t = squash(text)
    if (!t) return [] as any[]
    return propList.filter((a) => propKeys(a.name).some((k) => t.includes(k))).slice(0, 2)
  }
  const sceneAt = (start: number) => {
    if (!sceneList.length) return null
    if (sceneList.length === 1 || !totalForScene) return sceneList[0]
    const idx = Math.min(sceneList.length - 1, Math.max(0, Math.floor((start / totalForScene) * sceneList.length)))
    return sceneList[idx]
  }
  // 景别按 MV 分镜规范定（由模型按歌词情绪/音乐节奏选），这里只留兜底：有唱默认近景、间奏默认中景、首尾可中远景
  const SIZES = ['中远景', '中景', '近景', '特写']
  const fallbackSize = (i: number, n: number, vocal: string) =>
    (i === 0 || i === n - 1) ? '中远景' : (vocal === 'vocal_active' ? '近景' : '中景')
  const sizes = raw.map((s, i) => fallbackSize(i, raw.length, String(s.vocal_state || '')))
  let outline: any[] = []
  try { outline = JSON.parse(project.outline || '[]') } catch { outline = [] }
  const outlineLine = outline.map((o: any, i: number) => `${i + 1}. ${o.start}-${o.end}s：${o.what}`).join('\n')
  const lyricLines = String(project.lyrics || '').split('\n').map((l) => l.trim()).filter(Boolean)
  let perShot: any[] = []
  try {
    const ask = `下面是已经切好的镜头时间轴（秒/帧/是否在唱），**时间不许改、段数不许改**：
${raw.map((s, i) => `${i}: ${s.start}s 起 ${s.seconds}s（${s.frames}帧） ${s.vocal_state === 'vocal_active' ? '有唱' : '无唱(间奏)'}`).join('\n')}

对应内容（粗分镜）：
${outlineLine || '(无)'}
${useLineCuts
  ? `每段唱的词（**lyric 字段必须原样照抄这一段这几句**，无人声的段留空字符串）：\n${raw.map((s, i) => `${i}: ${(lyricsInWindow(shotLines, Number(s.start), Number(s.end)).join(' / ') || '(无人声，间奏)')}`).join('\n')}`
  : (lyricLines.length ? `歌词行：\n${lyricLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : '')}

你就是这支 MV 的导演。给每段做**镜头编排**（beat），按这一段时长切成 2~4 个镜头，**每拍 2~3.5 秒**（5~6s 段 2 拍；7~9s 段 2~3 拍；10s 以上 3~4 拍）：
- 每个镜头要有起始秒、结束秒（必须首尾相接、从 0 开始、正好铺满这一段时长）
- 景别/机位用**中文**写（机位像 "固定机位，平视，正脸三分之四"，允许 "缓慢推近" 这类运镜）
- **action 和 camera 一律不许留空**（留空等于让模型自由发挥画面）
- action 是这一段镜头里人物/画面**在做什么**，用英文一句短语（如 "she looks down and smiles"），action_zh 给同一句的中文
- **景别要跳**：相邻两拍不要同一个景别（例：中景 → 特写 → 中景），景别在 中远景/中景/近景/特写 里选
- **机位/角度每拍都要换**（正面 → 四分之三侧 → 侧脸過肩），运镜也跟着换（固定 ↗ 缓慢推近 ↗ 固定）
- **段级景别必须交替（硬规则）**：全曲所有段的 shot_size（整段主导景别）**不许连续 3 段相同** —— 严禁一路都是「近景」（现在实测就是这么错的：分镜3/4/5/6 全是近景，拼起来整片怼脸）。按「中远景 → 中景 → 近景 → 特写 → 中景 → 中远景 …」交替推进；副歌可以近景/特写为主，但每 2~3 段必须插一段中景或中远景换气；首尾段用中远景收放
- **相邻段的 action（人物动作）也不许重复或近似**：连着两段都写"往镜头走""对着镜头唱"这类同一动作是**不允许**的 —— 每段的动作要换（例：对镜头唱 → 侧身唱手随乐句抬起 → 闭眼投入 → 偏头朝光 → 换重心下巴抬起），整首歌要有动作起伏
- **相邻段不许重复同样的推进方式**：通篇看一遍你排的所有段，连着两段都是"中景 → 特写"这类同样的景别走向是**不允许**的（拼在一起会跳）；相邻段的景别顺序、机位角度、运镜方向都要明显不同（例：上段「中景 → 特写」，这段就写「近景 → 中远景」或「特写 → 近景」），整首歌的景别要有交替推进的节奏
- 有唱段：**每一拍都必须看得见脸和嘴**（只换角度/景别，不许切背影、手部、空镜）；间奏段才可以切空镜/背影/手部/环境
- 不管怎么切，段内**只能是同一个场景**，不许换地方

只输出 JSON 数组，长度必须等于 ${raw.length}：
[{"index":0,"shot_size":"中景","beats":[{"start":0,"end":2.9,"size":"中景","camera":"固定机位，平视，正脸","action":"she looks up slowly","action_zh":"她缓缓抬头"},{"start":2.9,"end":5.8,"size":"特写","camera":"侧脸过肩，微微俯视","action":"her lips part as she sings","action_zh":"她张嘴唱出第一句"},{"start":5.8,"end":8.0,"size":"中景","camera":"固定机位，四分之三侧","action":"she turns to the light","action_zh":"她转向光"}]}, …]`
    perShot = pickJson<any[]>(await askText(await mvPrompt('mv_camera'), ask, 3000, project.textConfigId))
  } catch { perShot = [] }

  try {
    const ts = now()
    await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, id))
    // 相邻段景别必须「跨两档」（用户口径：中远景→中景 在他眼里就是同一个景，拼起来一定跳）。
    // 档位：中远景/远景=0 · 中景=1 · 近景=2 · 特写=3，相邻段差值必须 ≥2。
    const SIZE_LV: Record<string, number> = { '远景': 0, '中远景': 0, '中景': 1, '近景': 2, '特写': 3 }
    const LV_SIZE: Record<number, string> = { 0: '中远景', 1: '中景', 2: '近景', 3: '特写' }
    // 冲突时不要一律推向最近档（那样中远景↔近景会死循环，中景/特写永远不出现）：
    // 按 0(中远景)→2(近景)→0→3(特写)→1(中景)→3 这个循环取下一个合格档，四档都能轮到。
    const CYCLE = [0, 2, 0, 3, 1, 3]
    let cyc = 0
    let prevPrevLv = -99
    const pickFar = (want: number, prev: number, minLv = 0) => {
      // 合格 = 跨两档，且不是 A→B→A 来回弹（弹来弹去等于只有两种景别），且不低于 minLv
      const ok = (lv: number) => Math.abs(lv - prev) >= 2 && lv !== prevPrevLv && lv >= minLv
      if (ok(want)) {
        const at = CYCLE.indexOf(want)
        cyc = at >= 0 ? (at + 1) % CYCLE.length : cyc
        return want
      }
      for (let k = 0; k < CYCLE.length; k++) {
        const c = CYCLE[(cyc + k) % CYCLE.length]
        if (ok(c)) { cyc = (cyc + k + 1) % CYCLE.length; return c }
      }
      // 放宽「跨两档」：仍必须满足 minLv（上段拉远 ⇒ 本段不能回中远景/中景），挑与上段差得最远的。
      // 注：上段是特写+拉远时，「跨两档」与「拉远后不许回中远景/中景」天然冲突（无解）——
      // 此时以「拉远后不许回中远景/中景」为准（用户 2026-10-21 定的硬规则），跨两档让步。
      if (minLv > 0) {
        const allowed = [0, 1, 2, 3].filter((c) => c >= minLv && c !== want)
        if (allowed.length) {
          const best = allowed.sort((a, b) => Math.abs(b - prev) - Math.abs(a - prev))[0]
          const at = CYCLE.indexOf(best)
          cyc = at >= 0 ? (at + 1) % CYCLE.length : cyc
          return best
        }
      } else {
        // 放宽一轮：只要求跨两档（宁可 A→B→A，也不能只差一档）
        for (const c of [0, 1, 2, 3]) if (Math.abs(c - prev) >= 2 && c !== want) return c
      }
      return want
    }
    let prevLv = -99
    let lastActClass = ''
    // 2026-10-21 用户口径：「上一段末拍是**逐渐拉远**时，下一段不能是中远景/中景」——
    // 拉远后画面已经退到远景，下一段又切回中远景/中景 ⇒ 视觉上「跳一下」。
    // 反过来「上一段是逐渐推进」时，下一段可以回到中远景/中景（观众刚被推进，再拉开是顺的）。
    // 判据取**上一段最后一拍的机位**（拉远/推近写在那儿），不是整段。
    const endsWithPull = (cam: string) => /拉远|后拉|后退|拉走|zoom\s*out|pull\s*(back|out)|dolly\s*out/i.test(String(cam || ''))
    let prevEndCam = ''
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i]
      const extra = (Array.isArray(perShot) ? perShot : []).find((x: any) => Number(x?.index) === i) || {}
      let prevActClass = i > 0 ? (lastActClass || '') : ''
      let sizeEff = SIZES.includes(String(extra?.shot_size || '')) ? String(extra.shot_size) : (sizes[i] || '中景')
      let lv = SIZE_LV[sizeEff] ?? 1
      if (i > 0) {
        // 上段末拍在拉远 → 本段不许落在「中远景/中景」（档位 0/1），必须 ≥2（近景/特写）
        const minLv = endsWithPull(prevEndCam) ? 2 : 0
        lv = pickFar(lv, prevLv, minLv)
      }
      sizeEff = LV_SIZE[lv]
      prevPrevLv = prevLv
      prevLv = lv
      const bet = fitBeats(extra?.beats, Number(s.seconds) || 5.167, sizeEff, String(extra?.camera || ''), i + 1, String(s.vocal_state || '') === 'vocal_active', prevActClass)
      // 记下本段最后一拍的机位，给下一段判断用
      prevEndCam = String(bet[bet.length - 1]?.camera || extra?.camera || '')
      const scenePick = sceneAt(Number(s.start) || 0)
      const segStart = Number(s.start) || 0
      const segEnd = Number(s.end) || segStart
      const segWhat = (() => {
        try {
          return outlineForWindow(JSON.parse(String(project.outline || '[]')) as any[], segStart, segEnd)
            .map((o: any) => String(o.what || '')).join(' ')
        } catch { return '' }
      })()
      const segLyric = useLineCuts
        ? lyricsInWindow(shotLines, segStart, segEnd).join(' ')
        : String(extra?.lyric || '')
      const propsHere = propsInText([segWhat, segLyric, String(extra?.prompt_extra || '')].join(' '))
      // 顺序保持「人物 → 场景 → 道具」（老段没有道具，编号不变）；道具排在最后与短剧一致
      const refIds = [charDefault?.id, scenePick?.id, ...propsHere.map((a: any) => a.id)].filter(Boolean)
      await db.insert(schema.mvShots).values({
        projectId: id, shotNumber: i + 1,
        startSeconds: Number(s.start), endSeconds: Number(s.end),
        frames: Number(s.frames), seconds: Number(s.seconds),
        shotSize: sizeEff,
        camera: String(extra?.camera || '').slice(0, 300),
        beats: JSON.stringify(bet),
        vocalState: String(s.vocal_state || 'vocal_active'),
        // 库里存「这一段真正唱的句子」：模型漏填/填错都以后端按时间窗算出来的为准
        lyric: (useLineCuts
          ? lyricsInWindow(shotLines, Number(s.start), Number(s.end)).join(' / ')
          : String(extra?.lyric || '')).slice(0, 300),
        status: 'pending', createdAt: ts, updatedAt: ts,
        refIds: refIds.length ? JSON.stringify(refIds) : null,
      })
      lastActClass = actClass(bet[0]?.action || '')
    }
    await db.update(schema.mvProjects).set({ status: 'shots', maxShotSeconds: maxS, updatedAt: ts }).where(eq(schema.mvProjects.id, id))
    // 2026-10-21 用户要求：**拆分完就把道具绑好**（不用再点「重新绑道具」）
    let boundProps = 0
    try {
      const madeShots = await shotsOf(id)
      boundProps = (await bindPropsToShots({ ...project, outline: JSON.stringify(outline) }, madeShots)).touched
    } catch (e: any) {
      logTaskError('MV', 'shots-bind-props', { id, error: e?.message })
    }
    logTaskSuccess('MV', 'shots', { id, count: raw.length, maxS, boundProps })
    return success(c, { count: raw.length, max_seconds: maxS, grid: plan.grid || [], bound_props: boundProps, shots: await shotsOf(id) })
  } catch (err: any) {
    logTaskError('MV', 'shots', { id, error: err?.message })
    return serverError(c, err?.message || '写分镜表失败')
  }
})

/** 停止某一段的生成：还没轮到的（仍排队的）直接作废；已在跑的也会在下一轮轮询时收尾 */
app.post('/projects/:id/shots/:sid/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  let ids: number[] = []
  try { ids = JSON.parse(String(shot.taskIds || '[]')).map(Number).filter(Boolean) } catch { ids = [] }
  if (shot.taskId) ids.push(Number(shot.taskId))
  ids = [...new Set(ids.filter(Boolean))]
  // 只作废还在排队的（processing）；已完成的保持原样
  let killed = 0
  for (const tid of ids) {
    const [t] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, tid))
    if (t && t.status === 'processing') {
      await db.update(schema.sysTask).set({ status: 'canceled', errorMsg: '手动停止', updatedAt: now() })
        .where(eq(schema.sysTask.id, tid))
      killed++
    }
  }
  await db.update(schema.mvShots).set({ status: 'pending', taskId: null, errorMsg: null, updatedAt: now() })
    .where(eq(schema.mvShots.id, sid))
  logTaskSuccess('MV', 'cancel', { id, sid, killed })
  return success(c, { id: sid, canceled_tasks: killed, shots: await shotsOf(id) })
})

/** 按名字 + 一次模型判定，把道具绑到给定分镜上（只动道具那部分，人物/场景保持原样）。
 *  拆分分镜后会自动调它（2026-10-21 用户要求「拆分时就绑好」），也可由按钮重跑。 */
async function bindPropsToShots(project: any, shots: any[]): Promise<{ touched: number; props: number }> {
  const id = Number(project?.id)
  const allA = await assetsOf(id)
  const props = allA.filter((a) => a.kind === 'prop')
  if (!props.length || !shots.length) return { touched: 0, props: props.length }
  const propIds = new Set(props.map((a) => a.id))
  const ready = props.filter((a) => a.image)          // 有图才绑（没图绑了也没参考图）
  if (!ready.length) return { touched: 0, props: props.length }
  let outline: any[] = []
  try { outline = JSON.parse(String(project.outline || '[]')) } catch { outline = [] }
  const whatOf = (s: any) => outline
    .filter((o: any) => Number(o?.end) > Number(s.startSeconds || 0) && Number(o?.start) < Number(s.endSeconds || 0))
    .map((o: any) => String(o.what || '')).join(' ')
  const hitMap = new Map<number, number[]>()
  for (const s of shots) {
    const txt = String([s.lyric, whatOf(s)].join(' ')).replace(/\s+/g, '')
    hitMap.set(s.id, ready.filter((a) => propNameKeys(a.name).some((k) => txt.includes(k))).slice(0, 2).map((a) => a.id))
  }
  // 名字对不上的（歌词写「宵夜」、道具叫「外卖保温袋」）交给模型判一次：有界 1 次调用
  const needAI = shots.filter((s) => !(hitMap.get(s.id) || []).length)
  if (needAI.length && ready.length) {
    try {
      const propList2 = ready.map((a, i) => `${i + 1}. ${a.name} —— ${String(a.description || '').slice(0, 80)}`).join('\n')
      const segList = needAI.map((s) => `第${s.shotNumber}段：${String([whatOf(s), s.lyric].filter(Boolean).join(' ')).slice(0, 140)}`).join('\n')
      const raw = await askText(await mvPrompt('mv_prop_map'),
        `下面是这支 MV 的道具清单和分镜段落。判断**每一段画面里真的出现/被使用时**是哪些道具（没出现就别填，宁缺勿滥，每段最多 2 个）。\n\n` +
        `道具清单：\n${propList2}\n\n分镜段落（只列需要判断的）：\n${segList}\n\n` +
        `只输出 JSON：{"segments":[{"n":段号,"props":[道具序号]}]}`, 1500, project.textConfigId)
      const got = pickJson<{ segments?: any[] }>(raw)?.segments || []
      for (const it of got) {
        const s = needAI.find((x: any) => Number(x.shotNumber) === Number(it?.n))
        if (!s) continue
        const ids = (Array.isArray(it?.props) ? it.props : []).map((k: any) => ready[Number(k) - 1]?.id).filter(Boolean).slice(0, 2)
        if (ids.length) hitMap.set(s.id, ids as number[])
      }
    } catch (e: any) {
      logTaskError('MV', 'shots-bind-props-ai', { id, error: e?.message })
    }
  }
  let touched = 0
  for (const s of shots) {
    let ids: number[] = []
    try { ids = JSON.parse(String(s.refIds || '[]')).map(Number).filter(Boolean) } catch { ids = [] }
    const keep = ids.filter((x) => !propIds.has(x))
    const next = [...keep, ...(hitMap.get(s.id) || [])]
    if (JSON.stringify(next) !== JSON.stringify(ids)) {
      await db.update(schema.mvShots).set({ refIds: next.length ? JSON.stringify(next) : null, updatedAt: now() })
        .where(eq(schema.mvShots.id, s.id))
      touched++
    }
  }
  return { touched, props: ready.length }
}

/** 手改单段（景别/机位/歌词/提示词） */
app.put('/projects/:id/shots/:sid', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const patch: Record<string, any> = { updatedAt: now() }
  if (body.shot_size !== undefined) patch.shotSize = String(body.shot_size).slice(0, 20)
  if (body.camera !== undefined) patch.camera = String(body.camera).slice(0, 300)
  if (body.vocal_state !== undefined) patch.vocalState = String(body.vocal_state).slice(0, 20)
  if (body.lyric !== undefined) patch.lyric = String(body.lyric).slice(0, 300)
  // 把历史视频里选中的那一版设为当前（照短剧 setAsMainVideo）
  if (body.video_url !== undefined || body.videoUrl !== undefined) {
    patch.videoUrl = String(body.video_url ?? body.videoUrl) || null
  }
  if (body.prompt !== undefined) patch.prompt = String(body.prompt)
  // 2026-10-21：以前漏了这两个 —— 前端打了字、PUT 静默丢弃 → 轮询一刷新就"自动清空"
  if (body.prompt_extra !== undefined) patch.promptExtra = String(body.prompt_extra || '').slice(0, 1200)
  if (body.ref_ids !== undefined) patch.refIds = JSON.stringify(
    (Array.isArray(body.ref_ids) ? body.ref_ids : []).map(Number).filter(Boolean)).slice(0, 4000)
  await db.update(schema.mvShots).set(patch).where(eq(schema.mvShots.id, sid))
  return success(c, { id: sid })
})

/** 编译六段式提示词（服务器侧编译 + 硬校验，一条不过整批不发） */
app.post('/projects/:id/prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const allShots = await shotsOf(id)
  if (!allShots.length) return badRequest(c, '还没有分镜表，先切分详细分镜')
  // 批量「补齐」：默认只补没有英文稿的段，已生成的不重写（要重写请点该段的「重新生成」）
  const body = await c.req.json().catch(() => ({} as any))
  const missingOnly = body?.missing_only !== false
  // 只补勾选的段（前端多选时传 shot_ids；不传=全部缺的段）
  const pickedIds: number[] = Array.isArray(body?.shot_ids) ? body.shot_ids.map(Number).filter(Number.isFinite) : []
  let shots = missingOnly ? allShots.filter((x: any) => !String(x.promptEn || '').trim()) : allShots
  if (pickedIds.length) shots = shots.filter((x: any) => pickedIds.includes(x.id))
  if (!shots.length) {
    return success(c, { ok: true, done: 0, skipped: allShots.length, message: '每一段都已有提示词，没有需要补齐的' })
  }
  const { character, scene } = await primaryAssets(id)
  if (!character) return badRequest(c, '还没有人物资产（先提取人物并出图）')
  // 2026-10-19：先走 MV 自己的 video-prompt 规范（skills/mv/video-prompt）。
  // 任一条失败 → 整批回退下面的中转编译，保证同一批口径一致。
  try {
    const got: { zh: string; en: string }[] = []
    for (const s0 of shots) {
      const pickedS = (await shotRefs(id, s0)).filter((a0: any) => a0.image)
      const scS = pickedS.find((a0: any) => a0.kind === 'scene') || scene
      const r = await mvShotPromptSkill(project, s0, pickedS, character, scS)
      if (!r) throw new Error(`第 ${(s0 as any).shotNumber} 段生成失败：${lastShotPromptError || '流水线未返回有效内容'}`)
      got.push(r)
    }
    for (let i = 0; i < shots.length; i++) {
      await db.update(schema.mvShots).set({ prompt: got[i].zh, promptEn: got[i].en, updatedAt: now() })
        .where(eq(schema.mvShots.id, (shots[i] as any).id))
    }
    return success(c, { ok: true, done: shots.length, skipped: allShots.length - shots.length, engine: 'skill' })
  } catch (err: any) {
    // 2026-10-19 用户拍板：失败就如实报失败，不再回退中转编译
    logTaskError('MV', 'batch-prompt-failed', { id, error: err?.message })
    return serverError(c, err?.message || '提示词生成失败')
  }
})

/** 单段提示词生成/重新生成（照短剧每段的「AI 生成 / 重新生成」） */
app.post('/projects/:id/shots/:sid/prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  const { character, scene } = await primaryAssets(id)
  if (!character) return badRequest(c, '还没有人物资产（先提取人物并出图）')
  // 舞蹈 MV：提示词是**模板化**的（动作写死复刻 <Video 1>，服装取角色资产 styling），不走 LLM。
  // 前端「全部重写 / 重新生成 / 批量补齐」三个按钮都打这个路由，挡在入口一处即可 ——
  // 原来的 LLM 路径每段各写一套服装/场景，跨段必然漂移（实测段1/段2 换衣）。
  if (String(project.kind || 'song') === 'dance') {
    const all = await db.select().from(schema.mvShots).where(eq(schema.mvShots.projectId, id))
    const frames = Number(shot.frames) || 124
    const shotNo = Number(shot.shotNumber) || 1
    const en = await compileDancePromptEn({
      characterPrompt: danceWhoText(project, character),
      outfit: String(character?.styling || character?.appearance || '').trim(),
      scenePrompt: project.scenePrompt || scene?.description || '',
      style: project.style || '', styleHead: (await getStyleSpecByValue(project.style)).head,
      frames, shotNo, totalShots: all.length || 1,
      scenePic: danceScenePic(await shotRefs(id, shot)),
      actionZh: danceActionText(project, shot),
      force: true,        // 「全部重写 / 重新生成」本来就是要求重来，必须真调模型
    })
    const zh = compileDancePromptZh({ frames, shotNo, totalShots: all.length || 1 })
    await db.update(schema.mvShots).set({ prompt: zh, promptEn: en, updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
    logTaskSuccess('MV', 'dance-prompt-template', { id, sid, chars: en.length, action_err: danceActionError || undefined })
    return success(c, {
      id: sid, prompt: zh, promptEn: en, engine: 'dance-template',
      // 舞步翻译失败时提示词里就没有 moves 句 —— 不静默，直接带回前端
      warn: danceActionError || undefined,
    })
  }
  const picked = (await shotRefs(id, shot)).filter((a) => a.image)
  const sc = picked.find((a) => a.kind === 'scene') || scene
  // 2026-10-19：先走 MV 自己的 video-prompt 规范；失败如实报错
  // 2026-10-19 用户拍板：生成失败就如实报失败，**不偷偷回退旧编译**
  const skill = await mvShotPromptSkill(project, shot, picked, character, sc)
  if (!skill) return serverError(c, `提示词生成失败：${lastShotPromptError || '流水线未返回有效内容'}`)
  await db.update(schema.mvShots).set({ prompt: skill.zh, promptEn: skill.en, updatedAt: now() })
    .where(eq(schema.mvShots.id, sid))
  return success(c, { id: sid, prompt: skill.zh, promptEn: skill.en, engine: 'skill' })
})

/** 改「初步分镜」里某一段的文字（按起止秒匹配那一条；没有就追加）—— 画稿是提示词的剧情依据，必须能改 */
app.post('/projects/:id/outline', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body = await c.req.json().catch(() => ({} as any))
  const start = Number(body?.start), end = Number(body?.end)
  const what = String(body?.what ?? '').trim()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return badRequest(c, '缺 start / end')
  let list: any[] = []
  try { list = JSON.parse(String(project.outline || '[]')) } catch { list = [] }
  if (!Array.isArray(list)) list = []
  const i = list.findIndex((o: any) => Math.abs(Number(o.start) - start) < 0.01 && Math.abs(Number(o.end) - end) < 0.01)
  if (i >= 0) list[i] = { ...list[i], what }
  else list.push({ start, end, what })
  list.sort((a: any, b: any) => Number(a.start) - Number(b.start))
  await db.update(schema.mvProjects).set({ outline: JSON.stringify(list), updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  logTaskSuccess('MV', 'outline-edit', { id, start, end, chars: what.length })
  return success(c, { outline: list })
})

/** 单段提示词生成的真实进度（前端轮询用） */
app.get('/projects/:id/shots/:sid/prompt-progress', async (c) => {
  const sid = Number(c.req.param('sid'))
  const p = shotPromptProgress.get(sid)
  if (!p) return success(c, { step: 0, total: 8, label: '等待开始', done: false, age: 0 })
  return success(c, { step: p.step, total: p.total, label: p.label, done: p.done, age: Date.now() - p.at })
})

/** 本地机械体检：查 服务器那套没覆盖、但我们真踩过的坑（只读，不改动任何内容） */
function localPromptProblems(shot: any, mode: 'song' | 'dance' = 'song'): string[] {
  const en = String(shot?.promptEn || '')
  const out: string[] = []
  if (!en.trim()) return out
  if (mode === 'dance') {
    // 舞蹈段口径：动作来自 <Video 1>，没有唱段，不套 lead singer / 谁都不唱 那套
    if (!en.includes('<Video 1>')) out.push('舞蹈提示词没点名 <Video 1> 作为动作来源')
    if (!en.includes('[video editing + reference generation + audio reuse]')) out.push('舞蹈提示词模式头不对（应为 video editing + reference generation + audio reuse）')
    if (!/complete head/i.test(en)) out.push('舞蹈提示词没声明「有完整头部」（参考板可能被画成裁头，必须补头）')
    if (!/fully_copy/.test(en)) out.push('音频必须是 fully_copy（整段复用源片原音）')
    if (/<d>|<\/d>/.test(en)) out.push('出现 <d> 台词块（MV 不许写台词/歌词）')
    // 注意：舞蹈场景里镜子墙/地板反光都是**合法背景**（舞蹈室标配），
    // 所以这里不吃短剧那把 mirror/reflection 的禁区词 —— 否则正式场景必报假警。
    const bannedD = [...new Set((en.match(/\b(?:screen|screens|phone|phones|smartphone|tablet|projection|poster|photograph|crowd|television|clone|duplicate|ghost)\b/gi) || []).map((x) => x.toLowerCase()))]
    if (bannedD.length) out.push(`含禁区词：${bannedD.slice(0, 4).join(', ')}`)
    // 🔴 2026-10-26 反转：原来锁的是否定句 `Framing is locked: no close-up, no facial shot`。
    //    H3 是 BasicGuider + cfg=1、没有负向分支 —— 否定句不扣分，只是把 close-up / facial shot
    //    这两个词喂进正向描述（官方 base-en/ref-en 的示例提示词里一句否定都没有）。
    //    现在锁正向写法：全片全身 + 画面保持广。
    if (!en.includes('the frame stays wide with the whole body inside it')) {
      out.push('缺景别锁定句（正向：the frame stays wide with the whole body inside it）')
    }
    // 否定短语兜底（2026-10-26）：命中就把原句报出来 —— H3 听不懂否定，写什么反而演什么。
    const negD = findDanceNegations(en)
    if (negD.length) out.push(`含否定短语（H3 无负向分支，会被当正向描述）：${negD.slice(0, 4).join(' | ')}`)
    if (en.length > 7000) out.push(`提示词 ${en.length} 字符，超 H3 上限 7000（编译时会自动收紧场景句，超说明没走模板）`)
    return out
  }
  const det = (en.split(/^detailed_description:\s*$/m)[1] || '').split(/^overall_soundscape:/m)[0]
  if (/^\s*<(?:Subject \d+|Audio 1)>\s+is the supplied song excerpt/im.test(det)) {
    out.push('音频声明混进了 detailed_description（只能出现在 subject_definitions）')
  }
  const ret = (en.split(/^retention_analysis:\s*$/m)[1] || '').split(/^detailed_description:/m)[0]
  if (/<Subject \d+>/.test(ret) && !/\(appears in \[Shot \d+\]\)/.test(ret)) {
    out.push('retention_analysis 缺 (appears in [Shot N]) 标注')
  }
  const vocal = String(shot?.vocalState || '') === 'vocal_active'
  if (vocal && !/lead singer/i.test(en)) out.push('唱段缺「只有 <Subject 1> 唱」的 lead singer 句')
  if (vocal && !/only <Subject 1>'s lips/i.test(en)) out.push('唱段没点名只有 <Subject 1> 对嘴')
  if (!vocal && !/Nobody sings/i.test(en)) out.push('非唱段缺「谁都不唱」声明')
  if (/<d>|<\/d>/.test(en)) out.push('出现 <d> 台词块（MV 不许写台词/歌词）')
  const banned = [...new Set((en.match(/\b(?:screen|screens|phone|phones|smartphone|tablet|mirror|mirrors|reflection|reflections|projection|poster|portrait|painting|photograph|crowd|television|clone|duplicate|ghost)\b/gi) || []).map((x) => x.toLowerCase()))]
  if (banned.length) out.push(`含禁区词：${banned.slice(0, 4).join(', ')}`)
  if (en.length > 7000) out.push(`提示词 ${en.length} 字符，超 H3 上限 7000`)
  return out
}

/** 单段体检 */
app.post('/projects/:id/shots/:sid/check', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  const project = await loadProject(id)
  try {
    if (!String(shot.promptEn || '').trim()) {
      return success(c, { shotNumber: shot.shotNumber, ok: false, problems: ['这一段的英文提示词还没生成 —— 点该段的「AI 生成」'] })
    }
    const mode = String(project.kind || 'song') === 'dance' ? 'dance' : 'song'
    const out = await shimPost<{ rows: any[] }>('/v2/mv/check', {
      mode,
      shots: [{ prompt: shot.promptEn || '', vocal_state: shot.vocalState || 'vocal_active' }],
    })
    const row = out?.rows?.[0] || { ok: false, problems: ['体检无返回'] }
    const problems = [...(row.problems || []), ...localPromptProblems(shot, mode)]
    return success(c, { shotNumber: shot.shotNumber, ok: !problems.length, problems })
  } catch (err: any) {
    logTaskError('MV', 'shot-check', { id, sid, error: err?.message })
    return serverError(c, err?.message || '体检失败')
  }
})

/**
 * 超分到 1080p：等比例放大（原始什么比例就用什么比例），落一条新成片记录。
 * 2026-10-22：原来锁高度 scale=-2:1080 + 判 height≥1080 ⇒ 竖屏源反而被缩小。
 * 改为短边放到 1080：竖屏 768×1344 → 1080×1890，横屏 1344×768 → 1890×1080。
 */
app.post('/projects/:id/upscale', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const body: any = await c.req.json().catch(() => ({}))
  const srcRel = String(body.url || project.outputUrl || '')
  if (!srcRel || !fs.existsSync(getAbsolutePath(srcRel))) return badRequest(c, '还没有成片可超分 —— 先拼接')
  try {
    const rel = mvDir(id)
    // 源成片修过脸的话，1080p 这条也是修脸版 —— 标记跟着走
    const [srcMerge] = await db.select().from(schema.mvMerges)
      .where(and(eq(schema.mvMerges.projectId, id), eq(schema.mvMerges.mergedUrl, srcRel)))
    let srcTags: string[] = []
    try { srcTags = JSON.parse(String(srcMerge?.shotIds || '[]')) } catch { srcTags = [] }
    const inheritFace = Array.isArray(srcTags) && srcTags.includes('face') ? ['face'] : []
    const r = await upscaleVideo(srcRel, rel, 'mv_1080_')
    await db.insert(schema.mvMerges).values({
      // shot_ids 里打 `upscaled` 标记：前端据此把这条的「超分 1080p」按钮置灰，不用再去探一次分辨率
      projectId: id, shotIds: JSON.stringify(['upscaled', ...inheritFace]), mergedUrl: r.outRel,
      seconds: Number(r.from.duration || 0), status: 'completed', createdAt: now(),
    })
    logTaskSuccess('MV', 'upscale', { id, from: `${r.from.w}x${r.from.h}`, to: `${r.to.w}x${r.to.h}` })
    return success(c, { output_url: r.outRel, seconds: Number(r.from.duration || 0), width: r.to.w, height: r.to.h })
  } catch (err: any) {
    logTaskError('MV', 'upscale', { id, error: err?.message })
    return badRequest(c, err?.message || '超分失败')
  }
})

/** 歌词自动对轴：把纯歌词 + 人声轨送到 服务器跑 Whisper，回传 LRC（存在项目上，合成时烧字幕） */
app.post('/projects/:id/align', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  if (!project.vocalStem) return badRequest(c, '先点顶栏「人声分离」—— 对轴要用人声轨')
  const lyrics = String(project.lyrics || '').trim()
  if (!lyrics) return badRequest(c, '先把歌词填进「原始内容」的歌词框')
  try {
    const b: any = await c.req.json().catch(() => ({}))
    // 兼容旧版前端（不传 job）：直接同步对轴并返回 lrc。
    // 新前端传 job:true → 走异步任务，显卡被占用时排队、界面显示「排队中」。
    if (!b?.job) {
      const out = await shimPost<{ lrc: string; lines?: number; unmatched?: number; cover?: number; seconds?: number }>(
        '/v2/mv/align', { audio_file: project.vocalStem, lyrics, tag: `p${id}` },
      )
      const lrc = String(out?.lrc || '')
      if (!lrc.trim()) throw new Error('对轴没有返回时间轴')
      await db.update(schema.mvProjects).set({ lyricLrc: lrc, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
      logTaskSuccess('MV', 'align', { id, lines: out?.lines, cover: out?.cover })
      return success(c, { lrc, lines: out?.lines || 0, unmatched: out?.unmatched || 0, cover: out?.cover || 0, cached: Number(out?.seconds || 0) === 0 })
    }
    // 2026-10-21：改成异步 job —— 显卡被视频任务占用时服务器会排队，前端要能看到「排队中」
    const out = await shimPost<{ job_id?: string; state?: string; message?: string; lrc?: string; lines?: number; unmatched?: number; seconds?: number }>(
      '/v2/mv/align', { audio_file: project.vocalStem, lyrics, tag: `p${id}`, job: true },
    )
    const jobId = String(out?.job_id || '')
    if (!jobId) throw new Error('服务器没有返回对轴任务号')
    logTaskStart('MV', 'align', { id, job: jobId })
    // 服务器缓存命中时直接回 lrc（不再让前端绕一圈轮询）→ 这里就落库
    const lrc0 = String(out?.lrc || '')
    if (out?.state === 'done' && lrc0.trim()) {
      await db.update(schema.mvProjects).set({ lyricLrc: lrc0, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
      logTaskSuccess('MV', 'align', { id, lines: out?.lines })
      return success(c, { job_id: jobId, state: 'done', lrc: lrc0, lines: out?.lines || 0, unmatched: out?.unmatched || 0, seconds: out?.seconds || 0 })
    }
    return success(c, { job_id: jobId, state: out?.state || 'queued', message: out?.message || '' })
  } catch (err: any) {
    logTaskError('MV', 'align', { id, error: err?.message })
    return serverError(c, err?.message || '对轴失败')
  }
})

/** 对轴进度轮询：排队中 / 对轴中 / 完成（完成时才落库） */
app.post('/projects/:id/align/status', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const b: any = await c.req.json().catch(() => ({}))
  const jobId = String(b?.job_id || '')
  if (!jobId) return badRequest(c, '缺 job_id')
  try {
    const out = await shimPost<{ state?: string; message?: string; lrc?: string; lines?: number; unmatched?: number; seconds?: number; error?: string }>(
      '/v2/mv/align/status', { job_id: jobId },
    )
    const state = String(out?.state || 'queued')
    if (state === 'done') {
      const lrc = String(out?.lrc || '')
      if (!lrc.trim()) throw new Error('对轴没有返回时间轴')
      await db.update(schema.mvProjects).set({ lyricLrc: lrc, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
      logTaskSuccess('MV', 'align', { id, lines: out?.lines })
      return success(c, { state: 'done', lrc, lines: out?.lines || 0, unmatched: out?.unmatched || 0, seconds: out?.seconds || 0 })
    }
    if (state === 'failed') {
      logTaskError('MV', 'align', { id, error: out?.error })
      return success(c, { state: 'failed', error: String(out?.error || '对轴失败') })
    }
    return success(c, { state, message: String(out?.message || '') })
  } catch (err: any) {
    return serverError(c, err?.message || '查询对轴状态失败')
  }
})

/** 人声分离（demucs）：产出 vocals.wav，给唱/非唱判据用；幂等，已分离直接返回 */
app.post('/projects/:id/separate', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  // 人声分离已经挪到「上传完歌的第一步」，那时候还没走过详细分镜 → 这里先把歌推上去（幂等：有名字直接返回）
  let remote = String(project.songRemoteName || '')
  if (!remote) {
    try {
      remote = await ensureRemoteSong(project)
    } catch (err: any) {
      return serverError(c, `原曲上传失败：${err?.message || err}`)
    }
  }
  try {
    const out = await shimPost<{ vocals: string; no_vocals?: string; seconds?: number; cached?: boolean }>(
      '/v2/mv/separate', { audio_file: remote, tag: `p${id}`, force: !!project.vocalStem && false },
    )
    const stem = String(out?.vocals || '')
    // 新分离出来的音轨 = 旧的切分判据失效 → 清掉旧分镜（分镜/提示词/生成记录），让用户重切
    let cleared = 0
    if (!out?.cached) {
      const rows = await shotsOf(id)
      cleared = rows.length
      if (cleared) await db.delete(schema.mvShots).where(eq(schema.mvShots.projectId, id))
      await db.update(schema.mvProjects).set({ status: 'outline', updatedAt: now() }).where(eq(schema.mvProjects.id, id))
    }
    await db.update(schema.mvProjects).set({ vocalStem: stem, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'separate', { id, seconds: out?.seconds, cached: out?.cached, cleared })
    return success(c, { vocalStem: stem, noVocals: out?.no_vocals || null, seconds: out?.seconds || 0, cached: !!out?.cached, cleared })
  } catch (err: any) {
    logTaskError('MV', 'separate', { id, error: err?.message })
    return serverError(c, err?.message || '人声分离失败')
  }
})

/** 体检：把每段提示词发给中转跑硬校验，回问题清单（不生成、不改数据） */
app.post('/projects/:id/check', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const shots = await shotsOf(id)
  if (!shots.length) return badRequest(c, '还没有分镜')
  try {
    // 体检检查的是【英文稿 promptEn】——那是真正发给 H3 的；中文稿是给人看的导演分镜稿，不含官方六段
    const mode = String(project.kind || 'song') === 'dance' ? 'dance' : 'song'
    const out = await shimPost<{ rows: any[]; ok: number; bad: number }>('/v2/mv/check', {
      mode,
      shots: shots.map((s) => ({ prompt: s.promptEn || '', vocal_state: s.vocalState || 'vocal_active' })),
    })
    const rows = (out?.rows || []).map((r: any, i: number) => {
      const noEn = !String(shots[i]?.promptEn || '').trim()
      const problems = noEn
        ? ['这一段的英文提示词还没生成 —— 点「编译全部提示词」或该段的「AI 生成」']
        : [...(r.problems || []), ...localPromptProblems(shots[i], mode)]
      return {
        shotNumber: shots[i]?.shotNumber ?? i + 1,
        ok: !noEn && !!r.ok && !localPromptProblems(shots[i], mode).length,
        problems,
      }
    })
    const okN = rows.filter((x) => x.ok).length
    logTaskSuccess('MV', 'check', { id, ok: okN, bad: rows.length - okN })
    return success(c, { ok: okN, bad: rows.length - okN, rows })
  } catch (err: any) {
    logTaskError('MV', 'check', { id, error: err?.message })
    return serverError(c, err?.message || '体检失败')
  }
})

/** 删掉成片（分段视频都留着，只清成片文件 + 字段） */
app.delete('/projects/:id/output', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  if (!project.outputUrl) return badRequest(c, '还没有成片')
  const rel = String(project.outputUrl)
  await db.update(schema.mvProjects).set({ outputUrl: null, status: 'ready', updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  try { fs.rmSync(getAbsolutePath(rel), { force: true }) } catch { /* 文件不在就算了 */ }
  logTaskSuccess('MV', 'delete-output', { id, rel })
  return success(c, { ok: true })
})


/** 舞蹈成片单独修脸：生成阶段不修脸了，拼接完成后由这里对整片修一次。
 *  两张片子（段1/段2）拼完之后脸才统一，所以修脸必须放在这一步。 */
app.post('/projects/:id/merges/:mid/dance-face', async (c) => {
  const id = Number(c.req.param('id'))
  const mid = Number(c.req.param('mid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const [m] = await db.select().from(schema.mvMerges)
    .where(and(eq(schema.mvMerges.id, mid), eq(schema.mvMerges.projectId, id)))
  if (!m?.mergedUrl) return notFound(c, '成片不存在')
  const abs = getAbsolutePath(m.mergedUrl)
  if (!fs.existsSync(abs)) return notFound(c, '成片文件不在（先拼接）')
  const cfg = await getActiveConfig('video')
  if (!cfg?.baseUrl) return badRequest(c, '视频服务没配置')
  const assets = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.projectId, id))
  const charA = assets.find((a) => a.kind === 'character' && a.image)
  if (!charA?.image) return badRequest(c, '缺角色图，没法锁脸')
  const mb = fs.statSync(abs).size / 1048576
  if (mb > 48) return badRequest(c, `成片 ${mb.toFixed(1)}MB 超过 48MB，修脸接口传不动`)
  const base = String(cfg.baseUrl).replace(/\/+$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  let jid = ''
  try {
    const r = await fetch(`${base}/v2/video_generation`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: 'minimax-h3-mv-dance-face',
        video_b64: fs.readFileSync(abs).toString('base64'),
        ref_b64: (readAsDataUrl(charA.image, 'image/png').split(',')[1] || ''),
      }),
    })
    const j: any = await r.json().catch(() => ({}))
    jid = String(j?.task_id || '')
    if (!r.ok || !jid) return serverError(c, `修脸提交失败：${JSON.stringify(j).slice(0, 300)}`)
  } catch (err: any) {
    return serverError(c, `修脸提交失败：${err?.message || err}`)
  }
  logTaskStart('MV', 'dance-face', { id, mid, task: jid })
  const t0 = Date.now()
  while (Date.now() - t0 < 15 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 5000))
    const q: any = await fetch(`${base}/v2/query/video_generation/${jid}`, { headers })
      .then((r) => r.json()).catch(() => null)
    const st = String(q?.task?.status || '')
    if (st === 'succeeded') {
      const url = String(q?.task?.content?.url || '')
      if (!url) return serverError(c, '修脸完成但没返回视频地址')
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
      if (buf.length < 10240) return serverError(c, `修脸结果只有 ${buf.length} 字节，不可用`)
      // 原片留底，再覆盖成片（用户点这个按钮就是要换成修脸版）
      try { fs.copyFileSync(abs, abs.replace(/\.mp4$/i, '.before-face.mp4')) } catch { /* 留底失败不阻断 */ }
      fs.writeFileSync(abs, buf)
      // 打 face 标记（复用 shot_ids 数组，跟超分那条 upscaled 同一机制）—— UI 据此显示「已修脸」
      try {
        let tags: string[] = []
        try { tags = JSON.parse(String(m.shotIds || '[]')) } catch { tags = [] }
        if (!Array.isArray(tags)) tags = []
        if (!tags.includes('face')) tags.push('face')
        await db.update(schema.mvMerges).set({ shotIds: JSON.stringify(tags) }).where(eq(schema.mvMerges.id, mid))
      } catch { /* 标记失败不影响修脸结果 */ }
      logTaskSuccess('MV', 'dance-face', { id, mid, bytes: buf.length, sec: Math.round((Date.now() - t0) / 1000) })
      return success(c, { ok: true, merged_url: m.mergedUrl, bytes: buf.length, faced: true })
    }
    if (st === 'failed' || st === 'error') {
      return serverError(c, `修脸失败：${String(q?.task?.error || '').slice(0, 300)}`)
    }
  }
  return serverError(c, '修脸超时（15 分钟）')
})

/** 本项目所有成片（一次拼接一条，多家并存） */
app.get('/projects/:id/merges', async (c) => {
  const id = Number(c.req.param('id'))
  const rows = await db.select().from(schema.mvMerges)
    .where(and(eq(schema.mvMerges.projectId, id), isNull(schema.mvMerges.deletedAt)))
    .orderBy(desc(schema.mvMerges.id)).limit(200)
  return success(c, { merges: rows })
})

/** 删一条成片：删记录 + 文件；删的若是当前那条，项目成片指回剩下最新 */
app.delete('/projects/:id/merges/:mid', async (c) => {
  const id = Number(c.req.param('id'))
  const mid = Number(c.req.param('mid'))
  const [m] = await db.select().from(schema.mvMerges)
    .where(and(eq(schema.mvMerges.id, mid), eq(schema.mvMerges.projectId, id)))
  if (!m) return notFound(c, '成片不存在')
  await db.delete(schema.mvMerges).where(eq(schema.mvMerges.id, mid))
  try { fs.rmSync(getAbsolutePath(String(m.mergedUrl)), { force: true }) } catch { /* 文件不在就算了 */ }
  const [p0] = await db.select().from(schema.mvProjects).where(eq(schema.mvProjects.id, id))
  if (p0 && String(p0.outputUrl || '') === String(m.mergedUrl || '')) {
    const [next] = await db.select().from(schema.mvMerges)
      .where(and(eq(schema.mvMerges.projectId, id), isNull(schema.mvMerges.deletedAt)))
      .orderBy(desc(schema.mvMerges.id)).limit(1)
    await db.update(schema.mvProjects).set({ outputUrl: next?.mergedUrl || null, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  }
  logTaskSuccess('MV', 'delete-merge', { id, mid })
  return success(c, { ok: true })
})

/** 删掉某一段的某一版视频：删任务记录 + 文件；删的若是当前版本，自动把当前指回剩下最新的一条（照短剧） */
app.delete('/projects/:id/shots/:sid/video', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const url = String(c.req.query('url') || '')
  if (!url) return badRequest(c, '缺 url')
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  let tids: number[] = []
  try { tids = (JSON.parse(String(shot.taskIds || '[]')) as any[]).map(Number).filter(Number.isFinite) } catch { tids = [] }
  const rows = tids.length
    ? await db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, tids))
    : []
  const hit = rows.find((t: any) => (t.localPath || t.resultUrl) === url)
  if (hit) {
    await db.delete(schema.sysTask).where(eq(schema.sysTask.id, hit.id))
    const keep = tids.filter((x) => Number(x) !== Number(hit.id))
    await db.update(schema.mvShots).set({ taskIds: JSON.stringify(keep), updatedAt: now() }).where(eq(schema.mvShots.id, sid))
  }
  try { fs.rmSync(getAbsolutePath(url), { force: true }) } catch { /* 文件不在就算了 */ }
  // 当前版本被删 → 指回剩下最新的一条
  if (String(shot.videoUrl || '') === url) {
    const rest = rows.filter((t: any) => (t.localPath || t.resultUrl) !== url)
    await db.update(schema.mvShots).set({ videoUrl: rest[0]?.localPath || null, updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
  }
  logTaskSuccess('MV', 'delete-video', { id, sid })
  return success(c, { ok: true })
})

// ---------------------------------------------------------------- 出片

/** 提交单段：走 App 视频通道 → 中转按 model=minimax-h3-mv 走 MV 模板 */
app.post('/projects/:id/shots/:sid/render', async (c) => {
  const id = Number(c.req.param('id'))
  const sid = Number(c.req.param('sid'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const [shot] = await db.select().from(schema.mvShots)
    .where(and(eq(schema.mvShots.id, sid), eq(schema.mvShots.projectId, id)))
  if (!shot) return notFound(c, '分镜不存在')
  if (!shot.prompt && !shot.promptEn) return badRequest(c, '这一段还没提示词，先编译提示词')
  const body = await c.req.json().catch(() => ({} as any))
  // 这一段自己绑定的参考图（人物/场景/其它都可能），没绑就用人物卡+场景卡
  const picked = (await shotRefs(id, shot)).filter((a) => a.image)
  if (!picked.length) return badRequest(c, '这一段还没有可用的参考图（先给人物/场景出图，或在这一段勾选绑定）')
  const refs: string[] = picked.map((a) => readAsDataUrl(a.image, 'image/png'))
  const cards = picked.map((a) => a.card).filter(Boolean) as string[]
  const isDance = String(project.kind || 'song') === 'dance'
  const frames = Number(shot.frames) || snapFrames(Number(shot.seconds) || 5.167)
  const [VW, VH] = videoSize(project)
  if (isDance && (!project.danceSource || !project.danceRefSource)) {
    return badRequest(c, '舞蹈 MV 还没上传参考视频（先上传，后台会自动适配备份）')
  }
  // 舞蹈段：提示词按项目资产现场编译（动作来源写死 <Video 1>）。
  // 每次都重编译，不再用「不含 <Video 1> 才编译」做条件 —— 旧稿一旦含 <Video 1>，
  // 改完资产/模板后永远不更新（实测点「编译」也不生效，promptEn 停在旧 4298 字符）。
  if (isDance) {
    const all = await db.select().from(schema.mvShots).where(eq(schema.mvShots.projectId, id))
    // 服装/场景从资产取：项目层 characterPrompt 多为空，提示词里就会退化成通用兜底句，
    // 模型每段各自理解一遍服装 → 跨段换衣（实测段1/段2 两套衣服）。资产 styling 才是权威描述。
    const assets = await db.select().from(schema.mvAssets).where(eq(schema.mvAssets.projectId, id))
    const charAsset = assets.find((a) => a.kind === 'character')
    const sceneAsset = assets.find((a) => a.kind === 'scene')
    // 只取 styling（纯服装描述 145 字符）；appearance 是脸部外观 305 字符，塞进服装句会变成一坨无关描述
    const outfit = String(charAsset?.styling || charAsset?.appearance || '').trim()
    const danceEn = await compileDancePromptEn({
      characterPrompt: danceWhoText(project, charAsset),
      outfit,
      scenePrompt: project.scenePrompt || sceneAsset?.description || '',
      style: project.style || '', styleHead: (await getStyleSpecByValue(project.style)).head,
      frames,
      shotNo: Number(shot.shotNumber) || 1, totalShots: all.length || 1,
      scenePic: danceScenePic(picked),
      actionZh: danceActionText(project, shot),
    })
    const danceZh = compileDancePromptZh({ frames, shotNo: Number(shot.shotNumber) || 1, totalShots: all.length || 1 })
    await db.update(schema.mvShots).set({ promptEn: danceEn, prompt: danceZh, updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
    shot.promptEn = danceEn
  }
  // 舞蹈续接段：整片 = 上一段 + 本段，中转贴音轨要知道上一段从源片哪一帧开始
  // 🔴 2026-10-28（用户「你又整错了」后重算）：段起点**不能**用切分时算死的 startSeconds。
  //   原因：中转每段实际生成 = 17k+5 网格上 ≥ 请求+5 的值（请求 158 → 生成 175 → 新内容 170 帧），
  //   比计划多 12 帧/段；起点仍按死的 158 推进，就等于让「源片向导」和「上一段 latent」各说各话
  //   （实测差 12~17 帧 → 模型既被要求接着上一段画、又被指到更早的画面 → 背景回退/跳帧）。
  //   正解：起点 = 前面各段**实际交付帧数**的和（逐个从磁盘视频真数），和第几段计划多少帧无关。
  let danceStart = 0
  let dancePrevStart = 0
  if (isDance) {
    const segNo = Number(shot.shotNumber) || 1
    if (segNo > 1) {
      const allPrev = (await db.select().from(schema.mvShots).where(eq(schema.mvShots.projectId, id)))
        .filter((x: any) => (Number(x.shotNumber) || 0) < segNo)
        .sort((a: any, b: any) => (Number(a.shotNumber) || 0) - (Number(b.shotNumber) || 0))
      for (const p of allPrev) {
        const rel = String((p as any).videoUrl || '')
        const n = rel ? await countVideoFrames(getAbsolutePath(rel)) : Math.round((Number((p as any).frames) || 0))
        dancePrevStart = danceStart
        danceStart += n
      }
    }
    console.log(`[dance-chain] 段${segNo} 起点 = 前段实际交付累加 ${danceStart} 帧（上一段起点 ${dancePrevStart}）`)
  }
  // 本段可请求的帧数不能超过源片剩余（起点前移后末尾会不够，少给几帧比越界报错好）。
  // 🔴 2026-10-30：原来的 `Math.max(DANCE_MIN_FRAMES, …)` 会把降下来的值强行拉回 124，
  //   中转再 snap17_up(124+5)=141，窗口 408+141=549 > 源片 522 → ComfyUI 直接报
  //   "h3_v2v_fractional: source becomes 115 frames at 24 fps but target needs 124"，整段失败。
  //   根因是续接段每段实际交付 = 规划 + 12 帧左右（10-28「交付 = 整片里本段的内容全拿走」的代价），
  //   前几段多吃，最后一段就没料。这里按「源片窗口真正能给的帧数」反解，并保证落在 17k+5 网格上。
  const totalSrc = Number(project.danceFrames) || 0
  let reqFrames = frames
  if (isDance && danceStart > 0) {
    const srcStart = Math.max(0, danceStart - DANCE_CTX)
    const budget = totalSrc - srcStart
    const snapUp17 = (f: number) => 5 + 17 * Math.max(1, Math.ceil((f - 5) / 17))
    while (reqFrames > 5 && snapUp17(reqFrames + DANCE_CTX) > budget) reqFrames -= 1
    reqFrames = 5 + 17 * Math.floor((reqFrames - 5) / 17)   // 吸附到网格（只往小取，绝不越界）
    if (reqFrames < 5) reqFrames = 5
    if (reqFrames !== frames) {
      console.log(`[dance-chain] 段${shot.shotNumber} 源片窗口只剩 ${budget} 帧 → 请求帧数 ${frames} 降到 ${reqFrames}（生成 ${snapUp17(reqFrames + DANCE_CTX)}）`)
    }
  }
  try {
    const taskId = await generateVideo({
      prompt: String(shot.promptEn || shot.prompt || ''),
      model: isDance ? DANCE_MODEL : MV_MODEL,
      configId: project.videoConfigId ?? undefined,
      duration: Math.max(5.167, frames / 24),
      aspectRatio: project.aspectRatio || '16:9',
      resolution: `${VW}x${VH}`,
      referenceImageUrls: refs,
      seed: body.seed ? Number(body.seed) : undefined,
      // MV 专用字段（适配器原样并进请求体；短剧路径不传这些）
      mvExtras: isDance ? {
        dance_source: project.danceSource,
        dance_ref_source: project.danceRefSource,
        dance_start_frame: danceStart,
        dance_prev_start_frame: dancePrevStart,
        // 段序号（0 起）：第 2 段起服务端会把上一段末 39 帧钉成本段前缀，接缝不跳
        dance_seg_index: Math.max(0, (Number(shot.shotNumber) || 1) - 1),
        // 总段数：服务端只在最后一段跑修脸（前面各段会被最后那次整片修脸覆盖，省一次修脸）
        dance_total_segments: planDanceSegments(Number(project.danceFrames) || 0, danceMaxFrames(project.maxShotSeconds)).length,
        // 源片总帧数：续接段窗口前移后不能超出它，否则音频样本不足会报错
        dance_total_frames: Number(project.danceFrames) || 0,
        mv_frames: reqFrames,
        mv_width: VW, mv_height: VH,
        refmod_files: cards,
      } : {
        mv_audio: { name: await ensureRemoteSong(project) },
        mv_start_seconds: Number(shot.startSeconds) || 0,
        mv_frames: frames,
        mv_width: VW, mv_height: VH,
        refmod_files: cards,
      },
    })
    // 历史视频只认本段自己的任务 id（存 task_ids），不再用 storyboard_id —— 短剧分镜 id 与 MV 段 id 会撞号（实测 145/146/147）
    let prevTasks: string[] = []
    try { prevTasks = JSON.parse(String(shot.taskIds || '[]')) } catch { prevTasks = [] }
    const mergedTasks = [String(taskId), ...prevTasks.filter((x) => String(x) !== String(taskId))].slice(0, 50)
    await db.update(schema.mvShots).set({ taskId: String(taskId), taskIds: JSON.stringify(mergedTasks), status: 'processing', errorMsg: null, updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
    await db.update(schema.mvProjects).set({ status: 'rendering', updatedAt: now() }).where(eq(schema.mvProjects.id, id))
    logTaskStart('MV', 'render', { id, sid, task: taskId, frames: shot.frames })
    return success(c, { task_id: taskId })
  } catch (err: any) {
    await db.update(schema.mvShots).set({ status: 'failed', errorMsg: String(err?.message || err).slice(0, 500), updatedAt: now() })
      .where(eq(schema.mvShots.id, sid))
    logTaskError('MV', 'render', { id, sid, error: err?.message })
    return serverError(c, `提交失败：${err?.message}`)
  }
})

/** 成片：无音轨拼接 + 混原曲整段（听到的就是原歌，不是各段自己的音轨） */
/** 生成 ASS 字幕文件；既没有主创也没有歌词时间轴时返回 null（不烧字幕，保持纯 copy） */
async function makeAss(project: any, videoOnly: string, start: number, total: number, assPath: string): Promise<string | null> {
  const credits = { songTitle: project.songTitle, lyricist: project.lyricist, composer: project.composer }
  const lines = parseLrc(String(project.lyricLrc || ''))
  if (!credits.songTitle && !credits.lyricist && !credits.composer && !lines.length) return null
  const dim = await new Promise<{ w: number; h: number }>((res) =>
    ffmpeg.ffprobe(videoOnly, (e: any, m: any) => {
      const v = (m?.streams || []).find((x: any) => x.codec_type === 'video')
      res({ w: Number(v?.width) || 768, h: Number(v?.height) || 1344 })
    }))
  const ass = buildAss({ width: dim.w, height: dim.h, totalSeconds: total, credits, lyrics: lines, offset: start })
  if (!ass) return null
  fs.writeFileSync(assPath, ass, 'utf8')
  return ass
}

/** 主创三项（曲名/作词/作曲）：随时可改，合成时用 */
app.post('/projects/:id/credits', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const b: any = await c.req.json().catch(() => ({}))
  const patch: Record<string, any> = { updatedAt: now() }
  if ('song_title' in b || 'songTitle' in b) patch.songTitle = String(b.song_title ?? b.songTitle ?? '').trim() || null
  if ('lyricist' in b) patch.lyricist = String(b.lyricist ?? '').trim() || null
  if ('composer' in b) patch.composer = String(b.composer ?? '').trim() || null
  await db.update(schema.mvProjects).set(patch).where(eq(schema.mvProjects.id, id))
  return success(c, { ok: true })
})

app.post('/projects/:id/assemble', async (c) => {
  const id = Number(c.req.param('id'))
  const project = await loadProject(id)
  if (!project) return notFound(c, 'MV 项目不存在')
  const shots = await shotsOf(id)
  const body = await c.req.json().catch(() => ({} as any))
  const ids: number[] = Array.isArray(body?.shot_ids) ? body.shot_ids.map(Number).filter(Number.isFinite) : []
  const ready = shots.filter((s) => s.videoUrl)
  const done = ids.length ? ready.filter((s) => ids.includes(s.id)) : ready
  if (!done.length) return badRequest(c, ids.length ? '勾选的镜头里没有已生成的分段' : '还没有生成好的分段')
  const isDance = String(project.kind || 'song') === 'dance'
  if (isDance) {
    // 舞蹈 MV：各段自带参考视频原音 → 顺序拼接即可，不混原曲、不烧字幕
    const relD = mvDir(id)
    const outNameD = `mv_dance_final_${Date.now()}.mp4`
    const outAbsD = path.join(STORAGE_ROOT, relD, outNameD)
    const FPS = 24
    const durOfD = (f: string) => new Promise<number>((res) =>
      ffmpeg.ffprobe(f, (e: any, m: any) =>
        res(e ? 0 : Number((m?.streams || []).find((x: any) => x.codec_type === 'video')?.duration) || 0)))
    try {
      const filesD: string[] = []
      const chainsD: string[] = []
      const wavIns: string[] = []        // 每段裁尾时额外导出的 PCM 音轨（逐采样精确）
      let totalD = 0
      for (let i = 0; i < done.length; i++) {
        const abs = getAbsolutePath(done[i].videoUrl as string)
        filesD.push(abs)
        const sec = Number(done[i].seconds) || (Number(done[i].frames) || 124) / FPS
        const dur = await durOfD(abs)
        // 帧数按实测时长定：shot.seconds 是数据库里的旧值（段2 实际 8.5s / 204 帧，库里还写 8.0），
        // 拿它当上限会白裁掉半秒（实测拼出 384 帧而不是 396）。段视频已经在落盘时裁准了。
        const need = Math.max(1, Math.round((dur || sec) * FPS))
        chainsD.push(`[${i}:v]trim=start_frame=0,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=3,trim=end_frame=${need},setpts=PTS-STARTPTS,fps=${FPS},setsar=1[v${i}]`)
        // 音频优先用裁尾时导出的 PCM（.seg.wav）：MP4 里的 aac 按 1024 采样一块存，
        // 装不下 158/24 = 210666.7 这种非整数采样长度，每段短几十~上百毫秒 → 拼起来后半段卡。
        // PCM 实测能给到 210667 采样（差 0.01ms），这才是"拼接后音乐不卡"的关键。
        const wavPath = abs.replace(/\.mp4$/i, '.seg.wav')
        if (fs.existsSync(wavPath)) {
          wavIns.push(wavPath)
          // 🔴 索引必须用「视频总数 + 已加 wav 数」：ffmpeg 的 input 顺序是先全部视频、再全部 wav。
          // 原来写 filesD.length，而它在循环里是动态增长的 —— 第 1 段算出来是 1，
          // 指到了第 2 段的视频文件，导致成片开头播的是段2 的音频（实测 corr 与源片0秒 -0.06、
          // 与源片6.58秒 0.9997，用户听出来"段1 像段2"）。
          const idx = done.length + wavIns.length - 1
          chainsD.push(`[${idx}:a]atrim=start=0:duration=${(need / FPS).toFixed(6)},asetpts=PTS-STARTPTS,aresample=32000[a${i}]`)
          totalD += need / FPS
          continue
        }
        // 没导出的段（旧片）退回 MP4 音轨；无音轨就补静音（直接写 [i:a] 会让整条 graph 失败）
        const hasAudio = await new Promise<boolean>((res) => ffmpeg.ffprobe(abs, (e: any, m: any) =>
          res(!e && (m?.streams || []).some((x: any) => x.codec_type === 'audio'))))
        chainsD.push(hasAudio
          ? `[${i}:a]atrim=start=0:duration=${(need / FPS).toFixed(4)},asetpts=PTS-STARTPTS,aresample=32000[a${i}]`
          : `anullsrc=r=32000:cl=mono,atrim=start=0:duration=${(need / FPS).toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`)
        totalD += need / FPS
      }
      const graphD = `${chainsD.join(';')};${done.map((_: any, i: number) => `[v${i}][a${i}]`).join('')}concat=n=${done.length}:v=1:a=1[vout][aout]`
      await new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg()
        for (const f of filesD) cmd = cmd.input(f)
        for (const w of wavIns) cmd = cmd.input(w)
        cmd.complexFilter(graphD)
          .outputOptions(['-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '20',
            '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart'])
          .on('end', () => resolve()).on('error', (e: Error) => reject(new Error(`拼接失败：${e.message}`)))
          .save(outAbsD)
      })
    } catch (err: any) {
      logTaskError('MV', 'assemble-dance', { id, error: err?.message })
      return serverError(c, err?.message)
    }
    const outRelD = `${mvDir(id)}/${outNameD}`
    await db.insert(schema.mvMerges).values({
      projectId: id, shotIds: JSON.stringify(done.map((s) => s.id)), mergedUrl: outRelD,
      seconds: done.reduce((a, s) => a + (Number(s.seconds) || 0), 0), status: 'completed', createdAt: now(),
    } as any)
    await db.update(schema.mvProjects).set({ outputUrl: outRelD, status: 'done', updatedAt: now() })
      .where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'assemble-dance', { id, shots: done.length })
    // 少段必须吭声：原来静默按勾选拼，用户以为四段都进去了（实测成片 474 帧 = 3 段，少 6.4 秒）
    const missing = shots.length - done.length
    return success(c, {
      output_url: outRelD,
      seconds: done.reduce((a, s) => a + (Number(s.seconds) || 0), 0),
      merged_shots: done.length,
      total_shots: shots.length,
      warning: missing > 0 ? `只拼接了 ${done.length}/${shots.length} 段，${
        shots.filter((s) => !done.some((d: any) => d.id === s.id)).map((s) => `段${s.shotNumber}`).join('、')
      } 没进成片（未勾选或还没生成）` : '',
    })
  }
  // 原曲文件丢了（实测 mv/p1/song_src.mp3 被清掉过）→ 先找同目录的 song_src.wav / .mp3 兜底，再报人话
  const songRel = (() => {
    const cur = String(project.songFile || '')
    if (cur && fs.existsSync(getAbsolutePath(cur))) return cur
    const dir = mvDir(id)
    for (const name of ['song_src.wav', 'song_src.mp3', 'song_32k.wav', 'song_32k.mp3']) {
      const rel2 = `${dir}/${name}`
      if (fs.existsSync(getAbsolutePath(rel2))) return rel2
    }
    return cur
  })()
  if (!songRel || !fs.existsSync(getAbsolutePath(songRel))) return badRequest(c, '原曲文件丢了（' + (project.songFile || '未设置') + '）：请重新导入这首歌再混音')
  if (songRel !== project.songFile) {
    await db.update(schema.mvProjects).set({ songFile: songRel, updatedAt: now() }).where(eq(schema.mvProjects.id, id))
    logTaskSuccess('MV', 'song-file-fallback', { id, from: project.songFile, to: songRel })
    project.songFile = songRel
  }
  const rel = mvDir(id)
  const listPath = path.join(STORAGE_ROOT, rel, 'concat.txt')
  fs.writeFileSync(listPath, done.map((s) => `file '${getAbsolutePath(s.videoUrl as string)}'`).join('\n'))
  const videoOnly = path.join(STORAGE_ROOT, rel, 'video_only.mp4')
  const outName = `mv_final_${Date.now()}.mp4`
  const outAbs = path.join(STORAGE_ROOT, rel, outName)
  const start = Number(done[0].startSeconds) || 0
  const total = done.reduce((a, s) => a + (Number(s.seconds) || 0), 0)
  try {
    // 每段视频实际时长常比它的时间窗长（trim 只在 got>want 时裁、还按帧取整）→ 直接 -c copy 拼会把富余时长
    // 累加成错位（实测 3 段就差 1.4s，嘴形全错）。这里按每段自己声明的秒数精确裁，总长必然 = sum(seconds) = 音频窗口。
    const durOf = (f: string) => new Promise<number>((res) =>
      ffmpeg.ffprobe(f, (e: any, m: any) =>
        res(e ? 0 : Number((m?.streams || []).find((x: any) => x.codec_type === 'video')?.duration) || 0)))
    const files: string[] = []
    const chains: string[] = []
    const FPS = 24
    let acc = 0   // 累计秒；按绝对帧网格取整，段间误差不累积（按秒裁每段最多丢/多 1 帧，21 段能累积到 0.9s）
    for (let i = 0; i < done.length; i++) {
      const abs = getAbsolutePath(done[i].videoUrl as string)
      const sec = Number(done[i].seconds) || 0
      const dur = await durOf(abs)
      // 老片段开头带 0.5s 预热（实测：shot1 音频相对原曲偏 +0.5s、时长 7.30 vs 窗口 6.58；新生成的 shot2 偏移 0.000）
      // ⇒ 只要比窗口多出 0.3~1.2s 就按带预热处理，跳掉 0.5s；新片段 extra≈0，不动。零累积由下面的帧网格保证。
      const extra = dur - sec
      const skip = extra > 0.3 && extra < 1.2 ? MV_WARMUP_SECONDS : 0
      const f0 = Math.round(acc * FPS)
      acc += sec
      const f1 = Math.round(acc * FPS)
      const skipF = Math.round(skip * FPS)
      files.push(abs)
      // 先用 tpad 克隆末帧兜底再按帧数截断：某些段文件比应得帧数少 1~2 帧（实测 16 段少 6 帧 = 0.25s，
      // 拼到第 10 段以后就明显错位）——直接 end_frame 会被截断到源文件帧数，缺口累积。
      const need = Math.max(1, f1 - f0)
      chains.push(`[${i}:v]trim=start_frame=${skipF},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=3,trim=end_frame=${need},setpts=PTS-STARTPTS,fps=${FPS},setsar=1[v${i}]`)
    }
    const graph = `${chains.join(';')};${done.map((_: any, i: number) => `[v${i}]`).join('')}concat=n=${done.length}:v=1:a=0[vout]`
    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg()
      for (const f of files) cmd = cmd.input(f)
      cmd.complexFilter(graph)
        .outputOptions(['-map', '[vout]', '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
        .on('end', () => resolve()).on('error', (e: Error) => reject(new Error(`拼接失败：${e.message}`))).save(videoOnly)
    })
    // 字幕：主创（曲名/作词/作曲）+ 歌词逐句。有 ASS 才烧，没有就保持原来的 -c:v copy 直接混音。
    // ASS 必须放在**无空格**的路径：放 data/static 下会被 "Application Support" 里的空格切断
    // filtergraph 参数（实测报 subtitles.ass': Invalid argument）。
    const assPath = path.join(os.tmpdir(), `mv_sub_${id}_${Date.now()}.ass`)
    const assText = await makeAss(project, videoOnly, start, total, assPath)
    await new Promise<void>((resolve, reject) => {
      const mix = ffmpeg(videoOnly).input(getAbsolutePath(project.songFile as string)).inputOptions([`-ss ${start}`])
      const base = ['-map 0:v', '-map 1:a', '-c:a aac', '-b:a 192k', '-t', String(total), '-movflags +faststart']
      const out = assText
        // 烧字幕要重编码画面（字幕是画进像素的）；preset veryfast + crf 20 与拼接同档，画质不变
        // 路径交给 filtergraph 要做两级转义：先 \ 转 /，再转义 : 和 '（空格上一步已避开）
        ? ['-vf', `subtitles=filename=${assFilterPath(assPath)}`, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...base]
        : ['-c:v', 'copy', ...base]
      mix.outputOptions(out)
        .on('end', () => resolve()).on('error', (e: Error) => reject(new Error(`混音失败：${e.message}`))).save(outAbs)
    })
  } catch (err: any) {
    logTaskError('MV', 'assemble', { id, error: err?.message })
    return serverError(c, err?.message)
  }
  const outRel = `${rel}/${outName}`
  // 每拼一次就留一条记录，多家并存（照短剧 video_merges）
  await db.insert(schema.mvMerges).values({
    projectId: id, shotIds: JSON.stringify(done.map((s) => s.id)), mergedUrl: outRel,
    seconds: total, status: 'completed', createdAt: now(),
  })
  await db.update(schema.mvProjects).set({ outputUrl: outRel, status: 'done', updatedAt: now() }).where(eq(schema.mvProjects.id, id))
  logTaskSuccess('MV', 'assemble', { id, seconds: total })
  return success(c, { output_url: outRel, seconds: total })
})

export default app
export { parseLrcLines, planSegmentsByLines, lyricsInWindow, salvageWhat, localPromptProblems, propNameKeys,
         planDanceSegments, compileDancePrompt, compileDancePromptZh, danceActionText, danceScenePic,
         translateDanceAction, danceSeamStart, danceMotionSeam, trimDanceSegmentTail, resnapFrameCount }   // 给自检脚本用
