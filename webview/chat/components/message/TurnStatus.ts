// 左下角 Turn 级状态行：「深度求索中，用时 X ···」+ 小转圈（适配上游 0.2.0 的 `chat.deepDivingFor`）。
// processing（乐观 busy：首 token 等待/工具执行/流式全程）时整轮显示，左对齐贴底。
//
// 本轮对齐（2026-10-01）：**时长始终显示**（上游 `RunningStatus` 同 —— 0.1.7 的实时时钟由回合控制节点渲染、
// 0.2.0 该节点只在回合关闭后渲染，运行态交给运行指示组件）。此前插件固定在 ≥15s 时才在旁边补一个时长。
// 文案与时长格式集中在 `core/run-status.ts`（纯函数、有守卫）；掠光走 `ShimmerText`（真实文字始终可见）。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { runStatusText } from '../../core/run-status'
import { ShimmerText } from '../chain/ShimmerText'

export function TurnStatus() {
  // 运行时钟：锚点=挂载时刻（turn 全程组件常驻，时钟准）
  const [anchor] = useState(() => Date.now())
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => setElapsedMs(Math.max(0, Date.now() - anchor))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [anchor])
  return html`<div class="turn-status" role="status" aria-live="polite">
    <span class="turn-status-ico codicon codicon-loading codicon-modifier-spin"></span>
    <${ShimmerText} text=${runStatusText(elapsedMs)} className="turn-status-text" active=${true} />
  </div>`
}
