// 消息行模型切片：宿主下发的行（整表替换 + 乐观行认领）、通知行与审批行。
// 行 key 计数器在本切片内（per-store），不跨 store 实例共享——key 只用于同一列表内的替换匹配
// 与列表渲染 diff，各自从 1 计数即可。
import { computed, signal, type Signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { ImageAttachment, AttachmentRef } from '../protocol'
import { formatMsgClock } from '../format'
import type { DshStreamRow } from '../../../../src/dsh/rows/types'
import { toChatRows } from './host-rows'
import type { ChatRow, ChatStore, RefSnap } from './types'

export interface MessagesSlice {
  store: Pick<
    ChatStore,
    | 'messages'
    | 'view'
    | 'processing'
    | 'turnRunning'
    | 'scrollPend'
    | 'historyHasMore'
    | 'historyLoading'
    | 'historyEvents'
    | 'applyHistory'
    | 'loadOlder'
    | 'showNotice'
    | 'answerApproval'
    | 'openFile'
  >
  /** 追加一条审批行。 */
  pushApproval(approvalId: string, description: string, toolName?: string): void
  /** 追加一条用户行（本地乐观行：发出即显示，等宿主行回显后由提交标识认领）。 */
  addUser(text: string, imgs?: ImageAttachment[], time?: number, refs?: RefSnap[], imageRefs?: AttachmentRef[], files?: Array<{ name: string; path?: string; bytes?: number }>, rpcId?: string): void
  /** 开启（或复用）当前进行中的 assistant 行。 */
  beginAssistant(prompt?: string): void
  /** 取一个列表内唯一行 key。 */
  nextKey(): number
  /** 在编辑器区打开文件（相对路径按 cwd——会话工作区根——解析）。 */
  openFile(path: string, line?: number, cwd?: string): void
  /** 直接追加一行（历史恢复构行用）。 */
  push(row: ChatRow): void
  /** 请求滚到底（+1 由列表组件消费后清零）。 */
  bumpScroll(): void
  /** 清空消息与进行中标记；不动 scrollPend 与 key 计数器。 */
  resetRows(): void
  /** 接受宿主下发的行（阶段 4）：映射后写入列表，并保留本地尚未被回显认领的乐观行。
   *  `sessionId` 用于判归属：会话一变，上一个会话的乐观行必须丢弃（否则 processing 恒真）。 */
  applyHostRows(rows: unknown, sessionId?: string, turnActive?: boolean): void
  /** 更早的历史还没有进窗口（宿主给的窗口事实）：列表顶端据此出「加载更早」。 */
  historyHasMore: Signal<boolean>
  /** 「加载更早」是否在飞：按钮据此禁用并换成进行时文案。 */
  historyLoading: Signal<boolean>
  /** 窗口里的事件条数（诊断与「还需要往下翻多久」的直观量，不参与判定）。 */
  historyEvents: Signal<number>
  /** 记下宿主给的窗口事实（跟 `rows` 帧一起来，见 core/protocol 的 `rows`）。 */
  applyHistory(info: { hasMore?: boolean; loading?: boolean; events?: number }): void
  /** 请求往前翻一页（宿主去读更早的一页并 prepend；失败由宿主回 `history` 帧复位）。 */
  loadOlder(): void
  /** 本次提交**失败**（宿主 `chatError`）：把该标识对应的本地乐观行标为「未提交成功」，
   *  并把仍挂着的回答行定稿成错误。不这么做的话，它会一直被当成「在等回显」→ `processing` 恒真。 */
  failSubmission(rpcId: string | undefined, message: string): void
  /** 回合级过程折叠的展开态（见 `core/process-fold`）。未记录 = 默认（进行中展开、定稿收起）。 */
  turnFoldOpen: Signal<ReadonlyMap<number, boolean>>
  /** 记下某个回合的折叠展开态（回合号是**会话内**编号，换会话时整表清掉）。 */
  setTurnFoldOpen(turn: number, open: boolean): void
}

/** 本地时刻串（实时上送用；历史恢复走事件自带时刻）。 */
const nowTime = (): string => formatMsgClock(Date.now())

export function createMessages(host: ChatHost): MessagesSlice {
  const messages = signal<ChatRow[]>([])
  const view = computed<'welcome' | 'chat'>(() => (messages.value.length === 0 ? 'welcome' : 'chat'))
  const processing = signal(false)
  /** 宿主权威的「一轮在跑」：只喂停止/插话门控。 */
  const turnRunning = signal(false)
  const scrollPend = signal(0)
  /** 更早的历史还没进窗口（宿主事实，见 `src/api/dshService.ts` 的窗口分页）。 */
  const historyHasMore = signal(false)
  const historyLoading = signal(false)
  const historyEvents = signal(0)
  /** 回合级折叠展开态（见 core/process-fold）：key 是**会话内**回合号，换会话必须清 */
  const turnFoldOpen = signal<ReadonlyMap<number, boolean>>(new Map<number, boolean>())
  const setTurnFoldOpen = (turn: number, open: boolean): void => {
    const next = new Map(turnFoldOpen.value)
    next.set(turn, open)
    turnFoldOpen.value = next
  }
  let rowKey = 1
  /** 当前列表属于哪个会话：会话一变就丢弃本地乐观行（见 applyHostRows） */
  let rowsSessionId: string | undefined
  /** 上一次宿主下发里出现过的提交标识：判「这条本地行是否已被服务端回显认领」 */
  let claimedRpcIds = new Set<string>()

  // ---------- 不可变列表更新 ----------
  const replace = (key: number, next: ChatRow): void => {
    messages.value = messages.value.map((r) => (r.key === key ? next : r))
  }
  const push = (row: ChatRow): void => {
    messages.value = [...messages.value, row]
  }
  const removeWhere = (pred: (r: ChatRow) => boolean): void => {
    messages.value = messages.value.filter((r) => !pred(r))
  }

  function openFile(filePath: string, line?: number, cwd?: string): void {
    if (!filePath) return
    host.post({ type: 'openFile', path: filePath, ...(line === undefined ? {} : { line }), ...(cwd ? { cwd } : {}) })
  }

  const showNotice = (msgText: string, command?: string, tone: 'error' | 'ok' = 'error'): void => {
    push({ kind: 'notice', key: rowKey++, text: msgText, command, tone })
  }

  // 当前"流式进行中"的 assistant 行(至多一个);无则 undefined
  const activeAssistantIndex = (): number =>
    messages.value.findIndex((r) => r.kind === 'assistant' && !r.done)
  const ensureAssistant = (prompt = ''): ChatRow | undefined => {
    let idx = activeAssistantIndex()
    if (idx === -1) {
      push({
        kind: 'assistant',
        key: rowKey++,
        time: '', // 真实时刻由宿主的行带来（本行是本地占位，不伪造时刻）
        done: false,
        prompt,
        text: '',
        stats: '',
        chain: [],
        counts: { toolCallCount: 0, messageCount: 0, subagentCount: 0 },
        bodyStarted: false,
      })
      idx = messages.value.length - 1
    } else if (prompt) {
      const row = messages.value[idx]
      if (row.kind === 'assistant' && !row.prompt) {
        replace(row.key, { ...row, prompt })
      }
    }
    return messages.value[idx]
  }

  // ---------- 消息流动作(本地渲染) ----------
  function addUser(textMsg: string, imgs: ImageAttachment[] = [], time?: number, refs?: RefSnap[], imageRefs?: AttachmentRef[], files?: Array<{ name: string; path?: string; bytes?: number }>, rpcId?: string): void {
    // 实时本地上送用本地时刻;恢复历史时传入事件自带时间戳,不覆盖为"现在"
    push({ kind: 'user', key: rowKey++, text: textMsg, images: imgs, time: time !== undefined ? formatMsgClock(time) : nowTime(), refs, ...(imageRefs && imageRefs.length > 0 ? { imageRefs } : {}), ...(files && files.length > 0 ? { files } : {}), ...(rpcId !== undefined ? { rpcId } : {}) })
  }
  /**
   * 接受宿主下发的行（阶段 4，见 docs/design/08 §11）：**整表替换** —— 宿主是行列表的唯一权威。
   * 只有一种例外：本地已出、但尚未被回显认领的**乐观行**要留住（否则刚发出去的消息会一闪而没）。
   * 认领判定用提交标识：宿主行里已有同标识 → 已被认领；没有 → 还没回显，保留在末尾。
   */
  function applyHostRows(rows: unknown, sessionId?: string, turnActive?: boolean): void {
    // 会话变了 → 列表里那些「本地已出、尚未被回显认领」的乐观行属于**上一个会话**，必须丢掉：
    // 留着会让 pending 恒非空 → processing 恒真（一直「深度求索中」，停止按钮还对着别人的行）。
    // 上游的做法更彻底（乐观态挂在**会话**上、不混进时间线），这里先按会话归属把它清掉。
    if (sessionId !== undefined) {
      // 只在**确实换过会话**时丢弃：首次还没有归属，不算「换会话」
      // （否则页面刚打开就发消息的话，第一次下发会把那条乐观行清掉）。
      if (rowsSessionId !== undefined && rowsSessionId !== sessionId) {
        messages.value = []
        processing.value = false
        turnRunning.value = false
        // 回合号是**会话内**编号：换会话后同一个号会指到别的回合，折叠展开态必须一起清
        turnFoldOpen.value = new Map<number, boolean>()
        // **打开一个会话一律从底部开始**（对齐上游：没有存下的阅读位置时 `toBottom()`）。
        // 少了这一下，新会话的内容是在「保留原 scrollTop」的前提下长出来的 ——
        // 上一条会话若停在靠下的位置，打开新历史会话时视野就留在**最上面**（真机现象「光标跑到最上面去了」）。
        bumpScroll()
      }
      rowsSessionId = sessionId
    }
    const host = toChatRows(Array.isArray(rows) ? (rows as DshStreamRow[]) : [])
    const claimed = new Set(
      host
        .filter((r): r is Extract<ChatRow, { kind: 'user' }> => r.kind === 'user')
        .map((r) => r.rpcId)
        .filter((id): id is string => id !== undefined)
    )
    claimedRpcIds = claimed
    // 认领时把**本地行独有**的附件信息并回宿主行：内联图（base64）与文件的**本地路径**
    // （宿主事件里只有附件引用、名字与字节数，路径点不开）。不回填则「发图 / 发文件」后这两样立刻消失。
    const localByRpc = new Map<string, Extract<ChatRow, { kind: 'user' }>>()
    for (const r of messages.value) {
      if (r.kind === 'user' && r.rpcId !== undefined) localByRpc.set(r.rpcId, r)
    }
    const merged = host.map((r): ChatRow => {
      if (r.kind !== 'user' || r.rpcId === undefined) return r
      const local = localByRpc.get(r.rpcId)
      if (local === undefined) return r
      return {
        ...r,
        ...(local.images.length > 0 ? { images: local.images } : {}),
        ...(local.files !== undefined ? { files: local.files } : {}),
        ...(local.refs !== undefined ? { refs: local.refs } : {}),
      }
    })
    const pending = messages.value.filter(
      (r): r is Extract<ChatRow, { kind: 'user' }> =>
        r.kind === 'user' && r.rpcId !== undefined && !claimed.has(r.rpcId)
    )
    /**
     * 本地乐观行的**落位**：插到本轮未定稿的回答行**之前**，而不是一律追加到末尾。
     *
     * 为什么：这条路只在「回显还没到」或「回显永远不会到」时才有行可放。
     * 一律追加到末尾的话，一旦回显没来（丢帧，或提交与回显之间出过错），这条提问就会留在列表最后 ——
     * **看起来就是「回答在上面、我发的问题在下面」**（真机现象）。
     * 插到本轮回答行之前，「提问 → 回答」的顺序在任何情况下都成立；宿主真没这一行时它也仍在对话里可见。
     * 往回答行**之后**找是取最靠下的那条未定稿行，保证插在当前这一轮而不是更早的残留行旁边。
     */
    let openAssistantAt = -1
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const row = merged[i]
      if (row !== undefined && row.kind === 'assistant' && !row.done) {
        openAssistantAt = i
        break
      }
    }
    /**
     * 兜底去重（**只在标识认领没生效时才会用到**）：宿主已经有一条**同文案**的用户行，
     * 就说明本地这条是重复的 —— 丢掉它，而不是继续贴在末尾。
     *
     * 为什么需要：认领靠提交标识配对，一旦配不上（回显没带标识、或标识不一致），
     * 本地这条既不会被认领、又不该留在列表里 —— 留着就会出现在本轮回答**下面**
     * （真机现象：回答在上面、我发的问题在下面）。宿主那条位置本来就是对的。
     *
     * 代价：同一文案连发两次时，第二条在回显到达前会短暂消失（随之由宿主行补上）；
     * 这比"永久错位"轻。**这是兜底**，标识配对正常时它一次都不会触发。
     */
    const hostUserTexts = new Map<string, number>()
    for (const r of merged) {
      if (r.kind === 'user') hostUserTexts.set(r.text, (hostUserTexts.get(r.text) ?? 0) + 1)
    }
    const pendingKept = pending.filter((r) => {
      const seen = hostUserTexts.get(r.text) ?? 0
      if (seen === 0) return true
      hostUserTexts.set(r.text, seen - 1)
      console.warn(`[chat] 本地行未被标识认领，按同文案去重（宿主已有该消息，位置以宿主为准）`)
      return false
    })
    messages.value =
      openAssistantAt === -1
        ? [...merged, ...pendingKept]
        : [...merged.slice(0, openAssistantAt), ...pendingKept, ...merged.slice(openAssistantAt)]
    // 「处理中」三个来源：本地还有**在等回显**的乐观行 / **宿主说本轮在跑** / 最后一条回答行尚未定稿。
    // **不能**看「末行」：用户消息回显后、回答行还没建的一瞬末行是用户行，
    // 按末行判会把处理中算成 false —— 按钮中途变回「发送」并禁用（真机：停止点不动）。
    // 提交失败的行（failed）留在列表里但**不算在等**：它永远不会被回显认领。
    const waiting = pendingKept.filter((r) => r.failed !== true)
    const lastAssistant = [...messages.value].reverse().find((r) => r.kind === 'assistant')
    processing.value =
      waiting.length > 0 || turnActive === true || (lastAssistant !== undefined && !lastAssistant.done)
    // 停止/插话只认宿主权威：processing 会在回答中被推导成 false
    turnRunning.value = turnActive === true
  }

  /**
   * 本次提交失败：本地乐观行标 `failed`（留作历史，但不再算「在等回显」），仍挂着的回答行定稿成错误。
   * 这是**本地**失败（没工作区 / 服务不可用 / RPC 报错），服务端根本没有这一回合 ——
   * 所以事件流里不会有 turn/end，行的 `endMsg` 只能由这里写进去（与旧通路的 `chatDone(end=error)` 同口径）。
   */
  function failSubmission(rpcId: string | undefined, msgText: string): void {
    let hit = false
    messages.value = messages.value.map((r): ChatRow => {
      if (r.kind !== 'user' || r.failed === true) return r
      // **只标还没被服务端回显认领的行**：已经认领的说明消息确实送到了，它不该被标成「未提交成功」
      if (r.rpcId === undefined || claimedRpcIds.has(r.rpcId)) return r
      // 没有标识时（宿主没带上）退化为「把所有还没回显的本地行都标掉」，宁可多标也不能留下卡住的
      if (rpcId !== undefined && r.rpcId !== rpcId) return r
      hit = true
      return { ...r, failed: true }
    })
    const idx = activeAssistantIndex()
    if (idx !== -1) {
      const row = messages.value[idx]
      if (row.kind === 'assistant') {
        replace(row.key, {
          ...row,
          done: true,
          // 本地失败没有上游 reason.kind；角标沿用「错误」这一档，与 turn/end 的 error 同形
          status: 'error',
          endMsg: msgText || row.endMsg,
          bodyStarted: true,
        })
        hit = true
      }
    }
    if (!hit) showNotice(msgText)
    processing.value = false
  }

  function beginAssistant(prompt = ''): void {
    ensureAssistant(prompt)
  }

  // ---------- 审批 ----------
  function answerApproval(approvalId: string, allow: boolean, key: number): void {
    removeWhere((r) => r.kind === 'approval' && r.key === key)
    host.post({ type: 'approvalResponse', approvalId, allow })
  }
  function pushApproval(approvalId: string, description: string, toolName?: string): void {
    push({ kind: 'approval', key: rowKey++, approvalId, description, toolName })
  }

  const nextKey = (): number => rowKey++
  const bumpScroll = (): void => {
    scrollPend.value = scrollPend.value + 1
  }
  /** 记下宿主给的窗口事实（跟 `rows` 帧一起来；缺项不动，避免每帧把已知状态清回默认）。 */
  const applyHistory = (info: { hasMore?: boolean; loading?: boolean; events?: number }): void => {
    if (info.hasMore !== undefined) historyHasMore.value = info.hasMore
    if (info.loading !== undefined) historyLoading.value = info.loading
    if (info.events !== undefined) historyEvents.value = info.events
  }
  /** 往前翻一页：宿主去读更早的历史并 prepend；在飞时不重复发（按钮也已禁用）。 */
  const loadOlder = (): void => {
    if (historyLoading.value) return
    historyLoading.value = true
    host.post({ type: 'loadOlder' })
  }
  /** 清空消息与进行中标记。不清 scrollPend（触底语义独立）、不清 rowKey（保持单调，避免复用 key 让 diff 误判）。 */
  const resetRows = (): void => {
    messages.value = []
    processing.value = false
    turnRunning.value = false
    turnFoldOpen.value = new Map<number, boolean>()
    // 窗口事实随会话一起换：新会话的窗口由它自己的 `rows` 帧重写
    historyHasMore.value = false
    historyLoading.value = false
    historyEvents.value = 0
  }

  return {
    store: {
      messages,
      view,
      processing,
      turnRunning,
      scrollPend,
      historyHasMore,
      historyLoading,
      historyEvents,
      applyHistory,
      loadOlder,
      showNotice,
      answerApproval,
      openFile,
    },
    openFile,
    applyHostRows,
    failSubmission,
    applyHistory,
    loadOlder,
    historyHasMore,
    historyLoading,
    historyEvents,
    pushApproval,
    addUser,
    beginAssistant,
    nextKey,
    push,
    bumpScroll,
    resetRows,
    turnFoldOpen,
    setTurnFoldOpen,
  }
}
