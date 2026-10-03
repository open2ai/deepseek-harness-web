// 思考行（Disclosure 形态），与网页端的同一个组件逐项对齐：
//   收起 = 一行摘要 —— 定稿/历史取**首行**，流式(live)取**最新一行**并右对齐跟随思考尾部（`data-follow-end`）；
//   展开 = **纯文本**全文（`white-space: pre-wrap`，`**加粗**` 这类标记原样显示、不解析成 markdown）
//          —— 上游 `thinkBody` 就是 `<div>{text}</div>` + pre-wrap，本插件此前误走 markdown 渲染；
//   running 态 = 行首套 `data-state='running'` 触发掠光带（`.chain-row-head[data-state='running']::after`，
//          已在 chain.css 里、与工具行共用），上游是 `data-state={running ? 'running' : 'ok'}`。
// 收起态只渲染标题行，行高由标题行决定；全文只在展开时进 DOM（与上游"展开即渲染"同）。
import { html } from 'htm/preact'
import { memo } from 'preact/compat'
import { useState } from 'preact/hooks'
import type { DshTurnProcessItem } from '../../core/store/chat'

type Reasoning = Extract<DshTurnProcessItem, { kind: 'reasoning' }>

/** 收起预览 = **首个非空行**（单行，宽不足再省略；全文靠展开）。 */
const firstLine = (text: string): string => {
  for (const ln of text.split('\n')) {
    const t = ln.trim()
    if (t) return t
  }
  return ''
}

/** 收起预览（流式 live）= **最新一行**（动态跟随思考尾部）。 */
const latestLine = (text: string): string => {
  const visible = text.trimEnd()
  const nl = visible.lastIndexOf('\n')
  return nl === -1 ? visible : visible.slice(nl + 1)
}

interface ReasoningProps {
  item: Reasoning
  live?: boolean
  /**
   * 是否在标题旁预览首行（上游四档策略门：`settledReasoningPreview` / `liveProcessDetail`）。
   * 缺省 true = 显示（读不到偏好时维持接入前形态）。
   */
  showPreview?: boolean
}

function ReasoningRowView({ item, live, showPreview = true }: ReasoningProps) {
  const [open, setOpen] = useState(false) // 默认收起(一行摘要)；点开看全文
  // 收起摘要剥掉 markdown 加粗符号 `**`（如 `**重点**`→`重点`）；**展开全文不动**（上游同：summary 才剥）
  const preview = (live ? latestLine(item.text) : firstLine(item.text)).replaceAll('**', '')
  return html`<div class="chain-disclosure">
    <button class="chain-row-head" data-state=${live ? 'running' : 'ok'} onClick=${() => setOpen((o) => !o)} aria-expanded=${open} title=${preview || ''}>
      <span class=${'codicon chain-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
      <span class="codicon codicon-lightbulb chain-kind-ico"></span>
      <span class="chain-row-title">思考</span>
      ${open || !showPreview || !preview ? null : html`<span class="chain-sep" aria-hidden></span>
        <span class="chain-row-preview" data-follow-end=${live ? '' : undefined}><span class="chain-row-preview-text">${preview}</span></span>`}
    </button>
    ${open
      ? html`<div class="chain-reason is-open">${item.text}</div>`
      : null}
  </div>`
}

/**
 * 组件层跳渲：流式期间每一帧都会重建链上的 vnode，不加这层的话所有思考行都跟着重渲一遍
 * （`live` 每帧都可能变、`item.text` 也在长）。只比两项：只有真正在涨的那行会重渲。
 * 比 `item.text` 而不比 `item`：链项在每次整表构建时都会**重建对象**（宿主侧 `buildRows` 重跑），
 * 按引用比等于永远不等、这层就白加了。
 */
export const ReasoningRow = memo(
  ReasoningRowView,
  (a: ReasoningProps, b: ReasoningProps) => a.item.text === b.item.text && a.live === b.live
)
