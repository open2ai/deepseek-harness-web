// 输入触发(trigger)通用框架："/" 斜杠命令、"@ " 引用等“输入框内前缀触发”都收敛到这里。
// 一个触发器 = 一个 TriggerDef，注册进 Composer 后由本钩子统一负责：
//   命中检测(match) → 候选行(rows) → 过滤 → 键盘/点击选择 → pick 分派(改文本或执行)。
// 新加触发类型时新建一个文件(如 at.ts)实现 TriggerDef，并在 Composer 的 defs 数组里加一项即可，
// 避免把逻辑堆进 Composer/单文件。
import { useEffect, useState } from 'preact/hooks'
import { html } from 'htm/preact'
import type { ChatStore } from '../store/chat'

/** 菜单里的一行候选（slash 命令 / 技能 / 本地动作 / 将来 @ 的文件…）。 */
export interface TriggerRow {
  /** 语义分类（slash: command/skill/local；@: file …）。 */
  kind: string
  /** 名字（不含触发符），过滤按它做。 */
  name: string
  /** 展示前缀，如 '/'。 */
  prefix: string
  /** 选项图标（codicon 类名，如 folder/file）；设置后优先渲染小图标而非 prefix */
  icon?: string
  /** 是否可“钻取”（目录行）：渲染右侧 ›，点击/Tab 交给 def.drill 进入下一层 */
  hasDrill?: boolean
  description: string
  /** 可选输入提示（如 permission 的 "<preset>"）。 */
  hint?: string
  /** pick 后应插入到输入框的文本（@ 引用用：carry 上游 mention token）；缺省则由框架按 name 生成 */
  value?: string
  /** 过滤/命中用文本（默认 name）；@ 用全路径/会话id 命中，而展示仍用短名 */
  searchText?: string
  /** 分组标识（同组连续排一起）；提供 groupLabel 时在该组首行前渲染分组头。 */
  group?: string
  groupLabel?: string
}

/** 把候选名里匹配查询串的片段高亮（大小写不敏感；q 空返回原文）。 */
function hl(text: string, q: string): unknown[] {
  if (!q) return [text]
  const low = text.toLowerCase()
  const needle = q.toLowerCase()
  const out: unknown[] = []
  let i = 0
  for (;;) {
    const at = low.indexOf(needle, i)
    if (at < 0) break
    if (at > i) out.push(text.slice(i, at))
    out.push(html`<span class="trigger-hl">${text.slice(at, at + needle.length)}</span>`)
    i = at + needle.length
  }
  out.push(text.slice(i))
  return out
}

/** pick 时提供给 def 的输入改写助手。 */
export interface TriggerPickHelpers {
  /** 用 value 替换「触发符之后到光标前」的整段，光标移到末尾并聚焦。 */
  replace(value: string): void
  /** 删除「触发符之后到光标前」的整段（清掉刚输入的触发内容）。 */
  clear(): void
}

export interface TriggerDef {
  id: string
  /** 依文本与光标判定是否命中本触发器；命中返回触发符位置 start 与查询串 query。 */
  match(text: string, caret: number): { query: string; start: number } | null
  /** 返回全部候选行（过滤由框架按 query 做）。可在内部做异步目录预取。 */
  rows(): TriggerRow[]
  /** 弹窗顶部的面包屑/路径条（@ 下钻目录用）；返回 null 则不显示 */
  header?(query: string): string | null
  /** 选中某行后的行为。 */
  pick(row: TriggerRow, helpers: TriggerPickHelpers): void
  /** 目录行可选的“钻取”（Tab）：返回 true = 保留 @目录/ 并继续列其子项（菜单不关）；false = 交给 pick。 */
  drill?(row: TriggerRow, helpers: TriggerPickHelpers): boolean
}

export interface TriggerMenuApi {
  open: boolean
  rows: TriggerRow[]
  active: number
  /** 待渲染的浮层片段（空/关时为 null）。 */
  popup: unknown
  /** 文本或光标变化后调用（刷新命中/过滤）。 */
  sync(): void
  /** 关闭并复位。 */
  reset(): void
  /** 绑到 textarea 的 keydown。 */
  onKeyDown(e: KeyboardEvent): void
}

const MENU_ID = 'triggerPopup'

/** 一个触发器菜单的控制器。defs 可按需传入，命中取第一个 match 非空者。 */
export function useTriggerMenu(defs: TriggerDef[], store: ChatStore, taRef: { current: HTMLTextAreaElement | null }): TriggerMenuApi {
  // 当前命中：触发符所属 def + 触发符位置 + 查询串
  const [sel, setSel] = useState<{ defId: string; start: number; query: string } | null>(null)
  const [idx, setIdx] = useState(0)

  // 命中当前 def（依 defs 每次渲染都重建，按 id 匹配即可）
  const def = sel ? defs.find((d) => d.id === sel.defId) : undefined
  const allRows = def ? def.rows() : []
  const q = sel?.query.trim().toLowerCase() ?? ''
  const rows = q ? allRows.filter((r) => ((r.searchText ?? r.name).toLowerCase().includes(q))) : allRows
  const open = !!def && rows.length > 0
  const active = Math.min(Math.max(idx, 0), Math.max(rows.length - 1, 0))

  const close = (): void => {
    setSel(null)
    setIdx(0)
  }

  const sync = (): void => {
    const el = taRef.current
    const text = store.text.value
    const caret = el?.selectionStart ?? text.length
    for (const d of defs) {
      const m = d.match(text, caret)
      if (m) {
        setSel((prev) => (prev && prev.defId === d.id && prev.start === m.start && prev.query === m.query ? prev : { defId: d.id, start: m.start, query: m.query }))
        return
      }
    }
    close()
  }

  // 点击输入框与菜单之外 → 关闭
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Node
      const ta = taRef.current
      const menu = document.getElementById(MENU_ID)
      if (!ta?.contains(t) && !menu?.contains(t)) close()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 选中行(键盘 ↑/↓ 或鼠标悬停改变 active)始终滚进弹窗可视区：列表长、选项溢出时可“跟手”
  useEffect(() => {
    if (!open) return
    const menu = document.getElementById(MENU_ID)
    if (!menu) return
    const el = menu.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    if (!el) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    if (top < menu.scrollTop) {
      menu.scrollTop = top
    } else if (bottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = bottom - menu.clientHeight
    }
  }, [active, open])

  const makeHelpers = (): TriggerPickHelpers | null => {
    if (!def || !sel) return null
    const text = store.text.value
    const caret = taRef.current?.selectionStart ?? text.length
    const start = sel.start
    const focusAt = (pos: number): void => {
      queueMicrotask(() => {
        const el = taRef.current
        el?.setSelectionRange(pos, pos)
        el?.focus()
      })
    }
    return {
      replace: (value: string): void => {
        store.text.value = text.slice(0, start) + value + text.slice(caret)
        focusAt(start + value.length)
      },
      clear: (): void => {
        store.text.value = text.slice(0, start) + text.slice(caret)
        focusAt(start)
      },
    }
  }

  const pick = (row: TriggerRow): void => {
    const h = makeHelpers()
    if (!def || !h) return
    def.pick(row, h)
    close()
  }

  /** 目录钻取：返回 true = 已进入下一层（保留 @目录/、菜单保持并刷新候选）；false = 未处理 */
  const drill = (row: TriggerRow): boolean => {
    const h = makeHelpers()
    if (!def || !h || typeof def.drill !== 'function') return false
    if (!def.drill(row, h)) return false
    queueMicrotask(() => sync())
    return true
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    // 这里**只管弹层内部**的键盘（↑↓/Enter/Tab/Esc）。
    // 发送键（Enter / Ctrl+Enter / Shift+Enter 及其偏好切换）一律由调用点经
    // `core/inputKeys.decideInputKey` 判定 —— 两处都判会出现两条发送通路（谁先 preventDefault 谁赢），
    // 那种"有时发一次、有时发两次"的 bug 只能靠真机撞见，故刻意不在这里处理。
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => (i + 1) % rows.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => (i - 1 + rows.length) % rows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[active]) pick(rows[active])
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const row = rows[active]
      if (!row) return
      if (!drill(row)) pick(row) // 非目录行 Tab = 回车式选中
    } else if (e.key === 'Escape') {
      close()
    }
  }

  // 弹窗顶部路径条（@ 下钻进目录时显示 工作区 › …）
  const qRaw = sel?.query.trim() ?? ''
  const hdr = def?.header ? def.header(qRaw) : null

  const popup = open
    ? html`<div id=${MENU_ID} class="popup" role="listbox">
        ${hdr ? html`<div class="trigger-path">${hdr}</div>` : null}
        ${rows.map((r, i) => {
          const showHead = r.groupLabel && (i === 0 || rows[i - 1].group !== r.group)
          return html`${showHead ? html`<div class="optgroup-label">${r.groupLabel}</div>` : null}
            <div class=${i === active ? 'opt selected' : 'opt'} role="option" aria-selected=${i === active}
              data-idx=${i}
              onMouseEnter=${() => setIdx(i)}
              onClick=${() => pick(r)} title=${r.description}>
              <span class="trigger-name">${r.icon ? html`<span class="codicon trigger-ico codicon-${r.icon}"></span>` : r.prefix}${hl(r.name, q)}</span>
              <span class="trigger-desc">${r.description}${r.hint ? `　${r.hint}` : ''}</span>
              ${r.hasDrill
                ? html`<span class="trigger-drill codicon codicon-chevron-right" role="button" aria-label="进入文件夹"
                    title="进入文件夹（Tab）"
                    onClick=${(ev: Event) => { ev.stopPropagation(); drill(r) }}></span>`
                : null}
            </div>`
        })}
      </div>`
    : null

  return { open, rows, active, popup, sync, reset: close, onKeyDown }
}
