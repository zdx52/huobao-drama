/**
 * 角色音色描述（2026-10-08 批次③）——「生成角色提示词」时顺带生成，声音面板自动带出
 *
 * 为什么是独立一步：CosyVoice 的 instruct **只认白名单维度**（情绪/语速/方言/音量），
 * 年龄与音色靠描述改不了（论文 + 官方白名单 + 社区三证）→ 所以这里生成的描述
 * 只允许写白名单内的东西，避免 AI 写出「六岁小女孩」这种分布外输入污染抽卡。
 *
 * 落盘用文件（不新增数据库列：schema 只有 CREATE TABLE IF NOT EXISTS、无加列迁移）。
 */
import path from 'path'
import fs from 'fs'
import { generateText } from 'ai'
import { STORAGE_ROOT } from '../utils/paths.js'
import { getModel } from '../agents/index.js'
import { logTaskError, logTaskProgress } from '../utils/task-logger.js'

export interface VoiceDescOptions { model?: string; configId?: number }

function voicePromptsDir(): string {
  return path.join(STORAGE_ROOT, '..', 'voice_prompts')
}
function voicePromptPath(id: number): string {
  return path.join(voicePromptsDir(), `character-${Number(id)}.json`)
}

/** 读已生成的音色描述（没有则空串） */
export function readVoicePrompt(id: number): string {
  try {
    const j = JSON.parse(fs.readFileSync(voicePromptPath(id), 'utf8'))
    return String(j?.desc || '')
  } catch {
    return ''
  }
}

/** 落盘音色描述 */
export function saveVoicePrompt(id: number, desc: string, source = 'ai'): void {
  fs.mkdirSync(voicePromptsDir(), { recursive: true })
  fs.writeFileSync(
    voicePromptPath(id),
    JSON.stringify({ desc, source, updated_at: new Date().toISOString() }, null, 1),
  )
}

const VOICE_DESC_SYSTEM = [
  '你是短剧配音导演。根据角色资料，为该角色写一句「音色描述」，供中文 TTS 指令跟随使用。',
  '',
  '硬规则（违反即无效）：',
  '1. 只允许描述：音质质感（清亮/沙哑/浑厚/轻柔/明亮…）、情绪（稳重/爽朗/温柔/急躁…）、语速（偏快/偏慢/正常）、音量（偏低/洪亮）、方言或口音（东北话/广东话/四川话/陕西话…；没有把握就不写）。',
  '2. 严禁写：年龄、性别、身高、长相、职业称谓，以及任何音色之外的信息——这些由角色形象与参考音频决定，写进描述也不生效。',
  '3. 只输出那一句中文，10~30 字，不要引号、不要换行、不要任何前缀或解释。',
].join('\n')

/** 清洗模型输出：取首行、去引号、限长 */
function sanitize(text: string): string {
  let s = String(text || '').split(/\r?\n/)[0].trim()
  s = s.replace(/^["'“”‘’《》]+|["'“”‘’《》]+$/g, '').trim()
  s = s.replace(/^(音色描述|描述|输出)[：:。\s]*/i, '').trim()
  if (s.length > 40) s = s.slice(0, 40)
  return s
}

/**
 * 生成（并落盘）角色的音色描述。失败返回空串——不阻断角色提示词生成主流程。
 * 已有描述且非 force → 直接返回旧的（用户可在声音面板里手改，手改不动这里）。
 */
export async function ensureVoiceDesc(
  char: { id: number; name?: string | null; role?: string | null; personality?: string | null; appearance?: string | null },
  force = false,
  opts?: VoiceDescOptions,
): Promise<string> {
  if (!force) {
    const cached = readVoicePrompt(char.id)
    if (cached) return cached
  }
  try {
    logTaskProgress('VoiceDesc', 'generate', { characterId: char.id })
    const model = await getModel(undefined, opts?.model, opts?.configId)
    const { text } = await generateText({
      model,
      system: VOICE_DESC_SYSTEM,
      prompt: [
        `角色名：${char.name || '（未命名）'}`,
        `身份：${char.role || '（未填）'}`,
        `性格：${char.personality || '（未填）'}`,
        `外貌：${(char.appearance || '（未填）').slice(0, 120)}`,
      ].join('\n'),
      temperature: 0.7,
    })
    const desc = sanitize(text)
    if (!desc) return ''
    saveVoicePrompt(char.id, desc, 'ai')
    return desc
  } catch (err: any) {
    logTaskError('VoiceDesc', 'generate', { characterId: char.id, error: err?.message })
    return ''
  }
}
