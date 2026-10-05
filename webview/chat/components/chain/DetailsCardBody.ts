// 紧凑详情卡体（对齐上游 `ToolDetails`）：渲染 goal / schedule / 子代理协调 / todo diff 的详情模型。
//
// 一份渲染体同时服务两张卡（详情卡与 todo diff 卡），两者共用 `DetailsModel`：
//   · 详情卡：badge（状态徽标）+ fields + code + location + groups；
//   · todo 卡：status（三态）+ change（增/删/改）+ previousStatus（状态变化）+ unchanged（折叠的未变化项）。
// 结构照上游 `ToolDetails`：caption → 列表（标题行 + 字段/代码/子分组）→ unchanged 折叠区。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'
import type { DetailItem, DetailsModel } from '../../core/details-card'

/** todo 三态 → codicon（无 `codicon-` 前缀）。进行中那项用 play 三角（对齐上游，不是转圈）。 */
function statusGlyph(status: DetailItem['status']): string {
  if (status === undefined) return 'circle-large-outline'
  if (status.value === 'completed') return 'pass-filled'
  if (status.value === 'in_progress') return 'play'
  return 'circle-large-outline'
}

/** 单条详情项（递归渲染 groups）。 */
function DetailRow({ item, store }: { item: DetailItem; store: ChatStore }) {
  const status = item.status
  return html`<li class="detail-item" data-change=${item.change?.value}>
    ${item.title !== undefined
      ? html`<div class="detail-heading">
          ${status !== undefined
            ? html`<span class="detail-status" role="img" aria-label=${item.change?.label ?? status.label}>
                ${item.change?.value === 'added' ? '+'
                  : item.change?.value === 'removed' ? '−'
                    : html`<span class=${'codicon codicon-' + statusGlyph(status)} aria-hidden="true"></span>`}
              </span>`
            : null}
          ${item.location !== undefined
            ? html`<button type="button" class="detail-path" title=${item.location.path}
                onClick=${() => store.openFile(item.location?.path ?? '', item.location?.line)}>${item.title}</button>`
            : html`<span class="detail-title">${item.title}</span>`}
          ${item.badge !== undefined
            ? html`<span class="detail-badge" data-tone=${item.badge.tone}>${item.badge.label}</span>`
            : null}
          ${status !== undefined
            ? html`<span class="detail-status-text">
                ${item.previousStatus !== undefined
                  ? html`<span class="detail-previous">${item.previousStatus}</span><span> → </span>`
                  : null}
                <span>${status.label}</span>
                ${item.change?.value === 'updated' && item.previousStatus === undefined
                  ? html`<span> · ${item.change.label}</span>`
                  : null}
              </span>`
            : null}
        </div>`
      : null}
    ${item.subtitle !== undefined ? html`<div class="detail-subtitle">${item.subtitle}</div>` : null}
    ${item.description !== undefined ? html`<p class="detail-description">${item.description}</p>` : null}
    ${item.fields.length > 0
      ? html`<dl class="detail-fields">
          ${item.fields.map((field) => html`<div class="detail-field" key=${field.label}>
            <dt>${field.label}</dt><dd>${field.value}</dd>
          </div>`)}
        </dl>`
      : null}
    ${item.lines !== undefined
      ? html`<ul class="detail-lines">${item.lines.map((line, index) => html`<li key=${index}>${line}</li>`)}</ul>`
      : null}
    ${item.code !== undefined
      ? html`<pre class="detail-code">${item.code.text}</pre>`
      : null}
    ${item.groups?.map((group, index) => html`<details class="detail-group" key=${index}>
        <summary><span class="codicon codicon-chevron-right" aria-hidden="true"></span><span>${group.label}</span></summary>
        <ul class="detail-list">
          ${group.items.map((child, childIndex) => html`<${DetailRow} key=${childIndex} item=${child} store=${store} />`)}
        </ul>
      </details>`)}
  </li>`
}

/** 详情卡体：caption + 列表 + unchanged 折叠区。 */
export function DetailsCardBody({ model, store }: { model: DetailsModel; store: ChatStore }) {
  return html`<div class="detail-card" data-caption=${model.caption !== undefined ? 'true' : undefined}>
    ${model.caption !== undefined ? html`<div class="detail-caption">${model.caption}</div>` : null}
    ${model.items.length === 0
      ? html`<p class="detail-empty">${model.empty ?? '暂无结果'}</p>`
      : html`<ul class="detail-list">
          ${model.items.map((item, index) => html`<${DetailRow} key=${index} item=${item} store=${store} />`)}
        </ul>`}
    ${model.unchanged !== undefined
      ? html`<details class="detail-unchanged">
          <summary class="detail-unchanged-summary">
            <span class="codicon codicon-chevron-right" aria-hidden="true"></span>
            <span>${model.unchanged.label}</span>
          </summary>
          <ul class="detail-list">
            ${model.unchanged.items.map((item, index) => html`<${DetailRow} key=${index} item=${item} store=${store} />`)}
          </ul>
        </details>`
      : null}
  </div>`
}
