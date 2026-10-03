// 回合终止原因的形状（适配上游 0.1.7-rc.2）：镜像上游 turn/end 的 reason.kind 取值集合。
//
// ⚠️ CORE-COUPLED（核心耦合；目录名 official，本仓库注释里称"核心"）——只映射 dsh 核心规则，
// 勿混入插件自有逻辑；核心变化只改本目录。

/**
 * 回合终止原因的取值（对齐上游 `TurnEndReasonMap` 的 6 个键）。
 *
 * 语义提醒：`interrupted` 指**崩溃遗弃回合的事后关闭**（只在冷读/恢复时合成），
 * 用户点停止、取消请求走的是 `aborted`。
 */
export type DshTurnEndKind = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted';

/**
 * 插件**自己产出**终止原因时用的停止占位值。
 *
 * 为什么单独定义：产出侧一旦自造集合外的值（历史上用了 `cancelled`），同一件「用户停止」
 * 会在实时与历史两条路径上显示成不同的词。收在这里由 tsc 兜住，改也只改这一处。
 *
 * 注意 **消费侧不做白名单校验**：上游该类型可合并扩展，运行期可能收到集合外的陌生值，
 * 原样透传比静默丢弃安全。
 */
export const STOPPED_TURN_END: DshTurnEndKind = 'aborted';

/** `turn/end` 携带的失败事实（`code` 给页面选本地化文案，`message` 是服务端原文）。 */
export interface DshTurnFailure {
    readonly code?: string;
    readonly message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * 从一条 `turn/end` 的 `reason` 取出失败事实 —— 镜像上游两处：
 * `conversation-nodes/turn-error.ts` 的 `failureFrom()` 与 `event-projection.ts:149` 的 `displayFailure()`。
 *
 * 两条口径必须保持：
 *  · **`AUTH` 只留 `code`、不留 `message`**（上游原文：原始 AUTH 消息可能回显**被掩码的凭据**，
 *    诊断留在会话日志、不进 UI 状态）。插件原先也这么做，这里把理由收在一处；
 *  · `aborted` + `reason.reason.kind === 'hook'` 且 `reason.reason.reason === 'deepseek-account/signed-out'`
 *    时上游**合成**一个 `ACCOUNT_SIGNED_OUT` 失败（界面才有「任务已因退出 DeepSeek 登录而停止。」）。
 *
 * 中文文案**不在这里选**：code → 本地化由页面按上游 locale 决议（`webview/chat/core/turn-copy.ts`）。
 * @param reason - `turn/end.data.reason` 原文。
 * @returns 失败事实；非失败终止返回 undefined。
 */
export function turnEndFailure(reason: unknown): DshTurnFailure | undefined {
    const record = asRecord(reason);
    if (record === null) {
        return undefined;
    }
    const kind = record['kind'];
    if (kind === 'error') {
        const raw = record['error'];
        const error = asRecord(raw);
        const code = error !== null && typeof error['code'] === 'string' ? (error['code'] as string) : undefined;
        if (code === 'AUTH') {
            return { code };
        }
        const message = error === null
            ? (raw === undefined ? undefined : stringify(raw))
            : typeof error['message'] === 'string'
                ? (error['message'] as string)
                : stringify(error);
        if (code === undefined && message === undefined) {
            return undefined;
        }
        return {
            ...(code === undefined ? {} : { code }),
            ...(message === undefined ? {} : { message }),
        };
    }
    if (kind === 'aborted') {
        const inner = asRecord(record['reason']);
        if (inner !== null && inner['kind'] === 'hook' && inner['reason'] === 'deepseek-account/signed-out') {
            return { code: 'ACCOUNT_SIGNED_OUT' };
        }
    }
    return undefined;
}

function stringify(value: unknown): string | undefined {
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}
