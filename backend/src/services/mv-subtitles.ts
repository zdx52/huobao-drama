/**
 * MV 成片字幕（ASS）
 *
 * 两部分：① 片头主创（曲名/作词/作曲）右下角，前 5 秒淡入淡出，避开人脸；② 歌词逐句底部淡入。
 * 时间基准：ASS 用成片自己的时间轴（第一段起点 = 0），所以歌词的绝对秒要减去拼接口的起点。
 */
export interface AssLine { start: number; end: number; text: string }

export interface AssOpts {
  width: number
  height: number
  totalSeconds: number
  credits?: { songTitle?: string | null; lyricist?: string | null; composer?: string | null }
  lyrics?: AssLine[]
  offset?: number   // 成片第 0 秒 = 歌曲第 offset 秒
  creditSeconds?: number
  creditFont?: string   // 主创那块用艺术字体（歌词仍用无衬线，符合字幕规范）
}

const FADE = 200          // 歌词淡入淡出（毫秒）
const CREDIT_FADE = 450   // 主创淡入淡出（毫秒）

function assTime(sec: number): string {
  const t = Math.max(0, sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

/** 单行里不允许出现换行/花括号，否则会打乱 ASS 语法 */
function clean(s: string): string {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '').trim()
}

export function buildAss(o: AssOpts): string | null {
  const W = Math.max(320, Math.round(o.width || 768))
  const H = Math.max(320, Math.round(o.height || 1344))
  // 字号按「画面高度百分比」定，不写死像素（同一份代码适配横竖屏）：
  // 竖屏短视频字幕行业口径是行高 7%~9% 画高（BBC 竖屏下限 4.5%，短视频通常取上限，手机上看才够大）。
  // 竖屏时同一行文字在观感上要小一档：BBC 规范把竖屏行高定为横向的 9/16。
  // 横屏 6.2% 画高（768 高 → 48px，行高约 7.4%，合 BBC 8% 口径）；竖屏乘 9/16 → 3.8%。
  const vertical = H > W
  const lyricSize = Math.max(16, Math.round(H * (vertical ? 0.038 : 0.062)))
  const outline = Math.max(1, Math.round(H * (vertical ? 0.0028 : 0.0045)))   // 描边同比
  const marginV = Math.round(H * 0.07)         // 底部留安全区（竖屏平台 UI 占下方 ~20%，字幕抬到 93% 左右）
  const creditSec = o.creditSeconds ?? 5

  const c = o.credits || {}
  const creditLines = [
    c.songTitle ? `曲名　${c.songTitle}` : '',
    c.lyricist ? `作词　${c.lyricist}` : '',
    c.composer ? `作曲　${c.composer}` : '',
  ].filter(Boolean)

  const off = Number(o.offset) || 0
  const end = o.totalSeconds || 0
  const lyrics = (o.lyrics || [])
    .map((l) => ({ ...l, start: Number(l.start) - off, end: Number(l.end) - off, text: clean(l.text) }))
    .filter((l) => l.text && l.start < end && l.end > 0)
    .map((l) => ({ ...l, start: Math.max(0, l.start), end: Math.min(end, l.end) }))
    .filter((l) => l.end > l.start + 0.15)     // 太短的句子不上屏，闪一下更难看

  if (!creditLines.length && !lyrics.length) return null

  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Lyric,PingFang SC,${lyricSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0.4,0,1,${outline},1,2,40,40,${marginV},1
Style: Credit,${o.creditFont || 'Kaiti SC'},${Math.max(16, Math.round(H * (vertical ? 0.034 : 0.06)))},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1.6,0,1,${Math.max(2, outline - 2)},1,3,0,${Math.round(W * 0.085)},${Math.round(H * 0.04)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const events: string[] = []
  if (creditLines.length) {
    // 主创三行做成一整块（\N 换行），右下角，前 creditSec 秒淡入淡出
    const body = creditLines.map((l) => clean(l)).join('\\N')
    events.push(`Dialogue: 0,${assTime(0.4)},${assTime(creditSec)},Credit,,0,0,0,,{\\fad(${CREDIT_FADE},${CREDIT_FADE})}${body}`)
  }
  for (let i = 0; i < lyrics.length; i++) {
    const l = lyrics[i]
    // 下一句来了就收，避免两句叠在一起
    const nextStart = i + 1 < lyrics.length ? lyrics[i + 1].start : l.end
    // 最多停 6 秒：句间空太久（间奏）不该让上一句一直挂着
    const e = Math.min(l.end + 0.4, nextStart > l.start ? nextStart : l.end + 0.4, l.start + 6)
    events.push(`Dialogue: 0,${assTime(l.start)},${assTime(e)},Lyric,,0,0,0,,{\\fad(${FADE},${FADE})}${l.text}`)
  }

  return `${head}\n${events.join('\n')}\n`
}

/** 把 LRC 文本解析成行（[mm:ss.xx]文本） */
export function parseLrc(lrc: string): AssLine[] {
  const out: AssLine[] = []
  for (const raw of String(lrc || '').split('\n')) {
    const m = raw.match(/\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\](.*)/)
    if (!m) continue
    const t = Number(m[1]) * 60 + Number(m[2])
    const text = clean(m[3])
    if (!text) continue
    out.push({ start: t, end: t, text })
  }
  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start
  if (out.length) out[out.length - 1].end = out[out.length - 1].start + 3   // 末句默认停 3 秒
  return out
}
