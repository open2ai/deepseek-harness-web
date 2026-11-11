// **「继续生成」入口的准入判据**（独立纯函数；页面只按结果渲染，判据只写这一处）。
//
// 上游 0.2.2-rc.2 把「失败回合的继续生成」做成输入区主按钮的一个态：只有**服务端资格**（投影里
// 可续跑回合 seq 非空）成立、且输入区**真空闲**时才出现；它**不是**一个常驻按钮。
// 判据逐条镜上游同一段准入（驳回任何一条都不出现）：
//   · 本会话在跑（宿主权威的运行事实）—— 在跑时主钮该是「停止」；
//   · 子会话 —— 只有根会话能续跑失败回合；
//   · 草稿/附件/图片/引用全空 —— 有内容时主钮该是「发送」；
//   · 输入区相位为朴素态 —— 加载/切换过渡、刚发出还在等宿主接受、或继续生成已点过，
//     都算非朴素态（避免重复提交）；
//   · 没有待结算的提交、没有排队项、没有还没被取用的插话 —— 服务端准入也要求没有
//     待消费的用户输入，页面对等的事实就是这三类；
//   · 会话已成功打开 —— 打开失败时输入区整块不可用。
//
// 为什么要单独抽纯函数：这些事实分散在多个信号里，写在组件里既难覆盖也容易与「发送」
// 的判据漂开；这里只吃普通值，脚本可以直接喂边界组合。

/** 「继续生成」入口的判据输入（全部是页面已有的普通值，不是信号）。 */
export interface ContinueGates {
  /** 可续跑的失败回合 seq（`null` = 不可续；来自服务端投影）。 */
  continuation: number | null
  /** 宿主权威的「一轮在跑」。 */
  running: boolean
  /** 输入区草稿/附件/图片/引用是否全空（与「发送」按钮同一判据）。 */
  empty: boolean
  /** 是否子会话（只有根会话能续跑）。 */
  subagent: boolean
  /** 输入区过渡态（加载/切换）。 */
  busy: boolean
  /** 有提交在等宿主接受（「正在发送消息」那一拍）。 */
  sending: boolean
  /** 继续生成已点、还在等宿主回帧（防双击）。 */
  continuationPending: boolean
  /** 待结算提交条数。 */
  pendingSubmissions: number
  /** 排队项条数。 */
  queue: number
  /** 还没被取用的插话条数。 */
  pendingSteering: number
  /** 会话是否已成功打开（`false` = 打开失败横幅在，输入区不可用）。 */
  sessionOpen: boolean
}

/** 入口是否出现 + 点击时要传给动作的失败回合 seq。 */
export interface ContinueEntry {
  /** 主按钮是否切到「继续生成」态。 */
  show: boolean
  /** 非 `null` 时与 `continuation` 相同（上游动作要带它做陈旧性校验）。 */
  failureSeq: number | null
}

/**
 * 算「继续生成」入口这一拍出不出现。
 * @param gates - 见 `ContinueGates`。
 * @returns `show` = 主按钮应切到继续生成态；`failureSeq` = 点击时的失败回合 seq。
 */
export function continueEntry(gates: ContinueGates): ContinueEntry {
  const idle =
    !gates.running &&
    !gates.subagent &&
    !gates.busy &&
    !gates.sending &&
    !gates.continuationPending &&
    gates.sessionOpen &&
    gates.empty &&
    gates.pendingSubmissions === 0 &&
    gates.queue === 0 &&
    gates.pendingSteering === 0
  const failureSeq = gates.continuation !== null && idle ? gates.continuation : null
  return { show: failureSeq !== null, failureSeq }
}
