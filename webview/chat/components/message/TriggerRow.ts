// 触发卡（上游 `TurnTriggerNodeView`）：某条非 human 通知认领了本轮（waking）——展开可看通知正文。
//
//   [图标] 标题（如「收到任务消息」）  时刻(margin-left:auto)  [chevron 旋转]
//   展开：这条通知触发了本轮回复。 + 通知正文
//
// · 标题/图标按 `source.kind` 映射（镜像上游 `turn-trigger.ts` 的 `turnTriggerDetails`）；
// · 独立行：`turn-trigger` 在 `INDEPENDENT` 集合里，不被折进过程组、永远可见；
// · 外观照上游 `TurnTriggerNodeView.module.css`：圆角描边卡 + 12/16 内边距 + 40px 正文缩进。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ChatRow } from '../../core/store/types'

/** 标题 + 图标（codicon）按 `source.kind` 映射（镜像上游 `TRIGGER_ICONS`）。 */
function triggerDetails(source: unknown): { title: string; icon: string } {
    const src = (source !== null && typeof source === 'object' ? source : {}) as Record<string, unknown>
    const kind = typeof src['kind'] === 'string' ? src['kind'] : ''
    switch (kind) {
        case 'goal': return { title: '继续执行目标', icon: 'target' }
        case 'agent-message': return { title: '收到任务消息', icon: 'send' }
        case 'team-message': return { title: '收到团队消息', icon: 'organization' }
        case 'subagent-settled': return { title: '子任务状态更新', icon: 'organization' }
        case 'webhook':
            return src['provider'] === 'github'
                ? { title: '收到 GitHub 事件', icon: 'git-branch' }
                : { title: '收到外部事件', icon: 'globe' }
        case 'schedule': return { title: '自动化任务', icon: 'clock' }
        case 'tool-jobs': return { title: '后台任务状态更新', icon: 'list-unordered' }
        case 'cordis-host-runner': return { title: '插件状态更新', icon: 'extensions' }
        default: return { title: '收到执行请求', icon: 'comment-discussion' }
    }
}

function contentText(content: readonly unknown[]): string {
    let out = ''
    for (const b of content) {
        if (b !== null && typeof b === 'object') {
            const rec = b as Record<string, unknown>
            if (rec['type'] === 'text' && typeof rec['text'] === 'string') out += rec['text']
        }
    }
    return out
}

export function TriggerRow({ row }: { row: Extract<ChatRow, { kind: 'trigger' }> }) {
    const [open, setOpen] = useState(false)
    const details = triggerDetails(row.source)
    const body = contentText(row.content)
    return html`<section class="trigger" data-turn-trigger>
    <button class="trigger-head" type="button" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <span class=${'codicon codicon-' + details.icon + ' trigger-icon'} aria-hidden="true"></span>
      <span class="trigger-title">${details.title}</span>
      ${row.time !== '' ? html`<time class="trigger-time">${row.time}</time>` : null}
      <span class=${'codicon codicon-chevron-down trigger-chev' + (open ? ' is-open' : '')} aria-hidden="true"></span>
    </button>
    ${open
      ? html`<div class="trigger-body">
          <p class="trigger-explanation">这条通知触发了本轮回复。</p>
          ${body !== '' ? html`<div class="trigger-content">${body}</div>` : null}
        </div>`
      : null}
  </section>`
}
