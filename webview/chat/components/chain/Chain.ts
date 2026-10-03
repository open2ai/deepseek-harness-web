// 过程链（Chain）：**按片**（上游 step-group）渲染 —— 每片一个「过程分组标题 + 折叠控制」头。
// **文案按上游 `processTitle()`**：取该片前三类活动的本地化名称（如「已读取文件并读取图片」），
// **不带计数**；没有工具调用时是「已完成分析」。进行中则用进行时文案（「正在读取文件」）。
// **折叠头出现的条件由偏好里的两列共同决定**（0.2.0 起）：
//   进行中 → 只有 `stepGrouping === 'collapsed'`（compact/standard 档）出分组头，默认展开着看过程在动；
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
// 例外：只含提问行(ask)时整回合/整片不折叠，平铺显示问行（见 docs/design/06 §4）。
import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
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
import { chainDetailBody, chainRenderPlan, HIDDEN_UNTIL_FOUND, outerFold, reasoningLive } from './plan'
import { doneStatusText } from '../../core/run-status'

// 两项纯判据的实现在 `./plan`（Chain 与 ProcessGroup 共用同一份）；这里**原样再导出**：
// 两者都被守卫直接断言（`tmp/_rows.render.test.mjs` 取 `reasoningLive`、`_chain.render.test.mjs` 取
// `chainRenderPlan`），入口别换。
export { chainRenderPlan, reasoningLive }

type AssistantRow = Extract<ChatRow, { kind: 'assistant' }>

export function Chain({ row, store, ownsHead, noFold, soleRow }: { row: AssistantRow; store: ChatStore; ownsHead: boolean; noFold: boolean; soleRow?: boolean }) {
  const chain = row.chain
  // 上游显示偏好（控制已完成轮次的过程内容）；未知/未到 = compact，即接入前的固有形态
  const compact = store.transcriptView.value === 'compact'
  // 展开态是**回合级**的（整回合路径：同回合多段行共用；上游按 (turn, answerStep) 持久化）。
  // 未记录 = 默认：进行中展开（能实时看过程在动）、定稿收起。
  // **按片路径不用它**（各片有自己的键 `${turn}:${group.key}`，见 `ProcessGroup`）—— 那道回合级
  // 控制属于"整回合一条头"的形态，随片化的头一起退出；外层折叠是另一步（见 14 §进度 ⑧）。
  const turn = row.turn
  const stored = turn === undefined ? undefined : store.turnFoldOpen.value.get(turn)
  // 分组体的滚动状态（上游 `useProcessScroll` 的边判定部分）：`up/down` = 两端还看不看得见内容。
  // ⚠️ 这些 hook 必须在**任何提前返回之前**声明（preact 按调用顺序配 hook），所以本组件把
  // `chain.length === 0` 的返回挪到了所有 hook 之后 —— 别把那个 return 挪回来。
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const pendingInit = useRef<'top' | 'bottom' | null>(null)
  const [edges, setEdges] = useState<ScrollEdges>({ up: false, down: false })
  const open = stored ?? !row.done
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
  const groupEntries = groupPlan.entries.filter((entry) => entry.kind === 'group')

  // **外层折叠**（⑧，上游 `ChatGroupSeat` 的 `outerHidden`/`revealOuter`；判据在 `./plan`）：
  // 已关闭的回合只留**当前回答世代**那一片可见，更早的世代整片折起（`hidden="until-found"`，可被查找唤出）。
  // `stored` 缺省 = 没记录 → 折起（与上游一致：历史回合默认只看得见最后一个世代）。
  const outer = outerFold({
    foldCompleted: compact,
    done: row.done,
    // 被插话切开 = 多条行；跨行折会藏掉用户正在看的段落（等价上游 `hasInterleavedInput`）
    soleRow: soleRow !== false,
    hasProcess: row.process !== undefined,
    answerStep: row.process?.answerStep ?? undefined,
    storedAnswerStep: turn === undefined ? undefined : store.outerAnswerStep?.value.get(turn),
    // 上游 `turnProcessAlwaysOpen()` 的两个"非正常收官"：**只有** aborted / error。
    // （`forked` / `interrupted` 等一律当普通收官 —— 2026-10-02 按 tag 更正，见下面的注释）
    interrupted: row.interrupted === true || row.status === 'aborted' || row.status === 'error',
    sliceCount: groupEntries.length,
  })
  /** 用户唤出（网页查找命中 `beforematch`）→ 记下"已唤出到当前世代"。 */
  const revealOuter = (): void => {
    if (turn !== undefined) store.revealOuter?.(turn, outer.answerStep)
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
    grouping: store.stepGrouping?.value,
    open,
    ownsHead,
    noFold,
    // 窗口就绪的最后一条门（上游 0.2.0：per-Turn 的 `turnStarted || turnClosed`）：
    // 窗口里有本回合的 `turn/start` 就算就绪；没有它则靠 `done`（= `turnClosed`）。
    // **历史分页截断不是不折叠的理由**（旧版那道 `historyIncomplete` 上游已删）。
    turnStarted: row.process?.turnStarted === true,
  })
  // 按片路径下**整回合这道头不渲染**："片数 = 头数"是 B′ 的验收判据（14 §4）—— 多一个回合级头就多一个
  // 控制点，且与片头语义重叠（一个开合整个回合、一个开合片内）。片自己的头就是本回合的控制。
  const folded = disclosure.head && !grouped
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
    : null // 只含提问行 / 进行中 / 「标准」下的已完成回合 / 按片路径：无整回合折叠头，明细平铺

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
   * 形状取自真机截图（`tmp/版本差异记录/…/03` §3.1 的那三张）：文案在左、chevron **紧贴文案之后**
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
  const doneLine = chain.length === 0
    ? null
    : doneStatusText(row.done, row.status, typeof wallSecOf === 'number' ? wallSecOf * 1000 : undefined)
  /**
   * **控制节点（上游 `TurnProcessNodeView`）的三态**，逐字对齐 0.2.0-rc.2：
   *
   * ```tsx
   * const canCollapse = turnProcess.foldable && turnProcess.hasContent && !turnProcessAlwaysOpen(node)
   * // turnProcessAlwaysOpen = 未关闭 || reason === 'aborted' || reason === 'error'
   * disabled={!canCollapse}
   * aria-expanded={turnProcess.hasContent ? open : undefined}
   * {canCollapse && <IconChevronDownOutlineRegular className={css.chevron} />}
   * ```
   *
   * 于是：
   *   · `canCollapse` 真 → **有 chevron、可点**；
   *   · 假 → **按钮仍在、`disabled`、无 chevron**（不是"换成一个纯文本 span"，上游是同一个 button）。
   * ⚠️ **片数不是条件**（我上一轮误加了 `片数 > 1`，真机反馈"没有箭头可点"就是它）：
   * 单片回合只要 `hasContent` 为真，上游照样给 chevron —— 点下去藏的是那一片过程区。
   * 这里 `hasContent` 用 `outerFold` 的输入等价物：过程事实说"有过程内容"（`hasExternalProcess`
   * 或真的留下思考行的 `inlineReasoning`），且偏好是紧凑档（非紧凑档本来就不折，见 `process-fold.ts`）。
   */
  const hasProcessContent =
    row.process !== undefined && (row.process.hasExternalProcess === true || row.process.inlineReasoning === true)
  /**
   * 上游 `turnProcessAlwaysOpen()`：**只有**"未关闭"与 `aborted` / `error` 不能折。
   *
   * ⚠️ 2026-10-02 更正：此前写成"`status` 有值就不能折"——**太宽**。真机现象：点「在新对话中分支」后，
   * 分叉切点合成的 `turn/end.reason.kind = 'forked'` 让这一行**没有箭头**，而 web 端有
   * （上游把它当普通收官：文案 `已完成`、`canCollapse` 照常为真）。
   */
  const alwaysOpen = row.interrupted === true || row.status === 'aborted' || row.status === 'error'
  const canCollapse = row.done && compact && hasProcessContent && !alwaysOpen
  const toggleDone = (): void => {
    if (turn === undefined || !canCollapse) {
      return
    }
    if (!outer.hidden) {
      store.foldOuter?.(turn)
    } else {
      store.revealOuter?.(turn, outer.answerStep)
    }
  }
  const doneBody = html`<span class="chain-done-text">${doneLine}</span>`
  const doneRow = doneLine === null
    ? null
    : html`<div class="chain-done" data-turn-done="true" data-turn-done-foldable=${canCollapse ? 'true' : undefined}>
        <button class="chain-done-btn" type="button" onClick=${toggleDone} disabled=${!canCollapse}
          aria-expanded=${hasProcessContent ? String(!outer.hidden) : undefined}
          title=${canCollapse ? (outer.hidden ? '展开过程详情' : '收起过程详情') : undefined}>
          ${doneBody}
          ${canCollapse
            ? html`<span class="chain-done-chev" data-turn-done-chevron>${chevronGlyph(!outer.hidden)}</span>`
            : null}
        </button>
        <div class="chain-done-rule" aria-hidden="true"></div>
      </div>`

  // ⚠️ 空链的返回**必须**在所有 hook 之后（见上面 hook 区的注释）
  if (chain.length === 0) {
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

  // **按片**：每片走子组件（各自的头/明细/计时/滚动边），边界文本渲染在相邻两片**之间**（永远可见）。
  // **各片头 + 明细都在 `.chain-body` 里**（外层折起时一起藏 —— 与 web 折起态一致）；终局行在外。
  if (grouped) {
    return html`<div class="chain">
      ${doneRow}
      <div class="chain-body" ref=${outerRef}>
        ${groupPlan.entries.map((entry) =>
          entry.kind === 'group'
            ? html`<${ProcessGroup} key=${entry.key} row=${row} store=${store}
                group=${{ key: entry.key, facts: entry.facts }} items=${entry.items}
                prefs=${{ compact, grouping: store.stepGrouping?.value, liveProcessDetail: store.liveProcessDetail?.value }} />`
            : html`<div class="chain-proc-text" key=${entry.item.key}>${entry.item.text}</div>`)}
      </div>
    </div>`
  }

  // 整回合路径：**折叠头也属于过程区**（折起时它跟着藏，与 web 同）—— 只有终局行留在外面。
  return html`<div class="chain">
    ${doneRow}
    <div class="chain-body" ref=${outerRef}>
      ${head}
      ${chainDetailBody({ items: plan.items, bodyRef, groupBody, edges, done: row.done, store })}
    </div>
  </div>`
}
