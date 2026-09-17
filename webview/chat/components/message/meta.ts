// 行动作条（RowMeta）：时间 + 复制 + 追加动作 + 分叉 + 尾部动作(用量/用时)。
//
// **顺序与上游一致**（上游 `MessageIconActions`：clock → copy → extraActions → branch → usageAction）：
// 追加动作（反馈 👍/👎）落在**复制之后、分叉之前** —— 反馈是对这条回答本身的评价，
// 分叉是拿这条回答去开新对话，两者语义上就该这么排。
import { html } from 'htm/preact'

export function RowMeta({
  time,
  onCopy,
  onBranch,
  copyable,
  branchable,
  extraActions,
  trailingActions,
}: {
  time?: string
  onCopy?: () => void
  /** 「在新对话中分支」：只有当前对话的最后一条、且带回答锚点的回答才可用（判据见 AssistantRow） */
  onBranch?: () => void
  copyable: boolean
  branchable?: boolean
  /** 追加动作：落在**复制之后、分叉之前**（assistant 反馈 👍/👎） */
  extraActions?: unknown
  /** 尾部动作：落在动作区**最末**（用量/用时） */
  trailingActions?: unknown
}) {
  // 不可用时也要说清**为什么**：一个点不动的按钮比没有按钮更让人以为是坏了
  const branchLabel = branchable ? '在新对话中分支' : '仅可从已完成轮次的最后一条消息分支'
  return html`<div class="msg-meta"><span class="time">${time ?? ''}</span><span class="msg-actions">
    <button data-act="copy" title="复制" disabled=${!copyable} onClick=${onCopy}><span class="codicon codicon-copy"></span></button>
    ${extraActions}
    ${onBranch === undefined ? null : html`<button data-act="branch" title=${branchLabel} aria-label=${branchLabel}
      disabled=${!branchable} onClick=${onBranch}><span class="codicon codicon-git-branch"></span></button>`}
    ${trailingActions}
  </span></div>`
}
