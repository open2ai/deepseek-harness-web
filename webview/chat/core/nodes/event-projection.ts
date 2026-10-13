// 事件投影纯函数：块分类 / 可见增量 / 上下文来源 / 失败规范化。
// 属客户端节点模型：宿主转发事件时已附派生字段，这里只做**展示所需的轻投影**，
// 不重做三层解包（解包只在宿主 `official/`，逻辑只写一份）。
import type { ChatBlock } from './types'

/** 一个 wire 内容块。 */
type WireBlock = { type?: unknown; text?: unknown; attachment?: unknown; id?: unknown; name?: unknown; arguments?: unknown }

/** wire 块 → Chat 块（上游 `toAssistantBlock`）。 */
export function toAssistantBlock(block: WireBlock): ChatBlock {
    switch (block.type) {
        case 'text':
            return { kind: 'text', text: String(block.text ?? '') }
        case 'reasoning':
            return { kind: 'reasoning', text: String(block.text ?? '') }
        case 'image':
            return { kind: 'image', attachment: block.attachment }
        case 'tool-call':
            return {
                kind: 'tool-call',
                callId: String(block.id ?? ''),
                name: String(block.name ?? ''),
                argsRaw: String(block.arguments ?? ''),
            }
        default:
            return { kind: 'other', block }
    }
}

/** 内容块数组 → Chat 块数组（上游 `toAssistantBlocks`）。 */
export function toAssistantBlocks(content: unknown): ChatBlock[] {
    if (!Array.isArray(content)) return []
    return content.map((b) => toAssistantBlock((b ?? {}) as WireBlock))
}

/** 一个块是否可见（上游 `blockIsVisible`）：tool-call 不可见；text/reasoning 需非空白；其余可见。 */
export function blockIsVisible(block: ChatBlock | undefined): boolean {
    if (block === undefined || block.kind === 'tool-call') return false
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
}

/** 有「回答内容」吗（上游 `hasAssistantReplyContent`）：非推理、非工具、非空白文本。 */
export function hasAssistantReplyContent(blocks: readonly ChatBlock[]): boolean {
    return blocks.some((b) => b.kind === 'text' ? b.text.trim() !== '' : b.kind !== 'reasoning' && b.kind !== 'tool-call')
}

/** 一个 stream chunk 是否携带可见模型输出（上游 `isTokenDelta`）。 */
export function isTokenDelta(chunk: { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown }): boolean {
    switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta':
            return chunk.text !== ''
        case 'tool-call-delta':
            return chunk.argumentsDelta !== '' || chunk.name !== undefined
        default:
            return false
    }
}

/** 一个 stream chunk 是否可见（上游 `visibleChunk`）。 */
export function visibleChunk(chunk: Record<string, unknown>): boolean {
    const type = chunk['type']
    if (type === 'text-delta' || type === 'reasoning-delta') return String(chunk['text'] ?? '').trim() !== ''
    if (type === 'block-start') return chunk['blockType'] !== 'text' && chunk['blockType'] !== 'reasoning' && chunk['blockType'] !== 'tool-call'
    if (type !== 'block-end') return false
    const block = (chunk['block'] ?? {}) as WireBlock
    if (block.type === 'tool-call') return false
    if (block.type === 'text' || block.type === 'reasoning') return String(block.text ?? '').trim() !== ''
    return true
}

const KNOWN_FORMS = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'] as const

/** 上下文消息的呈现形式（上游 `contextForm`）。 */
export function contextForm(source: unknown): string | null {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
    const form = (source as Record<string, unknown>)['form']
    const f = typeof form === 'string' && form.length > 0 ? form : null
    return f !== null && (KNOWN_FORMS as readonly string[]).includes(f) ? f : null
}

/** 上下文来源 → 角色与生产标签（上游 `contextProducer`）。 */
export function contextProducer(source: unknown): { role: 'inject' | 'recall'; label: string | null } {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return { role: 'inject', label: null }
    const record = source as Record<string, unknown>
    const kind = typeof record['kind'] === 'string' && record['kind'].length > 0 ? record['kind'] : null
    if (kind === null) return { role: 'inject', label: null }
    if (kind === 'session-reference') {
        return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind }
    }
    if (kind === 'agent-instructions') {
        return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind }
    }
    if (kind === 'skill-invocation') {
        const name = typeof record['name'] === 'string' && record['name'].length > 0 ? record['name'] : null
        return { role: 'inject', label: name ?? kind }
    }
    return { role: 'inject', label: kind }
}

/** 取来源里某成员数组的 `field` 字段（去重、保序）。 */
function collect(source: Record<string, unknown>, member: string, field: string): string[] {
    const list = source[member]
    if (!Array.isArray(list)) return []
    const seen: string[] = []
    for (const entry of list) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const value = (entry as Record<string, unknown>)[field]
        if (typeof value === 'string' && value.length > 0 && !seen.includes(value)) seen.push(value)
    }
    return seen
}

function joined(names: string[]): string | null {
    return names.length > 0 ? names.join(', ') : null
}

/** 失败规范化（上游 `displayFailure`）：AUTH 只留 code、不给 message（防凭据进 UI）。 */
export function displayFailure(failure: unknown): { message: string; code?: string } {
    if (failure === null || typeof failure !== 'object') return { message: String(failure) }
    const record = failure as Record<string, unknown>
    const code = typeof record['code'] === 'string' ? record['code'] : undefined
    if (code === 'AUTH') return { code, message: '' }
    const message = typeof record['message'] === 'string' ? record['message'] : JSON.stringify(failure)
    return code === undefined ? { message } : { message, code }
}
