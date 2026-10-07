// **停止控件的呈现判定**（页面侧）：主钮能不能让出「停止」、要不要另挂一个独立 Stop、输入区要不要
// 被"父离线"锁住。三条件逐条镜上游 `InputBar` 的同一段判据（版本与行号见 `details/upgrade/10` §8）：
//
//   · `primaryStops = running && subagent === null && (empty || blocked !== undefined)`
//     —— **子会话的主钮永远是「发送」**（子会话不能自己停自己：`session.cancel` 会被服务端拒）；
//     插件这边 `blocked`（owner 挡住输入）没有对应态，故只保留 `empty` 那一半；
//   · `interruptible = running && continuable`（`continuable` = 地址的 `mode === 'continuable'`）
//     —— 可继续子会话在跑时**另挂一个独立 Stop**；它**不依赖父在线**（上游注释：父不在线时那个
//     独立 Stop 仍然可用）；
//   · `parentOffline = continuable && parentAvailable !== true` 进 `disabled`
//     —— 可继续子会话在父不在线时**不能收人话**（输入区锁住），但上面那个 Stop 照常可用。
//
// 判据放页面、事实由宿主下发（`subagent` 那三个字段）：宿主只管"谁是子会话、父在不在"，
// "该画成什么"全在这一处。

/** 页面看到的子会话事实（宿主随行帧下发）。 */
export interface SubagentFacts {
    /** 直接父会话；`undefined` = 普通会话（主钮可以变「停止」）。 */
    parentSessionId?: string
    /** 地址模式：`continuable` = 可继续（才有独立 Stop / 父离线锁）。 */
    mode?: string
    /** 父 Agent 是否可用；`undefined` = 还没读到（不下结论）。 */
    parentAvailable?: boolean
    /** 列表事实是否读到过（决定"父不可用"要不要下结论）。 */
    factsReady?: boolean
}

/** 是不是子会话（上游 `subagent !== null`）。 */
function isSubagent(facts: SubagentFacts | undefined): boolean {
    return typeof facts?.parentSessionId === 'string' && facts.parentSessionId !== ''
}

/** 是不是**可继续**的子会话（上游 `subagent?.address.mode === 'continuable'`）。 */
function isContinuable(facts: SubagentFacts | undefined): boolean {
    return isSubagent(facts) && facts?.mode === 'continuable'
}

/**
 * 主钮这一态是不是「停止」。
 *
 * @param running - 宿主说这一轮在跑。
 * @param processing - 页面推导的「处理中」（提交当帧也算，见提交台账那条腿）。
 * @param empty - 输入框是否为空。
 * @param subagent - 子会话事实。
 * @returns 主钮是否显示为停止。
 */
export function primaryStops(
    running: boolean,
    processing: boolean,
    empty: boolean,
    subagent: SubagentFacts | undefined
): boolean {
    // 子会话**永远**不让主钮变停止（上游 `subagent === null` 那一条）
    if (isSubagent(subagent)) {
        return false
    }
    return (running || processing) && empty
}

/**
 * 要不要另挂一个**独立**停止控件（上游 `interruptible`）。
 *
 * @param running - 这一轮在跑。
 * @param subagent - 子会话事实。
 * @returns 是否渲染那个独立控件。
 */
export function standaloneStop(running: boolean, subagent: SubagentFacts | undefined): boolean {
    return running && isContinuable(subagent)
}

/**
 * 输入区是否被**父离线**锁住（上游 `parentOffline`）。
 *
 * `parentAvailable` 缺失时按"列表读过没"决定：没读过**不下结论**（免得刚进会话就锁住输入），
 * 读过而缺项 = 不可用（与上游 `agentAvailable()` 在列表就绪后回落 `false` 同口径）。
 *
 * @param subagent - 子会话事实。
 * @returns 是否锁住输入区。
 */
export function parentOffline(subagent: SubagentFacts | undefined): boolean {
    if (!isContinuable(subagent)) {
        return false
    }
    if (subagent?.parentAvailable !== undefined) {
        return subagent.parentAvailable !== true
    }
    return subagent?.factsReady === true
}
