// 节点模型 → 渲染行（纯函数）：把 `buildChatNodes` 的产物映射成组件消费的扁平行列表。
//
// 与旧「宿主行→渲染行」映射同角色（旧通路已退役）：这一条把「客户端节点」映射成渲染行。
// **展示派生**（工具标题/摘要、时钟、计数文案）仍在组件侧，
// 这里只搬运**事实**（文本/链/状态/锚点/计数原文）。
//
// 形状刻意只列渲染所需字段（不 import store/types.ts 的 ChatRow —— 那会带进 @preact/signals 依赖链，
// 让本文件无法在无依赖环境下独立 type-check + 守卫）。接线层把 RenderRow 收窄成 ChatRow（同构、spread）。
import type { ChatBlock, ChatNode, ChatNodeModel, ProcessGroupSnapshot, ProcessPresentation } from './types'
import { isAtOrOutside } from './group-tree'
import { hasAssistantReplyContent } from './event-projection'
import { fileRefsOf, hasImageBlock, imageRefsOf, resultText } from '../../../../src/dsh/official/result-text'
import type { DshRowGroupFacts, DshRowGroupSummary, DshTodoItem } from '../../../../src/dsh/rows/types'

/** 过程链上的一项（渲染所需事实）。 */
export type RenderChainItem =
    // `status` = 该 assistant-step 的状态（`running`/`settled`/…）：实时细节只认**运行中**那一步
    // （上游），链项不带它就等于那道门永远为假。
    | { kind: 'reasoning'; key: string; step?: number; text: string; status?: string }
    | { kind: 'tool'; key: string; step?: number; callId?: string; name: string; argsRaw?: string; status: 'preparing' | 'running' | 'ok' | 'error'; content?: unknown; blocks?: unknown; isError?: boolean; meta?: unknown; errorName?: string; errorCode?: string; errorReason?: string; parentCallId?: string; subCalls?: RenderSubCall[]; /** `todo_write` 专用：本次写入之前最近一次落盘的清单（卡片据此做增/改/删 diff） */ todoBaseline?: DshTodoItem[] | null }
    | { kind: 'context'; key: string; content: unknown; source: unknown }
    | { kind: 'text'; key: string; step?: number; text: string }
    /**
     * **命令行 / 手动压缩**（`command` / `manual-compaction` 节点）。
     *
     * 它们是**普通过程成员**（各自有节点渲染器、与工具同一个座位；分组那张独立表里没有它们）
     * → 出现在片里、跟着片一起折叠。
     * 与独立行那条路（`RenderRow` 的 `kind:'command'`）共用同一份事实与同一个组件
     * （`CommandRow` / `commandFactsOf`），区别只在"长在片里"还是"长在顶层"。
     */
    | { kind: 'command'; key: string; name: string | null; outcome?: { kind: string; text?: string } }

/** 一片过程分组（最终形态：直接按节点模型的成员表分组，不用步区间近似）。 */
/**
 * 嵌套调用（上游 `ToolCallBlock.subCalls`）：PTC 从 `run_code` 里派发的工具，挂在其父调用的卡片之后。
 * 与根行同构但**没有自己的 key/step**（它属于父那一格），故单列一个类型。
 */
export interface RenderSubCall {
    callId: string
    name: string
    argsRaw?: string
    status: 'running' | 'ok' | 'error'
    content?: unknown
    isError?: boolean
    meta?: unknown
    parentCallId?: string
    errorName?: string
    errorCode?: string
    errorReason?: string
    subCalls?: RenderSubCall[]
}

/** 从节点模型里的原始子块折出渲染用的嵌套调用（递归）。 */
function subCallsOf(raw: unknown): RenderSubCall[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    const out: RenderSubCall[] = []
    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') continue
        const child = entry as Record<string, unknown>
        const settled = child['kind'] === 'tool-result'
        const call = (settled ? child['call'] : child) as { name?: unknown; argsRaw?: unknown } | null | undefined
        const name = call !== null && call !== undefined && typeof call.name === 'string' ? call.name : ''
        if (name === '') continue
        const error = (settled ? child['error'] : undefined) as Record<string, unknown> | undefined
        const nested = subCallsOf(child['subCalls'])
        out.push({
            callId: String(child['callId'] ?? ''),
            name,
            ...(typeof call?.argsRaw === 'string' ? { argsRaw: call.argsRaw } : {}),
            status: settled ? (child['isError'] === true ? 'error' : 'ok') : 'running',
            ...(settled ? { content: child['content'], isError: child['isError'] === true, meta: child['meta'] } : {}),
            ...(typeof child['parentCallId'] === 'string' ? { parentCallId: child['parentCallId'] } : {}),
            ...(error === undefined ? {} : {
                ...(typeof error['name'] === 'string' ? { errorName: error['name'] } : {}),
                ...(typeof error['code'] === 'string' ? { errorCode: error['code'] } : {}),
                ...(typeof error['reason'] === 'string' ? { errorReason: error['reason'] } : {}),
            }),
            ...(nested === undefined ? {} : { subCalls: nested }),
        })
    }
    return out.length === 0 ? undefined : out
}

/** 一片过程分组（最终形态：直接按节点模型的成员表分组，不用步区间近似）。 */
export type RenderGroup = { key: string; itemKeys: string[]; facts: DshRowGroupFacts }

/**
 * 呈现层的判据：**站在这棵树上的节点不参与回合级过程呈现**（`isAtOrOutside(node, 'turn')`）。
 *
 * 这原先是一张 kind 白名单（`system-prompt`/`user`/`steering`/`turn-trigger`/`turn-process`/
 * `turn-error`/`turn-max-tokens`/`turn-tail`）。0.2.1 起改为读**分组树位置**，与 `chat-nodes.ts` 同一份事实：
 * 位置在造节点时定一次，判据只读它，不再有两处表可能漂开。
 */


/** 渲染行（节点 kind 的扁平投影；与 ChatRow 同构，缺省字段由接线层补）。 */
export type RenderRow =
    | { kind: 'user'; key: string; text: string; steering?: boolean; timeMs?: number; rpcId?: string; /**
     * 用户消息里的**图片附件引用**（`user/message` 的 `content` 里 `{type:'image',attachment}`）。
     * 字节不在事件里（内容寻址 id），渲染侧按 `attachmentId` 向宿主取（与图片卡同一条路）。
     */ imageRefs?: Array<{ attachmentId: string; mediaType: string; name?: string; width?: number; height?: number }>; /**
     * 文件附件：名字、字节数，以及**内容寻址 id**（`user/message` 的 `file` 块同样带
     * `attachment.attachmentId` —— 2026-10-12 更正"历史回放没有本地路径就打不开"的旧结论：
     * 有 id 就能照图片那条路取字节、落临时文件、在编辑区打开）。
     */ files?: Array<{ name: string; bytes?: number; attachmentId?: string }> }
    | { kind: 'sysprompt'; key: string; text: string }
    | { kind: 'command'; key: string; name: string | null; outcome?: { kind: string; text?: string } }
    | { kind: 'compaction'; key: string; summary?: string | null; shadowedItemCount?: number | null; shadowedTokenCount?: number | null }
    | { kind: 'retry'; key: string; retryId: string; retry: number; turn?: number; step?: number; provider?: string; mode?: string; maxRetries?: number; delayMs?: number; failure?: { message?: string; code?: string }; started?: number; cancelled?: boolean }
    | { kind: 'turnNotice'; key: string; tone: 'error' | 'warning'; turn?: number; step?: number; message?: string; code?: string }
    | { kind: 'context'; key: string; content: unknown; source: unknown }
    | { kind: 'trigger'; key: string; source: unknown; content: unknown; timeMs: number }
    | { kind: 'assistant'; key: string; turn?: number; text: string; done: boolean; chain: RenderChainItem[]; counts: { toolCallCount: number; messageCount: number; subagentCount: number }; answerAnchorSeq: number | null; answerStep: number | null; controlAnchorSeq: number; processStartSeq: number; inlineReasoning: boolean; hasExternalProcess: boolean; hasInterleavedInput: boolean; compactAnswer: boolean; turnStarted: boolean; turnClosed: boolean; interrupted?: boolean; messageId?: string; seq?: number; timeMs?: number; turnStartMs?: number; status?: string; stats?: Record<string, unknown>; presentedFiles?: Array<{ path: string; description?: string }>; changesSeq?: number; pos: number; /**
     * **排序三键**（`(anchor, rank, originalAnchor)`）—— 与上游 `orderedVisibleChatNodes()` 的比较器
     * 逐字同口径（：anchor → rank → originalAnchor → key）。
     *
     * 为什么不能只用 `pos`：插件原先的行序只按 `pos` 一个数比，而**rank 才是分清"同锚谁在前"的那一维** ——
     * 控条（rank 1）与开局输入（rank 0）同锚时该排在输入之后、独立种类（rank 2）在输入之前，
     * 少了这维就会出现"插话排到过程项前面"这类交错（真机 `54fdba8f`、`c5c3c306`）。
     */
    sortAnchor?: number; sortRank?: number; sortOriginalAnchor?: number; scheduleResults?: string[]; groups: RenderGroup[]; generation: number }

/**
 * 一个过程节点在某回合里的**呈现位置** —— 逐条镜像上游 `presentationPosition`
 * 。
 *
 * 上游不是简单按 `anchorSeq` 排：开局人类输入与控条都有自己的 `rank`，
 * 于是"合并进来的开场内容排在控条之前"这类平局能排对。三支与上游一一对应：
 *   · 锚**早于**开局输入、且不是独立种类 → 锚拉成开局输入、**rank 2**；
 *   · 控条自己 → 有开局输入则锚拉成开局输入、**rank 1**（贴输入之后）；没有则锚 = 最早过程锚、**rank −1**；
 *   · 其余 → 原锚、**rank 0**。
 *
 * 抽成模块级函数：`nodesToRows` 的**行排序**也要用它（非 assistant 行按各自节点算位置）。
 *
 * @param n - 待判节点。
 * @param turnFacts - 该回合的两件事实：开局人类输入锚、最早过程锚。
 * @returns `(anchor, rank, originalAnchor)` 三元组。
 */
function positionInTurn(
    n: ChatNode,
    turnFacts: { openingInputAnchor: number | undefined; earliestProcessAnchor: number | undefined },
): { anchor: number; rank: number; originalAnchor: number } {
    const original = n.anchorSeq
    const { openingInputAnchor, earliestProcessAnchor } = turnFacts
    if (openingInputAnchor !== undefined && original < openingInputAnchor && !isAtOrOutside(n, 'turn')) {
        return { anchor: openingInputAnchor, rank: 2, originalAnchor: original }
    }
    if (n.kind === 'turn-process') {
        return openingInputAnchor === undefined
            ? { anchor: earliestProcessAnchor ?? original, rank: -1, originalAnchor: original }
            : { anchor: openingInputAnchor, rank: 1, originalAnchor: original }
    }
    return { anchor: original, rank: 0, originalAnchor: original }
}

/**
 * 一个回合的**位置事实**（`nodesToRows` 排序非 assistant 行时用）。
 *
 * 与 `buildAssistantRows` 内部那两件事同一口径（它那边是逐回合算的局部的版本）：
 * 开局人类输入锚、最早过程锚。
 */
function turnPositionFacts(model: ChatNodeModel, turn: number): { openingInputAnchor: number | undefined; earliestProcessAnchor: number | undefined } {
    const turnNodes = [...model.nodes.values()].filter((n) => (n.location.kind === 'turn' || n.location.kind === 'step') && n.location.turn === turn)
    const controlAnchorSeq = (() => {
        const control = turnNodes.find((n) => n.kind === 'turn-process')
        const v = control?.data['controlAnchorSeq']
        return typeof v === 'number' ? v : 0
    })()
    const turnStartSeq = model.turnTimes.get(turn)?.startSeq
    let openingInputAnchor: number | undefined
    for (const n of turnNodes) {
        if (n.kind !== 'user' && n.kind !== 'steering' && n.kind !== 'turn-trigger') continue
        if (controlAnchorSeq === turnStartSeq || n.anchorSeq < controlAnchorSeq) {
            openingInputAnchor = Math.max(openingInputAnchor ?? n.anchorSeq, n.anchorSeq)
        }
    }
    let earliestProcessAnchor: number | undefined
    for (const n of turnNodes) {
        if (n.kind === 'turn-process' || isAtOrOutside(n, 'turn')) continue
        earliestProcessAnchor = Math.min(earliestProcessAnchor ?? n.anchorSeq, n.anchorSeq)
    }
    return { openingInputAnchor, earliestProcessAnchor }
}

/** 节点 → 链项（只认过程成员）。 */function toChainItem(node: ChatNode, groupPart?: string, todoBaselines?: ReadonlyMap<string, DshTodoItem[] | null>): RenderChainItem | undefined {
    if (node.kind === 'assistant-step') {
        const blocks = (node.data['blocks'] ?? []) as Array<{ kind?: string; text?: string }>
        if (groupPart === 'reasoning') {
            const text = blocks.filter((b) => b.kind === 'reasoning').map((b) => b.text ?? '').join('')
            const status = node.data['status']
            return text.trim() === '' ? undefined : { kind: 'reasoning', key: node.key, step: node.data['step'] as number | undefined, text, ...(typeof status === 'string' ? { status } : {}) }
        }
        // 非回答步的文本（中间步正文）：进链（否则中间步的正文会被后来那条整条覆盖）
        const text = blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join('')
        return text.trim() === '' ? undefined : { kind: 'text', key: node.key, step: node.data['step'] as number | undefined, text }
    }
    if (node.kind === 'tool-call') {
        const root = (node.data['root'] ?? {}) as Record<string, unknown>
        const isResult = root['kind'] === 'tool-result'
        const call = (root['call'] ?? {}) as { name?: string; argsRaw?: string }
        const callId = String(root['callId'] ?? '')
        const name = String(call.name ?? root['name'] ?? '')
        return {
            kind: 'tool',
            key: node.key,
            step: node.location.step,
            callId,
            name,
            argsRaw: typeof call.argsRaw === 'string' ? call.argsRaw : typeof root['argsRaw'] === 'string' ? root['argsRaw'] : undefined,
            status: isResult ? ((root['isError'] === true) ? 'error' : 'ok') : 'running',
            // **任务清单的 diff 基线**（`todo_write` 专用）：卡片要显示「与上次清单相比 · 新增 X…」，
            // 而"上次清单"只能从更早的 `todo/write` 事件里找 —— 由模型建好后配对（见 `nodes/todo-baseline`）。
            // 少了它卡片恒显示「首次记录」（真机 2026-10-16 与网页端左右对照）。
            ...(name === 'todo_write' ? { todoBaseline: todoBaselines?.get(callId) ?? null } : {}),
            // 结果里含**图片块**时把原始块带上（图片卡的输入；图片字节由附件层按需另取）。
            // ⚠️ 与宿主那条路同一判据（`hasImageBlock`）：少了这一条，图片卡永远拿不到内容 →
            // 真机 68 条 `read_image` 全部静默落通用卡（2026-10-11 探针实测）。
            ...(isResult && hasImageBlock(root['content']) ? { blocks: root['content'] } : {}),
            // 嵌套调用（PTC 从 `run_code` 里派发的，`tool/ptc-dispatch*` 建出来的块）带 `parentCallId`：
            // 专属卡的门全靠它（上游 `read/search/web/diff-card-model` 见它即退让、图片卡拿它决定路径回退）。
            ...(typeof root['parentCallId'] === 'string' ? { parentCallId: root['parentCallId'] } : {}),
            ...(subCallsOf(root['subCalls']) === undefined ? {} : { subCalls: subCallsOf(root['subCalls']) }),
            ...(isResult ? { content: root['content'], isError: root['isError'] === true, meta: root['meta'] } : {}),
            // 结构化错误（上游 `ToolResultNode.error`）：Auto review 拒绝靠 name+code 辨认、reason 是文案。
            ...(isResult && root['error'] !== null && typeof root['error'] === 'object'
                ? (() => {
                    const err = root['error'] as Record<string, unknown>
                    return {
                        ...(typeof err['name'] === 'string' ? { errorName: err['name'] } : {}),
                        ...(typeof err['code'] === 'string' ? { errorCode: err['code'] } : {}),
                        ...(typeof err['reason'] === 'string' ? { errorReason: err['reason'] } : {}),
                    }
                })()
                : {}),
        }
    }
    if (node.kind === 'context') {
        return { kind: 'context', key: node.key, content: node.data['content'], source: node.data['source'] }
    }
    /**
     * 命令行 / 手动压缩进链（上游把两者当普通过程成员，见 `RenderChainItem` 的说明）。
     *
     * 两种节点的 data 形状不同：`command` 的 data 就是命令本体；`manual-compaction` 是
     * `{ command, compaction }`（上游 的 `ManualCompactionChatData`），取 command 那半边。
     */
    if (node.kind === 'command' || node.kind === 'manual-compaction') {
        return { kind: 'command', key: node.key, ...commandFactsOf(node) }
    }
    return undefined
}

/**
 * **单个节点 → 行**（顶层 entry 的那一支）。
 *
 * 抽出来是为了让 `nodesToRows` 与 `nodesToEntryPlan`（seat 化那一步）**共用同一份映射** ——
 * 两份实现迟早漂开（这正是"行模型重复近似"的老毛病）。
 *
 * @param node - 顶层 entry 指向的节点。
 * @param turn - 该节点所属回合（`turn-process` 要按它折出回答行）。
 * @param model - 节点模型（`turn-process` 那支要读整回合的节点与分组）。
 * @returns 该节点产出的行；不产出任何行时（如 `turn-tail`）为空数组。
 */
function rowsOfNode(node: ChatNode, turn: number, model: ChatNodeModel): RenderRow[] {
    const rows: RenderRow[] = []
    switch (node.kind) {
        case 'user':
        case 'steering': {
            const src = node.data['source'] as { rpcId?: unknown } | undefined
            /**
             * **用户消息的附件**（图片 / 文件）—— 与旧行通路同一口径：
             * `imageRefsOf` 取图片引用、`fileRefsOf` 取文件展示信息。
             *
             * ⚠️ 2026-10-11 补：此前这里只搬 `text`/`rpcId`，**附件引用整条丢失** ——
             * 真机现象就是"会话区里发出去的图片不显示、也没法点开"（两处断链：节点侧不留 `content`、
             * 行侧又硬写 `images: []`）。图片字节不在事件里（内容寻址 id），渲染侧按需向宿主取。
             */
            const imageRefs = imageRefsOf(node.data['content'])
            const files = fileRefsOf(node.data['content'])
            rows.push({
                kind: 'user', key: node.key, text: String(node.data['text'] ?? ''),
                ...(node.kind === 'steering' ? { steering: true } : {}),
                timeMs: node.time,
                ...(typeof src?.rpcId === 'string' ? { rpcId: src.rpcId } : {}),
                ...(imageRefs.length > 0 ? { imageRefs } : {}),
                ...(files.length > 0 ? { files } : {}),
            })
            break
        }
        case 'system-prompt':
            rows.push({ kind: 'sysprompt', key: node.key, text: String(node.data['text'] ?? '') })
            break
        case 'command':
        case 'manual-compaction': {
            // ⚠️ **片外回落支**（2026-10-10）：有过程分组的回合里，命令行是**片的成员** →
            // 它在 `entries` 里被 `nodesToRows` 那行 `consumed.add(member.key)` 吃掉，走链那条路
            // （`toChainItem` 的 `command` 支 + `chainItemNode` → `CommandRow`）。
            // 只有**不属于任何回合**的那些（`/plan`、`/compact` 落在两条回合之间，位置是会话级
            // `turn: 0`）才到这里，按独立行渲染 —— 上游那条路是顶层 entry，形态同。
            rows.push({ kind: 'command', key: node.key, ...commandFactsOf(node) })
            break
        }
        case 'compaction': {
            const summary = node.data['summary'] as string | null | undefined
            rows.push({ kind: 'compaction', key: node.key, summary, shadowedItemCount: node.data['shadowedItemCount'] as number | null | undefined, shadowedTokenCount: node.data['shadowedTokenCount'] as number | null | undefined })
            break
        }
        case 'model-retry': {
            // ⚠️ **末次尝试的整份数据都要带下去**（真机 2026-10-19：插件显示「(1/∞)」「重试延迟：0毫秒」，
            // 网页端是「(1/5)」「46毫秒」）。原因就是这里只搬了 `retry`/`retryState`，
            // 把 `mode`/`maxRetries`/`delayMs`/`failure` 丢了 —— 行的类型里明明有这几项
            // （`RetryRow` 读的正是它们）。上游是把 `llm/retry` 的 `data` **整体**展开成节点
            // （`conversation-nodes/retry.ts:30` 的 `...match.event.data`），这里照同一口径透传。
            const current = node.data['current'] as Record<string, unknown> | undefined
            const pick = <T>(key: string, guard: (v: unknown) => v is T): T | undefined => {
                const fromCurrent = current?.[key]
                if (guard(fromCurrent)) return fromCurrent
                const fromNode = node.data[key]
                return guard(fromNode) ? fromNode : undefined
            }
            const isStr = (v: unknown): v is string => typeof v === 'string'
            const isNum = (v: unknown): v is number => typeof v === 'number'
            const mode = pick('mode', isStr)
            const maxRetries = pick('maxRetries', isNum)
            const delayMs = pick('delayMs', isNum)
            const provider = pick('provider', isStr)
            const failureRaw = current?.['failure'] ?? node.data['failure']
            const failure = failureRaw !== null && typeof failureRaw === 'object' ? failureRaw as { message?: string; code?: string } : undefined
            rows.push({ kind: 'retry', key: node.key, retryId: String(node.data['retryId'] ?? node.key), retry: typeof current?.['retry'] === 'number' ? current['retry'] as number : 0, turn: node.data['turn'] as number | undefined, step: node.data['step'] as number | undefined, ...(provider === undefined ? {} : { provider }), ...(mode === undefined ? {} : { mode }), ...(maxRetries === undefined ? {} : { maxRetries }), ...(delayMs === undefined ? {} : { delayMs }), ...(failure === undefined ? {} : { failure }), ...(current?.['retryState'] === 'started' && typeof current['retry'] === 'number' ? { started: current['retry'] as number } : {}), ...(current?.['retryState'] === 'cancelled' ? { cancelled: true } : {}) })
            break
        }
        case 'turn-error':
        case 'turn-max-tokens': {
            const tone = node.kind === 'turn-error' ? 'error' as const : 'warning' as const
            rows.push({ kind: 'turnNotice', key: node.key, tone, turn: node.data['turn'] as number | undefined, step: node.data['step'] as number | undefined, ...(node.kind === 'turn-error' ? { message: node.data['message'] as string | undefined, code: node.data['code'] as string | undefined } : {}) })
            break
        }
        case 'context':
            // 含工具增删块的注入才占一行（isVisibleChatNode 已过滤，这里防御）
            rows.push({ kind: 'context', key: node.key, content: node.data['content'], source: node.data['source'] })
            break
        case 'turn-trigger':
            rows.push({ kind: 'trigger', key: node.key, source: node.data['source'], content: node.data['content'], timeMs: node.time })
            break
        case 'turn-process':
            // 控制条的位置 = 首片的 assistant 行位置：在这里把该回合折成 assistant 行，
            // 使问答顺序按 entries 交错（用户行/回答行不再分两遍、不会把所有回答堆到末尾）。
            // **一个回合可以折出多行**：插话（user/steering/turn-trigger）把过程切成若干片，
            // 每片一行、各自带自己的过程链与正文 —— 上游也是「每片一个分组 seat + 独立回答节点」。
            rows.push(...buildAssistantRows(model, turn))
            break
        case 'turn-tail':
            // 尾部动作条并入 assistant 行
            break
    }
    return rows
}

/**
 * **seats 计划**（上游 `RenderEntry` 同形）：`entries` 一条一项，每项各自渲染。
 *
 * 为什么要有它：插件原先只有"行"这一种产物，一行**承载了多种东西**
 *（一个回合控件 + 该段的片 + 该段的回答正文悬在链体之外 + 各类独立行），
 * 于是位次 / 间距 / 折叠 / 可见性四类判据**每一条都要在"行"这一层再做一次近似** ——
 * 这就是"十几处修正全落在同一层、收益递减而结构债累积"的由来。
 */
export interface RenderSeat {
    /** 这一项的稳定身份（node 用节点 key，group 用分组 key）—— 与上游 `chatRenderKey` 同义。 */
    key: string
    /** `node` = 一个节点（含 `turn-process`：它**自己**是一项，带出该回合的回答行）；`group` = 一片过程。 */
    kind: 'node' | 'group'
    /** 节点 kind（`group` 项为 `'process-group'`）。 */
    nodeKind: string
    /** 所属回合（会话级节点为 `0`，与 `SESSION_BUCKET` 同义）。 */
    turn: number
    /** 该项产出的行：独立行一条；`turn-process` 是**该回合的全部回答行**（每段一条）。 */
    rows: RenderRow[]
    /** `group` 项：成员节点 key（渲染时按它从链里取项，与上游 `GroupMembers` 同）。 */
    members?: string[]
}

/** 节点的行列表（`turn-process` 一支会展开成多条）。 */
function rowsOfSeat(model: ChatNodeModel, key: string): RenderRow[] {
    const node = model.nodes.get(key)
    return node === undefined ? [] : rowsOfNode(node, node.location.turn, model)
}

/**
 * 节点模型 → **seats 计划**（有序）。
 *
 * 与 `nodesToRows` 的差别只在**粒度**：这里保住了"每一项是一件事"，
 * 不再把"用户行 / 各段回答 / 各类独立行"混成一个扁平数组让渲染侧自己去猜。
 *
 * @param model - `buildChatNodes` 的产物。
 * @returns 按 `model.entries` 顺序的项列表。
 */
export function nodesToSeatPlan(model: ChatNodeModel): RenderSeat[] {
    const seats: RenderSeat[] = []
    for (const entry of model.entries) {
        if (entry.kind === 'group') {
            const group = model.groups.find((g) => g.key === entry.key)
            seats.push({
                key: entry.key,
                kind: 'group',
                nodeKind: 'process-group',
                turn: group?.data.turn ?? 0,
                rows: [],
                members: group === undefined ? [] : group.members.map((m) => m.key),
            })
            continue
        }
        const node = model.nodes.get(entry.key)
        if (node === undefined) continue
        seats.push({
            key: node.key,
            kind: 'node',
            nodeKind: node.kind,
            turn: node.location.turn,
            rows: rowsOfSeat(model, node.key),
        })
    }
    return seats
}

/** 座位计划的一项：**只带行 key**（页面侧按 key 去行表取行，避免跨层持有行对象）。 */
export interface RenderSeatKeys {
    key: string
    /**
     * **原始节点 / 分组 key**（会话内语义串，如 `turn-process:1` / `["process",…]`）——
     * DOM 锚点与分页定位用的是它（上游 `data-chat-anchor-key` 就是条目 key），
     * 而 `key` 是对应到行表的数字 key。
     */
    nodeKey: string
    kind: 'node' | 'group'
    nodeKind: string
    turn: number
    /** 该项占用的行 key（顺序即渲染顺序）。 */
    rowKeys: string[]
    /** `group` 项：成员节点 key（原始串，不是行 key）。 */
    members?: string[]
}

/**
 * 节点模型 → **座位计划（只带行 key）**。
 *
 * 页面侧消费的是行表（`ChatRow[]`，按 key 索引）—— 座位计划只需要说明
 * "**哪些行属于同一项、它们按什么次序排**"，渲染时再按 key 取行。
 * 这样座位化不必把行对象搬来搬去，也不会在两层各留一份行副本。
 *
 * ⚠️ `rowKey` 这个映射参数是**必需**的（不是可选优化）：计划里的 key 是**节点 key**
 *（`turn-process:1:seg1` 这类会话内语义串），而行表的 key 是**数字**（由接线层的 key 映射分配）。
 * 不转换就等于拿两种 key 去对，按 key 查表会 100% 落空。
 *
 * @param model - `buildChatNodes` 的产物。
 * @param rowKey - 节点 key → 行 key 的映射（接线层的 key 分配器）。
 * @returns 按 `model.entries` 顺序的项列表。
 */
export function nodesToSeatRows(model: ChatNodeModel, rowKey: (nodeKey: string) => number): RenderSeatKeys[] {
    return nodesToSeatPlan(model).map((seat) => ({
        key: String(rowKey(seat.key)),
        nodeKey: seat.key,
        kind: seat.kind,
        nodeKind: seat.nodeKind,
        turn: seat.turn,
        rowKeys: seat.rows.map((r) => String(rowKey(String(r.key)))),
        // 成员表保留**原始节点 key**：它是宿主 API 的口径（分页 / 导轨按它找），转成行 key 反而没用
        ...(seat.members === undefined ? {} : { members: [...seat.members] }),
    }))
}

/** 把节点模型映射成渲染行（有序）。 */
export function nodesToRows(model: ChatNodeModel): RenderRow[] {
    const rows: RenderRow[] = []
    // 过程成员节点已进 assistant 行的链，独立行/回答步在这里出现一次。
    const consumed = new Set<string>()
    const groupByKey = new Map(model.groups.map((g) => [g.key, g]))
    for (const entry of model.entries) {
        if (entry.kind === 'group') {
            const group = groupByKey.get(entry.key)
            if (group === undefined) continue
            for (const member of group.members) consumed.add(member.key)
            continue
        }
        const node = model.nodes.get(entry.key)
        if (node === undefined) continue
        rows.push(...rowsOfNode(node, node.location.turn, model))
    }
    /**
     * 排序：**逐字对齐上游 `orderedVisibleChatNodes` 的比较器**：
     * `anchor → rank → originalAnchor → key`。
     *
     * ⚠️ 三键缺一不可（2026-10-11 两次真机踩到）：
     *   · 只比 `pos`（= `anchor + 0.5`）时，"控条（rank 1）与开局输入（rank 0）同锚"这一对
     *     就没有确定的先后 —— 真机 `54fdba8f` 的插话排到了过程项前面、`c5c3c306` 里
     *     `user:264` 与 `turn-process:6` 交错，都是这一处；
     *   · `rank` 是上游专门为"合成控条坐在开局输入与过程之间"设的那一维（`rank: -1/0/1/2`），
     *     少了它就只能靠浮点偏移量硬凑。
     *
     * assistant 行用**段内可见成员里最小的那个位置**（`sortAnchor/sortRank/sortOriginalAnchor`）；
     * 其它行用它自己节点的位置（`positionInTurn`）。
     */
    /** 每个回合的位置事实只算一次（排序比较器里会被反复读）。 */
    const turnFactsByTurn = new Map<number, { openingInputAnchor: number | undefined; earliestProcessAnchor: number | undefined }>()
    for (const row of rows) {
        const node = model.nodes.get(row.key)
        if (node === undefined) continue
        const turn = node.location.turn
        if (!turnFactsByTurn.has(turn)) turnFactsByTurn.set(turn, turnPositionFacts(model, turn))
    }
    const positionOfRow = (row: RenderRow): { anchor: number; rank: number; originalAnchor: number } => {
        if (row.kind === 'assistant' && row.sortAnchor !== undefined && row.sortRank !== undefined && row.sortOriginalAnchor !== undefined) {
            return { anchor: row.sortAnchor, rank: row.sortRank, originalAnchor: row.sortOriginalAnchor }
        }
        const node = model.nodes.get(row.key)
        if (node === undefined) return { anchor: 0, rank: 0, originalAnchor: 0 }
        const turn = node.location.turn
        const p = positionInTurn(node, turnFactsByTurn.get(turn) ?? { openingInputAnchor: undefined, earliestProcessAnchor: undefined })
        return { anchor: p.anchor, rank: p.rank, originalAnchor: p.originalAnchor }
    }
    return rows.sort((a, b) => {
        const pa = positionOfRow(a)
        const pb = positionOfRow(b)
        return pa.anchor - pb.anchor
            || pa.rank - pb.rank
            || pa.originalAnchor - pb.originalAnchor
            || String(a.key).localeCompare(String(b.key))
    })
}

/**
 * 命令行 / 压缩标记的**事实**（独立行与链项两条路共用这一份）。
 *
 * `command` 节点的 data 就是命令本体；`manual-compaction` 是 `{ command, compaction }`（上游
 * `command.ts` 的 `buildViewNode`）。两边的 outcome 形状相同，取 command 那半边即可。
 * `name === 'permission'` 的那一类已被 `isVisibleChatNode` 剔除，到不了这里。
 *
 * @param node - `command` / `manual-compaction` 节点。
 * @returns 命令名与结算事实（认不出的形状给 `name: null`）。
 */
function commandFactsOf(node: ChatNode): { name: string | null; outcome?: { kind: string; text?: string } } {
    const data = node.kind === 'manual-compaction' ? ((node.data['command'] ?? {}) as Record<string, unknown>) : node.data
    const outcome = data['outcome'] as { kind?: string; text?: string } | null | undefined
    const name = (data['name'] as string | null | undefined) ?? null
    return {
        name,
        ...(outcome === null || outcome === undefined
            ? {}
            : { outcome: { kind: String(outcome.kind ?? ''), ...(outcome.text === undefined ? {} : { text: outcome.text }) } }),
    }
}

/**
 * 把一个回合折成渲染行：**按插话切段**，每段一行。
 *
 * ⚠️ **已知残留（真机 `c5c3c306`，见 `12` 的更新记录）**：排序三键与上游逐字对齐之后，
 * 全库 25 份抽样里 **24 份**与上游的条目序完全一致；那一份还剩几处**相邻对**互换
 *（`at 14,13` / `22,21` / `102,101` 这类 —— 用户行与它所属回合的过程项各让一位）。
 * 成因是"过程项首行的位置由**段内成员**的最小位置决定"（上游是 `pending` 首个成员），
 * 两者在"段里含多个输入"时可能差一个位次；再往下要让**段的成员切分**与上游 `pending` 的
 * flush 时机逐字一致 —— 那是切段层的重构，先记录在案。
 *
 * 为什么不是「整回合一行」：插话发生在回合**中途**，上游分组会把过程切成多片、
 * 回答步各自作为独立节点成形。压成一行会有两个硬伤 —— 插话被挤到回合末尾、
 * 中途那条回答步的正文整段丢失（真机 2026-10-09 复现）。
 */
function buildAssistantRows(model: ChatNodeModel, turn: number): RenderRow[] {
    const turnNodes = [...model.nodes.values()].filter((n) => (n.location.kind === 'turn' || n.location.kind === 'step') && n.location.turn === turn)
    const control = turnNodes.find((n) => n.kind === 'turn-process')
    const answer = turnNodes.filter((n) => n.kind === 'assistant-step' && hasReply(n)).sort((a, b) => a.anchorSeq - b.anchorSeq).at(-1)
    const presentation = model.presentations.get(turn)
    const spec = control?.data as { answerAnchorSeq?: unknown; answerStep?: unknown; controlAnchorSeq?: unknown; processStartSeq?: unknown; inlineReasoning?: unknown; toolCallCount?: unknown; messageCount?: unknown; subagentCount?: unknown } | undefined
    // 开局长人类/触发锚（镜像上游 turnProcessPresentations）：控制条贴着它、rank 1（排在它**之后**）。
    // 少了这一步，流式中（还没有回答步）assistant 行会退到控制条锚点、跑到用户消息**上面**去。
    const controlAnchorSeq = typeof spec?.controlAnchorSeq === 'number' ? spec.controlAnchorSeq : 0
    const turnStartSeq = model.turnTimes.get(turn)?.startSeq
    let openingInputAnchor: number | undefined
    for (const n of turnNodes) {
        if (n.kind !== 'user' && n.kind !== 'steering' && n.kind !== 'turn-trigger') continue
        // 控制锚回落成回合起点（本回合没有过程证据）时，全部开局输入都算；否则只算控制锚之前的。
        if (controlAnchorSeq === turnStartSeq || n.anchorSeq < controlAnchorSeq) {
            openingInputAnchor = Math.max(openingInputAnchor ?? n.anchorSeq, n.anchorSeq)
        }
    }
    // 本回合结算的 schedule_create 结果（上游 ui-schedule：这张卡渲染在**回合尾部**，不进工具组）。
    const scheduleResults: string[] = []
    for (const n of turnNodes) {
        if (n.kind !== 'tool-call') continue
        const root = (n.data['root'] ?? {}) as Record<string, unknown>
        if (root['kind'] !== 'tool-result' || root['isError'] === true) continue
        const call = (root['call'] ?? null) as { name?: unknown } | null
        const name = call !== null && typeof call === 'object' && typeof call.name === 'string'
            ? call.name
            : (typeof root['name'] === 'string' ? root['name'] : '')
        if (name !== 'schedule_create') continue
        const text = resultTextOf(root['content'])
        if (text.trim() !== '') scheduleResults.push(text)
    }
    /**
     * 本回合**最早的过程锚**（`earliestProcessAnchor`）：独立种类以外的节点里锚最小的那个。
     * 与上游 `turnProcessPresentations` 里那一步同口径 —— 控条在"没有开局人类输入"时拿它当锚。
     */
    let earliestProcessAnchor: number | undefined
    for (const n of turnNodes) {
        if (n.kind === 'turn-process' || isAtOrOutside(n, 'turn')) continue
        earliestProcessAnchor = Math.min(earliestProcessAnchor ?? n.anchorSeq, n.anchorSeq)
    }
    /**
     * 一个过程节点在本回合里的**呈现位置**（逐条镜像上游 `presentationPosition`）。
     *
     * 上游不是简单按 `anchorSeq` 排：开局人类输入与控条都有自己的 `rank`，
     * 于是"合并进来的开场内容排在控条之前"这类平局能排对。三支与上游一一对应：
     *   · 锚**早于**开局输入、且不是独立种类 → 锚拉成开局输入、**rank 2**；
     *   · 控条自己 → 有开局输入则锚拉成开局输入、**rank 1**（贴输入之后）；没有则锚 = 最早过程锚、**rank −1**；
     *   · 其余 → 原锚、**rank 0**。
     */
    const presentationPosition = (n: ChatNode): { anchor: number; rank: number; originalAnchor: number } =>
        positionInTurn(n, { openingInputAnchor, earliestProcessAnchor })
    // ---- 切段：按插话把过程切开 ----
    // 插话 = 开局长输入**之后**的 user/steering/turn-trigger。它两侧是两个独立的回答世代，
    // 上游各自成片（flush(true)），所以行也必须断开，否则中途那条正文会被并进同一行而丢失。
    /**
     * 走查/切段的次序 = **上游的 `(anchor, rank, originalAnchor)` 呈现序**（不是裸 `anchorSeq`）。
     *
     * ⚠️ 控条虽然后面会被滤掉（它自己那条行由 `node-entries` 走），但它要**参与排序**：
     * 上游那套 rank 平局规则就是为它写的（见 `presentationPosition`）。少了这一层，
     * 同一个锚上"控条该排在开局输入之后"就只能靠别处补 —— 已删掉的那段 `humanFloor` 兜底就是补丁。
     */
    const ordered = turnNodes
        .filter((n) => n.kind !== 'turn-tail')
        .map((n) => ({ n, pos: presentationPosition(n) }))
        .sort((a, b) => a.pos.anchor - b.pos.anchor
            || a.pos.rank - b.pos.rank
            || a.pos.originalAnchor - b.pos.originalAnchor
            || a.n.key.localeCompare(b.n.key))
        .map((x) => x.n)
    const process = ordered.filter((n) => n.kind !== 'turn-process')
    const turnGroups = model.groups.filter((g) => g.data.turn === turn)
    const groupKeyOfMember = new Map<string, string>()
    for (const g of turnGroups) for (const m of g.members) groupKeyOfMember.set(m.key, g.key)
    interface Segment { nodes: ChatNode[]; groupKeys: string[]; boundary: number | undefined; generation: number; hasReplyStep: boolean }
    const segments: Segment[] = []
    let generation = 0
    let cur: Segment = { nodes: [], groupKeys: [], boundary: undefined, generation, hasReplyStep: false }
    /**
     * **只有"带回答正文的段"才成行**（对齐上游 的 `flush`）。
     *
     * 上游产生 entry 只有两条路：`INDEPENDENT` 的节点、以及**带回答正文的 `assistant-step`**
     *（`if (reply(node)) { flush(true); emit(key, …) }`）。**没有回答的段不产生 entry** ——
     * 它的成员被下一次 `flush` 一起收进那一段（`flush` 取整个 `pending`）。
     *
     * ⚠️ **判据是"这一段有没有等到回答步"，不是"有没有成员"**（2026-10-11 踩过两次）：
     *   ① 按"有成员且后面还有段"就并进上一段 → **合法分界也被并掉**
     *     （例：回答步之后的工具段本就该自成一行），守卫立刻变红；
     *   ② 按"回合末尾有成员就并" → 又把合法收尾段并掉。
     *
     * 现在只有**一个**判据：段被边界（插话 / 独立节点 / 命令行落单）切出来之后，
     * `curOrphan = true`；**直到这一段里出现带回答正文的回答步**才转为 `false`。
     * 收口时 `curOrphan` 仍为真的段不单独成行 —— 它的成员归入**下一段**；
     * 若它已是最后一段（回合以工具工作结束、没有收尾回答，例 `b341b9fa` 回合 1），
     * 则归入**上一个已收口段**（上游 `pending` 在没有下一次 flush 时也是这样留在最后一个 entry 里）。
     */
    /** 当前段"还没等到回答步"（被边界切出来、又没有回答正文）。 */
    let curOrphan = false
    /**
     * 收口当前段。
     *
     * - `curOrphan === true`（这一段从头到尾没等到回答步）→ **不单独成行**：成员并进**上一个已收口段**，
     *   或（还没有任何已收口段时）并成唯一那一行（控件与控制块必须有个落点）；
     * - `curOrphan === false`（这一段里有带回答正文的步）→ 自成一行。
     *
     * 这就是与上游 `flush(followed)` 对齐的落点：上游只把**带回答的步**发射成 entry，
     * 没有回答的成员留在 `pending` 里被下一次 flush 收走。
     */
    const closeSegment = (): void => {
        const hasMembers = cur.nodes.length > 0 || cur.groupKeys.length > 0
        if (!hasMembers) { curOrphan = false; return }
        /**
         * ⚠️ **被边界切出来的孤儿段必须自成一行**（与上游分组口径同）：
         * 孤儿态只由 `markBoundary` 置起，所以"孤儿段"就是**人类输入之后**、还没等到回答步的那一段。
         * 把它并回上一段 = 把边界之后的过程搬到人类输入**上面** —— 上游分组表是
         * `G[T1] → steering → G[T2]`，插话之后那一片自成一个 seat；并回去就会让运行中的片头
         * （「正在分析请求 · …」）挂在插话**前面**那条回答行里。
         * 并回上一段只在**没有边界**（段被切出来却没有边界锚）或**无可渲染成员**
         * （不会画出任何东西，不必多一条行）时才成立。
         */
        const renderable = cur.groupKeys.length > 0
            || cur.nodes.some((n) => n.visibility === 'visible' && n.kind !== 'system-prompt')
        if (!curOrphan || (cur.boundary !== undefined && renderable)) { segments.push(cur); curOrphan = false; return }
        const host = segments.length > 0 ? segments[segments.length - 1] as Segment : null
        const target = host ?? cur
        for (const n of cur.nodes) if (!target.nodes.includes(n)) target.nodes.push(n)
        for (const k of cur.groupKeys) if (!target.groupKeys.includes(k)) target.groupKeys.push(k)
        // 锚点取**最早**那个（该段起点，与上游 `emit` 取 `pending[0]` 同）
        if (host !== null && cur.boundary !== undefined && (host.boundary === undefined || cur.boundary < host.boundary)) host.boundary = cur.boundary
        if (host === null) segments.push(target)
        curOrphan = false
    }
    /** 段边界：开一段新的孤儿段（等它自己等到回答步）。 */
    const markBoundary = (boundary: number | undefined, nextGeneration: number): void => {
        generation = nextGeneration
        cur = { nodes: [], groupKeys: [], boundary, generation, hasReplyStep: false }
        curOrphan = true
    }
    /**
     * **收口当前段（边界到来时）**：与上游 `flush` 同义 —— 边界处把攒下的成员发射成一段，
     * 边界那条输入自己另有顶层行（上游它也是独立 entry），所以这里只管"把段收掉"。
     *
     * 为什么要收：`nodesToRows` 的排序**只认行的 `pos`**，而插件的顶层行（插话等）用 `anchorSeq`。
     * 若把边界两侧的成员并成一段（旧行为），这一段的锚就是**最后那条边界**，
     * 整行于是被推到该回合所有插话之后 —— 真机 `54fdba8f` 回合 1 的表现就是
     * "过程项排在 5 条插话之后"（网页端是 `过程项 → 片1 → 插话1 → 片2 → …`）。
     */
    const flushOnBoundary = (): void => {
        if (cur.nodes.length > 0 || cur.groupKeys.length > 0) {
            segments.push(cur)
            cur = { nodes: [], groupKeys: [], boundary: undefined, generation, hasReplyStep: false }
        }
        curOrphan = false
    }
    for (const n of process) {
        if (n.kind === 'user' || n.kind === 'steering' || n.kind === 'turn-trigger') {
            if (openingInputAnchor !== undefined && n.anchorSeq <= openingInputAnchor) continue // 开局那条本身不是插话
            flushOnBoundary()
            markBoundary(n.anchorSeq, generation + 1)
            continue
        }
        /**
         * ⚠️ **独立成行的节点也切段**（2026-10-10）：那七种独立节点一律"组在此断开 + 自己一条顶层 entry"。
         * 插件原先只把它们塞进本段（它们自带渲染行，所以看不出丢了东西），于是**它两侧的片被并进同一条
         * assistant 行**：行内序成了「片1 片2 … 正文」，而上游是「片1 → 重试行 → 片2 → 正文」。
         * 这里只**切**不**收**（节点自己那条行由 node-entries 那条路发，本函数只管 assistant 行）。
         *
         * ⚠️ **命令行 / 手动压缩不在这张表里**（2026-10-10 改正）：它们是**片的成员**，按分组归属走 ——
         * **属于某一片** → 记下那张片（链里由 `toChainItem` 出**命令行**，与工具行同一个座位）；
         * **不属于任何片**（会话级 `/plan`、`/compact`，位置是 `SESSION_BUCKET`）→ 自己一条顶层行，与切段同形。
         */
        if (n.kind === 'model-retry' || n.kind === 'turn-error' || n.kind === 'turn-max-tokens') {
            flushOnBoundary()
            cur = { nodes: [], groupKeys: [], boundary: undefined, generation, hasReplyStep: false }
            continue
        }
        if (n.kind === 'command' || n.kind === 'manual-compaction') {
            const groupKey = groupKeyOfMember.get(n.key)
            if (groupKey === undefined) {
                flushOnBoundary()
                cur = { nodes: [], groupKeys: [], boundary: undefined, generation, hasReplyStep: false }
                continue
            }
            // 片的成员：**不进 `nodes`**（它没有自己的正文，也不是回答步），只把那张片挂进本段 ——
            // 链与片都由片的成员表算（下面 `for (const g of turnGroups…)` 那一段），位置自然正确。
            if (!cur.groupKeys.includes(groupKey)) cur.groupKeys.push(groupKey)
            continue
        }
        cur.nodes.push(n)
        const groupKey = groupKeyOfMember.get(n.key)
        if (groupKey !== undefined && !cur.groupKeys.includes(groupKey)) cur.groupKeys.push(groupKey)
        /**
         * **这一段等到回答步了** → 退出孤儿态，并记下"本段带回答"（上游那种"带回答的 entry"）。
         *
         * ⚠️ 这两句是判据的另一半，少了就会出现两种错法（各踩过一次）：
         *   · 只清 `curOrphan`、不记 `hasReplyStep` → **尾部无回答段**（回合以 reasoning+工具收尾，
         *     例 `b341b9fa` 回合 1 的 step 40）仍会自成一行，屏幕多出一条正文为空的回答行；
         *   · 只记 `hasReplyStep`、不清 `curOrphan` → 带回答的段被并走（`0b326c` 回合 1 两个回答步并成 1 行）。
         */
        if (n.kind === 'assistant-step' && hasReply(n)) {
            curOrphan = false
            cur.hasReplyStep = true
        }
        /**
         * ⚠️ **回答步也是段边界**（2026-10-10 对齐上游 dsh-v0.2.0-rc.2）。
         *
         * 上游 ：带回答正文的步 → `flush(true)` 之后把**它自己**发射成
         * 一条独立 render entry（`groupPart: 'response'`），于是 entry 序 = 【片1】【回答段1】【片2】…，
         * 网页端就是「片头 → 该片的正文 → 下一片头」。
         *
         * 只按插话切段（旧行为）会把一个世代压成**一行**：所有片头挤在正文之上、所有回答拼成一段
         *（真机 2026-10-10：三条片头「向用户提出了问题」/「…已调用工具，已搜索网页等」/「已调用工具」
         * 全部排在整段正文上面，网页端则是片头与正文交错）。
         *
         * 段界落在回答步**之后**：这一条回答属于它自己那一段（正文挂在片头之下），
         * 下一片的成员从新段开始 —— 与上游的发射次序逐条对应。
         */
        if (n.kind === 'assistant-step' && hasReply(n)) {
            closeSegment()
            cur = { nodes: [], groupKeys: [], boundary: undefined, generation, hasReplyStep: false }
            // ⚠️ **这一句不能少**：开了新段就要退出"孤儿"态，否则新段收口时又会被并进上一段
            // （第一版漏了它，真机上两个回合分别变成"1 行"与"18 行"）。
            // 回答步之后的成员属于**正常收尾段**（例：回答步之后的工具自成一行），保持自成一行。
            curOrphan = false
        }
    }
    /**
     * 收尾两步（与上游 `flush(followed)` 同义）：
     *
     * ① `closeSegment()` 按 `curOrphan` 决定"自成一行"还是"并进上一个已收口段"；
     * ② **纯尾随的"无回答、也无工具"段并进上一段**。
     *
     * ⚠️ ②这条的判据是**两条一起**（各踩过一次，守卫与真机分别抓到）：
     *   · 只按"尾段无回答"就并 → 把**回答步之后的工具段**也吞了（上游那里是**独立 entry**，
     *     网页端就是「回答 → 下一片工具」，真机与 `_nodes` 守卫都变红）；
     *   · 完全不并 → 回合以"只有 reasoning 的收尾步"结束时（例 `b341b9fa` 回合 1 的 step 40：
     *     块 = `["reasoning:…"]`，无回答、无工具），屏幕多出一条**正文为空**的回答行。
     * 结论：只有当尾段**既没有回答步、也没有任何工具调用**（纯思考尾随）时，它才属于上一段的过程；
     * 一旦有工具，它就是上游那样一片独立 entry，自成一行。
     */
    closeSegment()
    const hasTool = (segment: Segment): boolean => segment.groupKeys.length > 0
        || segment.nodes.some((n) => n.kind === 'tool-call')
    while (segments.length >= 2) {
        const tail = segments[segments.length - 1] as Segment
        // ⚠️ 边界之后的纯思考尾段**也不能并回边界之前**：它就是插话之后那一片的片头
        // （运行中 =「正在分析请求」），并回去就又跑到人类输入上面（同 `closeSegment` 那条口径）。
        if (tail.hasReplyStep || hasTool(tail) || tail.boundary !== undefined) break
        segments.pop()
        const host = segments[segments.length - 1] as Segment
        for (const n of tail.nodes) if (!host.nodes.includes(n)) host.nodes.push(n)
        for (const k of tail.groupKeys) if (!host.groupKeys.includes(k)) host.groupKeys.push(k)
    }
    if (segments.length === 0) segments.push({ nodes: [], groupKeys: [], boundary: undefined, generation: 0, hasReplyStep: false })
    /**
     * **一片的成员在本回合里的呈现位次**（切段用的就是这条序）。
     *
     * 为什么片内也要按它排：分组是在**另一条序**（按锚点）上重建的，而这里切段按呈现序。
     * 两条序在"命令行 / 注入挨着工具"这类位置上会差一格，于是同一个片的成员在呈现序里
     * **不再连续**（实测：某片 4 个成员夹着一条命令行与两条注入），片就被段界切成两半 ——
     * 两半各自成行、**各画一次同一个片头**（真机：同一批步骤连着出现两遍）。
     * 排序后片内序与渲染序一致，下面那条"同一项只归一行"的去重才落得干净。
     */
    const presentationIndex = new Map<string, number>()
    for (const [at, n] of ordered.entries()) presentationIndex.set(n.key, at)
    /**
     * **本回合已经被某一行收下的项 / 片**。
     *
     * 不变式（分组那一层是靠"片 = 两次收口之间的连续区间"天然成立的，插件切段会破坏它）：
     *   · 一个**片**只由**一行**渲染 —— 否则同一批步骤会在屏幕上出现两遍；
     *   · 一个**项**只由**一行**渲染 —— 否则同一行内容会在两行里各来一次。
     * 归属按行序（= 呈现序）先到先得；被前面行收走的项，本行不再重复渲染。
     */
    const claimedItems = new Set<string>()
    const claimedGroups = new Set<string>()
    const rows: RenderRow[] = []
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index] as Segment
        const first = index === 0
        const last = index === segments.length - 1
        const chain: RenderChainItem[] = []
        const groups: RenderGroup[] = []
        for (const g of turnGroups.filter((g) => segment.groupKeys.includes(g.key))) {
            if (claimedGroups.has(g.key)) continue
            claimedGroups.add(g.key)
            const itemKeys: string[] = []
            /** 片内成员按**呈现位次**排（缺位次的事实排在最后，顺序按分组给的原始序）。 */
            const members = [...g.members].sort((a, b) =>
                (presentationIndex.get(a.key) ?? Number.POSITIVE_INFINITY)
                - (presentationIndex.get(b.key) ?? Number.POSITIVE_INFINITY))
            for (const member of members) {
                const n = model.nodes.get(member.key)
                if (n === undefined) continue
                const item = toChainItem(n, member.groupPart, model.todoBaselines)
                if (item === undefined) continue
                // 已经被前面某一行画过的项不再重复（同一项在整个回合里只有一个渲染位次）。
                if (claimedItems.has(item.key)) continue
                claimedItems.add(item.key)
                chain.push(item)
                itemKeys.push(item.key)
            }
            groups.push({ key: g.key, itemKeys, facts: renderGroupFacts(g, model, spec, presentation) })
        }
        const segmentAnswer = segment.nodes.filter((n) => n.kind === 'assistant-step' && hasReply(n)).at(-1)
        /**
         * 本行自己那一步的步号 —— **逐世代折叠的判据必须是它**，不是回合控制条的 `spec.answerStep`。
         *
         * ⚠️ 真机踩过（2026-10-11）：一个回合的每一段（每片一个回答步）都拿 `spec.answerStep`
         * （= 回合收尾那一步的号，实测 5 行全是 8）→ "谁都不早于当前世代" → **一个都折不起来**，
         * 屏幕上五段答句全铺着；网页端只留最后一段（上游 用的是
         * **每片自己的** `spec.answerStep`）。
         *
         * 段落切法本身来自插话 / 独立种类，所以"最后一段"就是当前世代；
         * 取不到自己那一步（旧宿主 / 无步号）时退回 `spec.answerStep`。
         */
        const segmentStep = segmentAnswer !== undefined && segmentAnswer.location.kind === 'step'
            ? segmentAnswer.location.step
            : undefined
        // 正文 = 本段**所有**回答步的文本按序拼接（中途那条也必须在，别只取最后一条）。
        const text = segment.nodes
            .filter((n) => n.kind === 'assistant-step')
            .map((n) => textOfBlocks(n.data['blocks']))
            .join('')
        const baseKey = control?.key ?? answer?.key ?? `turn:${turn}`
        /**
         * 本回合的**起点时刻**：`turnTimes` 是首选（它由 `turn/start` 填）。
         *
         * ⚠️ 分页/窗口截断会让 `turn/start` 不在窗口里 —— 那时 `turnTimes` 整条拿不到，
         * 而**回合时的长还是要显示**（网页端「已完成，用时 2分21秒」）。兜底顺序：
         *   ① `turnTimes.startMs`（真回合起点）；
         *   ② 本回合**最早的发起节点**（user / steering / turn-trigger）的 `time` —— 人类提问那一刻，
         *      与回合起点同拍（真机里 `user/message` 紧跟在 `turn/start` 之后 0.1~0.5 秒）；
         *   ③ 收官回答的时刻（最后一个兜底，`turn/start` 与人类消息都缺时至少不退化成`完成的时刻 = 自己`）。
         * 都没有 → 不填，`Chain` 那边就不带时长（不伪造 0 秒）。
         */
        // ⚠️ **兜底只在回合已关闭时用**（2026-10-10）：回合还在跑而 `turn/start` 没到时，
        // 宿主那句「回合开始时刻」确实是「还不知道」—— 拿人类消息的时刻去顶会让状态行从第一秒
        // 就显示时长（上游此时只写「深度求索中」，见 `runStatusText(undefined)`），属于**猜**。
        // 已关闭的回合则相反：窗口分页把 `turn/start` 切掉了，而时长**必须显示**
        //（网页端「已完成，用时 2分21秒」），这时用最早的发起节点/收官回答兜底是有据可依的近似。
        const turnStartOf = model.turnTimes.get(turn)?.startMs
            ?? (presentation?.turnClosed === true
                ? turnNodes
                    .filter((n) => n.kind === 'user' || n.kind === 'steering' || n.kind === 'turn-trigger')
                    .map((n) => n.time)
                    .filter((t): t is number => typeof t === 'number' && t > 0)
                    .sort((a, b) => a - b)[0]
                    ?? (answer !== undefined && answer.time > 0 ? answer.time : undefined)
                : undefined)
        /**
         * 本行的排序锚 —— **逐条对齐上游 `emit(pending[0]?.key ?? key, …)`**：
         *
         *   ① 插话边界（这一段的起点是那条人类输入）；
         *   ② 段内**最早可见成员**的锚，且成员锚若**早于开局人类输入**就拉成开局输入
         *     （上游 `presentationPosition` 的第二支：`anchor < openingInputAnchor && 非独立种类`
         *      → 锚 = 开局输入、**rank 2**；本文件顶部的 `ordered` 已按同一规则排过程序，
         *      这里只是让**行的 `pos` 与那套口径一致**）；
         *   ③ 还没有任何成员（流式首帧）→ 兜底控制锚。
         *
         * ⚠️ "**可见**成员"这半句不能少：`system-prompt` 是**隐藏**节点（聊天区不渲染它），
         * 而它的锚常在开局输入**之前**（真机 `54fdba8f` 回合 1：`system-prompt@18` 早于 `user:20`）——
         * 拿它取锚会把整行排到用户消息**上面**。上游那边是"先 `filter(isVisibleChatNode)`、
         * 再按可见节点派生根位置"，同一口径。
         *
         * ⚠️ 按回答步切行之后**不能**统一用 `controlAnchorSeq` 兜底 —— 那样多行的 `pos` 会相等，
         * 行序就靠不住（片头与正文会错位）。
         *
         * ⚠️ **这里曾经有一个"下界 = 开局人类输入"（`humanFloor`）**，2026-10-11 删除：
         * 它会把过程项**一路推到该回合所有插话之后**（真机同一会话的行序成了
         * `user:20 → 插话:106/185/577/593 → turn-process:1`，而网页端是
         * `user:20 → turn-process:1 → 片1 → 插话:106 → 片2 → …`）。
         * 上游让控条排在开局输入之后靠的是 **rank**，不是把锚点改成"输入与内容锚的较大者"。
         */
        const segmentAnchor = ((): number => {
            if (segment.boundary !== undefined) return segment.boundary
            const anchors = segment.nodes
                // `system-prompt` 在聊天区**不渲染**（`MessageList` 那一支返回 null）→ 它不该影响
                // 可见行的位置；否则它的锚（常在开局输入之前）会把整行拽到用户消息上面。
                .filter((n) => n.visibility === 'visible' && n.kind !== 'system-prompt')
                .map((n) => (openingInputAnchor !== undefined && n.anchorSeq < openingInputAnchor && !isAtOrOutside(n, 'turn')
                    ? openingInputAnchor
                    : n.anchorSeq))
                .filter((a): a is number => typeof a === 'number')
            return anchors.length > 0 ? Math.min(...anchors) : controlAnchorSeq
        })()
        /**
         * 本行的**排序三键** = 段内可见成员里"位置最小"的那一个的位置（上游 `emit(pending[0])` 同义）。
         * 比较器见 `nodesToRows` 的排序与上游 `orderedVisibleChatNodes()` 逐字对应。
         */
        const segmentSort = ((): { anchor: number; rank: number; originalAnchor: number } => {
            let best: { anchor: number; rank: number; originalAnchor: number } | undefined
            for (const n of segment.nodes) {
                if (n.visibility !== 'visible' || n.kind === 'system-prompt') continue
                const p = presentationPosition(n)
                if (best === undefined || p.anchor < best.anchor
                    || (p.anchor === best.anchor && p.rank < best.rank)
                    || (p.anchor === best.anchor && p.rank === best.rank && p.originalAnchor < best.originalAnchor)) {
                    best = { anchor: p.anchor, rank: p.rank, originalAnchor: p.originalAnchor }
                }
            }
            if (best !== undefined) return best
            // 段里没有可见成员（流式首帧）：用控条自己的位置（有开局输入则贴它之后）
            return presentationPosition(control ?? ({ kind: 'turn-process', anchorSeq: controlAnchorSeq } as ChatNode))
        })()
        rows.push({
            kind: 'assistant',
            key: first ? baseKey : `${baseKey}:seg${index}`,
            generation: segment.generation,
            turn,
            text,
            done: presentation?.turnClosed === true,
            chain,
            counts: {
                toolCallCount: typeof spec?.toolCallCount === 'number' ? spec.toolCallCount : 0,
                messageCount: typeof spec?.messageCount === 'number' ? spec.messageCount : 0,
                subagentCount: typeof spec?.subagentCount === 'number' ? spec.subagentCount : 0,
            },
            answerAnchorSeq: spec?.answerAnchorSeq === null || typeof spec?.answerAnchorSeq !== 'number' ? null : spec.answerAnchorSeq,
            controlAnchorSeq,
            processStartSeq: typeof spec?.processStartSeq === 'number' ? spec.processStartSeq : 0,
            answerStep: segmentStep ?? (spec?.answerStep === null || typeof spec?.answerStep !== 'number' ? null : spec.answerStep),
            inlineReasoning: spec?.inlineReasoning === true,
            hasExternalProcess: presentation?.hasExternalProcess === true,
            hasInterleavedInput: presentation?.hasInterleavedInput === true,
            compactAnswer: presentation?.compactAnswer === true,
            turnStarted: presentation?.turnStarted === true,
            turnClosed: presentation?.turnClosed === true,
            ...(segmentAnswer?.data['interrupted'] === true || (segmentAnswer?.data['finalNode'] as { interrupted?: boolean } | undefined)?.interrupted === true ? { interrupted: true } : {}),
            ...(segmentAnswer?.data['finalNode'] !== undefined ? { messageId: (segmentAnswer.data['finalNode'] as { messageId?: string }).messageId, seq: (segmentAnswer.data['finalNode'] as { seq?: number }).seq } : {}),
            // 本行的**时刻** = 本段自己那条回答的时刻（网页端每条回答节点带自己的时刻）。
            // 末行兜底回合的收口/开始时刻（尾片没有回答步时，动作条那一格还要有时刻）。
            ...(segmentAnswer !== undefined && segmentAnswer.time > 0
                ? { timeMs: segmentAnswer.time }
                : last && model.turnTimes.get(turn)?.endMs !== undefined
                    ? { timeMs: model.turnTimes.get(turn)?.endMs }
                    : last && model.turnTimes.get(turn)?.startMs !== undefined
                        ? { timeMs: model.turnTimes.get(turn)?.startMs }
                        : {}),
            // **回合级事实**（首行与末行都给）：控制行「已完成，用时 X」/「已停止」挂在**首行**
            //（`MessageList` 的 `ownsHead`），它要读 `status` 与 `stats`（时长口径 = `wallSec`）；
            // 动作条（时刻/复制/用量）挂在**末行**（`turnTail`），也要 `stats`。两份消费者都受各自的门控，
            // 所以重复下发是安全的；按回答步切行之后只挂末行会让首行的控制行丢掉时长/停止原因。
            ...(first || last
                ? {
                    ...(turnStartOf === undefined ? {} : { turnStartMs: turnStartOf }),
                    ...(model.turnTimes.get(turn)?.status === undefined ? {} : { status: model.turnTimes.get(turn)?.status }),
                    ...(model.turnStats.get(turn) === undefined ? {} : { stats: model.turnStats.get(turn) }),
                }
                : {}),
            // 「尾」**内容**只挂末行：交付、改动、定时任务卡都在回合收口处。
            ...(last
                ? {
                    ...(model.turnPresented.get(turn) === undefined ? {} : { presentedFiles: model.turnPresented.get(turn) }),
                    ...(model.turnChanges.get(turn) === undefined ? {} : { changesSeq: model.turnChanges.get(turn) }),
                    ...(scheduleResults.length === 0 ? {} : { scheduleResults }),
                }
                : {}),
            pos: segmentAnchor + 0.5,
            // 排序三键（上游比较器逐字同口径；`pos` 只作诊断/透明用途）
            sortAnchor: segmentSort.anchor,
            sortRank: segmentSort.rank,
            sortOriginalAnchor: segmentSort.originalAnchor,
            groups,
        })
    }
    return rows
}

/**
 * 一片过程的折叠事实。
 *
 * 上游把折叠判据摊在 seat 内部（`ChatGroupSeat` 的 `outerHidden`/`alwaysOpen`/`grouped`，
 * 各自读 turn-process presentation + 本组 presentation），插件把它们收成一份 facts 传给折叠头。
 * **判据本身与上游同源**（同一个 `derivePresentation` 的字段）；差异只在「装在哪里」，不是取值口径。
 */
function renderGroupFacts(g: ProcessGroupSnapshot, model: ChatNodeModel, spec: { controlAnchorSeq?: unknown; processStartSeq?: unknown } | undefined, presentation: ProcessPresentation | undefined): DshRowGroupFacts {
    const members = g.members.map((m) => model.nodes.get(m.key)).filter((n): n is ChatNode => n !== undefined)
    // 收口成员 = 'response' groupPart 的 assistant-step（回答世代）；推理片/工具片没有回答成员 → 无锚点
    const closing = members.find((n) => g.members.some((m) => m.key === n.key && m.groupPart === 'response'))
    const closingStep = closing?.location.step ?? null
    const blocks = closing !== undefined && closing.kind === 'assistant-step' ? (closing.data['blocks'] ?? []) as ChatBlock[] : []
    return {
        answerAnchorSeq: closing?.anchorSeq ?? null,
        answerStep: closingStep,
        inlineReasoning: blocks.some((b) => b.kind === 'reasoning' && b.text.trim() !== ''),
        turnStarted: presentation?.turnStarted ?? false,
        controlAnchorSeq: (spec?.controlAnchorSeq as number | undefined) ?? 0,
        processStartSeq: (spec?.processStartSeq as number | undefined) ?? 0,
        // 片内除收口步外还有别的成员（工具/上下文/更早的步）才算「有过程外置」
        hasExternalProcess: members.some((n) => n.kind !== 'assistant-step' || (n.location.step !== closingStep)),
        // 上游 `data.closed`（组收口 || 回合关闭）：分组头的文案/图标看它，不看回合的 done
        closed: g.data['closed'] === true,
        // 上游 `data.summary`（时间序、递归 subCalls、callId 去重）：片头 label/detail/icon 的**唯一**来路。
        // 缺了它才退回按链项现算（老宿主），见 process-group-view 的注释。
        summary: g.data['summary'] as DshRowGroupSummary | undefined,
        compactAnswer: presentation?.compactAnswer ?? false,
    }
}

/**
 * 该步是不是「带回答内容的步」（行切段 / 收口判据）。
 *
 * ⚠️ **与分组的 `reply()`、与 `latestAnswer` 必须同一口径**：只要有一个非空白文本块就算 ——
 * 带工具调用的步**也算**（上游 `hasAssistantReplyContent` 只排除 reasoning / tool-call **块本身**）。
 * 别用 render-plan 自己数 text 块（早先写过一版，两者迟早漂开）。
 */
function hasReply(node: ChatNode): boolean {
    return hasAssistantReplyContent((node.data['blocks'] ?? []) as ChatBlock[])
}

/** 工具结果内容 → 纯文本（**与宿主同一份实现**，别再写第二套展平规则）。 */
function resultTextOf(content: unknown): string {
    return resultText(content)
}

function textOfBlocks(blocks: unknown): string {
    if (!Array.isArray(blocks)) return ''
    return blocks.map((b) => (b !== null && typeof b === 'object' && (b as { kind?: unknown }).kind === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('')
}
