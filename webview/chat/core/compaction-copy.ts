// 压缩标记（上游 `compaction` 节点 / `CompactionItem`）的**文案决议**（纯函数、有守卫）。
//
// 逐字取自上游 zh 字典：标题「上下文已压缩」、有计数时「已压缩 {items} 条历史记录（约 {tokens} tokens）」、
// 可展开时提示「点击查看压缩摘要」、拿不到摘要时「压缩摘要不可用」。
// 两处上游细节：摘要**缺失即不可展开**（`expandable = summary !== null`）；计数**两项都有**才用带数字的文案。

/** 标题（上游 `message.compaction`）。 */
export const COMPACTION_TITLE = '上下文已压缩'

/** 展开提示（上游 `message.compaction.expand`）。 */
export const COMPACTION_EXPAND = '点击查看压缩摘要'

/** 摘要不可用（上游 `message.compaction.unavailable`）。 */
export const COMPACTION_UNAVAILABLE = '压缩摘要不可用'

/** 手动压缩卡片的标题（上游 `message.compaction.commandTitle`）—— 命令行那一支用。 */
export const COMPACTION_COMMAND_TITLE = 'compact'

/**
 * 摘要行文案：**两项计数都有**时用带数字的文案，否则按"摘要能不能展开"给提示。
 *
 * @param row - 该行的事实（`summary` 决定可展开性，两个计数决定文案档）。
 * @returns 一行文案。
 */
export function compactionSummaryText(row: {
    summary?: string
    shadowedItemCount?: number
    shadowedTokenCount?: number
}): string {
    if (typeof row.shadowedItemCount === 'number' && typeof row.shadowedTokenCount === 'number') {
        return `已压缩 ${String(row.shadowedItemCount)} 条历史记录（约 ${String(row.shadowedTokenCount)} tokens）`
    }
    return row.summary === undefined ? COMPACTION_UNAVAILABLE : COMPACTION_EXPAND
}

/** 该行能不能展开（上游：只有拿得到摘要才可展开）。 */
export function compactionExpandable(row: { summary?: string }): boolean {
    return row.summary !== undefined
}
