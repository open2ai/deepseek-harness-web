// 审批卡行（需要批准的工具操作）。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { approvalText } from '../../core/approval-text'

export function ApprovalRow({ row, store }: { row: Extract<ChatRow, { kind: 'approval' }>; store: ChatStore }) {
  // 原因行文案：本地化文案（dsh 0.1.7-rc.2 的 displayReason）优先，缺失回退审计原文；都给不出就不渲染。
  const reason = approvalText(row)
  return html`<div class="approval">
    <div class="appr-info">
      <span class="appr-title"><span class="codicon codicon-warning inline-ico"></span>需要批准${row.toolName ? `：${row.toolName}` : ''}</span>
      ${reason ? html`<div class="appr-reason">${reason}</div>` : null}
    </div>
    <button class="allow" onClick=${() => store.answerApproval(row.approvalId, true, row.key)}>允许</button>
    <button class="reject" onClick=${() => store.answerApproval(row.approvalId, false, row.key)}>拒绝</button>
  </div>`
}
