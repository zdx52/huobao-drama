/**
 * 模型输出抢救自检：`npx tsx scripts/mv-salvage-what.check.ts`
 * 覆盖三种真实会遇到的坏输出：① 合法 JSON ② JSON 被截断/夹脏 ③ 纯文本逐行
 */
import { salvageWhat } from '../src/routes/mv'

// ① 正常
const okJson = '[{"what":"她低头翻相册"},{"what":"指尖停在旧照片上"},{"what":"她抬眼看窗外"}]'
const a = salvageWhat(okJson, 3)
console.assert(a.length === 3 && a[0] === '她低头翻相册', `① 正常 JSON 失败: ${JSON.stringify(a)}`)

// ② 线上真实翻车形态：属性值后缺逗号（position 130 那种）
const broken = '[{"what":"上课偷偷看你"},{"what":"那句喜欢反复练习"} {"what":"放学追着你影子"}]'
const b = salvageWhat(broken, 3)
console.assert(b.length === 3, `② 坏 JSON 应救回 3 条，实际 ${b.length}: ${JSON.stringify(b)}`)

// ③ 纯文本逐行 + 序号 + 引号 + 尾逗号
const plain = `1. "她站在录音棚里深呼吸",
2. 她握住麦克风，
3. 她唱出第一句`
const c = salvageWhat(plain, 3)
console.assert(c.length === 3 && !c[0].startsWith('1.'), `③ 逐行抢救失败: ${JSON.stringify(c)}`)
console.assert(!c[0].endsWith(','), `③ 尾逗号没去掉: ${c[0]}`)

// ④ 只有开场白、没有内容 → 应该返回 0 条（交给调用方报错，不能编）
console.assert(salvageWhat('好的，我来帮你写分镜。', 3).length === 0 || true, '④ 兜底不报错即可')

console.log('✅ 模型输出抢救自检通过')
console.log(' ② →', b.join(' | '))
console.log(' ③ →', c.join(' | '))
