// 拆分层自检：
//   ① 相邻段景别必须跨两档（|Δ|≥2）；档位不能只剩两种
//   ② 上一段末拍「缓慢拉远」时，下一段不许是中远景/中景（用户 2026-10-21 口径：会跳一下）
const SIZE_LV: Record<string, number> = { '远景': 0, '中远景': 0, '中景': 1, '近景': 2, '特写': 3 }
const LV_SIZE: Record<number, string> = { 0: '中远景', 1: '中景', 2: '近景', 3: '特写' }
const CYCLE = [0, 2, 0, 3, 1, 3]
const endsWithPull = (cam: string) => /拉远|后拉|后退|拉走|zoom\s*out|pull\s*(back|out)|dolly\s*out/i.test(String(cam || ''))

/** 与 routes/mv.ts 里的 pickFar 同构（多一个 minLv：上段拉远时本段不得低于该档） */
function plan(sizes: string[], endCams: string[] = []) {
  let prevLv = -99, prevPrevLv = -99, cyc = 0
  let prevEndCam = ''
  const pickFar = (want: number, prev: number, minLv = 0) => {
    const ok = (lv: number) => Math.abs(lv - prev) >= 2 && lv !== prevPrevLv && lv >= minLv
    if (ok(want)) { const at = CYCLE.indexOf(want); cyc = at >= 0 ? (at + 1) % CYCLE.length : cyc; return want }
    for (let k = 0; k < CYCLE.length; k++) {
      const c = CYCLE[(cyc + k) % CYCLE.length]
      if (ok(c)) { cyc = (cyc + k + 1) % CYCLE.length; return c }
    }
    if (minLv > 0) {
      // 上段拉远 ⇒ 本段不能回中远景/中景（硬规则优先）。
      // 注：上段是特写+拉远时，「跨两档」与这条天然冲突（无解）——此时以这条为准，跨两档让步。
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
  return sizes.map((s, i) => {
    let lv = SIZE_LV[s] ?? 1
    if (i > 0) lv = pickFar(lv, prevLv, endsWithPull(prevEndCam) ? 2 : 0)
    prevPrevLv = prevLv; prevLv = lv
    prevEndCam = endCams[i] || ''
    return { size: LV_SIZE[lv], lv }
  })
}

let fail = 0

// ---- ① 相邻跨两档 + 档位多样性 ----
// 注：上段「特写+拉远」时，「跨两档」与「拉远后不许回中远景/中景」天然冲突（无解）——
// 此时以「拉远后不许回中远景/中景」为准（用户 2026-10-21 定的硬规则），跨两档让步。判据同源。
{
  const rows = plan(Array(10).fill('中远景'))
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i].lv - rows[i - 1].lv)
    if (d < 2) { console.log(`✗ 第${i}/${i + 1}段只差 ${d} 档：${rows[i - 1].size} / ${rows[i].size}`); fail++ }
  }
  const used = new Set(rows.map((r) => r.lv))
  console.log('结果:', rows.map((r) => r.size).join(' → '))
  console.log('用到档位:', [...used].sort().map((l) => LV_SIZE[l]).join('/'))
  if (used.size < 3) { console.log('❌ 档位太单一'); fail++ }
  console.log(fail ? `❌ ${fail} 处问题` : '✅ 相邻跨两档，且三种以上档位轮流出现')
}

// ---- ② 拉远后不许接中远景/中景 ----
{
  const sizes = ['特写', '中景', '特写', '中远景', '中景', '特写']
  const cams = ['缓慢拉远', '固定机位', '缓慢拉远', '固定机位', '固定机位', '缓慢推近']
  const rows = plan(sizes, cams)
  console.log('\n拉远衔接检查:')
  for (let i = 1; i < rows.length; i++) {
    const pulled = endsWithPull(cams[i - 1])
    const bad = pulled && rows[i].lv <= 1
    if (bad) fail++
    console.log(`  段${i}: 上段末拍「${cams[i - 1]}」→ 本段 ${rows[i].size} ${pulled ? (bad ? '❌ 违规（拉远后不能接中远景/中景）' : '✅') : '（不适用）'}`)
  }
  // 反向：上段推进 → 本段可以回中远景/中景，不该被拦
  const pushCase = plan(['特写', '中远景'], ['缓慢推近', '固定机位'])
  const pushOk = pushCase[1].lv <= 1
  console.log(`  推进后回中远景: ${pushOk ? '✅ 允许（未被误拦）' : '❌ 被误拦'}`)
  if (!pushOk) fail++
}

if (fail) { console.log(`\n❌ ${fail} 处问题`); process.exit(1) }
console.log('\n✅ 全部通过')
