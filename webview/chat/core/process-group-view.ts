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
    headActivity,
    liveProcessDetailOf,
    liveProcessTitle,
    type ProcessActivity,
} from './step-process-title'

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
    const label = done ? closedProcessTitle(items) : liveProcessTitle(items)
    const liveDetail =
        !done && input.liveProcessDetail !== false ? liveProcessDetailOf(items) : ''
    return {
        folded: processDisclosure({
            done,
            process: input.facts,
            compact: input.compact,
            grouping: input.grouping,
            open: input.open,
            // 每片自带头（上游"每个分组 seat 一个头"）
            ownsHead: true,
            // 这一片自己的 seat：窗口门里"有回答锚点"那一条**只属于回合级**（分组头开合的是这一片的明细，
            // 不需要锚点）—— 少了它，没有回答步的那一片（停下来的回合只留一条思考）分组头不出现
            groupSeat: true,
            turnStarted: input.turnStarted,
        }).head,
        detail: processDisclosure({
            done,
            process: input.facts,
            compact: input.compact,
            grouping: input.grouping,
            open: input.open,
            ownsHead: true,
            groupSeat: true,
            turnStarted: input.turnStarted,
        }).detail,
        title: liveDetail === '' ? label : `${label} · ${liveDetail}`,
        activity: headActivity(items, done),
    }
}
