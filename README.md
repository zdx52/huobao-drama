# HuobaoDrama — self-maintained fork

[**中文版说明**](README.zh-CN.md)

A self-maintained fork of [chatfire-AI/huobao-drama](https://github.com/chatfire-AI/huobao-drama) — an AI short-drama production pipeline (script → assets → storyboards → video), shipped as an Electron desktop app with a Nuxt front end and a TypeScript back end.

> **This is a personal fork.** All of my changes live on the **`chain`** branch; **`master`** is kept exactly as upstream delivered it, which makes diffing easy. I do not chase upstream updates, and I do not offer support for this fork.
> App version `desktop 4.0.188` · last update 2026-10-19 · 396 own commits since 2026-10-07.

## What this fork adds

1. **Three-layer prompt governance** — a rules layer (Chinese and English templates are always edited together), a persistence layer (machine gates: language gate, out-of-range `<Subject N>` / `<Picture N>` cleanup, voice-over lip lock, prop reference gate, and more) and an inspection layer (per-storyboard plus whole-episode checks with one-click repair). The same problem is fixed at all three layers instead of trusting the model to behave.
2. **Chained re-shoot** — a derivable chain id and segment ordinal (so a single re-shot segment can attach to the previous one), an automatically prepended airlock head, and wiring through the runner, the local relay and the UI.
3. **Asset system** — RefMod identity cards (character / scene / prop), costume variants (a separate character row produced by image editing, so the face is preserved), voices (a 32 kHz source wav is the artifact; a costume variant can reuse the original character's voice), soft-delete filtering plus cascade cleanup when an episode or a drama is deleted.
4. **Practical engineering** — a stopwatch that shows which task is really rendering, batch generation progress with green/red results, and a local macOS packaging path (per-architecture `ffmpeg` / `ffprobe`, ad-hoc signing so no Rosetta prompt and no "app is damaged" popup).

## Changelog

> Convention: **every delivered installer gets a tag** (`v<app version>-zdz<N>`), and its highlights are added to the table below. The complete history is the [`compare/master...chain`](https://github.com/zdx52/huobao-drama/compare/master...chain) view.

| Date | Tag | Highlights |
| --- | --- | --- |
| 2026-10-19 | `v4.0.188-zdz1` | **Fixes the blank screen in 4.0.187** (the production page rendered nothing). Root cause: while deleting the shared-library block, the edit cut from `importAsset` to the next `}` and swallowed the six `const`s right after it (`promptBusy`, `viewer`, `editRatio`, `textConfigs`, `imageConfigs`, `videoConfigs`) plus `loadConfigs()`. `const` is not hoisted, so the template threw on first access and the whole page went blank — the build stayed green, which is why a real render check is required. Restored by diffing line-by-line against 186; the only differences left are the ones this release intended. README changelog trimmed to the 5 most recent entries. |
| 2026-10-19 | `v4.0.187-zdz1` | **MV: four fixes from user feedback.** (1) **Character boards came back with heads** — root cause: our instruction told the model to close with "cells 2/3/4 have no head at all", while the spec says writing "headless" / "no head" is exactly what makes the model draw one; it now copies the wording the drama uses (which renders correctly): "only cell 1 has a face on this whole board, cells 2/3/4 have the head cleanly removed". Existing prompts do not change by themselves — regenerate the prompt, then re-render. (2) **Project covers now use a scene image** (the drama's rule: a scene is a single complete frame and suits a cover; a character image is a four-cell board), falling back to the initial letter. (3) **Removed the useless "shared asset library" block and the ☆ button** from the production page (assets already live at project level, and the detail page has its own library). (4) **Header nav "Projects" renamed to "Shorts Projects"** (and the ja/ko equivalents). |
| 2026-10-19 | `v4.0.186-zdz1` | **MV rebuilt as the drama's three-level structure, plus three pre-existing bugs fixed.** (1) One page becomes three: `/mv` = project launcher (search + filter chips + cover cards + ⋯ menu, copied from `pages/index.vue`); `/mv/series/:id` = project detail (copied from `drama/detail.vue` — header with rename, then a two-tab body: **MV list / asset library**; song cards copied from the drama's episode cards with a trailing "create MV N+1" card, and the library keeps the drama's layout — character cards, scene cards, click-to-edit dialog with the final prompt); `/mv/:id` = the single MV production flow (the old four-step workbench as its own page, back returns to the project). (2) Backend: new `GET /mv/series/:id` (project + songs + library in one call) and `cover`/`status` on the list; deleting a project now cascades to its songs/assets/shots (it used to delete only the series row, leaving everything behind); asset write endpoints are authorised by project-or-same-series, so a song can edit/delete/render an asset extracted under a sibling song. (3) Fixed three pre-existing bugs: the MV production page returned **500 for everyone** (`watch(() => activeShotId.value, …)` sat above `const activeShotId`, and Vue runs the getter when the watcher is registered → TDZ; reproduced against the pre-change file), a **fresh database could not boot** (`ALTER TABLE mv_projects ADD COLUMN series_id` ran before `CREATE TABLE mv_projects` → `no such table`), and project deletion did not cascade. Verified with a scratch database plus a real browser pass (create project → open it → create an MV → production page → back → asset tab → rename an asset and confirm it in the DB); `npm run generate` passes and the backend `tsc` baseline is still 7. |
| 2026-10-18 | `v4.0.90-zdz1` | **MV asset cards narrowed to match the drama, and clicking a card now opens an editor.** (1) Card too wide: switched to the drama's material-library grids — characters `minmax(230px,260px)` (several per row), scenes `minmax(190px,1fr)` — and the character card is now vertical: 16:9 image area on top, then name / 样貌 / 妆造 / buttons, with a 最终提示词 · 三视图 line at the bottom; scene cards mirror it (cover follows the ratio → body → 最终提示词 · 场景图). (2) Clicking a card did nothing: it now opens an edit dialog (large image left, form right: name / appearance / styling / description / hand-editable final prompt) matching the drama's dialog; the dialog is `<Teleport>`-ed to body so a page container cannot clip it. (3) Image badges now read 形象已生成 / 场景已生成 (green) or 待生成. (4) The render button is renamed 重绘 as in the drama. |
| 2026-10-18 | `v4.0.89-zdz1` | **MV: aspect ratio, a prompt step before rendering, and asset cards copied from the drama.** (1) Ratio: pickable at create time (9:16 portrait / 16:9 landscape) and editable later on the 原始内容 tab (`PUT /mv/projects/:id`); the character board renders at a fixed **16:9 = 2048x1152**, **scene images follow the project ratio** (`imageSizeForAspect`), and shots follow it too (H3 only accepts 9:16 / 16:9; other ratios map by orientation). (2) Prompt-then-render (as in the drama): each asset card has a **生成提示词** button that turns its description into a ready-to-render prompt stored in `mv_assets.prompt`; **rendering is blocked until that prompt exists**, and the render uses it plus the style head. (3) Cards copied from the drama's material library: characters are horizontal cards (left image area fixed **16:9**, right name/description/buttons, prompt line at the bottom), scenes are vertical cards (cover follows the ratio, then body + prompt line), delete moved to a hover button in the corner. (4) Clicking an image opens a large preview (as in the drama). |

## Quick Start

### Install a ready-built app

1. Quit the app completely (⌘Q).
2. Open the `.dmg`, drag **HuobaoDrama.app** into `/Applications` and choose *Replace*.
3. If macOS claims the app "is damaged": `xattr -cr /Applications/HuobaoDrama.app`, then open it again.

### Build it yourself

```bash
# 1) front end (static output in frontend/.output/public)
cd frontend && npm ci && npm run generate

# 2) desktop app (dmg under desktop/release)
cd ../desktop && npm ci && npm run dist
```

- The first desktop build downloads Electron as well as `ffmpeg` / `ffprobe`. If `scripts/prepare-resources.mjs` fails to download them, pre-seed `desktop/build/bin-cache/<name>` (for example copy `ffprobe` out of an installed app's `Contents/Resources/bin/`).
- The trailing publish step fails locally with `Cannot read properties of null (reading 'channel')`. That happens **after** the dmg has been produced — ignore it.
- CI: [`.github/workflows/build-mac.yml`](.github/workflows/build-mac.yml) runs on pushes to `chain`. **Since 2026-10-15 GitHub Actions is blocked for this repository by the platform** — a manual dispatch returns `422 Actions has been disabled for this repository` even though the repository setting shows "enabled", so restoring it needs a support ticket on GitHub's side.

### First run

Configure text / image / video providers under **Settings → AI services** (point them at your own relay or vendor endpoints), then create a project and add an episode.

## Features

- Script import and storyboard breakdown with configurable episode length and shot rules
- Asset extraction with de-duplication (characters, scenes, props) kept in sync across episodes of one drama
- Image generation for character turnaround sheets, scenes and props; optional RefMod identity cards and voice samples
- Bilingual storyboard prompts (Chinese working copy + English version for the video model) guarded by rules, gates and an inspection pass
- Chained re-shoot across storyboards, single-segment re-shoots, and merging finished clips
- Project settings (name, genre, synopsis, visual style, aspect ratio) and a four-language UI

## Tech Stack

- Front end: Nuxt 3 + Vue 3 + vue-i18n (Chinese / English / Japanese / Korean)
- Desktop shell: Electron + electron-builder (bundled per-architecture `ffmpeg` and `ffprobe`)
- Back end: TypeScript + Hono + Drizzle ORM + better-sqlite3 + Zod + sharp, with Mastra agents for the prompt pipeline
- Media: your own ComfyUI instance or relay for image and video models; 32 kHz reference audio for voices

## Project Structure

```
frontend/   Nuxt application (static output)
backend/    Hono API, agents, and the workspace templates (skills / prompts)
desktop/    Electron shell, packaging scripts, release/*.dmg
docker/     docker-compose helpers
configs/    sample service configurations
docs/       design notes
```

Runtime data lives in `~/Library/Application Support/HuobaoDrama/`: the SQLite database (`data/huobao.sqlite3`), identity cards (`data/refmods/`), voices (`data/voices/`) and the editable prompt templates (`workspace/`). Replacing the app never touches it.

## Upstream & License

- Upstream project: [chatfire-AI/huobao-drama](https://github.com/chatfire-AI/huobao-drama). `master` tracks upstream; `chain` carries my changes.
- To pull upstream changes: `git remote add upstream https://github.com/chatfire-AI/huobao-drama.git`, `git fetch upstream`, then merge `upstream/master` into `chain` as needed.
- License: **CC BY-NC-SA 4.0**, same as upstream — attribution required, non-commercial, share-alike. See [LICENSE](LICENSE).
- The [Japanese](README.ja.md) and [Korean](README.ko.md) READMEs are upstream originals and are not maintained here.
