// 公共「可搜索选择弹窗」：顶部搜索框(按名称/值模糊过滤) + 选项列表 + 方向键/Enter 选择。
// 用于需要从一组可选项里选一个值的场景(如权限预设 /permission、后续 @ 引用、模型等)，
// 弹窗定位/外点关闭由外层(anchor popup)负责，本组件只负责内部内容与键盘导航。
import { html } from 'htm/preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { keepRowVisible } from '../core/scroll'
import { rankByName } from '../core/rank-by-name'

export interface SearchOption {
  value: string
  /** 展示名(可为空，空则回落 value) */
  name?: string
  description?: string
}

export interface SearchPickerProps {
  title?: string
  options: SearchOption[]
  /** 当前已选值(可空)；命中时行首标 ✓ */
  currentId?: string
  placeholder?: string
  emptyText?: string
  /** 选中一个值：由外层决定是否确认危险项并关闭弹窗。 */
  onPick(opt: SearchOption): void
  /** 关闭弹窗(Escape)。 */
  onClose(): void
}

export function SearchPicker({ title, options, currentId, placeholder = '搜索…', emptyText = '没有可匹配的选项', onPick, onClose }: SearchPickerProps) {
  const [q, setQ] = useState('')
  // 打开时键盘光标落到**当前值**那一行 —— 与上游一致（不是偏离）：
  // 的 `activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), …)`，
  // 且 `:181-184` 明写「The checked row is the value in use; a pane without one opens on its first row.」
  //（旧注释写的「上游 active=0」是错的，已删。）
  // 惰性初始化：组件每次打开都重新挂载，之后不随 currentId 变化跳位；搜索输入仍回第 0 项
  const [idx, setIdx] = useState(() => {
    const i = options.findIndex((o) => o.value === currentId)
    return i < 0 ? 0 : i
  })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const list = useMemo(
    // 与上游同口径（`rankByName`：前缀命中 → 对齐分 → 源序），不再是自己写的子串过滤。
    // 名字与 value 都当搜索键 —— 对应上游的 `name` 与可选 `label`。
    () =>
      rankByName(
        options.map((o) => ({ name: o.name || o.value, ...(o.name === undefined ? {} : { label: o.value }), option: o })),
        q.trim()
      ).map((entry) => entry.option),
    [options, q]
  )
  const n = list.length
  const active = n === 0 ? 0 : Math.min(Math.max(idx, 0), n - 1)
  // 光标移动/过滤变化后把高亮行滚进列表可视区。依赖要带 list：过滤后即使 active 数值没变也要回到正确位置
  useEffect(() => {
    keepRowVisible(listRef.current, active)
  }, [active, list])
  const choose = (o: SearchOption): void => onPick(o)
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (n > 0) setIdx((i) => (i + 1) % n)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (n > 0) setIdx((i) => (i - 1 + n) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (list[active]) choose(list[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  return html`<div class="spicker" onKeyDown=${onKeyDown}>
    ${title ? html`<div class="popup-title">${title}</div>` : null}
    <input ref=${inputRef} class="spicker-search" type="text" placeholder=${placeholder} value=${q} spellcheck="false"
      onInput=${(e: Event) => {
        setQ((e.target as HTMLInputElement).value)
        setIdx(0)
      }} />
    <div class="spicker-list" ref=${listRef} role="listbox">
      ${n === 0
        ? html`<div class="opt" style=${{ opacity: 0.6, cursor: 'default' }}>${emptyText}</div>`
        : list.map(
            (o, i) => html`<div class=${'opt' + (i === active ? ' selected' : '')} key=${o.value}
              role="option" aria-selected=${i === active} data-idx=${i}
              onMouseEnter=${() => setIdx(i)}
              onClick=${() => choose(o)} title=${o.description ?? ''}>
              <span class="sp-name">${o.value === currentId ? '✓ ' : ''}${o.name || o.value}</span>
              ${o.description ? html`<span class="sp-desc">${o.description}</span>` : null}
            </div>`
          )}
    </div>
  </div>`
}
