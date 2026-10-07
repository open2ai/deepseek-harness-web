// **停止这一轮的走法**：普通会话发 `session.cancel`，**子会话**改走父级中断。
//
// 为什么不能一律 `session.cancel`（真机 2026-10-06 分析）：分叉/子智能体会话在服务端挂在一个
// **直接父**名下，`session.cancel` 会被拒（`session/agent-busy`）—— 界面表现为「停止按钮永远无效」，
// 只能去网页端停或干等。上游同一个 `Session.cancel()` 里就是按"有没有父地址"分流的（版本与行号见
// `details/upgrade/10` §8）；这里的判据与它逐条同口径：
//
//   · 有地址 → `subagents.interruptByParent(childSessionId, parentSessionId, 'continuable')`
//     —— 走的是**持久化的父地址权威**，父 Agent 不在线也照样能中断；
//   · 没有地址 → `session.cancel({ sessionId })`（与上游的退化情形一致：拿不到地址就只能试这一条，
//     失败会被上层报出来）。
//
// 地址从哪来也照上游：父会话自有的子目录投影（`subagentCatalog`：`{id, mode, …}`），客户端据此拼出
// `{ parentSessionId, childSessionId, mode }`。插件不另开订阅 —— `session/list` 的每一项本来就带
// 它自己的投影值，足够拼出全量父子关系（见 `dshService.refreshSubagentFacts`）。
//
// **判定与发送分家**：本文件只管"发哪个 remote"（宿主侧）；"主钮能不能让出停止 / 要不要另挂一个独立
// Stop / 输入区要不要被父离线锁住"是**页面侧判定**（`webview/chat/core/stop-control.ts`，同一套口径）。

/** 直接父地址（上游 `SubagentAddress` 的插件侧形状）。 */
export interface DshSubagentAddress {
    parentSessionId: string;
    childSessionId: string;
    /** `continuable` = 可继续（能收人话、也能被父中断）；`one-shot` / `unknown` = 其余。 */
    mode: string;
}

/** 一次停止要走的方法与参数（宿主只负责拼，RPC 由调用方发）。 */
export interface DshStopTarget {
    method: 'subagents.interruptByParent' | 'session.cancel';
    params: Record<string, string>;
}

/**
 * 停止这一轮该发哪个 remote。
 *
 * @param sessionId - 当前会话。
 * @param address - 它的直接父地址（没有 = 普通会话）。
 * @returns 方法与参数（参数名与上游远端签名逐字一致）。
 */
export function stopTargetOf(sessionId: string, address: DshSubagentAddress | undefined): DshStopTarget {
    if (address === undefined || address.parentSessionId === '') {
        return { method: 'session.cancel', params: { sessionId } };
    }
    return {
        method: 'subagents.interruptByParent',
        params: {
            childSessionId: address.childSessionId,
            parentSessionId: address.parentSessionId,
            // 上游 `cancel()` 传的就是这一个字面量：可继续子会话的中断走持久父地址权威
            mode: 'continuable',
        },
    };
}
