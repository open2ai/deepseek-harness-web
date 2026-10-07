// 行动作条（RowMeta）：时间 + 复制 + 追加动作 + 分叉 + 尾部动作(用量/用时)。
//
// **顺序与上游一致**（上游 `MessageIconActions`：clock → copy → extraActions → branch → usageAction）：
// 追加动作（反馈 👍/👎）落在**复制之后、分叉之前** —— 反馈是对这条回答本身的评价，
// 分叉是拿这条回答去开新对话，两者语义上就该这么排。
//
// **时刻的位置分两端**（上游那个 `clock` 形参）：用户消息在**开头**（`start`）、回答消息在**末尾**
//（`end`，且与用量同一格：用量在前、时刻在后）。插件的用户行与回答行共用这一个组件，所以要由调用方说。
//
// 分叉按钮**不可用时也必须能悬停**：原生 `disabled` 不派发 hover/focus，提示根本弹不出来
//（上游为此专门用 `aria-disabled` + `data-unavailable`，并在旁边放一个只读给读屏的原因 span）。
// 这里同口径：不挂 `onClick` 兜住点击，`title`/`aria-label` 给提示，`aria-describedby` 指到原因 span。
import { html } from 'htm/preact'
import { BranchIcon } from './ThumbIcons'

export function RowMeta({
  time,
  onCopy,
  onBranch,
  copyable,
  branchable,
  branchReasonId,
  extraActions,
  trailingActions,
  clockSide = 'start',
}: {
  time?: string
  onCopy?: () => void
  /** 「在新对话中分支」：只有这一轮的**终局节点**才可用（判据见 AssistantRow） */
  onBranch?: () => void
  copyable: boolean
  branchable?: boolean
  /** 不可用时那句原因的 `id`（`aria-describedby` 指过去；由调用方按行给，保证唯一） */
  branchReasonId?: string
  /** 追加动作：落在**复制之后、分叉之前**（assistant 反馈 👍/👎） */
  extraActions?: unknown
  /** 尾部动作：落在动作区**最末**（用量/用时） */
  trailingActions?: unknown
  /**
   * 时刻落在动作区的哪一端（上游那个 `clock` 形参）：用户消息 `start`、回答消息 `end`。
   *
   * ⚠️ 插件此前一律画在开头 —— 回答行的左右对照因此差一位（真机 2026-10-07：上游是
   * `[复制][反馈][分叉][用量][时刻]`，插件是 `[时刻][复制][反馈][分叉][用量]`）。
   */
  clockSide?: 'start' | 'end'
}) {
  const available = branchable === true
  // 不可用时也要说清**为什么**：一个点不动的按钮比没有按钮更让人以为是坏了
  const branchLabel = available ? '在新对话中分支' : '仅可从已完成轮次的最后一条消息分支'
  const clock = html`<span class="time">${time ?? ''}</span>`
  return html`<div class="msg-meta">${clockSide === 'start' ? clock : null}<span class="msg-actions">
    <button data-act="copy" title="复制" disabled=${!copyable} onClick=${onCopy}><span class="codicon codicon-copy"></span></button>
    ${extraActions}
    ${onBranch === undefined ? null : html`<button data-act="branch" title=${branchLabel} aria-label="在新对话中分支"
      aria-disabled=${available ? undefined : true} data-unavailable=${available ? undefined : true}
      aria-describedby=${available ? undefined : branchReasonId}
      onClick=${available ? onBranch : undefined}><${BranchIcon} /></button>`}
    ${onBranch === undefined || available || branchReasonId === undefined
      ? null
      : html`<span id=${branchReasonId} class="visually-hidden">${branchLabel}</span>`}
    ${clockSide === 'end' ? html`<span class="end-info">${trailingActions}${clock}</span>` : trailingActions}
  </span></div>`
}
