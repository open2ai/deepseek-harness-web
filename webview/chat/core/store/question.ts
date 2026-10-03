// 提问弹窗切片：上游 waterfall 交互（输入框上方）的 pending 数据与应答；
// 外加**迟到回答**（限时提问超时后的补答）的清单、草稿与提交。
// 与消息行上的提问「记录」行无关（那部分在聚合层的消息域）。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { QuestionSpec } from '../protocol'
import { continuedCallsOf, type LateAnswerCall, type LateAnswerItem } from '../late-answer'
import type { ChatStore } from './types'

/** 正在补答的那一条（非 null 时提问弹窗进入补答模式）。 */
export interface LateDraft {
  callId: string
  questions: LateAnswerCall['questions']
}

export interface QuestionSlice {
  store: Pick<
    ChatStore,
    | 'pendingQuestion'
    | 'submitQuestion'
    | 'cancelQuestion'
    | 'lateCalls'
    | 'lateDraft'
    | 'canAnswerLate'
    | 'openLateDraft'
    | 'closeLateDraft'
    | 'submitLateAnswer'
  >
  /** chatQuestion 帧到达：置弹窗数据（`callId` 只在限时提问上有）。 */
  openQuestionDialog(
    rpcId: string | undefined,
    sessionId: string | undefined,
    questions: QuestionSpec[],
    callId?: string
  ): void
  /** questionClosed 帧到达：关闭弹窗。 */
  closeQuestion(rpcId: string | undefined): void
  /** 投影整表 / chatInfo 到达：刷新「仍可补答」的调用清单。 */
  applyLateQuestions(values: Record<string, unknown> | undefined): void
  reset(): void
}

export function createQuestion(host: ChatHost): QuestionSlice {
  const pendingQuestion = signal<{ rpcId?: string; sessionId?: string; questions: QuestionSpec[]; callId?: string } | null>(null)
  /** 仍可补答的调用（投影 `userQuestions` 的 `active` 里 `state === 'continued'` 的那些）。 */
  const lateCalls = signal<LateAnswerCall[]>([])
  /** 正在补答的那一条；非 null 时提问弹窗进入补答模式。 */
  const lateDraft = signal<LateDraft | null>(null)
  /** 本面板刚提交过补答的调用（投影还没收敛前先把入口收起来，避免重复提交撞上「已在队列」）。 */
  const lateSubmitted = new Set<string>()

  function openQuestionDialog(
    rpcId: string | undefined,
    sessionId: string | undefined,
    questions: QuestionSpec[],
    callId?: string
  ): void {
    pendingQuestion.value = { rpcId, sessionId, questions, ...(callId === undefined ? {} : { callId }) }
  }
  function submitQuestion(
    key: number,
    rpcId: string | undefined,
    sessionId: string | undefined,
    answers: Array<{ id: string; selected: string[]; custom?: string }>
  ): void {
    void key
    pendingQuestion.value = null // 回答后关闭弹窗
    host.post({ type: 'questionResponse', rpcId, sessionId, answers })
  }
  function cancelQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined): void {
    void key
    pendingQuestion.value = null // 取消/关闭后收起弹窗
    host.post({ type: 'questionCancel', rpcId, sessionId })
  }
  function closeQuestion(rpcId: string | undefined): void {
    // waterfall 提问确认后关闭（清除历史独立 question 行兜底 + 弹窗）
    void rpcId
    pendingQuestion.value = null
  }

  function reset(): void {
    pendingQuestion.value = null
    lateCalls.value = []
    lateDraft.value = null
    lateSubmitted.clear()
  }

  /**
   * 投影整表 / `chatInfo` 到达：刷新「仍可补答」的调用清单。
   *
   * 顺带做两件**必须**跟着投影走的事：
   *   ① 弹窗对应那条**已经超时转入可补答**时把它关掉 —— 那条提问不能再从弹窗回答了（超时后
   *      只有补答通道接受作答），留着就是个点了会报错的死弹窗；
   *   ② 草稿对应的那条已经不在清单里（本面板/网页端答过、或已结算）→ 收起草稿。
   */
  function applyLateQuestions(values: Record<string, unknown> | undefined): void {
    const calls = continuedCallsOf(values?.['userQuestions'])
    lateCalls.value = calls
    const pendingCallId = pendingQuestion.value?.callId
    if (pendingCallId !== undefined && calls.some((call) => call.callId === pendingCallId)) {
      pendingQuestion.value = null
    }
    const draft = lateDraft.value
    if (draft !== null && !calls.some((call) => call.callId === draft.callId)) {
      lateDraft.value = null
    }
  }

  /** 某条调用是否**当前**该显示补答入口（已提交过的先收起来，等投影收敛）。 */
  function canAnswerLate(callId: string): boolean {
    return !lateSubmitted.has(callId) && lateCalls.value.some((call) => call.callId === callId)
  }

  /** 点提问卡上的「回答」：把该条的问题清单放进草稿（没有这条就什么都不做）。 */
  function openLateDraft(callId: string): void {
    const call = lateCalls.value.find((entry) => entry.callId === callId)
    if (call === undefined) return
    lateDraft.value = { callId: call.callId, questions: call.questions }
  }
  function closeLateDraft(): void {
    lateDraft.value = null
  }
  /** 提交补答：先收起草稿（本地 UI 不依赖服务端），作答经宿主走另一条远端调用。 */
  function submitLateAnswer(callId: string, answers: LateAnswerItem[]): void {
    lateDraft.value = null
    lateSubmitted.add(callId)
    host.post({ type: 'questionLateAnswer', callId, answers })
  }

  return {
    store: {
      pendingQuestion,
      submitQuestion,
      cancelQuestion,
      lateCalls,
      lateDraft,
      canAnswerLate,
      openLateDraft,
      closeLateDraft,
      submitLateAnswer,
    },
    openQuestionDialog,
    closeQuestion,
    applyLateQuestions,
    reset,
  }
}
