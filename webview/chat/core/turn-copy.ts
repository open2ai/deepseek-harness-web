// 回合**终局文案**的决议（纯函数，无 Preact/DOM，便于直接喂用例）：
//   ① 终局通知行的标题与正文（失败 `turn-error` / 输出 token 上限 `turn-max-tokens`）；
//   ② 回答行状态角标的文案。
//
// 上游把失败文案拆成两层，本文件是**第二层**（view）：
//   · 节点层 `conversation-nodes/turn-error.ts` 产出 `{message, code}`（插件对应 `src/dsh/official/turn-end.ts`）；
//   · 展示层的 `failureMessage()` —— **只对下面 5 个 code**
//     换成固定文案，**其余一律回退上游原文**；两个终局节点另给标题。
// 文案逐字取自网页端字典（`message.failure.*` / `message.turnError` /
// `message.accountStopped` / `message.maxTokens*` / `message.stopped`），不自造同义词。
//
// 为什么值得单开一层：插件原先只显示行上的原始 message，而 `AUTH` 的 message 被节点层**主动置空**（防凭据进 UI），
// 于是「API 密钥无效」这种情况插件**什么都不显示**、比上游更安静。

/** code → 固定文案（与上游 locale 逐字一致）。key 即上游 `failureMessage()` 判定的那几个 code。 */
const FAILURE_TEXT: Record<string, string> = {
  AUTH: 'API 密钥无效',
  ACCOUNT_SIGNED_OUT: '任务已因退出 DeepSeek 登录而停止。',
  ACCOUNT_SIGN_IN_REQUIRED: '请先登录 DeepSeek，并确认请求地址支持账号认证。',
  QUOTA: '当前请求的额度已用尽',
  ACCOUNT_QUOTA: '当前请求的额度已用尽',
}

/** 有固定文案的 code 集合（供守卫与调用方核对，勿与上游 `failureMessage()` 漂移）。 */
export const LOCALIZED_FAILURE_CODES: readonly string[] = Object.keys(FAILURE_TEXT)

/**
 * 一行失败的展示文案：**有固定文案的 code 优先，否则回退上游原文**。
 *
 * 入参是终局通知行自己的字段名（`message`/`code`，见 `core/store/types.ts` 的 `turnNotice` 行）。
 * 与上游同口径：`code` 命中就**不再看 `message`**（那几个 code 的原文本就不该给用户看，
 * 例如 AUTH 的原文可能含被掩码的凭据）；两者都给不出可读文案时返回 `undefined` → 调用方不渲染文案。
 */
export function turnFailureText(input: { message?: string; code?: string }): string | undefined {
  const fixed = input.code === undefined ? undefined : FAILURE_TEXT[input.code]
  if (fixed !== undefined) {
    return fixed
  }
  const message = input.message
  return message === undefined || message === '' ? undefined : message
}

/**
 * 失败行的**标题**（上游 `TurnErrorItem` 取的就是这两个文案，逐字取自 locale）：
 * `ACCOUNT_SIGNED_OUT` → 「任务已停止」（`message.accountStopped`），其余 → 「本轮运行失败」（`message.turnError`）。
 */
export function turnFailureTitle(code: string | undefined): string {
  return code === 'ACCOUNT_SIGNED_OUT' ? '任务已停止' : '本轮运行失败'
}

/** 输出 token 上限的标题（上游 `message.maxTokens`）。 */
export const MAX_TOKENS_TITLE = '已达到输出 token 上限'

/** 输出 token 上限的提示（上游 `message.maxTokens.hint`）。 */
export const MAX_TOKENS_HINT = '回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。'

/**
 * 回合**终局通知行**的文案（标题 + 可选正文）：上游 `turn-error` 与 `turn-max-tokens` 渲染同一套布局，只是文案不同。
 * @param row - 通知行的 `tone` 与失败事实（`message`/`code`，`warning` 档不带）。
 * @returns 标题与正文（正文取不到时省略）。
 */
export function turnNoticeCopy(row: { tone: 'error' | 'warning'; message?: string; code?: string }): { title: string; message?: string } {
  if (row.tone === 'warning') {
    return { title: MAX_TOKENS_TITLE, message: MAX_TOKENS_HINT }
  }
  const message = turnFailureText(row)
  return { title: turnFailureTitle(row.code), ...(message === undefined ? {} : { message }) }
}

/**
 * 回答行**状态角标**的文案；`undefined` = 不渲染角标。
 *
 * 上游这个位置显示的是「已停止」（`message.stopped`），而它**不对应某个 `reason.kind`**，对应的是
 * **消息级**的「这条回答被中断」状态 —— `aborted`（用户停止）与 `interrupted`（崩溃遗弃的事后关闭）都会显示它
 * （上游只在 `reason === 'aborted'` 时用它）。
 * 插件现在**按消息级事实**把「已停止」渲染在正文末尾（`AssistantRow`，上游 `AssistantMarkdown` 的位置），
 * 所以 `interrupted` 为真时这里**不再出角标**（同一件事不显示两遍）。
 * `error` / `max-tokens` 上游有各自的终局行、也不用这个词 → 同样不出角标。
 * 其余（含上游将来新加的陌生值）**原样显示**：静默吞掉会让"这个回合非正常结束"这个事实消失。
 * @param status - 宿主给的 `turn/end.reason.kind`（`completed` 不会传进来）。
 * @param interrupted - 该行是否已按**消息级**标记渲染了「已停止」。
 * @returns 角标文案，或不渲染。
 */
export function statusBadgeText(status: string | undefined, interrupted = false): string | undefined {
  if (status === undefined) return undefined
  if (interrupted) return undefined
  if (status === 'aborted' || status === 'interrupted') return '已停止'
  if (status === 'error' || status === 'max-tokens') return undefined
  return status
}
