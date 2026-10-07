// 行动作条里的消息反馈入口（👍/👎）：与上游 MessageFeedbackActions 同判定。
//
// 两个按钮**只在悬停/聚焦时**触发一次反馈表读取（懒加载）—— 每条定稿消息都挂这个控件，
// 挂载即读会把整个会话的反馈表在同一瞬间拉多遍（上游同此取舍）。
// 已记录的那一侧用 `.active` 常显（不靠 hover），文案换成「取消标记」。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'
import type { FeedbackRating } from '../../core/protocol'
import { ThumbDownIcon, ThumbUpIcon } from './ThumbIcons'

export function FeedbackActions({ store, messageId }: { store: ChatStore; messageId: string }) {
  const rating = store.feedbackItems.value.get(messageId)?.rating
  const button = (kind: FeedbackRating, label: string, activeLabel: string, icon: (filled: boolean) => unknown) => {
    const active = rating === kind
    return html`<button data-act=${kind === 'positive' ? 'like' : 'dislike'}
      class=${'fb-btn' + (active ? ' active' : '')}
      aria-pressed=${active}
      title=${active ? activeLabel : label} aria-label=${active ? activeLabel : label}
      onFocus=${() => store.ensureFeedbackLoaded()}
      onPointerEnter=${() => store.ensureFeedbackLoaded()}
      onClick=${() => store.chooseFeedback(messageId, kind)}>
      ${icon(active)}
    </button>`
  }
  // 字形照搬上游 artwork（见 ThumbIcons.ts）：未评线稿、已评实心，指针离开后仍看得出评过
  return html`<span class="fb-actions">
    ${button('positive', '好的回答', '取消标记', (filled) => html`<${ThumbUpIcon} filled=${filled} />`)}
    ${button('negative', '有问题的回答', '取消标记', (filled) => html`<${ThumbDownIcon} filled=${filled} />`)}
  </span>`
}
