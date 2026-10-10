/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 进程内内存态：按集跟踪一份任务，运行中不重复启动；重启后状态丢失
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface VideoPromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
}

const tasks = new Map<number, VideoPromptBatchStatus>()

/** video_prompt_en 长度硬上限，与 video-prompt 技能「英文发送版」节的逐段配额一致：
 *  MiniMax H3 官方 7000 字符 hard limit − 后端风格头 591 − 余量 ≈ 6200。
 *  Agent 不数字符数（2026-10-10 实测：sb147 写到 7823 仍以为没超、逐段全超 28%），
 *  所以由后端当裁判 —— 超限就带逐段实测数字回喂重写，最多 MAX_EN_RETRY 次。 */
const PROMPT_EN_LIMIT = 6200
const MAX_EN_RETRY = 2
/** [段名, 字符配额]，顺序即文档顺序，用于精确指出哪段超了多少 */
const EN_SECTION_QUOTA: Array<[string, number]> = [
  ['CAST:', 220],
  ['BLOCKING:', 420],
  ['subject_definitions:', 1850],
  ['summary:', 380],
  ['retention_analysis:', 820],
  ['detailed_description:', 2050],
  ['overall_soundscape:', 330],
  ['non_diegetic_music:', 50],
]

/** 按段名切分英文版，返回每段实测长度与配额差（切不出就返回空数组） */
function measureEnSections(t: string): Array<{ seg: string; len: number; quota: number; over: number }> {
  const found = EN_SECTION_QUOTA
    .map(([seg, quota]) => {
      const at = t.indexOf('\n' + seg)
      return { seg, quota, i: at >= 0 ? at + 1 : t.indexOf(seg) }
    })
    .filter(x => x.i >= 0)
    .sort((a, b) => a.i - b.i)
  return found.map((p, n) => {
    const end = n + 1 < found.length ? found[n + 1].i - 1 : t.length
    const len = end - p.i
    return { seg: p.seg, len, quota: p.quota, over: len - p.quota }
  })
}

/** 超长回喂文案：把逐段实测数字交给 Agent，要求按技能里的砍除顺序压回上限 */
function buildOverLengthFeedback(en: string, attempt: number): string {
  const rows = measureEnSections(en)
    .map(r => `${r.seg.replace(':', '')} ${r.len}/${r.quota}${r.over > 0 ? ` (+${r.over})` : ''}`)
    .join(' / ')
  return `⚠️ 第 ${attempt} 次重写要求：上一版 video_prompt_en 实测 ${en.length} 字符，超 ${PROMPT_EN_LIMIT} 上限 ${en.length - PROMPT_EN_LIMIT} 字符，**会被 H3 整段拒收、视频生成不出来**。
逐段实测/配额：${rows || '（未能切段，请按技能配额表逐段自查）'}
请按 video-prompt 技能「英文发送版」节的砍除顺序压缩到 ${PROMPT_EN_LIMIT} 字符以内，再调用 update_storyboard 保存（三个键都要传）。**绝不许砍**：\`<d>\` 台词、\`retention_analysis\` 的 fully_preserved、\`<Picture N>\` 的 with 外观、CAST 数量锁、BLOCKING 的 180 轴线。`
}

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (tasks.get(episodeId)?.status === 'running') return { started: false, total: -1 }

  const sbs = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const pending = storyboardIds?.length
    ? sbs.filter(sb => storyboardIds.includes(sb.id))
    // 2026-10-09：中英文**任一**缺失都算缺。英文版是视频生成唯一可用的那份
    // （前端已硬保护：缺英文版直接报错不发送），只判中文版会出现
    // 后端说"已齐"、前端说"发不了"的死锁。
    : sbs.filter(sb => !((sb.videoPrompt || '').trim() && (sb.videoPromptEn || '').trim()))
  if (!pending.length) return { started: false, total: 0 }

  // 视频模型标签：跟随该集锁定的视频配置，供 Agent 按模型特性生成
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  let videoLabel = '默认'
  if (ep?.videoConfigId) {
    const [cfg] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.videoConfigId))
    if (cfg) videoLabel = `${cfg.name} (${cfg.provider})`
  }

  const task: VideoPromptBatchStatus = {
    status: 'running',
    total: pending.length,
    completed: 0,
    failed: 0,
    started_at: new Date().toISOString(),
  }
  tasks.set(episodeId, task)

  logTaskStart('VideoPrompt', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  ;(async () => {
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('视频提示词 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
    })
    for (const sb of pending) {
      task.current_storyboard_id = sb.id
      logTaskProgress('VideoPrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: task.completed + task.failed + 1, total: task.total })
      try {
        const baseContent = `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词(video_prompt)。视频模型:${videoLabel},请根据该模型的特性和时长限制生成。
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长，据此**同批生成两份**：video_prompt(中文工作版)与 video_prompt_en(H3 官方 Ref2VA 六段式英文版,规则见 video-prompt 技能「英文发送版」节)。

🔴 **硬性长度上限（必守，不许目测估算）**：video_prompt_en 全文（含换行与标点）**必须 ≤ 6200 字符**。**保存前逐段核对技能里的配额表并数字符数**：CAST ≤220 / BLOCKING ≤420 / subject_definitions ≤1850 / summary ≤380 / retention_analysis ≤820 / detailed_description ≤2050 / overall_soundscape ≤330 / non_diegetic_music ≤50。**实测超限会被整段拒收、视频根本生成不出来**（历史事故：写到 7823 字符 → 拼接风格头后 8414 → 报「提示词超长：MiniMax H3 上限 7000 字符」）。超了就按技能里的砍除顺序压回 6200 以内再保存。**绝不许砍**：「<d>」 台词、retention_analysis 每条的 fully_preserved、「<Picture N>」 的 with 外观、CAST 数量锁、BLOCKING 的 180 轴线。

update_storyboard 必须同时传三个键: storyboard_id、video_prompt、video_prompt_en。不要回传该分镜的其他任何字段,不要重新拆分整集。`
        // 长度闭环：Agent 不数字符数（实测 sb147 写到 7823 仍以为没超），
        // 所以由后端实测——超 6200 就把逐段实测数字回喂要求重写，最多 MAX_EN_RETRY 次。
        let lastEn = ''
        for (let attempt = 0; attempt <= MAX_EN_RETRY; attempt++) {
          const feedback = attempt === 0 ? '' : `\n\n${buildOverLengthFeedback(lastEn, attempt)}`
          await agent.generate([{ role: 'user', content: baseContent + feedback }], { maxSteps: 12, requestContext })
          const [cur] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
          const en = (cur?.videoPromptEn || '').trim()
          if (!(cur?.videoPrompt || '').trim() || !en) break   // 生成失败，重试无意义
          if (en.length <= PROMPT_EN_LIMIT) break              // 达标
          lastEn = en
          logTaskError('VideoPrompt', 'over-length-retry', {
            storyboardId: sb.id, attempt: attempt + 1, len: en.length, over: en.length - PROMPT_EN_LIMIT,
          })
        }
        // 以实际落库为准判定成败（2026-10-09：中英两份都落库才算成功，只看中文版会漏判）
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        const freshEn = (fresh?.videoPromptEn || '').trim()
        if ((fresh?.videoPrompt || '').trim() && freshEn) {
          task.completed++
          if (freshEn.length > PROMPT_EN_LIMIT) {
            // 重试用尽仍超：不拦（发送侧还有 7000 硬限），留痕便于复盘
            logTaskError('VideoPrompt', 'batch-shot', {
              storyboardId: sb.id,
              error: `video_prompt_en 仍超长 ${freshEn.length} > ${PROMPT_EN_LIMIT}（重写 ${MAX_EN_RETRY} 次未达标）`,
            })
          }
        } else {
          task.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: 'agent finished but video_prompt or video_prompt_en is empty' })
        }
      } catch (err: any) {
        task.failed++
        logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: err?.message })
      }
    }
  })()
    .then(() => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
      task.current_storyboard_id = undefined
      logTaskSuccess('VideoPrompt', 'batch', { episodeId, total: task.total, completed: task.completed, failed: task.failed })
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '批量生成失败'
      logTaskError('VideoPrompt', 'batch', { episodeId, error: err?.message })
    })
  return { started: true, total: pending.length }
}

export function getVideoPromptBatchStatus(episodeId: number): VideoPromptBatchStatus | null {
  return tasks.get(episodeId) || null
}
