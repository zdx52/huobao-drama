
---

## 附：2026-10-08 追加两项（编号统一 + 正文瘦身）

### 一、编号统一（卡方案下"保证对"）
- **规则**：`<Subject N>` = `<Picture N>` = **卡槽 `mod_N`** = 第 N 张参考图 = 第 N 张资产的卡 —— **同一个号走到底**
- **为什么改**：旧版 `<Subject K>` 按 header 声明顺序编号（出场人物在前），而参考图/卡顺序是"场景在前" →
  `<Subject 1>`(角色) 会对上 `mod_1`(场景卡)，插卡后必然错位
- **实现**：shim `hb_bind_tags` 里 `subs.append((k, nm, k, kd))`（N=k），骨架按图序输出；
  骨架文案改为"identity card mod_N + <Picture N>"
- **数据链路**：App 前端 `getShotReferenceImages`／`getShotReferenceIndexMap`／`getShotReferenceAssetKeys`
  三者同序（场景→角色→道具）；`refmod_files` 按同序下发 → `mod_s = refmods[s-1]`

### 二、正文瘦身（用户反馈"都是人物描述，太长"）
- **规则**：身份/外观**不写进正文**。三重锁定负责"长什么样"：① 身份卡（`<Subject N>`↔`mod_N`）
  ② 参考图（`<Picture N>`）③ 后端机械注入的 `verbatim_lock`（styling/appearance、场景 prompt/lighting 原文）
- 正文只写：场景环境与光线、机位/景别/运动、动作与表演、情节、台词/旁白、音景、曝光锁、切镜
- 每个出场角色**只写 `@名`**（首次可带一次参照格），再次出现不复述特征
- **唯一例外**：本段发生的外观变化（湿透/沾油/换装/受伤/戴面具）必须写进正文
- 骨架同步瘦身：`retention_analysis` 的长句从"每主体重复一遍"合并成一条
- **实测**（sb148 真实分镜干跑）：旧正文 1791→组装 2887 字；新正文 522→组装 **1571 字（-46%）**；正文本身 -71%
- **落地**：`video-prompt/SKILL.md/.en.md`、`prompt_generator.md/.en.md`（已同步本机现役 workspace）；
  shim `merged_shim.py`（备份 `.bak-slim-20261008`，md5 `a5ad4d24e30ac38b256b261c5b85c5cf`，已重启 health ok）
