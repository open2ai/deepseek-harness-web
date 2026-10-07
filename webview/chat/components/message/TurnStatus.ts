// 左下角 Turn 级状态行：「深度求索中，用时 X」+ 小转圈（适配上游 0.2.0 的 `chat.deepDivingFor`）。
// processing（乐观 busy：首 token 等待/工具执行/流式全程）时整轮显示，左对齐贴底。
//
// 本轮对齐（2026-10-01）：**有锚点就带时长**（上游 `RunningStatus` 同 —— 0.1.7 的实时时钟由回合控制节点渲染、
// 0.2.0 该节点只在回合关闭后渲染，运行态交给运行指示组件）。此前插件固定在 ≥15s 时才在旁边补一个时长。
//
// **时钟锚点 = 本回合 `turn/start` 的时刻**（不是组件挂载时刻）【2026-10-05 对齐】：上游锚的是
// 回合开始时刻，所以面板中途打开/切回本会话不会从 0 重算；锚点由宿主下发（行上的 `turnStartMs`
// → store 的 `runAnchorMs`）。锚点未知时按上游只写「深度求索中」、不起算。
//
// 文案与时长格式集中在 `core/run-status.ts`（纯函数、有守卫）；掠光走 `ShimmerText`（真实文字始终可见）。
//
// **图标用转圈**；文字与掠光的颜色仍按上游
// 状态行的 deep-diving 蓝（见 `styles/chat.css` 的 `--dsh-deep-diving*`）。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import { runStatusText } from '../../core/run-status'
import { ShimmerText } from '../chain/ShimmerText'

export function TurnStatus({ store }: { store: ChatStore }) {
  // 时钟锚点来自宿主（回合开始时刻）。它换成**另一个值**（下一回合）时计时要跟着换锚 ——
  // 但同一回合内整轮只有一个值，故不会出现「中途归零」。
  const anchor = store.runAnchorMs.value
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [anchor])
  // 上游 `Math.max(1000, now - startTime)`：不足 1s 也按 1s 起（避免闪一下「0秒」）
  const elapsedMs = anchor === undefined ? undefined : Math.max(1000, now - anchor)
  return html`<div class="turn-status" role="status" aria-live="polite">
    <span class="turn-status-ico codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
    <${ShimmerText} text=${runStatusText(elapsedMs)} className="turn-status-text" active=${true} />
  </div>`
}
