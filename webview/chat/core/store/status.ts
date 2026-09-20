// 会话状态切片：过渡态与宿主投影（会话统计 / token 用量 / plan / goal / 任务清单）。
// 动作只有三个：applyProjections / applyTodos / goalAction（目标条的动作要发帧给宿主）。
import { signal } from '@preact/signals'
import type { ContextBreakdown, ContextPressure, TodoItem } from '../protocol'
import type { ChatHost } from '../host'
import type { ChatStore, GoalView, SessionStatsView, TokenUsageView } from './types'

export interface StatusSlice {
  store: Pick<
    ChatStore,
    'busy' | 'sessionCwd' | 'sessionStats' | 'tokenUsage' | 'planState' | 'goalState' | 'todos' | 'contextFacts' | 'goalAction'
  >
  /** 由投影快照刷新会话统计、token 用量、plan 与 goal（形状见各派生函数）。 */
  applyProjections(proj: Record<string, unknown>): void
  /** 任务清单整表替换（宿主折叠好下发）；`null` = 没有清单。 */
  applyTodos(todos: readonly TodoItem[] | null | undefined): void
  /** 上下文占用两条投影（发送按钮左侧的环）：两条都没有 → null（整个环不渲染）。 */
  applyContext(pressure: ContextPressure | undefined, breakdown: ContextBreakdown | undefined): void
  reset(): void
}

export function createStatus(host: ChatHost): StatusSlice {
  const busy = signal<'loading' | 'switching' | null>(null)
  const sessionCwd = signal('')
  const sessionStats = signal<SessionStatsView | null>(null)
  const tokenUsage = signal<TokenUsageView | null>(null)
  const planState = signal<{ active: boolean; pending: boolean } | null>(null)
  const goalState = signal<GoalView | null>(null)
  /** 任务清单（输入框上方的常驻条）：空数组 = 没有清单，卡片整块不渲染 */
  const todos = signal<TodoItem[]>([])
  /** 上下文占用（发送按钮左侧的环）：两条投影都可能缺，都缺就整块不渲染 */
  const contextFacts = signal<{ pressure?: ContextPressure; breakdown?: ContextBreakdown } | null>(null)

  /** plan 投影：能力未组合则键缺失 → 保持 null。 */
  function derivePlanState(proj: Record<string, unknown>): { active: boolean; pending: boolean } | null {
    const p = proj['plan'] as { active?: boolean; pending?: boolean } | undefined
    return p && typeof p.active === 'boolean' ? { active: p.active, pending: !!p.pending } : null
  }

  /** goal 投影：null=无目标、缺键=能力未组合。形状按上游 GoalProjection{goal:{objective,phase,…}}，
   *  顺带兼容扁平 string/object 的旧/变体。**`id`/`revision` 必须带下来** —— 目标条的动作要拿
   *  它们做 CAS（上游 `GoalRef`，见宿主 `dshService.goalAction`）。 */
  function deriveGoalState(proj: Record<string, unknown>): GoalView | null {
    const rawGoal: unknown = proj['goal']
    let goalObj: string | undefined
    let goalPhase = ''
    let goalId: string | undefined
    let goalRevision: number | undefined
    let blocked: string | undefined
    if (typeof rawGoal === 'string') {
      goalObj = rawGoal || undefined
    } else if (rawGoal && typeof rawGoal === 'object') {
      const rec = rawGoal as Record<string, unknown>
      const nested = rec['goal']
      const src = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : rec
      const obj = src['objective']
      const ph = src['phase']
      const id = src['id']
      const rev = src['revision']
      if (typeof obj === 'string' && obj) goalObj = obj
      if (typeof ph === 'string') goalPhase = ph
      if (typeof id === 'string' && id !== '') goalId = id
      if (typeof rev === 'number' && Number.isFinite(rev)) goalRevision = rev
      // 受阻原因只在 blocked 时存在（上游 `GoalSnapshot.blockedReason?`）：挂成 title
      const reason = src['blockedReason'] as { message?: unknown } | undefined
      if (reason && typeof reason.message === 'string' && reason.message !== '') blocked = reason.message
    }
    return goalObj
      ? {
          objective: goalObj,
          phase: goalPhase,
          ...(goalId === undefined ? {} : { id: goalId }),
          ...(goalRevision === undefined ? {} : { revision: goalRevision }),
          ...(blocked === undefined ? {} : { blockedReason: blocked }),
        }
      : null
  }

  /**
   * 会话统计投影：只挑认识的数值字段（**原样保留、不做显示派生** —— 卡片要显示什么由组件算）。
   * 一个数值都没有 → null（当作"没有这项统计"，卡片不渲染）。
   */
  function deriveSessionStats(proj: Record<string, unknown>): SessionStatsView | null {
    const raw = proj['sessionStats']
    if (raw === null || typeof raw !== 'object') return null
    const rec = raw as Record<string, unknown>
    const out: SessionStatsView = {}
    for (const key of ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'] as const) {
      const v = rec[key]
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    }
    return Object.keys(out).length > 0 ? out : null
  }

  /** Token 用量投影：四个互斥桶原样取；全缺 → null。 */
  function deriveTokenUsage(proj: Record<string, unknown>): TokenUsageView | null {
    const raw = proj['tokenUsage']
    if (raw === null || typeof raw !== 'object') return null
    const rec = raw as Record<string, unknown>
    const out: TokenUsageView = {}
    for (const key of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      const v = rec[key]
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    }
    return Object.keys(out).length > 0 ? out : null
  }

  /**
   * 当前会话的**投影整表**（宿主 `session/control` 推来的那份）。
   *
   * 为什么不逐键存：宿主那边已经把整表算好了（上游客户端也是这个模型 —— `ProjectionValueStore`
   * 按 key 存完整值），页面再拆成逐键、又要为「缺键 = 能力未组合」各留一套分支，只会分叉口径。
   */
  let projectionValues: Record<string, unknown> = {}

  function applyProjections(proj: Record<string, unknown>): void {
    projectionValues = { ...proj }
    sessionStats.value = deriveSessionStats(projectionValues)
    tokenUsage.value = deriveTokenUsage(projectionValues)
    planState.value = derivePlanState(projectionValues)
    goalState.value = deriveGoalState(projectionValues)
  }

  function applyTodos(next: readonly TodoItem[] | null | undefined): void {
    // `null`/缺省（从未写过、或新一轮已开始）与空表同义：都是"没有清单可显示"
    todos.value = next === null || next === undefined ? [] : [...next]
  }

  function applyContext(pressure: ContextPressure | undefined, breakdown: ContextBreakdown | undefined): void {
    contextFacts.value =
      pressure === undefined && breakdown === undefined
        ? null
        : { ...(pressure === undefined ? {} : { pressure }), ...(breakdown === undefined ? {} : { breakdown }) }
  }

  /**
   * 目标条的动作：把动作交给宿主去打上游 goal RPC（宿主现读投影取 CAS 引用，见 `dshService.goalAction`）。
   *
   * 为什么不经 `/goal` 命令：命令要**下一轮**才被 agent 处理（白跑一次模型回合），而条上的按钮是即时操作
   * —— 上游 `ui-goal` 也是直接打 `ctx.remote.goals.*`。失败时宿主回 `{error}`，条内联显示。
   * @param action - edit（带 objective）/ pause / resume / clear
   * @returns 失败时 `{error: '<message> (<code>)'}`；成功 `{}`
   */
  function goalAction(
    action: 'edit' | 'pause' | 'resume' | 'clear',
    objective?: string
  ): Promise<{ error?: string }> {
    return host.requestGoalAction(action, objective)
  }

  function reset(): void {
    busy.value = null
    projectionValues = {}
    sessionStats.value = null
    tokenUsage.value = null
    planState.value = null
    goalState.value = null
    todos.value = []
    contextFacts.value = null
    // sessionCwd 不随会话清空：它标识的是工作区，换会话后同一工作区仍有效；
    // 工作区切换由宿主推新的 chatInfo 覆盖。
  }

  return {
    store: { busy, sessionCwd, sessionStats, tokenUsage, planState, goalState, todos, contextFacts, goalAction },
    applyProjections,
    applyTodos,
    applyContext,
    reset,
  }
}
