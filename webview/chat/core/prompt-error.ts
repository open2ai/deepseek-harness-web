// 提交失败时的**一行文案**（对齐上游 `ui-conversation` 的 InputBar 处理）。
//
// 上游规则：失败一律显示服务端返回的 `message`（其它失败还带 `(code)`）；只有 `session/writer-held`
// 它换成了本地化提示。**本插件不跟这一条**：按维护者 2026-10-18 的决定，**原样显示服务端返回的内容** ——
// 上游的错误消息里带着具体现场（哪个会话、哪个写句柄），而本地化文案会把它们抹掉；而且上游以后
// 换文案/加字段时，插件不用跟着猜。
//
// 所以这里只做一件事：`message`，有 `code` 时附在后面（`message (code)`），**不做任何翻译/替换**。

/**
 * 把一次提交失败翻译成给用户看的一行文案。
 *
 * @param error - 失败事实：服务端消息 + 上游错误码（可能没有）
 * @returns 一行文案；`error` 缺失时返回 undefined（不显示错误条）
 */
export function promptErrorTextOf(
    error: { message: string; code?: string } | undefined,
): string | undefined {
    if (error === undefined) return undefined
    return error.code === undefined ? error.message : `${error.message} (${error.code})`
}
