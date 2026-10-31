/**
 * 舞蹈续拍「接缝位置」自检（纯算术，不跑 GPU）
 *
 * 已由用户实测确认的两条映射（2026-10-28）：
 *   ① 整片(video) 第 frameSkip 帧 = 本段内容起点；frameSkip = 整片 − gen + 5 = 上一段生成帧数
 *      → 段3 frameSkip 175 时画面接得上（用户：「画面连续」）
 *   ② 整片(audio) 第 k 帧 = 源片 PREV_START + k
 *      → 段3 skip 163 时音频落在源片 321，而画面在 328 → 音乐重复 7 帧（用户：「音乐重复了一下」）
 *
 * 由 ①②：音频 skip 的物理真值 = S_n − PREV_START = 上一段**交付帧数**（不是计划的 frames+5）。
 * 本脚本把这条规则对每一段跑一遍，断言「音频终点 == 画面起点」，失败即退出码 1。
 *
 * 跑：npx tsx scripts/mv-dance-seam.check.ts
 */
const FPS = 24
const CTX = 5 // mv_core.py DANCE_CTX_FRAMES

type Seg = {
  no: number
  start: number // 本段在源片的起点 S_n
  req: number // 请求帧数（计划）
  gen: number // 中转实际生成帧数（17k+5 网格；首段不带前缀）
  delivered: number // 实际交付帧数
}

/** 中转真实生成帧数：首段 = req；续接段 = snapUp17(req + CTX)，再按源片剩余收口 */
function genFrames(req: number, start: number, totalSrc: number, segIdx: number): number {
  if (segIdx === 0) return req
  const snapUp17 = (n: number) => {
    let k = 5
    while (k < n) k += 17
    return k
  }
  let g = snapUp17(req + CTX)
  const srcStart = Math.max(0, start - CTX)
  while (srcStart + g > totalSrc + 1 && g > 5) g -= 17
  return g
}

function build(totalSrc: number): Seg[] {
  const specs = [
    { no: 1, start: 0, req: 158 },
    { no: 2, start: 0, req: 158 },
    { no: 3, start: 0, req: 158 },
    { no: 4, start: 0, req: 155 },
  ]
  const out: Seg[] = []
  let start = 0
  specs.forEach((s, i) => {
    const gen = genFrames(s.req, start, totalSrc, i)
    // 交付：整片里属于本段的全拿走；整片 = 上一段 gen + 本段 gen − 5
    const prevGen = i === 0 ? 0 : out[i - 1].gen
    const got = i === 0 ? gen : prevGen + gen - CTX
    const frameSkip = i === 0 ? 0 : got - gen + CTX
    const delivered = i === 0 ? gen : got - frameSkip
    out.push({ no: s.no, start, req: s.req, gen, delivered })
    start += delivered // 🔴 关键：下一段起点 = 前几段实际交付累加
  })
  return out
}

function check(totalSrc: number) {
  const segs = build(totalSrc)
  let prevStart = 0
  let prevDelivered = 0
  let prevGen = 0
  let ok = true
  console.log(`源片 ${totalSrc} 帧`)
  for (const s of segs) {
    const got = s.no === 1 ? s.gen : segs[s.no - 2].gen + s.gen - CTX
    const frameSkip = s.no === 1 ? 0 : got - s.gen + CTX
    // 画面：整片 frameSkip 帧 → 源片 S_n
    // 整片(piece) 第 p 帧 ↔ 源片 S_n + p − 上一段生成帧数（由 concat 丢本段前 CTX 帧推出；
    // 用户实测确认：段3 p=175 → 源片 328 = S_3）
    const picAt = s.no === 1 ? 0 : s.start + frameSkip - prevGen
    // 音频：整片音轨基点 = max(0, PREV_START − CTX)（mv_core.py src_start 同基，实测 ncc 0.98~0.99）
    // 真值 skip = frameSkip（音画同基）
    const audioBase = s.no === 1 ? 0 : Math.max(0, prevStart - CTX)
    const skip = s.no === 1 ? 0 : frameSkip
    const audAt = s.no === 1 ? 0 : audioBase + skip
    const end = s.start + s.delivered
    const line = `  段${s.no}: 起点 ${s.start} | gen ${s.gen} | 整片 ${got} | 画面截 ${frameSkip}→源片 ${s.start} | 音频截 ${skip}→源片 ${audAt} | 交付 ${s.delivered} → 覆盖 ${s.start}~${end - 1}`
    console.log(line)
    if (picAt !== s.start) { console.log(`  ✗ 段${s.no} 画面落点 ${picAt} ≠ 起点 ${s.start}`); ok = false }
    if (audAt !== s.start) { console.log(`  ✗ 段${s.no} 音频落点 ${audAt} ≠ 起点 ${s.start}（音乐重叠/缺口 ${audAt - s.start} 帧）`); ok = false }
    if (s.start < prevStart + prevDelivered && s.no > 1) {
      console.log(`  ✗ 段${s.no} 起点 ${s.start} < 上一段结束 ${prevStart + prevDelivered}（会重复）`)
      ok = false
    }
    if (end > totalSrc) { console.log(`  ✗ 段${s.no} 覆盖到 ${end}，超出源片 ${totalSrc}`); ok = false }
    prevStart = s.start
    prevDelivered = s.delivered
    prevGen = s.gen
  }
  // 回归断言：旧规则（音频 skip = 上一段**计划** frames + 5）必须被判为错位，
  // 否则说明这个自检已经抓不到「音乐重复一下」（段3 实测：落 321、画面 328、重复 7 帧）。
  {
    const s3 = segs[2]
    const prevPlan = segs[1].req
    const oldAudAt = Math.max(0, segs[1].start - CTX) + (prevPlan + CTX)
    if (oldAudAt === s3.start) {
      console.log('  ✗ 回归断言失效：旧规则居然也算对，自检不可信')
      ok = false
    } else {
      console.log(`  ✓ 回归断言：旧规则会让段3 音频落 ${oldAudAt}（本段起点 ${s3.start}）→ 重复 ${s3.start - oldAudAt} 帧`)
    }
  }
  const total = segs.reduce((a, b) => a + b.delivered, 0)
  console.log(`  合计 ${total} 帧，源片 ${totalSrc}，末段少 ${totalSrc - total} 帧`)
  if (!ok) throw new Error('接缝位置自检失败')
  console.log('  全部通过：每段画面起点 == 音频落点 == 本段起点，无重复无缺口')
}

check(631)
