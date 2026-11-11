// **聊天区可见性**：一行到底显不显示（独立纯函数；判据只写这一处，渲染处不再各写一遍）。
//
// 规则（dsh 0.2.2-rc.2 口径）：系统提示词行不显示；权限命令不显示；成功的团队开关回执不显示（失败回执保留）；
// **普通上下文注入照常显示**。
//
// ⚠️ **本代相对前代是反向调整**：前代「普通上下文注入不显示，只有含工具增删块的那一类保留」，
// 本代上游删掉了对上下文的排除 —— 工作区指令、技能目录、召回等注入现在都要出现在会话区，
// 并按工具行呈现、可展开。别再把旧规则抄回来。
//
// 只在**渲染层**过滤：数据层不动（被隐藏的行仍在会话日志里，宿主照旧下发）。

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * 内容里**有没有**工具增删块。
 *
 * ⚠️ **两种形状都要容**（2026-10-10 真机）：数组（常见）与**单个块对象**（真窗口里就有）。
 * 原先直接 `content.some(...)` —— 遇到单块形状会抛 `content.some is not a function`：
 * 那一条注入所在的行会整行渲染失败（落成 `row-error` 的错误行）。
 * @param content - 内容块（数组或单块；坏形一律当作「没有」）。
 */
export function hasToolChangeBlock(content: readonly unknown[] | unknown): boolean {
  const blocks = Array.isArray(content) ? content : content === null || content === undefined ? [] : [content]
  return blocks.some((block) => {
    const record = asRecord(block)
    return record !== null && (record['type'] === 'tool-addition' || record['type'] === 'tool-removal')
  })
}

/**
 * 一条 `context` **链项**是否进聊天区：**恒可见**。
 *
 * 0.2.2-rc.2 上游删掉了「普通上下文不显示、只留工具增删通知」的排除规则，工作区指令与技能目录等注入
 * 都要按工具行呈现且可展开。保留这个函数是为了让调用点语义不变（判据仍只有这一处），
 * 也便于将来若再收紧时只改这里。
 * @param _entry - 链项（当前不参与判定）。
 */
export function isVisibleContextItem(_entry: { kind: string; content?: readonly unknown[] }): boolean {
  return true
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
 * ⚠️ 上游 `isVisibleChatNode` **剔除 `name === 'permission'` 的命令行**（由 Access chip 表达）；
 * 另外 `export` / `feedback` 在网页端是客户端动作（下载 / 反馈），本来就不产生聊天行 ——
 * 插件由宿主执行这两个命令会落 command 事件，这里按同一「不可见」口径过滤。
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
  if (row.kind === 'command' && (row.name === 'permission' || row.name === 'export' || row.name === 'feedback')) return false
  // assistant 行：一条可见内容都没有的（例如「只有一条不可见注入」）**不占聊天区的一行**
  if (row.kind === 'assistant') return hasVisibleAssistantContent(row)
  return isVisibleContextItem(row)
}
