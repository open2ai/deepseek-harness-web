// 工作区会话：**纯逻辑**（不碰 VS Code / RPC / 状态订阅），只负责
// “成员表 sessionIds → 下拉行”的映射与顺序。
//
// 顺序规则（真机反馈）：严格按上游工作区成员表 `sessionIds` 的顺序；
// **不按 current / running 重排**。当前/运行中只是行内状态，不是排序键。
//
// 之后的工作区 UI（VS Code QuickPick / webview 下拉 / 原生标题栏）都只消费这里的结果，
// 不允许各自再写一份过滤/排序。

/** 上游 `session.list` 里本模块用到的字段（其余字段原样忽略）。 */
export interface WorkspaceSessionCandidate {
    sessionId?: string
    running?: boolean
    blank?: boolean
    origin?: string
    cwd?: string
    title?: string
    projectionValues?: Record<string, unknown>
    projections?: { values?: Record<string, unknown> }
    // 上游 session.list 若带状态字段就透传；没有则由 UI 退化为 idle/ongoing。
    pendingInteraction?: { kind?: string }
    runningSubagentCount?: number
    completionUnread?: boolean
}

/** 下拉/QuickPick 共用的一行会话。 */
export interface WorkspaceSessionRow {
    sessionId: string
    title: string
    running: boolean
    blank: boolean
    current: boolean
    pendingInteraction?: 'approval' | 'plan-review' | 'question'
    runningSubagentCount?: number
    completed?: boolean
}

/**
 * 把某工作区的成员表和 session.list 结果映射成展示行。
 *
 * @param input - 工作区成员顺序、session.list 条目、当前会话 id、标题解析器。
 * @returns 按 `sessionIds` 顺序排列的会话行（空白会话只保留当前会话）。
 */
export function mapWorkspaceSessions(input: {
    sessionIds: readonly string[]
    items: readonly WorkspaceSessionCandidate[]
    currentSessionId?: string
    /** 由宿主提供的标题解析（durable title → cwd basename → sessionId）。 */
    titleOf: (item: WorkspaceSessionCandidate) => string
}): WorkspaceSessionRow[] {
    const byId = new Map<string, WorkspaceSessionCandidate>()
    for (const item of input.items) {
        if (typeof item.sessionId === 'string' && item.sessionId !== '') {
            byId.set(item.sessionId, item)
        }
    }
    const rows: WorkspaceSessionRow[] = []
    for (const sessionId of input.sessionIds) {
        const item = byId.get(sessionId)
        if (item === undefined) {
            continue
        }
        if (item.origin === 'subagent') {
            continue
        }
        const current = sessionId === input.currentSessionId
        // 纯空「新会话」：除非就是当前会话（显示为选中），否则不列出。
        if (item.blank === true && item.running !== true && !current) {
            continue
        }
        const pendingKind = item.pendingInteraction?.kind
        rows.push({
            sessionId,
            title: item.blank === true ? '新会话' : input.titleOf(item),
            running: item.running === true,
            blank: item.blank === true,
            current,
            ...(pendingKind === 'approval' || pendingKind === 'plan-review' || pendingKind === 'question'
                ? { pendingInteraction: pendingKind }
                : {}),
            ...(typeof item.runningSubagentCount === 'number' ? { runningSubagentCount: item.runningSubagentCount } : {}),
            ...(item.completionUnread === true ? { completed: true } : {}),
        })
    }
    return rows
}
