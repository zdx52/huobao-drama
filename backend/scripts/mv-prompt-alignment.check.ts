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

// ── 补充说明 = 导演修正意见（不是追加一句） ──
let enReq = ''
const fakeAsk2 = async (_s: string, user: string) => { enReq = user; return fakeAsk(_s, user) }
const withFix = await generateMvShotPrompt({ ...({
  skillZh: '规则', skillEn: 'rules', styleHead: '', styleRulesZh: '', styleRulesEn: '',
  roster: '人物：女主', pictures: [{ n: 1, name: '女主', kind: 'character', assetText: '黑色长发，红色比基尼' }],
  outlineText: '她在海边跳舞', beats, seconds: 5, start: 0, frames: 120, vocalActive: true,
} as any), extra: '第二拍不要扭头看海，改成低头整理裙摆' }, fakeAsk2 as any)

console.assert(withFix.zh.includes('【本段修正意见'), '中文稿没有独立的修正意见块')
console.assert(!/补充：/.test(withFix.zh), '中文稿还在用「补充：」追加')
console.assert(enReq.includes('导演修正意见'), '英文请求里没把补充说明当修正意见')
console.assert(enReq.includes('低头整理裙摆'), '修正原文没进英文请求')
console.assert(enReq.includes("DIRECTOR'S CORRECTIONS"), '英文请求缺「修正覆盖正文、不追加」硬规则')
console.log('✅ 补充说明=修正意见 自检通过')

// ── 景别中英必须一致（模型爱把「近景」写成 close-up） ──
{
  const drift = `subject_definitions:\n<Subject 1> is her, face close-up panel.\n` +
    `summary:\n[reference generation + audio reuse] She tucks hair.\n` +
    `retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - same hoodie.\n` +
    `detailed_description:\n[Shot 1] The camera holds a close-up framing on <Subject 1> and pushes in. She tucks hair.\n` +
    `overall_soundscape:\nhum.\n` +
    `non_diegetic_music:\nN/A\n`
  const fake = async () => drift
  const out = await generateMvShotPrompt({ ...({
    skillZh: '规则', skillEn: 'rules', styleHead: '', styleRulesZh: '', styleRulesEn: '',
    roster: '人物：女主', pictures: [], outlineText: '', seconds: 5, start: 0, frames: 120, vocalActive: false,
    beats: [{ start: 0, end: 5, size: '近景', camera: '缓慢推近', action_zh: '她别发丝', action: 'she tucks hair' }],
  } as any) }, fake as any)
  console.assert(/medium close-up/.test(out.en), `英文景别没对齐中文「近景」：${out.en.slice(0, 200)}`)
  console.assert(/medium close-up framing/.test(out.en), `英文首句没换成 medium close-up：${out.en.match(/\[Shot 1\][^.]*/)?.[0]}`)
  console.log('✅ 景别中英对齐 自检通过')
}

// ── 中间断句必须被发现（契约句自带句号，不能拿它当"结尾完整"） ──
{
  let calls = 0
  const truncated = `subject_definitions:\n<Subject 1> is her.\n` +
    `summary:\n[reference generation + audio reuse] She leans.\n` +
    `retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - same hoodie.\n` +
    `detailed_description:\n[Shot 1] The camera pulls back to reveal the chair backrest, the windows\n` +
    `overall_soundscape:\nhum.\nnon_diegetic_music:\nN/A\n`
  const ask2 = async (_s: string, _u: string) => { calls++; return truncated }
  await generateMvShotPrompt({ ...({
    skillZh: '规则', skillEn: 'rules', styleHead: '', styleRulesZh: '', styleRulesEn: '',
    roster: '人物：女主', pictures: [], outlineText: '', seconds: 5, start: 0, frames: 120, vocalActive: true,
    beats: [{ start: 0, end: 5, size: '近景', camera: '缓慢拉远', action_zh: '她趴在椅背上', action: 'she leans' }],
  } as any) }, ask2 as any).catch(() => {})
  console.assert(calls >= 2, `中间断句没触发补句（调用 ${calls} 次）`)

  // 对照：结尾完整时只该 1 次调用（不许白花一次）
  let ok1 = 0
  const whole = truncated.replace('the windows\n', 'the windows beyond the glass.\n')
  const ask3 = async () => { ok1++; return whole }
  await generateMvShotPrompt({ ...({
    skillZh: '规则', skillEn: 'rules', styleHead: '', styleRulesZh: '', styleRulesEn: '',
    roster: '人物：女主', pictures: [], outlineText: '', seconds: 5, start: 0, frames: 120, vocalActive: true,
    beats: [{ start: 0, end: 5, size: '近景', camera: '缓慢拉远', action_zh: '她趴在椅背上', action: 'she leans' }],
  } as any) }, ask3 as any).catch(() => {})
  console.assert(ok1 === 1, `完整稿不该补句（调用 ${ok1} 次）`)
  console.log('✅ 中间断句检测 自检通过')
}
