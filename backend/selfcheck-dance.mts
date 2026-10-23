import { planDanceSegments, compileDancePrompt } from './src/routes/mv.ts'

/** 不变量：段网格合法、段间连续、覆盖帧数 ≤ 总数且零头 < 124 */
function verify(total: number, label: string) {
  const segs = planDanceSegments(total)
  const sum = segs.reduce((a, s) => a + s.frames, 0)
  const dropped = total - sum
  const bad = segs.filter((s) => s.frames < 124 || s.frames > 345 || (s.frames - 5) % 17 !== 0)
  const gap = segs.find((s, i) => i > 0 && s.startFrame !== segs[i - 1].startFrame + segs[i - 1].frames)
  if (bad.length) throw new Error(`${label}: 段不在网格/超范围 ${JSON.stringify(bad)}`)
  if (gap) throw new Error(`${label}: 段起点断档 ${JSON.stringify(gap)}`)
  if (dropped < 0 || dropped >= 124) throw new Error(`${label}: 丢弃帧数异常 ${dropped}`)
  console.log(`${label}: ${total} 帧 → ${segs.length} 段 [${segs.map((s) => s.frames).join(', ')}]，丢尾 ${dropped} 帧`)
}

;[[124, '最短片 5.17s'], [250, '10.4s'], [345, '14.4s'], [400, '16.7s'], [1000, '41.7s'], [4000, '2m47s'], [7200, '5min']]
  .forEach(([n, l]) => verify(n as number, l as string))

const p = compileDancePrompt({
  characterPrompt: 'a young woman in a navy workwear shirt',
  scenePrompt: 'a riverside promenade with a pale blue running track',
  style: 'photoreal', frames: 124, shotNo: 2, totalShots: 5,
})
for (const sec of ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']) {
  if (!p.includes(sec)) throw new Error('缺段: ' + sec)
}
for (const tok of ['<Subject 1>', '<Video 1>', '<Audio 1>', '[video editing + reference generation + audio reuse]', 'fully_preserved', 'fully_copy', '[Shot 1]', 'segment 2 of 5']) {
  if (!p.includes(tok)) throw new Error('缺标记: ' + tok)
}
// 官方口径：detailed_description 350~500 词（其余段不计入这个配额）
const dd = p.split('detailed_description:')[1].split('overall_soundscape:')[0]
const words = dd.replace(/\n/g, ' ').split(/\s+/).filter(Boolean).length
if (words < 350 || words > 500) throw new Error('detailed_description 词数超口径: ' + words)
const total = p.replace(/\n/g, ' ').split(/\s+/).filter(Boolean).length
console.log('提示词: detailed_description ' + words + ' 词（口径 350-500），全文 ' + total + ' 词，六段齐全、标记齐全')
