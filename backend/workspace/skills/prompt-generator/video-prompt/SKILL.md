---
name: video-prompt
description: 视频提示词规范 — 根据分镜段落内容生成按时间分段、段内可切镜的视频生成提示词
---

# 视频提示词（分镜段落 → video_prompt）

根据单个分镜段落的 description（含【镜头N】子镜头结构与台词/旁白）/ atmosphere / duration，生成驱动 AI 视频生成的 `video_prompt`。**一个分镜段落 = 一段 8-10 秒的视频，内部允许切镜**：段与段之间可以是不同镜头（换景别/角度/对象），用硬切衔接；但**全程不跨场景**、不闪回。

> **2026-10-09 起：同批产出两份（必读）**
> `video_prompt`（中文工作版，界面显示/编辑）+ `video_prompt_en`（英文发送版，视频生成实际发送）。
> 英文版规则见本文件末尾「英文发送版（H3 官方 Ref2VA 六段 + 前置 CAST/BLOCKING）」节；中文版规则就是下面全部既有内容。
> 保存时必须同时传 `storyboard_id` / `video_prompt` / `video_prompt_en` 三个键。

## 格式

`video_prompt` 的**第一行是信息头**：先介绍这条视频有哪些人物和场景，然后再接时间分段。人物、场景一律用 @ 引用（生成时会替换为对应参考图片标记，让视频模型先对上"谁"和"在哪"）。

```
出场人物：@小明、@小红；场景：@咖啡厅。
0-3秒：@咖啡厅，近景固定镜头，@小明低头看手机，手指反复敲桌面，表情焦虑。
3-6秒：切到门口全景，门铃响，@小红推门走入，带进一阵冷风。
6-9秒：切回中景，@小红微笑着走向小明坐下，小明说：「你终于来了。」
```

信息头规则：
- 只列该分镜段落实际出场的人物和绑定的场景，不要列没出场的
- 有明显道具出场时可在信息头追加（如 `；道具：@信件`）
- 信息头独立一行，以句号结尾，之后是时间分段

按 3 秒为一段，每段单独一行、用换行分隔，时间范围连续衔接（无重叠、无空缺）。

## 与分镜描述的映射

`description` 是 video_prompt 的唯一内容来源（画面、动作、台词、旁白都在其中），转换规则：

- `description` 的每个 `【镜头N】` 映射为 **1-2 个连续的 3 秒段**，顺序一致、不遗漏、不合并、不新增子镜头
- 台词/旁白从对应 `【镜头N】` 内的「角色名说：「…」」「旁白：…」提取，分配到该子镜头映射的段；**不要创作 description 之外的新台词**
- 画面动作以 `description` 为准；`atmosphere` 只用于补各段的光线、色调与氛围描写

## 段内结构

每一段按此顺序组织内容（可省略无内容的项，但动作/画面必须有）：

**时间范围 ＋ 场景@引用 ＋ 景别/运镜 ＋ 角色@引用＋主体动作·表情 ＋ 对白/旁白 ＋ 氛围光线**

- **第一段必须建立空间**：场景 + 机位 + 角色的位置与状态，让观众一眼知道在哪、看谁
- **切镜**：切镜后的段开头用"切到/切回"等衔接词，并重新交代景别与主体；切镜点应对齐分镜 `description` 中的 `【镜头N】` 结构
- **景别/运镜**：每段一个镜头状态（近景/中景/全景/特写；固定/推/拉/摇/跟）；单个子镜头内运镜连续，切镜后可更换运镜方式
- **动作**：每段一个主动作，动词具体可见（走、转身、抬头、攥紧、停顿）
- **情绪全部转为可见描写**：不要"他很伤心/气氛紧张"这类抽象词，写成"他低下头、手指攥紧杯沿、呼吸变重"
- **对白/旁白**：写「角色名说：「台词」」，旁白写「旁白：内容」；3 秒念不完的长台词拆到多段；**无对白的拍也必须显式写「本段无任何人声，只有……环境音」**（只写"机器持续轰鸣"不够——模型会以为你漏写了人声，自己补说话声）
- **人称与光线用语只许写克制的量级**：光线一律用"冷光/冷调侧光/明暗柔和/稍暗/光线一致"这类词，**禁用"强烈对比、骤然变亮、刺眼、明暗分明、光线突变、忽明忽暗"**——模型把这类词直接当打光指令，整段亮度会跳，续拍链接缝处必现忽明忽暗；要表达明暗层次只能写"稍暗""渐入暗部"

## 引用规则

- `@场景名` — 场景引用，名字必须与场景列表中的地点完全一致
- `@角色名` — 角色引用，名字必须与角色列表中的名字完全一致
- `@道具名` — 道具引用，名字必须与道具列表中的名字完全一致；道具在画面中明显可见、被使用或特写时引用
- 生成时会自动把 `@名字` 替换为对应参考图片标记（如 `@小明` → `@图片1小明`），因此名字必须精确匹配，不要缩写或加额外符号
- **每段至少一个 @ 引用锚定画面**；角色出场的段必须 @ 该角色；只引用该分镜段落已绑定的场景/角色/道具
- **首行必须写出场 header**：`出场人物：@A、@B；场景：@C；道具：@D`（无某类省略该段），header 内顺序必须与参考图顺序一致（中转按序绑定身份）
- **正文每个出场实体（含只有台词/画外音、没露脸的人物）至少出现一次 @名**，否则该实体在本段不定妆不定脸
- **多角色同段必须分别声明**：header 里每个角色各写各的 `@名`，正文里每个出场角色也至少出现一次 `@名`——**只写名字，不写外貌**。中转按 `@名` 生成 `<Subject N>` 身份声明，参考图与卡才不会互相污染；不分别声明，模型会把几张脸**平均成一张新脸**
- **角色参考板要逐镜点名用哪一格**（角色首次出现写一次即可）：`@林巧（参照脸部特写格）`。参考板是**四格**（从左到右：脸部特写 / 正面全身 / 90度左侧面全身 / 背面全身，三视图**都有头**），格子名**逐字照抄**：`脸部特写格` / `正面全身格` / `90度左侧面全身格` / `背面全身格`（近景特写取脸部特写格，全身中景取正面全身格）。**禁止**造格（如"手部格"）、**禁止**一次点两格、禁止改格子名
- **中转会按 header 自动拼官方 R2V 骨架**：`subject_definitions`（`<Subject N>` 定义"是谁"、`<Picture N>` 对应第 N 张参考图、`mod_N` 对应第 N 张身份卡——**四者同号**）、`retention_analysis: fully_preserved`、`detailed_description`，并把正文里的 `@名` 换成 `<Subject N>`——所以 **header 必须写全、顺序必须与参考图顺序一致**，否则身份声明对错图

## 正文瘦身（2026-10-08 立规 · 必守）

**身份与外观不在正文里写**，正文只写"演什么、怎么拍"。

三重锁定已经负责"长什么样"，正文再复述一遍纯属白烧字数、还容易和它们打架：

1. **身份卡**：`<Subject N>` ↔ `mod_N` 卡槽（身份、发型、服装从角色板抽出来的卡）
2. **参考图**：`<Picture N>`
3. **后端机械注入**：提交时自动把资产 `styling`/`appearance` 原文、场景 `prompt`/`lighting` 原文整串钉进提示词末尾（`verbatim_lock`）

正文该写的：

- 场景环境与光线（可引用场景资产要点，不要另写一套）
- 机位、景别、运动；人物动作与表演；情节推进；台词/旁白；音景
- 曝光一致性：**只在风格句里写一次**（`[Shot 1]` 之前那一两句带上 consistent exposure and white balance throughout, no new light source），**禁止每拍复读** `same exposure...`（白烧 token、稀释注意力）；切镜

正文不该写的：

- **任何角色的外貌/妆造**：脸型、发型、五官、身材、服装、配饰、新旧磨损——一律不写
- **`styling`/`appearance` 原文整串**：不要搬进正文
- **重复复述**：同一角色在本段第二次出现时**只写 `@名`**，不再复述任何特征

**唯一例外——本段发生的外观变化**：衣服湿透、脸上沾油、换装、受伤、戴面具等"与卡不一致的状态"**必须写进正文**（卡与锁块只管不变的基准，变化只能靠正文表达）；变化一旦发生，后续各段沿用变化后的状态。

**收尾自检（必须做）**：保存前扫一遍正文，**不应出现任何角色的外貌/妆造原文串**（出现即没瘦身，删掉）；再确认每个出场角色的 `@名` 都在、header 顺序与参考图顺序一致。

## 纸张/证件类道具（视频里出现时）

- **🔴 纸面文字内容一律不写**（2026-10-09 定，取代旧规则「纸面文字要带全」）：道具上具体印了什么字，**完全由参考图决定**——道具的 `final_prompt` 是生图定稿，参考图上的字已经是定的；提示词再写一遍必然与参考图打架，而且实测必错：2026-10-09 报到单，`final_prompt` 写「单位：红星机械厂二车间」「1979年3月17日」且只有 2 行正文，提示词却写成「第二车间」「三月十七日」、还凭空多出一行「钳工学徒」（写成 3 行）。
- **正确写法**：只写载体与动作、**不写内容**——`her gaze down on the form`、`the printed side turned toward her and away from the lens`、`the printed side of the single form`（只提"印刷面"，**绝不提印了什么字**）。旧例 `纸面竖排写着"报到证"三个大字；正文三行分别写着"林巧""红星机械厂""二车间钳工"` **已作废，禁止再写**。
- **背面必须是空白纸背**（这条保留——它不是文字内容，是防穿帮）：写明「纸张不透光，背面是空白纸背，不透出正面任何字迹、表格线与印章」；纸张翻面、转动、背面朝镜头或被举向光时尤其要写——否则模型会把正面字迹透到背面（实测穿帮：报到单从背面也能看到内容）
- 禁写「纸张很薄／半透明／能透出」

## 提交前自检：逐拍过这三条（硬性，任一不过就改到过）

写完正文后，**按每个时间段挨个过一遍**——是一拍一拍过，不是整段过一遍：

- [ ] **每一拍都要有声音声明**：要么有台词/旁白（`旁白：…` / `X说：「…」`），要么写死「本段无任何人声，只有……环境音」。**两个都没有的那一拍 = 模型自由发挥**
- [ ] **段首 2 秒 + 段尾 2 秒内没有台词/旁白**；续拍段（第 2 段起）**第一拍只写 hold**（承接上段构图 + 呼吸/重心/视线微动作），台词从第二拍起
- [ ] **台词总字数 ≤ (段长秒数 − 4) × 4.5**（10 秒段 ≤27 字，建议 ≤25）

**实测反例（别再这么写）**：

```
0-3秒：…手部特写…旁白：「这双手，跟着我回来了。」
3-6秒：…本段无任何人声，只有远处风声与车间嗡鸣…
6-9秒：切中景，…攥紧拳头…                ← 这一拍没有任何声音声明 → 成片在这里乱说话（还溢到下一拍）
9-10秒：…本段无任何人声，只剩脚步声…
```

**正解**：把旁白挪出段首 2 秒（0-2 秒只写画面 + 「本段无任何人声」→ 旁白放 2-5 秒），并给 6-9 秒补上「本段无任何人声，只有骨节轻响与远处车间嗡鸣」——**每一拍都有声明**。

## 续拍链承接（禁止手写，runner 自动加）

链上第 2 段起，**runner 会自动前置 airlock 头**（hold 住上段结尾构图约 2 秒、无台词、给呼吸/重心/视线微动作，然后切到新构图）。所以正文这边：

- **一律不写承接句**：不写"承接上段结尾构图""接上段""延续上一镜"这类话，也不要拿上段尾字/尾词当第一句——写了就和自动前置的 airlock 重复
- **第一个时间段必须承接上段结尾的构图**（同机位、同景别、同人数与相对位置），只给呼吸/重心/视线微动；**换机位、换景别、增减人物一律放到第二个时间段之后**——这是"并集"警告的正解
- **同一段里不要既描述旧构图又描述新构图**：模型把矛盾渲染成**并集**（上段结尾是 A 的特写、本段写"B 和 C 的双人镜"，出来会是三个人）。换场景/换主体时，第一个时间段留给 airlock 的 hold（旧构图、不写台词），新场景新构图从第二个时间段起写
- **hold 段没有台词**：台词写在本段切到新构图之后
- **安静处必须写死"无任何人声"**：没有台词/旁白的节拍必须写明"**本段无任何人声，只有……环境音**"，否则 H3 会自己脑补说话声（官方指南：安静的镜头冒出没要求的人声 → 把音频字段写明再重跑；提交时中转已自动补 overall_soundscape，正文也要写死）
- **台词窗（每一段都适用，含单段重拍）**：**段首 2 秒 + 段尾 2 秒一律不写台词/旁白**。链会把上一段结尾的音频钉进本段开头：上段结尾若是"说到一半的话"，本段开头又写新台词，两句会打架 → 听感就是"乱说"（实测确认；而"读数字/打鼓"这类持续性声音的续接不会乱，因为下段在继续同一件事）。**10 秒段的台词窗只有中间约 6 秒**
- **台词预算（硬性数字）**：每段台词总字数 ≤ **(段长秒数 − 4) × 4.5**（10 秒段 ≈ 27 字，**建议 ≤25 字**）。实测语速 5~6 字/秒——seg1 写了 40 字旁白，音频说到 9.9 秒占满段尾。超预算就删信息或改用画面表达；"最后一格不写台词"不算数（前面那句会念过结尾）
- 交付时头部约 0.9 秒会被剪掉，节拍随之整体前移；时间码按采样时间写即可，不用手动偏移（知道有这个偏移量就行）

## 时间轴规则

- 段数 = 分镜段落 duration ÷ 3 秒（向上取整），各段时间范围相加必须等于段落总时长
- 内容节奏：第一段建立 → 中段推进动作/冲突 → 末段落到结果或情绪点

## 禁止事项

- 跨场景切换、闪回（一个段落只发生在一个场景内）
- 引用列表之外的场景/角色名
- 抽象心理描写、文学化比喻（模型只认可见画面）
- 语言与会话语言指令不符

## 保存

调用 `update_storyboard` 仅更新该分镜段落的 `video_prompt` 字段，不要改动其他字段，不要重新拆分整集。

## 英文发送版（H3 官方 Ref2VA 六段 + 前置 CAST/BLOCKING）— 2026-10-09 立规

`video_prompt_en` 是**真正发给视频模型的那一份**，规则来源 = MiniMax 官方 H3 提示词写作指南（Ref2VA 全参考模式改写输出格式）。**除对话、歌词与画面内可见文字外全部英文。**

**🔴 长度预算（硬性，2026-10-09 立）：`video_prompt_en` 全文 ≤ 6200 字符**（写完用 `len()` 数一遍再保存）。
MiniMax H3 的 prompt 上限是 **7000 字符，官方 hard limit、不可放宽**（RunDiffusion / AtlasCloud / MiniMax 官方 GitHub 口径一致），后端发送时还会在前面拼一段 photorealistic 风格头，必须留余量。
**超限直接被拒、整段生成不出来**（2026-10-09 实测：sb147 写到 7608 字符 → 拼接后 8403 → 报「提示词超长：MiniMax H3 上限 7000 字符，当前 8403」）。

各段配额（按此分配，写完逐段数）：
- `CAST:` ≤ 220
- `BLOCKING:` ≤ 420
- `subject_definitions` ≤ 1850（多角色段也别超）
- `summary` ≤ 380（官方只要求 one short English paragraph）
- `retention_analysis` ≤ 820
- `detailed_description` ≤ 2050（官方 350–500 词，取下限附近）
- `overall_soundscape` ≤ 330
- `non_diegetic_music` ≤ 50
- 换行与标点余量 ≈ 80 → **合计 ≤ 6200**

**超了就砍，顺序**：① `summary` 冗余从句 ② `soundscape` 与正文重复的音效 ③ `BLOCKING` 中与正文重复的描述 ④ `subject_definitions` 的外观修饰词。
**绝不许砍**：`<d>` 台词、`retention_analysis` 每条 `fully_preserved`、`<Picture N>` 与 `with` 外观、`CAST` 数量锁、`BLOCKING` 朝向与 180 度轴线。

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
   - 官方示例原文：`<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.`
   - **🔴 `<Picture N>` 编号 = 参考图实际顺序，不是出场顺序**：本管线参考图顺序固定为 **场景第 1 张 → 角色第 2..N 张 → 道具最后**（与 `@图片N` 注入顺序、卡槽 `mod_N` 三者同号）。3 张图时：`<Picture 1>` = 场景、`<Picture 2>` = 林巧、`<Picture 3>` = 报到单。**不许按"谁先出场就从 1 编起"**——编号错位会让 `<Subject N>` 对上错误的 `mod_N` 卡（场景卡被当成身份卡 = 脸必漂）
   - **场景也必须有 `<Subject N>`**：`<Subject 1> is the scene in <Picture 1>, with ...`。漏掉场景 = 场景不吃卡、不吃参考图
   - **`with` 后面把可见外观逐个点名**：脸型 / 发型（长度+颜色）/ 服装款式颜色 / 配饰 / 显著磨损。**外貌原文取自资产 `appearance`/`styling`/`description`/`prompt`/`location` 字段转写英文，不得省略、不得另编**
   - **只用于定义主体、不当帧锚点的图，不要给它独立 `<Picture N>` 行**，只在 `<Subject N>` 定义里引用（官方：*If an image is used only to define a character, scene, costume, or style, do not create a standalone picture entry.*）
   - **🔴 参考图是"多视角板"时，`<Subject N>` 定义必须点明各视角（2026-10-09 立）**：
     - **判断依据**：**只看该资产的 `final_prompt` / `prompt`（生图定稿）**，里面写明是多视角板（`三联参考板`/`三视图板`/`四格板`/`character sheet`/`multiple views`/`shown from N angles`）。**明确不看 `description`** —— 那是物品外观描述，不许往里放任何排版/布局信息（2026-10-09 踩过：往 description 塞了「左大格/右上小格」，污染外观字段，已回滚）。**没写明就按单视角处理，不许自己猜**。
     - **为什么必须点明**：板里同时出现**正面和背面**时，不点明 = 模型把它们当成**几个不同的东西** → 道具直接复制成两张（2026-10-09 实测根因之一）。
     - **写法（道具三视图板）**：`<Subject 3> is the registration form shown from three angles in <Picture 3>: a top-down view of its printed front, a three-quarter view of the same sheet, and its blank back — one single sheet seen three ways, not two or three separate forms.`
     - **角色四格板可不写四格**（模型天然理解人的正侧背），但**道具、以及任何带正反面的物体必须写**。
     - **`retention_analysis` 同步**：末尾加 `stays identical from every angle shown in <Picture 3>; one single sheet, never duplicated.`
   - **鞋写 `cloth shoes`（布鞋），禁写 `liberation shoes`**——直译词会被模型渲染成奇怪的靴子
   - **道具必须至少有一个"能看清全貌"的镜头，但靠机位不靠角色举（2026-10-09 三轮实测定稿）**：
     - **为什么需要**：如果 `<Subject N>` 全程只是"被攥在手里 / 被折起来 / 塞进口袋"，画面里没有可锁定的载体，模型会脑补 → 道具必丢。
     - **🔴 怎么给：禁止写 `facing the camera` / `toward the camera` / `presented to the viewer`** —— 这些词会让模型把道具/肢体**正对观众展示**，成片就是"角色举着道具给观众看"，非常出戏（2026-10-09 实测复现，用户明确否掉）。
     - **🔴🔴 同时禁止"俯拍 + 平摊"这个组合（2026-10-09 第三轮实测，几何必然）**：`settles high above them, looking down at the form lying open in her palms` 这种写法，**镜头在正上方 + 纸平摊在掌心 = 纸面正对镜头**，而且从镜头看纸顶的文字是**上下颠倒**的 —— 成片就是"角色倒着拿给观众看"。**俯拍不是解法，是新坑。**
     - **✅ 正确姿势（三条同时满足）**：
       ① **机位取侧向/斜上方，不要正上方**：`the camera at a low three-quarter angle beside her hands`、`over her shoulder, from her side`
       ② **道具的印刷面朝向角色自己，背对镜头**：`the printed side turned toward her, away from the lens`、`the text facing her, the blank back toward the camera`
       ③ **道具要有透视角度，不许平摊正对**：`the form held at an angle in her hands`，禁止 `lying flat` / `lying open` / `flat against her palms`
     - **🔴 道具数量必须显式锁死（防止复制成两张）**：正文里至少写一次 `a single sheet, exactly one form in her hands, never duplicated`；`retention_analysis` 里加 `only one form, never duplicated`。**只在 subject_definitions 写 `single` 不够**——2026-10-09 实测：定义里写了 `a single white paper slip`，成片后半段照样变成两张上下压着（`lying open` 被画成摊开的多张）
     - **🔴 不许自己加镜头**：剧本 description 里没写的道具镜头，一个都不许补（2026-10-09 实测：146 镜头1 剧本只有掌心，LLM 自己加了报到单平铺朝镜头）。
     - **反例（全部禁用）**：`the form lying flat and fully visible facing the camera` ❌ / `settles high above them, looking down at the form lying open in her palms` ❌
     - **正例**：`the camera at a low three-quarter angle beside her hands, the printed side of the single form turned toward her and away from the lens, held at an angle, her gaze down on the paper` ✅
   - 有声音卡时加一行 `<Audio 1>`。**声音卡是音色参考；画外音没有单独的参考音源，所以旁白必须指定画面里某个角色当旁白者**（一般就是主角自己）：
     - 本段**有旁白/画外音** → `<Audio 1> is the voice-timbre reference for <Subject N>'s off-screen narration (S1); use it only as a timbre reference and do not reproduce its words.`（绑的是**该角色的旁白音色**，不是"画面里正在说话的嘴"）
     - 本段**全是在场对白、没有旁白** → `<Audio 1> is the voice-timbre reference for <Subject N> (S1).`
2. **`summary`** — 一段英文，**以方括号任务类型开头**；本管线统一用 `[reference generation]`（有参考图但不以某图为首帧/关键帧、也不是编辑或续拍源视频时）。官方类型表：`keyframe completion` / `reference generation` / `video editing` / `video continuation` / `audio reuse` / `audio reference`，多关系用 ` + `
3. **`retention_analysis`** — 每个标签一行，关系词只能用 `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`
   - `<Audio N>` 用 `reference`：
     - 有旁白时：`<Audio 1>: reference - its vocal timbre guides <Subject N>'s off-screen narration without copying the original signal.`
     - 全是在场对白时：`<Audio 1>: reference - its vocal timbre guides the dialogue delivery of <Subject N> without copying the original signal.`
   - **本段严禁出现 `(S1)` 这类说话人编号**（官方：*Do not write `(Sx)` in `retention_analysis`.*）
4. **`detailed_description`** — 正文
   - **`[Shot 1]` 不加时间戳**，后续镜头 `[Shot 2] At 00:06.000, ...`
   - **🔴 CAST + BLOCKING 段（2026-10-09 立；同日按用户拍板，从 `detailed_description` 内部提升为顶层段）**：**放在整个提示词最前面，即 `subject_definitions` 之前**，作为独立一段排在官方六段之上。**官方六段的字段名与顺序原样不动**（`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`），CAST/BLOCKING 只是加在它们之前，不改名、不挤占、不打乱。**旧规则「不许新增顶层段名」已作废（2026-10-09）**：那句是当时自加的绝对措辞，官方只要求保留字段名与顺序（官方 skill 原文 *Preserve the exact field names, section order, labels, and timing notation*），从没下过禁止令——官方本就要求每拍写清 position / subject placement，只是没给这类内容段名。**⚠️ 未实测风险（生成后必须核）**：H3 解析器若严格按官方六段切段，最前多出的这段可能被忽略或报错，首版生成后要贴回来验 H3 有没有吃进去。
     - **CAST（治多脸 / 道具复制成两张）**：点名本段有几个人、几件道具，然后写死数量与"不许重复"：
       `CAST: exactly one young woman, one registration form, one factory gate; no twins, no duplicated figures, no extra people, no second copy of the form, no duplicated wardrobe.`
       **这比在 `subject_definitions` 写 `single` 强得多**——2026-10-09 实测：定义里写了 `a single white paper slip`，成片后半段照样变成两张上下压着。
     - **BLOCKING（治站位漂移 / 朝向乱 / 道具倒持）**：写死谁在哪、道具朝哪、镜头在哪一侧、**轴线在哪**：
       `BLOCKING: the woman stands centre-frame, the factory gate behind her; the form held in both hands at waist height, its printed side turned toward her and away from the lens. The camera stays on her side of the hands; the 180 axis runs through her hands and is never crossed.`
       **180 度轴线（the 180 axis）是电影百年行规**：机位一旦越过轴线，观众就分不清方位、道具朝向也会反 —— 2026-10-09 实测的"报到单倒着拿给观众看"就是没有轴线约束、每拍机位自由乱选的结果。
     - **参考写法（higgsfield 的成熟示例，逐字结构）**：`BLOCKING: Fire foreground center, x50 y74, blurred. Group in a semicircle beyond it, 1.5 m from flames. Camera stays on one side of the fire; the 180 axis runs through the fire and is never crossed. P3 and P4 stay screen-left looking camera-right.`
     - **⚠️ 但不要照抄坐标**：H3 不是 Veo，`x50 y74` 这类像素坐标对 H3 无效。H3 要的是**文字描述的相对位置**：`centre-frame` / `screen-left looking camera-right` / `behind her` / `at waist height` / `1.5 m from her`。
   - **风格句写在 `[Shot 1]` 之前、单独一两句**（T2VA 写在 Shot1 之后，Ref2VA 写在之前——这是官方差异点）
   - 主体**首次清晰出现时**描述外观特征 + 画面位置 + 当前动作；后续镜头沿用同一 `<Subject N>`，**不重复定义**
   - **说话人只有一种写法**（2026-10-09 立，取代此前所有旧写法）：
     - **在场对白**（该拍人物真在说话）：`<Subject 2> (S1) says, <d>[Chinese] 台词</d>`
     - **旁白/画外音**：`<Subject 2>'s voice-over (S1) speaks off-screen while on screen her lips stay completely closed and her mouth does not move: <d>[Chinese] 台词</d>`
     - **旁白者必须指定为画面里某个角色**（一般就是主角自己）——画外音没有独立参考音源，不指定旁白者 = 模型自己编一个声音
     - **🔴 禁用这两种写法**（都会让模型把说话动作挂到画面里的人身上，导致嘴动/双人）：① `<Subject 2> (S1) says off-screen` ② `A young woman's low restrained voice (S1) speaks off-screen`（嗓音描述式 = 没指定旁白者，2026-10-09 实测复现）
   - **🔴 锁嘴必须与台词同句**（不能隔动作描写）：官方示例原句 `She closes her lips`。锁嘴必须**直接贴在 `<d>` 前或后**，中间不得插入任何动作/画面描写（2026-10-09 实测：锁嘴写在拍子开头、台词在末尾，中间隔了三个动作从句 → 模型照样让嘴动）
   - **🔴🔴 画外音那一拍，画面里不得出现说话人的正脸（硬性，优先级高于以上所有锁嘴写法）**：
     - **为什么**：视频模型有强先验「画面里有人脸 + 有台词 = 这个人在说话」。锁嘴是文字约束，**压不住这个先验**——2026-10-09 实测：锁嘴与台词同句、voice-over 指定角色、声音卡绑旁白音色，三样全做对了，5-9 秒那两拍**照样让她张嘴念出来**。**唯一的解法是不露脸**：没有"谁在说话"的视觉锚点，模型才会当作画外音。
     - **画外音拍只能用这三种镜头**：① **手部特写**（只拍手 + 道具，`extreme close-up of her hands holding the form`）② **背影/过肩**（`from behind, the back of her head`, `over her shoulder`）③ **空镜**（场景或道具单独，`the form lies open on the workbench`）
     - **🔴 禁止**：画外音拍写任何让正脸入画的机位（`close-up of her face` / `high-angle close-up: <Subject 2> lowers her head` 这类**脸可见**的写法）
     - **项目 2026-10-08 就立过这条**（"凡画外音拖尾所覆盖的段落均不得露出人物正脸"），**双语化改造时丢了**，2026-10-09 复现 → 现在补回
   - **`retention_analysis` 里一律不出现 `(Sx)`**（说话人编号只在 `detailed_description` 出现）
   - 台词只写 `<d>[Chinese] 原文</d>`，**中文逐字取自分镜 description，禁止改写或自编**
   - **🔴 台词只许整句删，不许截断或改写（2026-10-09 实测）**：把一句台词砍成两句、或删掉半句，会悄悄吞掉剧情（实测「撞见了张建国」被整段抹掉）。塞不下就**整句删**；删句必须在中文工作版显式标注（如 `（本段未采用：XX句——原因：10秒装不下）`），让用户看得见
   - 画面内可见文字保留中文原文
   - 生成类正文 **350–500 英文词**
5. **`overall_soundscape`** — 环境音（英文）；无台词镜头写死无人声明 `(No human voice in this segment except the dialogue lines explicitly written below; no narration, no humming, no singing.)`
6. **`non_diegetic_music`** — 观众才能听到的配乐；无则 `N/A`

**保存前自检**：`CAST:` 与 `BLOCKING:` 两行在 `subject_definitions` 之前（整篇最前）且内容齐全 / 官方六段名齐全且顺序对 / **道具表面文字没写内容**（只出现 `the printed side`/载体+动作这类说法，**没有**任何引号里的纸面文字原文） / 每行 `subject_definitions` 都有 `<Picture N>` + `with` 外观 / `retention_analysis` 无 `(Sx)` / 台词**全句**逐字来自 description（无截断改写，删句已标注）/ 旁白者指定为画面里某个角色且声音卡写成 `<Subject N>'s off-screen narration` / 锁嘴紧贴在 `<d>` 台词旁（没隔动作描写）/ `Same exposure...` 只在风格句出现一次（没每拍复读）/ 正文英文（除 `<d>` 与画面文字）
