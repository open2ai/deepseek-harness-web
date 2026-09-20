/**
 * 库对宿主 webview 通道的唯一抽象:
 *   post(msg)         = 发一条消息给宿主(等价 vscode.postMessage);
 *   onMessage(cb)     = 订阅宿主发来的消息(等价 window 'message' 监听);
 *   requestGoalAction = 目标条的动作(要等宿主回执的**请求-应答**,见下)。
 * 库内任何模块都不得直接调 acquireVsCodeApi() 或自己加 window 'message' 监听;
 * 一切收发只经注入的 ChatHost —— 这样同一个库可被 VS Code / sidex 等不同宿主复用。
 *
 * makeWindowMessageHost() 是"页面环境"下的实现:由入口(bootstrap)把 acquireVsCodeApi 的
 * postMessage 注入进来,并在页面**唯一一个** window 'message' 监听,向多个接收者扇出。
 */
export interface ChatHost {
  post(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): () => void
  /**
   * 目标条的动作请求（edit/pause/resume/clear），等宿主回 `goalActionResult`。
   *
   * 为什么需要"等回执"：这个动作**不是**乐观更新 —— 上游 `GoalBar` 也是 `await` 动作结果，
   * 失败时把 `message (code)` 内联显示在条上（`GoalBar.tsx:69`）。没有回执就没法区分
   * 「改了但投影还没到」与「被 CAS 拒了」。
   * @param action - 动作名
   * @param objective - 仅 edit 用
   * @returns 失败时 `{error}`；成功 `{}`（新的目标由投影帧带回来）
   */
  requestGoalAction(action: 'edit' | 'pause' | 'resume' | 'clear', objective?: string): Promise<{ error?: string }>
}

/** 页面实现:单一 window 监听、多接收者扇出。postMsg 通常为 vscode.postMessage。 */
export function makeWindowMessageHost(postMsg: (m: unknown) => void): ChatHost {
  const handlers = new Set<(msg: unknown) => void>()
  let wired = false
  /** 在飞的目标动作（key → 兑现器）。页面上同时只允许一个（按钮在飞时禁用），但按 key 配对更稳。 */
  const pendingGoal = new Map<string, (r: { error?: string }) => void>()
  let goalSeq = 0
  return {
    post: (m) => postMsg(m),
    onMessage(cb) {
      handlers.add(cb)
      if (!wired) {
        wired = true
        window.addEventListener('message', (e) => {
          const m = e.data as unknown
          // 目标动作回执先兑现 Promise（订阅者也会收到，互不影响）
          if (m !== null && typeof m === 'object' && (m as { type?: unknown }).type === 'goalActionResult') {
            const r = m as { key?: unknown; error?: unknown }
            const key = typeof r.key === 'string' ? r.key : undefined
            const settle = key === undefined ? undefined : pendingGoal.get(key)
            if (settle !== undefined && key !== undefined) {
              pendingGoal.delete(key)
              settle(typeof r.error === 'string' ? { error: r.error } : {})
            }
          }
          for (const h of [...handlers]) {
            h(m)
          }
        })
      }
      return () => {
        handlers.delete(cb)
      }
    },
    requestGoalAction(action, objective) {
      goalSeq += 1
      const key = `goal-${String(goalSeq)}`
      return new Promise<{ error?: string }>((resolve) => {
        // 宿主没回执（面板被关/服务挂了）时不能把按钮永久卡在禁用态：到点当失败处理
        const timer = setTimeout(() => {
          if (pendingGoal.delete(key)) {
            resolve({ error: '目标操作超时（宿主没有回执）' })
          }
        }, 10_000)
        pendingGoal.set(key, (r) => {
          clearTimeout(timer)
          resolve(r)
        })
        postMsg({ type: 'goalAction', key, action, ...(objective === undefined ? {} : { objective }) })
      })
    },
  }
}
