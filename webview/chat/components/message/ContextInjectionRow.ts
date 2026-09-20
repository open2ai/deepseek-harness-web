// 上下文注入/召回行（展开体渲染在 ContextBody；适配上游 0.1.5-rc.2）。
// 收进 assistant 过程链：收起=一行（图标 + 角色标题「上下文注入/跨会话召回」+ 来源标签 + notice 单行说明），
// 展开=按生产者声明的 form（instructions/catalog/snapshot/notice/relay/recall/opaque）展示该行内容。
// 铁律：文案/结构取自字典与协议申报的事实，不自行翻译、不编造；未知 form 退回 opaque（原文不丢）。
import { html } from 'htm/preact'
import { memo } from 'preact/compat'
import { useMemo, useState } from 'preact/hooks'
import type { DshTurnProcessItem } from '../../core/store/chat'
import { contextLabels } from '../../core/context-labels'
import { contextView, type ContextBodySpec, type ContentRun } from '../../core/context-body'

type ContextItem = Extract<DshTurnProcessItem, { kind: 'context' }>

/** 未知内容块（block run）→ 标签 + pretty JSON。 */
function JsonBlock({ label, payload }: { label: string; payload: unknown }) {
  let text = ''
  try {
    text = JSON.stringify(payload, null, 2)
  } catch {
    text = String(payload)
  }
  return html`<div class="ctx-unknown">
    <div class="ctx-unknown-label">${label}</div>
    <pre class="ctx-unknown-json">${text}</pre>
  </div>`
}

/** 模型读到的内容：文本 run 原样（含真实换行），未知块各成一 JSON 块。 */
function ModelFacing({ runs }: { runs: ContentRun[] }) {
  const labels = contextLabels()
  return html`${runs.map((run, i) =>
    'text' in run
      ? run.text !== ''
        ? html`<pre class="ctx-text" key=${i}>${run.text}</pre>`
        : null
      : html`<${JsonBlock} key=${i} label=${labels.unknownBlock} payload=${run.block} />`
  )}`
}

function Fields({ fields }: { fields: Array<{ key: string; value: string }> }) {
  if (fields.length === 0) return null
  return html`<dl class="ctx-fields">
    ${fields.map((f, i) => html`<div class="ctx-field" key=${i}>
      <dt class="ctx-field-key">${f.key}</dt>
      <dd class="ctx-field-value">${f.value}</dd>
    </div>`)}
  </dl>`
}

function Body({ spec }: { spec: ContextBodySpec }) {
  const labels = contextLabels()
  switch (spec.kind) {
    case 'opaque':
      return html`<${ModelFacing} runs=${spec.runs} /><${Fields} fields=${spec.fields} />`
    case 'instructions':
      return html`<ul class="ctx-files">
        ${spec.files.map((f, i) => html`<li class="ctx-file" key=${i} title=${f.digest ?? ''}>
          <span class="ctx-file-path">${f.path}</span>
          <span class="ctx-file-action">${f.action}</span>
        </li>`)}
      </ul><${ModelFacing} runs=${spec.runs} />`
    case 'catalog':
      return html`${spec.update ? html`<p class="ctx-notice" data-ctx-catalog-update>${labels.catalogReplaced}</p>` : null}
        <ul class="ctx-entries">
          ${spec.entries.map((e, i) => html`<li class="ctx-entry" key=${i}>
            <code class="ctx-entry-name">${e.name}</code>
            <span class="ctx-entry-description">${e.description}</span>
          </li>`)}
        </ul>
        ${spec.more > 0 ? html`<p class="ctx-notice" data-ctx-entries-truncated>${labels.catalogMore(spec.more)}</p>` : null}
        ${spec.unknown.map((b, i) => html`<${JsonBlock} key=${'u' + i} label=${labels.unknownBlock} payload=${b} />`)}`
    case 'snapshot':
      return html`<p class="ctx-notice" data-ctx-snapshot-supersedes>${labels.snapshotSupersedes}</p>
        <dl class="ctx-sections">
          ${spec.sections.map((s, i) => html`<div class="ctx-section" key=${i}>
            <dt class="ctx-section-name">${s.name}</dt>
            <dd class="ctx-section-text">${s.text}</dd>
          </div>`)}
        </dl>`
    case 'notice':
      return html`<${ModelFacing} runs=${spec.runs} />`
    case 'relay':
      return html`<p class="ctx-notice" data-ctx-relay-sender>${labels.relayFrom(spec.sender)}</p>
        <${ModelFacing} runs=${spec.runs} />`
    case 'recall':
      return html`<ul class="ctx-recalls">
        ${spec.sessions.map((s, i) => html`<li class="ctx-recall" key=${i}>
          <span class="ctx-recall-label">${s.label}</span>
          <span class="ctx-recall-counts">${labels.recallCounts(s.retained, s.omitted)}</span>
          ${s.truncated ? html`<span class="ctx-recall-counts">${labels.recallTruncated}</span>` : null}
        </li>`)}
      </ul><${ModelFacing} runs=${spec.runs} />`
  }
}

function ContextInjectionRowView({ item }: { item: ContextItem }) {
  const [open, setOpen] = useState(false)
  const labels = contextLabels()
  const view = useMemo(
    () => contextView(item.form, item.content, item.source),
    [item.form, item.content, item.source]
  )
  const isRecall = item.provenance.role === 'recall'
  const icon = isRecall ? 'codicon-history' : 'codicon-file-text'
  const title = isRecall ? labels.contextRecall : labels.contextInjection
  const label = item.provenance.label
  return html`<div class="ctx${open ? ' is-open' : ''}">
    <button class="ctx-head" onClick=${() => setOpen((o) => !o)} aria-expanded=${open}>
      <span class=${'codicon ctx-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
      <span class=${'codicon ctx-ico ' + icon}></span>
      <span class="ctx-title">${title}</span>
      ${label !== null ? html`<span class="ctx-sep" aria-hidden></span>
        <span class="ctx-source">${label}</span>` : null}
      ${!open && view.summary !== null ? html`<span class="ctx-sep" aria-hidden></span>
        <span class="ctx-summary">${view.summary}</span>` : null}
    </button>
    ${open
      ? html`<div class="ctx-body">
          <${Body} spec=${view.body} />
        </div>`
      : null}
  </div>`
}

/**
 * 组件层跳渲：流式期间链上 vnode 每帧重建，而**已出现的注入行 item 不会变**。
 * 不加这层的话，每帧都要把 `contextView` 与展开体重算一遍（系统提示词注入尤其大）。
 */
export const ContextInjectionRow = memo(
  ContextInjectionRowView,
  (a: { item: ContextItem }, b: { item: ContextItem }) => a.item === b.item
)
