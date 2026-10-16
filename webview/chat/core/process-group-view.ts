// 过程**一片**（上游 step-group）的呈现判据（适配上游 0.2.0-rc.2）：给定"这一片 + 它自己的事实 + 偏好"，
// 吐出"有没有头 / 头文案 / 图标 / 明细是否可见"。渲染侧只按结果画（`Chain.ts` 之后接线）。
//
// 与整回合路径的关系：**判据完全相同**（`processDisclosure` + 三个文案函数），只是把输入从
// "整条链 + 回合级事实"换成"这一片的链项 + 这一片自己的事实"。所以这里不复制任何规则。
//
// 接线约定：片的事实由宿主下发（`DshRowGroup.facts`），是回合级事实的同形子集 → 直接喂给判据。

import type { DshRowGroupFacts, DshTurnProcess } from '../../../src/dsh/rows/types'
import type { DshTurnProcessItem } from './store/types'
import { processDisclosure } from './process-fold'
import {
    closedProcessTitle,
    closedTitleOfCounts,
    headActivity,
    liveProcessDetailOf,
    liveProcessTitle,
    liveTitleOfSummary,
    type ProcessActivity,
} from './step-process-title'

/**
 * **这一片自己的收口态**（上游 `ChatGroupSeat` 的 `data.closed` = 片收口 || 回合关闭）。
 *
 * 判据只此一份：`processGroupView` 与片组件（展开预定位、标题微光）都从它取，
 * 免得两处各写一遍再漂开。片事实里没有 `closed` 时（旧宿主 / 无片形态）退回回合级 `done`。
 *
 * @param facts - 片事实（`DshRowGroupFacts`；可能没有 `closed`）。
 * @param done - 回合是否已关闭（缺省口径）。
 */
export function sliceClosedOf(facts: { closed?: unknown } | undefined, done: boolean): boolean {
    const closed = facts?.closed
    return typeof closed === 'boolean' ? closed : done
}

export interface ProcessGroupViewInput {
    /** 本回合是否已定稿（上游 `turnClosed`） */
    done: boolean
    /** 紧凑偏好（上游 `foldCompletedTurns` 那一列） */
    compact: boolean
    /** 分组偏好（上游 `stepGrouping` 那一列） */
    grouping?: 'collapsed' | 'history' | 'none'
    /** 窗口里有没有本回合的 `turn/start`（上游 `turnStarted`） */
    turnStarted: boolean
    /** 该片当前是否展开 */
    open: boolean
    /** 该片内的链项（已按链序） */
    items: readonly DshTurnProcessItem[]
    /** **该片自己的**过程事实（宿主下发）；缺省 = 退回整回合那套事实。
     *  两种事实都收：片的 `DshRowGroupFacts` 是回合级 `DshTurnProcess` 的同形子集。 */
    facts: DshRowGroupFacts | DshTurnProcess | undefined
    /** 实时细节偏好（上游 `liveProcessDetail`）；`undefined` = 读不到，按显示处理 */
    liveProcessDetail?: boolean
    /** 插话事实（回合级）：片级也用它，见 `ProcessGroup` 的调用点 */
    hasInterleavedInput?: boolean
}

export interface ProcessGroupView {
    /**
     * **这一片自己收口了没**（上游 `data.closed` = 组收口 || 回合关闭）。
     *
     * 组件侧也要它：上游的标题稳定延迟只在**未收口**时生效（`useStableLiveProcessTitle({...}, !data.closed)`），
     * 收口那一刻标题要**立刻**换成已收口文案。
     */
    closed: boolean
    /** 有没有折叠头（每片各判一次） */
    folded: boolean
    /** 明细是否可见 */
    detail: boolean
    /** 头文案（已按上游接上 ` · ` 实时细节） */
    title: string
    /** 头左侧的活跃度图标类别 */
    activity: ProcessActivity
}

/**
 * 算一片的呈现形态。
 * @param input - 该片 + 该片自己的事实 + 用户偏好（见 `ProcessGroupViewInput`）。
 */
export function processGroupView(input: ProcessGroupViewInput): ProcessGroupView {
    const { items, done } = input
    /**
     * ⚠️ **看的是这一片自己的 `closed`，不是回合的 `done`**（上游 `ChatGroupSeat`：
     * `data.closed ? processTitle(...) : ...live...`，而 `data.closed` = 组收口 || 回合关闭）。
     *
     * 真机 2026-10-10（左右对照、同一会话、回合还在跑）：网页端那一行是**已收口**的片 →「向用户提出了问题」，
     * 插件显示「正在分析请求」。成因就是这里用了回合级 `done`（false，回合还在跑），于是拿**进行时**文案
     * 去渲染一个**已经收口**的片（它没有运行中的工具 → 落到 `thinking` 兜底）。
     * 片事实里没有 `closed` 时（旧宿主 / 无片形态）退回回合级 `done`。
     */
    const closed = sliceClosedOf(input.facts as { closed?: unknown } | undefined, done)
    /**
     * **这一片自己的活动汇总**（片事实带的 `summary`）—— 片头的 label/detail/icon 全都该读它。
     * 它与「按链项现算」那份的差别是**口径**：
     * 运行中那个按 **time** 取、计数**递归 `subCalls`**、没有运行中工具时退回**运行中那一步**的思考。
     * 片事实里没有它（老宿主 / 无片形态）才退回链序那份。
     */
    const summary = (input.facts as { summary?: { counts: Array<{ kind: string; count: number }>; running?: string; runningDetail?: string; preparing?: boolean } } | undefined)?.summary
    const label = summary === undefined
        ? (closed ? closedProcessTitle(items) : liveProcessTitle(items))
        : (closed ? closedTitleOfCounts(summary.counts) : liveTitleOfSummary(summary))
    const liveDetail =
        !closed && input.liveProcessDetail !== false
            ? (summary === undefined ? liveProcessDetailOf(items) : (summary.runningDetail ?? ''))
            : ''
    return {
        closed,
        folded: processDisclosure({
            done,
            process: input.facts,
            compact: input.compact,
            grouping: input.grouping,
            open: input.open,
            // 每片自带头（上游"每个分组 seat 一个头"）
            ownsHead: true,
            turnStarted: input.turnStarted,
        }).head,
        detail: processDisclosure({
            done,
            process: input.facts,
            compact: input.compact,
            grouping: input.grouping,
            open: input.open,
            ownsHead: true,
            turnStarted: input.turnStarted,
        }).detail,
        title: liveDetail === '' ? label : `${label} · ${liveDetail}`,
        // 上游 `data.closed ? summary.counts[0]?.kind ?? 'thinking' : live.activity`
        activity: summary === undefined
            ? headActivity(items, closed)
            : ((closed ? summary.counts[0]?.kind : summary.running) as ProcessActivity | undefined) ?? 'thinking',
    }
}
