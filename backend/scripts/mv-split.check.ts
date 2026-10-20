// 拆分层自检：相邻段景别必须跨两档（|Δ|≥2）；档位不能只剩两种
const SIZE_LV: Record<string, number> = { '远景': 0, '中远景': 0, '中景': 1, '近景': 2, '特写': 3 }
const LV_SIZE: Record<number, string> = { 0: '中远景', 1: '中景', 2: '近景', 3: '特写' }
const CYCLE = [0, 2, 0, 3, 1, 3]

function plan(sizes: string[]) {
  let prevLv = -99, prevPrevLv = -99, cyc = 0
  const pickFar = (want: number, prev: number) => {
    const ok = (lv: number) => Math.abs(lv - prev) >= 2 && lv !== prevPrevLv
    if (ok(want)) { const at = CYCLE.indexOf(want); cyc = at >= 0 ? (at + 1) % CYCLE.length : cyc; return want }
    for (let k = 0; k < CYCLE.length; k++) {
      const c = CYCLE[(cyc + k) % CYCLE.length]
      if (ok(c)) { cyc = (cyc + k + 1) % CYCLE.length; return c }
    }
    for (const c of [0, 1, 2, 3]) if (Math.abs(c - prev) >= 2 && c !== want) return c
    return want
  }
  return sizes.map((s, i) => {
    let lv = SIZE_LV[s] ?? 1
    if (i > 0) lv = pickFar(lv, prevLv)
    prevPrevLv = prevLv; prevLv = lv
    return { size: LV_SIZE[lv], lv }
  })
}

const rows = plan(Array(10).fill('中远景'))
let fail = 0
for (let i = 1; i < rows.length; i++) {
  const d = Math.abs(rows[i].lv - rows[i - 1].lv)
  if (d < 2) { console.log(`✗ 第${i}/${i + 1}段只差 ${d} 档：${rows[i - 1].size} / ${rows[i].size}`); fail++ }
}
const used = new Set(rows.map((r) => r.lv))
console.log('结果:', rows.map((r) => r.size).join(' → '))
console.log('用到档位:', [...used].sort().map((l) => LV_SIZE[l]).join('/'))
if (used.size < 3) { console.log('❌ 档位太单一'); fail++ }
console.log(fail ? `❌ ${fail} 处问题` : '✅ 相邻跨两档，且三种以上档位轮流出现')
if (fail) process.exit(1)
