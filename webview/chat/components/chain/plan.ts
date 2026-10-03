// 过程链的**渲染计划与逐项渲染** —— 从 `Chain.ts` 抽出来共享（`Chain` 与按片的 `ProcessGroup` 都要用）。
//
// 为什么抽出来：B′ 的按片渲染里，"一片的明细"与"整回合的明细"必须画出**同一棵树**
//（思考行 live 判据、注入行可见性、过程文本元素与样式都只有一份）。复制一份到一个新组件里
// 迟早分叉 —— 这里只搬不复制。
import { html } from 'htm/preact'
import type { Ref } from 'preact'
import type { ChatStore, DshTurnProcessItem } from '../../core/store/chat'
import { isVisibleContextItem } from '../../core/chat-visibility'
import type { ScrollEdges } from '../../core/scroll-edges'
import { ContextInjectionRow } from '../message/ContextInjectionRow'
import { ReasoningRow } from './ReasoningRow'
import { ToolRow } from './ToolRow'

/** 一行里的链（顺序即渲染顺序）。 */
export type ChainLike = readonly DshTurnProcessItem[]

/**
 * 思考行是否处于「活跃」（收起摘要跟随最新一行）。
 *
 * **判据不能用 `row.bodyStarted`**：切到「宿主下发行」这条渲染通路之后，页面侧的行由
 * `host-rows.ts` 映射而来，那里**恒填 `bodyStarted: true`**（旧指令通路退役时的遗留），
 * 用它算 live 会永远为假 —— 表现为思考行的收起摘要不再跟随最新一行【2026-09-19 修】。
 * 真正的事实是「回合还没结束 + 这是最后一条思考」。
 */
export function reasoningLive(row: { done: boolean }, idx: number, lastReasonIdx: number): boolean {
  return !row.done && idx === lastReasonIdx
}

/** 链里最后一条思考行的下标（没有则 −1）。 */
export function lastReasoningIndex(chain: ChainLike): number {
  let last = -1
  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i].kind === 'reasoning') last = i
  }
  return last
}

/**
 * 链的渲染计划：**组件只按它渲染**（把「哪些项看得见」抽成纯函数，脚本可逐形状断言）。
 *
 * 规则：展开 → 链上全部项照序渲染；折叠 → **只藏过程成员**（工具/思考/注入），步骤说明文字留在原处。
 * 不用「文本另放一个常显容器」的写法：那会丢掉文字与工具的交错位置（真机现象：折叠态下文字全跑到末尾）。
 */
export function chainRenderPlan<T extends DshTurnProcessItem>(
  chain: readonly T[],
  detailVisible: boolean
): { items: T[]; hidden: T[] } {
  if (detailVisible) {
    return { items: [...chain], hidden: [] }
  }
  const items: T[] = []
  const hidden: T[] = []
  for (const item of chain) {
    if (item.kind === 'text') {
      items.push(item)
    } else {
      hidden.push(item)
    }
  }
  return { items, hidden }
}

/**
 * 把一个链项渲染成 vnode（`null` = 该项按可见性规则不显示）。
 *
 * @param item - 链上的一项。
 * @param index - **在整条链上的下标**（判定"是否最后一条思考"用；传片内下标即可，只要 `lastReasonIdx` 同基准）。
 * @param ctx - 本回合是否已定稿、最后一条思考的下标、store。
 */
export function chainItemNode(
  item: DshTurnProcessItem,
  index: number,
  ctx: { done: boolean; lastReasonIdx: number; store: ChatStore }
): unknown {
  if (item.kind === 'reasoning') {
    const live = reasoningLive({ done: ctx.done }, index, ctx.lastReasonIdx)
    // 预览门（上游 `ReasoningRow`：`running || policy.settledReasoningPreview`）：
    // **进行中的思考行照常预览**（与 `liveProcessDetail` 无关 —— 那是分组头实时细节的门）；
    // 已定稿的才看 `settledReasoningPreview`。
    const showPreview = live || ctx.store.settledReasoningPreview?.value !== false
    return html`<${ReasoningRow} key=${item.key} item=${item} live=${live} showPreview=${showPreview} />`
  }
  if (item.kind === 'context') {
    // **聊天区可见性按上游 0.1.7-alpha.1 起的口径**：普通上下文注入（召回 / 技能目录 / 快照 / notice…）
    // **不进聊天区**；只有含工具增删块的那一类保留（工具变更通知行）。判据在 `core/chat-visibility.ts`
    //（与行的过滤同一份规则）。只在**渲染层**过滤：折叠头的存在与否由宿主的「有外部过程 / 内联思考」
    // 事实决定，与注入无关（上游 `hasContent` 同样不算注入），所以不会出现"折叠头在、展开是空的"。
    if (!isVisibleContextItem(item)) return null
    return html`<${ContextInjectionRow} key=${item.key} item=${item} />`
  }
  if (item.kind === 'text') {
    // 非回答步的说明文字（上游那些是**独立的回答节点**，永远可见）：折叠时由 `chainRenderPlan`
    // 保留在明细里（与工具交错的原位），片间边界也用它渲染同一个元素/样式。
    return html`<div class="chain-proc-text" key=${item.key}>${item.text}</div>`
  }
  return html`<${ToolRow} key=${item.key} item=${item} store=${ctx.store} />`
}

/**
 * **外层折叠**（上游 `ChatGroupSeat.tsx` 的 `outerHidden` / `alwaysOpen`）：同一回合里，
 * 只有"**当前回答世代**"那一片可见，更早的世代整片隐藏（用 `hidden="until-found"`
 * —— 仍可被网页查找命中，命中即由 `beforematch` 唤出，见 `Chain.ts`）。
 *
 * 上游判据（`13` §3 逐字）：
 * `outerHidden = foldCompletedTurns && 回合已关闭 && spec 存在 && !alwaysOpen && stored?.answerStep !== (spec.answerStep ?? 0)`
 *
 * 三处按插件事实落地：
 *   · `foldCompletedTurns` = 页面偏好 `compact`（`transcriptView` 的紧凑/标准/详细三档都为真）；
 *   · `stored?.answerStep` = `store.outerAnswerStep`（**回合级**一份，`revealOuter` 记新的世代）；
 *   · `alwaysOpen` 的两个"不是正常收官"的条件用 `status`（报错/中断/停止）与 `interrupted` 代替
 *     （宿主只在**非 completed** 的收尾原因上带 `status`，见 `core/turn-copy.ts` 的口径）。
 *
 * ⚠️ **只在同一行内生效**：被插话切开的回合是多条行（上游是同一个 seat），跨行折会藏掉
 * 用户当下正在看的段落 —— 所以行数 > 1 时整支关闭（等价上游的 `hasInterleavedInput`）。
 * 展开态、`answerStep`、`alwaysOpen` 的完整对照见 `14` §7。
 *
 * @param input - 本回合的折叠偏好与事实。
 * @returns `hidden` = 是否折起（只留当前世代），`answerStep` = 当前世代（唤出时要记的值），`revealed` = 本回合用户已唤出过。
 */
export function outerFold(input: {
    /** 页面偏好 `foldCompletedTurns`（= `compact`） */
    foldCompleted: boolean
    /** 本回合是否已关闭 */
    done: boolean
    /** 本行是不是本回合的**唯一**一行（多行 = 被插话切开 → 不折） */
    soleRow: boolean
    /** 宿主下发的过程事实（`spec` 不存在 = 没有过程证据 → 不折） */
    hasProcess: boolean
    /** 本行的回答世代 */
    answerStep: number | undefined
    /** 用户已唤出的世代（`undefined` = 没有记录） */
    storedAnswerStep: number | undefined
    /** `alwaysOpen` 的输入：回合未正常收官（`status` 有值）或消息被中断 */
    interrupted: boolean
    /** 回合计入外层折叠是否 ≤ 1 片（单片时折与不折没有区别） */
    sliceCount: number
}): { hidden: boolean; answerStep: number; revealed: boolean } {
    const answerStep = input.answerStep ?? 0
    const revealed = input.storedAnswerStep === answerStep
    const alwaysOpen = input.interrupted || !input.soleRow
    // ⚠️ **不再要求"片数 > 1"**（2026-10-02 对齐上游 `TurnProcessNodeView`）：上游折不折只看
    // `foldable && hasContent && !alwaysOpen` —— 单片回合同样折（折起后只剩那条摘要行 + 细线）。
    // 这条"片数 > 1"是我早先自己加的，真机反馈「没有箭头可点击」正是它（`14` §21）。
    const hidden =
        input.foldCompleted &&
        input.done &&
        input.hasProcess &&
        !alwaysOpen &&
        !revealed
    return { hidden, answerStep, revealed }
}

/**
 * 隐藏的那一片要挂的属性（上游用 `hidden="until-found"`：**不渲染但可被查找命中**）。
 *
 * 单独抽一个常量：`until-found` 的拼写错一个字母就会退化成"彻底隐藏、搜也搜不到"（内容等于丢了），
 * 所以让它成为**可断言**的形状（守卫直接比这个常量）。
 */
export const HIDDEN_UNTIL_FOUND = 'until-found'

/**
 * 过程明细体（`.chain-detail`）的 vnode —— 整回合路径与按片路径**共用这一份**。
 *
 * 为什么必须共用：这个元素既是布局（`display:flex` 的明细列），又是**滚动容器**
 *（`data-group-body` 封顶 + 两端渐隐 `data-scroll-*`）。两条路径各写一遍的话，渐隐判据
 * 与"哪一端还有内容"的属性名迟早分叉 —— 守卫只钉得住其中一条。
 *
 * @param props.items - 本次要渲染的链项（已由 `chainRenderPlan` 过滤）。
 * @param props.bodyRef - 明细体的 DOM 引用（调用方各自算滚动边）。
 * @param props.groupBody - 是否按"分组体"渲染（封顶 + 自己滚）。
 * @param props.edges - 两端还有没有内容（`core/scroll-edges.ts`）。
 * @param props.done - 本回合是否已定稿（思考行 live 判据用）。
 * @param props.store - 页面 store。
 */
export function chainDetailBody({ items, bodyRef, groupBody, edges, done, store }: {
  items: readonly DshTurnProcessItem[]
  bodyRef: Ref<HTMLDivElement>
  groupBody: boolean
  edges: ScrollEdges
  done: boolean
  store: ChatStore
}): unknown {
  if (items.length === 0) return null
  const lastReasonIdx = lastReasoningIndex(items)
  return html`<div class="chain-detail" ref=${bodyRef}
    data-group-body=${groupBody ? 'true' : undefined}
    data-scroll-up=${groupBody && edges.up ? 'true' : undefined}
    data-scroll-down=${groupBody && edges.down ? 'true' : undefined}>${items.map((item, index) =>
      chainItemNode(item, index, { done, lastReasonIdx, store }))}</div>`
}
