// 差异卡卡体：文件改动的 diff 渲染（适配上游 0.1.7-rc.2 / `ui-primitives/DiffBlock.tsx`）。
//
// 结构逐条对齐上游 ：
//   ```
//   <div class="diff-block" data-diff>          ← 上游还带 CodeCard.card / ToolRow.diffBody
//     <CodeToolbar/>                            ← 语言标签（languageForPath）+ 换行 + 复制
//     <div class="diff-body">                   ← grid + 等宽字体
//       前 5 行（path 头必在其中）
//       「… 其余 N 行」折叠钮
//       后 4 行
//     </div>
//   </div>
//   ```
//   · **路径行是卡体的第一行**（上游 `buildRows:114`，文本原样）—— 不是标题旁的链接，也不是页脚；
//   · `+`/`-` 前缀由 **CSS 伪元素**画（上游 `.add/.del` 同款），行文本里不带符号；
//   · 未变行是 `context` 行（居中、无前缀）。
//
// 折叠：`maxLines = 9`（上游 `CHAT_DIFF_MAX_LINES`）→ 头 `ceil(9/2)=5`、尾 `9-5=4`，
// `hidden = rows.length - 9`（**path/gap 行也计入**）。展开态是**组件局部**的：
// 收起工具行会把卡体卸载，再展开回到折叠态（上游）。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import { diffRows, diffCopyText, diffLabels, languageForPath, type DiffCard as DiffCardData } from '../../core/diff-card'
import { CHAT_DIFF_MAX_LINES, FOLD_ARIA, headTail, foldLabels } from '../../core/fold'

export function DiffCard({ card, store }: { card: DiffCardData; store: ChatStore }) {
  const labels = diffLabels()
  const fold = foldLabels()
  const [expanded, setExpanded] = useState(false)
  const { rows, added, removed, files } = diffRows(card.diffs)
  // 差异内容变化（running → 定稿拿到 meta.diffs）时回到折叠态
  useEffect(() => {
    setExpanded(false)
  }, [rows.length])
  const { head, tail, hidden, capped } = headTail(rows, CHAT_DIFF_MAX_LINES, expanded)
  const copy = (): void => {
    store.copy(diffCopyText(rows))
  }
  const toggle = (): void => setExpanded((e) => !e)
  const line = (r: (typeof rows)[number], key: string): unknown =>
    html`<div class=${'diff-line is-' + r.kind} key=${key}>${r.text || ' '}</div>`
  // 横幅语言标签：所有 diff 指向同一种语言才显示它，否则按上游退回「代码块」
  const first = card.diffs[0] === undefined ? undefined : languageForPath(card.diffs[0].path)
  const language = card.diffs.every((d) => languageForPath(d.path) === first) ? first : undefined
  return html`<div class="diff-block" data-diff>
    <div class="diff-banner">
      <span class="diff-lang">${language ?? labels.codeLabel}</span>
      <button type="button" class="diff-copy" onClick=${copy}>${labels.copy}</button>
    </div>
    <div class="diff-body">
      ${head.map((r, i) => line(r, String(i)))}
      ${capped
        ? html`<button type="button" class="diff-expand" onClick=${toggle} aria-expanded=${expanded} aria-label=${expanded ? FOLD_ARIA.diff.collapse : FOLD_ARIA.diff.expand(hidden)}>
            ${expanded ? fold.collapse : fold.expandRest(hidden)}
          </button>`
        : null}
      ${tail.map((r, i) => line(r, 't' + i))}
    </div>
    <div class="diff-footer">└ +${added} -${removed} · ${labels.files(files)}</div>
  </div>`
}
