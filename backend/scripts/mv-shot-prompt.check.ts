/**
 * mv-shot-prompt 干跑自检（不发网络请求）：用桩 ask 跑完整流水线。
 * 2026-10-19 改版后流水线**有界**：正常 2 次调用，最坏 4 次（各自重试 1 + 断尾修 1）。
 * 验：中文拍数、英文六段、契约机械补齐、retention 行头方括号、断尾修复、唱段三词、不写 <d>、调用次数上限。
 * 跑法：cd backend && npx tsx scripts/mv-shot-prompt.check.ts
 */
import { generateMvShotPrompt, MV_SEGS } from '../src/services/mv-shot-prompt.js'

const ZH = `出场人物：@女主；场景：@录音隔间内部·棚拍。
0-3.5秒：@录音隔间内部·棚拍，中远景固定机位，@女主 站在麦克风前低头、视线落向地面，胸廓缓慢起伏一次；本段无任何人声，只有隔间底噪。
3.5-6.583秒：切到近景，@女主 眼神仍低垂、下巴微收，呼气让肩膀下沉；本段无任何人声，只有底噪。`

const GOOD = `subject_definitions:
<Subject 1> is the young woman in <Picture 1>, with long straight black hair, an off-white crew-neck knit sweater, slim black trousers and white canvas shoes; complete head and face taken from the FACE CLOSE-UP PANEL of the four-panel sheet.
<Subject 2> is the scene in <Picture 2>, with dark grey acoustic foam walls and a silver microphone stand.
<Audio 1> is the supplied song excerpt for this entire clip and is reused as the synchronized vocal track for <Subject 1> (S1).
summary:
[reference generation + audio reuse] <Subject 1> breathes in <Subject 2> before the microphone.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - black hair, off-white knit, black trousers, white shoes.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - foam walls and mic stand.
<Audio 1>: fully_copy - the supplied song excerpt is reused 1:1 across the clip.
detailed_description:
photorealistic live-action film still, 35mm grain, muted grading.
[Shot 1] A medium-long shot frames <Subject 1> before the microphone. <Subject 1> (S1) breathes slowly, lips closed.
[Shot 2] At 00:03.500, the camera cuts to a close shot as <Subject 1> settles her shoulders.
overall_soundscape:
Booth room tone and a faint electrical hum, with one soft cloth rustle.
non_diegetic_music:
N/A`

const inp = {
  skillZh: '（MV 中文规范占位）', skillEn: '（MV English spec placeholder）',
  styleHead: 'photorealistic live-action film still', styleRulesZh: '', styleRulesEn: '',
  roster: '出场人物：@女主；场景：@录音隔间内部·棚拍',
  pictures: [
    { n: 1, name: '女主', kind: 'character', assetText: '黑色长直发；灰白色宽松圆领针织衫；黑色直筒长裤；白色帆布鞋' },
    { n: 2, name: '录音隔间内部·棚拍', kind: 'scene', assetText: '哑光暖灰吸音棉墙、镀铬麦克风支架' },
  ],
  outlineText: '[0-12s] 录音隔间内，女主站在麦克风前缓慢深呼吸。',
  beats: [
    { start: 0, end: 3.5, size: '中远景', camera: '固定机位', action: 'she breathes quietly', action_zh: '她安静呼吸' },
    { start: 3.5, end: 6.583, size: '近景', camera: '固定机位', action: 'her shoulders settle', action_zh: '肩膀下沉' },
  ],
  seconds: 6.583, start: 0, frames: 158, vocalActive: false, lyric: '',
  shotNumber: 1, aspectRatio: '16:9',
}

// ── A：合规稿 → 2 次调用，零额外重写 ──
{
  let n = 0
  const ask = async (_s: string, user: string) => {
    if (++n > 10) throw new Error('A 场景调用爆炸')
    return /中文工作版/.test(user) ? ZH : GOOD
  }
  const out = await generateMvShotPrompt(inp as any, ask)
  const en = out.en
  console.log('A：调用', n, '次 | 长度', en.length, '| 词数', en.split(/\s+/).length)
  const checks: [string, boolean][] = [
    ['六段齐', MV_SEGS.every((s) => en.includes(`${s}:`))],
    ['<Audio 1>', en.includes('<Audio 1>')],
    ['(S1)', /\(S1\)/.test(en)],
    ['fully_copy', en.includes('fully_copy')],
    ['前缀', en.includes('[reference generation + audio reuse]')],
    ['行头方括号', /<Subject 1> \(appears in \[Shot 1\], \[Shot 2\]\): fully_preserved - /.test(en)],
    ['第二拍切镜动词', /\[Shot 2\] At 00:03\.500, the camera cuts to/.test(en)],
    ['无 <d>', !/<d>/.test(en)],
    ['无空行', !/\n\n/.test(en)],
  ]
  for (const [k, v] of checks) { console.log('   ', v ? '✓' : '✗', k); if (!v) throw new Error('A 失败：' + k) }
  if (n > 1) throw new Error('A：合规稿应只调用 1 次（英文稿），实际 ' + n + ' 次')
}

// ── B：模型漏契约（无 <Audio 1> / 无 fully_copy / 前缀不全）→ 机械补齐，不额外调模型 ──
{
  let n = 0
  const bad = GOOD
    .replace(/<Audio 1>[^\n]*\n/, '')
    .replace(/<Audio 1>: fully_copy[^\n]*\n/, '')
    .replace('[reference generation + audio reuse]', '[reference generation]')
  const ask = async (_s: string, user: string) => {
    if (++n > 10) throw new Error('B 场景调用爆炸')
    return /中文工作版/.test(user) ? ZH : bad
  }
  const out = await generateMvShotPrompt(inp as any, ask)
  const en = out.en
  console.log('B：调用', n, '次')
  const ok = en.includes('<Audio 1>') && en.includes('fully_copy') && en.includes('[reference generation + audio reuse]')
  console.log('   ', ok ? '✓' : '✗', '契约已机械补齐')
  if (!ok) throw new Error('B：契约没补齐')
  if (n > 1) throw new Error('B：机械补齐不该调模型，实际 ' + n + ' 次')
}

// ── C：正文断尾 → 只补一句（+1 次），仍 ≤4 次 ──
{
  let n = 0
  const truncated = GOOD.replace('as <Subject 1> settles her shoulders.', 'as <Subject 1> settles her shoulders and her gaze drifts gently')
  const fixed = GOOD.replace('as <Subject 1> settles her shoulders.', 'as <Subject 1> settles her shoulders and her gaze drifts gently toward the floor.')
  const ask = async (_s: string, user: string) => {
    if (++n > 10) throw new Error('C 场景调用爆炸')
    if (/中文工作版/.test(user)) return ZH
    if (/ends in the middle of its final sentence/.test(user)) return fixed
    return truncated
  }
  const out = await generateMvShotPrompt(inp as any, ask)
  const tail = out.en.split('detailed_description:')[1].split('overall_soundscape:')[0].trim()
  console.log('C：调用', n, '次 | 结尾', JSON.stringify(tail.slice(-40)))
  if (!/[.!?]\s*$/.test(tail)) throw new Error('C：断尾没修好')
  if (n > 3) throw new Error('C：调用超上限（应 ≤3），实际 ' + n)
}

// ── D：有唱段 → 机械补嘴部三词，且不写 <d> ──
{
  let n = 0
  const ask = async (_s: string, user: string) => {
    if (++n > 10) throw new Error('D 场景调用爆炸')
    return /中文工作版/.test(user) ? ZH : GOOD
  }
  const out = await generateMvShotPrompt({ ...inp, vocalActive: true, lyric: '月光落在旧cd上' } as any, ask)
  const en = out.en
  const ok = /unobstructed/i.test(en) && /phoneme/i.test(en) && /mouth/i.test(en) && !/<d>/.test(en)
  console.log('D：调用', n, '次 |', ok ? '✓' : '✗', '唱段三词齐且无 <d>')
  if (!ok) throw new Error('D：唱段补齐失败')
}

// ── E：模型只写到 detailed_description 就停（缺 soundscape / music）→ 机械补默认值，不报错、不加调用 ──
{
  let n = 0
  const cut = GOOD.split('overall_soundscape:')[0].trimEnd()
  const ask = async (_s: string, user: string) => {
    if (++n > 10) throw new Error('E 场景调用爆炸')
    return /中文工作版/.test(user) ? ZH : cut
  }
  const out = await generateMvShotPrompt(inp as any, ask)
  const en = out.en
  const ok = en.includes('overall_soundscape:') && en.includes('non_diegetic_music:') && /<Audio 1>.*entire soundtrack/.test(en) && /non_diegetic_music:\s*\nN\/A/.test(en)
  console.log('E：调用', n, '次 |', ok ? '✓' : '✗', '缺的两段已机械补齐')
  if (!ok) throw new Error('E：缺段没补齐')
  if (n > 1) throw new Error('E：机械补段不该调模型，实际 ' + n + ' 次')
}

// ── F：出现禁词（"reads on screen from the first frame"）→ 机械洗成 in frame，不额外调模型 ──
{
  let n = 0
  const dirty = GOOD.replace('breathes slowly, lips closed.', 'breathes slowly, lips closed, and the <Audio 1> reads on screen from the first frame.')
  const ask = async (_s: string, user: string) => {
    if (++n > 10) throw new Error('F 场景调用爆炸')
    return /中文工作版/.test(user) ? ZH : dirty
  }
  const out = await generateMvShotPrompt(inp as any, ask)
  const bad = /\b(?:screen|screens|phone|tablet|mirror|reflection|poster|portrait|photo|crowd|ghost|clone|duplicate)\b/i.test(out.en)
  console.log('F：调用', n, '次 |', bad ? '✗' : '✓', '禁词已洗掉', bad ? '' : '（on screen → in frame）')
  if (bad) throw new Error('F：禁词还在')
  if (n > 1) throw new Error('F：机械洗禁词不该调模型，实际 ' + n + ' 次')
}

console.log('✅ 干跑通过')
