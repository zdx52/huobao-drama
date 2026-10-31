/**
 * dance 提示词模板自检（纯函数，无网络/无 DB 写入）。
 * 验：环境写成官方 <Subject N> is the environment in <Picture N>, featuring …、retention 有环境行、
 *     dd 地点指向 Subject、无 the scene reference 残留、舞步句、压测长度不越 H3 的 6980 上限。
 * 跑法：cd backend && npx tsx scripts/mv-dance-prompt.check.ts
 */
import { compileDancePrompt, danceActionText, findDanceNegations, danceSeamStart, danceMotionSeam, stripHeadActions, scrubDanceActionEn, scrubSceneEn, trimShapeDetail, trimMakeup } from '../src/routes/mv.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCENE = 'open-air plaza in front of a multi-story building; walls: candy-colored facade with decorative stripes; '
  + 'floor: open light-colored cement ground with line textures; fixtures: main cartoon building with arched entrance; '
  + 'light: even soft diffuse daylight without harsh shadows; palette: dominant candy colors like bright yellow and pink.'
const WHO = 'A cartoon anthropomorphic pig in a bright cherry-blossom-pink tone, with even saturated skin, rounded rose-pink blush circles on both cheeks, '
  + 'a slightly deeper coral-pink nose-tip, smooth texture-free skin, round full head, small upright ears, large black dot eyes, '
  + 'flat oval pig snout with two black nostrils, an upturned mouth line, no hair on the head, a short stout body, short thick limbs, '
  + 'three-fingered plump round hands and oval hoof-shaped feet, three-heads-tall chibi proportions.'

const run = (scenePic?: number, action?: string) => compileDancePrompt({
  characterPrompt: WHO, outfit: 'Plain white short-sleeved cotton T-shirt; plain black A-line short skirt; pink hoof-shaped bare feet.',
  scenePrompt: SCENE, style: '3d', styleHead: 'High-quality 3D CG animation still, modern game-engine cinematic render',
  frames: 175, shotNo: 1, totalShots: 2, scenePic, action,
})

const ACT = 'she puts both hands on her hips and sways her waist twice, then spins to the right for two full turns'
const out = run(2)
const withAct = run(2, ACT)
// outline 采样：两段窗口各取各的动作，不串段
const outlineProject = { outline: JSON.stringify([{ start: 0, end: 7.31, what: '双手叉腰扭腰' }, { start: 7.31, end: 14.63, what: '转身连续旋转' }]) }
const seg2Shot = { startSeconds: 7.29, endSeconds: 14.58 }
const unknownProject = { outline: 'not json' }

const fails: [string, boolean][] = [
  // 官方 MiniMax-H3 ref-en.txt §2.2/§7：只用来说明场景的图不要单独建 <Picture N> 条目，
  // 场景本身要写成 <Subject N> is the environment in <Picture N>, featuring ...（照官方例子的咖啡店环境）
  ['环境定义成 <Subject 2>（官方写法）', out.includes('<Subject 2> is the environment in <Picture 2>, featuring open-air plaza')],
  ['场景六要素进了定义', out.includes('candy-colored facade with decorative stripes')],
  ['环境有 retention 行（官方 §4.1 每个 label 一行）', out.includes('<Subject 2> (appears in [Shot 1]): fully_preserved')],
  ['dd 里地点指向 <Subject 2>', out.includes('The location of the take is <Subject 2>.')],
  ['不残留非官方写法 the scene reference', !out.includes('the scene reference')],
  ['场景列表只出现一次', out.split('candy-colored facade with decorative stripes').length === 2],
  ['retention 里动作不归 <Video 1>', out.includes('motion as described below')],
  // 2026-10-28 瘦身验收：Subject 1 不许再把妆造/形状级细描整串抄进来，且整段留足余量
  // 2026-10-28：翻译分句不稳定（形状+颜色可能挤进同一句），所以按短语判 —— 下面这两条锁住这个行为
  ['trimShape 在「形状+颜色同句」里只删形状短语', (() => {
    const s = trimShapeDetail('Soft oval face shape, moderate-width double eyelids, deep-brown almost black irises, small round nose tip. Fair skin with a cool white tone.')
    return !/oval|eyelids|nose tip/i.test(s) && /deep-brown/.test(s) && /cool white tone/.test(s) && /\./.test(s)
  })()],
  ['trimShape 不把两句粘成一句（句末标点保留）', (() => {
    const s = trimShapeDetail('Relaxed posture. deep-brown almost black irises. Fair skin.')
    return /posture\.\s/.test(s) && /irises\.\s|irises\.$/.test(s)
  })()],
  ['trimMakeup 能剔 Fingernails 句（旧正则漏）', (() => {
    const s = trimMakeup('Fingernails are trimmed short and rounded. Top: grey knit sweater.')
    return !/fingernails/i.test(s) && /Top: grey knit sweater/.test(s)
  })()],
  ['Subject 1 不含妆造段（Makeup/Nails/Jewelry）', !/\b(make-?up|eyeliner|nail polish|earrings|necklace|bracelet|jewell?ery)\b/i.test((out.split('<Subject 1>')[1] || '').split('<Subject 2>')[0])],
  ['Subject 1 不含形状级细描（额头/双眼皮/鼻梁/唇形）', !/\b(forehead|double-eyelid|nose bridge|upper lip|lower lip)\b/i.test((out.split('<Subject 1>')[1] || '').split('<Subject 2>')[0])],
  ['颜色锚点保留（瞳色/发色/肤色不许删）', /skin/i.test(out) && /hair/i.test(out)],
  ['整段留足余量（<= 6400，避免压缩循环砍人物）', out.length <= 6400],
  // 官方 §2.3：`<Video N>` 只承担结构源（运镜/剪辑/节奏/时间结构）；动作归 `<Subject N>`。
  // 注意 `whose dance motion … comes from <Video 1>` 是官方 §2.1 的双源句式，**允许**出现，
  // 所以要查的是「<Video N> 自己的定义行里有没有动作词」，不是简单禁 `come from <Video 1>`。
  ['动作不挂 <Video 1>（官方：<Video N> 定义只写结构源）', (() => {
    const vline = out.split('\n').find((l) => l.startsWith('<Video 1>')) || ''
    return !/choreography|dance motion|body movement|expression/i.test(vline)
  })()],
  ['调色句指向环境 Subject', out.includes('saturation of <Subject 2>')],
  ['风格句指向环境 Subject', out.includes('same lighting as <Subject 2>')],
  ['上限内（<=6980）', out.length <= 6980],
  ['没有独立的 <Picture 2> 构图锚点条目', !out.includes('<Picture 2> is the')],
  ['summary 标了 video editing', out.includes('[video editing')],
  ['不传 action 时不出现舞步句', !out.includes('the sequence of moves')],
  // 2026-10-28 用户拍板 A：per-段动作句下线（动作只由 <Video 1> 给），模板里不许再出现这句
  ['per-段动作句已下线（动作只由 <Video 1> 给）', !withAct.includes('the sequence of moves')],
  ['固定动作锁仍在（不靠 per-段动作句）', withAct.includes('her feet land on the beat and keep their spots') && withAct.includes('matches <Video 1> frame by frame')],
  // 🔴 2026-10-26 实测：加「官方 keep 清单」（Everything the instructions above leave unnamed
  //    stays exactly as <Video 1> has it: the shot size, the subject's size and position…）之后，
  //    段1 开头又出大脸（4.0.364 无此句 = 段1 干净）。这句把「人物在画框里的尺寸和位置」交给
  //    <Video 1>，模型反过来去源片里找景别、把开场画成特写 ⇒ 已撤，别再往提示词里加 keep 清单。
  //    官方那条 Editing keeps whatever you do not mention 的结论在纯「编辑」轻提示词下成立，
  //    套进六段式 Ref2VA 会反噬。
  ['不许再加 keep 清单（会诱发开场大脸）', !withAct.includes('Everything the instructions above leave unnamed')],
  // 🔴 2026-10-26 实测：把 719 字符的肢体清单压成两句 + 砍掉 LLM 动作句后，段1 火焰纹和大脸全回来了
  //    ⇒ 这段逐项清单是有效约束，以后不许再当冗余删。
  ['逐项肢体清单在（脚/膝/胯/躯干/手臂/手腕/头/重心）', out.includes('her knees bend and straighten through the same amplitude') && out.includes('her hips travel the same path and distance') && out.includes('her weight shifts from one leg to the other on the same beats')],
  // 🔴 2026-10-26 反转：原来锁的是「Framing is locked: no close-up, no facial shot」和
  //    「no added pan, no tilt, no zoom and no push in」两句否定句。H3 是 BasicGuider + cfg=1、
  //    没有负向分支，否定句不扣分，只是把 close-up / facial shot / pan / tilt / zoom / push in
  //    这些词喂进正向描述（官方 base-en/ref-en 示例提示词里零否定句）。改正向写法：
  //    机位不动 = 官方原句 `The camera holds a static shot`；景别 = 全片全身 + 画面保持广。
  // 🔴 2026-10-28 通用化：景别/机位不再写死「全身 + 静态」（换半身源片、运镜源片就矛盾），
  //    改为「取景/角度/距离与 <Video 1> 逐帧一致」——防特写靠的是「距离不跟源片比不变」，不靠写死全身。
  ['景别锁死：取景/角度/距离跟源片一致（不写死全身）', out.includes('The shot frames <Subject 1> with the same framing, angle and distance as <Video 1>') && !/full body from head to feet/i.test(out)],
  // 🔴 2026-10-28 按官方原文对齐（skills/h3-prompt-writing → references/ref-en.txt）
  ['官方 §2.1/§2.3：动作归属写在 <Subject 1> 定义里（<Video N> 只承担结构源）',
    out.includes('whose dance motion, body movement and positions in the frame come from <Video 1>')],
  ['官方 §5.2：dd 正文以 [Shot 1] 起头且 dd 内只出现一次', (() => {
    const dd = out.split('detailed_description:')[1] || ''
    return dd.split('[Shot 1]').length === 2 && dd.includes('[Shot 1] The shot frames <Subject 1>')
  })()],
  ['官方 §5.2：风格句在 [Shot 1] 之前（不是塞进正文）',
    out.indexOf('<Subject 2> is the environment') < out.indexOf('[Shot 1]')],
  ['运镜锁死：机位高度/距离/背景布局跟源片一致（不写死 static）', out.includes('The camera holds the same height, distance and background layout as <Video 1>') && !/holds a static shot/i.test(out)],
  // 兜底：整段提示词里不许出现「否定词 + 名词/运镜词」。命中就把原句打出来。
  ['提示词里零否定短语（H3 无负向分支，否定句=把词喂给模型）', (() => {
    const hits = findDanceNegations(withAct)
    if (hits.length) console.log('      命中:', hits.join(' | '))
    return hits.length === 0
  })()],
  ['参考板只管衣服（头来自身份卡）', out.includes('the reference board shows the outfit only')],
  ['提示词不点名 face（改用 expression）', !/her face/i.test(out)],
  ['服装句在（面料褶皱随之变化）', /fabric creas/i.test(withAct)],
  // 🔴 2026-10-27 段4 收尾「大脸背景 + 跳舞人物」的两条修法，缺一条就会复发：
  //    ① 幅度声明不能再说「满幅度」（和收尾动作 slowly/softly 自相矛盾，模型选「不跳了」然后自由发挥）
  //    ② 减速时必须显式锁机位距离，直到最后一帧
  ['幅度声明改为「随源片帧、不管大小全身在画面内」', withAct.includes('The amplitude of each move matches <Video 1> frame by frame')
    && withAct.includes('whatever its size the whole body stays inside the frame')],
  // C 句：一镜到底（实测段4 掉点区间帧间差 8.22 且两端有 61/67 硬切峰 ⇒ 模型自己切镜头；
  // 「减速锁机位」那句两轮实测都没挡住，换成这句正向声明。H3 无负向分支，不能写 no cut）
  // 🔴 2026-10-27 真凶：第 2220 行那句只改了一半 —— 前半句还写着 `dances continuously at full amplitude`，
  //    后半句写「幅度随源片」，一句话里自相矛盾。段4 末段是拍手/并脚/颔首/站定，模型在片尾最后 2 秒二选一，
  //    选了「换镜头」→ 人脸特写。这条断言必须保证全文一个 `full amplitude` 都不剩。
  ['全文零 "full amplitude"（段4 片尾特写的真凶）', !/full amplitude/i.test(withAct)],
  // 🔴 2026-10-27 用户要求：用正向提示词保证不写大脸。
  //    不再只说「一镜到底」，而是把「相机到身体距离恒定 + 人物在画面占比恒定」写死——
  //    特写的本质就是距离变小、占比变大，这两点正向钉住，模型推近就没依据。
  ['正向锁「机位距离恒定 + 人物占比恒定」',
    out.includes('The camera holds the same height, distance and background layout as <Video 1> for the whole take')
    && out.includes('she fills the same part of the frame in every frame as in <Video 1>')
    && !/dances at full amplitude/i.test(withAct)
    && !withAct.includes('Where the moves slow down')],
  ['场景句结尾不出现双句号（…trees..）', !/\.\.\s*(\n|$)/.test(out)],
  // 2026-10-28：场景清洗的三类实测写法（项首占位 / 项首否定 / 中间夹否定小句）
  // 2026-10-31：期望值随 10-30 新增的两条规则更新 —— `distant` 和 `city building outlines`
  //   现在整段删除（实测会被画成画面上方远景灰块），所以 `faint distant city building outlines,
  //   no close vertical walls` 这一整段都会被吃掉，只剩 `walls: faint`。
  ['scrubSceneEn 剔掉中间夹的 no … 小句',
    scrubSceneEn('walls: faint distant city building outlines, no close vertical walls; floor: stone tiles.') === 'walls: faint; floor: stone tiles.'],
  ['scrubSceneEn 剔掉项首 none mentioned',
    !/none mentioned/i.test(scrubSceneEn('walls: none mentioned, open horizon view; light: daylight.'))],
  ['scrubSceneEn 把 reflecting dancers 改成 reflecting the room',
    scrubSceneEn('mirror wall reflecting dancers, light: panel lights.').includes('reflecting the room')],
  // 正常场景的正面内容必须全部保住；只有 `without harsh shadows` 这类否定小句会被剔掉（预期行为）
  ['scrubSceneEn 不误伤正面内容', scrubSceneEn(SCENE).includes('candy-colored facade with decorative stripes') && scrubSceneEn(SCENE).includes('light-colored cement ground')],
  ['scrubSceneEn 剔掉 without 小句后不留残句', !/\bwithout\b/i.test(scrubSceneEn(SCENE))],
  // 2026-10-28：LLM 翻译会在同一项里把同一短语贴两遍（实测 `wide open dance-area stone paving in mid-ground` ×2）
  ['scrubSceneEn 去掉同一项里的重复短语',
    scrubSceneEn('floor: stone tiles, wide open paving in mid-ground, wide open paving in mid-ground; light: daylight.').split('in mid-ground').length === 2],
  // who 段自带尾点时，模板不再补一个（否则 `… winter morning..`）
  ['Subject 1 里不出现双句号（…morning..）', !/\.\.\s/.test(out.split('<Subject 2>')[0])],
  ['Subject 1 里不出现「;.」这类标点粘连', !/[;:,]\.\s/.test(out.split('<Subject 2>')[0])],
  ['场景里不留「walls: no … visible」这类负面存在写法',
    !/:\s*(?:no|without|none)\b/i.test((out.split('featuring ')[1] || '').split('\n')[0])],
  // 2026-10-28：per-段动作句下线后，这两条（超长舞步的裁剪行为）已无输出可测；
  // 裁剪逻辑仍留在 compileDancePrompt 里（便于回滚），恢复那行模板句时把这两条断言一起加回来。
  ['带 action 仍在上限内', withAct.length <= 6980],
  // 2026-10-26：动作句改成每条带「在本段里占几秒」（翻译按占比分配篇幅），断言跟着改。
  ['outline 按时间窗取本段（段2，带秒数）', danceActionText(outlineProject, seg2Shot) === '7.3s: 转身连续旋转'],
  // 段2 时间窗 7.31~14.63：第一条只沾 0 秒（end 7.31 ≈ s0），不该进来
  ['outline 只收与时间窗真重叠的条目', !danceActionText(outlineProject, seg2Shot).includes('双手叉腰扭腰')],
  ['outline 坏 JSON 不炸', danceActionText(unknownProject, seg2Shot) === ''],
  // 🔴 2026-10-27：动作句里出现头部/面部动作（nod/head/face/eye/chin）会把模型逼到特写 ——
  //    实测段4 是四段里唯一带 `nodding slightly` 的，也是唯一出大脸的；段1/2/3 动作句零头部词全好。
  //    颔首/点头这类礼节动作在 translateDanceAction 里已经被剔掉，这条守它不被加回来。
  // 🔴 2026-10-27：动作句里出现头部/面部动作会把模型逼到特写 ——
  //    实测段4 是四段里唯一带 `nodding slightly` 的，也是唯一出大脸的；段1/2/3 零头部词全好。
  ['stripHeadActions 剔掉颔首/点头（段4 大脸根因）',
    stripHeadActions('双手收拢至胸前轻轻拍合，双脚小步并拢站定，微微颔首，保持微笑完成收尾') === '双手收拢至胸前轻轻拍合，双脚小步并拢站定，保持微笑完成收尾'],
  ['stripHeadActions 不碰站定/拍手/并步',
    stripHeadActions('clapping hands, stepping feet together, standing still') === 'clapping hands, stepping feet together, standing still'],
  // 🔴 2026-10-27：段4 稳定复现的 3~5s 大脸出在 `clap at her chest ... to a still stance`。
  //    chest 把注意力上移到上半身、still stance 把"站定"说成"姿态静止" → 模型用特写填画面。
  // 🔴 2026-10-27：模板里原来写 `She has a complete head, a full face and her own hair in every frame`
  //    —— `a full face ... in every frame` 等于直接要求"每帧都要有一张完整人脸"。
  //    改成只保"完整头部 + 自己的头发"（正话：不断头、不换发型），不提"完整的脸"。
  //    注意：五官/肤色/妆造描述一个字都不能删 —— 删了画面发黄（实测 R/B 1.16 → 1.42）。
  // 🔴 2026-10-27 段4 结尾"背景上隐约两次人脸"：
  //    ① 场景卡写 `mirror wall reflecting dancers`（复数泛指）⇒ 镜面背景里浮出陌生人的脸；
  //    ② 模板 `The panels of that board ...` 点名"板子里有几格图" ⇒ 模型照着贴格子内容（含正脸）。
  ['镜墙句只在场景里真有镜墙时出现（换背景不能凭空加物件）',
    !withAct.includes('The mirror wall shows nothing but her own reflection')
    && compileDancePrompt({ characterPrompt: WHO, outfit: '', scenePrompt: 'a dance studio with a full-height mirror wall and a wooden barre; floor: polished wood; light: cool white panel lights.', style: 'photoreal', frames: 175, shotNo: 1, totalShots: 2, scenePic: 2 })
      .includes('The mirror wall shows nothing but her own reflection')],
  ['通用：不写死冷白灯管/光源类型', !/cold white tube lights/i.test(withAct)],
  ['通用：人物为空时不写死长相（男/长发/儿童也不被改写）',
    !/short black chin-length hair/i.test(compileDancePrompt({ characterPrompt: '', outfit: '', scenePrompt: SCENE, style: 'photoreal', frames: 175, shotNo: 1, totalShots: 2 }))],
  // 2026-10-28（用户「大脸来自人物参考图」）：不再提"板子有几格"，改成声明参考板只给长相/服装，
  //   并且明确"全片只有 <Video 1> 那一个景别、她每帧只出现一次"——这才是能压住"照贴参考板近景"的写法。
  // 2026-10-31：模板措辞换成 `multi-panel wardrobe and identity board`（三格三视图参考板），断言跟着更新。
  ['模板不点名「板子的多格」且声明参考板只给长相+服装（大脸诱因）',
    !/panels of that board/i.test(withAct) && /multi-panel wardrobe and identity board/i.test(withAct)],
  ['模板把景别锁成「只有 <Video 1> 那一个」',
    /one framing only, the one <Video 1> gives/i.test(withAct)],
  ['模板不提「完整的脸」（段4 大脸诱因）', !/a full face/i.test(withAct)],
  ['仍保「完整头部」（参考板无头必须补）', /complete head/i.test(withAct)],
  ['scrub 抹掉 chest（段4 大脸真凶）',
    scrubDanceActionEn('Both hands softly clap at her chest while small steps close her feet to a still stance.') === 'Both hands softly clap in front of her body while small steps close her feet to a stance.'],
  ['scrub 抹掉无冠词 chest',
    scrubDanceActionEn('Draws hands to chest, claps softly, stands still ending centered') === 'Draws hands in front of her body, claps softly, stands still ending centered'],
  ['scrub 抹掉 still stance/position',
    !/still\s+(stance|position|pose)/i.test(scrubDanceActionEn('feet close into a still position, body in a still stance'))],
  // 🔴 2026-10-28 通用：时间戳前缀 / 光暗描写 / 缺失占位都不许进提示词（实测 `6s:` + `in darkness` 真的发出去了）
  ['scrub 抹掉秒数前缀（6s: …）', !/^\s*\d+(?:\.\d+)?\s*s\s*:/i.test(scrubDanceActionEn('6s: She rises slowly from a crouch') + ' ')],
  ['scrub 抹掉 in darkness（写黑暗=把黑暗喂给模型）',
    !/darkness|in the dark/i.test(scrubDanceActionEn('A dancer curled on the floor in darkness, gently vibrating back'))],
  ['scrub 保留动作本体（只剔污染，不丢动作）',
    scrubDanceActionEn('6s: A dancer curled on the floor in darkness; Slowly rises').includes('Slowly rises')],
  ['负向闸能抓「缺失占位」（none mentioned）', findDanceNegations('walls: none mentioned, open horizon view').length > 0],
  ['负向闸能抓「光暗描写」（in darkness）', findDanceNegations('she rises from the floor in darkness').length > 0],
  ['scrub 不碰正常动作（段1/2/3 零误伤）',
    scrubDanceActionEn('Stands still before mirror, feet together, arms down, gently swaying shoulders') === 'Stands still before mirror, feet together, arms down, gently swaying shoulders'],
  ['真实段4 中文剔除后无头部动作',
    stripHeadActions('双脚小步并拢站定，微微颔首，保持微笑完成收尾').indexOf('颔首') === -1],
]

// ── 接缝定位：合成两段噪声拼成"整片"，拿第一段当"上一段"，必须解出第一段的时长 ──
// 这条不依赖任何生成素材，专门守「skip 猜错 → 整段晚 0.5 秒 → 音乐错位」那个 bug。
{
  const dir = mkdtempSync(join(tmpdir(), 'seam-'))
  const ff = process.env.FFMPEG_BIN || 'ffmpeg'
  const A = join(dir, 'a.wav'), B = join(dir, 'b.wav'), W = join(dir, 'w.wav')
  const mk = (out: string, seed: number, dur: number) =>
    execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anoisesrc=d=${dur}:c=pink:seed=${seed}:a=0.4`,
      '-ar', '32000', '-ac', '1', out])
  mk(A, 11, 3.0); mk(B, 77, 2.0)
  execFileSync(ff, ['-v', 'error', '-y', '-i', A, '-i', B, '-filter_complex',
    '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-ar', '32000', '-ac', '1', W])
  const got = await danceSeamStart(W, A, 3.0)
  // 画面起点：拿 A 当上一段，整片=A+B，应解出 A 的时长 3.0s（逐帧精度）
  const mvA = join(dir, 'ma.mp4'), mvB = join(dir, 'mb.mp4'), mvW = join(dir, 'mw.mp4')
  // A 用滚动测试图（有连续运动），B 用静止彩条 —— 两者运动量差别极大，模板不会在 B 段误配
  execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=d=3:s=160x288:r=24',
    '-pix_fmt', 'yuv420p', '-r', '24', mvA])
  execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=d=2:s=160x288:r=24',
    '-pix_fmt', 'yuv420p', '-r', '24', mvB])
  execFileSync(ff, ['-v', 'error', '-y', '-i', mvA, '-i', mvB, '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', '-r', '24', mvW])
  const mGot = await danceMotionSeam(mvW, mvA, 3.0)
  fails.push([`画面起点误差 ${mGot < 0 ? '解不出' : Math.abs(mGot - 3.0).toFixed(3) + 's'}（应 < 0.05s，解出 ${mGot.toFixed(3)}）`,
    mGot > 0 && Math.abs(mGot - 3.0) < 0.05])
  const okSeam = got > 0 && Math.abs(got - 3.0) < 0.06
  // 不相干素材必须拒（返回 -1），否则会乱跳
  const rej = await danceSeamStart(W, B, 3.0)
  fails.push([`接缝定位误差 ${Math.abs(got - 3.0).toFixed(3)}s（应 < 0.06s，解出 ${got.toFixed(3)}）`, okSeam])
  fails.push(['接缝定位拒绝不相关素材（应 -1）', rej === -1])
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('长度', out.length, '/ 带舞步', withAct.length, '/ 6980 | 词数', withAct.split(/\s+/).length)
for (const [what, ok] of fails) console.log(ok ? '  ✓' : '  ✗', what)
const bad = fails.filter(([, ok]) => !ok)
if (bad.length) { console.error(`失败 ${bad.length} 项`); process.exit(1) }
console.log('全部通过')
