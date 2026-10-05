// 重试链（上游 `model-retry` 节点）的**文案决议**（纯函数、无 Preact/DOM，便于直接喂用例）。
//
// 逐字取自上游 zh 字典：`{label}（{retry}/{maximum}） · {seconds}s` + 四个 label + 展开区两行。
// 注意两处上游细节：`always` 模式的 `maximum` 显示为 `∞`；`seconds` **最小为 1**（`Math.max(1, ceil(ms/1000))`）。

/** 重试行当前处于哪一态（上游 `retryState`）。 */
export type RetryState = 'scheduled' | 'started' | 'cancelled'

/** 一次尝试的显示态：**该序号**已开始 → started；停在等待中且回合关闭 → cancelled。 */
export function retryStateOf(input: { retry: number; started?: number; cancelled?: boolean }): RetryState {
  if (input.started === input.retry) {
    return 'started'
  }
  return input.cancelled === true ? 'cancelled' : 'scheduled'
}

/** 该行是否在"等待中"（决定要不要 shimmer + 实时倒计时）。 */
export function retryActive(state: RetryState): boolean {
  return state === 'scheduled'
}

/** 上游 `retrySeconds()`：向上取整到秒，且**至少 1 秒**。 */
export function retrySeconds(delayMs: number): number {
  return Math.max(1, Math.ceil(delayMs / 1_000))
}

/** 四个 label（上游 `message.retry.*`）。 */
export function retryLabel(state: RetryState): string {
  if (state === 'scheduled') {
    return '正在重试模型请求'
  }
  return state === 'cancelled' ? '模型请求重试已取消' : '已重试模型请求'
}

/** 上限位的显示：`always` 模式没有 `maxRetries` → 上游显示 `∞`。 */
export function retryMaximum(mode: string | undefined, maxRetries: number | undefined): string {
  return mode === 'normal' && typeof maxRetries === 'number' ? String(maxRetries) : '∞'
}

/**
 * 该行的整行文案（上游 `message.retry.status`）。
 * @param input - 显示态、尝试序号、上限与本次倒计时秒数。
 */
export function retryStatusText(input: {
  state: RetryState
  retry: number
  maximum: string
  seconds: number
}): string {
  return `${retryLabel(input.state)}（${String(input.retry)}/${input.maximum}） · ${String(input.seconds)}s`
}

/** 展开区的两项标签（上游 `message.retry.delay` / `.failure`）。 */
export const RETRY_DELAY_LABEL = '重试延迟：'
export const RETRY_FAILURE_LABEL = '失败原因：'

/** 延迟的显示（上游 `duration.milliseconds`）。 */
export function retryDelayText(delayMs: number): string {
  return `${String(Math.round(delayMs))}毫秒`
}

/**
 * 失败原因的显示：**先按 code 取上游固定文案，未知 code 回退服务端原文**（与终局通知行同一套 code 表）。
 * @param failure - 重试事件里的 `failure`。
 */
export function retryFailureText(failure: { message?: string; code?: string } | undefined): string | undefined {
  if (failure === undefined) {
    return undefined
  }
  const fixed =
    failure.code === 'AUTH' ? 'API 密钥无效'
    : failure.code === 'ACCOUNT_SIGNED_OUT' ? '任务已因退出 DeepSeek 登录而停止。'
    : failure.code === 'ACCOUNT_SIGN_IN_REQUIRED' ? '请先登录 DeepSeek，并确认请求地址支持账号认证。'
    : failure.code === 'QUOTA' || failure.code === 'ACCOUNT_QUOTA' ? '当前请求的额度已用尽'
    : undefined
  if (fixed !== undefined) {
    return fixed
  }
  return failure.message === undefined || failure.message === '' ? undefined : failure.message
}
