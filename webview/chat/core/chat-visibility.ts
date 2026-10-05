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

/** 链上的一项（可见性判定只用这两件事）。 */
export interface ChainItemLike {
  kind?: string
  content?: readonly unknown[]
}

/**
 * 一条 assistant 行**有没有可显示的内容**：正文非空，或链上至少有一项可见。
 *
 * 上游的次序是**先过滤、后算**：可见性过滤发生在排序与"过程呈现"之前，一个回合里
 * **只有不可见节点**时，它在聊天区**一条行都不占** —— 这一层必须与那个次序一致。
 *
 * 真机来历：`/plan` 会补一条
 * `user/message`（`source.kind === 'plan-mode'`）的**通知注入**，它落在 `turn/end` 之后、上一段已收束，
 * 于是 `ensureActive()` 为它单独开了一条回答行；那条行链上只有这条不可见注入 → 修前渲染成
 * 「已完成 + 已完成分析」的**空块**（上游没有：那条注入被 `isVisibleChatNode` 排除，而该回合的
 * 控制行按**最早可见过程锚**落在真正有内容的那条行上）。
 *
 * @param row - assistant 行（只读 `text` 与 `chain` 的项种类/内容）。
 */
export function hasVisibleAssistantContent(row: { text?: string; chain?: readonly ChainItemLike[] }): boolean {
  if (typeof row.text === 'string' && row.text !== '') return true
  return (row.chain ?? []).some((item) => isVisibleContextItem({
    kind: typeof item.kind === 'string' ? item.kind : '',
    ...(Array.isArray(item.content) ? { content: item.content } : {}),
  }))
}

/**
 * 这一行是否进聊天区。
 *
 * ⚠️ 上游 `isVisibleChatNode` 还**剔除 `name === 'permission'` 的命令行**（`contract/chat-visibility.ts`）：
 * 权限预设切换在界面上由 Access chip 表达，命令行不再重复一行。
 * @param row - 行（用 `kind`；`context` 行看 `content`；`command` 行看 `name`；`assistant` 行看 `text`/`chain`）。
 */
export function isVisibleChatRow(row: {
  kind: string
  content?: readonly unknown[]
  /** `command` 行：命令名 */
  name?: string | null
  /** `assistant` 行：正文 */
  text?: string
  /** `assistant` 行：过程链 */
  chain?: readonly ChainItemLike[]
}): boolean {
  if (row.kind === 'sysprompt') return false
  if (row.kind === 'command' && row.name === 'permission') return false
  // assistant 行：一条可见内容都没有的（例如「只有一条不可见注入」）**不占聊天区的一行**
  if (row.kind === 'assistant') return hasVisibleAssistantContent(row)
  return isVisibleContextItem(row)
}
