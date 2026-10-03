// **聊天区可见性**：一行到底显不显示（独立纯函数；判据只写这一处，渲染处不再各写一遍）。
//
// 规则：系统提示词行不显示；普通上下文注入不显示，只有**含**工具增删块的那一类保留
//（就是工具变更通知行）；其余行照常。
//
// 两个容易踩的点：
//   1. 可见性 != 形态：这里只要求内容里**有**工具增删块；改成工具变更**形态**还要求每一块都是
//      （见 `context-body.ts` 的 `toolChange()`）—— 混合内容会留下，并按普通注入行渲染。
//   2. 只在**渲染层**过滤：数据层不动（被隐藏的行仍在会话日志里，宿主照旧下发）。

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * 内容里**有没有**工具增删块。
 * @param content - 内容块数组（可能坏形；认不出的块不算）。
 */
export function hasToolChangeBlock(content: readonly unknown[]): boolean {
  return content.some((block) => {
    const record = asRecord(block)
    return record !== null && (record['type'] === 'tool-addition' || record['type'] === 'tool-removal')
  })
}

/**
 * 一条 `context` **链项**是否进聊天区（与行的规则同源，见 `isVisibleChatRow`）。
 * @param entry - 链项（只用 `kind` 与 `context` 的 `content`）。
 */
export function isVisibleContextItem(entry: { kind: string; content?: readonly unknown[] }): boolean {
  return entry.kind !== 'context' || hasToolChangeBlock(entry.content ?? [])
}

/**
 * 这一行是否进聊天区。
 * @param row - 行（只用 `kind` 与 `context` 行的 `content`）。
 */
export function isVisibleChatRow(row: { kind: string; content?: readonly unknown[] }): boolean {
  if (row.kind === 'sysprompt') return false
  return isVisibleContextItem(row)
}
