// 思考行（Disclosure 形态），与网页端的同一个组件逐项对齐：
//   收起 = 一行摘要 —— 定稿/历史取**首行**，流式(live)取**最新"已完成"段落的首行**（右对齐跟随思考尾部，
//          `data-follow-end`；不是"最新一行"，逐行照搬上游 `latestCompletedParagraphFirstLine`）；
//   展开 = **纯文本**全文（`white-space: pre-wrap`，`**加粗**` 这类标记原样显示、不解析成 markdown）
//          —— 上游 `thinkBody` 就是 `<div>{text}</div>` + pre-wrap，本插件此前误走 markdown 渲染；
//   running 态 = 行首套 `data-state='running'` 触发掠光带（`.chain-row-head[data-state='running']::after`，
//          已在 chain.css 里、与工具行共用），上游是 `data-state={running ? 'running' : 'ok'}`。
// 收起态只渲染标题行，行高由标题行决定；全文只在展开时进 DOM（与上游"展开即渲染"同）。
import { html } from 'htm/preact'
import { memo } from 'preact/compat'
import { useState } from 'preact/hooks'
import { reasoningText } from '../../core/reasoning-text'
import type { DshTurnProcessItem } from '../../core/store/chat'

type Reasoning = Extract<DshTurnProcessItem, { kind: 'reasoning' }>

/** 收起预览（定稿/历史）= **首行**（上游 `firstLine`：不 trim、不跳过空行）。 */
const firstLine = (text: string): string => {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * 收起预览（流式 live）= **最新"已完成"段落的首行**（逐行移植上游 `latestCompletedParagraphFirstLine`）。
 *
 * 段落按空行切；"已完成" = 该段已经出现过换行（尾段还在长、连第一行都没写完时不抢镜）。
 * 与旧的"最新一行"不同：同一段里不会跟着尾巴滚，显示的是该段首行（真机对照网页端）。
 */
const latestCompletedParagraphFirstLine = (text: string): string => {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  for (;;) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
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
  // 显示文本：剥掉模型返回的签名段（逐条对齐上游 rc.5 `ReasoningRow`）。
  // **数据层 `item.text` 保持原始**，与上游"rawText 留在数据里"同构 —— 这样
  // `hasReasoning`/`inlineReasoning`/链项数据的判据都不变，只有显示被剥。
  const text = reasoningText(item.text)
  // 上游同一条件：只有"剥过且剥完为空"才隐藏（原本就空的文本不归这条管）。
  const hidden = text !== item.text && text.trim() === ''
  // 收起摘要剥掉 markdown 加粗符号 `**`（如 `**重点**`→`重点`）；**展开全文不动**（上游同：summary 才剥）
  const preview = (live ? latestCompletedParagraphFirstLine(text) : firstLine(text)).replaceAll('**', '')
  if (hidden) return null
  return html`<div class="chain-disclosure">
    <button class="chain-row-head" data-state=${live ? 'running' : 'ok'} onClick=${() => setOpen((o) => !o)} aria-expanded=${open} title=${preview || ''}>
      <span class=${'codicon chain-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
      <span class="codicon codicon-lightbulb chain-kind-ico"></span>
      <span class="chain-row-title">思考</span>
      ${open || !showPreview || !preview ? null : html`<span class="chain-sep" aria-hidden></span>
        <span class="chain-row-preview" data-follow-end=${live ? '' : undefined}><span class="chain-row-preview-text">${preview}</span></span>`}
    </button>
    ${open
      ? html`<div class="chain-reason is-open">${text}</div>`
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
