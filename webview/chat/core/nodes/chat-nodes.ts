// 客户端节点模型（事件 → 节点 → 排序 → 分组 → 折叠 → 可见性）—— 与上游 conversation-nodes + assembler 同构。
//
// 给定一窗保结构事件，产出节点序列、过程分组、折叠呈现与可见性。**纯函数**（不依赖 DOM / store），可脚本级验证。
// 全量重建版；流式增量见同文件底部的 `buildChatNodesIncremental`。
import {
    CHAT_SYNTHETIC_SEQ_OFFSETS,
    type ChatBlock,
    type ChatLocation,
    type ChatNode,
    type ChatNodeModel,
    type GroupEntry,
    type ProcessGroupSnapshot,
    type ProcessPresentation,
    type ProcessSpec,
    type SessionEvent,
} from './types'
import {
    blockIsVisible,
    displayFailure,
    hasAssistantReplyContent,
    isTokenDelta,
    toAssistantBlock,
    toAssistantBlocks,
} from './event-projection'
import { deriveTurnFacts, deriveTurnTokenUsage } from '../../../../src/dsh/official/turn-stats'
import { readToolResult } from '../../../../src/dsh/official/result-text'
import { processActivityOfNodes } from '../step-process-title'

// ---------- 时间线（镜像 `location-index.js` 的全量重建） ----------

interface StepTimeline { step: number; start?: { seq: number; time: number }; end?: { seq: number; time: number }; status: 'open' | 'closed' }
interface TurnTimeline {
    turn: number
    start?: { seq: number; time: number }
    end?: { seq: number; time: number }
    status: 'open' | 'closed'
    steps: Map<number, StepTimeline>
}
interface Timeline { turns: Map<number, TurnTimeline> }

function eventTurn(event: SessionEvent): number | undefined {
    const turn = event.data['turn']
    return typeof turn === 'number' ? turn : undefined
}

function eventStep(event: SessionEvent): number | undefined {
    const step = event.data['step']
    if (typeof step === 'number') return step
    const frameStep = event.frame?.['step']
    return typeof frameStep === 'number' ? frameStep : undefined
}

/** 边界事件（turn/step 开合）重建时间线。 */
function buildTimeline(events: readonly SessionEvent[]): Timeline {
    const turns = new Map<number, TurnTimeline>()
    const turnOf = (n: number): TurnTimeline => {
        let t = turns.get(n)
        if (t === undefined) { t = { turn: n, status: 'open', steps: new Map() }; turns.set(n, t) }
        return t
    }
    for (const event of events) {
        const turn = eventTurn(event)
        if (turn === undefined) continue
        const t = turnOf(turn)
        if (event.type === 'turn/start') {
            t.start = { seq: event.seq, time: event.time }
        } else if (event.type === 'turn/end') {
            t.end = { seq: event.seq, time: event.time }
            t.status = 'closed'
        } else if (event.type === 'step/start' || event.type === 'step/end') {
            const step = eventStep(event)
            if (step === undefined) continue
            let s = t.steps.get(step)
            if (s === undefined) { s = { step, status: 'open' }; t.steps.set(step, s) }
            if (event.type === 'step/start') s.start = { seq: event.seq, time: event.time }
            else { s.end = { seq: event.seq, time: event.time }; s.status = 'closed' }
        }
    }
    return { turns }
}

/** 节点归属的回合/步（上游 `locationOf`）。 */
function locationOf(event: SessionEvent): ChatLocation | undefined {
    const turn = eventTurn(event)
    if (turn === undefined) return undefined
    const step = eventStep(event)
    return step === undefined ? { kind: 'turn', turn } : { kind: 'step', turn, step }
}

/** 从实时/历史两种增量包装里取 chunk：`assistant-stream` 帧在 `frame.chunk`，其余在 `data.chunk`。 */
function chunkOf(event: SessionEvent): unknown {
    if (event.type === 'assistant-stream') return event.frame?.['chunk']
    return event.data['chunk']
}

/** 该事件是否「增量块」：实时帧（assistant-stream）或历史展开（assistant/chunk）或上游 wire（assistant/live-chunk）。 */
function isLiveChunk(event: SessionEvent): boolean {
    return event.type === 'assistant-stream' || event.type === 'assistant/chunk' || event.type === 'assistant/live-chunk'
}

// ---------- assistant-step 投影（镜像 `assistant.js`） ----------

interface AssistantState {
    turn: number
    step: number
    blocks: ChatBlock[]
    visibleBlocks: number
    firstVisibleSeq?: number
    firstVisibleTime?: number
    firstTokenTime?: number
    final?: { event: SessionEvent }
    usage?: unknown
}

function initialState(turn: number, step: number): AssistantState {
    return { turn, step, blocks: [], visibleBlocks: 0 }
}

function emptyAssistantBlock(blockType: unknown): ChatBlock {
    switch (blockType) {
        case 'text': return { kind: 'text', text: '' }
        case 'reasoning': return { kind: 'reasoning', text: '' }
        case 'tool-call': return { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
        default: return { kind: 'other', block: null }
    }
}

function countVisibleBlocks(blocks: readonly ChatBlock[]): number {
    let count = 0
    for (const block of blocks) if (blockIsVisible(block)) count += 1
    return count
}

/** 一个 chunk 折叠进该步的块数组（镜像 `updateChunk`）。 */
function updateChunk(state: AssistantState, chunk: Record<string, unknown>, seq: number, time: number): AssistantState {
    const blocks = [...state.blocks]
    let changedIndex = -1
    let previousVisible = false
    const type = chunk['type']
    const index = typeof chunk['index'] === 'number' ? chunk['index'] : 0
    switch (type) {
        case 'block-start':
            changedIndex = index
            previousVisible = blockIsVisible(blocks[index])
            blocks[index] = emptyAssistantBlock(chunk['blockType'])
            break
        case 'text-delta': {
            const previous = blocks[index]
            changedIndex = index
            previousVisible = blockIsVisible(previous)
            blocks[index] = { kind: 'text', text: (previous?.kind === 'text' ? previous.text : '') + String(chunk['text'] ?? '') }
            break
        }
        case 'reasoning-delta': {
            const previous = blocks[index]
            changedIndex = index
            previousVisible = blockIsVisible(previous)
            blocks[index] = { kind: 'reasoning', text: (previous?.kind === 'reasoning' ? previous.text : '') + String(chunk['text'] ?? '') }
            break
        }
        case 'tool-call-delta': {
            const previous = blocks[index]
            changedIndex = index
            previousVisible = blockIsVisible(previous)
            const base: ChatBlock = previous?.kind === 'tool-call' ? previous : { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
            blocks[index] = {
                kind: 'tool-call',
                callId: base.kind === 'tool-call' && base.callId !== '' ? base.callId : String(chunk['id'] ?? ''),
                name: chunk['name'] !== undefined ? String(chunk['name']) : (base.kind === 'tool-call' ? base.name : ''),
                argsRaw: (base.kind === 'tool-call' ? base.argsRaw : '') + String(chunk['argumentsDelta'] ?? ''),
            }
            break
        }
        case 'block-end':
            changedIndex = index
            previousVisible = blockIsVisible(blocks[index])
            blocks[index] = toAssistantBlock((chunk['block'] ?? {}) as Record<string, unknown>)
            break
        case 'usage':
            return { ...state, usage: chunk['usage'] }
        default:
            return state
    }
    const visibleBlocks = state.visibleBlocks - Number(previousVisible) + Number(blockIsVisible(blocks[changedIndex]))
    const firstToken = isTokenDelta(chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown })
    return {
        ...state,
        blocks,
        visibleBlocks,
        ...(visibleBlocks > 0 && state.firstVisibleSeq === undefined ? { firstVisibleSeq: seq, firstVisibleTime: time } : {}),
        ...(firstToken && state.firstTokenTime === undefined ? { firstTokenTime: time } : {}),
    }
}

/** 结算（镜像 `settleMessage`）：`assistant/message` 整条替换该步块数组。 */
function settleMessage(state: AssistantState, event: SessionEvent): AssistantState {
    const blocks = toAssistantBlocks(event.data['message'] === null || event.data['message'] === undefined ? [] : (event.data['message'] as { content?: unknown }).content)
    return {
        ...state,
        blocks,
        visibleBlocks: countVisibleBlocks(blocks),
        final: { event },
        usage: event.data['usage'],
    }
}

/** 重试重置（镜像 `resetForRetry`）：清块、保留首 token 时刻。 */
function resetForRetry(state: AssistantState): AssistantState {
    return { ...initialState(state.turn, state.step), firstTokenTime: state.firstTokenTime }
}

/** 定稿节点 / 中断合成节点（镜像 `finalNode`）。 */
function finalNodeOf(state: AssistantState, boundary?: { seq: number; time: number }): { seq: number; time: number; blocks: ChatBlock[]; messageId?: string; interrupted?: boolean; usage?: unknown } | undefined {
    const final = state.final
    if (final !== undefined && final.event.type === 'assistant/message') {
        const message = (final.event.data['message'] ?? {}) as { id?: unknown; content?: unknown }
        return {
            seq: final.event.seq,
            messageId: typeof message.id === 'string' ? message.id : undefined,
            time: final.event.time,
            blocks: toAssistantBlocks(message.content),
            usage: final.event.data['usage'],
            ...(final.event.data['interrupted'] === true ? { interrupted: true } : {}),
        }
    }
    if (boundary === undefined) return undefined
    const blocks = state.blocks.filter((b): b is ChatBlock => b !== undefined)
    if (blocks.length === 0) return undefined
    return { seq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant, time: boundary.time, blocks, interrupted: true }
}

// ---------- 过程事实（镜像 `turn-process.js`） ----------

interface ProcessState {
    turn: number
    assistantStartByStep: Map<number, number>
    messageCountByStep: Map<number, number>
    messageCount: number
    toolCallCount: number
    subagentCount: number
    otherStartSeq?: number
    controlAnchorSeq?: number
}

function freshProcessState(turn: number): ProcessState {
    return { turn, assistantStartByStep: new Map(), messageCountByStep: new Map(), messageCount: 0, toolCallCount: 0, subagentCount: 0 }
}

function isSubagentDelegationTool(name: unknown): boolean {
    return typeof name === 'string' && (name === 'subagent' || name.startsWith('subagent_'))
}

/** 该事件是否「可见 assistant 证据」（镜像 `visibleAssistantEvent`）。 */
function visibleAssistantEvent(event: SessionEvent): boolean {
    if (isLiveChunk(event)) {
        const chunk = chunkOf(event)
        return chunk !== null && typeof chunk === 'object' && (chunk as Record<string, unknown>)['type'] !== undefined
    }
    if (event.type === 'assistant/attempt') return false
    return event.type === 'assistant/message' && event.surfaceOp === 'append' &&
        hasAssistantReplyContent(toAssistantBlocks((event.data['message'] as { content?: unknown } | undefined)?.content))
}

function processEvidence(event: SessionEvent): { kind: 'assistant' | 'other'; seq: number; step?: number } | undefined {
    if (visibleAssistantEvent(event)) {
        if (!isLiveChunk(event) && event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
        const step = eventStep(event)
        return step === undefined ? { kind: 'assistant', seq: event.seq } : { kind: 'assistant', seq: event.seq, step }
    }
    if (event.type === 'tool/call' || (event.type === 'tool/result' && event.surfaceOp === 'append') || event.type === 'llm/retry') {
        return { kind: 'other', seq: event.seq }
    }
    return undefined
}

function updateProcessState(state: ProcessState, event: SessionEvent): ProcessState {
    let current = state
    if (event.type === 'assistant/message' && event.surfaceOp === 'append' && hasAssistantReplyContent(toAssistantBlocks((event.data['message'] as { content?: unknown } | undefined)?.content))) {
        const step = eventStep(event)
        if (step !== undefined) {
            const messageCountByStep = new Map(current.messageCountByStep)
            messageCountByStep.set(step, (messageCountByStep.get(step) ?? 0) + 1)
            current = { ...current, messageCountByStep, messageCount: current.messageCount + 1 }
        }
    }
    if (event.type === 'tool/call') {
        const subagent = isSubagentDelegationTool(event.data['name'])
        current = {
            ...current,
            toolCallCount: current.toolCallCount + (subagent ? 0 : 1),
            subagentCount: current.subagentCount + (subagent ? 1 : 0),
        }
    }
    const evidence = processEvidence(event)
    if (evidence === undefined) return current
    if (evidence.kind === 'other') {
        if (current.otherStartSeq !== undefined) return current
        return { ...current, otherStartSeq: evidence.seq, controlAnchorSeq: Math.min(current.controlAnchorSeq ?? Number.POSITIVE_INFINITY, evidence.seq) }
    }
    if (evidence.step === undefined || current.assistantStartByStep.has(evidence.step)) return current
    const assistantStartByStep = new Map(current.assistantStartByStep)
    assistantStartByStep.set(evidence.step, evidence.seq)
    return { ...current, assistantStartByStep, controlAnchorSeq: Math.min(current.controlAnchorSeq ?? Number.POSITIVE_INFINITY, evidence.seq) }
}

/** 末步是否为「回答」（镜像 `latestAnswer`）。 */
function latestAnswer(turn: TurnTimeline, states: Map<string, AssistantState>): { step: number; seq: number; blocks: ChatBlock[]; hasReasoning: boolean } | null {
    const lastStep = [...turn.steps.values()].at(-1)
    if (lastStep === undefined) return null
    const state = states.get(`${turn.turn}:${lastStep.step}`)
    if (state === undefined || state.final === undefined) return null
    if (!hasAssistantReplyContent(state.blocks)) return null
    if (state.blocks.some((b) => b.kind === 'tool-call')) return null
    const seq = state.final.event.type === 'assistant/message' ? state.final.event.seq : (state.firstVisibleSeq ?? state.final.event.seq)
    return { step: lastStep.step, seq, blocks: state.blocks, hasReasoning: state.blocks.some((b) => b.kind === 'reasoning' && b.text.trim() !== '') }
}

/** 过程规格（镜像 `processSpec`）。 */
function processSpecOf(ps: ProcessState, turn: TurnTimeline, states: Map<string, AssistantState>): ProcessSpec | null {
    const controlAnchorSeq = ps.controlAnchorSeq ?? turn.start?.seq
    if (controlAnchorSeq === undefined) return null
    const answer = latestAnswer(turn, states)
    const counts = {
        messageCount: answer === null ? ps.messageCount : [...ps.messageCountByStep].filter(([step]) => step < answer.step).reduce((total, [, count]) => total + count, 0),
        toolCallCount: ps.toolCallCount,
        subagentCount: ps.subagentCount,
    }
    if (answer === null) return { turn: turn.turn, controlAnchorSeq, processStartSeq: controlAnchorSeq, answerAnchorSeq: null, answerStep: null, inlineReasoning: false, ...counts }
    const inlineReasoning = answer.hasReasoning
    const earlierAssistantSeq = Math.min(...[...ps.assistantStartByStep].filter(([step]) => step < answer.step).map(([, seq]) => seq))
    const externalProcessSeq = Math.min(ps.otherStartSeq ?? Number.POSITIVE_INFINITY, earlierAssistantSeq)
    return {
        turn: turn.turn,
        controlAnchorSeq,
        processStartSeq: turn.start?.seq ?? (Number.isFinite(externalProcessSeq) ? externalProcessSeq : answer.seq),
        answerAnchorSeq: answer.seq,
        answerStep: answer.step,
        inlineReasoning,
        ...counts,
    }
}

// ---------- 可见性（镜像 `chat-visibility.js`） ----------

/** 该节点是否占一条可见行（镜像 `isVisibleChatNode`）。 */
export function isVisibleChatNode(node: ChatNode): boolean {
    if (node.visibility !== 'visible') return false
    if (node.kind === 'system-prompt') return false
    if (node.kind === 'context') {
        /**
         * ⚠️ **`content` 有两种形状，两种都要认**（2026-10-10 真机）：
         *   · 数组 —— 常见形态（`[{type:'text',…}]`）；
         *   · **单个块对象** —— 真窗口里就有这种注入（`{type:'tool-addition',…}`）。
         * 原先这里 `!Array.isArray(content) → false` 把后一种**整条判成不可见**：工具变更通知行不显示，
         * 更糟的是它会让下面 `turnNodeKeys` 的分组号错位（不可见节点仍占一个 `brand()`）。
         * 上游 `isVisibleChatNode` 读的是 `node.data.content`（类型上是块数组），插件这条路上两种都要容。
         */
        const content = node.data['content']
        const blocks = Array.isArray(content) ? content : content === null || content === undefined ? [] : [content]
        return blocks.some((block) => (block as { type?: unknown })?.type === 'tool-addition' || (block as { type?: unknown })?.type === 'tool-removal')
    }
    if (node.kind === 'command' && node.data['name'] === 'permission') return false
    return true
}

// ---------- 分组（镜像 `process-groups.js`） ----------

/**
 * 独立成行的节点种类（组在这七种节点处**断**，节点自己是一条顶层 entry）。
 *
 * ⚠️ **`command` / `manual-compaction` 曾经被塞进这个集合**（2026-10-09），当时是权宜之计：
 * 链上根本不认这两种 kind，落进 `pending` 就整条不渲染（可见命令行 `/plan`、`/compact` 会消失）。
 * 2026-10-10 复核后改正 —— 这两种是**普通过程成员**（节点各自有渲染器、与 `tool-call` 同一个座位），
 * 所以它们进 `pending`、落进片、跟着片折叠；**唯一的前提是链上认这两种 kind**
 * （`render-plan.ts` 的 `toChainItem`）—— 顺序反了就会重演"整条不渲染"。
 *
 * 另一张更宽的呈现层表见下面 `PRESENTATION_INDEPENDENT`：它管"哪些节点不参与回合级过程呈现"
 * （含 `system-prompt`/`turn-process`、不含 `model-retry`），与"分组在哪里断"是两件事，别混用。
 */
const INDEPENDENT = new Set(['user', 'steering', 'turn-trigger', 'model-retry', 'turn-error', 'turn-max-tokens', 'turn-tail'])
/** 呈现层独立集合：不含 `model-retry`（它仍算过程外置）、含 `system-prompt`/`turn-process`。 */
const PRESENTATION_INDEPENDENT = new Set(['system-prompt', 'user', 'steering', 'turn-trigger', 'turn-process', 'turn-error', 'turn-max-tokens', 'turn-tail'])

/**
 * **会话级节点的桶号**（「没有回合归属」的那些节点）。
 *
 * 位置本来有三态：`{turn, step}` / `{turn}` / **无回合**（命令行落在两条回合之间时就是第三种）。
 * 插件这边所有消费者都要一个数字回合号，于是选 0 当"不属于任何回合"
 * —— 真回合从 1 起（`turn/start.data.turn`），0 永远空着。
 *
 * 语义上等价于上游那种"没有回合"的位置：这些节点**不进任何片**、各自一条顶层 entry。
 */
const SESSION_BUCKET = 0

function reasoning(node: ChatNode): boolean {
    return node.kind === 'assistant-step' && (node.data['blocks'] as ChatBlock[] | undefined)?.some((b) => b.kind === 'reasoning' && b.text.trim() !== '') === true
}

/**
 * 该步是不是「带回答内容的步」—— 分组的收口点、也是行切段的边界。
 *
 * 判据就是 `hasAssistantReplyContent`（与同文件 `latestAnswer` 的"末步是不是回答"同源）：
 * **只要有一个非空白文本块就算**，哪怕这一步同时还在调工具（真机里 `[reasoning, text, tool-call]`
 * 这种"边说话边调工具"的步很常见，它们**是**收口点）。
 *
 * ⚠️ 别按"带工具调用就不算回答"去收紧这一条 —— 上游 `hasAssistantReplyContent` 明确只排除
 * reasoning 与 tool-call **块本身**，不排除"这一步里还有工具块"。曾按那个直觉改过一次，
 * 结果真机 349 个回合的片被切碎（`tmp/_groupalign.probe.mjs` 逐回合对照当场抓出来，已回退）。
 */
function reply(node: ChatNode): boolean {
    return node.kind === 'assistant-step' && hasAssistantReplyContent((node.data['blocks'] as ChatBlock[] | undefined) ?? [])
}

/** 一个回合的分组结果（镜像 `TurnGroups.rebuild`）。 */
function rebuildTurnGroups(turn: number, keys: readonly string[], nodes: Map<string, ChatNode>, turnClosed: boolean): { snapshots: ProcessGroupSnapshot[]; entries: GroupEntry[] } {
    const entries: GroupEntry[] = []
    const snapshots: ProcessGroupSnapshot[] = []
    /**
     * 待收口的成员。带上各自的 `turn`：**会话级成员（`turn === 0`）与真回合成员可能并进同一个
     * `pending`**（同一回合桶内不会混，但收口判据要能分辨），判据见 `flush`。
     */
    let pending: Array<{ kind: 'node'; key: string; turn: number; groupPart?: string }> = []
    let groupSeq = 0
    const brand = (): string => { groupSeq += 1; return `process:${turn}:${groupSeq}` }
    /**
     * 收口一组（镜像上游 `ProcessGroup.refresh`）：**组自己算活动汇总**，不是从回合级推。
     * 已关闭的组只留计数（`running`/`runningDetail` 清空），未关闭的组带上运行中活动与实时细节。
     */
    const flush = (closed: boolean): void => {
        if (pending.length === 0) return
        const members = pending
        pending = []
        /**
         * ⚠️ **会话级成员不成片**（2026-10-10，真机会话 1b9ce6f8 的两条 `/plan` 抓到的）。
         *
         * `turn === 0` 是插件给「不属于任何回合」选的下标（上游那种会话级位置没有回合号）。
         * 这种成员要是照常收成一张片，就会得到一个**没有任何行能接住**的 `{kind:'group'}` 入口：
         * `nodesToRows` 拿分组只当"成员已并进某条链"的记号（`consumed.add`）**不产行** ——
         * 于是命令行被"消费掉"却不渲染，整条消失（探针实测）。
         * 上游对这种节点的做法是**逐条顶层 entry**（`rootEntries`：`location.turn === undefined`
         * → `{kind:'node', key}`），这里等价：不发分组入口、不发快照，成员各自独立成行。
         */
        const synthetic = members.every((m) => (m.turn ?? turn) === SESSION_BUCKET)
        if (!synthetic) {
            const key = brand()
            const activity = processActivityOfNodes(
                members.map((m) => nodes.get(m.key)).filter((n): n is ChatNode => n !== undefined)
            )
            const isClosed = closed || turnClosed
            entries.push({ kind: 'group', key })
            snapshots.push({
                key,
                members,
                data: {
                    turn,
                    closed: isClosed,
                    summary: isClosed
                        ? { counts: activity.counts, runningDetail: '' }
                        : {
                            counts: activity.counts,
                            ...(activity.running === undefined ? {} : { running: activity.running }),
                            runningDetail: activity.runningDetail,
                            ...(activity.preparing === true ? { preparing: true } : {}),
                        },
                },
            })
            return
        }
        // 会话级成员：各自一条顶层 entry（`nodesToRows` 的 `case 'command'` 那条路出命令行/压缩标记）。
        for (const member of members) entries.push({ kind: 'node', key: member.key })
    }
    for (const key of keys) {
        const node = nodes.get(key)
        if (node === undefined) continue
        if (INDEPENDENT.has(node.kind)) {
            flush(true)
            entries.push({ kind: 'node', key })
        } else if (node.kind === 'turn-process') {
            /**
             * 控条自己那条顶层 entry —— **key 就是控条节点本身**。
             *
             * ⚠️ 别按"上游那句 `emit(pending[0]?.key ?? key, …)`"改成 `pending[0]?.key`：
             * ① 上游控条的**呈现位置**由 `presentationPosition` 里 `node.key === control.key` 那一支决定
             *    —— 认的就是**控条节点的 key**，所以这条 entry 指向的是控条自己；
             * ② 那句 `?? ` 是"离群收口"的兜底：控条排在**过程节点之后**时才轮到它，而那种次序下
             *    `pending` 必为空（`?? key` 生效）—— 真机 126 份日志里 pending 非空 0 次（扫过）。
             * ③ 插件这边 key 还兼作**路由**（`nodesToRows` 按 entry.key 取节点画那一行），
             *    用 `pending[0]` 会画成"成员节点自己一行"、控条那条行反而消失（2026-10-11 真撞过：
             *    修复锚点次序后，`1:1` 成了 entry key，于是 assistant 行整批不渲染）。
             */
            entries.push({ kind: 'node', key })
        } else if (node.kind === 'assistant-step') {
            if (reasoning(node)) pending.push({ kind: 'node', key, turn, groupPart: 'reasoning' })
            if (reply(node)) { flush(true); entries.push({ kind: 'node', key, groupPart: 'response' }) }
        } else {
            pending.push({ kind: 'node', key, turn })
        }
    }
    flush(false)
    return { snapshots, entries }
}

// ---------- 过程呈现（镜像 `turn-process-presentation.js`） ----------

/** 从该回合的可见节点派生呈现（镜像 `derivePresentation`）。 */
function derivePresentation(
    turn: TurnTimeline,
    spec: ProcessSpec,
    turnKeys: readonly string[],
    nodes: Map<string, ChatNode>
): ProcessPresentation {
    let openingHumanAnchor: number | undefined
    for (const key of turnKeys) {
        const node = nodes.get(key)
        if (node === undefined) continue
        if ((node.kind === 'user' || node.kind === 'steering' || node.kind === 'turn-trigger') && (spec.controlAnchorSeq === turn.start?.seq || node.anchorSeq < spec.controlAnchorSeq)) {
            openingHumanAnchor = Math.max(openingHumanAnchor ?? node.anchorSeq, node.anchorSeq)
        }
    }
    let hasExternalProcess = false
    let hasInterleavedInput = false
    let compactAnswer = true
    for (const key of turnKeys) {
        const node = nodes.get(key)
        if (node === undefined || !isVisibleChatNode(node) || node.kind === 'turn-process') continue
        if ((node.kind === 'user' || node.kind === 'steering' || node.kind === 'turn-trigger') && (openingHumanAnchor === undefined || node.anchorSeq > openingHumanAnchor)) {
            hasInterleavedInput = true
            if (spec.answerAnchorSeq === null || node.anchorSeq < spec.answerAnchorSeq) compactAnswer = false
        }
        if (PRESENTATION_INDEPENDENT.has(node.kind) || node.anchorSeq < spec.processStartSeq || (spec.answerAnchorSeq !== null && node.anchorSeq >= spec.answerAnchorSeq)) continue
        if (node.kind !== 'assistant-step' || spec.answerStep === null || (node.data['step'] as number) !== spec.answerStep) hasExternalProcess = true
    }
    return {
        turn: turn.turn,
        spec,
        turnStarted: turn.start !== undefined,
        turnClosed: turn.status === 'closed',
        hasExternalProcess,
        hasInterleavedInput,
        compactAnswer,
    }
}

// ---------- 其余节点种类（镜像 tool.js / turn-error.js / turn-max-tokens.js / turn-tail.js / command.js / compaction.js / retry.js / message.js） ----------

function isAppend(event: SessionEvent): boolean {
    return event.surfaceOp === undefined || event.surfaceOp === "append"
}

/** 从内容块数组里取纯文本（只认 text 块）。 */
function textOfBlocks(content: unknown): string {
    if (!Array.isArray(content)) return ""
    return content.map((b) => (b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("")
}

/** 压缩检查点（user/message 的替换型 + 源带 compactionId）。 */
function compactionCheckpoint(event: SessionEvent): { compactionId: string; sourceCommandId?: string } | undefined {
    if (event.type !== "user/message" || isAppend(event)) return undefined
    const source = event.data["source"]
    if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined
    const record = source as Record<string, unknown>
    const isCheckpoint = record["kind"] === "compact-checkpoint" || (record["kind"] === "plugin" && record["plugin"] === "compact")
    if (!isCheckpoint || typeof record["compactionId"] !== "string" || record["compactionId"] === "") return undefined
    return { compactionId: record["compactionId"], ...(typeof record["sourceCommandId"] === "string" ? { sourceCommandId: record["sourceCommandId"] } : {}) }
}

// --- tool-call（镜像 tool.js）：tool/call 开始、tool/result(append) 结算 ---
interface ToolCallRoot {
    phase: "preparing" | "start"
    callId: string
    name: string
    argsRaw?: string
    /** 嵌套调用（PTC 从 `run_code` 里派发的）：上游 `ToolCallBlock.subCalls` */
    subCalls?: ToolChildRoot[]
    parentCallId?: string
    turn: number
    step: number
    time: number
    seq: number
}
interface ToolResultRoot {
    kind: "tool-result"
    seq: number
    time: number
    callId: string
    call: { name: string; argsRaw?: string } | null
    content: unknown
    isError: boolean
    error?: unknown
    meta?: unknown
    /** 同上：嵌套调用（本轮从 `tool/ptc-dispatch*` 建出来） */
    subCalls?: ToolChildRoot[]
    parentCallId?: string
    turn: number
    step: number
}
type ToolRoot = ToolCallRoot | ToolResultRoot

/**
 * 嵌套调用块（上游 `StartedToolCall` / `ToolResultNode` 的结构子集，`tool/ptc-dispatch*` 建的）。
 * 形状与根块同构，只是多一个 `parentCallId`、且不再带回合/步（它属于父调用那一格）。
 */
/**
 * 嵌套调用块。**与上游同构**（别自创形状）：运行中是 `StartedToolCall`（`name`/`argsRaw` 在顶层），
 * 定稿是 `ToolResultNode`（名字在 **`call.name`** 里，顶层没有 `name`）。
 * `processActivityOfNodes` 的 `visit` 正是按这个分叉读名字的（与上游 `processActivity` 同）。
 */
interface ToolChildRoot {
    kind?: "tool-result"
    phase?: "start"
    callId: string
    parentCallId: string
    name?: string
    argsRaw?: string
    /** 定稿形态：与根块一致，`{ name, argsRaw }` */
    call?: { name: string; argsRaw?: string } | null
    seq: number
    time: number
    content?: unknown
    isError?: boolean
    error?: unknown
    subCalls?: ToolChildRoot[]
}

/** 上游 `jsonArguments`：参数原样透传，非字符串则序列化（缺失留空）。 */
function jsonArguments(value: unknown): string | undefined {
    if (typeof value === 'string') return value
    if (value === undefined) return undefined
    try {
        return JSON.stringify(value)
    } catch {
        return undefined
    }
}

function toolRootFromCall(event: SessionEvent): ToolCallRoot {
    if (event.type === "assistant/live-chunk") {
        const chunk = (event.data["chunk"] ?? {}) as Record<string, unknown>
        return { phase: "preparing", callId: String(chunk["id"] ?? ""), name: String(chunk["name"] ?? ""), turn: eventTurn(event) ?? 0, step: eventStep(event) ?? 0, time: event.time, seq: event.seq }
    }
    return { phase: "start", callId: String(event.data["callId"] ?? ""), name: String(event.data["name"] ?? ""), argsRaw: typeof event.data["arguments"] === "string" ? event.data["arguments"] : undefined, turn: eventTurn(event) ?? 0, step: eventStep(event) ?? 0, time: event.time, seq: event.seq }
}

/**
 * `tool/result` 事件 → 结果块。
 *
 * **载荷解包必须走官方的 `readToolResult`**，不能自己读 `message.content`：
 * 现行格式把结果包了一层 —— `message.content[0]` 是 `tool-result` 块，真正的展示内容在它的 `content` 里。
 * 自己读外层等于把**包装块**当内容，`resultText` 再把它 pretty-print 成 JSON，于是所有靠"结果文本形状"
 * 判定的卡全部失配（真机 2026-10-09 实测：`read` 20 条**全落通用卡**，读取卡的 `<path>…` 信封永远对不上）。
 * 宿主层一直用的是这个官方解包器，客户端这条路此前漏了。
 */
function toolResultFromEvent(event: SessionEvent, previous: ToolCallRoot | undefined): ToolResultRoot | undefined {
    const parsed = readToolResult(event.data as Record<string, unknown>)
    return {
        kind: "tool-result",
        seq: event.seq,
        time: event.time,
        callId: parsed.callId ?? "",
        call: previous === undefined ? null : { name: previous.name, ...(previous.argsRaw === undefined ? {} : { argsRaw: previous.argsRaw }) },
        content: parsed.blocks,
        isError: parsed.isError,
        ...(event.data["error"] === undefined ? {} : { error: event.data["error"] }),
        ...(event.data["meta"] === undefined ? {} : { meta: event.data["meta"] }),
        turn: eventTurn(event) ?? 0,
        step: eventStep(event) ?? 0,
    }
}

// --- turn-error（镜像 turn-error.js）---
function failureFrom(event: SessionEvent): { message: string; code?: string } | undefined {
    if (event.type !== "turn/end") return undefined
    const reason = (event.data["reason"] ?? {}) as Record<string, unknown>
    const reasonKind = reason["kind"]
    if (reasonKind === "error") return displayFailure(reason["error"] as unknown)
    if (reasonKind === "aborted") {
        const inner = (reason["reason"] ?? {}) as Record<string, unknown>
        if (inner["kind"] === "hook" && inner["reason"] === "deepseek-account/signed-out") return { message: "Stopped because you signed out of DeepSeek.", code: "ACCOUNT_SIGNED_OUT" }
    }
    return undefined
}

// --- turn-max-tokens（镜像 turn-max-tokens.js）---
function maxTokensFrom(event: SessionEvent): { seq: number; time: number; turn: number } | undefined {
    if (event.type !== "turn/end") return undefined
    const reason = (event.data["reason"] ?? {}) as Record<string, unknown>
    if (reason["kind"] !== "max-tokens") return undefined
    const turn = eventTurn(event)
    if (turn === undefined) return undefined
    return { seq: event.seq, time: event.time, turn }
}

// --- turn-tail（镜像 turn-tail.js）---
// --- command（镜像 command.js）---
function commandFromRun(event: SessionEvent): Record<string, unknown> {
    const data = event.data
    return { kind: "command", seq: event.seq, time: event.time, commandId: data["commandId"], name: data["name"], args: data["args"] ?? null, outcome: null }
}
function commandFromDone(event: SessionEvent, previous: Record<string, unknown> | undefined): Record<string, unknown> {
    const data = event.data
    return { kind: "command", seq: previous?.["seq"] ?? event.seq, time: previous?.["time"] ?? event.time, commandId: data["commandId"], name: previous?.["name"] ?? null, args: previous?.["args"] ?? null, outcome: { kind: data["kind"], ...(data["text"] === undefined ? {} : { text: data["text"] }) } }
}

// --- compaction（镜像 compaction.js 的 compactSummary）---
function compactSummary(match: SessionEvent | undefined, checkpoint: SessionEvent): Record<string, unknown> {
    let summary: string | null = null
    let shadowedItemCount: number | null = null
    let shadowedTokenCount: number | null = null
    if (match !== undefined && match.type === "compaction/summary") {
        const data = match.data
        if (Array.isArray(data["summary"])) {
            const text = (data["summary"] as Array<Record<string, unknown>>).map((b) => (b?.["type"] === "text" ? String(b["text"] ?? "") : "")).join("")
            summary = text.trim() === "" ? null : text
        }
        const shadowedSeqs = data["shadowedSeqs"]
        shadowedItemCount = Array.isArray(shadowedSeqs) && shadowedSeqs.every((s) => Number.isSafeInteger(s) && (s as number) >= 0) ? shadowedSeqs.length : null
        const tokens = data["shadowedTokenCount"]
        shadowedTokenCount = Number.isSafeInteger(tokens) && (tokens as number) >= 0 ? (tokens as number) : null
    }
    return { kind: "compaction", seq: checkpoint.seq, time: checkpoint.time, summary, summaryEventSeq: match?.seq ?? null, shadowedItemCount, shadowedTokenCount }
}

// --- model-retry（镜像 retry.js）---
interface RetryAttempt { kind: "model-retry"; seq: number; time: number; retryState: "scheduled" | "started" | "cancelled"; retry: number; retryId: string; turn?: number; step?: number; provider?: string; mode?: string; maxRetries?: number; delayMs?: number; failure?: unknown }

function scheduledRetryNode(event: SessionEvent): RetryAttempt | undefined {
    if (event.type !== "llm/retry") return undefined
    const data = event.data
    const retry = data["retry"]
    const turn = eventTurn(event)
    const step = eventStep(event)
    return { kind: "model-retry", seq: event.seq, time: event.time, retryState: "scheduled", retry: typeof retry === "number" ? retry : 0, retryId: String(data["retryId"] ?? ""), ...(turn === undefined ? {} : { turn }), ...(step === undefined ? {} : { step }), ...(typeof data["provider"] === "string" ? { provider: data["provider"] } : {}), ...(typeof data["mode"] === "string" ? { mode: data["mode"] } : {}), ...(Number.isSafeInteger(data["maxRetries"]) ? { maxRetries: data["maxRetries"] as number } : {}), ...(Number.isSafeInteger(data["delayMs"]) ? { delayMs: data["delayMs"] as number } : {}), ...(data["failure"] === undefined ? {} : { failure: data["failure"] }) }
}
// ---------- 组装（镜像 `assembler` 的全量重建版） ----------

/** 组装会话窗口为节点模型。 */
/** 每回合用量/计时（镜像宿主 `buildStats` 口径：inputTokens/outputTokens/ttftSec/tps/wallSec）。 */
function buildTurnStats(events: readonly SessionEvent[]): Map<number, Record<string, unknown>> {
    const out = new Map<number, Record<string, unknown>>()
    const like = events.map((e) => ({ type: e.type, time: e.time, data: e.data })) as unknown as Array<{ type: string; time?: number; data?: { turn?: unknown; usage?: Record<string, unknown> } }>
    const usage = deriveTurnTokenUsage(like)
    const facts = deriveTurnFacts(like)
    for (const turn of new Set<number>([...usage.keys(), ...facts.runMs.keys()])) {
        const o: Record<string, unknown> = {}
        const u = usage.get(turn)
        if (u !== undefined) {
            o.inputTokens = u.uncachedInputTokens
            o.outputTokens = u.outputTokens
            if (u.cacheReadTokens !== undefined) o.cacheReadTokens = u.cacheReadTokens
            if (u.cacheWriteTokens !== undefined) o.cacheWriteTokens = u.cacheWriteTokens
            if (u.reasoningTokens !== undefined) o.reasoningTokens = u.reasoningTokens
            if (u.routes !== undefined && u.routes.length === 1) { o.provider = u.routes[0].provider; o.model = u.routes[0].model }
        }
        const m = facts.metrics.get(turn)
        if (m?.ttftMs !== undefined) { const sec = m.ttftMs / 1000; o.ttftSec = sec < 10 ? Math.round(sec * 10) / 10 : Math.round(sec) }
        if (m?.tokensPerSecond !== undefined) { o.tps = m.tokensPerSecond < 10 ? Math.round(m.tokensPerSecond * 10) / 10 : Math.round(m.tokensPerSecond) }
        const rm = facts.runMs.get(turn)
        if (rm !== undefined) o.wallSec = rm / 1000
        if (Object.keys(o).length > 0) out.set(turn, o)
    }
    return out
}

/**
 * 顺序扫描事件，在**遇到每条 `user/message` 的那一刻**记下它是否被收件箱认领
 *（镜像上游 `message.ts` 的 `reader.previous('inbox-next-step'/'inbox-next-turn')`）。
 * 不能先整窗折完再判：后面的 claim 会覆盖前面的认领状态，真机上会让触发卡全丢。
 *
 * - `next-step` 认领 → 插话（steering）；
 * - `next-turn` 认领 → 唤醒本轮（waking，非 human 源升成 `turn-trigger`）；
 * - `idleSteer`：回合第 1 步里被 next-step 认领、而认领批不含人类 → 也算唤醒。
 */
function inboxClaimsByMessage(events: readonly SessionEvent[]): { steering: Set<string>; waking: Set<string> } {
    interface Msg { id: string; human: boolean }
    type Pending =
        | { kind: 'snapshot'; msgs: Msg[] }
        | { kind: 'splice'; previous: Pending; start: number; removedCount: number; inserted: Msg[] }
    const materialize = (state: Pending): Msg[] => {
        const splices: Array<Extract<Pending, { kind: 'splice' }>> = []
        let cur = state
        while (cur.kind === 'splice') { splices.push(cur); cur = cur.previous }
        const out = [...cur.msgs]
        for (const s of splices.reverse()) out.splice(s.start, s.removedCount, ...s.inserted)
        return out
    }
    const makeMsgs = (raw: unknown): Msg[] =>
        (Array.isArray(raw) ? raw : []).map((m) => {
            const rec = m as { id?: unknown; source?: { kind?: unknown } } | null | undefined
            return { id: typeof rec?.id === 'string' ? rec.id : '', human: rec?.source?.kind === 'user' }
        }).filter((m) => m.id !== '')
    interface Fold { pending: Pending; current: Set<string>; claimSeq: number; claimedHuman: boolean }
    const makeFold = (): Fold => ({ pending: { kind: 'snapshot', msgs: [] }, current: new Set<string>(), claimSeq: -1, claimedHuman: false })
    const folds: Record<string, Fold> = { 'next-step': makeFold(), 'next-turn': makeFold() }
    const steering = new Set<string>()
    const waking = new Set<string>()
    const turnStartSeq = new Map<number, number>()
    let curTurn = 0
    let curStep = 0
    for (const ev of events) {
        const d = ev.data as { target?: unknown; start?: unknown; removedCount?: unknown; inserted?: unknown; outcome?: unknown; turn?: unknown; step?: unknown; id?: unknown; source?: { kind?: unknown } } | undefined
        if (ev.type === 'turn/start') {
            if (typeof d?.turn === 'number') { curTurn = d.turn; curStep = 0; turnStartSeq.set(d.turn, ev.seq) }
            continue
        }
        if (ev.type === 'step/start') {
            if (typeof d?.step === 'number') curStep = d.step
            continue
        }
        if (ev.type === 'agent/inbox/spliced') {
            const fold = typeof d?.target === 'string' ? folds[d.target] : undefined
            if (fold === undefined || typeof d?.start !== 'number') continue
            const start = d.start
            const removedCount = typeof d.removedCount === 'number' ? d.removedCount : 0
            const inserted = makeMsgs(d.inserted)
            if (removedCount > 0 && d.outcome !== 'canceled') {
                const msgs = materialize(fold.pending)
                const claimed = msgs.splice(start, removedCount, ...inserted)
                fold.pending = { kind: 'snapshot', msgs }
                fold.current = new Set(claimed.map((m) => m.id))
                fold.claimSeq = ev.seq
                fold.claimedHuman = claimed.some((m) => m.human)
            } else {
                for (const m of inserted) fold.current.delete(m.id)
                fold.pending = { kind: 'splice', previous: fold.pending, start, removedCount, inserted }
            }
            continue
        }
        if (ev.type !== 'user/message') continue
        const id = typeof d?.id === 'string' ? d.id : ''
        if (id === '') continue
        const srcKind = typeof d?.source?.kind === 'string' ? d.source.kind : ''
        const nextStep = folds['next-step']
        const nextTurn = folds['next-turn']
        if (srcKind === 'user') {
            if (nextStep.current.has(id)) steering.add(id)
            continue
        }
        // idleSteer（镜像上游 message.ts）：回合第 1 步、该 turn 由 next-step 认领开始（next-turn 认领早于回合起点）、
        // 认领批不含人类，且本条在认领批里 —— 这三条一起才算「唤醒本轮」。
        const tStart = turnStartSeq.get(curTurn)
        const idleSteer = curStep === 1 && tStart !== undefined
            && nextStep.claimSeq > tStart && nextTurn.claimSeq < tStart
            && nextStep.claimedHuman === false && nextStep.current.has(id)
        if (nextTurn.current.has(id) || idleSteer) waking.add(id)
    }
    return { steering, waking }
}
export function buildChatNodes(events: readonly SessionEvent[]): ChatNodeModel {
    const timeline = buildTimeline(events)
    // 事件 seq → 时刻（合成节点靠最近真实事件的时刻）。
    const timeOfSeq = new Map<number, number>()
    for (const ev of events) timeOfSeq.set(ev.seq, ev.time)
    // 每回合起止时刻（turn/start、turn/end）+ 收官原因。
    const turnTimes = new Map<number, { startMs?: number; endMs?: number; closed?: boolean; status?: string }>()
    for (const [turn, t] of timeline.turns) {
        turnTimes.set(turn, { ...(t.start === undefined ? {} : { startMs: t.start.time, startSeq: t.start.seq }), ...(t.end === undefined ? {} : { endMs: t.end.time, closed: t.status === 'closed' }) })
    }
    // 收官原因（turn/end.reason.kind，非 completed 才记：对齐宿主 status 字段）。
    for (const ev of events) {
        if (ev.type !== 'turn/end') continue
        const turn = eventTurn(ev)
        if (turn === undefined) continue
        const kind = (ev.data['reason'] as { kind?: unknown } | undefined)?.kind
        if (typeof kind === 'string' && kind !== 'completed') {
            const cur = turnTimes.get(turn)
            if (cur !== undefined) cur.status = kind
        }
    }
    // 交付文件（deliverables/presented：同路径留最后声明，顺序按首见）。
    const turnPresented = new Map<number, Array<{ path: string; description?: string }>>()
    for (const ev of events) {
        if (ev.type !== 'deliverables/presented') continue
        const turn = typeof ev.data['turn'] === 'number' ? (ev.data['turn'] as number) : undefined
        if (turn === undefined || !Array.isArray(ev.data['files'])) continue
        const files = turnPresented.get(turn) ?? []
        for (const entry of ev.data['files'] as unknown[]) {
            const f = entry as { path?: unknown; description?: unknown } | null | undefined
            const p = typeof f?.path === 'string' ? f.path.trim() : ''
            if (p === '') continue
            const desc = typeof f?.description === 'string' ? f.description : undefined
            const at = files.findIndex((x) => x.path === p)
            if (at >= 0) files[at] = desc === undefined ? { path: p } : { path: p, description: desc }
            else files.push(desc === undefined ? { path: p } : { path: p, description: desc })
        }
        turnPresented.set(turn, files)
    }
    // 改动序号（workspace/changes 的 seq，按 turn）。
    const turnChanges = new Map<number, number>()
    for (const ev of events) {
        if (ev.type !== 'workspace/changes') continue
        const turn = typeof ev.data['turn'] === 'number' ? (ev.data['turn'] as number) : undefined
        if (turn !== undefined && typeof ev.seq === 'number') turnChanges.set(turn, ev.seq)
    }
    // 收件箱认领（按每条消息所在位置判）：next-step = 插话（steering）、next-turn = 唤醒本轮（waking）。
    const inboxClaims = inboxClaimsByMessage(events)
    // 每回合用量/计时（镜像宿主 buildStats 口径）。
    const turnStats = buildTurnStats(events)
    // 1. assistant-step：按 (turn, step) 累积块。
    const states = new Map<string, AssistantState>()
    const stepOrder: string[] = []
    const stateOf = (turn: number, step: number): AssistantState => {
        const key = `${turn}:${step}`
        let s = states.get(key)
        if (s === undefined) { s = initialState(turn, step); states.set(key, s); stepOrder.push(key) }
        return s
    }
    // 2. processState：每回合一个。
    const processStates = new Map<number, ProcessState>()
    const psOf = (turn: number): ProcessState => {
        let p = processStates.get(turn)
        if (p === undefined) { p = freshProcessState(turn); processStates.set(turn, p) }
        return p
    }
    let curTurn: number | undefined
    let curStep: number | undefined
    const locationBySeq = new Map<number, ChatLocation>()
    for (const event of events) {
        // 先推进边界，再用「事件自带 ?? 当前」取生效的 turn/step（实时增量帧不带 turn）。
        if (event.type === 'turn/start') { curTurn = eventTurn(event); curStep = undefined }
        if (event.type === 'step/start') { curTurn = eventTurn(event) ?? curTurn; curStep = eventStep(event) }
        /**
         * ⚠️ **边界事件要把游标清掉**（2026-10-10 修）：`step/end` 清 step、`turn/end` 清 turn+step
         *（`turn/start` 也清 step —— 新回合的第一步还没开始）。
         *
         * 于是**回合之外**的事件（命令行 `/plan`、`/compact`、压缩检查点这些都落在 `turn/end`
         * 与下一条 `turn/start` 之间）拿到的是「无回合归属」的位置。少了这两行，游标会一路带着
         * **上一个回合**的 turn/step：真机反例（会话 1b9ce6f8，`/plan`，seq=23 落在 `turn/end`(22)
         * 与 `turn/start`(27) 之间）插件把这条命令行判成「回合 1 第 1 步的成员」→ 它一旦不再是独立种类，
         * 就会被并进回合 1 的片、跟着片折叠（本该像会话级节点那样自己一行）。
         */
        if (event.type === 'step/end' && curStep === eventStep(event)) curStep = undefined
        if (event.type === 'turn/end' && curTurn === eventTurn(event)) { curTurn = undefined; curStep = undefined }
        const turn = eventTurn(event) ?? curTurn
        const step = eventStep(event) ?? curStep
        /** 位置恒有一条 —— 回合之外（`curTurn` 已清掉）记**会话级** `SESSION_BUCKET`。 */
        locationBySeq.set(event.seq, curTurn === undefined ? { kind: 'turn', turn: SESSION_BUCKET } : curStep === undefined ? { kind: 'turn', turn: curTurn } : { kind: 'step', turn: curTurn, step: curStep })
        if (isLiveChunk(event)) {
            if (turn !== undefined && step !== undefined) {
                const chunk = chunkOf(event)
                if (chunk !== null && typeof chunk === 'object') {
                    states.set(`${turn}:${step}`, updateChunk(stateOf(turn, step), chunk as Record<string, unknown>, event.seq, event.time))
                }
            }
        } else if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
            if (turn !== undefined && step !== undefined) {
                states.set(`${turn}:${step}`, settleMessage(stateOf(turn, step), event))
            }
        } else if (event.type === 'llm/retry') {
            if (turn !== undefined && step !== undefined) {
                const key = `${turn}:${step}`
                const existing = states.get(key)
                if (existing !== undefined) states.set(key, resetForRetry(existing))
            }
        }
        if (turn !== undefined) processStates.set(turn, updateProcessState(psOf(turn), event))
    }
    // 3. 建节点。
    const nodes = new Map<string, ChatNode>()
    const mkNode = (key: string, kind: string, id: string, anchorSeq: number, location: ChatLocation, visibility: 'visible' | 'hidden', data: Record<string, unknown>): void => {
        nodes.set(key, { key, kind, id, target: 'chat', anchorSeq, time: timeOfSeq.get(anchorSeq) ?? 0, location, visibility, data })
    }
    // 3.1 assistant-step 节点。
    for (const key of stepOrder) {
        const state = states.get(key)
        if (state === undefined) continue
        const loc: ChatLocation = { kind: 'step', turn: state.turn, step: state.step }
        const stepTimeline = timeline.turns.get(state.turn)?.steps.get(state.step)
        const boundary = stepTimeline?.end !== undefined ? { seq: stepTimeline.end.seq, time: stepTimeline.end.time } : timeline.turns.get(state.turn)?.end !== undefined ? { seq: timeline.turns.get(state.turn)?.end?.seq ?? state.turn, time: timeline.turns.get(state.turn)?.end?.time ?? 0 } : undefined
        const final = finalNodeOf(state, boundary)
        const blocks = final?.blocks ?? state.blocks.filter((b): b is ChatBlock => b !== undefined)
        const visible = final === undefined ? state.visibleBlocks > 0 : blocks.some(blockIsVisible)
        const anchorSeq = final?.interrupted === true ? final.seq : (state.firstVisibleSeq ?? final?.seq) ?? 0
        mkNode(key, 'assistant-step', key, anchorSeq, loc, visible ? 'visible' : 'hidden', {
            status: final?.interrupted === true ? 'interrupted' : final === undefined ? 'running' : 'settled',
            turn: state.turn, step: state.step, blocks, time: final?.time ?? state.firstVisibleTime ?? 0,
            ...(state.usage === undefined ? {} : { usage: state.usage }),
            ...(final === undefined ? {} : { finalNode: final }),
        })
    }
    // 3.2 turn-process 控制条节点（每 turn 一个；anchorSeq = controlAnchorSeq - .1）。
    for (const [turn, timelineTurn] of timeline.turns) {
        const ps = processStates.get(turn)
        const spec = ps === undefined ? null : processSpecOf(ps, timelineTurn, states)
        if (spec !== null) {
            const key = `turn-process:${turn}`
            mkNode(key, 'turn-process', String(turn), spec.controlAnchorSeq + CHAT_SYNTHETIC_SEQ_OFFSETS.processControl, { kind: 'turn', turn }, 'visible', { ...spec })
        }
    }
    // 3.3 user / steering / context / system-prompt（镜像 message.js + request-prompt.js）。
    for (const event of events) {
        if (event.type === 'user/message') {
            if (compactionCheckpoint(event) !== undefined) continue
            const source = event.data['source']
            const src = (source !== null && typeof source === 'object' ? source : {}) as Record<string, unknown>
            const isUser = src['kind'] === 'user'
            const turn = eventTurn(event)
            const loc = locationBySeq.get(event.seq) ?? locationOf(event) ?? { kind: 'turn', turn: turn ?? 0 }
            const text = textOfBlocks(event.data['content'])
            const messageId = String(event.data['id'] ?? '')
            // 插话/唤醒都只能从收件箱 splice 史判（镜像上游 message.js）：事件形状上区分不出。
            const steering = messageId !== '' && inboxClaims.steering.has(messageId)
            const key = `user:${event.seq}`
            if (isUser) {
                // data 必须带上 `source`：页面靠 `source.rpcId` 认领本地乐观行（丢了就闪）。
                // ⚠️ **`content` 也必须带上**（2026-10-11 修）：用户消息里的**图片/文件附件**只存在于
                // `data.content` 的块里，原先这里只留 `text` → 附件引用在**节点侧就丢了**，
                // 于是行模型两层都拿不到（真机现象：发出去的图片在会话区完全不显示）。
                // 与"非 human"那一支（下面的 trigger/context）保持同一形状。
                mkNode(key, steering ? 'steering' : 'user', String(event.seq), event.seq, loc as ChatLocation, 'visible', { text, content: event.data['content'], source })
            } else {
                // 非 human 的 user/message：context 态 + waking（next-turn 认领）→ turn-trigger 节点（触发卡）。
                const waking = messageId !== '' && inboxClaims.waking.has(messageId)
                mkNode(
                    waking ? `trigger:${event.seq}` : `context:${event.seq}`,
                    waking ? 'turn-trigger' : 'context',
                    String(event.seq), event.seq, loc as ChatLocation, 'visible',
                    { text, content: event.data['content'], source }
                )
            }
        } else if (event.type === 'system/message') {
            const turn = eventTurn(event)
            const loc = locationBySeq.get(event.seq) ?? locationOf(event) ?? { kind: 'turn', turn: turn ?? 0 }
            mkNode(`sysprompt:${event.seq}`, 'system-prompt', String(event.seq), event.seq, loc as ChatLocation, 'visible', { text: textOfBlocks(event.data['content']) })
        }
    }
    // 3.4 tool-call 节点（镜像 tool.js）：tool/call 开始、tool/result(append) 结算。
    const toolStates = new Map<string, ToolRoot>()
    /** 父调用 id → 它的嵌套调用（`tool/ptc-dispatch*` 建的；根块与子块都可能当父）。 */
    const toolChildren = new Map<string, ToolChildRoot[]>()
    for (const event of events) {
        if (event.type === 'assistant/live-chunk') {
            const chunk = (event.data['chunk'] ?? {}) as Record<string, unknown>
            if (chunk['type'] === 'tool-call-delta' && chunk['name'] !== undefined) {
                const callId = String(chunk['id'] ?? '')
                if (!toolStates.has(callId)) toolStates.set(callId, toolRootFromCall(event))
            }
        } else if (event.type === 'tool/call') {
            const callId = String(event.data['callId'] ?? '')
            toolStates.set(callId, toolRootFromCall(event))
        } else if (event.type === 'tool/result' && isAppend(event)) {
            const message = (event.data['message'] ?? {}) as Record<string, unknown>
            const source = (message['source'] ?? {}) as Record<string, unknown>
            const callId = String(source['callId'] ?? '')
            const prev = toolStates.get(callId)
            const prevCall = prev !== undefined && (prev as ToolCallRoot).phase !== undefined ? prev as ToolCallRoot : undefined
            const result = toolResultFromEvent(event, prevCall)
            if (result !== undefined) toolStates.set(callId, result)
        } else if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
            // 嵌套调用（镜像上游 `tool.js` 的 `updateDispatch`）：PTC 从 `run_code` 里派发的工具**不是**根节点，
            // 它们挂在父块的 `subCalls` 上。事件带 `parentCallId`/`subCallId`/`name`/`arguments`（定稿还带 content）。
            const parentCallId = String(event.data['parentCallId'] ?? '')
            const subCallId = String(event.data['subCallId'] ?? '')
            if (parentCallId !== '' && subCallId !== '') {
                const siblings = toolChildren.get(parentCallId) ?? []
                const at = siblings.findIndex((child) => child.callId === subCallId)
                const name = String(event.data['name'] ?? '')
                const settled = event.type === 'tool/ptc-dispatch'
                const argsRaw = jsonArguments(event.data['arguments'])
                const child: ToolChildRoot = settled
                    ? {
                        // 上游 `childResult`：定稿块的调用信息在 `call` 里（`name`/`argsRaw`）
                        kind: 'tool-result', callId: subCallId, parentCallId,
                        call: { name, ...(argsRaw === undefined ? {} : { argsRaw }) },
                        seq: event.seq, time: event.time, content: event.data['content'] ?? [],
                        isError: event.data['isError'] === true,
                        ...(event.data['error'] === undefined ? {} : { error: event.data['error'] }),
                    }
                    : {
                        // 上游 `childCall`：运行中的块名字在顶层
                        phase: 'start', callId: subCallId, parentCallId, name,
                        ...(argsRaw === undefined ? {} : { argsRaw }),
                        seq: event.seq, time: event.time,
                    }
                toolChildren.set(parentCallId, at < 0 ? [...siblings, child] : siblings.map((c, index) => (index === at ? child : c)))
            }
        }
    }
    // 把子调用挂回各自的父块（上游 `projectBlock` 的那一步；父块可能是根，也可能是另一个子块）。
    if (toolChildren.size > 0) {
        const attach = (child: ToolChildRoot): ToolChildRoot => {
            const kids = toolChildren.get(child.callId)
            return kids === undefined ? child : { ...child, subCalls: kids.map(attach) }
        }
        for (const [callId, children] of toolChildren) {
            const parent = toolStates.get(callId)
            if (parent !== undefined) toolStates.set(callId, { ...parent, subCalls: children.map(attach) } as ToolRoot)
        }
    }
    for (const [callId, root] of toolStates) {
        const turn = (root as { turn: number }).turn
        const step = (root as { step: number }).step
        const loc: ChatLocation = { kind: 'step', turn, step }
        const anchor = (root as ToolCallRoot).phase !== undefined ? (root as ToolCallRoot).seq : (root as ToolResultRoot).seq
        mkNode(`tool:${callId}`, 'tool-call', callId, anchor, loc, 'visible', { root })
    }
    // 3.5 turn-error / turn-max-tokens / turn-tail（镜像 turn-error.js / turn-max-tokens.js / turn-tail.js）。
    for (const [turn, timelineTurn] of timeline.turns) {
        const lastStep = [...timelineTurn.steps.values()].at(-1)?.step ?? 0
        let failure: { message: string; code?: string } | undefined
        for (const event of events) {
            if (eventTurn(event) !== turn) continue
            const f = failureFrom(event)
            if (f !== undefined) failure = f
        }
        if (failure !== undefined && timelineTurn.end !== undefined) {
            mkNode(`turn-error:${turn}`, 'turn-error', String(turn), timelineTurn.end.seq, { kind: 'turn', turn }, 'visible', { seq: timelineTurn.end.seq, time: timelineTurn.end.time, turn, step: lastStep, message: failure.message, ...(failure.code === undefined ? {} : { code: failure.code }) })
        }
        for (const event of events) {
            if (eventTurn(event) !== turn) continue
            const mt = maxTokensFrom(event)
            if (mt !== undefined) {
                mkNode(`turn-max-tokens:${turn}`, 'turn-max-tokens', String(turn), mt.seq, { kind: 'turn', turn }, 'visible', { seq: mt.seq, time: mt.time, turn, step: lastStep })
            }
        }
        if (timelineTurn.end !== undefined) {
            const finalized = [...timelineTurn.steps.values()]
                .map((s) => nodes.get(`${turn}:${s.step}`)?.data)
                .filter((d): d is Record<string, unknown> => d !== undefined && d['finalNode'] !== undefined)
                .sort((a, b) => ((a['finalNode'] as { seq: number }).seq) - ((b['finalNode'] as { seq: number }).seq))
            const closing = finalized.findLast((d) => {
                const fn = d['finalNode']
                const blocks = d['blocks']
                return fn !== undefined && Array.isArray(blocks) && blocks.some((b) => (b as { kind?: unknown; text?: unknown }).kind === 'text' && String((b as { text?: unknown }).text ?? '').trim() !== '')
            }) ?? null
            // 上游 `latestTranscriptSeq`：最后一条定稿回答的 seq，与工具/错误/重试里最大的 seq 取大者。
            // 分叉只允许从**本回合最后的内容**出发：closing 之后还有内容（工具结果/重试）时 branchUnavailable。
            const lastFinalized = finalized.at(-1)
            let latestTranscriptSeq = lastFinalized?.['finalNode'] !== undefined ? (lastFinalized['finalNode'] as { seq: number }).seq : undefined
            for (const event of events) {
                if (eventTurn(event) !== turn) continue
                const reasonKind = (event.data['reason'] as Record<string, unknown> | undefined)?.['kind']
                const candidate = event.type === 'tool/call' || (event.type === 'tool/result' && isAppend(event)) || (event.type === 'turn/end' && reasonKind === 'error') || event.type === 'llm/retry' ? event.seq : undefined
                if (candidate !== undefined && (latestTranscriptSeq === undefined || candidate > latestTranscriptSeq)) latestTranscriptSeq = candidate
            }
            const closingSeq = closing === null ? undefined : (closing['finalNode'] as { seq: number }).seq
            const branchUnavailable = closing === null || (closingSeq !== undefined && latestTranscriptSeq !== closingSeq)
            mkNode(`turn-tail:${turn}`, 'turn-tail', String(turn), timelineTurn.end.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup, { kind: 'turn', turn }, 'visible', { turn, seq: timelineTurn.end.seq, time: timelineTurn.end.time, closing: closing === null ? null : closing['finalNode'], branchUnavailable })
        }
    }
    // 3.6 command / compaction / model-retry（镜像 command.js / compaction.js / retry.js）。
    const commandStates = new Map<string, Record<string, unknown>>()
    const compactionCheckpoints = new Map<string, SessionEvent>()
    const compactionSummaries = new Map<string, SessionEvent>()
    // 手动压缩（/compact）的检查点/摘要按 sourceCommandId（= commandId）存，折进 manual-compaction 节点。
    const manualCheckpoints = new Map<string, SessionEvent>()
    const manualSummaries = new Map<string, SessionEvent>()
    const retryStates = new Map<string, RetryAttempt[]>()
    for (const event of events) {
        if (event.type === 'command/run') {
            const id = String(event.data['commandId'] ?? '')
            if (id !== '') commandStates.set(id, commandFromRun(event))
        } else if (event.type === 'command/done') {
            const id = String(event.data['commandId'] ?? '')
            if (id !== '') commandStates.set(id, commandFromDone(event, commandStates.get(id)))
        }
        const cp = compactionCheckpoint(event)
        if (cp !== undefined) {
            if (cp.sourceCommandId === undefined) compactionCheckpoints.set(cp.compactionId, event)
            else manualCheckpoints.set(cp.sourceCommandId, event)
        }
        if (event.type === 'compaction/summary') {
            const id = String(event.data['compactionId'] ?? '')
            const sourceCommandId = event.data['sourceCommandId']
            if (typeof sourceCommandId === 'string' && sourceCommandId !== '') manualSummaries.set(sourceCommandId, event)
            else if (id !== '') compactionSummaries.set(id, event)
        }
        if (event.type === 'llm/retry') {
            const retryId = String(event.data['retryId'] ?? '')
            if (retryId !== '') {
                const node = scheduledRetryNode(event)
                if (node !== undefined) {
                    const arr = retryStates.get(retryId) ?? []
                    arr.push(node)
                    retryStates.set(retryId, arr)
                }
            }
        } else if (event.type === 'llm/retry-started') {
            const retryId = String(event.data['retryId'] ?? '')
            const retry = event.data['retry']
            const arr = retryStates.get(retryId)
            if (arr !== undefined) {
                retryStates.set(retryId, arr.map((a) => a.retry === retry ? { ...a, retryState: 'started' as const } : a))
            }
        }
    }
    for (const [id, command] of commandStates) {
        const seq = command['seq'] as number
        const loc = locationBySeq.get(seq) ?? { kind: 'turn', turn: 0 }
        const name = command['name']
        if (name === 'compact') {
            // 手动压缩：把检查点 + 摘要折进节点（上游 manual-compaction 的 data = { command, compaction }）
            const checkpoint = manualCheckpoints.get(id)
            const summary = manualSummaries.get(id)
            const compaction = checkpoint === undefined ? null : compactSummary(summary, checkpoint)
            mkNode(`command:${id}`, 'manual-compaction', id, compaction === null ? seq : (compaction['seq'] as number), loc as ChatLocation, 'visible', { command, compaction })
        } else {
            mkNode(`command:${id}`, 'command', id, seq, loc as ChatLocation, 'visible', command)
        }
    }
    for (const [compactionId, checkpoint] of compactionCheckpoints) {
        const summary = compactionSummaries.get(compactionId)
        const marker = compactSummary(summary, checkpoint)
        const seq = marker['seq'] as number
        const loc = locationBySeq.get(seq) ?? { kind: 'turn', turn: 0 }
        mkNode(`compaction:${compactionId}`, 'compaction', compactionId, seq, loc as ChatLocation, 'visible', marker)
    }
    for (const [retryId, attempts] of retryStates) {
        const first = attempts[0]
        if (first === undefined) continue
        const anchor = first.seq
        const loc: ChatLocation = first.turn !== undefined ? { kind: 'step', turn: first.turn, step: first.step ?? 0 } : { kind: 'turn', turn: 0 }
        mkNode(`retry:${retryId}`, 'model-retry', retryId, anchor, loc, 'visible', { attempts, current: attempts.at(-1) })
    }
    // 4. 排序 + 分组 + 呈现。
    const order = [...nodes.values()].filter(isVisibleChatNode).sort((a, b) => a.anchorSeq - b.anchorSeq).map((n) => n.key)
    // 按 turn 收节点（保持全局 order 的位置序）。
    const turnNodeKeys = new Map<number, string[]>()
    for (const key of order) {
        const node = nodes.get(key)
        if (node === undefined) continue
        // ⚠️ **不可见节点一律不进这张表**（`order` 已经滤过一道，这里是给 `buildAssistantRows` 用的第二道）：
        // 与上游 `ProcessGroup.refresh(nodes, visible)` 同口径 —— 它算活动汇总时喂的就是**可见**节点。
        // 少了这一道，一条「只含不可见注入」的 context 节点会占住分组的 `pending` 槽：
        //   · 它自己进不了链（`toChainItem` 返回 undefined）；
        //   · **排在它后面的过程成员被并进同一片**，而这一片随后被回答步的 `flush(true)` 收成
        //     `groupPart: 'response'` 组 —— 那一组的成员不进链 → 工具行、注入行整批消失；
        //   · 它还会**占掉一个分组号**（`brand()` 自增），把后面的 `process:1:2` 顶成 `1:3`，
        //     分组 key 跟着漂（2026-10-10 守卫抓到的形状）。
        if (!isVisibleChatNode(node)) continue
        const t = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn : undefined
        if (t === undefined) continue
        const arr = turnNodeKeys.get(t) ?? []
        arr.push(key)
        turnNodeKeys.set(t, arr)
    }
    // 每回合分组 + 根引用；再按全局 order 拼 entries（每个回合在它首个节点处插入该回合的根引用）。
    const turnEntries = new Map<number, GroupEntry[]>()
    const groups: ProcessGroupSnapshot[] = []
    for (const [turn, keys] of turnNodeKeys) {
        const result = rebuildTurnGroups(turn, keys, nodes, timeline.turns.get(turn)?.status === 'closed')
        groups.push(...result.snapshots)
        turnEntries.set(turn, result.entries)
    }
    const entries: GroupEntry[] = []
    const emittedTurns = new Set<number>()
    for (const key of order) {
        const node = nodes.get(key)
        if (node === undefined) continue
        const raw = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn : undefined
        /**
         * ⚠️ **会话级节点（没有回合归属）逐条发成顶层 entry —— 就是上游的做法**。
         *
         * 上游的节点模型里没有"会话级"这一说：`location-index` 对**没有回合归属**的事件不建 location，
         * 分组的 `rebuild` 只走"按回合分桶"的节点，`rootEntries` 对它们的处理就是
         * `{ kind: 'node', key }` **一条一个**（没有片、没有分组入口）。
         *
         * 插件这边「没有回合」记成 `SESSION_BUCKET`（见该常量）。**别让它走分桶那条路** ——
         * 2026-10-09 那版就是照表面写法收片的，真机结果（会话 1b9ce6f8，两条 `/plan`）：
         * 得到一个**没有 assistant 行去接**的 `{kind:'group'}` 入口 → 命令行被 `consumed` 掉、
         * 一条都不渲染。所以这里把它与"不在真回合表里"同等处理，直接发节点本身。
         */
        const t = raw === undefined || raw === SESSION_BUCKET ? undefined : raw
        const turnEntriesOf = t === undefined ? undefined : turnEntries.get(t)
        if (turnEntriesOf === undefined) { entries.push({ kind: 'node', key }); continue }
        if (emittedTurns.has(t as number)) continue
        emittedTurns.add(t as number)
        entries.push(...turnEntriesOf)
    }
    const presentations = new Map<number, ProcessPresentation>()
    for (const [turn, timelineTurn] of timeline.turns) {
        const ps = processStates.get(turn)
        if (ps === undefined) continue
        const spec = processSpecOf(ps, timelineTurn, states)
        if (spec === null) continue
        presentations.set(turn, derivePresentation(timelineTurn, spec, turnNodeKeys.get(turn) ?? [], nodes))
    }
    // 呈现层不发布会话级那一桶（`turn: 0`）的分组：它没有回合级 `presentations`，也没人认领。
    return { nodes, order, entries, groups, presentations, turnTimes, turnStats, turnPresented, turnChanges }
}

/** 增量折叠的断点：`prefix` = 最后一条 `turn/start` **之前**已定稿的完整模型；
 * `tailStart` = 那条 `turn/start` 的下标。流式只在**同一回合**内追加时走增量（只重折尾巴），
 * 一旦新 `turn/start` 到来（回合边界，可能牵动 command/compaction/retry 的跨回合配对）就退回全量重建。 */
export interface NodesCheckpoint {
    tailStart: number
    windowHeadSeq: number | undefined
    windowLen: number
    prefix: ChatNodeModel
}

function mergeModels(a: ChatNodeModel, b: ChatNodeModel): ChatNodeModel {
    return {
        nodes: new Map([...a.nodes, ...b.nodes]),
        order: [...a.order, ...b.order],
        entries: [...a.entries, ...b.entries],
        groups: [...a.groups, ...b.groups],
        presentations: new Map([...a.presentations, ...b.presentations]),
        turnTimes: new Map([...a.turnTimes, ...b.turnTimes]),
        turnStats: new Map([...a.turnStats, ...b.turnStats]),
        turnPresented: new Map([...a.turnPresented, ...b.turnPresented]),
        turnChanges: new Map([...a.turnChanges, ...b.turnChanges]),
    }
}

/** 增量建节点：与 `buildChatNodes` 等价（守卫逐事件比对），但流式期间只重折当前回合。 */
export function buildChatNodesIncremental(events: readonly SessionEvent[], checkpoint?: NodesCheckpoint): { model: ChatNodeModel; checkpoint: NodesCheckpoint | undefined } {
    let lastTurnStart = -1
    for (let i = 0; i < events.length; i += 1) {
        if (events[i]?.type === 'turn/start') lastTurnStart = i
    }
    const windowHeadSeq = events[0]?.seq
    const windowLen = events.length
    const usable =
        checkpoint !== undefined &&
        lastTurnStart === checkpoint.tailStart &&
        events[checkpoint.tailStart]?.type === 'turn/start' &&
        windowHeadSeq === checkpoint.windowHeadSeq &&
        windowLen >= checkpoint.windowLen
    if (usable && checkpoint !== undefined) {
        const tail = buildChatNodes(events.slice(checkpoint.tailStart))
        const model = mergeModels(checkpoint.prefix, tail)
        return { model, checkpoint: { tailStart: lastTurnStart, windowHeadSeq, windowLen, prefix: checkpoint.prefix } }
    }
    const model = buildChatNodes(events)
    // `prefix` = 最后一条 `turn/start` 之前（已定稿回合）的模型，供**后续帧**续折用。
    //
    // ⚠️ **2026-10-12 去掉一次重复折叠**：原先这里是 `buildChatNodes(events.slice(0, lastTurnStart))`，
    // 即"断点不可用"这条路上**连折两遍全量**（`model` 已是全量；`prefix` 还要再折一遍前缀）。
    // 实测在 92 万事件的真会话上，这条路的耗时是纯全量的 **2 倍**（12.9s vs 6.5s）——
    // 而"加载更早"（前插 → 窗口头变 → 断点必然不可用）每次都走这条路，正是维护者看到的"点了没反应"。
    //
    // 切法与 `foldChatNodes(events)` 的口径一致：**顺序折叠只产出"到此为止"的东西**，
    // 所以按**位次**切就能复现"折到断点前"的产物 —— 节点与条目按 `order` 里的位次切，
    // 回合级表（`presentations`/`turnTimes`/`turnStats`/`turnPresented`/`turnChanges`）按回合号切。
    // 不按 `anchorSeq` 过滤：那里存在并列与"开局输入拉齐"，用它当界限会漏（我第一版就写错了）。
    const prefix = ((): ChatNodeModel => {
        if (lastTurnStart < 0) {
            return model
        }
        const cutTurn = events[lastTurnStart]?.data?.['turn']
        const before = (key: string): boolean => {
            const t = model.nodes.get(key)?.location?.turn
            return typeof cutTurn !== 'number' || typeof t !== 'number' || t < cutTurn
        }
        const byTurn = <T>(m: Map<number, T>): Map<number, T> => (typeof cutTurn === 'number'
            ? new Map([...m].filter(([t]) => t < cutTurn))
            : m)
        return {
            nodes: new Map([...model.nodes].filter(([k]) => before(k))),
            order: model.order.filter((k) => before(k)),
            entries: model.entries.filter((e) => before(e.key)),
            groups: [],
            presentations: byTurn(model.presentations),
            turnTimes: byTurn(model.turnTimes),
            turnStats: byTurn(model.turnStats),
            turnPresented: byTurn(model.turnPresented),
            turnChanges: byTurn(model.turnChanges),
        }
    })()
    return {
        model,
        checkpoint: lastTurnStart >= 0 ? { tailStart: lastTurnStart, windowHeadSeq, windowLen, prefix } : undefined,
    }
}

