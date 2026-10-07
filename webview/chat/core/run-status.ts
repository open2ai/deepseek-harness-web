// 「运行中」状态行的文案与时长 —— 独立纯函数文件（适配 dsh 0.2.0）。
//
// 上游 0.2.0 起运行态文案是「深度求索中，用时 {duration} ···」（英文 `Deep diving for {duration} ···`），
// 由运行指示组件消费：**锚点（回合开始时刻）拿得到就带时长**，拿不到只写「深度求索中」；0.1.7 的同一句
// 在回合控制节点上、没有尾部省略号，而 0.2.0 该节点只在回合关闭后渲染，运行态交给运行指示组件。
//
// 时长格式对齐上游：小时 > 0 才出现「小时」、总时长 ≥ 60s 才出现「分」，数字不加前导零。
//
// 插件此前固定显示「深度求索中...」，且**只在 ≥15s** 时才在旁边补一个时长 —— 上一轮对齐成
// 「有锚点就带时长 + 上游同形文案」（不再有 15s 门槛）；锚点语义见下。

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
 * 运行中状态行文案（上游 `chat.deepDivingFor` / `chat.deepDiving` 的中文原文）。
 *
 * ⚠️ **锚点未知时不写时长**：上游那个时钟锚的是**本回合 `turn/start` 的时刻**，锚点拿不到时它渲染
 * `chat.deepDiving`＝「深度求索中」（连尾部的「···」都没有）。插件原先锚在**组件挂载时刻**，于是
 * 面板中途打开/切回本会话就从 0 重计，与网页端差出好几秒 —— 现由宿主下发回合开始时刻
 *（`turnStartMs` → store 的 `runAnchorMs`），这一函数只管格式。
 *
 * @param elapsedMs - 已运行毫秒；`undefined` = 还不知道本回合何时开始（上游同款：不带时长）。
 */
export function runStatusText(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined) {
    return '深度求索中'
  }
  return `深度求索中，用时 ${formatRunDuration(elapsedMs)} ···`
}

/**
 * **终局态**状态行文案：正常收官「已完成 / 已完成，用时 {duration}」、被停止「已停止」、失败「处理失败」。
 *
 * ⚠️ **失败这一格必须有文案**：先前这里返回 `null`（想法是"失败另有终局行说明"），
 * 结果是这一行渲染成一个**空盒子** —— 网页端同一位置写的是「处理失败」。三档的判据与文案都照上游：
 * `aborted` → 已停止、`error` → 处理失败（两档**都不带时长**：带了反而像"跑完了"）、
 * 其余 kind 一律「已完成 / 已完成，用时 X」（上游只特判这两种，`max-tokens`/`interrupted`/`forked`
 * 乃至陌生值都走「已完成」—— 原样印内部 kind 会把它们漏到界面上）。
 *
 * 与**正文末尾**的「已停止」分工不同：那个是**消息级**标记（"这条回答被中断"），这个才是**回合级**控制行。
 *
 * 时长取本回合总用时（`row.usageRaw.wallSec`，与动作条 ⏱ 同源）；**没有就不带**（不显示占位、不伪造 0 秒）。
 *
 * @param done - 本回合是否已关闭（未关闭 = 运行中，不出这一行）。
 * @param status - 宿主的 `turn/end.reason.kind`；`undefined` = 正常收官（`completed` 不传进来）。
 * @param wallMs - 本回合总用时（毫秒）；`undefined` = 没拿到。
 * @returns 文案；`null` = 不出这一行（只有"还没关闭"这一种）。
 */
export function doneStatusText(done: boolean, status: string | undefined, wallMs: number | undefined): string | null {
  if (!done) {
    return null
  }
  if (status === 'error') {
    return '处理失败'
  }
  if (status === 'aborted') {
    return '已停止'
  }
  return wallMs === undefined ? '已完成' : `已完成，用时 ${formatRunDuration(wallMs)}`
}
