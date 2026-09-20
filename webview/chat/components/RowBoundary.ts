// 行级错误边界（对齐上游 `SlotErrorBoundary`，见 `core/errors.ts` 顶部关于取舍的说明）。
//
// 每一条「行」各包一层：行在渲染期抛异常时只把**那一行**换成兜底块，兄弟行照常渲染。
// 没有这一层时，任何一行抛错都会让 preact 卸载整棵消息树 —— 真机表现是「打开某个会话整片对话空白」。
//
// **为什么不用 `getDerivedStateFromError`**：preact 的 `_catchError` 确实会调它并 `setState`，
// 但它同时给该组件挂上 `_pendingError` 让提交阶段**跳过这棵子树** —— 于是本地 state 更新既没提交、
// 也没换成兜底块：抛错那行直接**空白**（实测：兄弟行都在、兜底块一个都没有）。
// 所以判据改成**读订阅的账本**（`renderErrors` 信号）：崩溃由 `reportRenderError` 记账 → 信号变
// → 本组件重渲 → 这一次才真画兜底块。重试 = 代数 +1 换子树，同时把该 slot 的账本条目标掉。
import { Component } from 'preact'
import type { ComponentChildren } from 'preact'
import { html } from 'htm/preact'
import { reportRenderError, renderErrors, type RenderErrorEntry } from '../core/errors'

interface RowBoundaryProps {
  /** 出错时写进账本的标识（行 key / 部件名）；同时显示在兜底块上，便于对上是哪一行。 */
  slot: string
  children: ComponentChildren
}

interface RowBoundaryState {
  /** 本 slot 最近一次错误（`null` = 健康）。 */
  error: RenderErrorEntry | null
  /** 重试代数：`+1` 换 `key` 强制子树重挂（同一段坏数据会再次崩，但状态脏了的情况能自愈）。 */
  gen: number
}

/**
 * 兜底块（导出以便脚本直接断言渲染形状）。
 * @param props - 出错标识、错误摘要与重试回调
 */
export function RowFallback({ slot, message, onRetry }: { slot: string; message: string; onRetry: () => void }) {
  const firstLine = message.split('\n')[0] ?? message
  return html`<div class="row-error" data-row-error=${slot} role="alert">
    <span class="codicon codicon-warning row-error-ico" aria-hidden="true"></span>
    <div class="row-error-body">
      <div class="row-error-title">这一行渲染失败（其余内容不受影响）</div>
      <div class="row-error-msg" title=${message}>${firstLine}</div>
    </div>
    <button class="row-error-retry" type="button" onClick=${onRetry}>重试</button>
  </div>`
}

export class RowBoundary extends Component<RowBoundaryProps, RowBoundaryState> {
  override state: RowBoundaryState = { error: null, gen: 0 }

  override componentDidCatch(error: unknown): void {
    reportRenderError(this.props.slot, error)
  }

  /** 重试：该 slot 的账本条目标掉、代数 +1（`key` 随之变化，子树重挂）。 */
  private retry = (): void => {
    const slot = this.props.slot
    renderErrors.value = renderErrors.value.filter((e) => e.key !== slot)
    this.setState((s) => ({ error: null, gen: s.gen + 1 }))
  }

  override render(): ComponentChildren {
    // 订阅账本（这一步同时建立依赖：崩溃上报 → 本组件重渲 → 这一次才画兜底块）
    const latest = renderErrors.value.find((e) => e.key === this.props.slot) ?? null
    const error = this.state.error ?? latest
    if (error !== null) {
      return html`<${RowFallback} slot=${this.props.slot} message=${error.message} onRetry=${this.retry} />`
    }
    const gen = this.state.gen
    return html`<${BoundaryChild} key=${gen}>${this.props.children}</${BoundaryChild}>`
  }
}

/** 承载 children 的一层薄壳：只为了拿到 `key` 让重试能换掉整棵子树。 */
function BoundaryChild({ children }: { children: ComponentChildren }) {
  return children
}
