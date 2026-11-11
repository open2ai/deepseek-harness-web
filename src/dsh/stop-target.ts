// **停止这一轮的走法**：普通会话发 `session.cancel`，**子会话**改走子会话中断。
//
// 为什么不能一律 `session.cancel`：分叉/子智能体会话在服务端挂在一个
// **直接父**名下，`session.cancel` 会被拒（`session/agent-busy`）—— 界面表现为「停止按钮永远无效」，
// 只能去网页端停或干等。上游同一个 `Session.cancel()` 里就是按"有没有父地址"分流的；
// 这里的判据与它逐条同口径：
//
//   · 有地址 → 子会话中断。dsh 0.2.2-rc.2 把这个远端**改名并收窄**成了
//     `subagents.interruptByUser(childSessionId)`：只收目标会话一个形参，授权改按目标会话校验；
//     0.2.2-rc.1 及更早是带父地址与可继续语义的三形参版本，本插件基线已抬到 0.2.2-rc.2，只发新名。
//   · 没有地址 → `session.cancel({ sessionId })`（与上游的退化情形一致：拿不到地址就只能试这一条，
//     失败会被上层报出来）。
//
// 地址从哪来也照上游：父会话自有的子目录投影（`subagentCatalog`：`{id, mode, …}`），客户端据此拼出
// `{ parentSessionId, childSessionId, mode }`。插件不另开订阅 —— `session/list` 的每一项本来就带
// 它自己的投影值，足够拼出全量父子关系（见 `dshService.refreshSubagentFacts`）。
//
// **判定与发送分家**：本文件只管"发哪个 remote"（宿主侧）；"主钮能不能让出停止 / 要不要另挂一个独立
// Stop / 输入区要不要被父离线锁住"是**页面侧判定**，同一套口径）。

/** 直接父地址（上游 `SubagentAddress` 的插件侧形状）。 */
export interface DshSubagentAddress {
    parentSessionId: string;
    childSessionId: string;
    /** `continuable` = 可继续（能收人话、也能被父中断）；`one-shot` / `unknown` = 其余。 */
    mode: string;
}

/** 一次停止要走的方法与参数（宿主只负责拼，RPC 由调用方发）。 */
export interface DshStopTarget {
    method: 'subagents.interruptByUser' | 'session.cancel';
    params: Record<string, string>;
}

/**
 * 停止这一轮该发哪个 remote。
 *
 * **dsh 0.2.2-rc.2 改名**：旧名 `subagents/interruptByParent(childSessionId, parentSessionId, 'continuable')`
 * 已不存在，0.2.2-rc.2 是 `subagents/interruptByUser(childSessionId)` —— 只剩目标会话**一个**形参，
 * 授权口径也从「持久父地址权威」改成「按目标 Session 校验」。
 * 父地址仍然要判：它决定走子会话中断还是普通 `session/cancel`（与上游 `Session.cancel()` 同口径），
 * 只是不再作为参数上送。
 * @param sessionId - 当前会话。
 * @param address - 它的直接父地址（没有 = 普通会话）。
 * @returns 方法与参数（参数名与上游远端签名逐字一致）。
 */
export function stopTargetOf(sessionId: string, address: DshSubagentAddress | undefined): DshStopTarget {
    if (address === undefined || address.parentSessionId === '') {
        return { method: 'session.cancel', params: { sessionId } };
    }
    // 参数名逐字对齐 0.2.2-rc.2 的 `interruptByUser(childSessionId: SessionId)`
    return { method: 'subagents.interruptByUser', params: { childSessionId: address.childSessionId } };
}
