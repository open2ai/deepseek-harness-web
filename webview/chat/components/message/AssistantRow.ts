// assistant 回复行：过程链(思考/工具折叠) + markdown 正文(块级增量渲染) + 终态角标 + 动作条。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { TurnStats } from '../TurnStats'
import { FeedbackActions } from './FeedbackActions'
import { Chain } from '../chain/Chain'
import { planProcessGroups } from '../../core/process-groups'
import { Deliverables } from './Deliverables'
import { MessageBody } from './MessageBody'
import { RowMeta } from './meta'
import { TurnNoticeRow } from './TurnNoticeRow'

export function AssistantRow({ row, store, latest, turnTail, ownsHead, soleRow, tailNotices }: { row: Extract<ChatRow, { kind: 'assistant' }>; store: ChatStore; latest?: boolean; turnTail?: boolean; ownsHead: boolean; soleRow?: boolean; tailNotices?: readonly ChatRow[] }) {
  // 上游无正文流式光标（流式指示靠左下角 TurnStatus），正文不加打字光标
  // 动作条（复制/分叉/反馈/用量/用时）：仅回答结束后(done)显示，回答过程中不出现
  // 回答收得紧不紧（`compactAnswer`）：过程区间里有人插话时为 `wide`，链与正文之间放宽（见 chain.css）
  const answerGap = row.process === undefined ? undefined : row.process.compactAnswer ? 'compact' : 'wide'
  // 分叉可不可用**只有两条判据**（与上游逐字同口径）：① 这一轮**没有定稿回答**（没有回答锚点）；
  // ② 收官回答**之后、同一回合里还有转录活动**。后者的等价物就是 `turnTail`：本行是这一轮的
  // 内容收尾节点（回合内没有更晚的内容行）。
  //
  // ⚠️ **不要再按"收尾原因"或"有没有终局行"加判据**：收尾原因是 `forked`（从这条回答分叉出来的
  // 回合）、`aborted`、`max-tokens`、消息级中断……这些**都不影响**分叉能不能用 —— 上游只在
  // "没有定稿回答"或"后面还有工具/结果/重试"时置灰。曾经这里还按 `status` / `interrupted` /
  // 终局通知各加了一条 → 分叉出来的回合（收尾原因 `forked`）一进去就是灰的，点不动（真机反馈）。
  //
  // ⚠️ **不能用 `latest` 代替 `turnTail`**：`latest` 是**整表**最后一条可见行，一条回合**之后**的
  // 命令行/压缩标记会把它顶掉 —— 那正是「正常完成的会话却点不动分叉」的成因（`latest` 保留给
  // 动作条的常显样式，不再是这里的判据）。
  const branchUnavailable = turnTail !== true
  /**
   * 「已停止」药丸落在**哪里**（真机左右对照 2026-10-06）：上游那个药丸长在**该步自己的正文块**上 ——
   * 有正文时它就在正文末尾（本行现在的行为）；**这一步没有正文、只有思考/工具**时，那个块本身就是
   * **这一片的成员**，药丸于是落在**分组框里面**。判据取"链上有没有可渲染的明细"，与 `Chain` 用的是
   * 同一份切片计划（`planProcessGroups`），不会两边打架。
   */
  const chainPlan = planProcessGroups(row.chain ?? [], row.process?.groups)
  const chainHasDetail = chainPlan.ok && chainPlan.entries.some((entry) => entry.kind !== 'group' || entry.items.length > 0)
  const pillInChain = row.interrupted === true && row.text.trim() === '' && chainHasDetail
  const stoppedPill = html`<span class="answer-stopped">已停止</span>`
  /**
   * 动作区**常显**的条件（上游那个 `data-actions-reveal={endsWithResponse ? 'always' : 'hover'}`）。
   *
   * 上游只在「这一轮**以回答正文收尾**」时常显，其余一律**悬停才出**（动作区默认 `opacity: 0`，
   * `.msg:hover` 才亮）。"以回答正文收尾"的判据是上游的 `hasAssistantReplyContent`：
   * **推理（reasoning）与工具调用（tool-call）都不算回答正文**，只有非空文本之类的块才算。
   *
   * ⚠️ 插件原先拿**整表最后一行**（`latest`）当常显条件 —— 于是"末行是工具/思考收尾（没有正文）"时
   * 也会常亮一片，与上游不一致（真机左右对照 2026-10-07：用户问"按钮出现的时机对上了吗"）。
   */
  const alwaysShowActions = latest === true && row.text.trim() !== ''
  // 失败原因**不在这里**：它是独立行（镜像上游 `turn-error` / `turn-max-tokens`，见 `TurnNoticeRow.ts`）
  return html`<div class="msg assistant${alwaysShowActions ? ' latest' : ''}" data-turn-process-answer=${answerGap}><div class="col">
    <${Chain} row=${row} store=${store} ownsHead=${ownsHead} soleRow=${soleRow} stoppedPill=${pillInChain ? stoppedPill : null} />
    <div class="body"><${MessageBody} text=${row.text} streaming=${!row.done} />${row.interrupted === true && !pillInChain
      ? stoppedPill
      : null}</div>
    ${/* 归并进来的终局通知（token 上限）：上游 `noticeAnchor` 的等价位置 = 收官回答与 turn-tail 之间，
         而插件的 turn-tail（动作条 + 交付区）在行内 → 排在它们**之前** */ ''}
    ${tailNotices !== undefined && tailNotices.length > 0
      ? tailNotices.map((notice) => html`<${TurnNoticeRow} key=${notice.key} row=${notice} />`)
      : null}
    <${Deliverables} row=${row} store=${store} />
    ${/* 动作条（时间/复制/反馈/分叉/用量用时）的**唯一门控是「有没有定稿的回答锚点」**（`row.seq`），
         不是「回合结束了没有」。与上游同口径（`TurnTailNodeView.tsx:27`）：被终止的回合若没产出定稿回答，
         上游 `closing === null` 直接不渲染这一条动作区。没有锚点也就没有可复制的定稿正文、
         没有可反馈/可分支的 messageId，画出来只会误导。 */ ''}
    ${row.done && row.seq !== undefined ? RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
      // 「在新对话中分支」：只有**当前对话的最后一条**、已定稿、且**本轮正常收在正文上**才能分叉。
      // 与上游同一门控（它只提供「从末尾分叉」，不提供从历史中间分叉；被终止/出错/中断的轮次
      // 终局不在正文上，因而不可用）。不可用时按钮仍在，只是置灰 + 悬停给出原因。
      onBranch: () => store.forkAt(row.seq as number),
      branchable: !branchUnavailable,
      branchReasonId: `branch-reason-${String(row.key)}`,
      // 反馈（👍/👎）：插在**复制之后、分叉之前**（与上游 `MessageIconActions` 的槽位顺序一致）。
      // 只有拿到回答消息标识的行才有目标 —— 没有就整个不渲染，不给一个点了报错的按钮。
      extraActions: row.messageId !== undefined ? html`<${FeedbackActions} store=${store} messageId=${row.messageId} />` : null,
      // 用量 / 用时：排在动作区**最末**（上游的 `usageAction` 就在分叉之后）
      // 【性能与用量 = 简洁】时**不显示每轮用量**（上游：简洁模式不显示统计卡片与每轮用量）；
      // 判据「只有显式 compact 才隐藏」= 字段缺失时维持旧行为
      //
      // ⚠️ **只落在本回合的最后一段**（`turnTail`）：用量/用时是**回合级**事实，宿主现在把它写给本回合
      // 每一条行（终局态摘要行由**首行**渲染，不补就没法显示「用时 X」）；动作条这一处按既定口径
      // 「用量、时钟、分叉与反馈只落在最后一段」（`design/06` §14）只留一份，不在被插话切开的前段重复出现。
      trailingActions: turnTail === true && row.usageRaw && store.performanceUsage?.value !== 'compact' ? html`<${TurnStats} usage=${row.usageRaw} />` : null,
    }) : null}
  </div></div>`
}
