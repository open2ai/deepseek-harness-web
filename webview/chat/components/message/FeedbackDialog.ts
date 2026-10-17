// 「提交反馈」卡（👍/👎 点开的那一张）：**内联显示在对话区下方**（不弹窗、不遮罩）。
//
// 文案逐条对照上游字典：
//   `dialog.title`「提交反馈」/ `dialog.categories`「反馈分类」/ `dialog.detail`「反馈详情」/
//   `dialog.hint`「填写详情以帮助我们改进体验，提交内容会包括当前对话的日志」/ `category.*` 七条 /
//   `toast.recorded`「感谢你的反馈」/ `error.conflict`·`error.noteTooLarge`·`error.generic` 三条。
//   「好的回答 / 有问题的回答」只属于**动作按钮**的 `action.like` / `action.dislike`（见 `FeedbackActions.ts`）。
//
// 一处有意的本地化：关掉的时机比上游多一条 —— **提交中不允许关**（上游靠控制器挡；这里由 `submitting` 挡）。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'

/** 分类 id → 中文标签（上游 `category.*` 字典原文；宿主下发的 id 认不出时回显 id 本身，不自造词）。 */
const CATEGORY_LABELS: Record<string, string> = {
  'task-result': '任务结果',
  'instruction-following': '指令理解与遵循',
  'product-interaction': '产品功能与交互',
  'service-stability': '稳定性和速度',
  'resource-cost': '资源使用与费用',
  'security-privacy-permission': '安全隐私与权限',
  other: '其他',
}

/**
 * 分类 chips 的**兜底顺序**（上游把七个分类写死在客户端：`CATEGORY_CHIPS` 是 `FeedbackCategory` 的完整记录）。
 * 宿主下发了目录就用宿主那份（顺序以宿主为准），没下发时用这里 —— 否则会渲染出一张**没有分类可选的空卡**。
 */
const FALLBACK_CATEGORIES = Object.keys(CATEGORY_LABELS)

export function FeedbackDialog({ store }: { store: ChatStore }) {
  const d = store.feedbackDialog.value
  if (d === null) return null
  const declared = store.feedbackCategories.value
  const categories = declared.length > 0 ? declared : FALLBACK_CATEGORIES
  const busy = d.submitting
  const close = (): void => {
    // 提交中不关：关掉等于把这次提交的反馈面丢掉（上游用控制器挡同一件事）
    if (!busy) store.closeFeedbackDialog()
  }
  const submit = (): void => store.submitFeedbackDialog()
  return html`<div class="fb-card" role="dialog" aria-label="提交反馈">
    <div class="fb-head">
      ${/* 标题是**固定**的「提交反馈」（上游 `dialog.title`）；「好的回答 / 有问题的回答」是**动作按钮**那两个
           tooltip（`action.like` / `action.dislike`） */ ''}
      <h2 class="fb-title">提交反馈</h2>
      <button type="button" class="fb-close" title="关闭" aria-label="关闭"
        disabled=${busy} onClick=${close}>
        <span class="codicon codicon-close"></span>
      </button>
    </div>
    <div class="fb-body">
      <div class="fb-cats" role="group" aria-label="反馈分类">
        ${categories.map((id) => html`<button type="button" key=${id}
          class=${'fb-chip' + (d.category === id ? ' active' : '')}
          aria-pressed=${d.category === id}
          disabled=${busy}
          onClick=${() => store.editFeedbackDialog({ category: d.category === id ? null : id })}>
          ${CATEGORY_LABELS[id] ?? id}
        </button>`)}
      </div>
      <textarea class="fb-detail" aria-label="反馈详情"
        placeholder="填写详情以帮助我们改进体验，提交内容会包括当前对话的日志"
        readOnly=${busy} value=${d.note}
        onInput=${(e: Event) => store.editFeedbackDialog({ note: (e.target as HTMLTextAreaElement).value })}></textarea>
      ${d.errorCode !== null
        ? html`<div class="fb-error" role="status">${
            d.errorCode === 'version-conflict'
              ? '这条反馈已在别处改动，已显示最新状态'
              : d.errorCode === 'note-too-large'
                ? '描述太长，请缩短后再提交'
                : '反馈保存失败'
          }</div>`
        : null}
    </div>
    <div class="fb-footer">
      <button type="button" class="fb-submit" disabled=${busy} onClick=${submit}>
        ${busy ? '正在提交…' : '提交'}
      </button>
    </div>
  </div>`
}
