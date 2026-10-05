// 过程**一片**（上游 step-group）的组件 —— B′ 按片渲染的落点。
//
// 一片 = 链上两个「步骤文本边界」之间的一段过程（切片判据在 `core/process-groups.ts`，别在这里重算）。
// 本组件承担上游「每个分组 seat」的那一份：
//   · 自己的折叠头（文案/图标按**片内**的项算，判据在 `core/process-group-view.ts`）；
//   · 自己的展开态（store 里按 `${turn}:${group.key}` 存，各片独立）；
//   · 自己的 150ms 标题稳定计时（上游「每 seat 一个 `useStableLiveProcessTitle`」）；
//   · 自己的明细体：封顶高度 + 两端渐隐（`scrollEdges`）—— 各片各自滚。
//
// ⚠️ hook 不能在循环里按数量变化地调用，所以"一片一个组件"是**唯一**干净的解法（见 14 §2.4）：
// `Chain` 只把它们列出来，不在这里做任何分支性的 hook 调用。
import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { DshRowGroup } from '../../../../src/dsh/rows/types'
import type { ChatRow, ChatStore, DshTurnProcessItem } from '../../core/store/chat'
import { processGroupView } from '../../core/process-group-view'
import { scrollEdges, type ScrollEdges } from '../../core/scroll-edges'
import { titleHoldMs } from '../../core/step-process-title'
import { activityGlyph, chevronGlyph } from './ProcessIcons'
import { ShimmerText } from './ShimmerText'
import { chainDetailBody, chainRenderPlan } from './plan'

/** 页面级偏好（整条链共享，与片无关）：四档展示、实时细节、窗口就绪。 */
export interface ChainPagePrefs {
  compact: boolean
  grouping?: 'collapsed' | 'history' | 'none'
  liveProcessDetail?: boolean
}

type AssistantRow = Extract<ChatRow, { kind: 'assistant' }>

/**
 * 渲染过程链里的一"片"。
 *
 * @param props.row - 所属回答行（回合级事实与定稿态从这里读）。
 * @param props.store - 页面 store（展开态、偏好、工具行交互）。
 * @param props.group - 宿主下发的这一片（稳定 key + 该片自己的过程事实）。
 * @param props.items - 该片内的链项（已按链序）。
 * @param props.prefs - 页面级偏好。
 */
export function ProcessGroup({ row, store, group, items, prefs, outerHidden = false }: {
  row: AssistantRow
  store: ChatStore
  group: Pick<DshRowGroup, 'key' | 'facts'>
  items: readonly DshTurnProcessItem[]
  prefs: ChainPagePrefs
  /** 外层（整条过程区）此刻是否折起 —— 折起时本片要跟着关掉（上游 `ChatGroupSeat` 同） */
  outerHidden?: boolean
}) {
  const turn = row.turn
  // ⚠️ 两个 ref 必须**在 `setOpen` 之前**声明：`setOpen` 是闭包、点的时候才跑，但引用在渲染那一刻
  // 就要求变量已初始化（`const` 的暂时性死区会让"声明在后"直接抛错）。整回合路径的 Chain 同理。
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const pendingInit = useRef<'top' | 'bottom' | null>(null)
  // 展开态：键 = `${turn}:${group.key}`（各片独立）。回合号缺失（旧宿主）时按"未记录"处理。
  const stored = turn === undefined ? undefined : store.groupFoldOpen?.value.get(`${String(turn)}:${group.key}`)
  // 默认**收起**：上游的分组头用 `useDisclosure`，初始即收 —— **与回合是否已关闭无关**。
  const open = stored ?? false
  const setOpen = (next: boolean): void => {
    // 手动展开时按上游做一次**预定位**：未关闭的回合停在底部（看最新动静）、已关闭的停在顶部。
    // 真正的写入在渲染后的 layout effect 里（那时元素才存在）。
    if (next) pendingInit.current = row.done ? 'top' : 'bottom'
    if (turn !== undefined) store.setGroupFoldOpen?.(turn, group.key, next)
  }

  /**
   * **外层收起时把本片也关掉**（上游 `ChatGroupSeat` 的那条 effect：`outerHidden` 为真就 `setOpen(false)`）。
   *
   * 为什么不能省：外层"折起"只是把整个过程区挂上 `hidden`，**片自己的展开态还在** ——
   * 不一起关掉的话，展开回来时下面那些片还是开着的（真机反馈："再点『已完成，用时 X』收起，
   * 下面的展开也该一起收"）。这里与上游一样只认**外层折起**这一个触发点，用户手动收起外层时同样生效。
   */
  useEffect(() => {
    if (outerHidden && open) {
      setOpen(false)
    }
  }, [outerHidden, open])

  // 折叠判定与头文案：**判据一条都不复制**，全在 `core/process-group-view.ts`（纯函数、有守卫）。
  // `turnStarted` 用本片自己的事实（缺省退回回合级的），`open` 用本片的展开态。
  const view = processGroupView({
    done: row.done,
    compact: prefs.compact,
    grouping: prefs.grouping,
    turnStarted: group.facts?.turnStarted ?? row.process?.turnStarted === true,
    open,
    items,
    // 插话是**回合级**事实（链项里没有人类消息），所以片级也取宿主算好的那个字段
    hasInterleavedInput: row.process?.hasInterleavedInput === true,
    facts: group.facts,
    liveProcessDetail: prefs.liveProcessDetail,
  })

  // **标题稳定延迟**（上游 `useStableLiveProcessTitle`）：进行中每帧都可能换标题，
  // 要求一条标题**至少显示 150ms** 才允许换下一条 —— 观感上标题不闪。已关闭的回合直接跟随最新值。
  // 判据在 `titleHoldMs()`（纯函数、有守卫），这里只做计时与提交。
  const desiredTitle = { label: view.title, detail: '' }
  const [shownTitle, setShownTitle] = useState(desiredTitle)
  const shownAtRef = useRef(Date.now())
  const desiredRef = useRef(desiredTitle)
  useEffect(() => {
    desiredRef.current = desiredTitle
    const changed = shownTitle.label !== desiredTitle.label
    const hold = titleHoldMs(shownAtRef.current, Date.now(), changed)
    const commit = (): void => {
      shownAtRef.current = Date.now()
      setShownTitle(desiredRef.current)
    }
    if (hold === 0) {
      if (changed) commit()
      return
    }
    const timer = setTimeout(commit, hold)
    return () => { clearTimeout(timer) }
  }, [desiredTitle.label])
  const headText = row.done ? desiredTitle.label : shownTitle.label

  // 明细体：这一片自己的滚动状态（两端渐隐判据与整回合路径同一份 `scrollEdges`）。
  const [edges, setEdges] = useState<ScrollEdges>({ up: false, down: false })
  const groupBody = view.folded && open
  useEffect(() => {
    const el = bodyRef.current
    if (el === null || !groupBody) {
      setEdges((previous) => (previous.up || previous.down ? { up: false, down: false } : previous))
      return
    }
    const sync = (): void => {
      const next = scrollEdges(el.scrollTop, el.clientHeight, el.scrollHeight)
      setEdges((previous) => (previous.up === next.up && previous.down === next.down ? previous : next))
    }
    sync()
    el.addEventListener('scroll', sync)
    // 内容长高/变矮（工具卡展开、正文追加）也要重算，否则渐隐会停在上一次的状态
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    observer?.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      observer?.disconnect()
    }
  }, [groupBody, items.length, row.done])
  // 手动展开的那一下做一次预定位（上游 `initialize(closed === false ? 'bottom' : 'top')`）
  useLayoutEffect(() => {
    const el = bodyRef.current
    const want = pendingInit.current
    if (el === null || want === null) {
      return
    }
    pendingInit.current = null
    el.scrollTop = want === 'bottom' ? el.scrollHeight : 0
    setEdges(scrollEdges(el.scrollTop, el.clientHeight, el.scrollHeight))
  })

  // 明细里实际渲染的项：折叠时**只藏过程成员**，步骤文本留在原位（与整回合路径同一份计划）。
  // 片里出现边界文本是不可能的（边界不属任何片），但这里不做假设 —— 同一份计划照单渲染。
  const plan = chainRenderPlan(items, view.detail)

  // 头部结构完全按整回合路径：`[16px 位：活动图标 / 悬停换箭头][标题]`（CSS 管淡入淡出）。
  const head = view.folded
    ? html`<button class="chain-summary" onClick=${() => setOpen(!open)} aria-expanded=${open}
        data-process-activity=${view.activity}>
        <span class="chain-summary-lead">
          <span class="chain-summary-act" data-step-process-icon>${activityGlyph(view.activity)}</span>
          <span class="chain-summary-chev" data-step-process-chevron>${chevronGlyph(open)}</span>
        </span>
        <${ShimmerText} text=${headText} className="chain-summary-text" active=${!row.done} />
      </button>`
    : null

  return html`<div class="chain-group" data-group-key=${group.key}>
    ${head}
    ${chainDetailBody({ items: plan.items, bodyRef, groupBody, edges, done: row.done, store })}
  </div>`
}
