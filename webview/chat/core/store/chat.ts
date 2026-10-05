// 聊天页核心状态(信号 store)的装配层：只做切片创建与接线，不含行为逻辑。
// 行模型在 messages，输入区在 composer，目录在 catalogs，选择器在 selectors，提问弹窗在 question，
// 会话状态在 status，全局显示偏好在 prefs，发送动作在 outbox，宿主消息归约器在 reducer；
// 跨切片依赖全部由本层注入（切片之间不互相 import）。
// 组件只读 store 上的信号并渲染;要发宿主一律走 store 动作(内部 host.post)。
import type { ChatHost } from '../host'
import { MODE_NAMES } from '../format'
import { createMessages } from './messages'
import { createComposer } from './composer'
import { createCatalogs } from './catalogs'
import { createSelectors } from './selectors'
import { createQuestion } from './question'
import { createAttachments } from './attachments'
import { createStatus } from './status'
import { createPrefs } from './prefs'
import { createOutbox } from './outbox'
import { createFeedback } from './feedback'
import { createQueue } from './queue'
import { createReducer } from './reducer'
import type { ChatStore } from './types'

// 行模型与 store 接口的对外导出保持不变(定义在 ./types)。
export type {
  ChatRow,
  ChatStore,
  DshTurnProcessItem,
  RefChip,
  SelectorState,
  SessionStatsView,
  TokenUsageView,
  TurnCounts,
} from './types'

export { MODE_NAMES }

export function createChatStore(host: ChatHost): ChatStore {
  // 1. 消息行模型：selectors 的通知行要用它的 showNotice，须最先创建
  const messages = createMessages(host)

  // 2. 其余叶切片（selectors 注入消息切片的 showNotice，不反向 import）
  const composer = createComposer(host)
  const catalogs = createCatalogs(host)
  const status = createStatus(host)
  const selectors = createSelectors(host, messages.store.showNotice)
  const question = createQuestion(host)
  const attachments = createAttachments(host)
  // 队列卡：它不是行（见 store/queue 文件头）。失败提示借用消息切片的通知行（与 selectors 同一注入方式）
  const queue = createQueue(host, (text) => messages.store.showNotice(text))
  // 显示偏好：全局量，故不参与下面的 reset（见 store/prefs 文件头）
  const prefs = createPrefs()

  // 3. 发送动作（跨输入区 + 目录 + 消息域 + 队列卡，依赖注入）
  const outbox = createOutbox({ host, composer, catalogs, messages, queue })
  // 消息反馈：与其它切片无 import 边，装配层直接持有
  const feedback = createFeedback(host)

  // 4. 全量清空：跨切片唯一入口。各切片只清自己的量，这里按固定顺序串联。
  //    不含 prefs：上游显示形态是全局偏好，换会话不该重置。
  const reset = (): void => {
    messages.resetRows()
    composer.reset()
    status.reset()
    selectors.reset()
    catalogs.reset()
    question.reset()
    attachments.reset()
    feedback.reset()
    queue.reset()
  }

  // 5. 归约器（宿主消息 → 各切片；需要 reset 做全量清空）
  const reducer = createReducer({ messages, composer, catalogs, selectors, question, status, attachments, prefs, outbox, feedback, queue, reset })

  // 显式列举装配（不用展开）：字段漏装配被返回类型拦截，字段重复在编译期直接报错。
  return {
    // 消息域
    messages: messages.store.messages,
    view: messages.store.view,
    processing: messages.store.processing,
    turnRunning: messages.store.turnRunning,
    scrollPend: messages.store.scrollPend,
    historyHasMore: messages.store.historyHasMore,
    historyLoading: messages.store.historyLoading,
    historyEvents: messages.store.historyEvents,
    sessionOpenError: messages.store.sessionOpenError,
    applyHistory: messages.store.applyHistory,
    loadOlder: messages.store.loadOlder,
    showNotice: messages.store.showNotice,
    openFile: messages.store.openFile,
    answerApproval: messages.store.answerApproval,
    // 回合级过程折叠的展开态（同回合多段行共享）
    turnFoldOpen: messages.turnFoldOpen,
    setTurnFoldOpen: messages.setTurnFoldOpen,
    // **片**级过程折叠的展开态（B′：按片渲染时各片独立；键 `${turn}:${group.key}`）
    groupFoldOpen: messages.groupFoldOpen,
    setGroupFoldOpen: messages.setGroupFoldOpen,
    // **外层折叠**（上游 `turnProcesses {turn, answerStep}`）：每回合"已唤出到哪个回答世代"
    outerAnswerStep: messages.outerAnswerStep,
    revealOuter: messages.revealOuter,
    foldOuter: messages.foldOuter,
    // 发送动作
    send: outbox.store.send,
    suggestion: outbox.store.suggestion,
    forkAt: outbox.store.forkAt,
    // 消息反馈（👍/👎）
    feedbackItems: feedback.store.feedbackItems,
    feedbackDialog: feedback.store.feedbackDialog,
    feedbackToast: feedback.store.feedbackToast,
    feedbackCategories: feedback.store.feedbackCategories,
    ensureFeedbackLoaded: feedback.store.ensureFeedbackLoaded,
    chooseFeedback: feedback.store.chooseFeedback,
    editFeedbackDialog: feedback.store.editFeedbackDialog,
    submitFeedbackDialog: feedback.store.submitFeedbackDialog,
    closeFeedbackDialog: feedback.store.closeFeedbackDialog,
    // 归约器
    onHostMessage: reducer.store.onHostMessage,
    // 输入区切片
    text: composer.store.text,
    attachments: composer.store.attachments,
    images: composer.store.images,
    refs: composer.store.refs,
    focusTick: composer.store.focusTick,
    runSlash: composer.store.runSlash,
    pickFile: composer.store.pickFile,
    copy: composer.store.copy,
    cancel: composer.store.cancel,
    addImage: composer.store.addImage,
    removeImage: composer.store.removeImage,
    addAttachment: composer.store.addAttachment,
    removeAttachment: composer.store.removeAttachment,
    retryUpload: composer.store.retryUpload,
    addRef: composer.store.addRef,
    removeRef: composer.store.removeRef,
    readImageFile: composer.store.readImageFile,
    // 目录切片
    slashCatalog: catalogs.store.slashCatalog,
    atCatalog: catalogs.store.atCatalog,
    requestSlashList: catalogs.store.requestSlashList,
    needsSlashList: catalogs.store.needsSlashList,
    requestAtList: catalogs.store.requestAtList,
    // 选择器切片
    sel: selectors.store.sel,
    permNameOf: selectors.store.permNameOf,
    openPopup: selectors.store.openPopup,
    togglePopup: selectors.store.togglePopup,
    openModelSearch: selectors.store.openModelSearch,
    markSlashPick: selectors.store.markSlashPick,
    closePopups: selectors.store.closePopups,
    selectPerm: selectors.store.selectPerm,
    selectModel: selectors.store.selectModel,
    selectMode: selectors.store.selectMode,
    openModeConfig: selectors.store.openModeConfig,
    // 提问切片
    pendingQuestion: question.store.pendingQuestion,
    lateCalls: question.store.lateCalls,
    lateDraft: question.store.lateDraft,
    canAnswerLate: question.store.canAnswerLate,
    openLateDraft: question.store.openLateDraft,
    closeLateDraft: question.store.closeLateDraft,
    submitLateAnswer: question.store.submitLateAnswer,
    submitQuestion: question.store.submitQuestion,
    cancelQuestion: question.store.cancelQuestion,
    // 会话状态切片
    busy: status.store.busy,
    sessionCwd: status.store.sessionCwd,
    sessionStats: status.store.sessionStats,
    tokenUsage: status.store.tokenUsage,
    // 上下文占用（发送按钮左侧的环）：与统计两张卡同源（投影），但走单独一条轻帧
    contextFacts: status.store.contextFacts,
    planState: status.store.planState,
    // 附件大类
    attachmentCache: attachments.store.attachmentCache,
    requestAttachment: attachments.store.requestAttachment,
    goalState: status.store.goalState,
    // process-local 的激活（另一条来路：宿主 `goals/get` + `goal/activation-changed`）——
    // 目标条按 `(id, revision)` 与上面的投影对账后才用
    goalActivation: status.store.goalActivation,
    // 目标条的动作（edit/pause/resume/clear）：请求-应答，见 store/status 的 goalAction
    goalAction: status.store.goalAction,
    // 任务清单（输入框上方的常驻条）
    todos: status.store.todos,
    // 排队消息（输入框上方的队列卡）：与清单同级，但**不是行**
    queueItems: queue.store.queueItems,
    queueSending: queue.store.queueSending,
    queueEditing: queue.store.queueEditing,
    queueBusy: queue.store.queueBusy,
    // 对话区末尾的 pending 插话气泡（队列卡只列排队项；插话在对话区等被取用）
    pendingSteering: queue.store.pendingSteering,
    editQueueItem: queue.store.editQueueItem,
    saveQueueEdit: queue.store.saveQueueEdit,
    cancelQueueEdit: queue.store.cancelQueueEdit,
    removeQueueItem: queue.store.removeQueueItem,
    steerQueueItem: queue.store.steerQueueItem,
    steerWholeQueue: queue.store.steerWholeQueue,
    // 全局偏好（上游「设置 → 通用设置」四项）
    transcriptView: prefs.store.transcriptView,
    performanceUsage: prefs.store.performanceUsage,
    developerTools: prefs.store.developerTools,
    busyEnter: prefs.store.busyEnter,
    settledReasoningPreview: prefs.store.settledReasoningPreview,
    liveProcessDetail: prefs.store.liveProcessDetail,
    stepGrouping: prefs.store.stepGrouping,
    // 渲染源开关（阶段 4：宿主下发，见 docs/design/08 §11）
  }
}
