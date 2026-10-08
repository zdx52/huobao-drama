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
 * ⚠️ 「重新生成」必须给出**看得见的变化**（用户实测报过：点 AI 生成，写回来的还是几乎一样的一句）：
 *    文本模型随机性低，输入不变输出就基本不变。所以每次生成都会
 *    ① 换一个「侧重点维度」（记进文件，下次挑一个不同的）② 把上一版喂回去，明确要求换词换语序。
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

/** 每次轮换的侧重点（都落在 CosyVoice instruct 白名单内） */
const DESC_ANGLES = [
  '音质质感（清亮 / 沙哑 / 浑厚 / 轻柔 / 明亮 …）',
  '情绪语气（稳重 / 爽朗 / 温柔 / 急躁 / 冷淡 …）',
  '语速节奏（偏快 / 偏慢 / 不紧不慢 / 偶尔停顿 …）',
  '音量大小（偏低 / 洪亮 / 忽高忽低 …）',
  '方言口音（东北话 / 广东话 / 四川话 / 陕西话 …；没把握就不写）',
]

function voicePromptsDir(): string {
  return path.join(STORAGE_ROOT, '..', 'voice_prompts')
}
function voicePromptPath(id: number): string {
  return path.join(voicePromptsDir(), `character-${Number(id)}.json`)
}

/** 读整份文件（desc / source / angle） */
function readVoicePromptFile(id: number): any {
  try {
    return JSON.parse(fs.readFileSync(voicePromptPath(id), 'utf8'))
  } catch {
    return null
  }
}

/** 读已生成的音色描述（没有则空串） */
export function readVoicePrompt(id: number): string {
  return String(readVoicePromptFile(id)?.desc || '')
}

/** 读整份元信息（desc/source/angle/updated_at）——声音面板据 source 决定提示文案 */
export function readVoicePromptMeta(
  id: number,
): { desc: string; source: string; angle?: string; updated_at?: string } {
  const j = readVoicePromptFile(id) || {}
  return {
    desc: String(j.desc || ''),
    source: String(j.source || ''),
    angle: j.angle,
    updated_at: j.updated_at,
  }
}

/** 落盘音色描述（source: ai=模型生成 / user=用户手改；angle=本次侧重点，供下次避开重复） */
export function saveVoicePrompt(id: number, desc: string, source = 'ai', angle?: string): void {
  fs.mkdirSync(voicePromptsDir(), { recursive: true })
  fs.writeFileSync(
    voicePromptPath(id),
    JSON.stringify({ desc, source, ...(angle ? { angle } : {}), updated_at: new Date().toISOString() }, null, 1),
  )
}

/** 挑一个与上次不同的侧重点，保证两次生成的侧重不一样 */
function pickAngle(prevAngle?: string): string {
  const pool = DESC_ANGLES.filter(a => a !== prevAngle)
  const list = pool.length ? pool : DESC_ANGLES
  return list[Math.floor(Math.random() * list.length)]!
}

function buildAsk(char: VoiceDescChar, opts?: { avoid?: string; angle?: string }): string {
  const lines = [
    '任务：为下面这个角色写**一句**中文「音色描述」，用于中文 TTS 的指令跟随（配音用）。',
    '',
    '硬规则（违反即无效）：',
    '1. 只允许描述：音质质感（清亮/沙哑/浑厚/轻柔/明亮…）、情绪（稳重/爽朗/温柔/急躁…）、语速（偏快/偏慢/正常）、音量（偏低/洪亮）、方言或口音（东北话/广东话/四川话/陕西话…；没把握就不写）。',
    '2. 严禁写年龄、性别、身高、长相、职业称谓，以及任何音色之外的信息——这些由角色形象与参考音频决定，写进描述也不生效。',
    '3. 只输出那一句中文（10~30 字），不要引号、不要换行、不要解释、不要调用任何工具。',
  ]
  if (opts?.angle) {
    lines.push(`4. 这一版把重点放在：${opts.angle}（其余维度按需带过）。`)
  }
  if (opts?.avoid) {
    lines.push('5. 必须与「上一版」明显不同：换词、换语序、换说法，不要只改一两个字，也不要照抄。')
    lines.push(`上一版（仅供避免重复用，不要出现在你的回答里）：${opts.avoid}`)
  }
  lines.push(
    '',
    `角色名：${char.name || '（未命名）'}`,
    `身份：${char.role || '（未填）'}`,
    `性格：${char.personality || '（未填）'}`,
    `外貌：${String(char.appearance || '（未填）').slice(0, 120)}`,
  )
  return lines.join('\n')
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
 * force=true（面板上的「AI 生成」）→ 换侧重点重新生成，并明确要求与上一版不同。
 */
export async function ensureVoiceDesc(
  char: VoiceDescChar,
  force = false,
  opts?: VoiceDescOptions,
): Promise<string> {
  const prev = readVoicePromptFile(char.id)
  const prevDesc = String(prev?.desc || '')
  if (!force && prevDesc) return prevDesc
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
    const angle = pickAngle(prev?.angle)
    const res: any = await agent.generate(
      [{ role: 'user', content: buildAsk(char, { avoid: prevDesc, angle }) }],
      { maxSteps: 1, requestContext },
    )
    const desc = sanitize(String(res?.text || ''))
    if (!desc) return ''
    saveVoicePrompt(char.id, desc, 'ai', angle)
    return desc
  } catch (err: any) {
    logTaskError('VoiceDesc', 'generate', { characterId: char.id, error: err?.message })
    return ''
  }
}
