// 宿主消息归约器：postMessage 单通道的唯一分发点。
// 只做「消息类型 → 切片方法」的路由与少量极短的载荷兜底；形状解析一律下沉到对应切片
// （投影解析在 status，输入区拼装在 composer）。
import type { HostToViewMessage, PermissionOption, QueueItemView } from '../protocol'
import { APPROVAL_FALLBACK_TEXT } from '../approval-text'
import type { ChatStore } from './types'
import type { MessagesSlice } from './messages'
import type { ComposerSlice } from './composer'
import type { CatalogsSlice } from './catalogs'
import type { SelectorsSlice } from './selectors'
import type { QuestionSlice } from './question'
import type { StatusSlice } from './status'
import type { PrefsSlice } from './prefs'
import type { AttachmentsSlice } from './attachments'
import type { OutboxSlice } from './outbox'
import type { FeedbackSlice } from './feedback'
import type { QueueSlice } from './queue'

export interface ReducerDeps {
  messages: MessagesSlice
  composer: ComposerSlice
  catalogs: CatalogsSlice
  selectors: SelectorsSlice
  question: QuestionSlice
  status: StatusSlice
  prefs: PrefsSlice
  attachments: AttachmentsSlice
  outbox: OutboxSlice
  feedback: FeedbackSlice
  queue: QueueSlice
  /** 清空全部切片（clear 帧）。 */
  reset(): void
}

export interface ReducerSlice {
  store: Pick<ChatStore, 'onHostMessage'>
}

/**
 * 从宿主行数组里取出用户行的提交标识。
 * 形状按宿主行模型只认 `kind`/`rpcId` 两个字段，认不出的行直接跳过（页面不解析宿主行的其余结构）。
 */
function userRpcIdsOf(rows: unknown): string[] {
  if (!Array.isArray(rows)) {
    return []
  }
  const out: string[] = []
  for (const r of rows) {
    if (r === null || typeof r !== 'object') {
      continue
    }
    const row = r as { kind?: unknown; rpcId?: unknown }
    if (row.kind === 'user' && typeof row.rpcId === 'string') {
      out.push(row.rpcId)
    }
  }
  return out
}

export function createReducer(deps: ReducerDeps): ReducerSlice {
  const { messages, composer, catalogs, selectors, question, status, prefs, attachments, outbox, feedback, queue, reset } = deps

  function onHostMessage(m: HostToViewMessage): void {
    switch (m.type) {
      case 'chatApproval':
        messages.pushApproval(m.approvalId ?? '', m.description ?? APPROVAL_FALLBACK_TEXT, m.toolName, m.displayReason)
        break
      case 'chatQuestion':
        // 上游 waterfall 提问弹窗（输入框上方）：pending 时置弹窗数据，用户选择/提交/取消/关闭。
        question.openQuestionDialog(m.rpcId, m.sessionId, m.questions ?? [], m.callId)
        break
      case 'questionClosed':
        question.closeQuestion(m.rpcId)
        break
      // 账号类提示（宿主按上游 locale 给全文案）：直接落成对话区一行，页面不翻译
      case 'notice':
        if (m.text) messages.store.showNotice(m.text, undefined, m.tone ?? 'error')
        break
      case 'chatError':
        // 本地提交失败（没有回合、没有行）：标掉那条乐观行并给错误，避免输入区一直卡在「处理中」。
        // scope='queue' 是**忙时提交失败**：那条消息还没有回合，正在跑的是别人的回合 ——
        // 只标队列卡里那条「发送中」，绝不把对话区里未定稿的回答行定稿成错误。
        if (m.scope === 'queue') {
          queue.failSending(m.rpcId, m.message ?? '发送失败')
          break
        }
        messages.failSubmission(m.rpcId, m.message ?? '发送失败')
        break
      // 排队消息（整表替换）：队列不是行，它自持在队列切片里（见 store/queue）
      case 'queue':
        queue.applyQueue(m.sessionId, (m.items ?? []) as QueueItemView[])
        break
      case 'queueActionFailed':
        queue.showActionFailure(m.op, m.code)
        break
      // 上下文占用（发送按钮左侧的环）：单独一条轻帧（投影值小，不必随 chatInfo 重推整串）
      case 'context':
        status.applyContext(m.pressure, m.breakdown)
        break
      // 会话投影整表（会话统计 / token 用量 / plan / goal…）：与上下文分开一条，
      // 因为它一变就要重推整个整表、而环只要那两个字段。**整表语义**：直接替换。
      case 'projections':
        status.applyProjections(m.values ?? {})
        // 迟到回答：投影里的 `userQuestions` 决定「哪些限时提问还能补答」（拿不到就是没有）
        question.applyLateQuestions(m.values ?? {})
        break
      case 'attachmentBytes':
        attachments.receiveAttachment(
          m.attachmentId,
          m.error !== undefined || (m.mediaType ?? '') === '' || (m.data ?? '') === ''
            ? { state: 'error', error: m.error ?? '图片字节为空' }
            : { state: 'ready', mediaType: m.mediaType as string, data: m.data as string }
        )
        break
      case 'fileUploaded':
        composer.receiveUpload(m.key, m)
        break
      case 'filePicked':
        if (m.path) composer.store.addAttachment(m.path)
        break
      case 'chatInfo': {
        status.store.sessionCwd.value = m.cwd ?? ''
        const proj = m.projections
        if (proj) {
          // 权限是选择器的域，cast 极短，留在归约器；统计行/plan/goal 的形状解析下沉到 status
          const perms = proj['permissions'] as { options?: PermissionOption[]; currentValue?: string } | undefined
          selectors.setPermOptions(perms?.options, perms?.currentValue)
          status.applyProjections(proj)
          question.applyLateQuestions(proj)
        }
        selectors.setModels(m.models)
        selectors.setModes(m.agentPresets, m.agentPreset, m.agentPresetLocked)
        // 会话建立/切换后预取「/」目录：把「目录未到即发 /xxx」的窗口压到最小（换会话 reset 已把目录清空）
        if (catalogs.needsSlashList()) {
          catalogs.store.requestSlashList()
        }
        break
      }
      case 'chatPrefs':
        // 全局偏好（四项）：只改展示/键位，不动会话数据
        prefs.apply(m)
        break
      case 'rows':
        // 宿主下发的行（阶段 4，见 docs/design/08 §11）：渲染源切到宿主侧
        messages.applyHostRows(m.rows, m.sessionId, m.turnActive)
        // 窗口分页事实（「加载更早」按钮的门与进行态）：跟同一帧下发，页面只做镜像
        messages.applyHistory({ hasMore: m.historyHasMore, loading: m.historyLoading, events: m.historyEvents })
        // 队列卡的本地「发送中」也按提交标识认领：这次提交可能落在对话流（空闲）或队列（忙时），
        // 两条路都以同一个 `rpcId` 回显 —— 只认队列帧的话，竞态下会有一条「发送中」永远挂着。
        // 同时记下「日志里已落账」的标识：pending 插话气泡据此去重（队列帧可能比行帧慢一帧）。
        queue.noteDurable(userRpcIdsOf(m.rows))
        // 反馈是**按会话**的：会话一变就丢弃上一会话的评价，否则标记会串到新会话的行上
        feedback.onSession(m.sessionId)
        // 本轮已结束（宿主说不在跑）→ 仍挂着的提问不可能还有效，收起弹窗。
        // 上游**没有** resolved 类事件（只有 `user-questions/request`），弹窗的存活期只能由**回合生命周期**兜住；
        // 不关的话用户点关闭会去取消一个已解决的提问 —— 报「未找到对应的提问」并把整轮又停一次（真机现象）。
        if (m.turnActive === false) {
          question.reset()
        }
        break
      case 'todos':
        // 任务清单（输入框上方的常驻条）：宿主已折好，页面只整表替换
        status.applyTodos(m.todos)
        break
      case 'feedbackState':
        // 消息反馈的列表/写入结果：全部交给反馈切片自行解释（含按会话丢弃迟到回帧）
        feedback.apply(m)
        break
      case 'draft':
        composer.appendDraft(m.text)
        break
      case 'clear':
        reset()
        break
      case 'busy':
        status.store.busy.value = m.kind ?? null
        break
      case 'slashCatalog':
        catalogs.receiveSlashCatalog(m.commands, m.skills)
        // 目录到达后：裁决目录未到时挂起的「/」行(命令→执行，其余→普通消息)
        outbox.resolvePendingSlash()
        break
      case 'atCatalog':
        catalogs.receiveAtCatalog(m.query, m.files, m.sessions)
        break
      case 'slashResult':
        // 命令结果一律进对话区(不走 VSCode 通知)：失败红点+红字，成功正常色
        if (m.message) messages.store.showNotice(m.message, m.command, m.ok === false ? 'error' : 'ok')
        break
      // 标题栏消息归 titlebar(入口另行路由),本 store 忽略
      case 'panelState':
      case 'selfInfo':
      case 'wsDropdownList':
      case 'wsDropdownSessions':
      case 'wsActionDone':
        break
    }
  }

  return { store: { onHostMessage } }
}
