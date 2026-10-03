// 读文件卡卡体：带行号的文件内容（适配上游 0.1.7-rc.2）——独立组件。
// 结构：横幅（文件路径 + `显示 N / M 行` 注记 + 语言 + 复制）→ 正文（48px gutter 行号 + 内容，等宽不折行）。
// 长文件按上游 8 行上限折叠中间（首尾各半 + 「… 其余 n 行」）——对话行是摘要面。
// 行保留 `white-space: pre` + 横向滚动：代码折行会破坏缩进对齐。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import { readLabels, type ReadCard as ReadCardData } from '../../core/read-card'
import { headTail, foldLabels } from '../../core/fold'

export function ReadCard({ card, store }: { card: ReadCardData; store: ChatStore }) {
  const labels = readLabels()
  const fold = foldLabels()
  const [expanded, setExpanded] = useState(false)
  const { head, tail, hidden, capped } = headTail(card.lines, undefined, expanded)
  useEffect(() => {
    setExpanded(false)
  }, [card.lines.length])
  // 只显示文件的一部分时才注记行数（上游 windowed = lines.length < totalLines）
  const windowed = card.lines.length < card.totalLines
  const copy = (): void => {
    store.copy(card.lines.map((l) => l.text).join('\n'))
  }
  const toggle = (): void => setExpanded((e) => !e)
  const line = (l: (typeof head)[number], key: string): unknown =>
    html`<div class="read-line" key=${key}>
      <span class="read-gutter">${l.number}</span>
      <span class="read-content">${l.text || ' '}</span>
    </div>`
  return html`<div class="read-block">
    <div class="read-banner">
      <span class="read-label">${card.label}</span>
      ${windowed ? html`<span class="read-count">${labels.window(card.lines.length, card.totalLines)}</span>` : null}
      ${card.lang ? html`<span class="read-lang">${card.lang}</span>` : null}
      <button type="button" class="read-copy" onClick=${copy}>${labels.copy}</button>
    </div>
    <div class="read-body">
      ${head.map((l, i) => line(l, String(i)))}
      ${capped
        ? html`<button type="button" class="read-expand" onClick=${toggle} aria-expanded=${expanded}>
            ${expanded ? fold.collapse : fold.expandRest(hidden)}
          </button>`
        : null}
      ${tail.map((l, i) => line(l, 't' + i))}
    </div>
  </div>`
}
