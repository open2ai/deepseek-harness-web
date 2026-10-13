// 过程链（Chain）：**按片**（上游 step-group）渲染 —— 每片一个「过程分组标题 + 折叠控制」头。
// **文案按上游 `processTitle()`**：取该片前三类活动的本地化名称（如「已读取文件并读取图片」），
// **不带计数**；没有工具调用时是「已完成分析」。进行中则用进行时文案（「正在读取文件」）。
// **折叠头出现的条件由偏好里的两列共同决定**（0.2.0 起）：
//   进行中 → 只有 `stepGrouping === 'collapsed'`（compact/standard 档）出分组头；
//            它和已关闭回合一样**默认收起**（上游 `useDisclosure()` 初始即收），点开才看明细；
//            `history`（detailed）与 `none`（verbose）下进行中平铺、没有头；
//   已完成 + `foldCompletedTurns`（compact/standard/detailed 三档都为真）→ 收起成折叠头，点开看明细；
//   已完成 + `verbose`（不折叠）→ 过程行平铺。
// 链里有任何过程内容(工具/思考/上下文注入/召回) 才出折叠头；一类工具都没有时标题是「已完成分析」。
// **纯思考同样出折叠头**——上游 foldable 对「有过程成员」成立，与「N 次工具调用」是同一套折叠，
// 不是平铺；定稿后思考行同样收进折叠里。
//
// **头的粒度 = 片**（B′，见 `tmp/版本差异记录/dsh-v0.1.7-rc.2_to_dsh-v0.2.0-rc.2/14`）：
// 宿主按「带回答内容的步」下发 `groups`，页面按**链上位置**把它切成片（判据只在
// `core/process-groups.ts`，别在这里重算）—— **每片一个头、每片自己的展开态与文案**
//（上游"每个分组 seat 恰好一个头"）。片之间的步骤文本是**边界**：不属任何片、永远可见
//（对应上游那个独立回答节点）。片的判据在 `core/process-group-view.ts`，渲染在 `ProcessGroup`。
//
// **两道回退**（都走回"整回合一条头"的既有形态，绝不半新半旧）：
//   · 宿主没给 `groups`（旧宿主 / 单回答步回合）→ 整回合一条头；同回合各行共用展开态（`ownsHead` 归首行）；
//   · 有 `groups` 但**片数与链上边界对不上** → 同上（`planProcessGroups` 的 `ok === false`）。
// **没有"只含提问行就不折叠"这条例外**（⚠️ 2026-10-12 更正：本行原先写着"例外：只含提问行(ask)时
// 整回合/整片不折叠，平铺显示问行" —— 那条插件自造的偏离 `noFold` 早在 2026-10-02 就撤了，
// 提问在上游是**可见节点**、与普通工具行一视同仁地计入过程内容：
// 的 `tool/call` 分支、`core/nodes/chat-nodes.ts` 的 `derivePresentation`，
// 以及 `core/process-fold.ts` 的 `foldable = windowReady && (hasExternalProcess || inlineReasoning)` 里
// 都没有"提问"这一支）。真正"不出整回合折叠头"的情形只有一个：算不出可折内容
//（`hasExternalProcess` 与 `inlineReasoning` 皆假）。
import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { ChatRow, ChatStore, DshTurnProcessItem } from '../../core/store/chat'
import { processDisclosure } from '../../core/process-fold'
import { planProcessGroups } from '../../core/process-groups'
import { scrollEdges, type ScrollEdges } from '../../core/scroll-edges'
import {
  closedProcessTitle,
  headActivity,
  liveProcessDetailOf,
  liveProcessTitle,
  titleHoldMs,
} from '../../core/step-process-title'
import { activityGlyph, chevronGlyph } from './ProcessIcons'
import { ShimmerText } from './ShimmerText'
import { ProcessGroup } from './ProcessGroup'
import { chainDetailBody, chainProcText, chainRenderPlan, HIDDEN_UNTIL_FOUND, outerFold, reasoningLive } from './plan'
import { doneStatusText } from '../../core/run-status'

// 两项纯判据的实现在 `./plan`（Chain 与 ProcessGroup 共用同一份）；这里**原样再导出**：
// 两者都被守卫直接断言（`tmp/_rows.render.test.mjs` 取 `reasoningLive`、`_chain.render.test.mjs` 取
// `chainRenderPlan`），入口别换。
export { chainRenderPlan, reasoningLive }

type AssistantRow = Extract<ChatRow, { kind: 'assistant' }>

/**
 * 一行的过程链渲染。
 *
 * ⚠️ 这里曾经的 `soleRow`（"本行不是本回合唯一一行就不折"）**已整条删除**（2026-10-11）：
 * 外层折叠改成**逐世代**判之后它就没有读者了，留着只会让下一个人以为它还在起作用。
 * 判定口径见 `outerFold` 的注释。
 */
export function Chain({ row, store, ownsHead, stoppedPill, outerHidden, seatKey, turnCurrentStep }: { row: AssistantRow; store: ChatStore; ownsHead: boolean; stoppedPill?: unknown; outerHidden?: boolean; seatKey?: string; turnCurrentStep?: number }) {
  void outerHidden
  // 座位身份（上游 render entry 的 key）：**一行属于哪一项**由此说话。
  // 目前只作身份标记落在 DOM 上（`data-seat-key`），供"逐座位"改造的下一步与真机核对读它。
  const seatAttr = seatKey === undefined ? {} : { 'data-seat-key': seatKey }
  const chain = row.chain
  // 上游显示偏好（控制已完成轮次的过程内容）；未知/未到 = compact，即接入前的固有形态
  const compact = store.transcriptView.value === 'compact'
  /**
   * 分组偏好（上游 `stepGrouping` 那一列）**必须在渲染体里读一次**。
   *
   * ⚠️ 真机事故（2026-10-09）：「工作步骤展示」在设置里改完，网页端即时生效，插件要**再点一次
   * 收起/展开**才看得到。根因就是这里 —— 原先只在**把 prefs 当属性传下去的那一刻**读
   *（`prefs=${{ grouping: store.stepGrouping?.value }}`）：那个表达式在 htm 模板里求值，
   * **不建立本次渲染对信号的订阅**，偏好一变本组件不重渲 → 片组件拿到的还是旧的 `grouping`，
   * 分组头的有无与明细的可见性就全停在改动前那一档。（`transcriptView` 一直是这么读的，
   * 所以四档里只有分组那一档不跟手。）
   */
  const grouping = store.stepGrouping?.value
  // 展开态是**回合级**的（整回合路径：同回合多段行共用；上游按 (turn, answerStep) 持久化）。
  // 默认**收起**：上游的分组头初始即收，**与回合是否已关闭无关**；只有用户点开才展开。
  // **按片路径不用它**（各片有自己的键 `${turn}:${group.key}`，见 `ProcessGroup`）—— 那道回合级
  // 控制属于"整回合一条头"的形态，随片化的头一起退出；外层折叠是另一步。
  const turn = row.turn
  const stored = turn === undefined ? undefined : store.turnFoldOpen.value.get(turn)
  // 分组体的滚动状态（上游 `useProcessScroll` 的边判定部分）：`up/down` = 两端还看不看得见内容。
  // ⚠️ 这些 hook 必须在**任何提前返回之前**声明（preact 按调用顺序配 hook），所以本组件把
  // `chain.length === 0` 的返回挪到了所有 hook 之后 —— 别把那个 return 挪回来。
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const pendingInit = useRef<'top' | 'bottom' | null>(null)
  const [edges, setEdges] = useState<ScrollEdges>({ up: false, down: false })
  const open = stored ?? false
  const setOpen = (next: boolean): void => {
    // 手动展开时按上游做一次**预定位**：未关闭的回合停在底部（看最新动静）、已关闭的停在顶部。
    // 真正的写入在渲染后的 layout effect 里（那时元素才存在）。
    if (next) pendingInit.current = row.done ? 'top' : 'bottom'
    if (turn !== undefined) store.setTurnFoldOpen(turn, next)
  }

  // **按片渲染计划**（B′）：片 = 链上两个文本边界之间的一段过程。`ok === false` 时整体退回整回合形态。
  // 它只决定"画什么"、不参与 hook 数量，所以放在这里与判据同序读。
  const groupPlan = planProcessGroups(chain, row.groups)
  const grouped = groupPlan.ok && row.groups !== undefined && row.groups.length > 0
  /** 最终形态：节点模型下发的成员表分组（每组 = 实际成员 + 该片事实），优先于步区间切片。 */
  const nodeGrouped = row.nodeGroups !== undefined && row.nodeGroups.length > 0
  const groupEntries = groupPlan.entries.filter((entry) => entry.kind === 'group')

  // **外层折叠**（⑧，上游 `ChatGroupSeat` 的 `outerHidden`/`revealOuter`；判据在 `./plan`）：
  // 已关闭的回合只留**当前回答世代**那一片可见，更早的世代整片折起（`hidden="until-found"`，可被查找唤出）。
  // `stored` 缺省 = 没记录 → 折起（与上游一致：历史回合默认只看得见最后一个世代）。
  // ⚠️ **逐世代判**（2026-10-11 去掉 `soleRow` 兜底）：本行按**自己的** `answerStep` 判，
  // 于是"被插话切成多段"的回合里，更早世代的那些行各自折起、当前世代那行照常可见 ——
  // 与上游 同口径。去掉之前是"多段就整支不折"，屏幕会出现全部答句。
  const outer = outerFold({
    foldCompleted: compact,
    // 「不分组」那一档（上游 verbose）连外层折起也一并关掉（同一张策略表里两列同源，见 `outerFold` 的注释）
    grouped: grouping !== 'none',
    done: row.done,
    // 上游 `turnProcessAlwaysOpen()` 的一项：过程区间里有人插过话 → 永远展开（宿主算好的事实）
    hasInterleavedInput: row.process?.hasInterleavedInput === true,
    hasProcess: row.process !== undefined,
    answerStep: row.process?.answerStep ?? undefined,
    // **回合级当前世代**（座位层给）：`revealed` 与唤出记录都用它 —— 上游 `spec.answerStep` 是回合级的，
    // 于是"点一次控制行 = 整个回合一起露出来"（2026-10-12 修：「插件比 web 少了很多步骤」）
    currentStep: turnCurrentStep,
    storedAnswerStep: turn === undefined ? undefined : store.outerAnswerStep?.value.get(turn),
    // 上游 `turnProcessAlwaysOpen()` 的两个"非正常收官"：**只有** aborted / error。
    // （`forked` / `interrupted` 等一律当普通收官 —— 2026-10-02 按 tag 更正，见下面的注释）
    interrupted: row.interrupted === true || row.status === 'aborted' || row.status === 'error',
    sliceCount: nodeGrouped ? row.nodeGroups!.length : groupEntries.length,
  })
  /** 用户唤出（网页查找命中 `beforematch`）→ 记下"已唤出到当前世代"。 */
  const revealOuter = (): void => {
    if (turn !== undefined) store.revealOuter?.(turn, turnCurrentStep ?? outer.answerStep)
  }
  /** `beforematch` 的稳定监听器（ref 回调里 add/remove 的是同一个引用）。 */
  const onBeforeMatch = useRef(revealOuter)
  onBeforeMatch.current = revealOuter
  const outerRefEl = useRef<HTMLDivElement | null>(null)

  // 折叠头（过程分组标题）文案 = 上游口径（**按类别、不带计数**，2026-10-01 对齐）：
  //   已关闭 → `processTitle()`（如「已读取文件并读取图片」；没有工具调用 → 「已完成分析」）；
  //   进行中 → `message.stepProcess.<activity>`（如「正在读取文件」；没有运行中的工具 → 「正在分析请求」）。
  // 判据在 `core/step-process-title.ts`（纯函数、有守卫）。此前是「N 次工具调用 · M 条消息」，属长期偏离。
  // **按片路径这里不生效**：文案按**片内**的项算，在 `ProcessGroup` 里（各片一份）。
  const foldLabel = row.done ? closedProcessTitle(chain) : liveProcessTitle(chain)
  // **实时细节**（上游 `ChatGroupSeat`：`detailed = 未关闭 && liveProcessDetail`）：进行中且偏好为真时，
  // 标题后接 `' · ' + 细节`（分隔符取上游 `message.turnProcess.separator`）。这是 `liveProcessDetail`
  // 上游**唯一**的用途 —— 思考行的预览门另有其人（`running || settledReasoningPreview`，见下）。
  const liveDetail =
    !row.done && store.liveProcessDetail?.value !== false ? liveProcessDetailOf(chain) : ''
  // **标题稳定延迟**（上游 `useStableLiveProcessTitle`）：进行中每帧都可能换标题（工具一个接一个），
  // 于是要求一条标题**至少显示 150ms** 才允许换下一条 —— 观感上标题不闪。已关闭的回合直接跟随最新值。
  // 判据在 `titleHoldMs()`（纯函数、有守卫），这里只做计时与提交。
  // **按片路径各片各自计时**（上游"每 seat 一个 hook"）：见 `ProcessGroup`。
  const desiredTitle = { label: foldLabel, detail: liveDetail }
  const [shownTitle, setShownTitle] = useState(desiredTitle)
  const shownAtRef = useRef(Date.now())
  const desiredRef = useRef(desiredTitle)
  useEffect(() => {
    desiredRef.current = desiredTitle
    const changed = shownTitle.label !== desiredTitle.label || shownTitle.detail !== desiredTitle.detail
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
  }, [desiredTitle.label, desiredTitle.detail])
  // 未关闭才用"稳定后的"标题；已关闭即时跟随（上游 `return active ? displayed : desired`）
  const headTitle = row.done ? desiredTitle : shownTitle
  const headText = headTitle.detail === '' ? headTitle.label : `${headTitle.label} · ${headTitle.detail}`
  // 头部左侧图标按**活动类别**换（上游同款），已关闭回合取排名第一的类别
  const headActivityKind = headActivity(chain, row.done)

  // 折叠门控：判据链在 `core/process-fold.ts`（上游同口径），组件只按结果渲染。
  // 上游对「2 次工具调用 + 已停止」的回合照样折叠 —— 只要**末步有回答内容且已定稿**。
  const disclosure = processDisclosure({
    done: row.done,
    process: row.process,
    compact,
    // 上游 `stepGrouping`（0.2.0）：`collapsed` 时**进行中的回合也出分组头**（默认展开，可点收起）；
    // `history`/`none` 下进行中平铺。读不到偏好（部分 mock / 旧宿主）时 undefined → 按 `history` 处理。
    grouping,
    open,
    ownsHead,
    // 窗口就绪的最后一条门（上游 0.2.0：per-Turn 的 `turnStarted || turnClosed`）：
    // 窗口里有本回合的 `turn/start` 就算就绪；没有它则靠 `done`（= `turnClosed`）。
    // **历史分页截断不是不折叠的理由**（旧版那道 `historyIncomplete` 上游已删）。
    turnStarted: row.process?.turnStarted === true,
  })
  // 按片路径下**整回合这道头不渲染**："片数 = 头数"是验收判据 —— 多一个回合级头就多一个
  // 控制点，且与片头语义重叠（一个开合整个回合、一个开合片内）。片自己的头就是本回合的控制。
  const folded = disclosure.head && !nodeGrouped
  // 头部结构按上游：`[16px 位：活动图标 / 悬停换箭头][标题]`。
  // 图标与箭头叠在同一格（`.chain-summary-act` / `.chain-summary-chev`，CSS 管淡入淡出），
  // 所以**悬停图标位就看到箭头、点它展开/收起**；展开态常显箭头（上游 `aria-expanded` 那条规则）。
  // 标题带「文字微光」：只对**未关闭**的回合掠光（已定稿不闪）。
  const head = folded
    ? html`<button class="chain-summary" onClick=${() => setOpen(!open)} aria-expanded=${open}
        data-process-activity=${headActivityKind}>
        <span class="chain-summary-lead">
          <span class="chain-summary-act" data-step-process-icon>${activityGlyph(headActivityKind)}</span>
          <span class="chain-summary-chev" data-step-process-chevron>${chevronGlyph(open)}</span>
        </span>
        <${ShimmerText} text=${headText} className="chain-summary-text" active=${!row.done} />
      </button>`
    : null // 没有可折内容（`hasExternalProcess`/`inlineReasoning` 皆假）/ 按片路径（片自己的头）/ 四档里只有「完全展开」不折
    // ⚠️ 2026-10-12 更正：这里原先还写着「只含提问行」与「『标准』下的已完成回合」两种情形，**两者都已不成立**：
    // 前者见文件头（`noFold` 2026-10-02 已撤）；后者是插件两档时代的说法 —— 四档里 `standard` 与 `compact`
    // 的策略列相同（`foldCompletedTurns: true` + `stepGrouping: 'collapsed'`），不折的只有 `verbose`
    // （`false` + `'none'`；映射在）。

  /**
   * 明细里实际渲染的项（整回合路径）。
   *
   * 折叠时**只藏过程成员**（工具/思考/注入），步骤说明文字照旧渲染 —— 模型在步骤之间说的话属于
   * 回答内容（上游那些文本是独立回答节点，永远可见）。插件把它们混在链里，不单独取出来就会陪着
   * 工具一起消失（真机现象：「工具行之间的文字跑完就看不到了」）【2026-09-19 修】。
   *
   * **同一个序列原样过滤、不另放容器**：另起容器会丢掉「文字 ↔ 工具」的交错位置
   *（真机现象：折叠态下文字全跑到明细末尾，看着像次序坏了）。过滤保持相对位置，两处合起来不重不漏。
   */
  const plan = chainRenderPlan(chain, disclosure.detail)

  // **分组体**：有分组头（`folded`）且展开时，明细是要自己滚的那块（上游 `.body`）。
  // 不分组（verbose）时不封顶、不渐隐 —— 与上游 `expandedBody` 同。
  const groupBody = folded && open
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
  }, [groupBody, chain.length, row.done])
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

  /**
   * **终局态摘要行**（上游回合级过程控制节点：`已完成，用时 {d}` + 行尾一个 chevron + 下面一条细线）：
   * 形状取自真机截图（三张对照）：文案在左、chevron **紧贴文案之后**
   * （不是贴右边缘）、下一行是一条贯穿内容宽度的细线（`--dsh-hairline`）。
   * 文案按终局原因分档（正常收官「已完成」/ 被停止「已停止」/ `error`·`max-tokens` 不在此重复），
   * 判据在 `core/run-status.ts` 的 `doneStatusText()`；用时取本回合的 `turn-stats`
   * （`usageRaw.wallSec`，秒；动作条 ⏱ 弹窗同一份事实），没拿到就不带时长。
   * 未关闭时不渲染（运行态由左下角那行负责）。
   *
   * ⚠️ **折起时藏的是"过程区"，不是这一行**（2026-10-02 真机反馈后修正）：
   * 先前把 `hidden` 挂在整条 `.chain` 上 —— 折起后**这一行连同 chevron 一起消失**，
   * 用户既看不到摘要、也没有任何东西可点回来（真机现象：「点了之后箭头没了 / 只剩下……什么都看不到」）。
   * 上游折的是**过程区**、控制节点自己留着（`ChatGroupSeat` 的 `hidden` 在 seat 的内容上）。
   * 现在：`hidden` 挂 `.chain-body`，**这一行 + 细线始终在**（看起来 = "只剩这条线"）。
   */
  const wallSecOf = row.usageRaw?.['wallSec']
  /**
   * **已定稿回合的用时**：口径与上游**逐字同** —— `turn/end.time − turn/start.time`，下限 1 秒。
   *
   * 上游 ：
   *   `const elapsedMs = turn.start === undefined || turn.end === undefined ? undefined`
   *   `  : Math.max(1000, turn.end.time - turn.start.time)`
   * —— **两个节点缺一个就不显示时长**（label 退回「已完成」，没有「用时」那一段）。
   *
   * ⚠️ **2026-10-10 真机（左右对照，同一历史会话）**：插件显示「用时 11秒」、网页端「用时 12秒」。
   * 原因是这里原先另写了一条兜底 `row.timeMs − row.turnStartMs`，并**在两条都有时取小的** ——
   * 而那条兜底用的是**末条回答的时刻**（`render-plan.ts` 的 `timeMs = answer.time`，比 `turn/end` 早），
   * 于是它算出来总比真值小约一秒，取小的规则又让它每次都赢。上游没有这条兜底 → 两边必然不一致。
   * 现在**只认上游那一条**：窗口里缺 `turn/start` 时拿不到（网页端此时**同样**不显示用时，因为它的
   * `turn.start` 节点也不在窗口里）—— 宁可两边都不显示，也不要两边显示成不同的数。
   */
  const wallMs = typeof wallSecOf === 'number' ? Math.max(1000, Math.round(wallSecOf * 1000)) : undefined
  /**
   * **一个回合只有一个控制行**：控制块归谁由 `MessageList` 按**过滤后的可见行**算出来（`ownsHead`），
   * 这里只在**拥有它的那条行**上渲染「已完成 [, 用时 X]」。
   *
   * 为什么不能每条行各渲染一个：被插话切成多段行时，控制行会重复出现（真机现象是同一个回合
   * 底下连着两块「已完成 / 已完成分析」）。归属必须跟着**可见**内容走 —— 一条只有不可见注入的行
   * 不能把整个回合的控制块抢走。
   *
   * ⚠️ **空链也照出**（不再要求 `chain.length > 0`）：出现条件就是「回合已关闭」（上游控制节点
   * `turn/status === 'closed'` 即渲染，与有没有过程内容无关）。空链的回合有两种 —— 请求期就失败的、
   * 以及一次工具/思考都没有的纯文本回合 —— 上游这两种都看得见这一行。原先空链不出，等于把那两种回合的
   * 「已完成 / 已停止 / 处理失败」整格抹掉（真机对照 web 的差异之一）。
   */
  const doneLine = !ownsHead
    ? null
    : doneStatusText(row.done, row.status, wallMs)
  /**
   * **控制节点的三态**（0.2.0 起）：`canCollapse = foldable && hasContent && !alwaysOpen`；
   * 它真 → **有 chevron、可点**；假 → **按钮仍在、`disabled`、无 chevron**（是同一个 button）。
   * ⚠️ **片数不是条件**：单片回合只要 `hasContent` 为真，上游照样给 chevron。
   *
   * ⚠️ **2026-10-12 补上 `!interleavedInput` 这一项**（维护者截图：插件这颗 `^` 网页端**没有**）。
   * 上游 `hasContent` 是**两项之与**：
   *   `hasContent = !interleavedInput && (processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning)`
   * —— **过程区间里有人插过话的回合，`hasContent` 恒假 → 不给 chevron**（那一轮的过程本来就是
   * "永远展开"的：`alwaysOpen` 含 `hasInterleavedInput`），
   * 于是控制行是一颗 `disabled`、无箭头的按钮。插件此前只算了后半截，于是给"被插话的回合"也画了箭头 ——
   * 真机样本：会话 `54fdba8f` 回合 25（`turn/start` 之后还有一条 `source.kind === 'user'` 的
   * `user/message`「不要剩」，即插话），网页端该行**无箭头**、插件有。
   */
  const hasProcessContent =
    row.process !== undefined
    && row.process.hasInterleavedInput !== true
    && (row.process.hasExternalProcess === true || row.process.inlineReasoning === true)
  /**
   * 上游 `turnProcessAlwaysOpen()`：**只有**"未关闭"与 `aborted` / `error` 不能折。
   * ⚠️ 不能再宽：`forked` 这类分叉切点合成的收尾原因是**普通收官**（上游照常给 chevron）。
   */
  const alwaysOpen = row.interrupted === true || row.status === 'aborted' || row.status === 'error'
  /**
   * 可点 = `foldable && hasContent && !alwaysOpen`（上游那三项，**没有第四项**）。
   *
   * ⚠️ **2026-10-07 撤掉一条插件自造的第四项**：这里原来还挂着 `answerAnchorSeq !== null`
   *（当时的理由：「折叠动作的落点就是锚点世代，没有锚点可点」）。对着上游源码复核后确认那是**插件
   * 多出来的门** —— 上游那三项里没有任何"回答锚点"的要求，非锚点的回合**照样给 chevron**；
   * 而 `outerFold` 的落点本来就是 `answerStep ?? 0`（数字恒有），点击并不需要锚点。
   * 少这一条的真机表现（左右对照图）：**网页端「已完成，用时 45秒 ⌄」有箭头，插件没有**。
   */
  const canCollapse = row.done && compact && hasProcessContent && !alwaysOpen
  const toggleDone = (): void => {
    if (turn === undefined || !canCollapse) {
      return
    }
    if (!outer.hidden) {
      store.foldOuter?.(turn)
    } else {
      store.revealOuter?.(turn, turnCurrentStep ?? outer.answerStep)
    }
  }
  const doneBody = html`<span class="chain-done-text">${doneLine}</span>`
  /**
   * 控制行的**可点性与图标**（2026-10-11 **二次校正**，以网页端实测为准）。
   *
   * | 网页端 | 收起态 | 展开态 |
   * |---|---|---|
   * | `disabled` | false | **false**（`disabled={!canCollapse}`，**与开合无关**） |
   * | `data-open` | 无 | `"true"` |
   * | `aria-expanded` | `"false"` | `"true"` |
   * | chevron | **有** | **有**（靠 `[data-open] .chevron { rotate(180deg) }` 转过来） |
   * | `title` | **无** | **无** |
   *
   * ⚠️ **我上一轮在这里改错过一次**：当时量到的样本恰好是 `foldable=false` 的回合（`disabled=true`、
   * 无 chevron），我把它当成"展开态"，于是写下 `disabled=${!canCollapse || !collapsed}`、并把 chevron
   * 也 gate 在 `collapsed` 上 —— 结果**展开之后那颗按钮彻底不可点、也没有箭头，"收起"这个动作被删掉了**
   *（维护者截图："^展开后，没法收起了？？？？ 之前都是好好的啊"）。
   * 上游源码里 `disabled={!canCollapse}`、`canCollapse && <IconChevronDownOutlineRegular className={css.chevron}/>`
   * 两项都与 `open` 无关；`open` 只体现在 `data-open` 与那个旋转上。
   */
  const collapsed = outer.hidden
  const doneRow = doneLine === null
    ? null
    : html`<div class="chain-done" data-turn-done="true" data-turn-done-foldable=${canCollapse ? 'true' : undefined}>
        <button class="chain-done-btn" type="button" onClick=${toggleDone} disabled=${!canCollapse}
          data-open=${collapsed ? undefined : 'true'}
          aria-expanded=${hasProcessContent ? (collapsed ? 'false' : 'true') : undefined}>
          ${doneBody}
          ${canCollapse
            ? html`<span class="chain-done-chev" data-turn-done-chevron>${chevronGlyph(false)}</span>`
            : null}
        </button>
      </div>`

  // ⚠️ 空链的返回**必须**在所有 hook 之后（见上面 hook 区的注释）。
  // 「回合一条链都没有」（请求期就失败、或纯文本回合）**不是**整个不渲染的理由：控制行照出
  //（「处理失败」/「已停止」就在那一格），只有"既没有链、又不归我承控制行"时才真的什么都不画。
  if (chain.length === 0 && doneLine === null) {
    return null
  }

  /**
   * **外层折叠**的落点（⑧）：折起时给**整个过程区**挂 `hidden="until-found"`。
   *
   * ⚠️ **过程区包含各片的头**（2026-10-02 两张真机截图对照后修正）：
   *   · web 折起态 = 只有 `已完成，用时 15秒 ⌄` + 空白，**下面没有片的头**；
   *   · 我上一版把折的范围缩到"不含片头"，于是插件折起后还多显示一行 `向用户提出了问题` —— 不一致。
   * 结论：折的是**控制节点之外的全部过程内容**（各片头 + 各片明细都在里面），
   * **控制节点（这一行）+ 细线始终留在外面**（上一版修掉的那个 bug：折到整条链，连这行也藏了）。
   *
   * ⚠️ **两处必须手工接 DOM**（都用这一个 ref 回调，实测踩过）：
   *   · `hidden="until-found"`：`hidden` 是**布尔属性**，走 preact 的属性 diff 会被写成 `""`
   *     （诊断：字面量写法直接被丢弃、表达式写法得到空串）→ 属性值一丢，"可被网页查找唤出"就没了；
   *   · `beforematch`：preact 不认这个事件名（不挂监听）→ 用户搜到了内容却仍折着。
   * 所以：`setAttribute` / `addEventListener` 自己来，卸载时清掉。
   */
  // ⚠️ 外层折叠**只折内容、不折控件**（2026-10-11 修正）：`.chain-done` 那一行
  //（「已完成，用时 4分16秒 ⌄」）是**展开/收起这一回合内容的唯一入口**，它必须留在外面 ——
  // 我上一版把整行（`.turn-anchor`）都藏了，结果控件消失、用户没法展开（维护者当场指出）。
  // 落点因此是**内容容器**：行内的 `.chain-body`（过程片）+ 行内 `.body`（答句），
  // 两者都由 `MessageList` 的 `outerRowHidden` 判定后、经 `outerHidden` 传进来。
  const outerRef = (el: HTMLDivElement | null): void => {
    const previous = outerRefEl.current
    if (previous !== null) {
      previous.removeEventListener('beforematch', onBeforeMatch.current)
      if (previous !== el) previous.removeAttribute('hidden')
    }
    outerRefEl.current = el
    if (el === null) {
      return
    }
    if (outer.hidden) {
      el.setAttribute('hidden', HIDDEN_UNTIL_FOUND)
    } else {
      el.removeAttribute('hidden')
    }
    el.addEventListener('beforematch', onBeforeMatch.current)
  }
  /**
   * 行内**答句正文**（`.body`）的折叠落点在 `AssistantRow` 里（`answerRef`）—— 这里不再重复一份。
   * 两处都折同一个 `outer.hidden`：`.chain-body`（过程）+ `.body`（答句），
   * 而控件 `.chain-done` 留在外面可点。
   */
  // **按片**：每片走子组件（各自的头/明细/计时/滚动边），边界文本渲染在相邻两片**之间**（永远可见）。
  // **各片头 + 明细都在 `.chain-body` 里**（外层折起时一起藏 —— 与 web 折起态一致）；终局行在外。
  // 「已停止」药丸（`stoppedPill`）**只挂最后一片的明细末尾**（上游那个药丸长在该步自己的正文块上，
  // 而这一步没有正文时那个块本身就是这一片的成员 → 落在分组框里面；见 `AssistantRow` 的分派）。
  // 最终形态：节点模型下发的成员表分组（每组 = 该片成员链项 + 该片折叠事实）。
  if (nodeGrouped) {
    const chainByKey = new Map(chain.map((c) => [c.key, c]))
    const lastGroupAt = row.nodeGroups!.length - 1
    return html`<div class="chain" ...${seatAttr}>
      ${doneRow}
      <div class="chain-body" ref=${outerRef}>
        ${row.nodeGroups!.map((g, index) => {
          const items = g.itemKeys.map((k) => chainByKey.get(k)).filter((c): c is DshTurnProcessItem => c !== undefined)
          return html`<${ProcessGroup} key=${g.key} row=${row} store=${store}
              group=${{ key: g.key, facts: g.facts }} items=${items}
              outerHidden=${outer.hidden}
              tail=${index === lastGroupAt ? stoppedPill : null}
              prefs=${{ compact, grouping, liveProcessDetail: store.liveProcessDetail?.value }} />`
        })}
      </div>
    </div>`
  }
  if (grouped) {
    const lastGroupAt = groupPlan.entries.reduce((at, entry, index) => (entry.kind === 'group' ? index : at), -1)
    return html`<div class="chain" ...${seatAttr}>
      ${doneRow}
      <div class="chain-body" ref=${outerRef}>
        ${groupPlan.entries.map((entry, index) =>
          entry.kind === 'group'
            ? html`<${ProcessGroup} key=${entry.key} row=${row} store=${store}
                group=${{ key: entry.key, facts: entry.facts }} items=${entry.items}
                outerHidden=${outer.hidden}
                tail=${index === lastGroupAt ? stoppedPill : null}
                prefs=${{ compact, grouping, liveProcessDetail: store.liveProcessDetail?.value }} />`
            : chainProcText(entry.item))}
      </div>
    </div>`
  }

  // 整回合路径：**折叠头也属于过程区**（折起时它跟着藏，与 web 同）—— 只有终局行留在外面。
  return html`<div class="chain" ...${seatAttr}>
    ${doneRow}
    <div class="chain-body" ref=${outerRef}>
      ${head}
      ${chainDetailBody({ items: plan.items, bodyRef, groupBody, edges, done: row.done, store, tail: stoppedPill })}
    </div>
  </div>`
}
