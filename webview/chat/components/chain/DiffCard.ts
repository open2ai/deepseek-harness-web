// 差异卡卡体：文件改动的 diff 渲染（适配上游 0.1.7-rc.2）——独立组件，与 Read/Search/Web/Ask 各占一个文件。
// 结构：文件头（path）→ 删除行（- 前缀，error 色）/ 新增行（+ 前缀，success 色）→ 页脚 `└ +N -M · K 个文件`。
// 长差异按上游 8 行上限折叠中间（首尾各半 + 「… 其余 n 行」）——对话行是摘要面，全量铺开会冲垮消息流。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import { diffRows, diffCopyText, diffLabels, type DiffCard as DiffCardData } from '../../core/diff-card'
import { headTail, foldLabels } from '../../core/fold'

export function DiffCard({ card, store }: { card: DiffCardData; store: ChatStore }) {
  const labels = diffLabels()
  const fold = foldLabels()
  const [expanded, setExpanded] = useState(false)
  const { rows, added, removed, files } = diffRows(card.diffs)
  // 差异内容变化（running → 定稿拿到 meta.diffs）时回到折叠态
  useEffect(() => {
    setExpanded(false)
  }, [rows.length])
  const { head, tail, hidden, capped } = headTail(rows, undefined, expanded)
  const copy = (): void => {
    store.copy(diffCopyText(rows))
  }
  const toggle = (): void => setExpanded((e) => !e)
  const line = (r: (typeof rows)[number], key: string): unknown =>
    html`<div class=${'diff-line is-' + r.kind} key=${key}>${r.text || ' '}</div>`
  return html`<div class="diff-block">
    <button type="button" class="diff-copy" onClick=${copy}>${labels.copy}</button>
    <div class="diff-body">
      ${head.map((r, i) => line(r, String(i)))}
      ${capped
        ? html`<button type="button" class="diff-expand" onClick=${toggle} aria-expanded=${expanded}>
            ${expanded ? fold.collapse : fold.expandRest(hidden)}
          </button>`
        : null}
      ${tail.map((r, i) => line(r, 't' + i))}
    </div>
    <div class="diff-footer">└ +${added} -${removed} · ${labels.files(files)}</div>
  </div>`
}
