/**
 * 角色音色描述（2026-10-08 批次③）——「生成角色提示词」时顺带生成，声音面板/角色卡展示
 *
 * 为什么是独立一步：CosyVoice 的 instruct **只认白名单维度**（情绪/语速/方言/音量），
 * 年龄与音色靠描述改不了（论文 + 官方白名单 + 社区三证）→ 这里生成的描述只允许写白名单内的东西，
 * 避免 AI 写出「六岁小女孩」这种分布外输入污染抽卡。
 *
 * ⚠️ 不要 `import { generateText } from 'ai'`：backend/package.json 里**没有声明 `ai` 包**，
 *    desktop 的 esbuild 打包会直接报 `Could not resolve "ai"` 把编包打挂（2026-10-08 实测两次失败）。
 *    改为走项目自己的 Mastra Agent 通道（prompt_generator）——零新依赖，provider/模型解析沿用
 *    与 Agent 相同的 getModel 那套（openai / gemini / volcengine / aliyun 全覆盖）。
 *
 * 落盘用文件（不新增数据库列：schema 只有 CREATE TABLE IF NOT EXISTS、无加列迁移）。
 */
import path from 'path'
import fs from 'fs'
import { eq, asc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { logTaskError, logTaskProgress } from '../utils/task-logger.js'

export interface VoiceDescOptions { model?: string; configId?: number }

export interface VoiceDescChar {
  id: number
  dramaId: number
  name?: string | null
  role?: string | null
  personality?: string | null
  appearance?: string | null
}

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

/** 落盘音色描述（source: ai=模型生成 / user=用户手改） */
export function saveVoicePrompt(id: number, desc: string, source = 'ai'): void {
  fs.mkdirSync(voicePromptsDir(), { recursive: true })
  fs.writeFileSync(
    voicePromptPath(id),
    JSON.stringify({ desc, source, updated_at: new Date().toISOString() }, null, 1),
  )
}

function buildAsk(char: VoiceDescChar): string {
  return [
    '任务：为下面这个角色写**一句**中文「音色描述」，用于中文 TTS 的指令跟随（配音用）。',
    '',
    '硬规则（违反即无效）：',
    '1. 只允许描述：音质质感（清亮/沙哑/浑厚/轻柔/明亮…）、情绪（稳重/爽朗/温柔/急躁…）、语速（偏快/偏慢/正常）、音量（偏低/洪亮）、方言或口音（东北话/广东话/四川话/陕西话…；没把握就不写）。',
    '2. 严禁写年龄、性别、身高、长相、职业称谓，以及任何音色之外的信息——这些由角色形象与参考音频决定，写进描述也不生效。',
    '3. 只输出那一句中文（10~30 字），不要引号、不要换行、不要解释、不要调用任何工具。',
    '',
    `角色名：${char.name || '（未命名）'}`,
    `身份：${char.role || '（未填）'}`,
    `性格：${char.personality || '（未填）'}`,
    `外貌：${String(char.appearance || '（未填）').slice(0, 120)}`,
  ].join('\n')
}

/** 清洗模型输出：取首行、去引号、去前缀、限长 */
function sanitize(text: string): string {
  let s = String(text || '').split(/\r?\n/)[0].trim()
  s = s.replace(/^["'“”‘’《》]+|["'“”‘’《》]+$/g, '').trim()
  s = s.replace(/^(音色描述|描述|输出|答案)[:：。\s]*/i, '').trim()
  // 模型偶尔会加「角色音色：」这类前缀
  s = s.replace(/^[^：:]{0,6}[:：]\s*/, '').trim()
  if (s.length > 40) s = s.slice(0, 40)
  return s
}

/**
 * 生成（并落盘）角色的音色描述。失败返回空串——**不阻断角色提示词生成主流程**。
 * 已有描述且非 force → 直接返回旧的。
 */
export async function ensureVoiceDesc(
  char: VoiceDescChar,
  force = false,
  opts?: VoiceDescOptions,
): Promise<string> {
  if (!force) {
    const cached = readVoicePrompt(char.id)
    if (cached) return cached
  }
  try {
    logTaskProgress('VoiceDesc', 'generate', { characterId: char.id })
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('prompt_generator Agent 不可用')
    const [ep] = await db
      .select()
      .from(schema.episodes)
      .where(eq(schema.episodes.dramaId, char.dramaId))
      .orderBy(asc(schema.episodes.id))
      .limit(1)
    const requestContext = buildAgentRequestContext({
      episodeId: ep?.id ?? 0,
      dramaId: char.dramaId,
      modelOverride: opts?.model || undefined,
      textConfigId: opts?.configId || undefined,
    })
    const res: any = await agent.generate([{ role: 'user', content: buildAsk(char) }], {
      maxSteps: 1,
      requestContext,
    })
    const desc = sanitize(String(res?.text || ''))
    if (!desc) return ''
    saveVoicePrompt(char.id, desc, 'ai')
    return desc
  } catch (err: any) {
    logTaskError('VoiceDesc', 'generate', { characterId: char.id, error: err?.message })
    return ''
  }
}
