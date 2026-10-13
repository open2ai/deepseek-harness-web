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
import { buildChatNodesIncremental, type NodesCheckpoint } from '../nodes/chat-nodes'
import { nodesToRows, nodesToSeatRows } from '../nodes/render-plan'
import { resetNodeKeyMap, rowKeyOfNodeKey, toChatRowsFromNodes } from './node-rows'
import type { ChatNodeModel, SessionEvent } from '../nodes/types'

/**
 * **行帧的拼装缓存**（§3.3 的"只发变动的行"）：宿主只发变动的行 + 全量 `rowKeys`，
 * 页面按 `key` 覆盖缓存、再按 `rowKeys` 拼回渲染顺序 —— 结果与"宿主发整表"逐字节等价。
 *
 * 缓存放在**摄入边界**（这里）而不向下改 `applyHostRows` 的契约：乐观行认领、去重那些逻辑
 * 一行不动，照旧看到"整表"。
 */
let rowCache = new Map<number, unknown>()
let rowCacheSession: string | undefined

/**
 * **节点模型（渲染源切换）**：宿主 `chatEvents` 帧 → `buildChatNodes` 的产物。
 * `USE_NODE_MODEL` 开时渲染列表从它取；关时 `rows` 帧仍是渲染源（影子对照）。
 */
let chatNodeModel: ChatNodeModel | undefined
const USE_NODE_MODEL = true
let nodeRowsSessionId: string | undefined

/** 把帧上的保结构事件原文归一化成节点模型的 SessionEvent。 */
function normalizeEvents(events: unknown): SessionEvent[] {
    if (!Array.isArray(events)) return []
    const out: SessionEvent[] = []
    for (const e of events) {
        if (e === null || typeof e !== 'object') continue
        const rec = e as Record<string, unknown>
        out.push({
            seq: typeof rec['seq'] === 'number' ? rec['seq'] : 0,
            time: typeof rec['time'] === 'number' ? rec['time'] : 0,
            type: typeof rec['type'] === 'string' ? rec['type'] : '',
            data: (rec['data'] ?? {}) as Record<string, unknown>,
            ...(rec['frame'] === undefined ? {} : { frame: rec['frame'] as Record<string, unknown> }),
            ...(rec['surfaceOp'] === undefined ? {} : { surfaceOp: rec['surfaceOp'] }),
        })
    }
    return out
}

/**
 * **事件帧的摄入缓存 + 断点续折**（2026-10-12）。
 *
 * 原先这一格是两件 O(全量) 的事，每帧都做一遍：
 *   ① `normalizeEvents(events)` —— 把整份窗口（真机最大那份 **130 万条**）重新归一化成**新对象**；
 *   ② `buildChatNodes(全部)` —— 再从零折一遍。
 * 两者都随窗口线性涨，而流式期间每帧真正新增的只有几条到几十条。
 *
 * 现在：归一化结果**按窗口增量扩展**（旧对象复用），折叠走 `buildChatNodesIncremental`
 * （只重折**最后一条 `turn/start`** 之后的那一段）。两者都只在"窗口头变了 / 变短了 / 换会话"
 * 时整表重建 —— 那正是历史前插、压缩替换、换会话这三种情形（上游也在这些点重建）。
 *
 * ⚠️ **2026-10-12 修：这两格缓存不能再放在模块级**（原先就在这一行 `let`）。它们是**每个 store 各一份**
 * 的状态，放模块级会被"同一页面里新建的 store"复用 —— 而失效判据只有"头 seq + 长度"，
 * **同头同长而内容不同**时直接命中缓存。真机形状：两个会话的窗口都从 `seq 1` 起、长度也相同
 *（换会话；测试里连续挂载不同夹具更是必然）。现象是"新会话渲染出上一份窗口的内容"：
 * 守卫 `tmp/_doneline.wiring.dom.test.mjs`【5】就是这么红的 —— 被停止的那条夹具渲染成了上一份
 * 「已完成，用时 45秒」的文案还带着箭头。现已挪进 `createReducer` 的闭包（见那里）。
 */

/**
 * 把帧上的事件归一化进缓存：**只归一化新增的那一段**，前缀复用上一次的对象。
 *
 * 复用对象的理由：这些是**保结构快照**的同一份内容，帧之间不会就地改写；而 `buildChatNodes`
 * 只读不写。若哪天真要写，这条注释就是提醒：那时必须改成复制。
 *
 * ⚠️ **2026-10-12 改成"缓存进、缓存出"**（原来是模块级 `let`，见下面 `createReducer` 里的说明）：
 * 缓存必须跟着**store**走，否则新建 store（换会话 / 测试里连续挂载不同夹具）会复用上一份窗口。
 *
 * @param cache - 本 store 上一次的归一化缓存（首个帧传空数组）。
 * @param events - 帧上的保结构事件原文。
 * @param replaced - 宿主是否声明"窗口被整份换过"。
 * @returns 归一化后的**整段**数组与新的缓存。
 */
function ingestEvents(
    state: { events: SessionEvent[]; session: string | undefined },
    sessionId: string | undefined,
    events: unknown,
    replaced: boolean
): { evs: SessionEvent[]; state: { events: SessionEvent[]; session: string | undefined }; rebuilt: boolean } {
    if (!Array.isArray(events)) return { evs: [], state, rebuilt: false }
    const cache = state.events
    /**
     * 失效判据（**四件都要看**，2026-10-12 补齐后三件）：
     *   ① 宿主说"窗口被整份换过"（`replaced`）；
     *   ② **换会话**（`sessionId` 变了）—— 两个会话的窗口都从 `seq 1` 起是常态，光看头会串窗口；
     *   ③ 头 seq 变了 / **没有变长** —— 帧契约是"整表替换"，同头同长而内容不同必须重建
     *      （`tmp/_rows.delta.dom.test.mjs`【2】的"第二帧整表替换：正文跟着变"就是这个形状）；
     *   ④ **前缀确实是前缀** —— 缓存最后一条与来帧同位置的 `seq`/`type` 对得上，才敢把尾巴接上去
     *      （否则是把两份不同窗口缝在一起，`tmp/_rows.delta.dom.test.mjs`【3】的会话切换就是这么坏的）。
     * 全中才走"只归一化新增那几条"的增量路；任意一条不中 → 整表重建。
     */
    const last = cache[cache.length - 1]
    const at = cache.length - 1
    const incoming = at >= 0 && at < events.length ? (events[at] as { seq?: unknown; type?: unknown } | null) : null
    const prefixMatches = last !== undefined && incoming !== null && incoming !== undefined
        && incoming.seq === last.seq && incoming.type === last.type
    /**
     * ⚠️ **回退帧整帧忽略**（2026-10-12 加，真机"在编辑区打开后顺序一会乱"）。
     *
     * 页面把 `chatEvents` 当**整表替换**，所以一份**更旧的窗口**会把更新的画面顶掉：
     * 真机形状 —— 新建编辑区面板时宿主会把窗口推给**所有** webview，而两个实例各自可能先收到
     * 自己那一版（侧栏在流式、面板刚恢复），谁后收到旧版谁就退回去 ⇒ 两边**各显示一个版本**。
     * 实测（`tmp/_twostore.order.test.mjs`【D】）：行数 82 → 4、末行被换。
     *
     * 判据：**同一会话内窗口只许向前** —— 来帧的尾 `seq` 不比缓存小（同头时）。
     * 宁可少收一帧（下一帧就会补上），也不要让画面倒退。
     */
    const tailSeq = (list: readonly { seq?: number }[]): number | undefined => {
        const s = list[list.length - 1]?.seq
        return typeof s === 'number' ? s : undefined
    }
    const cachedTail = tailSeq(cache)
    const incomingTail = tailSeq(events as readonly { seq?: number }[])
    const isRewind = sessionId !== undefined && sessionId === state.session
        && cachedTail !== undefined && incomingTail !== undefined
        && headSeqOf(events) === headSeqOf(cache)
        && incomingTail < cachedTail
    if (isRewind) {
        return { evs: cache, state, rebuilt: false }
    }
    const sameHead = !replaced
        && sessionId !== undefined && sessionId === state.session
        && cache.length > 0 && events.length > cache.length
        && headSeqOf(events) === headSeqOf(cache)
        && prefixMatches
    if (!sameHead) {
        const fresh = normalizeEvents(events)
        return { evs: fresh, state: { events: fresh, session: sessionId }, rebuilt: true }
    }
    // 增量扩展：只把新增的那几条变成 SessionEvent
    const grown = [...cache, ...normalizeEvents(events.slice(cache.length))]
    return { evs: grown, state: { events: grown, session: sessionId }, rebuilt: false }
}

/**
 * 取窗口里**第一条带 `seq` 的事件**的 seq（用于判断"窗口头有没有换过"）。
 *
 * ⚠️ 不能只看 `list[0]`（2026-10-12 真机调试抓到的坑）：会话的首条事件（`session` 头记录）
 * **没有 `seq`**，而缓存里那一条经 `normalizeEvents` 会被归一成 `seq: 0` ——
 * 于是"来帧头 seq"是 `undefined`、"缓存头 seq"是 `0`，两边**不对称**，
 * 靠这个比较做的判据（回退检测）会**恒假**。取第一条真的有 seq 的即可。
 */
function headSeqOf(list: readonly { seq?: unknown }[]): number | undefined {
    for (const e of list) {
        if (e === null || typeof e !== 'object') continue
        const s = (e as { seq?: unknown }).seq
        if (typeof s === 'number') return s
    }
    return undefined
}

/** 从保结构事件里取用户回显的 rpcId（队列卡「发送中」认领 + 插话气泡去重）。 */function userRpcIdsOfEvents(events: unknown): string[] {
    if (!Array.isArray(events)) return []
    const out: string[] = []
    for (const ev of events) {
        if (ev === null || typeof ev !== 'object') continue
        const e = ev as { type?: unknown; data?: unknown }
        if (e.type !== 'user/message') continue
        const source = (e.data as { source?: unknown } | undefined)?.source
        if (source !== null && typeof source === 'object') {
            const rpcId = (source as { rpcId?: unknown }).rpcId
            if (typeof rpcId === 'string') out.push(rpcId)
        }
    }
    return out
}

/** 读当前节点模型（诊断/守卫用）。 */
export function readChatNodeModel(): ChatNodeModel | undefined {
    return chatNodeModel
}

/** 按本帧（整表 或 delta + keys）拼出整表；会话一变就丢缓存重来。 */
function assembleRows(m: {
  rows?: unknown[]
  rowDelta?: unknown[]
  rowKeys?: number[]
  sessionId?: string
}): unknown[] {
  if (m.sessionId !== rowCacheSession) {
    rowCache = new Map()
    rowCacheSession = m.sessionId
  }
  // 整表帧（首帧 / 窗口整表替换）：直接替换缓存
  if (m.rows !== undefined) {
    rowCache = new Map()
    for (const row of m.rows) {
      const key = (row as { key?: unknown } | null)?.key
      if (typeof key === 'number') rowCache.set(key, row)
    }
    return m.rows
  }
  for (const row of m.rowDelta ?? []) {
    const key = (row as { key?: unknown } | null)?.key
    if (typeof key === 'number') rowCache.set(key, row)
  }
  const keys = m.rowKeys ?? []
  const out: unknown[] = []
  for (const key of keys) {
    const row = rowCache.get(key)
    if (row !== undefined) out.push(row)
  }
  // 缓存里已不在顺序中的键（窗口前移丢掉的行）清掉，免得越积越多
  if (rowCache.size > keys.length) {
    const kept = new Set(keys)
    for (const key of [...rowCache.keys()]) {
      if (!kept.has(key)) rowCache.delete(key)
    }
  }
  return out
}

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
  /**
   * **本 store 自己的**摄入缓存与续折断点（**不能提到模块级** —— 换会话 / 连续挂载不同窗口会串窗口，
   * 详见上面 `ingestEvents` 的注释与守卫 `_doneline.wiring.dom.test.mjs`【5】）。
   * `chatNodeModel` 仍留在模块级：它是 `readChatNodeModel()` 给别的模块读的**只读出口**，不是缓存。
   */
  let ingestState: { events: SessionEvent[]; session: string | undefined } = { events: [], session: undefined }
  let nodesCheckpoint: NodesCheckpoint | undefined

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
      // 提交台账（整表 pending + 增量 retired）：页面据此撑住"提交→开跑"那一拍的「处理中」、
      // 收掉 `queued` 的本地回显、并把已退休未入档的标成未提交成功（见 messages.applySubmissions）
      case 'submissions':
        messages.applySubmissions(m.pending ?? [], m.retired ?? [])
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
      case 'projections': {
        const values = m.values ?? {}
        /*
         * **权限要在这里也接一次**。
         *
         * 现象：三处视图（侧栏 / 编辑区 / 网页端）看同一会话时，在别处切**模型、推理等级**侧栏会跟着变，
         * 但切**权限**（workspace-write ↔ read-only）不跟随 —— 尽管宿主已经把整表推下来了。
         * 根因：权限原先**只在 `chatInfo` 那条路上**应用（见下面 `case 'chatInfo'`），而权限变化走的是
         * **投影帧**这条路 ⇒ 值到了页面却没人接。修法就是**接进同一套应用逻辑**（同一句话，不是另写一份）。
         */
        const perms = values['permissions'] as { options?: PermissionOption[]; currentValue?: string } | undefined
        if (perms !== undefined) {
          selectors.setPermOptions(perms.options, perms.currentValue)
        }
        /*
         * **模式同理**：投影里的 `agentPreset` 是当前模式，而 `setModes` 需要选项表（投影里没有）
         * ⇒ 走只挪当前值的那个入口。`undefined`（这一帧没带）保持原值。
         */
        if ('agentPreset' in values) {
          selectors.setCurrentMode(values['agentPreset'] as string | null | undefined)
        }
        // 激活与投影同帧到达，但**不是投影**（`goals/get` + `goal/activation-changed` 的来路）：
        // 一起交给 status 存起来，由目标条按 `(id, revision)` 对账
        status.applyProjections(values, m.goalActivation)
        // 迟到回答：投影里的 `userQuestions` 决定「哪些限时提问还能补答」（拿不到就是没有）
        question.applyLateQuestions(values)
        break
      }
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
      case 'chatEvents': {
        // 保结构事件帧 → 节点模型 → 渲染行 → messages（渲染源切换）。
        // 摄入只在窗口增长时补新增那一段；折叠只在同一回合内追加时重折尾巴（见上面缓存段的说明）。
        const ingested = ingestEvents(ingestState, m.sessionId, m.events, m.replaced === true)
        ingestState = ingested.state
        // 窗口被整份换过（含换会话 / 头变了 / 没变长 / 前缀对不上）时，续折断点必须一起作废
        // —— 否则会在**旧前缀**上折新窗口。
        if (ingested.rebuilt) nodesCheckpoint = undefined
        const folded = buildChatNodesIncremental(ingested.evs, nodesCheckpoint)
        chatNodeModel = folded.model
        nodesCheckpoint = folded.checkpoint
        if (USE_NODE_MODEL) {
            // 换会话清节点 key 映射（节点 key 是会话内语义串，跨会话会撞号）
            if (m.sessionId !== undefined && m.sessionId !== nodeRowsSessionId) {
                nodeRowsSessionId = m.sessionId
                resetNodeKeyMap()
            }
            messages.applyNodeRows(
                toChatRowsFromNodes(nodesToRows(chatNodeModel), m.changesSummary),
                m.sessionId,
                m.turnActive,
                m.subagent,
                // ⚠️ 座位计划的行 key 必须与行表**同一套数字 key**（由 `keyOf` 分配）：
                // 直接下发计划里的字符串 key（`turn-process:1:seg1`）会导致按 key 查表 100% 落空。
                nodesToSeatRows(chatNodeModel, rowKeyOfNodeKey),
            )
            messages.applyHistory({ hasMore: m.historyHasMore, loading: m.historyLoading, events: m.historyEvents, openError: m.sessionOpenError })
            // 与 `rows` 帧同款的三条收尾：队列「发送中」认领 + 反馈按会话丢弃 + 回合结束后收起提问弹窗
            queue.noteDurable(userRpcIdsOfEvents(m.events))
            feedback.onSession(m.sessionId)
            if (m.turnActive === false) question.reset()
        }
        break
      }
      case 'rows':
        // 渲染源是节点模型时 `rows` 帧退役；影子期仍走宿主行。
        if (USE_NODE_MODEL) break
        // 宿主下发的行（阶段 4，见 docs/design/08 §11）：渲染源切到宿主侧
        // **只发变动的行**（§3.3）：`rowDelta` + `rowKeys` 在这里拼回整表 —— 等价性是硬约束
        //（守卫 `tmp/_rows.diff.test.mjs` 逐前缀比对两种口径），拼装逻辑只此一处。
        // 拼一次整表：`applyHostRows` 与下面的 `noteDurable` 必须看**同一份**（见那处的注释）
        const assembled = assembleRows(m)
        messages.applyHostRows(assembled, m.sessionId, m.turnActive, m.subagent)
        // 窗口分页事实（「加载更早」按钮的门与进行态）：跟同一帧下发，页面只做镜像
        // `sessionOpenError` 同帧（整表语义：`null` = 没有失败，用来清掉上一条横幅）
        messages.applyHistory({
          hasMore: m.historyHasMore,
          loading: m.historyLoading,
          events: m.historyEvents,
          openError: m.sessionOpenError,
        })
        // 队列卡的本地「发送中」也按提交标识认领：这次提交可能落在对话流（空闲）或队列（忙时），
        // 两条路都以同一个 `rpcId` 回显 —— 只认队列帧的话，竞态下会有一条「发送中」永远挂着。
        // 同时记下「日志里已落账」的标识：pending 插话气泡据此去重（队列帧可能比行帧慢一帧）。
        // 判据必须是**拼好的整表**（`assembled`），不是帧上的 `m.rows`：差分帧（`rowDelta` + `rowKeys`，
        // 也就是常态）根本没有 `rows` 字段 —— 拿 `m.rows` 只会得到空集合，于是每次差分都把这份
        // 「日志里已落账」的名单清空：插话气泡的去重恒不生效，一条旧提问的气泡就永远挂在列表末尾
        //（真机 2026-10-07：发新问题时，最早那条提问又出现在「思考 / 深度求索中」上方）。
        queue.noteDurable(userRpcIdsOf(assembled))
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
