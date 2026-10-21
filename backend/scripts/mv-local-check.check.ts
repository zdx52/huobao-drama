/**
 * 本地体检自检：`npx tsx scripts/mv-local-check.check.ts`
 * 用真实出问题的稿子（audio 行混进 detailed_description、retention 缺 appears in）断言能被抓到；
 * 再用一组合规稿断言不误报。
 */
import { localPromptProblems, propNameKeys } from '../src/routes/mv'

const bad = `subject_definitions:
<Subject 1> is the young woman in <Picture 1>, with black hair.
<Audio 1> is the supplied song excerpt for this entire clip and is reused as the synchronized vocal track for <Subject 1> (S1).
summary:
[reference generation + audio reuse] A woman stands under a streetlight. The clip follows <Subject 1>.
retention_analysis:
<Subject 1> fully_preserved — the woman in the grey hoodie.
<Audio 1>: fully_copy - the supplied song excerpt is reused 1:1 across the clip.
detailed_description:
Style sentence here.
<Subject 1> is the supplied song excerpt for this entire clip and is reused as the synchronized vocal track for <Subject 1> (S1).
[Shot 1] A medium-wide frame of her standing still.
Nobody sings in this clip: every mouth stays closed and no one mouths the words, <Audio 1> plays as the soundtrack.
overall_soundscape:
Room tone.
non_diegetic_music:
N/A`

const p1 = localPromptProblems({ promptEn: bad, vocalState: 'non_vocal' })
console.assert(p1.some((x) => x.includes('detailed_description')), `没抓到 audio 行错位：${JSON.stringify(p1)}`)
console.assert(p1.some((x) => x.includes('appears in')), `没抓到 retention 格式：${JSON.stringify(p1)}`)

const good = `subject_definitions:
<Subject 1> is the young woman in <Picture 1>, with black hair.
<Audio 1> is the supplied song excerpt for this entire clip and is reused as the synchronized vocal track for <Subject 1> (S1).
summary:
[reference generation + audio reuse] A woman stands under a streetlight. The clip follows <Subject 1>.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the woman in the grey hoodie.
<Audio 1>: fully_copy - the supplied song excerpt is reused 1:1 across the clip.
detailed_description:
Style sentence here.
[Shot 1] A medium-wide frame of her standing still.
Nobody sings in this clip: every mouth stays closed and no one mouths the words, <Audio 1> plays as the soundtrack.
overall_soundscape:
Room tone.
non_diegetic_music:
N/A`
console.assert(localPromptProblems({ promptEn: good, vocalState: 'non_vocal' }).length === 0, `合规稿被误报：${JSON.stringify(localPromptProblems({ promptEn: good, vocalState: 'non_vocal' }))}`)

// 唱段缺单主唱句
const vocalMiss = good.replace('Nobody sings in this clip: every mouth stays closed and no one mouths the words, <Audio 1> plays as the soundtrack.', 'She sings along.')
const p2 = localPromptProblems({ promptEn: vocalMiss, vocalState: 'vocal_active' })
console.assert(p2.some((x) => x.includes('lead singer')), `唱段缺 lead singer 没抓到：${JSON.stringify(p2)}`)

// 道具名匹配（歌词写简称也能命中）
console.assert(propNameKeys('外卖保温袋').some((k) => '我拎着外卖走在街上'.includes(k)), '道具简称没命中')

console.log('✅ 本地体检自检通过')
console.log('  坏稿问题:', p1.join(' / '))
