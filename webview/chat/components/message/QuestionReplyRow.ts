// 已回答提问行（上游 `answered-user-question` → `QuestionReplyView`）：
// 右对齐气泡，逐题列「问题（header + 正文）→ 回答」，不参与过程折叠、没有可展开的过程行。
// 数据来自 ask 工具调用 + 结果（见 `core/nodes/chat-nodes.ts` 3.5），与迟到补答共用同一套问答数据。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'

/** 与上游 `replyAnswerValues` 同：selected 全列，再接非空 custom。 */
function valuesOf(question: { id: string }, answers: Array<{ id: string; selected: string[]; custom?: string }>): string[] {
  const answer = answers.find((a) => a.id === question.id)
  const custom = answer?.custom?.trim() ?? ''
  return [...(answer?.selected ?? []), ...(custom === '' ? [] : [custom])]
}

export function QuestionReplyRow({ row, store }: { row: Extract<ChatRow, { kind: 'questionReply' }>; store: ChatStore }) {
  const qr = row.question
  /**
   * 复制文本与上游 `replyClipboardText` 同口径：`header — question`（无 header 或与问题同文时只用问题）
   * 换行 `回答：a、b`；没有作答时给「这道问题当时被跳过」。
   */
  const copyText = qr.questions.length === 0
    ? qr.text
    : qr.questions.map((q) => {
        const head = q.header !== undefined && q.header !== q.question ? `${q.header} — ${q.question}` : q.question
        const values = valuesOf(q, qr.answers)
        return `${head}\n回答：${values.length === 0 ? '这道问题当时被跳过' : values.join('、')}`
      }).join('\n\n')
  return html`<div class="msg user question-reply answered"><div class="col">
    <div class="qreply-bubble">
      <dl class="qreply-detail">
        ${qr.questions.map((q) => {
          const values = valuesOf(q, qr.answers)
          return html`<div class="qreply-pair" key=${q.id}>
            <dt class="qreply-q">
              ${q.header !== undefined && q.header !== '' ? html`<span class="qreply-header">${q.header}</span>` : null}
              <span>${q.question}</span>
            </dt>
            <dd class="qreply-a">${values.length === 0 ? html`<span class="qreply-skipped">这道问题当时被跳过</span>` : values.join('、')}</dd>
          </div>`
        })}
      </dl>
    </div>
    <div class="qreply-actions">
      <span class="qreply-time">${row.time}</span>
      ${copyText === '' ? null : html`<button type="button" class="qreply-copy" aria-label="复制" title="复制" onClick=${() => store.copy(copyText)}><span class="codicon codicon-copy" aria-hidden="true"></span></button>`}
    </div>
  </div></div>`
}
