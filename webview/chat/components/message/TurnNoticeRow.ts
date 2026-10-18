// 回合**终局通知**行（镜像上游两个节点：`turn-error` 与 `turn-max-tokens`；两者渲染同一套布局）：
//
//   [状态点] 标题 + 文案  [code 小标签]
//
// · 独立行：上游两节点都由 `turn/end` 建、与本回合有没有内容无关，且都在 `INDEPENDENT` 集合里
//   → 不被折进过程组、永远可见（插件里它是顶层行，天然不进回答行的链）；
// · `tone='error'`（`turn-error`）：标题「本轮运行失败」／`ACCOUNT_SIGNED_OUT` 时「任务已停止」，文案走 `turnFailureText`；
// · `tone='warning'`（`turn-max-tokens`）：标题「已达到输出 token 上限」+ 提示（上游 locale 原文）；
// · `code !== undefined` 时右侧追加 `<code>` 小标签（上游 `turn-error` 才有）；
//   例外：`INTERRUPTED`（宿主中途退出）**不显示**这个标签 —— 那一行的标题与原因句已经说清了，
//   再挂一个内部 code 只是噪音（上游同位置也没有）。
import { html } from 'htm/preact'
import type { ChatRow } from '../../core/store/types'
import { turnNoticeCopy } from '../../core/turn-copy'

/** 不挂 code 小标签的失败码（它们由标题/正文自解释）。 */
const NO_CODE_LABEL = new Set(['INTERRUPTED'])

export function TurnNoticeRow({ row }: { row: Extract<ChatRow, { kind: 'turnNotice' }> }) {
  const copy = turnNoticeCopy(row)
  const showCode = row.code !== undefined && !NO_CODE_LABEL.has(row.code)
  return html`<div class=${'msg turn-notice is-' + row.tone} role="status">
    <span class="turn-notice-dot" aria-hidden="true"></span>
    <div class="turn-notice-copy">
      <span class="turn-notice-title">${copy.title}</span>
      ${copy.message !== undefined ? html`<span class="turn-notice-message">${copy.message}</span>` : null}
    </div>
    ${showCode ? html`<code class="turn-notice-code">${row.code}</code>` : null}
  </div>`
}
