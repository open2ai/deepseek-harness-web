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
import { COMPACTION_RUNNING } from '../../core/compaction-copy'
import { ShimmerText } from '../chain/ShimmerText'

export function CommandRow({ row }: { row: Extract<ChatRow, { kind: 'command' }> }) {
  const [expanded, setExpanded] = useState(false)
  const state = commandState(row)
  const running = state === 'running'
  const text = row.outcome?.text
  // `/compact` 还没有压缩检查点（命令未结算）时，上游摘要用「正在压缩…」而不是泛化的「执行中…」
  const summary = row.outcome === undefined && row.name === 'compact' ? COMPACTION_RUNNING : commandSummary(row)
  const expandable = commandExpandable(row)
  const open = expandable && expanded
  /**
   * `/goal` 的指令回显：上游 ui-goal 的 `GoalCommandInputView` 为 `command/run` 单独投影一个
   * 右对齐气泡（`/goal` 作为命令 chip、参数为普通文本），通用命令行（结果卡）照常在其下方。
   */
  const commandInput = row.name === 'goal'
    ? html`<div class="command-input-row" data-command-input role="group" aria-label="指令输入">
        <div class="command-input-stack"><div class="command-input-bubble"><span class="command-input-chip">/goal</span>${(row.args ?? '').trimEnd()}</div></div>
      </div>`
    : null
  return html`${commandInput}<div class="command-row" data-state=${state}>
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
      <${ShimmerText} text=${summary} className="command-summary" active=${running} />
    </button>
    ${open && text !== undefined ? html`<pre class="command-body">${text}</pre>` : null}
  </div>`
}
