// 消息反馈切片（👍/👎）：与上游 `ui-message-feedback` 同口径的取值与判定。
//
// **一条评价从不直接提交**（上游同）：点👍/👎只是打开「提交反馈」弹窗，提交时才写入；
// 唯一的例外是**再点同一个** —— 那是撤回，直接删（不开弹窗、也不弹提示）。
// 目标消息用宿主的行模型带下来的 `messageId`（上游 `AssistantActionOwnerProps.messageId`）。

// 懒加载：反馈表在**首次悬停/聚焦**这两个按钮时才读（上游同）。所以「点第一下」可能还没有表 ——
// 那时先把这次点击挂起，等表回来再判定，否则会把「已记录同一评价」误当成首次评价而弹窗。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { FeedbackRating } from '../protocol'
import type { ChatStore } from './types'

export interface FeedbackEntry {
  rating: FeedbackRating
  version: string
}

export interface FeedbackDialogState {
  messageId: string
  rating: FeedbackRating
  category: string | null
  note: string
  submitting: boolean
  errorCode: string | null
}

export interface FeedbackToastState {
  text: string
  tone: 'ok' | 'error'
  /** 递增标识：同一条文案连续弹两次也要能重新触发计时 */
  id: number
}

export interface FeedbackSlice {
  store: Pick<ChatStore, 'feedbackItems' | 'feedbackDialog' | 'feedbackToast' | 'feedbackCategories' | 'ensureFeedbackLoaded' | 'chooseFeedback' | 'editFeedbackDialog' | 'submitFeedbackDialog' | 'closeFeedbackDialog'>
  /** 宿主 `feedbackState` 帧到达。 */
  apply(state: {
    sessionId?: string
    items?: Array<{ messageId: string; rating: FeedbackRating; version: string }>
    categories?: string[]
    errorCode?: string
    recorded?: boolean
  }): void
  /** 页面拿到「本批行属于哪个会话」时对齐：会话一变就丢弃上一会话的反馈（否则标记会串）。 */
  onSession(sessionId: string | undefined): void
  reset(): void
}

/** 业务失败码 → 用户文案（上游字典原文；认不出的码走通用文案，不自己造词）。 */
function failureText(code: string | undefined): string {
  if (code === 'version-conflict') return '这条反馈已在别处改动，已显示最新状态'
  if (code === 'note-too-large') return '描述太长，请缩短后再提交'
  return '反馈保存失败'
}

export function createFeedback(host: ChatHost): FeedbackSlice {
  const items = signal<ReadonlyMap<string, FeedbackEntry>>(new Map())
  const dialog = signal<FeedbackDialogState | null>(null)
  const toast = signal<FeedbackToastState | null>(null)
  const categories = signal<readonly string[]>([])
  /** 本会话的反馈表是否已读过（读失败也置真：否则每次悬停都会重读一遍） */
  let loaded = false
  let loading = false
  let session: string | undefined
  let toastSeq = 0
  /** 冷行上的第一次点击：等表回来再判定（见文件头） */
  let pendingChoice: { messageId: string; rating: FeedbackRating } | null = null

  function pushToast(text: string, tone: 'ok' | 'error'): void {
    toastSeq += 1
    toast.value = { text, tone, id: toastSeq }
  }

  function ensureLoaded(): void {
    if (loaded || loading) return
    loading = true
    host.post({ type: 'feedback', op: 'list' })
  }

  /** 拿到表之后的真正判定：同一评价 = 撤回，否则开弹窗。 */
  function decide(messageId: string, rating: FeedbackRating): void {
    const current = items.value.get(messageId)
    if (current !== undefined && current.rating === rating) {
      host.post({ type: 'feedback', op: 'retract', messageId, ifVersion: current.version })
      return
    }
    dialog.value = { messageId, rating, category: null, note: '', submitting: false, errorCode: null }
  }

  function choose(messageId: string, rating: FeedbackRating): void {
    if (!loaded) {
      pendingChoice = { messageId, rating }
      ensureLoaded()
      return
    }
    decide(messageId, rating)
  }

  function editFeedbackDialog(patch: { category?: string | null; note?: string }): void {
    const current = dialog.value
    if (current === null) return
    dialog.value = { ...current, ...patch }
  }

  function submitFeedbackDialog(): void {
    const current = dialog.value
    if (current === null || current.submitting) return
    dialog.value = { ...current, submitting: true, errorCode: null }
    const note = current.note.trim()
    host.post({
      type: 'feedback',
      op: 'rate',
      messageId: current.messageId,
      rating: current.rating,
      ...(note === '' ? {} : { note }),
      ...(current.category === null ? {} : { category: current.category }),
      // 版本取**当前已知**的那条：没有就是 null（要求服务端确认此刻确实没有）
      ifVersion: items.value.get(current.messageId)?.version ?? null,
    })
  }

  function closeFeedbackDialog(): void {
    dialog.value = null
  }

  function apply(state: {
    sessionId?: string
    items?: Array<{ messageId: string; rating: FeedbackRating; version: string }>
    categories?: string[]
    errorCode?: string
    recorded?: boolean
  }): void {
    if (state.sessionId !== undefined && session !== undefined && state.sessionId !== session) {
      // 迟到的上一会话回帧：直接丢，别把它的评价标到当前会话的行上
      loading = false
      return
    }
    if (state.categories !== undefined) categories.value = state.categories
    if (state.items !== undefined) {
      items.value = new Map(state.items.map((i) => [i.messageId, { rating: i.rating, version: i.version }]))
      loaded = true
      loading = false
      if (pendingChoice !== null) {
        const choice = pendingChoice
        pendingChoice = null
        // 表已就绪，回放那次点击（此刻才判得出「同一评价 = 撤回」）
        decide(choice.messageId, choice.rating)
      }
    }
    if (state.errorCode !== undefined) {
      const text = failureText(state.errorCode)
      const open = dialog.value
      if (open !== null) {
        // 弹窗还开着：把失败留在弹窗里（上游同 —— 弹窗不关，只在弹窗里报）
        dialog.value = { ...open, submitting: false, errorCode: state.errorCode }
      } else {
        pushToast(text, 'error')
      }
      return
    }
    if (state.recorded === true) {
      // 成功：弹窗只在「它的那次提交仍是最新」时关闭（上游按 generation 判；这里同义）
      if (dialog.value?.submitting === true) dialog.value = null
      pushToast('感谢你的反馈', 'ok')
    }
  }

  function onSession(sessionId: string | undefined): void {
    if (session === sessionId) return
    session = sessionId
    // 换会话：上一会话的评价、弹窗、挂起的点击全部作废
    items.value = new Map()
    dialog.value = null
    loaded = false
    loading = false
    pendingChoice = null
  }

  function reset(): void {
    items.value = new Map()
    dialog.value = null
    toast.value = null
    loaded = false
    loading = false
    pendingChoice = null
  }

  return {
    store: {
      feedbackItems: items,
      feedbackDialog: dialog,
      feedbackToast: toast,
      feedbackCategories: categories,
      ensureFeedbackLoaded: ensureLoaded,
      chooseFeedback: choose,
      editFeedbackDialog,
      submitFeedbackDialog,
      closeFeedbackDialog,
    },
    apply,
    onSession,
    reset,
  }
}
