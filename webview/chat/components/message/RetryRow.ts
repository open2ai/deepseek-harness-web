// 重试行（上游 `model-retry` 节点）：一行一条重试链，正文只显示**最后一次尝试**。
// 展开区只有两项（重试延迟 + 失败原因）—— 上游 `MessageItem` 同，别去臆造每次尝试的列表。
//
// 倒计时基准按上游：以**本节点首次渲染**的时刻 + `delayMs` 起算（host 事件时间与本地时钟可能不同源）。
import { html } from 'htm/preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import {
  RETRY_DELAY_LABEL,
  RETRY_FAILURE_LABEL,
  retryActive,
  retryDelayText,
  retryFailureText,
  retryMaximum,
  retrySeconds,
  retryStateOf,
  retryStatusText,
} from '../../core/retry-copy'
import type { ChatRow } from '../../core/store/types'
import { ShimmerText } from '../chain/ShimmerText'

export function RetryRow({ row }: { row: Extract<ChatRow, { kind: 'retry' }> }) {
  const state = retryStateOf(row)
  const active = retryActive(state)
  const delayMs = typeof row.delayMs === 'number' ? row.delayMs : 0
  // 倒计时：锚点取挂载时刻（上游 `useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])`）
  const deadline = useMemo(() => Date.now() + delayMs, [delayMs, row.retryId])
  const [remaining, setRemaining] = useState(() => retrySeconds(delayMs))
  useEffect(() => {
    if (!active) {
      return
    }
    const tick = (): void => setRemaining(retrySeconds(Math.max(0, deadline - Date.now())))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [active, deadline])
  const maximum = retryMaximum(row.mode, row.maxRetries)
  const text = retryStatusText({
    state,
    retry: row.retry,
    maximum,
    // 已开始/已取消时倒计时冻结在上游给的延迟值上（不再走动）
    seconds: active ? remaining : retrySeconds(delayMs),
  })
  const failure = retryFailureText(row.failure)
  return html`<details class="retry-row" data-active=${active ? 'true' : undefined}>
    <summary class="retry-summary">
      <${ShimmerText} text=${text} className="retry-text" active=${active} />
    </summary>
    <div class="retry-details">
      <div><span class="retry-label">${RETRY_DELAY_LABEL}</span>${retryDelayText(delayMs)}</div>
      ${failure === undefined
        ? null
        : html`<div><span class="retry-label">${RETRY_FAILURE_LABEL}</span>${failure}</div>`}
    </div>
  </details>`
}
