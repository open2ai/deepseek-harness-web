// 排队卡片（输入框上方）：忙时发出去、**排到下一轮**的消息在这里等回合边界，可编辑 / 删除 / 转插话。
//
// 它**不是对话流的一部分**：队列条目不属于任何回合，被取用之后才以用户消息出现在对话区 ——
// 所以它既不进 messages（与行的整表替换互不干扰），也不参与滚动与折叠。
// 与上游同一分工：这张卡只列 `queued` 项；**插话（steering）在对话区末尾以 pending 气泡呈现**
// （见 `components/message/PendingSteeringRow`），不在这张卡里重复显示。
// 布局照既有卡片（见 TodoCard）：一行头（图标 + 计数 + 折叠箭头），展开才出列表；单条时直接显示那一行。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ChatStore } from '../core/store/chat'
import type { QueueItemView } from '../core/protocol'
import type { QueueSendingAttachment } from '../core/store/types'
import { fileSizeText } from '../core/file-labels'

type QueueAttachment = NonNullable<QueueItemView['attachments']>[number] | QueueSendingAttachment

/** 附件摘要：图片只报「图片」，文件报名字与大小（排队阶段没有本地路径，也不显示缩略图）。 */
function attachmentLabel(a: QueueAttachment): string {
  if (a.kind === 'image') {
    return a.name ? `图片 ${a.name}` : '图片'
  }
  return [a.name, fileSizeText(a.bytes)].filter(Boolean).join(' ')
}

export function QueueCard({ store }: { store: ChatStore }) {
  // 只列排队项：插话不在这张卡里（它在对话区末尾，见文件头）
  const items = store.queueItems.value.filter((i) => i.placement === 'queued')
  const sending = store.queueSending.value.filter((s) => s.mode === 'queue')
  const editing = store.queueEditing.value
  const busyId = store.queueBusy.value
  const running = store.turnRunning.value
  // 默认折叠：队列是过渡态，多条时不该常驻占掉输入区上方的空间
  const [collapsed, setCollapsed] = useState(true)
  const total = items.length + sending.length
  if (total === 0) {
    return null
  }
  const anyBusy = busyId !== null
  // 单条、或正在编辑、或用户展开 → 出列表
  const expanded = total === 1 || !collapsed || editing !== null

  return html`<section class="queue-card" aria-label="排队消息">
    <div class="queue-body">
      ${total > 1
        ? html`<button type="button" class="queue-head" aria-expanded=${expanded}
            title=${expanded ? '收起排队消息' : '展开排队消息'} onClick=${() => setCollapsed((v) => !v)}>
            <span class="codicon codicon-list-ordered queue-lead" aria-hidden="true"></span>
            <span class="queue-title">${`${String(total)} 条排队消息`}</span>
            <span class=${'codicon queue-chev ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-up')} aria-hidden="true"></span>
          </button>`
        : null}
      ${expanded
        ? html`<ul class="queue-list">
            ${items.map((item) => {
              const atts = item.attachments ?? []
              const editingThis = editing !== null && editing.id === item.id
              const rowBusy = busyId === item.id
              // 含非文本附件 → 服务端只接受纯文本编辑，这里直接不给编辑
              const canEdit = atts.length === 0
              return html`<li class="queue-item" key=${item.id}>
                <span class="codicon codicon-list-ordered queue-glyph" aria-hidden="true"></span>
                <span class="queue-main">
                  ${atts.length > 0
                    ? html`<span class="queue-atts">${atts.map(
                        (a, i) => html`<span class="queue-att" key=${`${a.kind}:${a.name ?? ''}:${String(i)}`}>${attachmentLabel(a)}</span>`
                      )}</span>`
                    : null}
                  ${editingThis
                    ? html`<input class="queue-editor" value=${editing.text} autofocus aria-label="编辑排队消息"
                        onInput=${(e: Event) => store.editQueueItem(item.id, (e.target as HTMLInputElement).value)}
                        onKeyDown=${(e: KeyboardEvent) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            store.saveQueueEdit()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            store.cancelQueueEdit()
                          }
                        }} />`
                    : html`<span class="queue-text" title=${item.text}>${item.text}</span>`}
                </span>
                <span class="queue-actions">
                  ${editingThis
                    ? html`<button type="button" class="queue-act" title="保存排队消息" aria-label="保存排队消息"
                          disabled=${anyBusy || editing.text.trim() === ''} onClick=${() => store.saveQueueEdit()}>
                          <span class="codicon codicon-check"></span></button>
                        <button type="button" class="queue-act" title="取消编辑" aria-label="取消编辑" disabled=${anyBusy}
                          onClick=${() => store.cancelQueueEdit()}><span class="codicon codicon-close"></span></button>`
                    : html`<button type="button" class="queue-act" aria-label="编辑排队消息"
                          title=${canEdit ? '编辑排队消息' : '包含非文本内容，暂不支持编辑'} disabled=${anyBusy || !canEdit}
                          onClick=${() => store.editQueueItem(item.id, item.text)}><span class="codicon codicon-edit"></span></button>
                        <button type="button" class="queue-act" title="删除排队消息" aria-label="删除排队消息" disabled=${anyBusy}
                          onClick=${() => store.removeQueueItem(item.id)}><span class="codicon codicon-trash"></span></button>
                        <button type="button" class="queue-act" aria-label="插话发送"
                          title=${running ? '插话发送' : '仅运行中可插话发送'} disabled=${anyBusy || !running}
                          onClick=${() => store.steerQueueItem(item.id)}><span class="codicon codicon-send"></span></button>`}
                  ${rowBusy ? html`<span class="codicon codicon-loading codicon-modifier-spin queue-spin" aria-hidden="true"></span>` : null}
                </span>
              </li>`
            })}
            ${sending.map(
              (s) => html`<li class="queue-item is-sending" key=${s.rpcId}>
                <span class="codicon codicon-list-ordered queue-glyph" aria-hidden="true"></span>
                <span class="queue-main">
                  ${s.attachments.length > 0
                    ? html`<span class="queue-atts">${s.attachments.map(
                        (a, i) => html`<span class="queue-att" key=${`${a.kind}:${a.name ?? ''}:${String(i)}`}>${attachmentLabel(a)}</span>`
                      )}</span>`
                    : null}
                  <span class="queue-text" title=${s.text}>${s.text}</span>
                </span>
                <span class="queue-actions">
                  ${s.failed === true
                    ? html`<span class="queue-status is-error" role="status">${s.error ?? '发送失败'}</span>`
                    : html`<span class="codicon codicon-loading codicon-modifier-spin queue-spin" aria-hidden="true"></span>
                        <span class="queue-status" role="status">发送中…</span>`}
                </span>
              </li>`
            )}
          </ul>`
        : null}
    </div>
  </section>`
}
