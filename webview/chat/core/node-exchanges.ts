// 「最新交互段」与「收起时机」的判据（纯函数，供 `MessageList` 共用）。
//
// 上游把「回合」按"有没有人在第一步提问"切成**交互段** —— 一个回合只要它是人开的（该回合里有一条
// **不是插话**的用户消息），它就开启一个新段；段一直持续到**下一个**这样的回合。收起时机选
// 「下次发送时收起」时，只有**最新这一段里**的已定稿回合才保持展开；通知唤醒的回合（子代理完成、
// 定时任务、后台作业）不会开启新段，因此它们收不起来同一段里更早的回合 —— 这是上游明确的口径。
//
// ⚠️ **判据用"行在表里的位置"，不用"回合号比较"**：
//
// 上一版按"该行的 `turn` ≥ 段起点的 `turn`"判，依赖每行都带回合号。实际数据里**用户行没有 `turn`**
// （页面行模型只给 assistant 行带），于是"段起点"退化成"第一条带回合号的行"——段起点变得比真实段早，
// 一屏里几乎每个回合都会推迟收起，与网页端相反（真机 2026-10-18：网页端展开的那一轮，插件是收起的）。
// 位置判据只需要"最后一条人发的普通消息在第几行"：它之后的每一行都属于最新交互段，与回合号无关。
//
// 判据只吃行表里的少量字段（`key` / `kind` / `steering`），不碰 store 与 DOM，脚本可直接喂形状。

/** 判据只需要的行形状（`ChatRow` 的子集）。 */
export interface ExchangeRow {
    key: number
    kind: string
    /** 插话（被当前回合的下一步取用）—— 插话**不**开启新交互段 */
    steering?: boolean
}

/**
 * **最新交互段**的行 key 集合（含段首那条用户消息本身）。
 *
 * 口径：找到**最后一条**人发的普通消息（`kind === 'user'` 且不是插话），它以及它之后的每一行都属于
 * 最新交互段；一条这样的消息都没有时，整张表算一段（上游在同一情形下也把整段已加载窗口当作一段）。
 *
 * 为什么用"最后一条"而不是"第一条"：段是**向后**延伸的 —— 段起点越靠后，段内回合越少；
 * 用第一条会把整屏都算进段内（历史回合永远不收起），用最后一条才与"下一次提问即开新段"一致。
 *
 * @param rows - 按时间序排好的行（与渲染同一份）
 * @returns 属于最新交互段的行 key 集合
 */
export function latestExchangeKeys(rows: readonly ExchangeRow[]): ReadonlySet<number> {
    let startIndex = 0
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]
        if (row !== undefined && row.kind === 'user' && row.steering !== true) {
            startIndex = i
            break
        }
    }
    const keys = new Set<number>()
    for (let i = startIndex; i < rows.length; i += 1) {
        const row = rows[i]
        if (row !== undefined) keys.add(row.key)
    }
    return keys
}

export interface DeferFoldInput {
    /** 收起时机偏好（宿主下发；缺省按 `completion`） */
    timing: 'completion' | 'next-input' | undefined
    /** 这一行是否属于最新交互段（`latestExchangeKeys` 的结果） */
    inLatestExchange: boolean
    /** 台账里还有待结算的普通直发（用户已经提交了下一条） */
    pendingTranscript: boolean
}

/**
 * 这一行所在的回合**自动收起**要不要推迟。
 *
 * 推迟只影响"默认收不收"，不改变"能不能收"：读者手动收起/展开的选择仍然优先（见调用点：
 * `open` 先取读者记录，没有记录时才用这里的默认值）。
 *
 * @param input - 偏好 + 段归属 + 待发送标志
 * @returns 是否推迟收起
 */
export function deferFoldFor(input: DeferFoldInput): boolean {
    if (input.timing !== 'next-input') return false
    if (input.pendingTranscript) return false
    return input.inLatestExchange
}
