// 计划审阅卡（上游 `PlanReviewPanel`，包 `@deepseek-ai/dsh-client-ui-user-questions`）：
// 不进入一题一屏的通用提问流程 —— plan-mode 的 ask 请求被收窄成「计划待审」卡片：
//   · 顶部警示条：计划待审 + 「查看全文」；
//   · 摘要：计划第一行作标题、第一段作描述；
//   · 底部：「要求修改」（dismiss，回到输入区）与「同意执行」（以 approve.label 作答）。
//
// 上游的「查看全文」在侧边栏打开计划文档；VS Code webview 没有等价的 side document 面板，
// 这里用**同内容的 Markdown 弹层**承载（文案、入口位置与上游一致）。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { planDescriptionOf, planTitleOf, type PlanReview } from '../../core/plan-review'
import type { ChatStore } from '../../core/store/chat'

export interface PlanReviewPanelProps {
  store: ChatStore
  review: PlanReview
  rpcId?: string
  sessionId?: string
}

export function PlanReviewPanel({ store, review, rpcId, sessionId }: PlanReviewPanelProps) {
  const [busy, setBusy] = useState(false)
  const title = planTitleOf(review.plan)
  const description = planDescriptionOf(review.plan)
  const dismiss = (): void => {
    setBusy(true)
    store.cancelQuestion(0, rpcId, sessionId)
  }
  const approve = (): void => {
    setBusy(true)
    store.submitQuestion(0, rpcId, sessionId, [{ id: review.id, selected: [review.approve.label] }])
  }
  return html`<div class="plan-review">
    <section class="plan-review-card" aria-label=${review.question} aria-busy=${busy ? 'true' : 'false'}>
      <div class="plan-review-strip">
        <span class="plan-review-dot" aria-hidden="true"></span>
        <span>计划待审</span>
        <div class="plan-review-preview">
          <button type="button" class="plan-review-link" onClick=${() => store.openPlanDocument(title === '' ? '计划' : title, review.plan, review.callId)}>
            查看全文<span class="codicon codicon-chevron-right" aria-hidden="true"></span>
          </button>
        </div>
      </div>
      <div class="plan-review-summary">
        <h3 class="plan-review-title">${title}</h3>
        ${description !== '' && description !== title ? html`<p class="plan-review-description">${description}</p>` : null}
      </div>
      <div class="plan-review-footer">
        <div class="plan-review-feedback" role="status"></div>
        <div class="plan-review-actions">
          <button type="button" class="plan-review-discuss" disabled=${busy} onClick=${dismiss}>
            <span class="codicon codicon-edit" aria-hidden="true"></span>要求修改
          </button>
          <button type="button" class="plan-review-approve" disabled=${busy}
            title=${review.approve.description ?? ''} onClick=${approve}>同意执行</button>
        </div>
      </div>
    </section>
  </div>`
}
