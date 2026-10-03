// 搜索卡卡体：命中行列表与文件分组（适配上游 0.1.7-rc.2）——独立组件。
// 结构：头行（`N 处匹配 · M 个文件` / `N 个路径` + 复制）→ 正文 → 空则 `无结果` → 被截断时附兜底定位符。
// 两层折叠，与上游一致：
//   1. 整体按 8 行上限折中段（首尾各半 + 「… 其余 n 行」）——对话行是摘要面；
//   2. matches 分支的文件头是**按钮**，点它收起/展开该文件的匹配（文件组折叠）。
// 行保留折行（pre-wrap）：搜索结果不是需要对齐的代码，折行比横滚好读。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import { searchLabels, searchCopyText, searchMatchCount, type SearchCard as SearchCardData } from '../../core/search-card'
import { headTail, foldLabels } from '../../core/fold'

/** 扁平化后的展示行：文件头 / 匹配行 / 路径行。 */
type Row =
  | { kind: 'file'; path: string; count: number }
  | { kind: 'match'; path: string; lineNumber: number; line: string }
  | { kind: 'path'; path: string }

export function SearchCard({ card, store }: { card: SearchCardData; store: ChatStore }) {
  const labels = searchLabels()
  const fold = foldLabels()
  const [expanded, setExpanded] = useState(false)
  // 被收起的文件（matches 分支的文件组折叠）；按路径记，文件头点击切换
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    setExpanded(false)
    setCollapsed(new Set())
  }, [card.kind])

  // 扁平化成展示行：被收起的文件只留文件头（与上游「点文件头折叠该组」同观感）
  const rows: Row[] =
    card.kind === 'paths'
      ? card.paths.map((p): Row => ({ kind: 'path', path: p }))
      : card.files.flatMap((f): Row[] => {
          const head: Row = { kind: 'file', path: f.path, count: f.matches.length }
          if (collapsed.has(f.path)) return [head]
          return [head, ...f.matches.map((m): Row => ({ kind: 'match', path: f.path, lineNumber: m.lineNumber, line: m.line }))]
        })

  const shown = searchMatchCount(card)
  const files = card.kind === 'matches' ? card.files.length : 0
  const summary =
    card.kind === 'matches'
      ? labels.matchesSummary(shown, card.total, files, card.truncated)
      : labels.pathsSummary(shown, card.total, card.truncated)
  const empty = shown === 0
  const { head, tail, hidden, capped } = headTail(rows, undefined, expanded)

  const copy = (): void => {
    store.copy(searchCopyText(card))
  }
  const toggleExpand = (): void => setExpanded((e) => !e)
  const toggleFile = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const rowNode = (r: Row, key: string): unknown => {
    if (r.kind === 'file') {
      const isCollapsed = collapsed.has(r.path)
      return html`<button type="button" class="search-file-head" key=${key} onClick=${() => toggleFile(r.path)} aria-expanded=${!isCollapsed}>
        <span class=${'codicon ' + (isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down')}></span>
        <span class="search-file-path">${r.path}</span>
        <span class="search-file-count">${r.count}</span>
      </button>`
    }
    if (r.kind === 'path') return html`<div class="search-line" key=${key}>${r.path}</div>`
    return html`<div class="search-line" key=${key}><span class="search-line-number">${r.lineNumber}: </span>${r.line}</div>`
  }

  return html`<div class=${'search-block search-' + card.kind}>
    <div class="search-header">
      <span class="search-summary">${summary}</span>
      <button type="button" class="search-copy" onClick=${copy}>${labels.copy}</button>
    </div>
    ${empty
      ? html`<div class="search-empty">${labels.noResults}</div>`
      : html`<div class="search-body">
          ${head.map((r, i) => rowNode(r, String(i)))}
          ${capped
            ? html`<button type="button" class="search-expand" onClick=${toggleExpand} aria-expanded=${expanded}>
                ${expanded ? fold.collapse : fold.expandRest(hidden)}
              </button>`
            : null}
          ${tail.map((r, i) => rowNode(r, 't' + i))}
        </div>`}
    ${card.recovery ? html`<div class="search-recovery">${card.recovery}</div>` : null}
  </div>`
}
