---
name: video-prompt
description: 视频提示词规范 — 根据分镜段落内容生成按时间分段、段内可切镜的视频生成提示词
---

# 视频提示词（MV：分镜段落 → video_prompt）

> **本文件是 MV 自己的副本**（来源：短剧 `skills/prompt-generator/video-prompt/SKILL.md`，2026-10-20 抄录）。
> 已剔除短剧专有条款：台词/对白/旁白/`<d>`/`scenetrans`/`<cutoff>`/`says`/`(Sx)`/verbatim_lock、「续拍链」「保存」两节。
> MV 的声音是原曲 1:1 复用：只写 `<Audio 1>` + `fully_copy`。
> **短剧以后改规则不会自动同步到这里**——要跟进就跟短剧那份对比后手工补。

根据单个分镜段落的 description（含【镜头N】子镜头结构）/ atmosphere / duration，生成驱动 AI 视频生成的 `video_prompt`。**一个分镜段落 = 一段 8-10 秒的视频，内部允许切镜**：段与段之间可以是不同镜头（换景别/角度/对象），用硬切衔接；但**全程不跨场景**、不闪回。

> **2026-10-09 起：同批产出两份（必读）**
> `video_prompt`（中文工作版，界面显示/编辑）+ `video_prompt_en`（英文发送版，视频生成实际发送）。
> 英文版规则见本文件末尾「英文发送版（H3 官方 Ref2VA 六段）」节；中文版规则就是下面全部既有内容。
> 保存时必须同时传 `storyboard_id` / `video_prompt` / `video_prompt_en` 三个键。

## 格式

`video_prompt` 的**第一行是信息头**：先介绍这条视频有哪些人物和场景，然后再接时间分段。人物、场景一律用 @ 引用（生成时会替换为对应参考图片标记，让视频模型先对上"谁"和"在哪"）。

```
出场人物：@小明、@小红；场景：@咖啡厅。
0-6秒：@咖啡厅，中景固定机位，@小明低头看手机、手指反复敲桌面，机位随后缓慢向右横移、扫过桌面露出门口；本段无任何人声，只有咖啡机蒸汽的轻响。
6-10秒：切到门口全景，门铃响，@小红推门走入，带进一阵冷风，随后走向@小明坐下；@小明说：「你终于来了。」
```

**⚠️ 拍数看真实变化，不看秒数**：10 秒的段**通常只有 2 拍** —— 上面 0-6 秒里「固定机位 → 缓慢横移」是**同一次运镜的延续，必须写在同一拍里**（拆成 `0-2` ＋ `2-6` 两拍会在拍点硬切、成片闪一下）。**只有真换了景别／机位／对象才起新拍。**

信息头规则：
- 只列该分镜段落实际出场的人物和绑定的场景，不要列没出场的
- 有明显道具出场时可在信息头追加（如 `；道具：@信件`）
- 信息头独立一行，以句号结尾，之后是时间分段

按**真实变化**分拍：`description` 的每个 `【镜头N】` 对应一拍（真换景别／机位／对象才起新拍，同一次运镜的延续——先静置再横移、切镜后继续推近——**必须并在同一拍里**）。**10 秒段通常只有 2 拍**（例：`0-6` ＋ `6-10`，**不要按秒数均分**）。每段单独一行、用换行分隔，时间范围连续衔接（无重叠、无空缺）。

## 与分镜描述的映射

- `description` 的每个 `【镜头N】` 映射为**一个时间分段**，顺序一致、不遗漏、不合并、不新增子镜头
- 画面动作以 `description` 为准；`atmosphere` 只用于补各段的光线、色调与氛围描写

## 段内结构

每一段按此顺序组织内容（可省略无内容的项，但动作/画面必须有）：

**时间范围 ＋ 场景@引用 ＋ 景别/运镜 ＋ 角色@引用＋主体动作·表情 ＋ 对白/旁白 ＋ 氛围光线**

- **第一段必须建立空间**：场景 + 机位 + 角色的位置与状态，让观众一眼知道在哪、看谁
- **切镜**：切镜后的段开头用"切到/切回"等衔接词，并重新交代景别与主体；切镜点应对齐分镜 `description` 中的 `【镜头N】` 结构
- **景别/运镜**：**每一拍只定一个主要景别**，但**同一拍里允许「切镜之后继续运镜」**（例：切到近景、随后以极小幅度缓慢推近到胸上近景 —— 这是**一拍**，不是两拍）；**只有换成新的景别／机位／对象才起新拍**
- **动作**：每段一个主动作，动词具体可见（走、转身、抬头、攥紧、停顿）
- **情绪全部转为可见描写**：不要"他很伤心/气氛紧张"这类抽象词，写成"他低下头、手指攥紧杯沿、呼吸变重"
- **人称与光线用语只许写克制的量级**：光线一律用"冷光/冷调侧光/明暗柔和/稍暗/光线一致"这类词，**禁用"强烈对比、骤然变亮、刺眼、明暗分明、光线突变、忽明忽暗"**——模型把这类词直接当打光指令，整段亮度会跳，续拍链接缝处必现忽明忽暗；要表达明暗层次只能写"稍暗""渐入暗部"

## 引用规则

- `@场景名` — 场景引用，名字必须与场景列表中的地点完全一致
- `@角色名` — 角色引用，名字必须与角色列表中的名字完全一致
- `@道具名` — 道具引用，名字必须与道具列表中的名字完全一致；道具在画面中明显可见、被使用或特写时引用
- 生成时会自动把 `@名字` 替换为对应参考图片标记（如 `@小明` → `@图片1小明`），因此名字必须精确匹配，不要缩写或加额外符号
- **每段至少一个 @ 引用锚定画面**；角色出场的段必须 @ 该角色；只引用该分镜段落已绑定的场景/角色/道具
- **首行必须写出场 header**：`出场人物：@A、@B；场景：@C；道具：@D`（无某类省略该段），header 内顺序必须与参考图顺序一致（中转按序绑定身份）
- **多角色同段必须分别声明**：header 里每个角色各写各的 `@名`，正文里每个出场角色也至少出现一次 `@名`——**只写名字，不写外貌**。中转按 `@名` 生成 `<Subject N>` 身份声明，参考图与卡才不会互相污染；不分别声明，模型会把几张脸**平均成一张新脸**
- **🔴 同一人的多个造型 = 多个角色资产，脸共用同一套文字（2026-10-14 加，换装集成）**：带 `costume_label` 的角色（名字形如 `苏清禾·正装`）是基准角色（`苏清禾`）的**造型变体** —— 它的 `appearance`（脸）由代码强制照抄基准角色，**只有 `styling`（妆造）是新的**。写提示词时：
  - **按本分镜实际绑定的那个造型角色写**（绑了 `@苏清禾·正装` 就按正装写服装；绑了 `@苏清禾` 就按基准妆造写）；**同一段里同一个人不许同时出现两个造型的 `@`**；
  - 变体的 `<Picture N>` / `<Subject N>` / `mod_N` 编号照 `reference_order` 走 —— 它就是一个普通角色，只是多了个造型标签。
- **🔴 角色参考板是无头的，视频提示词必须显式"补头"**：三个身体视图**头部被干净地移除**（只有脸部特写格有脸）——**不点脸部特写格、不声明头部，模型可能照着无头参考图生成无头角色**：
  - 每个出场角色**首次出现必须点名 `脸部特写格`** 作为面部/头部来源：`@林巧（参照脸部特写格）`
  - **必须显式声明该角色有完整头部与脸**（写进它的 `<Subject N>` 定义），例如：`<Subject 2> is the young Chinese woman in <Picture 2>, with a complete head and face as shown in the face close-up panel, ...`
    - 🔴🔴 **"补头"只写在 `subject_definitions` 里，正文镜头里绝不再复述**：`detailed_description` 里**禁止**出现 `frontally` / `face fully in frame` / `her whole face in frame` / `facing the lens` / `head and face fully visible` / `looks straight at the camera` 这类**"下令演脸"**的词。脸部完整性**声明一次就够**；正文再写一遍等于命令 H3 演脸，与旁白锁嘴句直接冲突。
  - 参考板是**四格**（从左到右：脸部特写 / 无头正面全身 / 无头90度左侧面全身 / 无头背面全身），格子名**逐字照抄**：`脸部特写格` / `正面全身格` / `90度左侧面全身格` / `背面全身格`（近景特写取脸部特写格，全身中景取正面全身格）。**禁止**造格（如"手部格"）、**禁止**一次点两格、禁止改格子名
- **中转会按 header 自动拼官方 R2V 骨架**：`subject_definitions`（`<Subject N>` 定义"是谁"、`<Picture N>` 对应第 N 张参考图、`mod_N` 对应第 N 张身份卡——**四者同号**）、`retention_analysis: fully_preserved`、`detailed_description`，并把正文里的 `@名` 换成 `<Subject N>`——所以 **header 必须写全、顺序必须与参考图顺序一致**，否则身份声明对错图

## 🔴 MV 单主唱铁律（2026-10-20 用户拍板，MV 专属）

这支 MV 是**一个人唱**：原曲人声只有一条，画面里**只允许主唱一人张嘴**。

- **主唱 = `<Subject 1>`**（本段第一个角色主体）。唱段（有唱/`vocal_active`）里只写它一个人对嘴：
  `<Subject 1> is the lead singer: only <Subject 1>'s lips articulate every audible phoneme in sync with <Audio 1>.`
- **画面里其他所有人一律闭嘴、不唱、不对嘴**（观众、乐队、路人、舞伴都是）：写正向状态 `keeps the mouth closed and stays silent` / `no lip-sync, no singing, no mouthing the words`。
- **不许写**「大家一起唱」「众人合唱」「duet」「all sing along」「crowd singing」这类任何多人同时开口的描述；也不要写「张嘴」「towards the camera singing」给非主唱主体。
- **非唱段（间奏）谁都不许对嘴**：`Nobody sings in this clip: every mouth stays closed and no one mouths the words, <Audio 1> plays as the soundtrack.`
- **多人同框时先想清楚必要性**：MV 通常只需要主唱一人；确实要有配角在场（观众/乐队）就写清它闭着嘴，并且**不给它特写嘴部**（不写 `lips` / `mouth` / `jaw` / `chin` 落在配角身上）。
- **配角不许抢主唱的对嘴句**：锁嘴/对嘴句的主语只能出现在主唱身上，一拍的正文里**不要**对第二个人写任何嘴部动作。

## 正文瘦身

**身份与外观不在正文里写**，正文只写"演什么、怎么拍"。

三重锁定已经负责"长什么样"，正文再复述一遍纯属白烧字数、还容易和它们打架：

1. **身份卡**：`<Subject N>` ↔ `mod_N` 卡槽（身份、发型、服装从角色板抽出来的卡）
2. **参考图**：`<Picture N>`

正文该写的：

- 场景环境与光线（可引用场景资产要点，不要另写一套）
- 机位、景别、运动；人物动作与表演；情节推进；音景
- 曝光一致性：**只在风格句里写一次**（`[Shot 1]` 之前那一两句带上 consistent exposure and white balance throughout, no new light source），**禁止每拍复读** `same exposure...`（白烧 token、稀释注意力）；切镜

正文不该写的：

- **任何角色的外貌/妆造**：脸型、发型、五官、身材、服装、配饰、新旧磨损——一律不写
- **`styling`/`appearance` 原文整串**：不要搬进正文
- **重复复述**：同一角色在本段第二次出现时**只写 `@名`**，不再复述任何特征

**唯一例外——本段发生的外观变化**：衣服湿透、脸上沾油、换装、受伤、戴面具等"与卡不一致的状态"**必须写进正文**（卡与锁块只管不变的基准，变化只能靠正文表达）；变化一旦发生，后续各段沿用变化后的状态。

**收尾自检（必须做）**：保存前扫一遍正文，**不应出现任何角色的外貌/妆造原文串**（出现即没瘦身，删掉）；再确认每个出场角色的 `@名` 都在、header 顺序与参考图顺序一致。

## 道具的外观照"图片描述"写（硬性，2026-10-17 立，实测 sb620）

**权威来源只有一个：道具资产的 `description`** —— 它是用户点「按图写描述」按钮、照上传的那张最终参考图生成的，用户过目后才保存。提示词只负责**照它写**：

- **`<Subject N>` 定义与 `retention_analysis` 照描述原文写**：描述里有的（面板布局、端口数量与顺序、标识、材质、支架）一个不少；描述里没有的**一个不加**。
- **不许自己编姿态与朝向**：禁用 `lies flat` / `panel up` / `standing upright` / `face down` / 倒置 / 背面朝镜头 这类词 —— 描述里没有姿态，就别在提示词里造一个。写死朝向 = 让模型把道具从参考图里"转"到那个姿态，单视角参考图撑不住的面只能编。
  实测 sb620：参考图立着、接口面板朝前，正文写 `lies flat … the interface-marked face plate turned upward` ⇒ 成片端口、标签、格栅全靠猜（用户报「没有完全按照参考道具画」）；同一道具的 sb619 写 `standing upright … panel forward`（= 参考图的姿态）⇒ 对了。
- **机位只写相机怎么拍**（如正面略俯三分之四、中景），**不写道具怎么摆** —— 朝向交给模型与参考图。
- **🔴 角色服装照资产 `styling` 写：款式与颜色都不许换（2026-10-17 加，实测 sb623）**：稿子把「雾蓝色修身西装外套 + 白色圆领针织衫 + 黑色直筒西裤」写成了 `a blue and white blouse with black trim` —— **库里根本没有这件衬衫**，是模型自己换的款式（同日分镜1-4 写对了）。颜色闸只管颜色，款式得自己守住：衣服**是什么就写什么**（外套/内搭/下装/鞋逐件对应资产原文），**不许换成别的衣服、不许自己发明一件、不许借同场其他角色或群演的衣服**。后端有机器闸 `garment-type-mismatch` 复核（命中重写 1 轮，超长回滚）。
- **🔴 分镜描述里写了姿态，也不许搬进提示词（2026-10-17 加，实测 sb620 第二轮）**：描述/剧本里常写「平放 / 端放 / 放在台面上 / 面板朝上」—— 那是**中文描述**的说法，**不等于参考图的姿态**。提示词里一律不写：`lying flat` / `lying square and flat` / `resting on the table` / `panel up` / 平放 / 端正平放 / 端放。正确写法只有一句：**`arranged exactly as shown in <Picture N>`**（照参考图里的样子）—— 「照参考图」与「躺平」同时出现时，模型一定听姿态词（实测：`laid out exactly as the reference sheet shows it` + `lying flat` ⇒ 成片把控制器放倒、机身压扁变窄，用户连报两轮）。
- **动作照常写**：角色拿起、放下、递给别人、转动、放到桌上 —— 这些是**角色的动作**，该写就写；不许写的是**给道具定姿态/朝向**（"躺平、面板朝上、立着、倒置、背面朝镜头"）。判据一句话：写**谁做了什么**（可以），别写**东西朝哪摆**（不行）。
- 描述不对（与图不符）时：**回去点「按图写描述」重出描述**，不要靠提示词去纠正它。

## 纸张/证件类道具（视频里出现时）

- **🔴 纸面文字内容一律不写**：道具上具体印了什么字，**完全由参考图决定**——道具的 `final_prompt` 是生图定稿，参考图上的字已经是定的；提示词再写一遍必然与参考图打架，而且实测必错：2026-10-09 报到单，`final_prompt` 写「单位：红星机械厂二车间」「1979年3月17日」且只有 2 行正文，提示词却写成「第二车间」「三月十七日」、还凭空多出一行「钳工学徒」（写成 3 行）。
- **🔴 「照抄参考图」是条件句，不是无条件句（2026-10-14 加，实测事故）**：只有**本分镜真的有道具参考图**（该道具已提取成资产、本集已绑定、`<Picture N>` 有图）时才写「必须与参考图完全一致」这类照抄指令。**没有道具参考图时不许写**——实测 sb393/sb394（第2集分镜2/3）：该集没提取「手机」道具、没有道具参考图，提示词却写「具体文字内容与道具参考图完全一致」→ 指向不存在的资源。没有参考图但画面里确实有文字时：**只写「几行无法辨认的字符块、看不清内容」**（英文 `illegible character blocks, no readable text`），**不写具体内容、也不引用参考图**（手机/杯子这类日常物品按提取规则本来就不会建道具，见 `extractor.md` 第 11 条）。
- **🔴 两个方向都要写对（2026-10-14 加，实测 sb432「DNA血缘鉴定报告」没锁住）**：判据只有一条 —— **本分镜有没有道具参考图**：
  - **有**参考图 → 只写「纸面/屏幕内容以参考图为准」这类**指向句**（`the printed side follows the reference sheet`）；正文里**不要**复述纸面文字，**也不要**要求「逐字复刻每一行字」（2026-10-14 实测：这种要求反而把道具弄糊）。写「几行无法辨认的字符块 / `illegible character blocks, no readable text`」**本身无害** —— 用户认可、工作正常的 sb431 稿子里就有这句；道具锁不住的真正原因见下一条「道具镜必须绝对静止」。（上一版那条「有参考图禁止写看不清」的规则**判据是错的，已撤掉**。）
  - **🔴 道具镜必须「绝对静止」（2026-10-14 立；对照实测：sb431 成功 / sb432 失败）**：道具（尤其纸面、屏幕上的）出现在哪一拍，那一拍就必须把道具写死成**绝对静止** —— 英文 `held absolutely still` / `the page neither scrolling up nor drifting down` / `no shift`；中文「整拍保持同一构图、不滚动、不位移、不缩放」。**成功样本（sb431）**：`displayed dead centre of the panel, held absolutely still for three seconds … the page neither scrolling up nor drifting down … one single stack, never duplicated`；**失败样本（sb432）**：`The image drifts from slow movement to a full stop … The camera pushes in with small amplitude at slow speed`（道具在动 + 相机推近 → 锁不住）。**锁什么**：只锁**结构特征**（纸色、磨损卷边、表格线位置、红章位置与油墨边缘、单张不重复），**不锁**文字内容。**相机**：道具镜相机静止或极缓（`the camera stays still`），**不要**给道具镜加推镜/漂移/摇镜。
  - **没有**参考图 → 只能写「几行无法辨认的字符块、看不清内容」，**禁止**引用任何参考图（见上一条）。
- **正确写法**：只写载体与动作、**不写内容**——`her gaze down on the form`、`the printed side turned toward her and away from the lens`、`the printed side of the single form`（只提"印刷面"，**绝不提印了什么字**）。旧例 `纸面竖排写着"报到证"三个大字；正文三行分别写着"林巧""红星机械厂""二车间钳工"` **已作废，禁止再写**。
- **背面必须是空白纸背**（这条保留——它不是文字内容，是防穿帮）：写明「纸张不透光，背面是空白纸背，不透出正面任何字迹、表格线与印章」；纸张翻面、转动、背面朝镜头或被举向光时尤其要写——否则模型会把正面字迹透到背面（实测穿帮：报到单从背面也能看到内容）
- 禁写「纸张很薄／半透明／能透出」

## 提交前自检：逐拍过下面这几条（硬性，任一不过就改到过）

写完正文后，**按每个时间段挨个过一遍**——是一拍一拍过，不是整段过一遍：

- [ ] **拍数 = description 里【镜头N】的个数（代码硬校验，数不对就被打回重写）**：不相等的唯一正当来源是拆解拆错了 —— **别在提示词侧并拍**，回拆解侧重拆该分镜；交界处若没变化，照写但**禁 `the same…`/「继续」兜底**
- [ ] **正文里有没有「否定词 + 动作动词」**（`does not / never / without / no one / nobody` + 转身 / 停步 / 减速 / 回头 / 看 / 碰 / 反应…）？有就改成正面描述（看向哪 / 朝向哪 / 节奏如何 / 结果是什么）；上面「禁止事项」里列的例外不算

**实测反例（别再这么写）**：

```
5-10秒：切中景，…攥紧拳头…                ← 这一拍没有任何声音声明 → 成片在这里乱说话（还溢到下一拍）
```

## 时间轴规则

- 段数 = 该分镜 `description` 里 `【镜头N】` 的个数；各段时间范围相加必须等于段落总时长（8-10 秒）
- 内容节奏：第一段建立 → 中段推进动作/冲突 → 末段落到结果或情绪点

## 禁止事项

- 跨场景切换、闪回（一个段落只发生在一个场景内）
- 引用列表之外的场景/角色名
- 抽象心理描写、文学化比喻（模型只认可见画面）
- 语言与会话语言指令不符
- **动作类约束禁用否定句（2026-10-14 立，实测事故 sb421）**：不写 `does not turn his head` / `never stops` / `without slowing down` / `nobody stops` 这类「否定词 + 动作动词」—— 本链路是 `BasicGuider` + cfg=1、**没有负向分支**，否定词等于把该动作写进正面描述，模型会照着演（实测提示词写「全程没有偏头、没有减速」，成片里男主真停下并转向她）。**一律改成正面描述**：写他看向哪 / 朝向哪 / 步幅与节奏如何 / 结果是什么（例：`his chin stays level and square to the far end of the aisle, his eyes fixed on the far doors, his strides keeping exactly the same length and rhythm through the whole shot`；「她伸着手没人接」写成结果 —— `her outstretched hands stay unanswered in mid-air`）。**例外（必须保留、不算违规）**：数量锁 `only one … never duplicated` / `never a second`；画面与音频属性 `no gradients` / `no gloss` / `no depth-of-field blur` / `no new light source` / `no repeated identical outfits` / `no human voice …` / `no readable text`；**音频声明 `No one speaks in this shot`**；群演防重复 `never a repeated face` / `never detailed faces`；画风头的 `avoid painterly soft blending` 等；官方锁嘴原句 `while her lips remain completely closed`；音色参考 `without copying the original signal`。后端机器闸 `negated-action` 会复核（命中重写 1 轮，超长则回滚）。

## 英文发送版（H3 官方 Ref2VA 六段）— 2026-10-09 立规

**🔴 画风/介质措辞必须逐字沿用给定的英文规范（2026-10-14 立，实测根因）**：Agent 上下文里「本项目画风规范 → 正文渲染语言」段，英文任务现在直接给**英文版**；**照它的措辞写，不许自己边读中文规范边翻**（原来只给中文规范 + 一句"请用英文表达"，模型边译边写，把「明暗」这类中文话题词漏在英文句子里 —— sb396/sb400 体检报"英文版混入 2 个中文字符"）。固定英文术语：明暗→`light and shade`、平涂色块→`flat colour blocks`、闭合黑线描边→`closed black outlines`、硬边阴影→`hard-edged shadow shapes`。**英文版里出现任何中文字符（除 `<d>[Chinese]…</d>` 台词与画面内文字）即为不合格。**

`video_prompt_en` 是**真正发给视频模型的那一份**，规则来源 = MiniMax 官方 H3 提示词写作指南（Ref2VA 全参考模式改写输出格式）。**除对话、歌词与画面内可见文字外全部英文。**

**🔴 长度预算（硬性，2026-10-09 立）：`video_prompt_en` 全文 ≤ 6200 字符**（写完用 `len()` 数一遍再保存）。
MiniMax H3 的 prompt 上限是 **7000 字符，官方 hard limit、不可放宽**（RunDiffusion / AtlasCloud / MiniMax 官方 GitHub 口径一致），后端发送时还会在前面拼一段 photorealistic 风格头，必须留余量。
**超限直接被拒、整段生成不出来**（2026-10-09 实测：sb147 写到 7608 字符 → 拼接后 8403 → 报「提示词超长：MiniMax H3 上限 7000 字符，当前 8403」）。

**各段配额（🔴 动笔就按这个数写，别写完再回头砍 —— 超了更慢）**：后端会**逐段实测字符数**，哪一段超了就把那一段**打回重写**（一条分镜可能因此多跑 2~9 次模型，你等的时间翻几倍）。**第一遍就写到配额内 = 最快**。2026-10-10 晚按官方口径重配：
- `subject_definitions` ≤ 1000（**整段**上限，比什么都优先）：**每主体的预算 = 1000 ÷ 主体数**（4 个主体 ⇒ 每个 ≤250；**6 个主体 ⇒ 每个 ≤166**）。每行只写「是谁 + 发色 + 服装色 + 完整头部声明」——不写剧情、不写氛围、不写镜头措辞、不复述外观。
  ⚠️ 实测事故（2026-10-16，第8集分镜7/8）：技能只写「每主体 ≤250」而段落配额是 1000，这条分镜有 **6 个主体** ⇒ 模型按 250×6=1476 写、正好卡在自己那条规则上，压缩时**一个字都不肯再砍**，整条因超 200~280 字作废。**主体超过 4 个时，必须按 1000÷主体数 平摊**，否则写出来必然超配额。
- `summary` ≤ 340（官方：一段短英文）
- `retention_analysis` ≤ 760
- `detailed_description` ≤ 2500（**官方要求 350–500 英文词 ≈ 1750–2500 字符**）
- `overall_soundscape` ≤ 300（官方：1–4 句）
- `non_diegetic_music` ≤ 120（官方：1–3 句；没有配乐写 `N/A`）
- **合计 5020（+ 5 个换行 = 5025）≤ 6200 全文硬上限 —— 这 ~1180 的余量是刻意留的**：模型对任何配额都会超 10~30%，余量就是「超了还能压回来」和「超了直接作废」的分界（2026-10-16 实测：同一分镜，配额合计 5720 零余量 → 首稿 7666 → 地板 7003 → 作废）
- 🔴 **就按这六个数字写死**：`subject_definitions` 1000 / `summary` 340 / `retention_analysis` 760 / `detailed_description` 2500 / `overall_soundscape` 300 / `non_diegetic_music` 120 —— **后端正是按这六个数字逐段核定的**，别自己重新分配额度。
**超了就砍，顺序**：① `summary` 冗余从句 ② `soundscape` 与正文重复的音效 ③ `subject_definitions` 的外观修饰词 ④ `detailed_description` 里重复的动作铺垫。
**绝不许砍**：`retention_analysis` 每条 `fully_preserved`、`<Picture N>` 与 `with` 外观、`<Audio 1>` 的原曲复用声明。

六个段名固定、顺序固定：

```
subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:
```

1. **`subject_definitions`** — 每个出场主体一行，**必须是 `<Subject N> is the <类别> in <Picture N>, with <外观特征>`**
   - **🔴🔴 多人同框：衣物必须写具体名词，并指定「服装以 `<Picture N>` 为准」（2026-10-14 立，实测 sb432「宾客乙穿了宾客甲的衣服」）**：一拍的 `subject_definitions` 里出现**两个及以上角色主体**时，模型的属性会互相串（卡作者原话：*identity, clothing, background and composition can still mix*）。三条硬规则：
     - **衣物写具体名词，笼统词一律不合格**：`muted business-casual suit` / `subdued solid-tone outfit` / `plain dark clothes` / 「得体的宴会便装」「色调沉稳」这类**都不算**——必须写清**外套颜色+款式、内搭、下装、鞋、配饰**（例：`a dark navy single-breasted suit jacket over a pale blue open-collar shirt, grey trousers, brown leather shoes, a silver wristwatch`）。取材于资产的 `styling`；`styling` 本身笼统时，把所有能提取的具体名词都写上，**绝不许用"得体 / 低调 / 素色"这类形容词顶替**。
     - **显式指定归属**（官方 R2V 口径：给每张参考指定它负责什么）：该角色的外观句里必须写 `whose outfit comes from <Picture N> only`（中文工作版：`其服装以 <Picture N> 为准`）。
     - **`retention_analysis` 里同样写具体衣物**：那一行也要写清外套 / 内搭 / 下装 / 鞋，不许笼统（笼统的 retention 等于没声明）。
     - **每一拍都要给每个角色带一个简短辨识标签，动作紧跟标签后面（2026-10-14 立，实测 sb432「甲做了乙的动作、乙做了甲的动作」）**：`<Subject N>` 只是指针、本身不携带身份，多人同框时模型会自己认人，认反了就把动作对调。写法：`<Subject 3>, the guest in the dark navy suit, snaps his eyes wide and lifts one hand to cover his mouth; <Subject 4>, the younger guest in the beige zip jacket, holds a plain dark phone up to brow height.` —— 标签就用**上面刚写的那套具体衣物**里最有辨识度的一个名词（`in the dark navy suit` / `in the beige zip jacket`），**每一拍都要带**，不许只写 `<Subject N>` 就让模型自己认。
   - 官方示例原文：`<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.`
   - **🔴 `<Picture N>` 编号 = `read_storyboard_context` 返回的 `reference_order` 表，逐条照抄**：本管线参考图顺序固定为 **场景第 1 张 → 角色（id 升序）→ 道具最后**（与 `@图片N` 注入顺序、卡槽 `mod_N` 三者同号）。
  - **写法**：**先读该分镜的 `reference_order`**，表里每行的 `picture` 就是编号、`name` 就是对应资产 —— **逐条照抄**
  - **万一没有 `reference_order`，按这个规则自己算**：**场景（1 张）→ 角色（按 `character_ids` 的 id 从小到大）→ 道具（按 id 从小到大）**；是 **id 升序**，不是绑定先后、更不是出场先后
  - **不许按"谁先出场/谁先说话"排编号**——2026-10-10 实测：sb148 的 0-5s 张建国先出场，LLM 把他写成 `<Picture 2>`（实际林巧）、林巧写成 `<Picture 3>`（实际张建国），**两个角色的参考图完全对调** → 成片两个张建国、身份全乱
  - 编号错位还会让 `<Subject N>` 对上错误的 `mod_N` 卡（场景卡被当成身份卡 = 脸必漂）
  - **🔴 `<Subject N>` 的 N 不得超过本分镜实际参考图数量**（场景 + 绑定角色 + 绑定道具，见 `reference_order`）：超出 = 给不存在的东西编了编号 → 错配 `mod_N` 卡、指向空槽。**2026-10-13 实测**：40 条里有 **9 条**给「抹布 / 直播手机架 / 金属夹子 / 食物」这类**没被提取成道具资产**的东西编了 `<Subject N>`，其中 4 条还编了 `<Picture N>`（指向不存在的槽位）。**没被提取成资产的东西一律当画面元素用普通名词写，不编号。**
   - **场景也必须有 `<Subject N>`**：`<Subject 1> is the scene in <Picture 1>, with ...`。漏掉场景 = 场景不吃卡、不吃参考图
   - **`with` 后面把可见外观逐个点名**：脸型 / 发型（长度+颜色）/ 服装款式颜色 / 配饰 / 显著磨损。**外貌原文取自资产 `appearance`/`styling`/`description`/`prompt`/`location` 字段转写英文，不得省略、不得另编**
   - **🔴 小特征与手持物（官方症状表口径，2026-10-13 新增、待我们成片验证）**：① 疤 / 痣 / 耳钉 / 雀斑这类小特征**必须按身体部位命名**（如「左眉尾上方一颗小痣」），并在 `subject_definitions` 与 `retention_analysis` **两处都写**；每次出现用**完全一样的话**、左右侧写死 —— **没写出来的特征不会出现**，写得含糊它会跑到另一边或来回飘。② **角色手里拿的东西，只有「已被提取成道具资产、绑了参考图」时，才能给它写 `<Subject N>` / `<Picture N>`**（否则抬起手是空的）；**没被提取成道具资产的东西（抹布、餐具、手机架等）只许当画面元素用普通名词描述 —— 禁止编号、禁止写 `<Subject N>` / `<Picture N>`**，不许为了满足本条自己造一个主体编号。③ 手指多 / 手部畸形时，用**「手被画框裁掉」**规避。
   - **只用于定义主体、不当帧锚点的图，不要给它独立 `<Picture N>` 行**，只在 `<Subject N>` 定义里引用（官方：*If an image is used only to define a character, scene, costume, or style, do not create a standalone picture entry.*）
   - **🔴 参考图是"多视角板"时，`<Subject N>` 定义必须点明各视角**：
     - **判断依据**：**只看该资产的 `final_prompt` / `prompt`（生图定稿）**，里面写明是多视角板（`三联参考板`/`三视图板`/`四格板`/`character sheet`/`multiple views`/`shown from N angles`）。**明确不看 `description`** —— 那是物品外观描述，不许往里放任何排版/布局信息。**没写明就按单视角处理，不许自己猜**。
     - **为什么必须点明**：板里同时出现**正面和背面**时，不点明 = 模型把它们当成**几个不同的东西** → 道具直接复制成两张。
     - **写法（道具三视图板）**：`<Subject 3> is the registration form shown from three angles in <Picture 3>: a top-down view of its printed front, a three-quarter view of the same sheet, and its blank back — one single sheet seen three ways, not two or three separate forms.`
     - **角色四格板可不写四格**（模型天然理解人的正侧背），但**道具、以及任何带正反面的物体必须写**。
     - **`retention_analysis` 同步**：末尾加 `stays identical from every angle shown in <Picture 3>; one single sheet, never duplicated.`
   - **鞋写 `cloth shoes`（布鞋），禁写 `liberation shoes`**——直译词会被模型渲染成奇怪的靴子
   - **道具必须至少有一个"能看清全貌"的镜头，但靠机位不靠角色举**：
     - **为什么需要**：如果 `<Subject N>` 全程只是"被攥在手里 / 被折起来 / 塞进口袋"，画面里没有可锁定的载体，模型会脑补 → 道具必丢。
     - **🔴 怎么给：禁止写 `facing the camera` / `toward the camera` / `presented to the viewer`** —— 这些词会让模型把道具/肢体**正对观众展示**，成片就是"角色举着道具给观众看"，非常出戏。
     - **🔴🔴 同时禁止"俯拍 + 平摊"这个组合**：`settles high above them, looking down at the form lying open in her palms` 这种写法，**镜头在正上方 + 纸平摊在掌心 = 纸面正对镜头**，而且从镜头看纸顶的文字是**上下颠倒**的 —— 成片就是"角色倒着拿给观众看"。**俯拍不是解法，是新坑。**
     - **✅ 正确姿势（三条同时满足）**：
       ① **机位取侧向/斜上方，不要正上方**：`the camera at a low three-quarter angle beside her hands`、`over her shoulder, from her side`
       ② **道具的印刷面朝向角色自己，背对镜头**：`the printed side turned toward her, away from the lens`、`the text facing her, the blank back toward the camera`
       ③ **道具要有透视角度，不许平摊正对**：`the form held at an angle in her hands`，禁止 `lying flat` / `lying open` / `flat against her palms`
     - **🔴 道具数量必须显式锁死（防止复制成两张）**：正文里至少写一次 `a single sheet, exactly one form in her hands, never duplicated`；`retention_analysis` 里加 `only one form, never duplicated`。**只在 subject_definitions 写 `single` 不够**——2026-10-09 实测：定义里写了 `a single white paper slip`，成片后半段照样变成两张上下压着（`lying open` 被画成摊开的多张）
     - **🔴 不许自己加镜头**：剧本 description 里没写的道具镜头，一个都不许补。
     - **反例（全部禁用）**：`the form lying flat and fully visible facing the camera` ❌ / `settles high above them, looking down at the form lying open in her palms` ❌
     - **正例**：`the camera at a low three-quarter angle beside her hands, the printed side of the single form turned toward her and away from the lens, held at an angle, her gaze down on the paper` ✅
     - **🔴🔴 单视角正面参考图 + "背对镜头" = H3 会选参考图**：道具参考图大多是**正面单视角（字朝上）**，`subject_definitions` 会从图里读到"有文字"这个特征；正文若只写 `the printed side away from the lens` 这类**单薄否定**，H3 **优先照参考图把正面画出来**（实测 sb302 Shot 2：正文写了 3 遍"背对镜头"，成片仍把印字面转向观众、还自己按了一下翻回去）。
     - **✅ 写法：把"只见背面"提升为 `<Subject N>` 定义里的固有属性，正文写"镜头看到的是什么"（正面可观测，不用否定句）**：
       - `subject_definitions` 里加一句：`in this video it is seen only as its blank opaque back, the printed side pressed against <Subject N>'s palm and hidden from the lens`
       - 正文每一拍写镜头所见：`the camera sees only the blank opaque back of the form, the printed side pressed against her palm, out of view`
       - **禁止**只靠 `never` / `away from` 这类否定当锁 —— 必须写清**镜头里实际是什么**（社区实测：可观测的正面描述比反复否定有效）
     - **🔴 既然整片只见背面，背面透字就是致命穿帮**：`subject_definitions` 里必须**同时**写死"空白不透光的纸背"（`opaque` + `blank back` + `never showing the front's text, table lines or seal through`）；正文每一拍写"镜头所见"时，`back` 前面必须带 **`opaque`**（写 `the blank opaque back`，**不能只写 `blank`**）—— 镜头全程对着背面时，纸一透光，正面的字/表格线/印章就直接穿帮。
2. **`summary`** — 一段英文，**以方括号任务类型开头**；本管线统一用 `[reference generation]`（有参考图但不以某图为首帧/关键帧、也不是编辑或续拍源视频时）。官方类型表：`keyframe completion` / `reference generation` / `video editing` / `video continuation` / `audio reuse` / `audio reference`，多关系用 ` + `
3. **`retention_analysis`** — 每个标签一行，关系词只能用 `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`

   - **🔴🔴 必须逐个覆盖 `subject_definitions` 的每个 `<Subject N>`（2026-10-14 立，实测 sb432 道具整片没参考）**：参考图和身份卡都已按编号接好，**retention 才是模型"保不保这个主体"的唯一声明** —— 漏掉的主体（尤其道具）在成片里**完全不参考参考图**。定义里有几个 `<Subject N>`，retention 就必须**一条不漏、一条不多**、编号严格对应。**最容易踩的坑**：重新生成会把上一版提示词的 retention 整段继承下来，而主体编号因为新加了角色/道具而变了 → 旧编号错位（实测 sb432：retention 的 `<Subject 2>` 写的是"报告纸"、`<Subject 3>` 写的是"她的脸"，道具 `<Subject 5>` 一条都没有）。保存前数一遍：retention 的 `<Subject N>` 集合 == 定义的集合。
   - `<Audio N>` 用 `reference`：
   - **🔴🔴 保留段只写「出场 + 颜色 + 数量」，绝不复述外观（2026-10-16 立）**：这一行要写清衣物具体名词（外套 / 内搭 / 下装 / 鞋，来自卡面 `styling`）—— 但**不许**再复述发型、脸、眼睛、肤色、痣、配饰或道具表面：那些只写在 `subject_definitions` 里。复述是这一段冲破 760 配额的主因，也是整条压不回 6200 的元凶（实测同分镜：复述版 860~1346 字符 vs 不复述 640~760）。
   - **本段严禁出现 `(S1)` 这类说话人编号**（官方：*Do not write `(Sx)` in `retention_analysis`.*）
4. **`detailed_description`** — 正文
   - **`[Shot 1]` 不加时间戳**，后续镜头 `[Shot 2] At 00:06.000, ...`
   - **🔴 切镜必须用官方动词**：切镜写成 `the camera cuts to` / `the shot cuts to` / `the shot transitions to` / `the shot changes to` / `the shot switches to`，**写在该镜的句子里** —— 如 `[Shot 2] At 00:03.500, the camera cuts to an extreme close-up of ...`。**不许只写 `[Shot 2] At 00:02.000, extreme close-up of ...` 而不带动词** —— 没动词 H3 可能读成**同一镜头的延续**而不是切镜。cross-dissolve / fade / wipe 只在明确需要时用。
   - **🔴🔴 镜头怎么写**：
     - **① 景别用标准词**：`wide shot` / `wide establishing shot` / `medium shot` / `medium close-up` / `close-up` / `extreme close-up` / `over-the-shoulder` / `POV shot` / `low angle` / `high angle`。**不要自造说法** —— H3 就是在这些固定英文词上训练的。
     - **② 每镜只给一个主要机位**（one main camera behaviour per shot）：一个 `[Shot N]` 里**只定一个景别/机位**，不要在同一拍里既写 `wide shot` 又写 `extreme close-up`。
     - **③ 禁止堆矛盾指令**：`wide shot, extreme close-up, pan left, and static camera` 这种堆叠会逼模型在两套互斥指令间自行仲裁，出来是乱切或干脆不动。**一个镜头要么切、要么运镜，只能选一种。**
     - **④ 镜头运动写三要素（官方原文）**：**motion type**（Zoom In/Out、Push In/Pull Out、Pan、Truck、Tilt、Pedestal、Arc、Tracking、Static、Shake、POV、Roll）＋ **amplitude**（small/large）＋ **speed**（slow/fast），**写成一个自然的英文动作句**，**禁止**把标签堆在句尾。
       - ✅ `The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.`
       - ❌ `..., push in, small amplitude, slow speed.`
     - **⑤ framing 变化要连贯**：同一镜内景别推进要写出**中间过程**，让镜头真的"移动"，而不是把主体突然缩小/放大。✅ `close portrait → chest-up frame → full-body view → wide view`；❌ 直接从 `close-up` 跳到 `wide shot`。
     - **🔴🔴 每个拍点 = 硬切点：只有真换了「景别 / 机位 / 对象」三者之一，才起新拍**。同一机位同一景别的连续运镜（继续横移、缓慢推近、继续跟拍），以及"静止 → 横移/推近"这类只是**运镜状态**变了的情况，**必须写在同一个拍里**；拆开就会在拍点硬切，成片表现是"忽然闪一下"。写 `continues without a cut` 这句话**没用**（实测写明"不切"照样硬切）。
     - **🔴 拍首一律不许出现 `the same …`（不论后面接什么词 —— 写 `the same close camera pushes in` 也算违规）或任何「没变 / 继续」的说法**（出现即说明这拍不该起 —— 把它的运镜接到上一拍句尾）：`the same … framing holds` / `the same framing continues` / `without a cut` / `continues without a cut`；也**不许出现 cut 动词却不换画面**（`cuts to the same wide framing` / `cuts back to the same shot`）—— cut 动词只在真的换了景别/机位/对象时才用。
**🔴 正文里禁止引用 `[Shot N]`（拍头本身除外）**：`retention_analysis` 的「出现在哪些镜头」**中文工作版用中文写**（每个镜头 / 只在开场镜头 / 只在画外），**英文版必须翻成英文**（`(appears in every shot)` / `(appears in shots 2 and 3 only; the opening shot shows only the table and grill)` / `(off-screen only)`）—— **不许把中文标注抄进英文版**；两种版本都不许写 `(appears in [Shot 1], [Shot 2])` —— 那会让 App 的拍数校验把引用也数成拍（计数虚高、永远对不上），而且模型重写时会整行删掉。

**🔴 拍数必须严格等于分镜 description 里【镜头N】的数量（硬规则）**：**有几个【镜头N】就写几拍 —— 2 个镜头写 2 拍、3 个镜头写 3 拍，一个不多、一个不少**。**任何理由都不许增减拍数**：运镜变化（继续推近/继续横移）、安静拍、动作阶段 —— 全都不算。「近景缓推」这种"一个景别＋一个运镜"的镜头**就是一拍**（切到该景别后在同一拍内完成推近）。**🔴 这一条由代码硬校验（2026-10-12 运行时实测）**：英文版数 `[Shot N]` 个数、中文版数 `X-Y秒：` 行数，与该数量不符就**打回重写**（最多 2~3 轮）⇒ **在提示词侧并拍没有出路**（写了也被打回，白跑几轮）。**假切点的真凶在拆解**：相邻【镜头N】若同景别/同机位/同对象（一次连续表演被拆成两段）—— 这种情况**照写足数**（不许并拍）、**绝不用 `the same…`/「继续」兜底**（实测没用还占字数），并在中文工作版末尾加一行 `（提醒：本段第 N 个【镜头N】与上一镜头无景别/机位/对象变化，建议重拆该分镜）`；**根治只能回拆解侧把那两个【镜头N】并成一个，再重新生成**。
     - **🔴🔴 硬切到底是什么（引擎口径 —— 必须这样理解，别再自己解释）**：这份提示词是**按 `[Shot N]` 分段的**。**每一行 `[Shot N] At MM:SS` = 引擎在那个时间点"开一个新镜头"**。引擎**看不见**"你写的第 2 个镜头是不是还是同一个机位" —— 它只看见"第 2 个镜头从 4.0 秒开始" → **它就在那里切一刀**。
       **所以：在文字里写「同一机位继续 / 同一次运镜延续 / 不作硬切 / the same camera continues」完全没有用** —— 那只是镜头**内容**描述，**改不了时间轴结构**，该切还是切（实测：分镜1、分镜4 都这么写过，成片照切）。
       **判据只有一条**：**同一段连续运镜（先静置→再横移、切到近景→继续推近）必须写在同一个 `[Shot N]` 里**；**只要你写了第二个 `[Shot N]`，那里就一定是一刀** —— 无论你正文或注释怎么解释。
     - **若 description 里没有【镜头N】标记**（写成了一整段叙述）：按剧情里真实的动作/视线转折拆 **2-3 拍**。
     - **🔴 新拍开头写「承接态」**（`already lifted her gaze` / 她已经抬起头）：动作当成**上一拍已完成**，只写本拍的新微动，**禁止重演**上一拍已完成的大动作。
     - **🔴 群演/背景群众必须写「差异」**：只写"宾客三三两两举杯交谈"会让模型给所有人套同一套衣服。写清颜色错开（深蓝 / 酒红 / 米白 / 浅灰）、款式/发型/年龄/高矮各异；纯衬景可虚化成剪影色块。英文范式：`the guests wear a mix of colours — deep navy, burgundy, cream and pale grey — with different hairstyles, builds and ages; no uniform crowd, no repeated identical outfits`。
     - **上述几条**在动笔时**一次写到这个标准**（不必事后再回头翻文件、逐拍提问或核对清单）—— 拍结构直接照这个来：✅ `0-7秒：全景机位先静置一秒，随后缓慢向右横移，扫过香槟塔与人群；旁白：「…」`（"先静置、再横移"写在同一条拍里）。**绝不要把同一次运镜切成两个时间段** —— 那就是假切点。
     - **🔴 `description` 里「一个景别名 + 一个运镜」的写法（如「近景缓推」「中景缓推」「全景横移」）= 一拍**：切/起幅到那个景别，**在同一拍里完成那次运镜**。**绝不许拆成「切到近景」＋「继续推近」两拍**（这是分镜4 反复翻车的形态）。
       - ✅ `4-9秒：切到近景…随后机位以极小幅度缓慢向前推近到胸部以上近景…`（切镜与推近写在同一条拍里）
    - **根治仍在参考图**：两个角色的参考图本身辨识度低时，提示词只能缓解——要彻底分开需重做参考图（加独有特征）
     - **⚠️ 但不要照抄坐标**：H3 不是 Veo，`x50 y74` 这类像素坐标对 H3 无效。H3 要的是**文字描述的相对位置**：`centre-frame` / `screen-left looking camera-right` / `behind her` / `at waist height` / `1.5 m from her`。
   - **风格句写在 `[Shot 1]` 之前、单独一两句**（T2VA 写在 Shot1 之后，Ref2VA 写在之前——这是官方差异点）
   - 主体**首次清晰出现时**描述外观特征 + 画面位置 + 当前动作；后续镜头沿用同一 `<Subject N>`，**不重复定义**
   - **说话人只有一种写法**：
         - 除这一句锁嘴句外，那一拍**不要**再写任何嘴部 / 下颌 / 下巴 / 喉结动作（`lips part` / `mouth opens` / `jaw` / `chin dips` / `Adam's apple` 之类）—— 写到哪动到哪。**下巴也算**（2026-10-16 加，实测 sb519）：那一拍的锁嘴句完全合规（点名版），但正文里同时写着 `her chin dips a fraction`（照抄中文描述的「下颌微收」），成片嘴照样在动 —— cfg=1 没有负向分支，只要点到下半张脸就是命令它动。描述里出现「下颌微收」「下巴一沉」时，改写成碰不到下颌线的头/颈动作（如 `her head lowers a fraction`），或直接删掉。
         - description 里若写了对方的「张嘴 / 想解释 / 说话」，**不许照抄**，改写成不含嘴部的动作。
       - 🔴 **目的是"露屏幕内容"的那一拍，镜头里只许有手 + 这个设备（2026-10-16 加，用户报穿帮）**：当这一拍存在的意义是让人看清手机 / 平板 / 立式屏上的内容（一条消息、信息流、成排字形、`screen dominating the composition`）时，画面里**只留手（手臂/手指/拇指）+ 该设备** —— 不写脸、头、眼睛、胸、肩、躯干、腰、脖子、下巴、下颌、头发，也不写第二个主体；设备写成"被握着"（`fingers curled around <Subject N>`），镜头用 extreme close-up，让屏幕占满画面。**不要写成否定句**（`no face in frame`）—— cfg=1 没有负向分支，不写就是没写。**这条只管"屏幕内容拍"**：普通旁白拍照样可以有人脸在画面里（只要嘴不动）。写对的形状（实测）：`Extreme close-up …: a raised arm fills the frame, fingers curled around <Subject 4>, its screen dominating the composition.`；写成事故的形状（实测）：`one hand lifting a phone that throws flat red light upward onto his face …`。
   - **🔴🔴 旁白拍的正文里禁止"演脸"强调词**：景别照正常写（`chest-up close portrait` 没问题、不必改成背影），但**禁止** `frontally` / `her face fully in frame` / `her whole face in frame` / `facing the lens` / `head and face fully visible` / `looks straight at the camera` —— 这些词与紧邻的锁嘴句**直接打架**，H3 优先演脸 → 嘴照动。
   - **🔴🔴 镜头按正常给，不许为了防嘴改镜头**：
     - **画外音拍就用正常镜头** —— 中景、近景、特写、俯拍都行，**按该拍要表达的东西给**（有表情就给脸，有动作就给手，要交代环境就给全景）。**镜头跟着内容走，不跟着"防嘴"走。**
     - **禁止**为了躲口型而把镜头改成：纯背影 / 后脑勺 / 只手不露人 / 空镜 / "下巴以下"这类半张脸。**这些改法会丢掉表情和表演，已被用户否掉**。
     - **本 MV 没有台词**（原曲由 `<Audio 1>` 1:1 复用）：嘴部按正常表演写；唱段要求嘴型跟原曲，间奏段嘴自然闭合。
     - **镜头以 `description` 的【镜头N】为准**：分镜拆解阶段已经定了每一拍拍什么，提示词**照它写** —— 它说"垂眼看纸"就写垂眼看纸，**不许自作主张换成背影**。
   - **`retention_analysis` 里一律不出现 `(Sx)`**（说话人编号只在 `detailed_description` 出现） **同一段里多个说话人必须递增编号（S1/S2/S3）**：旁白者占一个号、在场对白者占另一个号，**绝不许两个说话人都写 `(S1)`**（实测 sb356：旁白与在场对白都写成 `(S1)` → H3 分不清谁在说）。
   - 画面内可见文字保留中文原文
   - 生成类正文 **350–500 英文词**
5. **`overall_soundscape`** — 环境音（英文）；本 MV 没有人声台词，只写环境音与本段原曲的听感（不写歌词）。
6. **`non_diegetic_music`** — 观众才能听到的配乐；无则 `N/A`

**🔴🔴 质量硬规**：

- **① 禁止写成剧情摘要**（官方原话 *Avoid reducing the description to a plot summary or a list of reference relationships*）：每一拍必须写**镜头里看得见的东西**，不许写「他回忆起往事」「两人关系缓和」这类概括；也不许把内容写成"参考关系清单"。
- **② 每拍七要素写全**（官方 `Description detail`）：**构图 / 主体外观与位置 / 环境与光线 / 动作与状态变化 / 运镜 / 当前声音 / 参考在哪一拍生效**。**镜头少 ≠ 可以写短**（官方：*A single shot does not automatically justify a shorter description*）—— 细节按信息量分配到各拍。
- **③ 标签在全部六段里含义一致**（官方：*Once a reference label is assigned, it keeps the same meaning across* 六段）：`<Subject 1>` 在 `subject_definitions` 里指谁，在 `detailed_description` 里就还指谁，**不许中途换指**。
- **④ 不许留未解决的标签**（官方 *unresolved reference labels*）：定义过的 `<Subject N>`/`<Picture N>`/`<Audio N>` 必须在某处用到；**不许**使用没定义的编号。
- **⑤ `summary` 段不许引入新标签**（官方：*Do not introduce new reference labels in this section*）—— 只能用前面已定义的。
- **⑨ 只参考音色/节奏/情感时，禁止把参考音频的原话搬进目标视频**（官方）。
- **⑩ 卡会串味 —— 必须靠 `<Picture N>` 明确指向**（RefMod 作者原话：*identity, clothing, background and composition can still mix*）：每拍都要写清该拍用哪张参考图；**不同角色必须分开存卡**（作者：*Keep different characters in separate files*）；编号**必须**来自 `reference_order`（作者：*`<Subject n>` is not automatically bound to a loader slot*），**不许**按"谁先出场/谁先说话"排。
- **⑪ 别指望靠重复或加强度锁身份**（作者）：视觉强度是 `w·latent + (1−w)·blur(latent)` —— **不是注意力权重、不是身份百分比**；`multiplier`/`copies` 只增成本不加信息。
- **⑫ 高速动作会被抹平变慢**（作者实测：快速手部动作 / 打斗 / 快舞被抹成又慢又软，因为参考被压成少量 latent 帧）—— 分镜应**避免高速动作**；若 `description` 里确有快速动作，提示词**要用文字描述该动作**给模型锚点。

**保存前自检**：官方六段名齐全且顺序对 / **道具表面文字没写内容**（只出现 `the printed side`/载体+动作这类说法，**没有**任何引号里的纸面文字原文） / 每行 `subject_definitions` 都有 `<Picture N>` + `with` 外观 / `retention_analysis` 无 `(Sx)` / **说话人编号递增**（同段多个说话人 S1/S2/S3，不许都写 `(S1)`）/ **首次出声写了稳定声音身份**（年龄/性别/音高/音色/语速/口音，只写 `says` 不合格） / 台词**全句**逐字来自 description（无截断改写，删句已标注）/ 旁白者指定为画面里某个角色且声音卡写成 `<Subject N>'s off-screen narration` / **锁嘴句用官方原句**（锁嘴紧贴在 `<d>` 台词旁、没隔动作描写，且**逐字**是 `while … lips remain completely closed`；搜 `mouth moves` / `nobody is in frame` / `mouth stays shut` / `lips do not move` / `mouth stays still`，命中即改回官方句） / **每处画外音主语都带 `(Sx)`**（搜 `says in an off-screen voiceover`，主语缺 `(Sx)` 即不合格）/ `Same exposure...` 只在风格句出现一次（没每拍复读）/ 正文英文（除 `<d>` 与画面文字）
