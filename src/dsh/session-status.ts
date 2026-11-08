// 全局会话状态表：把 host-wide `$events` 的审批/提问 waterfall 聚合成下拉行状态。
//
// - pending：approval/request → approval；user-questions/request → question，
//   其中首题 `intent.kind === 'plan-review'` → plan-review；
// - 应答/取消后由 events.ts 的 cleared 通知清除；
// - running：由调用方在拉 session.list 时 observe；true→false 记完成提醒；
// - subagents：目前沿用 session.list 若带的 runningSubagentCount（宿主未给则不显示）。
//
// 这是**真实数据源**；UI 只消费 `statusOf()` 的结果。
import { dshEvents, type DshAnyWaterfall } from './events'

export type PendingKind = 'approval' | 'plan-review' | 'question'

export interface SessionStatusView {
    pendingInteraction?: PendingKind
    running?: boolean
    completed?: boolean
    runningSubagentCount?: number
}

function pendingKindOf(event: DshAnyWaterfall): PendingKind | undefined {
    if (event.kind !== 'pending') return undefined
    if (event.event === 'approval/request') return 'approval'
    if (event.event !== 'user-questions/request') return undefined
    const questions = event.request?.['questions']
    const first = Array.isArray(questions) ? questions[0] : undefined
    const intent = first !== null && typeof first === 'object' ? (first as Record<string, unknown>)['intent'] : undefined
    const kind = intent !== null && typeof intent === 'object' ? (intent as Record<string, unknown>)['kind'] : undefined
    return kind === 'plan-review' ? 'plan-review' : 'question'
}

export class SessionStatusRegistry {
    private readonly pending = new Map<string, { kind: PendingKind; eventId: string }>()
    private readonly running = new Map<string, boolean>()
    private readonly completed = new Set<string>()
    private readonly eventIds = new Map<string, string>() // eventId → sessionId
    private started = false
    private unsubscribe: (() => void) | undefined

    start(): void {
        if (this.started) return
        this.started = true
        this.unsubscribe = dshEvents.subscribeAll((event) => this.apply(event))
    }

    /** 纯应用一条 waterfall（可单测；start() 只是把它接到全局事件流）。 */
    apply(event: DshAnyWaterfall): void {
        if (event.kind === 'cleared') {
            const sessionId = this.eventIds.get(event.eventId)
            this.eventIds.delete(event.eventId)
            // 只有**当前仍在等的那个 eventId** 被清才删；旧事件的迟到 cleared 不能误清新状态。
            if (sessionId !== undefined && this.pending.get(sessionId)?.eventId === event.eventId) {
                this.pending.delete(sessionId)
            }
            return
        }
        const kind = pendingKindOf(event)
        if (kind === undefined) return
        this.pending.set(event.agentId, { kind, eventId: event.eventId })
        this.eventIds.set(event.eventId, event.agentId)
    }

    dispose(): void {
        this.unsubscribe?.()
        this.unsubscribe = undefined
        this.started = false
    }

    /** 该会话当前是否有 pending（用于判断是否需要读 session/state）。 */
    hasPending(sessionId: string): boolean {
        return this.pending.has(sessionId)
    }

    /** 当前会话已打开：清掉“已完成”提醒（上游 completionUnread 在被查看后消失）。 */
    clearCompleted(sessionId: string): void {
        this.completed.delete(sessionId)
    }

    /** 用 `session/state` 的权威快照覆盖 pending/running（外部客户端应答后也能清掉）。 */
    applyState(sessionId: string, state: { running: boolean; pending?: PendingKind }): void {
        this.observeRunning(sessionId, state.running)
        if (state.pending === undefined) {
            this.pending.delete(sessionId)
        } else if (!(state.pending === 'question' && this.pending.get(sessionId)?.kind === 'plan-review')) {
            // state 只区分 approval/question；$events 已识别出的 plan-review 不被降级。
            this.pending.set(sessionId, { kind: state.pending, eventId: 'state' })
        }
    }

    /** 从 session.list 观察 running；true→false 记完成提醒。 */
    observeRunning(sessionId: string, running: boolean): void {
        const previous = this.running.get(sessionId)
        this.running.set(sessionId, running)
        if (running) {
            this.completed.delete(sessionId)
        } else if (previous === true) {
            this.completed.add(sessionId)
        }
    }

    statusOf(sessionId: string, fallbackRunning = false, subagents?: number): SessionStatusView {
        const pending = this.pending.get(sessionId)?.kind
        const running = this.running.get(sessionId) ?? fallbackRunning
        return {
            ...(pending === undefined ? {} : { pendingInteraction: pending }),
            running,
            ...(this.completed.has(sessionId) ? { completed: true } : {}),
            ...(typeof subagents === 'number' && subagents > 0 ? { runningSubagentCount: subagents } : {}),
        }
    }
}

/** 进程级单例（dshService 共用）。 */
export const sessionStatusRegistry = new SessionStatusRegistry()
