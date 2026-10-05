// 压缩标记行（上游 `compaction` 节点）：一行一次自动压缩，摘要可展开。
// 上游同款：**拿不到摘要就不可展开**（按钮 disabled）、标题固定「上下文已压缩」、前导是"上下文"图标 + 折叠箭头。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import {
  COMPACTION_TITLE,
  compactionExpandable,
  compactionSummaryText,
} from '../../core/compaction-copy'
import type { ChatRow } from '../../core/store/types'
import { MessageBody } from './MessageBody'

export function CompactionRow({ row }: { row: Extract<ChatRow, { kind: 'compaction' }> }) {
  const [expanded, setExpanded] = useState(false)
  const expandable = compactionExpandable(row)
  const open = expandable && expanded
  return html`<div class="compaction-row" data-expandable=${expandable ? 'true' : undefined}>
    <button
      class="compaction-head"
      type="button"
      disabled=${!expandable}
      aria-expanded=${expandable ? (open ? 'true' : 'false') : undefined}
      onClick=${() => setExpanded(!expanded)}
    >
      <span class="compaction-leading" aria-hidden="true">
        <span class="compaction-context-icon codicon codicon-symbol-namespace"></span>
        <span class="compaction-chevron codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'}"></span>
      </span>
      <span class="compaction-title">${COMPACTION_TITLE}</span>
      <span class="compaction-sep" aria-hidden="true"></span>
      <span class="compaction-summary">${compactionSummaryText(row)}</span>
    </button>
    ${open && row.summary !== undefined
      ? html`<div class="compaction-body"><${MessageBody} text=${row.summary} streaming=${false} /></div>`
      : null}
  </div>`
}
