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

  // 活跃 reasoning = 最后一条 reasoning 且正文未开始（live 内滚跟随最新）
  let lastReasonIdx = -1
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].kind === 'reasoning') lastReasonIdx = i
  }
  const itemNode = (item: DshTurnProcessItem, idx: number): unknown => {
    if (item.kind === 'reasoning') {
      return html`<${ReasoningRow} key=${item.key} item=${item} live=${!row.done && !row.bodyStarted && idx === lastReasonIdx} />`
    }
    if (item.kind === 'context') {
      // 系统提示词(agent-instructions, form==='instructions')→左上角常驻，不入链；其余注入(召回/技能/插件)保留
      if (item.form === 'instructions') return null
      return html`<${ContextInjectionRow} key=${item.key} item=${item} />`
    }
    if (item.kind === 'text') {
      // 非回答步的输出文本：上游是独立的回答节点，插件放进过程链 —— 不显示的话中间步的正文就丢了
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

  // 折叠时点开才看明细；其余（只含提问行 / 进行中 / 「标准」下的已完成回合）明细恒展。
  // 同回合的每一行都跟随同一个展开态 —— 折叠头只在本回合首行上。
  const detailVisible = disclosure.detail

  return html`<div class="chain">
    ${head}
    ${detailVisible ? html`<div class="chain-detail">${chain.map(itemNode)}</div>` : null}
  </div>`
}
