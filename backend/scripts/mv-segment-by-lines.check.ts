/**
 * 句界切段自检：跑 `npx tsx scripts/mv-segment-by-lines.check.ts`
 * 用的是《翻到那一页》真实对轴时间轴（29 句 / 150.7s），断言三件事：
 *   ① 段首尾相接、从第一句开始、到歌尾结束 ② 段长在 5.2~8s ③ 每段能说出自己唱的句子
 */
import { parseLrcLines, planSegmentsByLines, lyricsInWindow } from '../src/routes/mv'

const LRC = `[00:14.66]那句话我一直没写
[00:19.24]有一段雪落进那年的夜
[00:25.89]翻到那一页 你的笑还那么烈
[00:29.68]翻到那一页 风还那么野
[00:32.96]合上这一页 把往事都忘却
[00:37.68]午后的光照在相册每一页
[00:43.78]我慢慢翻那些发黄的年月
[00:47.46]一叠旧照边角也已经开裂
[00:50.06]那张脸还是当年那样真切
[00:55.44]翻到那一页 你的笑还那么烈
[00:59.28]翻到那一页 风还那么野
[01:02.76]合上这一页 把往事都忘却
[01:10.36]照片里我们还站在那老街
[01:13.86]你侧过脸说话说得很直接
[01:17.60]我用力点头笑得很热烈
[01:20.18]那时候我以为永远不会分别
[01:25.58]翻到那一页 你的笑还那么烈
[01:29.26]翻到那一页 风还那么野
[01:32.82]合上这一页 把往事都忘却
[01:39.74]后来搬过几回它都陪我过夜
[01:43.24]听说你走得很远也走得很绝
[01:46.58]我不知道你是否还留着那页
[01:49.72]想到这儿心里有个结
[01:55.60]翻到那一页 你的笑还那么烈
[01:59.24]翻到那一页 风还那么野
[02:02.34]合上这一页 跟这一段作别
[02:08.70]翻到那一页 你的笑还那么烈
[02:12.56]翻到那一页 风还那么野
[02:16.14]合上这一页 把往事都忘却`
const TOTAL = 150.72

const lines = parseLrcLines(LRC, TOTAL)
console.assert(lines.length === 29, `句子数应为 29，实际 ${lines.length}`)
console.assert(Math.abs(lines[0].start - 14.66) < 0.01, '首句起点')
console.assert(Math.abs(lines[28].end - TOTAL) < 0.01, '末句结束 = 歌尾')

const segs = planSegmentsByLines(lines, TOTAL, 5.2, 7, 8)
console.assert(segs.length >= 17 && segs.length <= 24, `段数应 17~24（前奏 2 段 + 正歌约 19 段），实际 ${segs.length}`)
console.assert(segs[0].start === 0, `第一段必须从 0 秒开始（前奏也要有镜头），实际 ${segs[0].start}`)
console.assert(Math.abs(segs[segs.length - 1].end - TOTAL) < 0.01, '最后一段到歌尾')
for (let i = 0; i < segs.length - 1; i++) {
  console.assert(Math.abs(segs[i].end - segs[i + 1].start) < 1e-6, `第 ${i + 1}/${i + 2} 段没有首尾相接`)
}
for (const s of segs) {
  const d = s.end - s.start
  console.assert(d >= 5.15 && d <= 8.01, `段长越界 ${d.toFixed(2)}s`)
  // 前奏/间奏段本来就没有歌词（整段在第一句之前 = 纯伴奏），只要求「有歌词跨进来的段必须算出词」
  const touchesLyric = lines.some((l) => l.end > s.start + 0.15 && l.start < s.end - 0.15)
  if (touchesLyric) console.assert(s.lyric.length >= 1, `第 ${s.start}s 这段跨了歌词却没算出来`)
}
// 每句歌词的起点必须落在某段的时间窗里（不能丢词）。注意副歌句子文本重复，不能用文本去重来数。
const uncovered = lines.filter((l) => !segs.some((s) => l.start >= s.start - 1e-6 && l.start < s.end - 1e-6))
console.assert(uncovered.length === 0, `有 ${uncovered.length} 句没被任何段覆盖：${uncovered.map((l) => l.text).join(' / ')}`)

// 窗口查询：一句跨两段时两边都能拿到
const mid = lyricsInWindow(lines, 24.0, 30.0)
console.assert(mid.length >= 2, '跨窗口应取到多句')

console.log(`✅ 句界切段自检通过：${segs.length} 段，平均 ${(segs.reduce((a, s) => a + s.end - s.start, 0) / segs.length).toFixed(2)}s`)
console.log(segs.slice(0, 4).map((s) => `${s.start}-${s.end}s：${s.lyric.join(' / ')}`).join('\n'))
