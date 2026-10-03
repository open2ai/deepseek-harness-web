// 「运行中」状态行的文案与时长 —— 独立纯函数文件（适配 dsh 0.2.0）。
//
// 上游 0.2.0 起运行态文案是「深度求索中，用时 {duration} ···」（英文 `Deep diving for {duration} ···`），
// 由运行指示组件消费，**运行中始终带时长**；0.1.7 的同一句在回合控制节点上、没有尾部省略号，
// 而 0.2.0 该节点只在回合关闭后渲染，运行态交给运行指示组件。
//
// 时长格式对齐上游：小时 > 0 才出现「小时」、总时长 ≥ 60s 才出现「分」，数字不加前导零。
//
// 插件此前固定显示「深度求索中...」，且**只在 ≥15s** 时才在旁边补一个时长 —— 本轮对齐为
// 「始终显示 + 上游同形文案」，不再有 15s 门槛。

/**
 * 运行时长文本（对齐上游 `formatRunDuration` 的 zh 单位拼接）。
 * @param ms - 已运行毫秒；负数按 0、小数向下取整。
 * @returns 形如 `45秒` / `2分42秒` / `1小时2分3秒`。
 */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const parts: string[] = []
  if (hours > 0) {
    parts.push(`${String(hours)}小时`)
  }
  if (total >= 60) {
    parts.push(`${String(minutes)}分`)
  }
  parts.push(`${String(seconds)}秒`)
  return parts.join('')
}

/**
 * 运行中状态行文案（上游 `chat.deepDivingFor` 的中文原文）。
 * @param elapsedMs - 已运行毫秒。
 */
export function runStatusText(elapsedMs: number): string {
  return `深度求索中，用时 ${formatRunDuration(elapsedMs)} ···`
}

/**
 * **终局态**状态行文案（上游 `chat.worked`/`chat.workedFor` —— 0.2.0 起是
 * `已完成` / `已完成，用时 {duration}`，英文 `Completed` / `Completed in {d}`）。
 *
 * 上游由回合级过程控制节点渲染（`chat/TurnProcessNodeView.tsx:26-32`）；插件此前**整行没做**，
 * 于是"网页端有一条完成态摘要、插件没有"（见 `tmp/版本差异记录/…/03` §3.1）。
 *
 * **终局原因不只"完成"**（2026-10-02 按真机截图补）：被停止的回合在同一位置显示「已停止」
 * （上游 `message.stopped`，与回答行角标同一个词）。这里的分支与 `core/turn-copy.ts` 的
 * `statusBadgeText()` **同一口径**（同一句话只该有一个来源）：
 *   · `undefined`（正常收官） → `已完成`；
 *   · `aborted` / `interrupted` → `已停止`；
 *   · `error` / `max-tokens` → 各自的**独立终局行**已经在说这件事（标题 + 原因 + hint），这里**不重复**；
 *   · 其余陌生值 → **原样显示**（静默吞掉会让"这一轮非正常结束"这个事实消失）。
 *
 * 时长来自本回合的 `turn-stats`（`row.usageRaw.wallSec`，动作条的 ⏱ 弹窗同一份事实）：
 * **没有时长就不带**（不显示占位、不伪造成 0 秒）。
 *
 * @param done - 本回合是否已关闭（未关闭 = 运行中，不出这一行）。
 * @param status - 宿主的 `turn/end.reason.kind`；`undefined` = 正常收官（`completed` 不传进来）。
 * @param wallMs - 本回合总用时（毫秒）；`undefined` = 没拿到。
 * @returns 文案；`null` = 不出这一行。
 */
export function doneStatusText(done: boolean, status: string | undefined, wallMs: number | undefined): string | null {
  if (!done) {
    return null
  }
  if (status === 'error' || status === 'max-tokens') {
    return null
  }
  /**
   * ⚠️ **只有 `aborted` 是"已停止"，其余一律"已完成"**（2026-10-02 按 tag `dsh-v0.2.0-rc.2` 更正）。
   *
   * 上游 `TurnProcessNodeView.tsx` 的原文是**只特判两种**：
   * ```tsx
   * const label = reason === 'aborted' ? t('message.stopped')
   *   : reason === 'error' ? t('message.turnProcess.failed')
   *     : duration === undefined ? t('message.turnProcess.worked')     // '已完成'
   *       : t('message.turnProcess.took')                             // '已完成，用时 '
   * ```
   * 也就是说 **`interrupted`、`forked`、`completed` 以及任何别的 kind 都走 `worked`/`took`**，
   * 文案表里根本没有这些词。此前我们把"陌生 kind 原样显示"（一条自作聪明的兜底）留下了 ——
   * 真机现象：点「在新对话中分支」后，分叉切点合成的 `turn/end.reason.kind = 'forked'`
   * 被直接印成 **`forked，用时 xx秒`**（web 端当时显示的是「已完成，用时 xx秒」）。
   */
  const label = status === 'aborted' ? '已停止' : '已完成'
  return wallMs === undefined ? label : `${label}，用时 ${formatRunDuration(wallMs)}`
}
