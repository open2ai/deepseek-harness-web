// 消息列表（按行类型分发）：用户/assistant/审批/提问/notice。智能跟随滚动。
import { html } from 'htm/preact'
import { useEffect, useRef } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { UserRow } from './UserRow'
import { AssistantRow } from './AssistantRow'
import { ApprovalRow } from './ApprovalRow'
import { QuestionRow } from './QuestionRow'
import { NoticeRow } from './NoticeRow'
import { ContextInjectionRow } from './ContextInjectionRow'
import { SysPromptRow } from './SysPromptRow'
import { TurnStatus } from './TurnStatus'
import { PendingSteeringList } from './PendingSteeringRow'

/**
 * 「读者是否移动了滚动」—— 浏览器把 `scrollTop` 收缩钳制、以及程序性写入，都**不转移滚动归属**：
 * 只有实际位置与「记录位置被钳制后」的值差超过 0.5px 才算读者移动。
 * 少了这一条，内容被整表替换时浏览器夹小 `scrollTop` 会被误判成「用户向上拖」而解除跟随。
 */
export function readerMovedScroll(top: number, floor: number, observedTop: number): boolean {
  return Math.abs(top - Math.min(observedTop, floor)) > 0.5
}

export function MessageList({ store }: { store: ChatStore }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // 是否粘在底部：只由**读者手势**与显式的「到底」请求改变
  const stickRef = useRef(true)
  // 最后一次**写入或观测到**的位置：判断「读者是否移动」的基准
  const observedTopRef = useRef(0)
  // 上次的**内容高度**：跟随只在它变化时发生。
  // 用高度而不是「行签名」：行签名会漏掉「不是末行在长」的情况（工具卡展开、中间行变高），
  // 而整表替换只要内容没变，高度就不变 —— 于是替换不会把正在翻阅的读者拽回底部。
  const lastHeightRef = useRef(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 显式的「到底」请求（发送时）：唯一该**强制**滚到底的入口
    if (store.scrollPend.value > 0) {
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      lastHeightRef.current = el.scrollHeight
      store.scrollPend.value = 0
      stickRef.current = true
      return
    }
    if (el.scrollHeight === lastHeightRef.current) return
    lastHeightRef.current = el.scrollHeight
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
    }
  })

  if (store.view.value !== 'chat') return null
  const rows = store.messages.value
  // 过程折叠是**回合级**的（见 core/process-fold）：同一回合可能有多条回答行（插话切成「前段 / 后段」），
  // 只有**首行**出折叠头，其余行跟随同一个展开态。这里先按回合归组算好，再逐行下发。
  // 没有回合号的（本地乐观行）自成一组：它没有过程事实，本来也不会折叠。
  const turnHeadRow = new Map<number, Extract<ChatRow, { kind: 'assistant' }>>()
  for (const row of rows) {
    if (row.kind === 'assistant' && row.turn !== undefined && !turnHeadRow.has(row.turn)) {
      turnHeadRow.set(row.turn, row)
    }
  }
  return html`<div id="messages" ref=${ref}
    onScroll=${() => {
      const el = ref.current
      if (!el) return
      const floor = el.scrollHeight - el.clientHeight
      if (!readerMovedScroll(el.scrollTop, floor, observedTopRef.current)) return
      // 读者确实移动了：落到底部附近 → 恢复跟随；否则（含主动上翻）解除
      stickRef.current = floor - el.scrollTop < 24
      observedTopRef.current = el.scrollTop
    }}>
    ${rows.map((row, i) => {
      const latest = i === rows.length - 1
      switch (row.kind) {
        case 'user':
          return html`<${UserRow} key=${row.key} row=${row} store=${store} latest=${latest} />`
        case 'context':
          return html`<${ContextInjectionRow} key=${row.key} row=${row} />`
        case 'sysprompt':
          return html`<${SysPromptRow} key=${row.key} text=${row.text} />`
        case 'assistant': {
          const head = row.turn === undefined ? undefined : turnHeadRow.get(row.turn)
          // 「只含提问行时不折叠」是插件偏离，判据必须是**回合级**的（按首行的链判），否则同回合的行会不一致
          const noFold =
            head !== undefined &&
            head.chain.every((c) => c.kind === 'tool' && c.name === 'ask_user_question')
          return html`<${AssistantRow} key=${row.key} row=${row} store=${store} latest=${latest}
            ownsHead=${head === undefined || head.key === row.key} noFold=${noFold} />`
        }
        case 'approval':
          return html`<${ApprovalRow} key=${row.key} row=${row} store=${store} />`
        case 'question':
          return html`<${QuestionRow} key=${row.key} row=${row} store=${store} />`
        case 'notice':
          return html`<${NoticeRow} key=${row.key} row=${row} />`
      }
    })}
    ${store.processing.value ? html`<${TurnStatus} />` : null}
    ${/* pending 插话气泡：排在列表与「生成中」之后（上游同序）——它们还没进日志，没有锚点序号 */ ''}
    <${PendingSteeringList} items=${store.pendingSteering.value} />
  </div>`
}
