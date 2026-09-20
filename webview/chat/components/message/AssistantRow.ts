// assistant 回复行：过程链(思考/工具折叠) + markdown 正文(块级增量渲染) + 终态角标 + 动作条。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { TurnStats } from '../TurnStats'
import { FeedbackActions } from './FeedbackActions'
import { Chain } from '../chain/Chain'
import { Deliverables } from './Deliverables'
import { MessageBody } from './MessageBody'
import { RowMeta } from './meta'

export function AssistantRow({ row, store, latest, ownsHead, noFold }: { row: Extract<ChatRow, { kind: 'assistant' }>; store: ChatStore; latest?: boolean; ownsHead: boolean; noFold: boolean }) {
  // 上游无正文流式光标（流式指示靠左下角 TurnStatus），正文不加打字光标
  // 动作条（复制/分叉/反馈/用量/用时）：仅回答结束后(done)显示，回答过程中不出现
  // 回答收得紧不紧（`compactAnswer`）：过程区间里有人插话时为 `wide`，链与正文之间放宽（见 chain.css）
  const answerGap = row.process === undefined ? undefined : row.process.compactAnswer ? 'compact' : 'wide'
  return html`<div class="msg assistant${latest ? ' latest' : ''}" data-turn-process-answer=${answerGap}><div class="col">
    <${Chain} row=${row} store=${store} ownsHead=${ownsHead} noFold=${noFold} />
    <div class="body"><${MessageBody} text=${row.text} streaming=${!row.done} /></div>
    ${row.endMsg ? html`<div class="end-note"><span class="codicon codicon-warning inline-ico"></span>${row.endMsg}</div>` : null}
    ${row.status ? html`<div class="status-badge">${row.status}</div>` : null}
    <${Deliverables} row=${row} store=${store} />
    ${/* 动作条（时间/复制/反馈/分叉/用量用时）的**唯一门控是「有没有定稿的回答锚点」**（`row.seq`），
         不是「回合结束了没有」。与上游同口径（`TurnTailNodeView.tsx:27`）：被终止的回合若没产出定稿回答，
         上游 `closing === null` 直接不渲染这一条动作区。没有锚点也就没有可复制的定稿正文、
         没有可反馈/可分支的 messageId，画出来只会误导。 */ ''}
    ${row.done && row.seq !== undefined ? RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
      // 「在新对话中分支」：只有**当前对话的最后一条**、已定稿、且带回答锚点的回答才能分叉。
      // 与上游同一门控 —— 它只提供「从末尾分叉」，不提供从历史中间分叉（避免切点歧义）。
      onBranch: () => store.forkAt(row.seq as number),
      branchable: !!latest,
      // 反馈（👍/👎）：插在**复制之后、分叉之前**（与上游 `MessageIconActions` 的槽位顺序一致）。
      // 只有拿到回答消息标识的行才有目标 —— 没有就整个不渲染，不给一个点了报错的按钮。
      extraActions: row.messageId !== undefined ? html`<${FeedbackActions} store=${store} messageId=${row.messageId} />` : null,
      // 用量 / 用时：排在动作区**最末**（上游的 `usageAction` 就在分叉之后）
      trailingActions: row.usageRaw ? html`<${TurnStats} usage=${row.usageRaw} />` : null,
    }) : null}
  </div></div>`
}
