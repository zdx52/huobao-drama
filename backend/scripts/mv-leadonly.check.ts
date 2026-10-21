/**
 * MV 单主唱自检：`npx tsx scripts/mv-leadonly.check.ts`
 * 断言唱段只点名 <Subject 1> 对嘴、其他人闭嘴；非唱段谁都不许对嘴。
 */
import { generateMvShotPrompt } from '../src/services/mv-shot-prompt'

const beats = [
  { start: 0, end: 3, size: '近景', camera: '固定机位', action: 'she sings into the mic', action_zh: '她对着麦唱' },
  { start: 3, end: 6, size: '中景', camera: '缓推', action: 'a friend watches from the side', action_zh: '朋友在旁边看着' },
]
const fakeAsk = async () => [
  'subject_definitions:',
  '<Subject 1> is the young woman in <Picture 1>, with black hair and a red dress.',
  '<Subject 2> is the friend in <Picture 2>, with short hair and a grey jacket.',
  'summary:',
  '[reference generation + audio reuse] The clip follows <Subject 1>.',
  'retention_analysis:',
  '<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - same face.',
  'detailed_description:',
  '[Shot 1] A close static frame of her singing.',
  '[Shot 2] At 00:03.000, the camera cuts to a medium frame as the friend watches.',
  'overall_soundscape:',
  'Dry and close room tone.',
  'non_diegetic_music:',
  'N/A',
].join('\n')

const base: any = {
  skillZh: '规则', skillEn: 'rules', styleHead: '', styleRulesZh: '', styleRulesEn: '',
  roster: '出场人物：@女主、@朋友；场景：@排练室', pictures: [
    { n: 1, name: '女主', kind: 'character', assetText: '黑色长发，红裙' },
    { n: 2, name: '朋友', kind: 'character', assetText: '短发，灰外套' },
  ],
  outlineText: '她在排练室唱歌，朋友在旁边看', beats, seconds: 6, start: 0, frames: 144,
}

const vocal = await generateMvShotPrompt({ ...base, vocalActive: true }, fakeAsk as any)
console.assert(/lead singer/i.test(vocal.en), '唱段缺 "lead singer" 句')
console.assert(/only <Subject 1>'s lips articulate/.test(vocal.en), '唱段没点名只有 Subject 1 对嘴')
console.assert(/Every other person in frame keeps the mouth closed/i.test(vocal.en), '唱段缺「其他人闭嘴」')
console.assert(!/all sing|everyone sings|duet/i.test(vocal.en), '唱段出现了多人同唱')

const nonVocal = await generateMvShotPrompt({ ...base, vocalActive: false }, fakeAsk as any)
console.assert(/Nobody sings in this clip/i.test(nonVocal.en), '非唱段缺「谁都不唱」')

console.log('✅ 单主唱自检通过')
console.log('  唱段对嘴句:', (vocal.en.match(/only <Subject 1>'s lips articulate[\s\S]{0,60}/) || [''])[0])
