// web 卡展开体：fetch 的状态码/URL 与 search 的来源列表（适配上游 0.1.7-rc.2）。
// fetch：URL 超链接（globe 图标，http(s) 才成锚）→ `HTTP {statusCode}` 状态**下一行** → 截断提示；
// search：answer → 有序来源列表(url/title/snippet/publishedAt，序号引用) → 空则 noResults → 截断。
// HTTP 状态在链接下一行（与 URL 同行在窄栏下会被挤掉）。
import { html } from 'htm/preact'
import { renderMd } from '../../core/markdown'
import type { WebCard as WebCardData, WebSource } from '../../core/web-card'
import { safeHref, linkLabel } from '../../core/web-card'
import { webLabels } from '../../core/web-labels'

function SourceItem({ source, ordinal }: { source: WebSource; ordinal: number }) {
  const href = safeHref(source.url)
  const label = linkLabel(source.url, source.title)
  return html`<li class="web-source" value=${ordinal}>
    ${href
      ? html`<a class="web-source-link" href=${href} target="_blank" rel="noopener noreferrer"><span class="codicon codicon-globe web-link-ico"></span>${label}</a>`
      : html`<span class="web-source-link">${label}</span>`}
    ${source.snippet ? html`<div class="web-snippet">${source.snippet}</div>` : null}
    ${source.publishedAt ? html`<div class="web-published">${source.publishedAt}</div>` : null}
  </li>`
}

export function WebCard({ card }: { card: WebCardData }) {
  const labels = webLabels()
  if (card.kind === 'fetch') {
    const href = safeHref(card.url)
    return html`<div class="web web-fetch">
      ${href
        ? html`<a class="web-link" href=${href} target="_blank" rel="noopener noreferrer"><span class="codicon codicon-globe web-link-ico"></span>${card.url}</a>`
        : html`<span class="web-link web-link-plain">${card.url}</span>`}
      <span class="web-status">${labels.http} ${card.statusCode}</span>
      ${card.truncated ? html`<div class="web-truncated">${labels.contentTruncated}</div>` : null}
    </div>`
  }
  const answerHtml = card.answer ? renderMd(card.answer) : ''
  return html`<div class="web web-search">
    ${card.answer ? html`<div class="web-answer" dangerouslySetInnerHTML=${{ __html: answerHtml }}></div>` : null}
    ${card.sources.length === 0
      ? html`<div class="web-empty">${labels.noResults}</div>`
      : html`<ol class="web-sources">${card.sources.map((s, i) => html`<${SourceItem} key=${i} source=${s} ordinal=${i + 1} />`)}</ol>`}
    ${card.truncated ? html`<div class="web-truncated">${labels.sourcesTruncated}</div>` : null}
  </div>`
}
