// 左下角 Turn 级状态行：「xxx...」+ 小转圈 + ≥15s 运行时钟（适配上游 0.1.5-rc.2）。
// processing（乐观 busy：首 token 等待/工具执行/流式全程）时整轮显示，左对齐贴底。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'

/** 运行时长：minutes>0 → `{minutes}分{seconds}秒`，否则 `{seconds}秒`。 */
function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`
}

export function TurnStatus() {
  // 运行时钟：锚点=挂载时刻（turn 全程组件常驻，时钟准），≥15s 显示
  const [anchor] = useState(() => Date.now())
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => setElapsedMs(Math.max(0, Date.now() - anchor))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [anchor])
  const showClock = elapsedMs >= 15_000
  return html`<div class="turn-status" role="status" aria-live="polite">
    <span class="turn-status-ico codicon codicon-loading codicon-modifier-spin"></span>
    <span class="turn-status-text">深度求索中...</span>
    ${showClock ? html`<span class="turn-status-clock" aria-hidden>${formatRunDuration(elapsedMs)}</span>` : null}
  </div>`
}
