import { outlineForWindow } from '../src/routes/mv.js'

// 真实数据（分镜 16，2026-10-21）：用户改段时复制出新段、旧段没删，下一段起点还压在窗内
const outline = [
  { start: 88.78, end: 96.78, what: '她回头冲门卫亭方向挥了挥手' },
  { start: 96.78, end: 104.46, what: '她靠在电梯厢壁上，手机屏幕亮着一列未读红点' },   // 旧段（用户以为已改）
  { start: 98.75, end: 104.625, what: '手机屏幕亮着一列未读红点，她盯着数字发呆' },    // 新段（用户真正改的）
  { start: 104.46, end: 110.92, what: '电梯门开，走廊尽头一扇门缝漏出细光' },          // 下一段，起点压在窗内
]
const got = outlineForWindow(outline, 98.75, 104.625).map((o) => o.what).join(' | ')
console.assert(!/靠在电梯厢壁上/.test(got), `旧段没被去掉：${got}`)
console.assert(!/电梯门开/.test(got), `下一段混进来了：${got}`)
console.assert(/盯着数字发呆/.test(got), `新段丢了：${got}`)
// 正常情况：一镜一段，不许误删
const normal = [{ start: 0, end: 7, what: 'A' }, { start: 7, end: 14, what: 'B' }]
console.assert(outlineForWindow(normal, 0, 7).length === 1 && outlineForWindow(normal, 7, 14)[0].what === 'B', '正常分镜被误删')
console.log('✅ 初步分镜重复段去重 自检通过')
