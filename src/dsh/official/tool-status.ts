// 工具调用终态判定：把 tool/result 的错误码与 isError 归到行状态（ok / error / stopped）。
// 宿主层共用（stream.ts 实时、session.ts 历史），两处必须同口径。
//
// 铁律：**主依据是 isError，不是「有没有 error.code」**。
// code 是开放集合，其中若干并不表示失败——按「有码即失败」判，会把「用户取消」「回合被打断」
// 一律标成红色失败。上游 toolRowModel 的判定顺序即此文件的两行：
//     state = !done ? 'running' : code === 'interrupted' ? 'stopped' : isError ? 'error' : 'ok'
//
// 不在本文件处理的两类（与上游分层一致，由展示层按 code 另行覆盖）：
//   - ask_user_question 的 ASK_CANCELLED → ok、ASK_ABORTED → stopped
// 上游把它放在提问行组件里（`AskQuestionRow` 显式改写 state），本插件有对应实现。

/** 工具行终态（与协议/组件的 status 字段同集合；running 由调用方另行判定）。 */
export type ToolStatus = 'ok' | 'error' | 'stopped';

/**
 * 由错误码与 isError 判出终态。
 * @param code - `tool/result.data.error.code`，无错误为 undefined。
 * @param isError - `readToolResult()` 解出的失败标记；缺省按未失败处理。
 * @returns 终态：被打断 → stopped；其余以 isError 为准。
 */
export function toolStatusOf(code: string | undefined, isError: boolean | undefined): ToolStatus {
    if (code === 'interrupted') {
        return 'stopped';
    }
    return isError === true ? 'error' : 'ok';
}
