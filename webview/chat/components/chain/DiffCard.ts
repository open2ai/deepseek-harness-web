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
import { CODE_COPY_LABELS } from '../../core/code-toolbar'
import { CODE_ICON_CHECK, CODE_ICON_COPY, CODE_ICON_NOWRAP, CODE_ICON_WRAP } from '../../core/code-icons'

export function DiffCard({ card, store }: { card: DiffCardData; store: ChatStore }) {
  const labels = diffLabels()
  const fold = foldLabels()
  const [expanded, setExpanded] = useState(false)
  // 换行开关与复制确认：**卡片自己持有状态**（上游 `DiffBlock.tsx:170-172` 的 `useState`，`CodeToolbar` 只是展示件）
  const [wrapped, setWrapped] = useState(false)
  const [copied, setCopied] = useState(false)
  const { rows, added, removed, files } = diffRows(card.diffs)
  // 差异内容变化（running → 定稿拿到 meta.diffs）时回到折叠态
  useEffect(() => {
    setExpanded(false)
  }, [rows.length])
  const { head, tail, hidden, capped } = headTail(rows, CHAT_DIFF_MAX_LINES, expanded)
  const copy = (): void => {
    store.copy(diffCopyText(rows))
    // 确认窗口与代码卡同量级（`code-toolbar.ts` 的 `COPIED_MS`）：图标由 CSS 按 `data-copied` 二选一
    setCopied(true)
    window.setTimeout(() => { setCopied(false) }, 1500)
  }
  const toggle = (): void => setExpanded((e) => !e)
  const line = (r: (typeof rows)[number], key: string): unknown =>
    html`<div class=${'diff-line is-' + r.kind} key=${key}>${r.text || ' '}</div>`
  // 横幅语言标签：所有 diff 指向同一种语言才显示它，否则按上游退回「代码块」
  const first = card.diffs[0] === undefined ? undefined : languageForPath(card.diffs[0].path)
  const language = card.diffs.every((d) => languageForPath(d.path) === first) ? first : undefined
  return html`<div class="diff-block" data-diff data-code-wrap=${wrapped ? 'true' : 'false'}>
    ${/* 横幅 = **与代码卡同一套工具条**（上游 `DiffBlock.tsx:6` 直接复用 `CodeToolbar`，样式取自
         `CodeCard.module.css` 的 header/heading/language/actions/action）：语言标签 + 换行开关 + 复制，
         两个 24×24 图标钮、14px 图标、hover/focus 同款。图标按 `data-code-wrap` / `data-copied` 由 CSS
         二选一显隐（同 `core/code-icons.ts` 的口径），可访问名与上游逐字同款（换行的 `aria-label`
         **固定**「自动换行」、只有 `aria-pressed`/`title` 随状态走）。 */ ''}
    <div class="md-code-head">
      <span class="md-code-lang">${language ?? labels.codeLabel}</span>
      <span class="md-code-acts">
        <button type="button" class="md-code-act" data-diff-wrap
          aria-label=${CODE_COPY_LABELS.wrap} aria-pressed=${wrapped ? 'true' : 'false'}
          title=${wrapped ? CODE_COPY_LABELS.unwrap : CODE_COPY_LABELS.wrap}
          onClick=${() => setWrapped((w) => !w)}>
          ${/* 图标是**上游原样的 HTML 串**（`core/code-icons.ts`）：htm 模板里插值会被转义，
               必须走 `dangerouslySetInnerHTML` —— 否则页面上会出现一大段 SVG 源码文本（2026-10-15 真机）。 */ ''}
          <span class="md-code-ico md-code-ico-wrap" dangerouslySetInnerHTML=${{ __html: CODE_ICON_WRAP }}></span>
          <span class="md-code-ico md-code-ico-nowrap" dangerouslySetInnerHTML=${{ __html: CODE_ICON_NOWRAP }}></span>
        </button>
        <button type="button" class="md-code-act" data-diff-copy data-copied=${copied ? 'true' : undefined}
          aria-label=${copied ? CODE_COPY_LABELS.copied : CODE_COPY_LABELS.copy} title=${CODE_COPY_LABELS.copy}
          onClick=${copy}>
          <span class="md-code-ico md-code-ico-copy" dangerouslySetInnerHTML=${{ __html: CODE_ICON_COPY }}></span>
          <span class="md-code-ico md-code-ico-check" dangerouslySetInnerHTML=${{ __html: CODE_ICON_CHECK }}></span>
        </button>
      </span>
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
