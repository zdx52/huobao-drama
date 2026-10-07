/**
 * 打包资源准备 — 组装 desktop/resources/（electron-builder extraResources 的来源）
 *
 * 1. frontend/           ← nuxt generate 产物（.output/public，含 index.html）
 * 2. workspace-template/ ← backend/workspace（skills + prompts，首启动拷入 userData）
 * 3. bin-<os>/           ← ffmpeg/ffprobe 按平台分目录（electron-builder ${os} 宏各取所需，
 *                          避免 mac 包带 exe、win 包带 mac 二进制白白 +144MB）
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(__dirname, '..')
const REPO = path.resolve(DESKTOP, '..')
const RES = path.join(DESKTOP, 'resources')

fs.rmSync(RES, { recursive: true, force: true })
fs.mkdirSync(RES, { recursive: true })

// 1. 前端静态产物
const frontendSrc = path.join(REPO, 'frontend', '.output', 'public')
if (!fs.existsSync(path.join(frontendSrc, 'index.html'))) {
  console.error('缺少前端产物：请先在 frontend/ 执行 npm run generate')
  process.exit(1)
}
fs.cpSync(frontendSrc, path.join(RES, 'frontend'), { recursive: true })
console.log('resources/frontend ✓')

// 2. workspace 模板（skills 技能 + prompts 提示词）
const workspaceSrc = path.join(REPO, 'backend', 'workspace')
fs.cpSync(workspaceSrc, path.join(RES, 'workspace-template'), { recursive: true })
console.log('resources/workspace-template ✓')

// 3. ffmpeg/ffprobe 二进制 — **按架构分别准备**：bin-mac-arm64 / bin-mac-x64 / bin-win-x64
//
// 2026-10-08 修复：原来 mac 的两种架构共用一份 resources/bin-mac，二进制来自本机 npm 安装的
//   ffmpeg-static / ffprobe-static。而 ffprobe-static@3.1.0 **只发布 darwin-x64**（没有 arm64），
//   于是 arm64 的 dmg 里也混进了 x86_64 的 ffprobe → 用户 Apple Silicon 机器上合并成片时会
//   弹"需要安装 Rosetta"或直接失败。现在四个二进制统一从 ffmpeg-static release b6.0 取
//   （它同时提供 ffmpeg/ffprobe × darwin-arm64/darwin-x64），按架构落到各自目录，
//   electron-builder 用 bin-${os}-${arch} 各取所需。首次构建会下载并缓存到 desktop/build/bin-cache。
const req = createRequire(import.meta.url)
const RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0'
const CACHE = path.join(DESKTOP, 'build', 'bin-cache')
fs.mkdirSync(CACHE, { recursive: true })

/** 取 <name>.gz → 解压到缓存（已缓存则跳过）；返回本地路径。带 3 次重试（网络抖动时别让整包失败） */
async function fetchGz(name) {
  const dest = path.join(CACHE, name)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return dest
  const url = `${RELEASE}/${name}.gz`
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  下载 ${name}.gz …${attempt > 1 ? ` (第 ${attempt} 次)` : ''}`)
      const resp = await fetch(url, { redirect: 'follow' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      fs.writeFileSync(dest, zlib.gunzipSync(Buffer.from(await resp.arrayBuffer())))
      fs.chmodSync(dest, 0o755)
      return dest
    } catch (err) {
      lastErr = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw new Error(`下载 ${url} 失败: ${lastErr?.message || lastErr}`)
}

// mac：两种架构都从 release 取（arm64 与 x64 各自一份，绝不混用）
for (const arch of ['arm64', 'x64']) {
  const out = path.join(RES, `bin-mac-${arch}`)
  fs.mkdirSync(out, { recursive: true })
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const src = await fetchGz(`${bin}-darwin-${arch}`)
    fs.copyFileSync(src, path.join(out, bin))
    fs.chmodSync(path.join(out, bin), 0o755)
  }
  console.log(`resources/bin-mac-${arch} ✓`)
}

// 3b. Windows 二进制（打 win 包用；不打 win 包时缺失不报错，仅提示）
const binWin = path.join(RES, 'bin-win-x64')
fs.mkdirSync(binWin, { recursive: true })
const winBinDir = path.join(DESKTOP, 'build', 'win-bin')
const ffmpegWin = path.join(winBinDir, 'ffmpeg.exe')
let ffprobeWinSrc = null
try {
  ffprobeWinSrc = path.join(path.dirname(req.resolve('ffprobe-static/package.json')), 'bin', 'win32', 'x64', 'ffprobe.exe')
} catch { /* 未安装 ffprobe-static 时忽略 */ }
if (!fs.existsSync(ffmpegWin)) {
  console.warn('提示: 缺少 build/win-bin/ffmpeg.exe，Windows 包将无法内置 ffmpeg。' +
    '获取: https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64')
}
if (fs.existsSync(ffmpegWin) && ffprobeWinSrc && fs.existsSync(ffprobeWinSrc)) {
  fs.copyFileSync(ffmpegWin, path.join(binWin, 'ffmpeg.exe'))
  fs.copyFileSync(ffprobeWinSrc, path.join(binWin, 'ffprobe.exe'))
  console.log('resources/bin-win-x64 ✓')
}

