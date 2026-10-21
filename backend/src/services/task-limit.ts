/**
 * 生成任务并发闸（2026-10-16 加；用户报「一次点多了生成卡，App 卡顿」）
 *
 * 死因：`createTask` 里的 `processTask` 是 **fire-and-forget**（不 await）——
 *   批量生成 8 张卡时，批量端点虽然用 `for` 依次循环，但每轮只是**登记任务**，
 *   真正的生成立刻在后台跑起来 ⇒ **8 个请求同时发、8 张图同时下载落盘**。
 *   Electron 主进程里 UI 与 API 是同一个进程 ⇒ 事件循环与内存被挤爆（用户看到的卡顿）；
 *   而 服务器那边本来就是单卡串行排队，一起涌过去只是把队列和内存也撑满。
 *
 * 口径：
 *   - **按类型限流**：图片与视频各 2 —— 图片几十秒、视频十几分钟，混在一个闸里会让卡排队等视频；
 *   - **为什么是 2 不是 1**：一个在下载/落盘时另一个还能占着 GPU，吞吐不降反升；
 *   - 排队顺序 FIFO，**同类型内**先到先跑。
 *
 * ponytail: 全局计数 + 线性找队首，无优先级/取消/超时。真要优先级（比如「这一条先出」）再换正经队列。
 */

/** 每类任务同时在跑的上限（未列出的类型按 1，即串行） */
export const TASK_LIMIT: Record<string, number> = { image: 2, video: 2 }

const running: Record<string, number> = {}
const waiters: Array<{ type: string; start: () => void }> = []

/** 当前该类任务在跑几个（测试与日志用） */
export function runningCount(type: string): number {
  return running[type] ?? 0
}

/** 排队等位的任务数（测试用） */
export function waitingCount(type?: string): number {
  return type ? waiters.filter(w => w.type === type).length : waiters.length
}

/** 把任务交给闸：有空位就立刻跑，没有就排队（返回空 promise，不阻塞调用方） */
export function runLimited(type: string, job: () => Promise<void>): void {
  const limit = TASK_LIMIT[type] ?? 1
  if ((running[type] ?? 0) >= limit) {
    waiters.push({ type, start: () => launch(type, job) })
    return
  }
  launch(type, job)
}

function launch(type: string, job: () => Promise<void>): void {
  running[type] = (running[type] ?? 0) + 1
  // ⚠️ job() 可能**同步**抛错（不是返回 rejected promise）—— 那样就走不到 .finally，
  //    闸的计数永远减不回去，整条同类队列卡死（单测 `任务抛错不许卡死队列` 抓到的就是这个）。
  let p: Promise<void>
  try {
    p = job()
  } catch {
    release(type)
    return
  }
  p
    .catch(() => { /* 任务自身的失败由调用方记录日志，这里只负责放行下一位 */ })
    .finally(() => release(type))
}

function release(type: string): void {
  running[type] = Math.max(0, (running[type] ?? 1) - 1)
    const i = waiters.findIndex(w => w.type === type)
    if (i >= 0) {
      const [next] = waiters.splice(i, 1)
    next.start()
  }
}

/** 清空计数与队列（仅测试用；跑着的任务不受影响） */
export function __resetTaskLimit(): void {
  for (const k of Object.keys(running)) delete running[k]
  waiters.length = 0
}
