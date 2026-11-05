// 提问卡行（ask_user_question：选项/自由输入 + 提交/取消）。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import type { QuestionSpec } from '../../core/protocol'

interface AnswerEntry {
  id: string
  selected: string[]
  custom?: string
}

export function QuestionRow({ row, store }: { row: Extract<ChatRow, { kind: 'question' }>; store: ChatStore }) {
  const init = (): AnswerEntry[] => row.questions.map((q) => ({ id: q.id, selected: [], custom: undefined }))
  const [answers, setAnswers] = useState<AnswerEntry[]>(init)
  const [free, setFree] = useState<Record<string, string>>({})
  /** 长问题/长描述的「展开 / 收起」（0.2.2 的新文案：`text.expand` / `text.collapse`）。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const EXPAND_LONG = 120
  const toggleCopy = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) {
        next.add(key)
      }
      return next
    })
  }
  const update = (id: string, fn: (e: AnswerEntry) => AnswerEntry): void => setAnswers((prev) => prev.map((e) => (e.id === id ? fn(e) : e)))
  const toggleOpt = (q: QuestionSpec, entry: AnswerEntry, label: string): void => {
    if (q.multiSelect) {
      update(entry.id, (e) => ({ ...e, selected: e.selected.includes(label) ? e.selected.filter((s) => s !== label) : [...e.selected, label] }))
    } else {
      update(entry.id, (e) => ({ ...e, selected: [label] }))
    }
  }
  const inputChange = (id: string, value: string): void => {
    setFree((prev) => ({ ...prev, [id]: value }))
    update(id, (e) => ({ ...e, custom: value.trim() || undefined }))
  }
  const submit = (): void => store.submitQuestion(row.key, row.rpcId, row.sessionId, answers)
  const cancel = (): void => store.cancelQuestion(row.key, row.rpcId, row.sessionId)
  const disabled = row.disabled
  return html`<div class="question">
    <div class="q-title"><span class="codicon codicon-question inline-ico"></span>需要你确认</div>
    ${row.questions.map((q, qi) => {
      const entry = answers[qi]
      const isSelected = (label: string): boolean => entry?.selected.includes(label) ?? false
      const copyKey = `q:${q.id}`
      const copyOpen = expanded.has(copyKey)
      return html`<div class="q-block" key=${q.id}>
        ${q.header ? html`<div class="q-header">${q.header}</div>` : null}
        <div class="q-text" data-expanded=${copyOpen ? 'true' : undefined}>${q.question}</div>
        ${q.question.length > EXPAND_LONG
          ? html`<button type="button" class="q-text-toggle" onClick=${() => toggleCopy(copyKey)}>${copyOpen ? '收起' : '展开'}</button>`
          : null}
        ${q.detail ? html`<div class="q-detail">${q.detail}</div>` : null}
        ${q.options && q.options.length > 0
          ? html`<div class="q-options">${q.options.map((o) =>
              html`<button class=${'q-option' + (isSelected(o.label) ? ' selected' : '')} key=${o.label}
                onClick=${() => entry && toggleOpt(q, entry, o.label)}>
                <span class="q-opt-label">${o.label}</span>
                ${o.description ? html`<span class="q-opt-desc">${o.description}</span>` : null}
              </button>`
            )}</div>`
          : html`<input class="q-input" value=${free[q.id] ?? ''} placeholder="输入回答…" disabled=${disabled}
              onInput=${(e: Event) => inputChange(q.id, (e.target as HTMLInputElement).value)} />`}
      </div>`
    })}
    <div class="q-bar">
      <button class="q-submit" disabled=${disabled} onClick=${submit}>回答</button>
      <button class="q-cancel" disabled=${disabled} onClick=${cancel}>取消</button>
    </div>
  </div>`
}
