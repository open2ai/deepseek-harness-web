// 消息列表（按行类型分发）：用户/assistant/审批/提问/notice。智能跟随滚动（判据见 core/follow）。
// 每条行各包一层**行级错误边界**（见 components/RowBoundary）：一行崩了只坏那一行，其余照常。
// 顶端是「加载更早」（历史分页）：只有宿主说「还有更早的」时才出现，加载前钉住阅读位置。
// **聊天区可见性**（对齐上游 0.1.7-alpha.1 起的口径）：系统提示词行与普通上下文注入行不进列表，
// 只有含工具增删块的注入行保留 —— 判据在 `core/chat-visibility.ts`，**在构造渲染列表那一层**过滤。
import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { ScrollFollow, type FollowHost } from '../../core/follow'
import { clearRenderErrors, renderErrors } from '../../core/errors'
import { isVisibleChatRow } from '../../core/chat-visibility'
import { turnRowIndex, turnSeatFacts } from '../../core/nodes/seat-facts'
import { controlRowTargetIndex } from '../../core/control-row-place'
import { anchoredTopAfterPrepend } from '../../../../src/dsh/rows/paging'
import { RowBoundary } from '../RowBoundary'
import { UserRow } from './UserRow'
import { AssistantRow } from './AssistantRow'
import { ApprovalRow } from './ApprovalRow'
import { QuestionRow } from './QuestionRow'
import { TriggerRow } from './TriggerRow'
import { NoticeRow } from './NoticeRow'
import { CommandRow } from './CommandRow'
import { CompactionRow } from './CompactionRow'
import { RetryRow } from './RetryRow'
import { TurnNoticeRow } from './TurnNoticeRow'
import { attachTailNotices } from '../../core/tail-notice'
import { ContextInjectionRow } from './ContextInjectionRow'
import { TurnStatus } from './TurnStatus'
import { PendingSteeringList } from './PendingSteeringRow'

/**
 * 跟随要盯住的元素（顺序：内容列在前，滚动视口在后）。
 *
 * **为什么必须盯内容列**：`#messages` 是滚动视口，高度由 flex 布局定死，内容再长它自己的盒也不变
 * —— `ResizeObserver` 只报**被观察元素自己的盒**变化，所以观察它收不到「内容长高」，
 * 流式回答时 `settle()` 一次都不会被调用，滚动条自然停住（这正是「回答时滚动条不跟随」的成因）。
 * 内容列 `.msg-col` 的高度 = 内容高度，观察它才能拿到真正的增长。
 * 视口本身也要看：窄面板/输入区长高会把视口改矮，那时 `maxTop` 跟着变。
 * 上游同款：观察 `.column`（内容列）与 composer 座位，**不观察**滚动容器。
 */
export function followTargets(content: HTMLElement | null, scroller: HTMLElement): HTMLElement[] {
  return content === null ? [scroller] : [content, scroller]
}

/** 把真实的滚动容器接成 `FollowHost`（判据全在 `core/follow`，这里只是取数与写入的适配）。 */
function hostOf(el: HTMLElement, col: HTMLElement | null): FollowHost {
  const rectOf = (node: HTMLElement): { top: number; bottom: number } => {
    const r = node.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom }
  }
  return {
    get scrollTop(): number {
      return el.scrollTop
    },
    set scrollTop(top: number) {
      el.scrollTop = top
    },
    get scrollHeight(): number {
      return el.scrollHeight
    },
    get clientHeight(): number {
      return el.clientHeight
    },
    // 视口 = 滚动容器本身（**不是**行节点的父节点：那一层现在是内容列 `.msg-col`）
    box: () => rectOf(el),
    // 行在内容列里；取不到内容列（理论上不会发生）时退回视口，避免判据整条失效
    // 行节点 = 内容列里的 `.msg`（**不是直接子节点**：每条行外面还有一层 `.turn-anchor`，
    // 它只是 `data-turn` 的载体，见下面渲染处）
    rows: () => Array.from((col ?? el).querySelectorAll<HTMLElement>('.msg')),
    rectOf,
    nextFrame: (fn) => {
      if (typeof requestAnimationFrame === 'undefined') fn()
      else requestAnimationFrame(fn)
    },
  }
}

export function MessageList({ store }: { store: ChatStore }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // 内容列（`#messages` 里那一层）：跟随的观察对象，见 `followTargets`
  const colRef = useRef<HTMLDivElement | null>(null)
  // 跟随状态机：与容器的生命周期一致（判据全在 core/follow，这里只接 DOM 事件）
  const followRef = useRef<ScrollFollow | null>(null)
  // 容器**存在与否**（欢迎页 / 会话被清空时不渲染）决定接线时机。
  // 必须进依赖：空会话时 `#messages` 整体不渲染（下面 `view !== 'chat'` 那条），
  // 若只在挂载时接线一次，第一条消息到达后就再也接不上 —— 跟随与 ResizeObserver 双双永久失效。
  const visible = store.view.value === 'chat'
  // 容器**上一次卸载前**是否停在底部：重挂时按它恢复（新容器 scrollTop 从 0 开始，
  // 无条件到底会让「切会话后原本读历史的位置」被打回底部；无条件保留又会丢掉"一直跟着看"的手感）。
  const wasAtBottom = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const host = hostOf(el, colRef.current)
    const follow = new ScrollFollow(host)
    followRef.current = follow
    follow.attach(wasAtBottom.current)
    // 首帧就把标记打上（否则要等第一次滚动才禁掉自动锚定；`attach` 的语义见 core/follow）
    if (wasAtBottom.current) el.setAttribute('data-dsh-following-tail', '')
    const onScroll = (): void => {
      follow.onScroll()
      wasAtBottom.current = follow.following
      // 上游同款：**跟随尾部时**在滚动体上标出来，CSS 据此 `overflow-anchor: none`
      // —— 否则浏览器自己的滚动锚定会与"重钉到底"互踢，流式期间观感就是滚动条来回抖。
      if (follow.following) el.setAttribute('data-dsh-following-tail', '')
      else el.removeAttribute('data-dsh-following-tail')
      if (typeof window !== 'undefined' && window.__dshFollowDebug) {
        const d = follow.debug()
        console.log(
          `[follow] scroll stick=${String(d.stick)} top=${String(Math.round(d.top))}/${String(Math.round(d.maxTop))} h=${String(Math.round(d.height))}`
        )
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 跟随由**内容高度变化**驱动（而不是「某次渲染」）：流式长高、图片加载、工具卡展开这类
    // 不引发重渲的变化也要能跟。观察对象见 `followTargets`（**内容列是必须的**：视口自己的盒不变）。
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => follow.settle())
    for (const target of followTargets(colRef.current, el)) observer?.observe(target)
    if (typeof window !== 'undefined') {
      window.__dshFollow = follow
      // 排查用：把接线好的 host 也露出来（「观察了谁」「视口取的是谁」都能在控制台直接问）
      window.__dshFollowHost = host
    }
    return () => {
      const d = follow.debug()
      wasAtBottom.current = d.stick
      el.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      followRef.current = null
      if (typeof window !== 'undefined') {
        if (window.__dshFollow === follow) delete window.__dshFollow
        if (window.__dshFollowHost === host) delete window.__dshFollowHost
      }
    }
  }, [visible])

  // 显式的「到底」请求（发送时）：唯一该**强制**滚到底的入口
  useEffect(() => {
    if (ref.current === null || store.scrollPend.value === 0) return
    followRef.current?.toBottom()
    wasAtBottom.current = true
    store.scrollPend.value = 0
  }, [store.scrollPend.value, visible])

  /**
   * 「加载更早」的**位置锚定**（对齐上游 `loadOlderAnchored` 的语义）。
   *
   * 前插会让整个内容往下推，浏览器会保持 `scrollTop`，于是**读者眼前的内容被推走了**。
   * 这里在每次行表重渲前记下「旧高度 − 顶部」，渲染后把同一段距离补回去 —— 读者停在原处。
   */
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const held = anchorRef.current
    anchorRef.current = null
    if (el === null || held === null) return
    // 补回前插的高度差（算准，不试；见 src/dsh/rows/paging.ts）：这一步是「把读者按回原处」，
    // 不改变跟随归属；写完让跟随状态机复核一次真实位置（程序性写入不会被当成读者移动，见 core/follow）。
    const next = anchoredTopAfterPrepend(held, el.scrollHeight, Math.max(0, el.scrollHeight - el.clientHeight))
    if (next === held.top) return
    el.scrollTop = next
    followRef.current?.settle()
  }, [(store.visibleRows ?? store.messages).value])

  /**
   * **行 → 座位**：每一条渲染行都带上"它属于哪个座位"。
   *
   * 座位 = 上游的渲染粒度（一个 render entry 一个 seat）。行的划分仍是页面自己的事务
   *（滚动锚点、分页、乐观行、导轨都按行 key 挂），但**与上游同构的判据应当读座位**：
   *   · `seatIndex` —— 座位在流程里的次序（**位次**由它说话，不再从行的锚点反推）；
   *   · `seatKey` —— 同一个座位的多条行（`turn-process` 一段一行）由此认亲，
   *     于是"谁是这一项的头""哪一段是当前世代"在座位层面有确定答案。
   *
   * 乐观行（本地已发出、宿主还没回显）不在座位计划里 → `seatOf` 查不到，
   * 判定自然退回行自己的事实（与改造前一致）。按 **key** 而不是按位置对应：
   * 座位计划按 entry 排、渲染行按可见性过滤 + 控制行落位排过，key 是唯一稳定的对应关系。
   */
  const seatOf = new Map<string, { seatKey: string; seatIndex: number; nodeKey: string; isLead: boolean }>()
  // ⚠️ **不再走"字段可缺省"那条路**（原先写的是 `store.seatPlan?.value`）：座位计划是 store 自带的切片，
  // 它与宿主版本**无关**（同一次发布里页面与宿主同版本），所以真实运行永远在。
  // 而 `seatPlan` **为空**是另一回事（乐观态 / 夹具 / 还没有节点模型）—— 那时下面各处会自然地
  // 退回行级判据，这条路径要留着，但它是"空计划兜底"、不是"旧宿主兜底"。
  for (const [index, seat] of store.seatPlan.value.entries()) {
    for (const [at, rowKey] of seat.rowKeys.entries()) {
      seatOf.set(String(rowKey), { seatKey: seat.key, seatIndex: index, nodeKey: seat.nodeKey, isLead: at === 0 })
    }
  }
  const seatKeyOfRow = (row: { key: number | string }): string | undefined => seatOf.get(String(row.key))?.seatKey
  /**
   * **DOM 锚点属性**（上游 那三个同名属性）。
   *
   * 上游的锚点是**一个条目一个**：节点 seat 落 `data-chat-anchor-key={flowKey}`（节点 key），
   * 分组 seat 落 `data-chat-anchor-key={`group:${groupKey}`}`；分页与滚动锚点**直接查这些属性**
   * 。插件此前只有行 key —— 那是行模型的遗留，
   * 这里补成上游口径：**同一座位的多行共用同一个锚点**（座位就是条目），
   * 而**首行带 `data-chat-seat-lead`** 标记，供"每座一个锚点"的读者（分页 / 导轨）认它。
   *
   * ⚠️ 行 key 不退场：React diff、乐观行认领、滚动跟随仍按行 key（页面自身事务）。
   * 锚点只是**补上上游那一维**，不改任何现有行为。
   */
  const anchorAttrsOfRow = (row: { key: number | string; turn?: number }): Record<string, string | undefined> => {
    const seat = seatOf.get(String(row.key))
    if (seat === undefined) return {}
    return {
      'data-chat-anchor-key': seat.nodeKey,
      'data-chat-flow-key': seat.nodeKey,
      ...(typeof row.turn === 'number' ? { 'data-chat-turn': String(row.turn) } : {}),
      ...(seat.isLead ? { 'data-chat-seat-lead': 'true' } : {}),
    }
  }

  if (!visible) return null
  // **渲染只读推导后的行表**：耐久行 + 还没进日志的会话级回显（上游 `ChatView` 的 visible × pending 合并）。
  // `?? store.messages`：只给「手搭桩 store 的老夹具」留一条退路（真实 store 两个切片都在，见 `messages.ts`）。
  const rows = (store.visibleRows ?? store.messages).value
  /**
   * **回合座位事实**（座位层，见 `core/nodes/seat-facts.ts`）：头 / 段数 / 当前世代由**座位计划**说话。
   *
   * 这三件事原先是**逐行近似**出来的（该回合第一条可见行 / 按 `generation` 去重 / 遍历行取
   * `answerStep` 最大值）—— 行一旦被过滤、被挪位、被补容器行，推断就会漂。
   * 现在只要座位计划在（真机就是），就以它为准；读不到（旧宿主 / mock 夹具）时才退回行级近似。
   *
   * `rowsByKey` 先建一次表：事实层按 key 查行，逐次 `find` 会退化成 O(行数²)。
   */
  const rowsByKey = new Map<string, { key: number | string; turn?: number; process?: { answerStep?: number | null } }>()
  for (const row of rows) {
    if (row.kind !== 'assistant') continue
    rowsByKey.set(String(row.key), {
      key: row.key,
      ...(row.turn === undefined ? {} : { turn: row.turn }),
      ...(row.process === undefined ? {} : { process: { answerStep: row.process.answerStep } }),
    })
  }
  const seatPlan = store.seatPlan.value
  const seatFacts = seatPlan.length === 0 ? undefined : turnSeatFacts(seatPlan, rowsByKey)
  const hasMore = store.historyHasMore.value
  const loadingOlder = store.historyLoading.value
  const errorCount = renderErrors.value.length
  const loadOlder = (): void => {
    // 进行中就不要再发一次（`disabled` 只挡真实点击：脚本/辅助技术仍可能派发事件，双保险）
    if (loadingOlder) return
    const el = ref.current
    if (el !== null) {
      anchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    }
    store.loadOlder()
  }
  /**
   * **外层循环改按座位展开**（seat 化第 2 步的落点之一）。
   *
   * 行表本身是按锚点排的；座位计划给的是**条目序**（上游 `rootEntries()` 就是按 `input.order` 输出，
   * 过程项的落点还会被它的第一个成员带走）。真机对拍（25 份会话）里两种序**24 份完全相同**，
   * 1 份不同 —— 那一份的差异**可能正是上游机制**（合并进来的开场回答排在折叠它的控制之前），
   * 尚未取到网页端实拍，故**暂不改变实际顺序**：这里只把"来源"换成座位，
   * 并在两种序**完全一致**时才采用座位序（`sameOrder` 门），不一致就原样用行表序。
   *
   * 乐观行（本地已发出、宿主还没回显）不在座位计划里 → 按原相对次序**收尾**（与改造前一致）。
   */
  const laid = (() => {
    const attached = attachTailNotices(rows)
    const byKey = new Map(attached.map((entry) => [String(entry.row.key), entry]))
    const seatPlanForOrder = store.seatPlan.value
    if (seatPlanForOrder.length === 0) return attached
    const seatOrder: Array<(typeof attached)[number]> = []
    const used = new Set<string>()
    for (const seat of seatPlanForOrder) {
      for (const rowKey of seat.rowKeys) {
        const entry = byKey.get(rowKey)
        if (entry === undefined || used.has(rowKey)) continue
        used.add(rowKey)
        seatOrder.push(entry)
      }
    }
    for (const entry of attached) {
      const key = String(entry.row.key)
      if (used.has(key)) continue
      used.add(key)
      seatOrder.push(entry)
    }
    // 门：两种序**完全一致**才采用座位序（否则原样保留行表序 —— 见上面那段说明）
    const sameOrder = seatOrder.length === attached.length
      && seatOrder.every((entry, i) => entry.row.key === attached[i]?.row.key)
    return sameOrder ? seatOrder : attached
  })()
  // **可见性过滤放在这一层**（不是逐行 `return null`）：`latest`（最后一条）与滚动锚点都按
  // **真正显示出来的**行算 —— 否则末尾一条被隐藏的注入行会把 `latest` 顶掉，
  // 动作条的分叉可用性、时间/复制常显判据就全部跟着错（上游也是先过滤可见节点再算这些）。
  const shown = laid.filter(({ row }) => isVisibleChatRow(row))
  // 过程折叠是**回合级**的（见 core/process-fold）：同一回合可能有多条回答行（插话切成「前段 / 后段」），
  // 只有**首行**出折叠头，其余行跟随同一个展开态。这里按回合归组算好，再逐行下发。
  // 没有回合号的（本地乐观行）自成一组：它没有过程事实，本来也不会折叠。
  //
  // ⚠️ **归属（`turnHeadRow`）与行数（`turnRowCount`）都必须按上面**过滤后**的可见行算**
  // —— 上游就是这个次序：`orderedVisibleChatNodes()` 先 `filter(isVisibleChatNode)`，控制节点的
  // presentation 只由**可见**节点派生、
  // ），控制行的落点 = 该回合**最早可见过程锚**
  // （`presentationPosition()`，同文件 :477-484）。若按未过滤的行算：一条「只有不可见注入」的行
  // 会抢走整个回合的控制行归属 —— 真机现象就是那块「已完成 / 已完成分析」的空块。
  // 每回合的**回答世代数**：`> 1` = 这个回合被插话切成了多段（不同世代的回答并排存在）。
  // 用途：动作条与"末段"判定（`turnTailKeys`）要知道"这一回合被切成几段"。
  //
  // ⚠️ **判据是世代数，不是行数**：一个世代自己就会切成多行 —— 每个回答步一行
  //（上游把回答步发射成独立 entry，插件 `render-plan.ts` 同）。
  // 拿行数当判据的话，**每个多片回合**都会被误判成"被插话切开"。
  // 没有 `generation` 的行（旧宿主 / 无片形态）按自己的 key 各自算一代 —— 保持原来的按行语义。
  //
  // ⚠️ 这件事（回合头）**已经不是内联在渲染体里**了：抽成 `seat-facts` 的 `turnRowIndex()`，
  // 它明确"座位优先、行级兜底"，也便于脚本级守卫逐形状断言。
  //
  // ⚠️ 同处一并删掉了"每回合世代集合"那张表：它唯一的读者是 `soleRow`（"不是唯一一行就不折"），
  // 而那条兜底与上游相反、已整条删除 —— 于是这张表也成了没人读的中间态。
  const turnHeadRow = turnRowIndex(
    shown.map(({ row }) => row),
    (turn) => seatFacts?.get(turn)?.headRowKey,
  ).headRow
  /**
   * **逐世代的"外层折叠"**（上游 的 `outerHidden`）：一个回合被插话切成
   * 多代回答时，**更早世代的那一段内容折起**（`hidden="until-found"`），只留**当前世代**可见。
   *
   * ⚠️ 折的落点是**内容容器**（`Chain` 的 `.chain-body` + `AssistantRow` 的 `.body`），
   * **不是行容器**：答句渲染在 `.chain-body` 之外，只折链体折不住它；而整行折掉又会把
   * 「已完成，用时 …⌄」这个**唯一展开入口**一起藏了（两条都踩过）。
   *
   * **"当前世代"由座位层给**（`seat-facts` 读回合过程项内各行 `answerStep` 的最大值）。
   *
   * ⚠️ 两条都踩过：
   *   · 拿**回合级**的 `answerStep` 去比（旧实现）→ 每行都一样 → **一个都折不起来**；
   *   · 拿 `generation` 去比 → 同一回合只有一个世代（`generation` 只在**插话**时递增，
   *     而"每片一个回答步"不递增）→ 同样折不起来。
   *
   * 记录值（`outerAnswerStep`，键是回合）只用来在用户**唤出过**之后放宽。
   *
   * 三条门与上游一致：`compact`（= `foldCompletedTurns`）+ 回合已关闭 + 该行**不是当前世代**。
   * `grouping === 'none'`（verbose 档）整支不折。
   */
  const outerStepOf = store.outerAnswerStep?.value
  /**
   * 一条**整行内容都被折起**的回答行上，除过程区与答句之外还剩没剩别的东西。
   *
   * `rowOuterHidden(row)` 为真时，这一行的 `.chain-body`（过程区，由 `Chain` 的 `outerFold` 判）
   * 与 `.body`（答句，由本组件判）**都已经折起**；还能看得见的只剩下面这几样：
   *   · `.chain-done` 控制行 —— 只在承回合头的那条行上（调用方用 `!headRow` 挡掉，不在这里重复判）；
   *   · 回合尾部卡（`.schedule-cards`，上游 `ui-schedule` 的 `conversation.chat.turnTail` 槽）；
   *   · 交付物 / 本轮改动卡（`Deliverables`；上游同样挂在 `turnTail`，**不在过程区里**）；
   *   · 归并进来的终局通知行（`tailNotices`，上游 `noticeAnchor` 的位置）；
   *   · 动作条（`RowMeta`）—— 挂在本回合的内容收尾行上（`turnTail`），调用方已挡。
   *
   * 有其中任何一样时**不能**把整行藏掉 —— 那些内容不属于过程区，藏了就是丢内容。
   *
   * @param row - 待判定的行（只有 assistant 行可能整行折起）。
   * @param tailNotices - 归并到这一行的终局通知行。
   * @returns 还有"过程区 / 答句之外"的内容时为 `true`。
   */
  const hasUnfoldedRowContent = (row: ChatRow, tailNotices: readonly ChatRow[] | undefined): boolean => {
    if (row.kind !== 'assistant') {
      return true;
    }
    if ((row.scheduleCreated?.length ?? 0) > 0) {
      return true;
    }
    if ((row.presentedFiles?.length ?? 0) > 0) {
      return true;
    }
    // 改动卡的存在性由 Host 的摘要决定（拿不到摘要就不出卡，见 `Deliverables`）—— 只看字段在不在
    if (row.changesSummary !== undefined && (row.changesSummary.files?.length ?? 0) > 0) {
      return true;
    }
    return tailNotices !== undefined && tailNotices.length > 0;
  };
  /**
   * 行级兜底：座位计划读不到时（旧宿主 / mock 夹具）才按行取每回合 `answerStep` 的最大值。
   * 座位层给得出就用座位层 —— 这是"判据读座位"的落点之一。
   */
  const maxAnswerStepOf = seatFacts === undefined ? (() => {
    const byTurn = new Map<number, number>()
    for (const { row } of shown) {
      if (row.kind !== 'assistant' || row.turn === undefined) continue
      const step = row.process?.answerStep ?? 0
      const seen = byTurn.get(row.turn)
      if (seen === undefined || step > seen) byTurn.set(row.turn, step)
    }
    return byTurn
  })() : undefined
  /**
   * **本回合的当前世代**（唯一一份取值口径）：座位层算好的先用，读不到才退回行级最大值近似。
   *
   * ⚠️ 两处消费者必须同源：① `rowOuterHidden` 判"这一行是不是更早世代"；
   * ② 交给 `Chain` 去比 `outerFold` 的"用户唤出过没有"（上游 `spec.answerStep` 是**回合级**的）。
   * 各写一份就会出现"存的是本行世代、比的是回合世代"这类错配 —— 2026-10-12 那次返工就是它
   * （展开后插件只剩一个片头，网页端有十几个）。
   */
  const currentStepOf = (turn: number): number | undefined =>
    seatFacts?.get(turn)?.currentStep ?? maxAnswerStepOf?.get(turn)
  const rowOuterHidden = (row: Extract<ChatRow, { kind: 'assistant' }>): boolean => {
    if (store.transcriptView.value !== 'compact') return false
    if (store.stepGrouping?.value === 'none') return false
    if (row.turn === undefined || row.done !== true || row.process === undefined) return false
    if (row.interrupted === true || row.status === 'aborted' || row.status === 'error') return false
    if (row.process.hasInterleavedInput === true) return false
    // **座位优先取"当前世代"**（座位计划里的回合过程项自己知道），读不到才退回行级最大值近似。
    const current = currentStepOf(row.turn)
    if (current === undefined) return false
    // 用户唤出过这一回合 → 不再折（他主动把过程/更早世代翻出来看过）
    if (outerStepOf?.get(row.turn) !== undefined) return false
    return (row.process.answerStep ?? 0) < current
  }
  /**
   * 折起行的 DOM 落点已经**不在这一层**了：折的是行内的内容容器
   *（`Chain` 的 `.chain-body` 与 `AssistantRow` 的 `.body`，各自接 `hidden="until-found"`），
   * 判定结果经 `outerHidden` 逐行下发。`beforematch` 的唤出监听在 `Chain` 的 `outerRef` 里。
   */
  // ⚠️ **回合级控制行对每个关闭的回合都存在**（哪怕这一轮没产出任何内容 —— 请求期就失败的那种：
  // 宿主只补出一条空容器行，正文与链都空）。可见行里找不到该回合的 assistant 行时，
  // 让该回合**第一条**容器行来承这一格，否则「处理失败」/「已停止」这类文案就没有落点。
  // 有可见行的回合不受影响（上面那轮已经认了首条**可见**行 —— 上游控制节点的位置就是它）。
  for (const { row } of laid) {
    if (row.kind !== 'assistant' || row.turn === undefined) continue
    if (!turnHeadRow.has(row.turn)) turnHeadRow.set(row.turn, row)
  }
  /** 真正要渲染的行：可见行 + 那些"承了本回合控制块"的容器行（其余仍被可见性挡在外面）。 */
  const rendered = laid.filter(({ row }) => isVisibleChatRow(row)
    || (row.kind === 'assistant' && row.turn !== undefined && turnHeadRow.get(row.turn)?.key === row.key))
  /**
   * **控制行的展示位置**：上游是按 `(anchor, rank)` 排的 —— 控制节点贴着该回合的开局人类输入
   *（有输入时 rank 1、没有时贴着最早的过程证据 rank -1），所以网页端「处理失败」排在重试行**之上**。
   * 插件里"只有回合事实"的容器行是补在末尾的，这里按同一规则把它挪过去（**只挪这一条**，别的行顺序不动）。
   */
  const placed = [...rendered]
  for (const entry of rendered) {
    const row = entry.row
    if (row.kind !== 'assistant' || row.turn === undefined || isVisibleChatRow(row)) continue
    if (turnHeadRow.get(row.turn)?.key !== row.key) continue
    const from = placed.indexOf(entry)
    if (from < 0) continue
    const to = controlRowTargetIndex(placed.map((item) => item.row), from, row.turn)
    if (to < from) {
      placed.splice(from, 1)
      placed.splice(to, 0, entry)
    }
  }
  /**
   * **本回合的内容收尾行**（上游 `lastContent(snapshot, turn, true)` 的等价物）：分叉只允许从这里出发。
   *
   * ⚠️ 与 `latest`（**整表**最后一条可见行）**不是一回事**：一条回合**之后**的行（`/plan` 等命令行、
   * 压缩标记）会把整表的 `latest` 顶掉，于是"正常完成的回合"也点不动分叉（真机现象）。
   * 上游的 `hasLaterChatNode` 用 `snapshot.locations.getTurn(turn)` **只在该回合内**找，并跳过
   * `turn-tail` / `turn-process` / `turn-max-tokens` —— 这里照同一口径：按回合分组、跳过终局通知行，
   * 组内**最后一条内容行**（assistant 或 user）才是收尾行；用户后来又说话时收尾落在 user 行上，
   * 那一回合的回答自然不再是收尾（上游同）。
   */
  const turnTailKeys = new Set<number>()
  {
    const lastOfTurn = new Map<number, number>()
    for (const { row } of shown) {
      // 上游 `skipWarning` 跳过 `turn-max-tokens`（插件的等价物是终局通知行）
      if (row.kind === 'turnNotice') continue
      if (row.kind !== 'assistant' && row.kind !== 'user') continue
      const turn = (row as { turn?: unknown }).turn
      if (typeof turn !== 'number') continue
      lastOfTurn.set(turn, row.key)
    }
    for (const key of lastOfTurn.values()) turnTailKeys.add(key)
  }
  // **打开历史失败**（上游 `ChatView` 的 `openState === 'error' && openError` 那条）：排版与
  // 「加载更早」同一处（列表顶端），文案逐字取上游 `chat.loadError`。
  // ⚠️ 可缺省读取：部分守卫/旧桩的 store 里没有这个切片（它较新），缺了就按"没有失败"渲染
  const openError = store.sessionOpenError?.value
  return html`<div id="messages" ref=${ref}>
    <div class="msg-col" ref=${colRef}>
      ${openError === undefined
        ? null
        : html`<div class="open-error" role="alert">
            历史加载失败：${openError.message}${openError.code === undefined ? '' : `（${openError.code}）`}
          </div>`}
      ${hasMore
        ? html`<button class="load-older" type="button" disabled=${loadingOlder} onClick=${loadOlder}>
            ${loadingOlder ? '正在加载更早的历史…' : '加载更早'}
          </button>`
        : null}
      ${placed.map(({ row, tailNotices }, i) => {
        const latest = i === placed.length - 1
        /**
         * 用户行的"时刻/复制常显"判据与回答行**不是同一条**（真机 2026-10-07：新会话发出第一条后
         * **那一行闪了一下**）。
         *
         * 上游对用户消息用的是**兄弟规则**：后面还有用户/插话消息 → 悬停才出；**没有**（= 最新那条提问）
         * → 常显。它只看"后面还有没有用户消息"，**不受回答行出现的影响**。
         *
         * 插件原先两条都借用"整表最后一行"：发出第一条时它是最后一行 → 常显；宿主的回答行一到，
         * 最后一行变成回答行 → 那一行的时刻/复制**当场淡出** —— 就是那一下闪。
         */
        const lastUserAt = (() => {
          for (let at = placed.length - 1; at >= 0; at -= 1) {
            // 插件把插话渲染成独立的 pending 气泡（不是行），所以这里只认用户行；
            // 但**在途的插话**要按上游一样算成"后面还有一条用户/插话消息"（见下面的 `steeringPending`）
            if (placed[at]?.row.kind === 'user') return at
          }
          return -1
        })()
        // 上游那条兄弟规则把 `steering`（插话）也算作"后面还有消息"：插话在途时，上一条提问
        // 就该退回"悬停才出"。插件把在途插话画成 pending 气泡（排在列表末尾），所以这里单独看它一眼。
        const steeringPending = store.pendingSteering.value.length > 0
        const userLatest = i === lastUserAt && !steeringPending
        // 每条行各包一层错误边界：`key` 放在边界上（边界自己也是行级 vnode），
        // 内部再按行 key 分层，保证「换行」与「重试换子树」两件事互不干扰。
        const body = (() => {
          switch (row.kind) {
            case 'user':
              return html`<${UserRow} key=${row.key} row=${row} store=${store} latest=${userLatest} />`
            case 'context':
              // 已被上面的可见性过滤挡掉（到这里只剩含工具增删块的注入行）；类型上仍可能出现，故保留分支
              return html`<${ContextInjectionRow} key=${row.key} row=${row} />`
            case 'sysprompt':
              // **聊天区不显示系统提示词**（上游 0.1.7-alpha.1 起 `isVisibleChatNode` 排除该 kind）。
              // 数据仍在会话日志里、宿主照旧下发，只是不再渲染 —— 这里返回 null 只作防御。
              return null
            case 'assistant': {
              const head = row.turn === undefined ? undefined : turnHeadRow.get(row.turn)
              return html`<${AssistantRow} key=${row.key} row=${row} store=${store} latest=${latest}
                turnTail=${turnTailKeys.has(row.key)}
                ownsHead=${head === undefined || head.key === row.key}
                outerHidden=${rowOuterHidden(row)}
                seatKey=${seatKeyOfRow(row)}
                turnCurrentStep=${row.turn === undefined ? undefined : currentStepOf(row.turn)}
                tailNotices=${tailNotices} />`
            }
            case 'approval':
              return html`<${ApprovalRow} key=${row.key} row=${row} store=${store} />`
            case 'question':
              return html`<${QuestionRow} key=${row.key} row=${row} store=${store} />`
            case 'notice':
              return html`<${NoticeRow} key=${row.key} row=${row} />`
            case 'turnNotice':
              // 回合终局通知行（上游 `turn-error` / `turn-max-tokens`）：独立行，永远可见（不参与过程折叠）
              return html`<${TurnNoticeRow} key=${row.key} row=${row} />`
            case 'trigger':
              // 触发卡（上游 `turn-trigger`）：某条非 human 通知唤醒了本轮，独立行、永远可见
              return html`<${TriggerRow} key=${row.key} row=${row} />`

            case 'retry':
              // 模型重试链（上游 `model-retry`）：一行一条链，首条 `llm/retry` 的 seq 就是它的位置
              return html`<${RetryRow} key=${row.key} row=${row} />`
            case 'compaction':
              // 自动压缩标记（上游 `compaction`）：只有检查点落地才有这一行，摘要可展开
              return html`<${CompactionRow} key=${row.key} row=${row} store=${store} />`
            case 'command':
              // 手动命令行（上游 `command`）：`permission` 已在可见性过滤里剔除
              return html`<${CommandRow} key=${row.key} row=${row} />`
          }
        })()
        // `data-turn` 是右侧导轨的跳转锚（上游用 Conversation Context key，效果同）
        const turnAttr = typeof (row as { turn?: unknown }).turn === 'number' ? String((row as { turn: number }).turn) : undefined
        // ⚠️ 折的落点是**行内的内容容器**（`Chain` 的 `.chain-body` + `AssistantRow` 的 `.body`），
        // **不是这一行的容器**（`.turn-anchor`）：回合控件「已完成，用时 …⌄」是展开入口，必须留在外面。
        // 上一版把整行折了 → 控件消失、没法展开（维护者当场指出）。
        //
        // `data-turn` 是插件自己的跳转锚（无 JS 消费者，仅属性）；`data-chat-turn` 是**上游同名**的那一个
        // 两个都落，前者留给既有工具，后者供将来按上游口径的读者（分页 / 导轨）。
        //
        // 另两个标记供**流程间距**用（数值逐档对齐上游，见 `chat.css`）：
        //   · `data-turn-process-head` = 本行承着回合头（上游 `[data-chat-flow-kind="turn-process"]`）→ 它与其后一项 16px；
        //   · `data-outer-folded` = 本行的内容被折起（上游对 `hidden` 的 seat 不给间距）。
        const headRow = row.kind === 'assistant' && row.turn !== undefined && turnHeadRow.get(row.turn)?.key === row.key
        const foldedRow = row.kind === 'assistant' && rowOuterHidden(row)
        /**
         * **整行折起 → 整行不占位**（对齐上游"隐藏的 seat 零高、零间距"）。
         *
         * 真机现象（2026-10-11 维护者截图「会话区域的这里的间距怎么这么大」）：一个已关闭、
         * 偏好「收起」的回合里，除承控制行的那条之外，其余每条行都把 `.chain-body` 与 `.body`
         * 一起折起 —— 内容确实是 0 高，但**行自己的盒子还在**（`.col` 里两个块的内外边距），
         * 十几条行叠成一块纯空白，夹在「已完成，用时 X」与收官答句之间；行的条数随回合被切段数增长。
         *
         * 上游的落点是**座位根**而不是座位里的某一块： 用
         * `useSearchableHidden(processHidden, …)` 给整个 `.flowItem` 座位挂 `hidden="until-found"`，
         * 对更早世代的分组座位同样处理；
         * 明确"隐藏的 seat 不产生间距"、`:97-101` 让空 seat `height: 0`。
         * `hidden="until-found"`（`content-visibility: hidden`）保留**零高**盒子，网页查找仍能命中并
         * 触发 `beforematch` 唤出 —— 所以这里也照这条办，而不是 `display: none`（那会让内容搜不到）。
         *
         * ⚠️ 三道门都不能少：
         *   · `!headRow` —— 承着「已完成，用时 X」控制行的那条**必须留在外面**（它是唯一的展开入口，
         *     藏了用户就没法把过程/更早世代翻出来，2026-10-11 已为此返工过一次）；
         *   · 没有交付物卡 / 本轮改动卡 —— `Deliverables` 渲染在过程区**之外**（上游在
         *     `conversation.chat.turnTail` 槽），藏整行会把这它们一起藏掉；
         *   · 没有归并进来的终局通知（`tailNotices`）—— 同理，它们是独立行语义的内容。
         *
         * 落点是 `data-blank='true'` + CSS（`.turn-anchor[data-blank] { height: 0; margin: 0; overflow: hidden }`），
         * **不是**给这一行挂 `hidden`：内容容器自己那份 `hidden="until-found"`（`Chain` 的 `outerRef` /
         * `AssistantRow` 的 `answerRef`）继续负责"可被网页查找命中并唤出"，多挂一层只会把
         * `beforematch` 的落点挪到没有监听器的祖先上。唤出时 `revealOuter` 记下世代 → 下一帧
         * `rowOuterHidden` 变假 → 这一行自动恢复占位，与整行藏/显是同一套判据。
         */
        const blankRow = foldedRow && !headRow
          && !turnTailKeys.has(row.key)
          && !hasUnfoldedRowContent(row, tailNotices)
        return html`<${RowBoundary} key=${row.key} slot=${`row:${String(row.key)}:${row.kind}`}>
          <div class="turn-anchor" data-turn=${turnAttr}
            data-chat-turn=${turnAttr}
            ...${anchorAttrsOfRow(row)}
            data-turn-process-head=${headRow ? 'true' : undefined}
            data-outer-folded=${foldedRow ? 'true' : undefined}
            data-blank=${blankRow ? 'true' : undefined}>${body}</div>
        </${RowBoundary}>`
      })}
      ${/* pending 插话气泡：排在**所有行之后、「生成中」状态行之前** —— 上游的次序就是先整张行表、
           再 pending 行、最后才是运行指示，故气泡在状态行之上。反过来放（气泡在状态行下面）会让
           「刚发出去那条」跑到「深度求索中…」底下，与上游位置相反。
           它们还没进日志，没有锚点序号，所以只能落在这里，不能塞进 `messages`。 */ ''}
      <${PendingSteeringList} items=${store.pendingSteering.value} />
      ${store.processing.value ? html`<${TurnStatus} store=${store} />` : null}
      ${errorCount > 0
        ? html`<div class="render-error-bar">
            <span class="codicon codicon-warning" aria-hidden="true"></span>
            <span>有 ${String(errorCount)} 处内容渲染失败（其余照常显示）</span>
            <button class="render-error-retry" type="button" onClick=${() => clearRenderErrors()}>知道了</button>
          </div>`
        : null}
    </div>

  </div>`
}
