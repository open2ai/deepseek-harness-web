// 过程链（Chain）：`N 次工具调用 · M 条消息` 是**外层折叠**（点它展开/收起过程明细）。
// **折叠头只出现在「紧凑 + 已完成」**（`turnClosed` 门控：折叠只发生在回合关闭之后）：
//   进行中 → 无折叠头，过程行直接平铺（能实时看思考/工具在动；两种显示形态下都一样）；
//   已完成 + 紧凑 → 收起成折叠头，点开看明细（注入/思考/工具/web/提问卡 平铺）；
//   已完成 + 标准 → 不折叠，过程行平铺（上游「控制已完成轮次的过程内容」的另一取值）。
// 链里有任何过程内容(工具/思考/上下文注入/召回/计数) 才出折叠头；计数全为 0 时文案兜底「已思考」。
// **纯思考同样出折叠头**——上游 foldable 对「有过程成员」成立，与「N 次工具调用」是同一套折叠，
// 不是平铺；定稿后思考行同样收进折叠里。
// **折叠头是回合级的**：一个回合只有一个（由本回合首行渲染，`ownsHead`），被它收起来的是整个回合
// 过程区间里的成员 —— 插话把回合切成多段行时，**各段共用同一个展开态**（上游只有 `turn-process`
// 那一个控制节点）。例外：只含提问行(ask)时整回合不折叠，平铺显示问行（见 docs/design/06 §4）。
import { html } from 'htm/preact'
import type { ChatRow, DshTurnProcessItem, ChatStore } from '../../core/store/chat'
import { processDisclosure } from '../../core/process-fold'
import { ReasoningRow } from './ReasoningRow'
import { ToolRow } from './ToolRow'
import { ContextInjectionRow } from '../message/ContextInjectionRow'

type AssistantRow = Extract<ChatRow, { kind: 'assistant' }>

/**
 * 思考行是否处于「活跃」（收起摘要跟随最新一行）。
 *
 * **判据不能用 `row.bodyStarted`**：切到「宿主下发行」这条渲染通路之后，页面侧的行由
 * `host-rows.ts` 映射而来，那里**恒填 `bodyStarted: true`**（旧指令通路退役时的遗留），
 * 用它算 live 会永远为假 —— 表现为思考行的收起摘要不再跟随最新一行【2026-09-19 修】。
 * 真正的事实是「回合还没结束 + 这是最后一条思考」。
 */
export function reasoningLive(row: Pick<AssistantRow, 'done'>, idx: number, lastReasonIdx: number): boolean {
  return !row.done && idx === lastReasonIdx
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

export function Chain({ row, store, ownsHead, noFold }: { row: AssistantRow; store: ChatStore; ownsHead: boolean; noFold: boolean }) {
  const chain = row.chain
  // 上游显示偏好（控制已完成轮次的过程内容）；未知/未到 = compact，即接入前的固有形态
  const compact = store.transcriptView.value === 'compact'
  // 展开态是**回合级**的（同回合多段行共用；上游按 (turn, answerStep) 持久化）。
  // 未记录 = 默认：进行中展开（能实时看过程在动）、定稿收起。
  const turn = row.turn
  const stored = turn === undefined ? undefined : store.turnFoldOpen.value.get(turn)
  const open = stored ?? !row.done
  const setOpen = (next: boolean): void => {
    if (turn !== undefined) store.setTurnFoldOpen(turn, next)
  }
  if (chain.length === 0) return null

  // 链内的实际工具数（ask 提问除外 —— 其交互在 waterfall 弹窗）：折叠**文案**的兜底要用它
  const chainToolCount = chain.filter((c) => c.kind === 'tool' && c.name !== 'ask_user_question').length

  // 折叠计数：定稿用宿主 counts；进行中用链内实际工具数(实时)。
  // 但「停止」是宿主本地合成的完成帧、**不带上游计数**（counts 仍为 0），此时必须回落到链内实际数——
  // 否则明明跑了工具却兜底成「已思考」。
  // 三项顺序与上游一致：工具调用 → 条消息 → subagent；全为 0 兜底「已思考」。
  const parts: string[] = []
  const toolCount = row.done && row.counts.toolCallCount > 0 ? row.counts.toolCallCount : chainToolCount
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  if (row.counts.messageCount > 0) parts.push(`${row.counts.messageCount} 条消息`)
  if (row.counts.subagentCount > 0) parts.push(`${row.counts.subagentCount} 个 subagent`)
  const foldLabel = parts.length > 0 ? parts.join(' · ') : '已思考'

  // 活跃 reasoning = 最后一条 reasoning 且本回合还没结束（live 内滚跟随最新；判据见 reasoningLive）
  let lastReasonIdx = -1
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].kind === 'reasoning') lastReasonIdx = i
  }
  // 每帧都会重建这份 vnode 列表：**非活跃**的思考行不跟随「谁是最后一条」变化，
  // `live` 传 false 让它与上一帧同参 → 组件层跳过重渲（见 ReasoningRow 的 memo）。
  const itemNode = (item: DshTurnProcessItem, idx: number): unknown => {
    if (item.kind === 'reasoning') {
      const live = reasoningLive(row, idx, lastReasonIdx)
      return html`<${ReasoningRow} key=${item.key} item=${item} live=${live} />`
    }
    if (item.kind === 'context') {
      // 系统提示词(agent-instructions, form==='instructions')→左上角常驻，不入链；其余注入(召回/技能/插件)保留
      if (item.form === 'instructions') return null
      return html`<${ContextInjectionRow} key=${item.key} item=${item} />`
    }
    if (item.kind === 'text') {
      // 非回答步的说明文字。展开时留在链里的原位（保持与工具/思考的交错），折叠时改由
      // 常显容器渲染（见 `chainRenderPlan`）—— 两处只渲染一次，不重复。
      return html`<div class="chain-proc-text" key=${item.key}>${item.text}</div>`
    }
    return html`<${ToolRow} key=${item.key} item=${item} store=${store} />`
  }

  // 折叠门控：判据链在 `core/process-fold.ts`（上游同口径），组件只按结果渲染。
  // 上游对「2 次工具调用 + 已停止」的回合照样折叠 —— 只要**末步有回答内容且已定稿**。
  const disclosure = processDisclosure({
    done: row.done,
    process: row.process,
    compact,
    open,
    ownsHead,
    noFold,
  })
  const folded = disclosure.head
  const head = folded
    ? html`<button class="chain-summary" onClick=${() => setOpen(!open)} aria-expanded=${open}>
        <span class="chain-summary-ico codicon codicon-sparkle"></span>
        <span class="chain-summary-text">${foldLabel}</span>
        <span class=${'codicon chain-summary-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
      </button>`
    : null // 只含提问行 / 进行中 / 「标准」下的已完成回合：无折叠头，明细平铺

  /**
   * 明细里实际渲染的项。
   *
   * 折叠时**只藏过程成员**（工具/思考/注入），步骤说明文字照旧渲染 —— 模型在步骤之间说的话属于
   * 回答内容（上游那些文本是独立回答节点，永远可见）。插件把它们混在链里，不单独取出来就会陪着
   * 工具一起消失（真机现象：「工具行之间的文字跑完就看不到了」）【2026-09-19 修】。
   *
   * **同一个序列原样过滤、不另放容器**：另起容器会丢掉「文字 ↔ 工具」的交错位置
   *（真机现象：折叠态下文字全跑到明细末尾，看着像次序坏了）。过滤保持相对位置，两处合起来不重不漏。
   */
  const plan = chainRenderPlan(chain, disclosure.detail)

  return html`<div class="chain">
    ${head}
    ${plan.items.length > 0 ? html`<div class="chain-detail">${plan.items.map(itemNode)}</div>` : null}
  </div>`
}
