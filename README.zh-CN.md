# HuobaoDrama · 自维护分支

[English Version](README.md)

这是我自维护的 [chatfire-AI/huobao-drama](https://github.com/chatfire-AI/huobao-drama) 分支 —— 一个 AI 短剧生产流水线（剧本 → 资产 → 分镜 → 视频），形态是 Electron 桌面应用 + Nuxt 前端 + TypeScript 后端。

> **这是个人自用分支。** 我自己的改动全部在 **`chain`** 分支上；**`master`** 保持上游原样，方便对照差异。我不追上游更新，也不提供技术支持。
> 应用版本 `desktop 4.0.188` · 最近更新 2026-10-19 · 396 条自己的提交

## 这个分支做了什么

1. **提示词三道防线** —— 规则层（中英模板永远同步改）、落库层（机器闸：语言闸、越界 `<Subject N>` / `<Picture N>` 清理、画外音锁嘴、道具引用闸…）、体检层（单条分镜 + 整集检查，带一键修复）。同一个毛病三层一起治，不靠模型自觉。
2. **续拍链** —— 链 ID 与段号可推导（单段重拍能接上前一段）、自动前置接头（airlock）、runner 与本地中转和界面全部打通。
3. **资产体系** —— RefMod 身份卡（角色 / 场景 / 道具）、换装造型（独立角色行 + 图像编辑保脸）、声音（以 32kHz 源 wav 为产物；换装角色可沿用原角色声音）、软删过滤与删集 / 删剧时的级联清理。
4. **自用工程化** —— 任务栏「真正在渲染」的秒表、批量生成进度绿红分色、本机 macOS 打包路径（ffmpeg / ffprobe 按架构分装、ad-hoc 签名，免装 Rosetta、免「已损坏」弹窗）。

## 更新日志

> 约定：**每次交付一个安装包就打一个 tag**（`v<应用版本>-zdz<N>`），要点加进下面的表。完整历史看 [`compare/master...chain`](https://github.com/zdx52/huobao-drama/compare/master...chain)。

| 日期 | tag | 主要改动 |
| --- | --- | --- |
| 2026-10-19 | `v4.0.188-zdz1` | **修 4.0.187 的黑屏**（点「进入制作」整页空白）。根因：187 删「公共素材库」时按「从 importAsset 到下一个 `}`」切代码块，把紧跟其后的 `promptBusy` / `viewer` / `editRatio` / `textConfigs` / `imageConfigs` / `videoConfigs` 六个 `const` 和 `loadConfigs()` 一起吞了（`const` 没有提升 → 模板一取就爆 → 整页白屏；构建全绿照样白屏，这类错只有真机渲染才看得见）。已按 186 版逐行 diff 复原，确认只剩「公共素材库区块 / 两颗 ☆ / libraryAssets / shareAsset / importAsset」这几处是这一版该删的。另：README 更新日志瘦身，只留最近 5 次。 |
| 2026-10-19 | `v4.0.187-zdz1` | **MV 四项修正（用户逐条反馈）**。① **人物板又带头** —— 根因是我们让模型收尾写「格2/3/4 **一律没有头**」，而规范明写「写『无头』『不要头』这类词，模型照旧会画头」；改成照抄短剧那份能出对的收尾句「整张参考板只有格1 一处面部，**格2格3格4 一律头部被干净地移除**」。**已生成的旧提示词不会自己变，要重新生成提示词再重绘**。② **项目封面改成场景图**（照短剧首页口径：场景图是单幅完整画面适合当封面，人物图是四格参考板不合适），没有场景图才用首字兜底。③ **删掉制作页里没用的「公共素材库」区块和卡上的 ☆**（素材本来就挂在项目级共用，上一级详情页已有素材库）。④ **顶栏「项目」改名「短剧项目」**（英文 Shorts Projects / 日文 ドラマプロジェクト / 韩文 드라마 프로젝트 同步）。 |
| 2026-10-19 | `v4.0.186-zdz1` | **MV 按短剧拆成三层结构 + 修掉三个原有 bug**。① 一页拆三页：`/mv` = 项目列表（照短剧首页 `pages/index.vue`：搜索 + 筛选胶囊 + 封面卡 + 右上角「⋯」菜单），`/mv/series/:id` = 项目详情（照 `drama/detail.vue`：顶部项目名 + 铅笔改名 + 画幅/计数，**主 Tab 两个：MV 列表 / 素材库**；MV 卡照短剧集卡，末尾常驻「新建第 N 支 MV」卡，素材库照短剧素材库：人物横排卡 / 场景竖排卡 / 点卡弹「左图右表单」编辑窗 + 最终提示词），`/mv/:id` = 单支 MV 的制作流程（原来那套四步流程独立成页，返回键回项目详情）。② 后端：新增 `GET /mv/series/:id`（项目 + 歌列表 + 素材库一次返回），列表补 `cover`/`status`；**删项目改为级联**（原来只删项目那一行，歌/素材/分镜全留在库里）；素材的写接口改成按「项目或同系列」判定归属，所以同一项目下 A 歌提取的人物，B 歌能改能删能出图。③ 顺手修掉三个原有 bug：**MV 制作页整页 500**（`watch(() => activeShotId.value, …)` 写在 `const activeShotId` 声明之前 —— Vue 注册 watch 时会立刻跑一次取值函数 ⇒ TDZ，用改动前的原文件在同环境复现确认过）；**全新数据库一启动就崩**（`ALTER TABLE mv_projects ADD COLUMN series_id` 排在 `CREATE TABLE mv_projects` 之前 ⇒ `no such table`）；删项目不级联。验证：临时空库起后端跑通全部接口 + 真浏览器走完「建项目 → 进项目 → 建 MV → 进制作页 → 返回 → 素材库 Tab → 改素材名并查库确认落盘」，`npm run generate` 通过，后端 `tsc` 仍是基线 7 条。 |
| 2026-10-18 | `v4.0.92-zdz1` | **MV 资产生图提示词改成照抄短剧（用户：生成的提示词没有风格、没有中文描述）**。① 规则不再用我自己写的那份简化版，**直接读短剧自己的 skill 文件**（人物 = `prompt-generator/character-prompt`，场景 = `prompt-generator/scene-prompt`，新增 `readSkillFile()` 复用 `skills.ts` 里同一份工作区路径；读不到才回退 MV 自己的指令）。② 生成的提示词结构改成和短剧 final_prompt 一样：**第一段是画风头（原样照抄，不许翻译）+ 之后用中文写名字/样貌/妆造/场景 + skill 规定的构图**（人物=一帧四格横版参考板、纯白底；场景=固定视角前景/中景/后景、画面里不许有人）。③ 出图时不再重复拼风格头（提示词里已含；手写的、不含风格头才补一次）。 |
| 2026-10-18 | `v4.0.91-zdz1` | **MV 编辑弹窗与短剧素材详情弹窗对齐（逐项照抄）**。① 结构照短剧：**顶部标题栏**（小标签「人物/场景」+ 名字 + 右侧状态与关闭）→ 主体左右两栏（**左侧视觉预览**：区块标题「视觉预览」+ 状态徽标 + **固定 16:9 横屏预览框**（原来没有固定比例、看着像竖屏）+ 两格元信息「类型 / 生卡」；**右侧编辑信息**：区块标题「编辑信息」+ 字段区）→ **底部最终提示词面板**（区块标题 + 右侧「生成提示词 / 重新生成」按钮 + 提示词框 112px）→ **底部操作栏**（取消 / 保存修改）。② CSS 数值逐条对齐短剧 `.mat-detail-*`：弹窗宽 `min(1040px, 100vw-56px)`、高 `calc(100vh-56px)`、左右栏 `minmax(280px,380px) / 1fr`（gap 14px）、字段区人物与场景都是**单列**（`grid-template-columns: 1fr`）、字段标签 10px/780、textarea 最小高 164px、元信息小卡 2 列。③ 之前「生成提示词」按钮在底部操作栏、提示词和字段混在一起 —— 现在按短剧放在**最终提示词面板的标题行**。 |

## 快速开始

### 安装现成的包

1. 完全退出应用（⌘Q）。
2. 打开 `.dmg`，把 **HuobaoDrama.app** 拖进 `/Applications`，选「替换」。
3. 如果 macOS 说应用「已损坏」：`xattr -cr /Applications/HuobaoDrama.app`，再打开。

### 自己打包

```bash
# 1）前端（静态产物在 frontend/.output/public）
cd frontend && npm ci && npm run generate

# 2）桌面应用（dmg 在 desktop/release 下）
cd ../desktop && npm ci && npm run dist
```

- 第一次打桌面包会下载 Electron 和 `ffmpeg` / `ffprobe`。若 `scripts/prepare-resources.mjs` 下载失败，可以把同名二进制预置到 `desktop/build/bin-cache/`（比如从已安装应用的 `Contents/Resources/bin/` 里取 `ffprobe`）。
- 末尾的 publish 步骤在本地会报 `Cannot read properties of null (reading 'channel')`，那是 **dmg 生成之后**的报错，忽略即可。
- CI：[`.github/workflows/build-mac.yml`](.github/workflows/build-mac.yml) 在 push 到 `chain` 时触发。**2026-10-15 起本仓的 GitHub Actions 被平台限制** —— 手动触发返回 `422 Actions has been disabled for this repository`，而仓库设置里却显示「已启用」，要恢复得向 GitHub 提工单。

### 第一次使用

在 **设置 → AI 服务** 里配置文本 / 图像 / 视频服务（指向自己的中转或厂商接口），然后新建项目、添加一集。

## 功能

- 剧本导入与分镜拆解，单集时长与镜头规则可配
- 资产提取去重（角色 / 场景 / 道具），同一部剧的各集之间共用
- 角色定妆板 / 场景 / 道具图像生成；可选的 RefMod 身份卡与声音样本
- 双语分镜提示词（中文工作版 + 给视频模型的英文版），规则 / 机器闸 / 体检三层把关
- 跨分镜的续拍链、单段重拍、成片拼接
- 项目设置（名称、类型、简介、视觉风格、画面比例）与四语言界面

## 技术栈

- 前端：Nuxt 3 + Vue 3 + vue-i18n（中 / 英 / 日 / 韩）
- 桌面壳：Electron + electron-builder（按架构内置 `ffmpeg` 与 `ffprobe`）
- 后端：TypeScript + Hono + Drizzle ORM + better-sqlite3 + Zod + sharp，提示词流水线走 Mastra Agent
- 媒体：图像与视频模型走自建的 ComfyUI 或中转；声音用 32kHz 参考音频

## 目录结构

```
frontend/   Nuxt 应用（静态产物）
backend/    Hono 接口、Agent 与 workspace 模板（skills / prompts）
desktop/    Electron 外壳、打包脚本、release/*.dmg
docker/     docker-compose 相关
configs/    示例服务配置
docs/       设计笔记
```

运行时数据在 `~/Library/Application Support/HuobaoDrama/`：SQLite 库（`data/huobao.sqlite3`）、身份卡（`data/refmods/`）、声音（`data/voices/`）、可编辑的提示词模板（`workspace/`）。换安装包不会动它们。

## 上游与许可

- 上游项目：[chatfire-AI/huobao-drama](https://github.com/chatfire-AI/huobao-drama)。`master` 跟随上游，`chain` 是我的改动。
- 想拉上游更新：`git remote add upstream https://github.com/chatfire-AI/huobao-drama.git`，`git fetch upstream`，再把 `upstream/master` 合进 `chain`。
- 许可：**CC BY-NC-SA 4.0**，与上游一致 —— 需署名、不可商用、相同方式共享。见 [LICENSE](LICENSE)。
- [日文版](README.ja.md) / [韩文版](README.ko.md) 是上游原文，本分支不维护。
