// 计划产物卡（上游 ui-plan `PlanCards`，挂在回合尾部 `conversation.chat.turnTail`）：
// 每个 `exit_plan_mode` 调用一张卡（Markdown 图标 + 标题 + 「计划 · Markdown」+「打开」）。
//
// 上游点「打开」在侧边栏打开计划文档；这里交给宿主用 **VS Code 编辑区的内置 Markdown 预览**
// 打开（`openPlanDocument` → 临时 .md → `markdown.showPreview`），比自绘弹层更接近原生阅读体验。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'

export interface PlanArtifact {
  callId: string
  markdown: string
  title: string
}

export function PlanArtifacts({ plans, store }: { plans: readonly PlanArtifact[]; store: ChatStore }) {
  if (plans.length === 0) return null
  return html`<div class="plan-artifacts" data-plan-artifacts>
    ${plans.map((plan) => html`<button type="button" class="plan-artifact-card" key=${plan.callId}
        data-plan-card=${plan.callId} aria-label=${`打开计划：${plan.title}`}
        onClick=${() => store.openPlanDocument(plan.title, plan.markdown, plan.callId)}>
      <span class="plan-artifact-icon" aria-hidden="true"><span class="codicon codicon-markdown"></span></span>
      <span class="plan-artifact-details">
        <span class="plan-artifact-title">${plan.title}</span>
        <span class="plan-artifact-desc">计划 · Markdown</span>
      </span>
      <span class="plan-artifact-open">打开</span>
    </button>`)}
  </div>`
}
