// 客户端节点模型 —— 只类型、零运行时。
//
// 目标：把「分组 / 可见性 / 折叠 / 块序」从宿主搬到客户端、按节点重发数据。
// 与上游 conversation-nodes + conversation/assembler 同构（事件 → 节点 → 排序 → 分组 → 折叠 → 可见性）。

import type { DshTodoItem } from '../../../../src/dsh/rows/types'

/** 合成锚点偏移：合成节点靠小数偏移插到既有事件之间（控制条 / 中断回答 / 超限通知 / 尾部动作条）。 */
export const CHAT_SYNTHETIC_SEQ_OFFSETS = {
    interruptedAssistant: -0.9,
    interruptedFollowup: -0.8,
    processControl: -0.1,
    maxTokensNotice: 0.05,
    finalizedFollowup: 0.1,
} as const

/** 会话事件（宿主保结构下发的原文；seq/turn/step/type/data 原样保留）。 */
export interface SessionEvent {
    seq: number
    time: number
    type: string
    data: Record<string, unknown>
    /** 实时增量帧（assistant-stream）的载荷：{ type, step, index, chunk }。 */
    frame?: Record<string, unknown>
    /** 表层操作：'append' 或 { op:'replace' }。结算类判据只认 append。 */
    surfaceOp?: unknown
}

/** 节点归属的回合/步（上游 `Location`）。 */
export interface ChatLocation {
    kind: 'turn' | 'step'
    turn: number
    step?: number
}

/** 视图节点（上游 `chatNode()`：key/kind/id/target/anchorSeq/location/visibility/data）。 */
export interface ChatNode {
    key: string
    kind: string
    id: string
    target: 'chat'
    anchorSeq: number
    /** 来源事件的时刻（epoch 毫秒，`SessionEvent.time`；合成节点取最近真实事件）。 */
    time: number
    location: ChatLocation
    visibility: 'visible' | 'hidden'
    data: Record<string, unknown>
}

/** 内容块（上游 `toAssistantBlock` 的产物；text/reasoning/image/tool-call/other）。 */
export type ChatBlock =
    | { kind: 'text'; text: string }
    | { kind: 'reasoning'; text: string }
    | { kind: 'image'; attachment: unknown }
    | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
    | { kind: 'other'; block: unknown }

/** 过程规格（上游 `processSpec`）。 */
export interface ProcessSpec {
    turn: number
    controlAnchorSeq: number
    processStartSeq: number
    answerAnchorSeq: number | null
    answerStep: number | null
    inlineReasoning: boolean
    messageCount: number
    toolCallCount: number
    subagentCount: number
}

/** 过程呈现（上游 `derivePresentation`）。 */
export interface ProcessPresentation {
    turn: number
    spec: ProcessSpec
    turnStarted: boolean
    turnClosed: boolean
    hasExternalProcess: boolean
    hasInterleavedInput: boolean
    compactAnswer: boolean
}

/** 过程组（上游 `ProcessGroup.snapshot`）。 */
export interface ProcessGroupSnapshot {
    key: string
    members: Array<{ kind: 'node'; key: string; groupPart?: string }>
    data: {
        turn: number
        closed: boolean
        summary: {
            counts: Array<{ kind: string; count: number }>
            running?: unknown
            runningDetail: string
        }
    }
}

/** 分组根的引用（上游 `rootEntries`）：一个节点根（可带 `groupPart`，如 `response`），或一个组。 */
export type GroupEntry =
    | { kind: 'node'; key: string; groupPart?: string }
    | { kind: 'group'; key: string }

/** 节点模型的构建产物。 */
export interface ChatNodeModel {
    /** 全部节点（含隐藏）。 */
    nodes: Map<string, ChatNode>
    /** 可见节点的排序（按 anchorSeq）。 */
    order: string[]
    /** 分组根引用（按序）。 */
    entries: GroupEntry[]
    /** 过程组快照。 */
    groups: ProcessGroupSnapshot[]
    /** 每回合的过程呈现。 */
    presentations: Map<number, ProcessPresentation>
    /** 每回合的起止时刻（turn/start、turn/end 的 time）+ 收官原因（非 completed 的 reason.kind）。 */
    turnTimes: Map<number, { startMs?: number; startSeq?: number; endMs?: number; closed?: boolean; status?: string }>
    /** 每回合的用量/计时统计（镜像宿主 buildStats：inputTokens/outputTokens/ttftSec/tps/wallSec…）。 */
    turnStats: Map<number, Record<string, unknown>>
    /** 每回合模型声明的交付文件（deliverables/presented，同路径留最后声明）。 */
    turnPresented: Map<number, Array<{ path: string; description?: string }>>
    /** 每回合的改动序号（workspace/changes 的 seq）。 */
    turnChanges: Map<number, number>
    /**
     * **任务清单写入 × 上一次清单**的配对（`todo_write` 调用 id → 它之前最近一次落盘的清单）。
     *
     * 少了它，`todo_write` 卡永远显示「首次记录」而网页端显示「与上次清单相比 · 新增 X…」
     * （真机 2026-10-16）。配对口径见 `./todo-baseline`。
     */
    todoBaselines: Map<string, DshTodoItem[] | null>
    /**
     * 折完这段事件后**最近一次落盘的清单**（`null` = 没有过）。
     *
     * 增量续折的**种子**：尾巴是从中途某条 `turn/start` 开始的切片，自己看不见更早的 `todo/write`，
     * 少了这个种子，尾巴里的 `todo_write` 会被配成 `null`（又退回「首次记录」）。见 `NodesCheckpoint.todoSeed`。
     */
    todoSeed: DshTodoItem[] | null
}
