// 行动作条（RowMeta）：时间 + 复制 + 追加动作 + 分叉 + 尾部动作(用量/用时)。
//
// **顺序与上游一致**（上游 `MessageIconActions`：clock → copy → extraActions → branch → usageAction）：
// 追加动作（反馈 👍/👎）落在**复制之后、分叉之前** —— 反馈是对这条回答本身的评价，
// 分叉是拿这条回答去开新对话，两者语义上就该这么排。
//
// **时刻的位置**：上游分两端（`MessageIconActions` 的 `clock: 'start' | 'end'` 形参）——
// 用户/插话类在开头（上游三处 `clock="start"`）、回答收口行在末尾
// （`clock="end"`，与用量同格：用量在前、时刻在后）。
//
// ⛔ **本插件有意不跟这一条**（维护者定案 2026-10-07）：宿主是**窄侧栏**，末尾那一格（用量 + 时刻）
// 内容最长时会被挤到**第二行**（真机截图：图标一行、`15:09` 单独一行）。所以**时刻一律留在最前面**。
// **这不是遗漏，别再按上游「对齐」回来** —— 2026-10-09 误改过一次，已回退。
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
}) {
  const available = branchable === true
  // 不可用时也要说清**为什么**：一个点不动的按钮比没有按钮更让人以为是坏了
  const branchLabel = available ? '在新对话中分支' : '仅可从已完成轮次的最后一条消息分支'
  return html`<div class="msg-meta"><span class="time">${time ?? ''}</span><span class="msg-actions">
    <button data-act="copy" title="复制" disabled=${!copyable} onClick=${onCopy}><span class="codicon codicon-copy"></span></button>
    ${extraActions}
    ${onBranch === undefined ? null : html`<button data-act="branch" title=${branchLabel} aria-label="在新对话中分支"
      aria-disabled=${available ? undefined : true} data-unavailable=${available ? undefined : true}
      aria-describedby=${available ? undefined : branchReasonId}
      onClick=${available ? onBranch : undefined}><${BranchIcon} /></button>`}
    ${onBranch === undefined || available || branchReasonId === undefined
      ? null
      : html`<span id=${branchReasonId} class="visually-hidden">${branchLabel}</span>`}
    ${trailingActions}
  </span></div>`
}