// 命令行（上游 `command` 节点 = `GenericCommandCard`）：一行一条命令，标题是**裸命令名**。
// 上游同款：前导图标 + 标题 + 分隔符 + 摘要；**只有结算文案含换行**才可展开（展开体是等宽的前格式化文本）；
// 进行中整行掠光、失败变色。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import {
  commandExpandable,
  commandState,
  commandSummary,
  commandTitle,
} from '../../core/command-copy'
import type { ChatRow } from '../../core/store/types'
import { ShimmerText } from '../chain/ShimmerText'

export function CommandRow({ row }: { row: Extract<ChatRow, { kind: 'command' }> }) {
  const [expanded, setExpanded] = useState(false)
  const state = commandState(row)
  const running = state === 'running'
  const text = row.outcome?.text
  const expandable = commandExpandable(row)
  const open = expandable && expanded
  return html`<div class="command-row" data-state=${state}>
    <button
      class="command-head"
      type="button"
      aria-expanded=${open ? 'true' : 'false'}
      onClick=${() => setExpanded(!expanded)}
      disabled=${!expandable}
    >
      <span class="command-icon codicon codicon-terminal" aria-hidden="true"></span>
      <span class="command-title">${commandTitle(row)}</span>
      <span class="command-sep" aria-hidden="true"></span>
      <${ShimmerText} text=${commandSummary(row)} className="command-summary" active=${running} />
    </button>
    ${open && text !== undefined ? html`<pre class="command-body">${text}</pre>` : null}
  </div>`
}
