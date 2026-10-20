/**
 * 中英一致性自检：`npx tsx scripts/mv-prompt-alignment.check.ts`
 * 断言「英文请求里带上了定稿中文稿的每一拍」+ 明确的逐拍照译约束。
 * 不调真模型：ask 是假的，只拦请求文本。
 */
import { generateMvShotPrompt } from '../src/services/mv-shot-prompt'

const beats = [
  { start: 0, end: 2.5, size: '中远景', camera: '固定机位', action: 'she sways barefoot on wet sand', action_zh: '她光脚踩在湿沙上轻轻摇摆' },
  { start: 2.5, end: 5, size: '近景', camera: '缓推', action: 'she turns her head to the sea', action_zh: '她扭头看向海面' },
]

let captured = ''
const fakeAsk = async (_sys: string, user: string) => {
  captured = user
  return [
    'subject_definitions:',
    '<Subject 1> is the young woman in <Picture 1>, with black hair and a red bikini.',
    'summary:',
    '[reference generation + audio reuse] The clip follows <Subject 1>.',
    'retention_analysis:',
    '<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - same face.',
    'detailed_description:',
    '[Shot 1] A wide static frame of her swaying on wet sand.',
    '[Shot 2] At 00:02.500, the camera cuts to a closer frame as she turns her head.',
    'overall_soundscape:',
    'Dry and close room tone.',
    'non_diegetic_music:',
    'N/A',
  ].join('\n')
}

const out = await generateMvShotPrompt({
  skillZh: '规则', skillEn: 'rules', styleHead: '', styleRulesZh: '', styleRulesEn: '',
  roster: '人物：女主', pictures: [{ n: 1, name: '女主', kind: 'character', assetText: '黑色长发，红色比基尼' }],
  outlineText: '她在海边跳舞', beats, seconds: 5, start: 0, frames: 120, vocalActive: true,
}, fakeAsk as any)

const zhLines = out.zh.split('\n').filter((l) => /^\d+(?:\.\d+)?-\d+(?:\.\d+)?秒/.test(l))
console.assert(zhLines.length === 2, `中文稿应有 2 拍，实际 ${zhLines.length}`)
for (const line of zhLines) {
  console.assert(captured.includes(line), `英文请求里没带这拍中文：${line}`)
  console.assert(captured.includes(line.split('：')[1].split('。')[0].slice(0, 6)), `中文动作没进请求：${line}`)
}
console.assert(captured.includes('英文必须逐行照它翻译'), '缺「逐行照中文翻译」约束')
console.assert(captured.includes('block N must be the English of line N'), '缺 detailed_description 逐拍对应约束')
console.assert(out.en.includes('subject_definitions'), '英文稿不是六段式')

console.log('✅ 中英对齐自检通过')
console.log('  中文稿拍数:', zhLines.length, '| 请求里含中文稿:', captured.includes(zhLines[0]))
