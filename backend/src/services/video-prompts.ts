/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 进程内内存态：按集跟踪一份任务，运行中不重复启动；重启后状态丢失
 *
 * 2026-10-10 改为**分段生成**：video_prompt_en 不再一次写完，而是分 4 轮、
 * 每轮只写指定段并当场实测。四轮配额之和 = 640+1850+1200+2430 = 6120，
 * 加换行标点余量 80 = 6200 = 全文上限，所以「每段都达标 → 拼起来必然不超」，
 * 不需要写完整篇再回头重写（用户嫌那样浪费时间）。
 * 根因：Agent 不数字符数——实测 sb147 写到 7823 字符仍以为没超，逐段全超 28%。
 * 落库也改由后端做（Agent 只输出纯文本，不调 save 工具，避免它顺手写别的字段）。
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

/** video_prompt_en 全文硬上限（含换行与标点），与 video-prompt 技能「英文发送版」节一致：
 *  MiniMax H3 官方 7000 字符 hard limit − 发送时拼的风格头 591 − 余量 ≈ 6200。 */
const PROMPT_EN_LIMIT = 6200
/** 单段超配额时的重写次数上限 —— 重写只针对这一段，代价远小于全文重写 */
const MAX_SEG_RETRY = 2

/** 分段表：每轮只写 segs 里的段，limit = 该轮各段配额之和（等于技能里的逐段配额相加）。
 *  limit 全部相加 = 6120；再加换行标点余量 80 = 6200 = PROMPT_EN_LIMIT。 */
const EN_STAGES: Array<{ key: string; label: string; segs: string[]; limit: number }> = [
  { key: 'head', label: 'CAST 和 BLOCKING 两段', limit: 640, segs: ['CAST:', 'BLOCKING:'] },
  { key: 'subj', label: 'subject_definitions 段', limit: 1850, segs: ['subject_definitions:'] },
  { key: 'summ', label: 'summary 和 retention_analysis 两段', limit: 1200, segs: ['summary:', 'retention_analysis:'] },
  {
    key: 'detail',
    label: 'detailed_description、overall_soundscape、non_diegetic_music 三段',
    limit: 2430,
    segs: ['detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'],
  },
]

/** 段名标记，用于把 Agent 输出里段名之前的解释性前言裁掉 */
const SEG_MARKERS = 'CAST:|BLOCKING:|subject_definitions:|summary:|retention_analysis:|detailed_description:|overall_soundscape:|non_diegetic_music:'

/** 清洗 Agent 的纯文本输出：去代码块围栏、去段名之前的废话、去尾部结语。
 *  循环跑到稳定——围栏和前言可能同时出现（例：'以下是内容：\n```\nCAST: …\n```\n希望有帮助。'），
 *  单趟清理会残留尾部围栏。 */
function cleanSegText(raw: string): string {
  let s = String(raw || '').trim()
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s.replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    s = s.replace(/\n?\s*```\s*$/, '')
    const at = s.search(new RegExp(`(?:^|\\n)(?:${SEG_MARKERS})`))
    if (at > 0) s = s.slice(at)
    s = s.replace(/\n+(?:以上[^\n]{0,80}|希望对[^\n]{0,80}|如需[^\n]{0,80})\s*$/, '')
    s = s.trim()
    if (s === before) break
  }
  return s
}

/** 某段输出是否合格：非空、段名齐全、且不超本轮配额 */
function segmentProblem(out: string, stage: { segs: string[]; limit: number }): string | null {
  const missing = stage.segs.filter(mk => !out.includes(mk))
  if (!out) return '上一版没有输出任何内容'
  if (missing.length) return `上一版缺少这些段：${missing.join(' ')}`
  if (out.length > stage.limit) return `上一版这一段实测 ${out.length} 字符，超 ${stage.limit} 上限 ${out.length - stage.limit} 字符`
  return null
}

/** 段级重写要求（只重写这一段，不动其他段） */
function buildSegmentRetryNote(problem: string, stage: { label: string; limit: number }, attempt: number): string {
  return `\n\n⚠️ 重写要求（第 ${attempt} 次）：${problem}。
**只输出【${stage.label}】**，直接给正文；不要解释、前言、结语；不要用代码块围栏；不要调用任何保存工具。
长度必须 ≤ ${stage.limit} 字符（含换行与标点）。不许为了压长度而砍 <d> 台词、retention_analysis 的 fully_preserved、<Picture N> 的 with 外观、CAST 数量锁、BLOCKING 的 180 轴线。`
}

/** 本轮指令：先读分镜上下文，再只输出本轮那几段；带上已定稿前文保持一致 */
function buildStagePrompt(
  sb: { id: number; storyboardNumber: number | null },
  videoLabel: string,
  stage: { key: string; label: string; segs: string[]; limit: number },
  prior: string[],
): string {
  const idx = EN_STAGES.findIndex(s => s.key === stage.key) + 1
  const priorBlock = prior.length
    ? `\n\n【已定稿的前文，仅供你保持一致，不要重复输出、不要改动一个字】\n${prior.join('\n')}`
    : ''
  return `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词 video_prompt_en 的第 ${idx}/${EN_STAGES.length} 部分。视频模型:${videoLabel}。

步骤：
1. 调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长。
2. **只输出本轮指定的段，直接给正文**：不要输出其他段；不要输出解释、前言、结语；不要用代码块围栏；不要调用任何保存工具。

【本轮要写】${stage.label}
【本轮硬性长度上限】≤ ${stage.limit} 字符（含换行与标点）—— 写完自己数字符数，超了就当场压缩到上限以内再输出。
为什么这么严：MiniMax H3 全文上限 7000 字符，发送时后端还要拼 591 字符风格头，四轮配额之和正好 6200；任一轮超了整条会被拒收、视频生成不出来。
绝不许为了压长度而砍：<d> 台词、retention_analysis 的 fully_preserved、<Picture N> 的 with 外观、CAST 数量锁、BLOCKING 的 180 轴线。${priorBlock}

格式与规则见 video-prompt 技能「英文发送版」节。`
}

/** 分段生成完整 video_prompt_en；任一段压不下去就返回 ok:false（上层记错，不落半成品） */
async function generateEnByStages(
  agent: { generate: (m: unknown, o: unknown) => Promise<unknown> },
  sb: { id: number; storyboardNumber: number | null },
  videoLabel: string,
  requestContext: unknown,
  episodeId: number,
): Promise<{ text: string; ok: boolean }> {
  const parts: string[] = []
  for (const stage of EN_STAGES) {
    let out = ''
    let ok = false
    let problem: string | null = null
    for (let attempt = 0; attempt <= MAX_SEG_RETRY; attempt++) {
      const note = attempt > 0 && problem ? buildSegmentRetryNote(problem, stage, attempt) : ''
      const res = (await agent.generate(
        [{ role: 'user', content: buildStagePrompt(sb, videoLabel, stage, parts) + note }],
        { maxSteps: 4, requestContext },
      )) as { text?: string } | undefined
      out = cleanSegText(res?.text || '')
      problem = segmentProblem(out, stage)   // 空 / 缺段名 / 超配额 都算不合格
      if (!problem) {
        ok = true
        break
      }
      logTaskProgress('VideoPrompt', 'segment-retry', {
        episodeId,
        storyboardId: sb.id,
        stage: stage.key,
        attempt: attempt + 1,
        problem,
        len: out.length,
        limit: stage.limit,
      })
    }
    if (!ok) {
      logTaskError('VideoPrompt', 'segment-give-up', {
        episodeId,
        storyboardId: sb.id,
        stage: stage.key,
        error: problem || '未知原因',
      })
      return { text: '', ok: false }
    }
    parts.push(out)
  }
  return { text: parts.join('\n'), ok: true }
}

/** 中文工作版（给人看的分镜说明，不直接发给视频模型，无长度压力） */
async function generateZhPrompt(
  agent: { generate: (m: unknown, o: unknown) => Promise<unknown> },
  sb: { id: number; storyboardNumber: number | null },
  videoLabel: string,
  requestContext: unknown,
): Promise<string> {
  const res = (await agent.generate(
    [
      {
        role: 'user',
        content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成中文工作版视频提示词(video_prompt)。视频模型:${videoLabel},请根据该模型的特性和时长限制生成。
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长。
这份是给人看的工作版（不直接发给视频模型，无长度限制），写法见 video-prompt 技能的中文工作版章节。
**只输出正文**：不要输出解释、前言、结语；不要用代码块围栏；不要调用任何保存工具。`,
      },
    ],
    { maxSteps: 4, requestContext },
  )) as { text?: string } | undefined
  return cleanSegText(res?.text || '')
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
        // 1) 分段生成英文版：每段当场达标 → 拼起来必然 ≤ 6200（配额之和 = 上限）
        const en = await generateEnByStages(agent, sb, videoLabel, requestContext, episodeId)
        if (!en.ok) {
          task.failed++
          continue
        }
        if (en.text.length > PROMPT_EN_LIMIT) {
          // 各段都已达标，理论上不会走到这里；留痕便于发现配额表被改坏
          logTaskError('VideoPrompt', 'batch-shot', {
            storyboardId: sb.id,
            error: `分段拼接后仍超 ${en.text.length} > ${PROMPT_EN_LIMIT}（各段应已达标，请核对 EN_STAGES 配额与技能配额是否一致）`,
          })
        }
        // 2) 中文工作版
        const zh = await generateZhPrompt(agent, sb, videoLabel, requestContext)
        if (!zh) {
          task.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: '中文工作版生成为空' })
          continue
        }
        // 3) 后端落库（英文版是分段落库，中文版随后一次写入）
        await db.update(schema.storyboards)
          .set({ videoPrompt: zh, videoPromptEn: en.text })
          .where(eq(schema.storyboards.id, sb.id))
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        const freshEn = (fresh?.videoPromptEn || '').trim()
        if ((fresh?.videoPrompt || '').trim() && freshEn) {
          task.completed++
          logTaskProgress('VideoPrompt', 'batch-shot-saved', {
            episodeId, storyboardId: sb.id, en_len: freshEn.length, zh_len: (fresh?.videoPrompt || '').length,
          })
        } else {
          task.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: '落库后读回为空' })
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
