// 提问卡展开体（适配上游 0.1.7-rc.2 / 0.2.0 的限时提问）：
//   已答 = 问题 → 答案列表（空答显示「未回答」）；未答 = 结论（已取消 / 已中断 / 已继续）+ 问题列表。
// 「无记录可展示」（进行中 / 问答配对不上 / 结果坏形）**不在这里兜底**：由 ToolRow 落回通用「输入/输出」区。
//
// **补答入口**：限时提问超时后（`card.lateCallId`）若该条仍在投影的可补答清单里，多一个「回答」按钮 ——
// 那条提问已经不能从弹窗回答了（超时后只有补答通道接受作答），卡片是唯一入口。
import { html } from 'htm/preact'
import type { AskCard } from '../../core/ask-card'
import type { ChatStore } from '../../core/store/chat'
import { askLabels } from '../../core/ask-labels'

export function AskCardBody({ card, store }: { card: AskCard; store: ChatStore }) {
  const labels = askLabels()
  const callId = card.lateCallId
  const late =
    callId !== undefined && store.canAnswerLate(callId)
      ? html`<div class="ask-late">
          <button type="button" class="ask-late-answer" onClick=${() => store.openLateDraft(callId)}>${labels.reopen}</button>
        </div>`
      : null
  const t = card.transcript
  // 记录取不到但**仍可补答**：只出补答入口（问题清单从投影来，比参数文本更权威）
  if (t === null) return late
  if (t.mode === 'unanswered') {
    return html`<div class="ask-card">
      <p class="ask-verdict">${t.verdict}</p>
      <ul class="ask-question-list">${t.questions.map((q, i) => html`<li class="ask-q-unanswered" key=${i}>${q.question}</li>`)}</ul>
      ${late}
    </div>`
  }
  return html`<dl class="ask-card">
    ${t.questions.map((q, i) => html`<div class="ask-item" key=${i}>
      <dt class="ask-question">${q.question}</dt>
      <dd class="ask-answer">
        ${q.answers && q.answers.length > 0
          ? q.answers.map((a, j) => html`<span class="ask-answer-line" key=${j}>${a}</span>`)
          : html`<span class="ask-skipped">${labels.skipped}</span>`}
      </dd>
    </div>`)}
    ${late}
  </dl>`
}
