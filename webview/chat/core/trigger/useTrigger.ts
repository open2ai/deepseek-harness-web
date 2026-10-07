// 输入触发(trigger)通用框架："/" 斜杠命令、"@ " 引用等“输入框内前缀触发”都收敛到这里。
// 一个触发器 = 一个 TriggerDef，注册进 Composer 后由本钩子统一负责：
//   命中检测(match) → 候选行(rows) → 过滤 → 键盘/点击选择 → pick 分派(改文本或执行)。
// 新加触发类型时新建一个文件(如 at.ts)实现 TriggerDef，并在 Composer 的 defs 数组里加一项即可，
// 避免把逻辑堆进 Composer/单文件。
import { useEffect, useRef, useState } from 'preact/hooks'
import { html } from 'htm/preact'
import { keepRowVisible } from '../scroll'
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

/** 弹窗顶部面包屑里的一段（对齐上游 `InputTriggerCrumb`）：一段＝一个可点回的层级。 */
export interface TriggerCrumb {
  /** 显示名：根层是「工作区」，其余是目录名。 */
  label: string
  /** 点它要写回输入框的 mention（`@dir/`；根层 `@` / `@"`）——与目录行的 value 同一口径。 */
  value: string
  /** 当前所在的那一层：不可点（上游同款）。 */
  current?: boolean
}

/** 判定候选/面包屑时随命中给的上下文（上游 `candidates(session, req)` 的 `req` 同款）。 */
export interface TriggerHitContext {
  /** 触发符之后的查询串（已 trim）。 */
  query: string
  /** 当前 token 是 `@"…"` 引号态：写回 mention 时决定是否沿用引号（上游 `preserveQuote`）。 */
  quoted: boolean
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
  /** 依文本与光标判定是否命中本触发器；命中返回触发符位置 start、查询串 query 与是否 `@"…"` 引号态。 */
  match(text: string, caret: number): { query: string; start: number; quoted: boolean } | null
  /** 返回全部候选行（过滤由框架按 query 做）。可在内部做异步目录预取。 */
  rows(hit: TriggerHitContext): TriggerRow[]
  /**
   * 这个命中是否还在等数据（换层/换查询后、宿主那一帧还没到）。
   *
   * 为 true 时框架**沿用上一份候选**、不把弹窗关掉 —— 上游 `ui-input-trigger/src/core/menu.ts`
   * 的 `hit` 分支就是这条口径（stale-while-revalidate：换查询期间旧候选继续留在屏上，
   * 新 generation 到了才整表替换），否则下钻的那一瞬间列表与面包屑会整个闪掉、等宿主回帧再重建。
   * 宿主明确回了**空**之后这里必须是 false —— 那时该照旧关菜单（不能赖着旧候选不走）。
   */
  pending?(hit: TriggerHitContext): boolean
  /** 弹窗顶部的面包屑（@ 下钻目录用）：一段＝一个可点回的层级；返回 null/空则不显示 */
  header?(query: string, quoted: boolean): readonly TriggerCrumb[] | null
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
  // 当前命中：触发符所属 def + 触发符位置 + 查询串（含是否 `@"…"` 引号态：面包屑根层要沿用同一形态）
  const [sel, setSel] = useState<{ defId: string; start: number; query: string; quoted: boolean } | null>(null)
  const [idx, setIdx] = useState(0)
  /** 真正滚动的候选列表容器（弹窗外壳里除顶部路径条之外的那层）。 */
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 上一份**非空**候选：`pending` 期间沿用它，免得换层那一拍弹窗整个卸载（见 `TriggerDef.pending`）。 */
  const settledRows = useRef<TriggerRow[]>([])

  // 命中当前 def（依 defs 每次渲染都重建，按 id 匹配即可）
  const def = sel ? defs.find((d) => d.id === sel.defId) : undefined
  const hitCtx: TriggerHitContext = { query: sel?.query.trim() ?? '', quoted: sel?.quoted === true }
  const allRows = def ? def.rows(hitCtx) : []
  const q = sel?.query.trim().toLowerCase() ?? ''
  const filtered = q ? allRows.filter((r) => ((r.searchText ?? r.name).toLowerCase().includes(q))) : allRows
  // 缓存只在「弹窗关着」或「过滤后有候选」时更新：pending 期间的空结果不许覆盖它 —— 那正是要沿用的那一份
  if (def === undefined || filtered.length > 0) settledRows.current = filtered
  const pending = def?.pending?.(hitCtx) === true
  const rows = pending && filtered.length === 0 ? settledRows.current : filtered
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
        setSel((prev) => (prev && prev.defId === d.id && prev.start === m.start && prev.query === m.query && prev.quoted === m.quoted
          ? prev
          : { defId: d.id, start: m.start, query: m.query, quoted: m.quoted }))
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

  // 选中行(键盘 ↑/↓ 或鼠标悬停改变 active)始终滚进**候选列表自己**的可视区：列表长、选项溢出时可"跟手"。
  // 滚的是 .trigger-list，不是外层 .popup —— 外层顶上还钉着路径条（@ 下钻的「工作区 › 目录…」）+
  // 它底下那条细线，让外层滚就会把路径条一起滚走/切掉一截（搜索弹窗踩过同一个坑，见 chat.css `.spicker` 注释）。
  // 依赖带 sel（换查询/下钻会换 sel）：列表整表换成新目录时，即使 active 数值没变也要按新列表重新对准。
  useEffect(() => {
    keepRowVisible(listRef.current, active)
  }, [active, sel])

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

  // 弹窗顶部路径条（@ 下钻进目录时显示 `工作区 › 目录 › …`）：一段＝一层，点一段回到那一层（当前层不可点）
  const hdr = def?.header ? def.header(hitCtx.query, hitCtx.quoted) : null

  /**
   * 点面包屑的某一段＝回到那一层：与目录行的「钻取」是同一个动作 ——
   * 把 `@目录/` 重写成那一段的 mention，菜单保持打开并列出该层（当前层不写，按钮本身也已 disabled）。
   */
  const pickCrumb = (index: number): void => {
    const crumb = hdr?.[index]
    const h = makeHelpers()
    if (!crumb || crumb.current === true || !h) return
    h.replace(crumb.value)
    queueMicrotask(() => sync())
  }

  const popup = open
    // 结构同搜索弹窗（.spicker）：外壳不滚，路径条钉在外面，只有候选列表自己滚。
    // listbox 角色落在滚动的列表上而不是外壳：路径条/分组标题都不是选项，上游同样只把角色给滚动视口。
    ? html`<div id=${MENU_ID} class="popup">
        ${hdr && hdr.length > 0
          // 面包屑（对齐上游）：**折行**排布，每段是一个按钮（点回那一层），段间是细线 chevron；
          // 当前层是标签（disabled + aria-current=location），不是可点项。
          ? html`<nav class="trigger-path" aria-label="目录导航">
              ${hdr.map((c, i) => html`${i > 0 ? html`<span class="trigger-sep codicon codicon-chevron-right" aria-hidden></span>` : null}<button
                  type="button"
                  class=${c.current === true ? 'trigger-crumb current' : 'trigger-crumb'}
                  aria-current=${c.current === true ? 'location' : undefined}
                  disabled=${c.current === true}
                  onMouseDown=${(ev: Event) => { ev.preventDefault(); pickCrumb(i) }}
                >${c.label}</button>`)}
            </nav>`
          : null}
        <div class="trigger-list" ref=${listRef} role="listbox">
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
        </div>
      </div>`
    : null

  return { open, rows, active, popup, sync, reset: close, onKeyDown }
}
