// 节点模型渲染行 → ChatRow（渲染源切换的桥）：把 `nodesToRows` 的 RenderRow 映射成组件消费的 ChatRow。
// 与旧「宿主行→渲染行」映射同角色（旧通路已退役）：展示派生（标题/摘要/时钟）在组件侧，这里只搬运事实 + 补缺省。
//
// key：节点模型用语义串（`user:2`/`1:1`/`tool:c1`），ChatRow.key 是 number —— 用会话内稳定的字符串→整数映射（同 reducer 的 rowCache 思路）。
import { contextForm, contextProducer } from '../nodes/event-projection'
import { deriveToolSummary, formatMsgClock, toolTitle } from '../format'
import { scheduleCardOf } from '../details-card'
import { resultText } from '../../../../src/dsh/official/result-text'
import type { RenderChainItem, RenderGroup, RenderRow, RenderSubCall } from '../nodes/render-plan'
import type { DshChangesSummary, DshTurnProcess } from '../../../../src/dsh/rows/types'
import type { ChatRow, DshTurnProcessItem, ToolSubCall } from './types'

let keySeq = 1
const keyMap = new Map<string, number>()
function keyOf(s: string): number {
    let n = keyMap.get(s)
    if (n === undefined) { n = keySeq++; keyMap.set(s, n) }
    return n
}
/** 换会话/清空时复位 key 映射（与 rowCache 同生命周期）。 */
export function resetNodeKeyMap(): void {
    keyMap.clear()
    keySeq = 1
}
/**
 * **节点 key → 行 key**（公开入口）。
 *
 * 行表用的是数字 key，而节点模型的 key 是会话内语义串（`turn-process:1:seg1`）——
 * 两者靠这张映射对应。**任何按 key 关联"节点/计划"与"行"的地方都必须走它**：
 * 自建第二份映射、或直接拿字符串 key 去行表里查，都会 100% 落空
 *（2026-10-11 座位计划就是这么对不上的：计划里是 `turn-process:1:seg1`，行表里是 `7`）。
 */
export function rowKeyOfNodeKey(s: string): number {
    return keyOf(s)
}

export function toChatRowsFromNodes(rows: readonly RenderRow[], changesSummary?: Record<string, unknown>): ChatRow[] {
    return rows.map((r) => toChatRowFromNode(r, changesSummary))
}

function toChatRowFromNode(r: RenderRow, changesSummary?: Record<string, unknown>): ChatRow {
    switch (r.kind) {
        case 'user':
            /**
             * ⚠️ **附件引用必须搬**（2026-10-11 修）：原先这里硬写 `images: []`，而 `RenderRow`
             * 又没有附件字段 —— 两处一起把用户消息里的图片/文件丢干净（真机现象：会话区不显示、
             * 也点不开）。`imageRefs` 走附件层按 `attachmentId` 向宿主取字节（与图片卡同一条路）。
             */
            return { kind: 'user', key: keyOf(r.key), text: r.text, images: [], time: r.timeMs !== undefined ? formatMsgClock(r.timeMs) : '', ...(r.rpcId !== undefined ? { rpcId: r.rpcId } : {}), ...(r.steering === true ? { steering: true } : {}), ...(r.imageRefs !== undefined ? { imageRefs: r.imageRefs as never } : {}), ...(r.files !== undefined ? { files: r.files } : {}) }
        case 'sysprompt':
            return { kind: 'sysprompt', key: keyOf(r.key), text: r.text }
        case 'command':
            return { kind: 'command', key: keyOf(r.key), commandId: '', name: r.name, ...(r.outcome === undefined ? {} : { outcome: r.outcome as { kind: 'success' | 'error'; text?: string } }) }
        case 'compaction':
            return { kind: 'compaction', key: keyOf(r.key), compactionId: '', seq: 0, ...(typeof r.summary === 'string' ? { summary: r.summary } : {}), ...(typeof r.shadowedItemCount === 'number' ? { shadowedItemCount: r.shadowedItemCount } : {}), ...(typeof r.shadowedTokenCount === 'number' ? { shadowedTokenCount: r.shadowedTokenCount } : {}) }
        case 'retry':
            return { kind: 'retry', key: keyOf(r.key), retryId: r.retryId, retry: r.retry, ...(r.turn === undefined ? {} : { turn: r.turn }), ...(r.step === undefined ? {} : { step: r.step }), ...(r.started === undefined ? {} : { started: r.started }), ...(r.cancelled === true ? { cancelled: true } : {}) }
        case 'turnNotice':
            return { kind: 'turnNotice', key: keyOf(r.key), tone: r.tone, ...(r.turn === undefined ? {} : { turn: r.turn }), ...(r.step === undefined ? {} : { step: r.step }), ...(r.message === undefined ? {} : { message: r.message }), ...(r.code === undefined ? {} : { code: r.code }) }
        case 'context':
            return { kind: 'context', key: keyOf(r.key), content: asBlockArray(r.content), source: r.source, provenance: contextProducer(r.source), form: contextForm(r.source) }
        case 'trigger':
            return { kind: 'trigger', key: keyOf(r.key), source: r.source, content: asBlockArray(r.content), time: formatMsgClock(r.timeMs) }
        case 'assistant': {
            const process: DshTurnProcess = {
                answerAnchorSeq: r.answerAnchorSeq,
                answerStep: r.answerStep,
                controlAnchorSeq: r.controlAnchorSeq,
                processStartSeq: r.processStartSeq,
                inlineReasoning: r.inlineReasoning,
                turnStarted: r.turnStarted,
                hasExternalProcess: r.hasExternalProcess,
                hasInterleavedInput: r.hasInterleavedInput,
                compactAnswer: r.compactAnswer,
            }
            return {
                kind: 'assistant',
                key: keyOf(r.key),
                time: r.timeMs !== undefined ? formatMsgClock(r.timeMs) : '',
                done: r.done,
                prompt: '',
                text: r.text,
                stats: '',
                chain: r.chain.map(toChainItemFromNode),
                counts: r.counts,
                bodyStarted: true,
                process,
                nodeGroups: r.groups.map((g: RenderGroup) => ({ key: keyOf(g.key), itemKeys: g.itemKeys.map(keyOf), facts: g.facts })),
                // 世代号（外层折叠「有没有被插话切开」的判据，见 store/types.ts）
                ...(r.generation === undefined ? {} : { generation: r.generation }),
                ...(r.turn === undefined ? {} : { turn: r.turn }),
                ...(r.turnStartMs === undefined ? {} : { turnStartMs: r.turnStartMs }),
                // ⚠️ `timeMs` 必须原样带过去（2026-10-10）：它是「本行所属时刻」的**数值**形态，
                // 已定稿摘要行用它算回合时长（`Chain` 的 `wallMs` 兜底那条路）。原先只带了格式化后的
                // `time`（"10:00" 那种显示串），于是 `turnStartMs` 有、`timeMs` 没有 → 时长整段消失。
                ...(r.timeMs === undefined ? {} : { timeMs: r.timeMs }),
                ...(r.status === undefined ? {} : { status: r.status }),
                ...(r.stats === undefined ? {} : { usageRaw: r.stats }),
                ...(r.presentedFiles === undefined ? {} : { presentedFiles: r.presentedFiles }),
                ...(r.changesSeq === undefined ? {} : { changesSeq: r.changesSeq }),
                ...(r.changesSeq !== undefined && changesSummary?.[String(r.changesSeq)] != null ? { changesSummary: changesSummary[String(r.changesSeq)] as DshChangesSummary } : {}),
                ...(scheduleCardsOf(r.scheduleResults) === undefined ? {} : { scheduleCreated: scheduleCardsOf(r.scheduleResults) }),
                ...(r.interrupted === true ? { interrupted: true } : {}),
                ...(r.seq === undefined ? {} : { seq: r.seq }),
                ...(r.messageId === undefined ? {} : { messageId: r.messageId }),
            }
        }
    }
}

/** 本回合已创建的定时任务卡（镜像上游 `ui-schedule`：标题 + 重复规则）。 */
function scheduleCardsOf(texts: readonly string[] | undefined): Array<{ id: string; title: string; frequency: string }> | undefined {
    if (texts === undefined || texts.length === 0) return undefined
    const out: Array<{ id: string; title: string; frequency: string }> = []
    for (const text of texts) {
        let value: unknown
        try { value = JSON.parse(text) } catch { continue }
        const card = scheduleCardOf(value)
        if (card !== null) out.push(card)
    }
    return out.length === 0 ? undefined : out
}

/**
 * 内容块的**归一化**：真窗口里既有数组形态（常见）也有**单个块对象**形态的注入。
 *
 * 下游（`context-body.ts` / `ContextInjectionRow` / `visibleStepTexts`）一律按数组消费，
 * 所以形状收口放在**这一层**：到这儿之后 `content` 恒为数组（空/未知 → 空数组）。
 * 少了这一步，单块形态会在渲染时抛 `content is not iterable`（那一行整行落成 `row-error`）。
 */
function asBlockArray(content: unknown): unknown[] {
    if (Array.isArray(content)) return content
    return content === null || content === undefined ? [] : [content]
}
/** 嵌套调用 → 工具子项（与根行同构，只是没有自己的 key/step：它是父调用的一格）。 */
function toSubCallFromNode(c: RenderSubCall): ToolSubCall {
    return {
        kind: 'tool',
        key: keyOf(`sub:${c.callId}`),
        callId: c.callId,
        name: c.name,
        title: toolTitle(c.name),
        summary: deriveToolSummary(c.argsRaw, c.name),
        ...(c.argsRaw === undefined ? {} : { argsRaw: c.argsRaw }),
        status: c.status,
        ...(c.content === undefined ? {} : { output: resultText(c.content, c.errorName === undefined && c.errorCode === undefined ? undefined : { name: c.errorName, code: c.errorCode }) }),
        ...(c.meta === undefined ? {} : { meta: c.meta }),
        ...(c.parentCallId === undefined ? {} : { parentCallId: c.parentCallId }),
        ...(c.errorName === undefined ? {} : { errorName: c.errorName }),
        ...(c.errorCode === undefined ? {} : { errorCode: c.errorCode }),
        ...(c.errorReason === undefined ? {} : { errorReason: c.errorReason }),
        ...(c.subCalls === undefined ? {} : { subCalls: c.subCalls.map(toSubCallFromNode) }),
    }
}

function toChainItemFromNode(c: RenderChainItem): DshTurnProcessItem {
    if (c.kind === 'reasoning') {
        return { kind: 'reasoning', key: keyOf(c.key), ...(c.step === undefined ? {} : { step: c.step }), text: c.text }
    }
    if (c.kind === 'context') {
        return { kind: 'context', key: keyOf(c.key), content: asBlockArray(c.content), source: c.source, provenance: contextProducer(c.source), form: contextForm(c.source) }
    }
    if (c.kind === 'text') {
        return { kind: 'text', key: keyOf(c.key), ...(c.step === undefined ? {} : { step: c.step }), text: c.text }
    }
    // 命令行 / 手动压缩进链（上游把两者当片的成员）：事实原样搬，渲染与顶层那条共用 `CommandRow`。
    if (c.kind === 'command') {
        return { kind: 'command', key: keyOf(c.key), name: c.name, ...(c.outcome === undefined ? {} : { outcome: c.outcome as { kind: 'success' | 'error'; text?: string } }) }
    }
    return {
        kind: 'tool',
        key: keyOf(c.key),
        ...(c.step === undefined ? {} : { step: c.step }),
        ...(c.callId === undefined ? {} : { callId: c.callId }),
        name: c.name,
        title: toolTitle(c.name),
        summary: deriveToolSummary(c.argsRaw, c.name),
        ...(c.argsRaw === undefined ? {} : { argsRaw: c.argsRaw }),
        status: c.status,
        // 结果文本要**按官方口径展平**（text 块原样 + 其余块 pretty JSON + 空内容带结构化错误时 `name: code`）。
        // 早先这里对内容数组直接 `JSON.stringify` —— 于是所有「解析结果文本」的卡（提问卡 / 详情卡 /
        // 终端 / 读文件 / 搜索 / 差异…）拿到的都是一串**包着块的 JSON**，解析全失败：
        // 提问卡真机表现就是「提问 · 未取到回答」（答案 JSON 解析不出来）。
        ...(c.content === undefined
            ? {}
            : {
                output: resultText(
                    c.content,
                    c.errorName === undefined && c.errorCode === undefined
                        ? undefined
                        : { name: c.errorName, code: c.errorCode }
                ),
            }),
        ...(c.meta === undefined ? {} : { meta: c.meta }),
        // 结果里含图片块时的**原始块**（图片卡的输入）：与宿主那条路同一个字段名；
        // 漏搬它 = 图片卡拿不到内容、静默落通用卡（真机 68 条 `read_image` 全落，2026-10-11 修）。
        ...(c.blocks === undefined ? {} : { blocks: c.blocks }),
        ...(c.parentCallId === undefined ? {} : { parentCallId: c.parentCallId }),
        ...(c.subCalls === undefined ? {} : { subCalls: c.subCalls.map(toSubCallFromNode) }),
        ...(c.errorName === undefined ? {} : { errorName: c.errorName }),
        ...(c.errorCode === undefined ? {} : { errorCode: c.errorCode }),
        ...(c.errorReason === undefined ? {} : { errorReason: c.errorReason }),
    }
}
