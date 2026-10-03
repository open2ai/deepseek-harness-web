// 回合**终局通知**行（镜像上游两个节点：`turn-error` 与 `turn-max-tokens`；两者渲染同一套布局）：
//
//   [状态点] 标题 + 文案  [code 小标签]
//
// · 独立行：上游两节点都由 `turn/end` 建、与本回合有没有内容无关，且都在 `INDEPENDENT` 集合里
//   → 不被折进过程组、永远可见（插件里它是顶层行，天然不进回答行的链）；
// · `tone='error'`（`turn-error`）：标题「本轮运行失败」／`ACCOUNT_SIGNED_OUT` 时「任务已停止」，文案走 `turnFailureText`；
// · `tone='warning'`（`turn-max-tokens`）：标题「已达到输出 token 上限」+ 提示（上游 locale 原文）；
// · `code !== undefined` 时右侧追加 `<code>` 小标签（上游 `turn-error` 才有）。
import { html } from 'htm/preact'
import type { ChatRow } from '../../core/store/types'
import { turnNoticeCopy } from '../../core/turn-copy'

export function TurnNoticeRow({ row }: { row: Extract<ChatRow, { kind: 'turnNotice' }> }) {
  const copy = turnNoticeCopy(row)
  return html`<div class=${'msg turn-notice is-' + row.tone} role="status">
    <span class="turn-notice-dot" aria-hidden="true"></span>
    <div class="turn-notice-copy">
      <span class="turn-notice-title">${copy.title}</span>
      ${copy.message !== undefined ? html`<span class="turn-notice-message">${copy.message}</span>` : null}
    </div>
    ${row.code !== undefined ? html`<code class="turn-notice-code">${row.code}</code>` : null}
  </div>`
}
