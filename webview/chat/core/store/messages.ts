// 消息行模型切片：客户端节点模型映射出的行（整表替换 + 乐观行认领）、通知行与审批行。
// 行 key 计数器在本切片内（per-store），不跨 store 实例共享——key 只用于同一列表内的替换匹配
// 与列表渲染 diff，各自从 1 计数即可。
import { computed, signal, type Signal } from '@preact/signals'
import type { ChatHost } from '../host'
import { isVisibleChatRow } from '../chat-visibility'
import type { ImageAttachment, AttachmentRef } from '../protocol'
import { formatMsgClock } from '../format'
import type { SubagentFacts } from '../stop-control'
import type { ChatRow, ChatStore, PendingEcho, RefSnap } from './types'
import type { RenderSeatKeys } from '../nodes/render-plan'



/**
 * 座位计划的一项：类型只有**一处**定义（`render-plan.ts` 的 `RenderSeatKeys`）。
 * 这里再导出一次，store 侧的读者不必去 `nodes/` 里找类型。
 */
export type SeatPlanEntry = RenderSeatKeys

export interface MessagesSlice {
  store: Pick<
    ChatStore,
    | 'pendingEchoes'
    | 'visibleRows'
    | 'pendingTranscriptInput'
    | 'messages'
    | 'view'
    | 'processing'
    /** 提交失败的错误条（只给输入区那一格用，不进对话流；见 `promptError` 的注释） */
    | 'promptError'
    | 'runAnchorMs'
    | 'turnRunning'
    | 'subagentFacts'
    | 'scrollPend'
    | 'seatPlan'
    | 'historyHasMore'
    | 'historyLoading'
    | 'historyEvents'
    | 'sessionOpenError'
    | 'applyHistory'
    | 'loadOlder'
    | 'showNotice'
    | 'answerApproval'
    | 'openFile'
    | 'openAttachment'
    | 'openAttachmentBytes'
  >
  /**
   * 追加一条审批行。
   * `description` 是上游审计 `reason`；`displayReason` 是 dsh 0.1.7-rc.2 起并列给出的
   * 本地化展示文案，二者都原样存下行、由 `core/approval-text.ts` 决议最终显示哪一条。
   */
  pushApproval(approvalId: string, description: string, toolName?: string, displayReason?: Record<string, string>): void
  /** 追加一条用户行（本地乐观行：发出即显示，等宿主行回显后由提交标识认领）。 */
  addUser(text: string, imgs?: ImageAttachment[], time?: number, refs?: RefSnap[], imageRefs?: AttachmentRef[], files?: Array<{ name: string; path?: string; bytes?: number; attachmentId?: string }>, rpcId?: string): void
  /**
   * 宿主**提交台账**的帧（`submissions`）：整表的待结算提交 + 自上一帧以来退休的那些。
   *
   * 与上游 `SessionSnapshot.pendingSubmissions` 同构：位置由宿主推导、退休由宿主判定 —— 页面只消费。
   * 于是「处理中」不再有一条"没人回收的本地乐观行"的腿（真机 2026-10-06 的卡死来路）。
   */
  applySubmissions(
    pending: ReadonlyArray<{ rpcId: string; placement: 'transcript' | 'queued' | 'steering'; text: string }>,
    retired: ReadonlyArray<{ rpcId: string; outcome: string }>
  ): void
  /** 开启（或复用）当前进行中的 assistant 行。 */
  beginAssistant(prompt?: string): void
  /** 取一个列表内唯一行 key。 */
  nextKey(): number
  /** 在编辑器区打开文件（相对路径按 cwd——会话工作区根——解析）。 */
  openFile(path: string, line?: number, cwd?: string): void
  /** 按附件 id 在编辑区打开附件（用户消息/图片卡里的图与文件只有 id，没有本地路径）。 */
  openAttachment(attachmentId: string, name?: string): void
  /** 把还没有附件 id 的字节在编辑区打开（本地乐观行里刚粘贴/拖进来的图）。 */
  openAttachmentBytes(data: string, mediaType?: string, name?: string): void
  /** 直接追加一行（历史恢复构行用）。 */
  push(row: ChatRow): void
  /** 请求滚到底（+1 由列表组件消费后清零）。 */
  bumpScroll(): void
  /** 清空消息与进行中标记；不动 scrollPend 与 key 计数器。 */
  resetRows(): void
  /** 座位计划（上游 render entry 同形）；与行表同帧更新。 */
  seatPlan: Signal<ReadonlyArray<SeatPlanEntry>>
  /** 接受**节点模型**映射出的 ChatRow：整表替换 + 回显认领（页面渲染源的唯一入口）。 */
  applyNodeRows(rows: ChatRow[], sessionId?: string, turnActive?: boolean, subagent?: SubagentFacts, seats?: ReadonlyArray<SeatPlanEntry>): void
  /** 更早的历史还没有进窗口（宿主给的窗口事实）：列表顶端据此出「加载更早」。 */
  historyHasMore: Signal<boolean>
  /** 「加载更早」是否在飞：按钮据此禁用并换成进行时文案。 */
  historyLoading: Signal<boolean>
  /** 窗口里的事件条数（诊断与「还需要往下翻多久」的直观量，不参与判定）。 */
  historyEvents: Signal<number>
  /** **打开历史失败**的事实（上游 `openState === 'error'`）：列表顶端据此出一条横幅；`undefined` = 没有失败。 */
  sessionOpenError: Signal<{ message: string; code?: string } | undefined>
  /** 记下宿主给的窗口事实（跟 `chatEvents` 帧一起来，见 core/protocol 的 `chatEvents`）。 */
  applyHistory(info: {
    hasMore?: boolean
    loading?: boolean
    events?: number
    /** 整表语义：`null` = 没有失败（用来清掉上一条横幅） */
    openError?: { message: string; code?: string } | null
  }): void
  /** 请求往前翻一页（宿主去读更早的一页并 prepend；失败由宿主回 `history` 帧复位）。 */
  loadOlder(): void
  /** 本次提交**失败**（宿主 `chatError`）：把该标识对应的本地乐观行标为「未提交成功」，
   *  并把仍挂着的本地占位回答行撤掉。错误原因写 `promptError`（**不进对话流**），不是在这里造行。 */
  failSubmission(rpcId: string | undefined, message: string, code?: string): void
  /** 回合级过程折叠的展开态（见 `core/process-fold`）。未记录 = 默认（进行中展开、定稿收起）。 */
  turnFoldOpen: Signal<ReadonlyMap<number, boolean>>
  /** 记下某个回合的折叠展开态（回合号是**会话内**编号，换会话时整表清掉）。 */
  setTurnFoldOpen(turn: number, open: boolean): void
  /**
   * **片**级过程折叠的展开态（B′：按片渲染后各片独立），键 = `${turn}:${group.key}`。
   * 与 `turnFoldOpen` 并存：哪条路径在用，由"有没有 `groups`"决定（见 `components/chain/Chain.ts`）。
   */
  groupFoldOpen: Signal<ReadonlyMap<string, boolean>>
  /** 记下**某片**的折叠展开态。 */
  setGroupFoldOpen(turn: number, groupKey: string, open: boolean): void
  /**
   * **外层折叠**（上游 `turnProcesses {turn, answerStep}`）：每回合记下"用户已唤出到哪个回答世代"。
   *
   * 语义（对齐上游）：**缺省 = 没记录** → 已关闭的回合只留**当前世代**那一片可见，更早的世代
   * 用 `hidden="until-found"` 折起（可被网页查找命中、命中即唤出）。用户唤出后记下当前 `answerStep`，
   * 该世代之后一直可见。**记录只在会话内有效**（键是会话内回合号，换会话整表清）。
   */
  outerAnswerStep: Signal<ReadonlyMap<number, number>>
  /**
   * 读者手动收起过的回合：键 = 回合号，值 = **收起时的 `answerStep`**（与唤出记录互斥）。
   *
   * 只记"收过/没收过"不够：上游 `turnProcessOpen` 的三态是"记录世代 == 当前世代？"，世代过期就回默认。
   * 单独一张表是为了让"推迟自动收起"与"读者要收起"能区分开（见接口注释）。
   */
  outerFoldedByReader: Signal<ReadonlyMap<number, number>>
  /** 记下某回合"已唤出到的回答世代"（用户展开隐藏片 / 网页查找命中时调用）。 */
  revealOuter: (turn: number, answerStep: number) => void
  /** 反向：清掉该回合的"已唤出世代" → 回到"只留当前世代"的折起状态（完成态行上的 chevron 用它收起）。 */
  foldOuter: (turn: number) => void
}

export function createMessages(host: ChatHost): MessagesSlice {
  const messages = signal<ChatRow[]>([])
  /**
   * 「欢迎页 / 对话区」的判据：**可见行**一条都没有 = 新会话（出欢迎页那三行提示词）。
   *
   * 为什么不是 `messages.value.length === 0`（「切换权限、模型之后，新会话区域的
   * 提示词被清空了」）：切权限走的是 `/permission <preset>` 斜杠命令，会话日志里因此多出
   * `command/run` + `command/done` 一对事件，宿主照实把它建成一条 `command` 行（见
   * ：上游是在**渲染**时剔 `name === 'permission'`，数据层照旧留着）。
   * 按**原始行表**长度算：这条**根本不会显示**的命令行就把空会话顶成"有内容" → 欢迎页卸载，
   * 而 `MessageList` 又把它按可见性滤掉 → 会话区**一片空白**（看起来就是提示词被清空了）。
   *
   * 判据因此与渲染层同一份（`core/chat-visibility.ts` 的 `isVisibleChatRow`，也是
   * `MessageList` 过滤用的那一个）——上游次序本来就是**先过滤可见节点、再算**
   *（`orderedVisibleChatNodes()` 的 `filter(isVisibleChatNode)`）：一条可见行都没有的会话
   * 在聊天区**一条行都不占**，那就该是欢迎页。同理受益的还有「只有 system-prompt /
   * 普通 context 注入」这类空会话。
   */
  const view = computed<'welcome' | 'chat'>(() =>
    messages.value.some((row) => isVisibleChatRow(row)) ? 'chat' : 'welcome'
  )
  const processing = signal(false)
  /**
   * **提交失败的错误条**（上游 `promptError` 的同一格）：只显示在输入区上方，**不进对话流**。
   *
   * 为什么不塞进 messages：那是**永久行**（不会自己消失），而且本地行与宿主行一起重排 ——
   * 真机 2026-10-18 的表现就是「红字一直赖在会话里、把行序搅乱、新发的内容还看不见」。
   * 清空时机见 `outbox.send`：**每次提交开始时**清（对齐上游 `prompt()` 的 `promptError = null`）。
   */
  const promptError = signal<{ message: string; code?: string } | undefined>(undefined)
  /**
   * 「深度求索中，用时 X」的时钟锚点 = **正在跑的那一回合的开始时刻**（宿主下发 `turnStartMs`）。
   *
   * 为什么不用「组件挂载时刻」：那是插件原先的做法，面板中途打开/切回本会话时会**从 0 重新计**，
   * 与网页端（锚回合开始时刻）差出好几秒。锚点未知时保持 `undefined` —— 状态行按上游只显示
   * 「深度求索中」（不带时长）。
   */
  const runAnchorMs = signal<number | undefined>(undefined)
  /** 宿主权威的「一轮在跑」：只喂停止/插话门控。 */
  const turnRunning = signal(false)
  /** 「请把视口钉到底」的脉冲（触底语义独立于行表：清空消息不清它）。 */
  const scrollPend = signal(0)
  /**
   * **会话级本地回显**（上游 `SessionSnapshot.pendingSubmissions` + `PendingSubmission` 的等价物）。
   *
   * 上游把回显放在**会话状态**里、由渲染层推导可见性（判据：
   * `pendingSubmissions.filter(s => !observed.rpcIds.has(s.requestId))`）——不是时间线里的一行。
   * 插件过去把它 push 进行表，于是必须靠「留住未认领的本地行 + 10s 宽限 + 文案兜底」三份补丁维持，
   * 认领/退休一错拍就是「两个气泡」或「一闪而没」（docs/design/08 §A1）。
   */
  const pendingEchoes = signal<ReadonlyArray<PendingEcho>>([])
  /** 回显行的行 key（负数域，与宿主正数 key 不冲突；同一条回显恒用同一个 key，避免每帧重挂）。 */
  const echoKeys = new Map<string, number>()
  let echoKeySeq = -1_000_000
  const echoKeyOf = (rpcId: string): number => {
    let k = echoKeys.get(rpcId)
    if (k === undefined) { echoKeySeq -= 1; k = echoKeySeq; echoKeys.set(rpcId, k) }
    return k
  }
  /**
   * **渲染用的行表（推导）**：耐久行 + 还没有耐久对应物的会话级回显（与上游同口径）。
   *
   * 判定只看一件事：行表里有没有**同 `rpcId`** 的用户行 —— 有 ⇒ 那条回显已经进日志，当场不画
   *（**不删行、不记账**，所以没有认领/退休竞态）；没有 ⇒ 补在「本轮未定稿回答行」**之前**
   *（一律追加到末尾的话，回显比回答晚到一步就会出现「回答在上、我发的问题在下」，真机 2026-10-07）。
   * `queued` 那档整类排除（由队列卡表示，上游同款）。
   */
  const visibleRows = computed<ReadonlyArray<ChatRow>>(() => {
    const dedupe = (list: ReadonlyArray<ChatRow>): ReadonlyArray<ChatRow> => {
      const seen = new Set<string>()
      let out: ChatRow[] | undefined
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i]
        if (r !== undefined && r.kind === 'user' && r.rpcId !== undefined) {
          if (seen.has(r.rpcId)) { if (out === undefined) out = list.slice(0, i); continue }
          seen.add(r.rpcId)
        }
        out?.push(r as ChatRow)
      }
      return out ?? list
    }
    const rows = dedupe(messages.value)
    const echoes = pendingEchoes.value
    if (echoes.length === 0) return rows
    const inLog = new Set<string>()
    for (const r of rows) {
      if (r.kind === 'user' && r.rpcId !== undefined) inLog.add(r.rpcId)
    }
    /**
     * **可见性以台账为准**（上游读的就是 `pendingSubmissions`）：
     * 提交那一刻页面猜的 `placement` 只用于「台账帧还没到」那一拍；台账一旦有这条，就用台账的位置 ——
     * 否则「忙时排队」那条会先在对话区冒出来、再被收走（真机 2026-10-06 的现象）。
     */
    const placementOf = new Map(pendingSubmissions.value.map((x) => [x.rpcId, x.placement]))
    const extra: ChatRow[] = []
    const added = new Set<string>()
    for (const e of echoes) {
      const placement = placementOf.get(e.rpcId) ?? e.placement
      if (placement === 'queued' || inLog.has(e.rpcId) || added.has(e.rpcId)) continue
      added.add(e.rpcId)
      extra.push({
        kind: 'user',
        key: echoKeyOf(e.rpcId),
        text: e.text,
        images: e.images,
        time: formatMsgClock(e.time),
        rpcId: e.rpcId,
        ...(e.failed === true ? { failed: true } : {}),
        ...(e.refs !== undefined ? { refs: e.refs } : {}),
        ...(e.imageRefs !== undefined ? { imageRefs: e.imageRefs as never } : {}),
        ...(e.files !== undefined ? { files: e.files } : {}),
      } as ChatRow)
    }
    if (extra.length === 0) return rows
    let at = rows.length
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      if (row !== undefined && row.kind === 'assistant' && !row.done) { at = i; break }
    }
    return [...rows.slice(0, at), ...extra, ...rows.slice(at)]
  })
  /**
   * **座位计划**（`RenderSeatKeys[]`：一条 entry 一项，项内按序带行 key）。
   *
   * 页面渲染正在从"逐行"迁到"逐座位"：座位是**上游的渲染粒度**（一个 render entry 一个 seat），
   * 而位次 / 间距 / 折叠 / 可见性四类判据应当在座位这一层判一次，
   * 不再每一条都在"行"上重复近似。这一步先把计划接进 store（只读、不改渲染）。
   */
  const seatPlan = signal<ReadonlyArray<SeatPlanEntry>>([])
  /** 更早的历史还没进窗口（宿主事实，见 的窗口分页）。 */
  const historyHasMore = signal(false)
  const historyLoading = signal(false)
  const historyEvents = signal(0)
  /** **打开历史失败**（上游 `openState === 'error'` 的 `openError`）：列表顶端横幅读它。 */
  const sessionOpenError = signal<{ message: string; code?: string } | undefined>(undefined)
  /**
   * **待结算的提交**（宿主台账的镜像：与上游 `SessionSnapshot.pendingSubmissions` 同构）。
   *
   * 页面不再自己推断"这条本地行还会不会来" —— 位置（`transcript` / `queued` / `steering`）与退休
   * 都由宿主判定：`queued` 交给队列卡表示、`steering` 留到入档、
   * `transcript` 在"提交之后、回合真正开跑"那一拍撑住「处理中」（上游 `awaitingFirstTurn` 的等价物）。
   * 于是「处理中」不再有一条"没人回收的本地乐观行"的腿（真机 2026-10-06 的卡死来路）。
   */
  const pendingSubmissions = signal<ReadonlyArray<{ rpcId: string; placement: 'transcript' | 'queued' | 'steering'; text: string }>>([])
  /**
   * 台账里还有**待结算的普通直发**（`placement === 'transcript'`）。
   *
   * 收起时机的「下次发送时收起」用它取消推迟：用户已经提交了下一条，这一刻就该恢复历史呈现 ——
   * 与上游「普通 transcript 输入进入待发送状态即取消推迟」同口径（排队输入、单独 steering 不算）。
   */
  const pendingTranscriptInput = computed(() => pendingSubmissions.value.some((p) => p.placement === 'transcript'))
  /**
   * **子会话事实**（宿主随行帧下发；普通会话是 `undefined`）。页面据此判停止控件与"父离线锁"（见
   * `core/stop-control.ts`）—— 判定在页面、事实在宿主，与插件其它地方同一分工。
   */
  const subagentFacts = signal<SubagentFacts | undefined>(undefined)
  /** 台账**刚退休**的那几条（增量；页面据此收掉本地行并区分"消失 / 未提交成功"）。 */
  const retiredSubmissions = signal<ReadonlyArray<{ rpcId: string; outcome: string }>>([])
  /** 回合级折叠展开态（见 core/process-fold）：key 是**会话内**回合号，换会话必须清 */
  const turnFoldOpen = signal<ReadonlyMap<number, boolean>>(new Map<number, boolean>())
  const setTurnFoldOpen = (turn: number, open: boolean): void => {
    const next = new Map(turnFoldOpen.value)
    next.set(turn, open)
    turnFoldOpen.value = next
  }
  /**
   * **片**级展开态：键 = `${turn}:${group.key}`（各片独立；上游是每个 seat 自己的本地 disclosure）。
   * 片消失（重折/翻页）后残留的键不会有人读，量也随回合数有界，故不额外做清理 —— 换会话时整表清掉。
   */
  const groupFoldOpen = signal<ReadonlyMap<string, boolean>>(new Map<string, boolean>())
  const setGroupFoldOpen = (turn: number, groupKey: string, open: boolean): void => {
    const next = new Map(groupFoldOpen.value)
    next.set(`${String(turn)}:${groupKey}`, open)
    groupFoldOpen.value = next
  }
  /**
   * 外层折叠的"已唤出世代"（上游 `turnProcesses`）：键 = 会话内回合号，值 = 已唤出到的 `answerStep`。
   * **缺省 = 没记录**（等价上游 `stored === undefined`）→ 已关闭回合只留当前世代可见。
   */
  const outerAnswerStep = signal<ReadonlyMap<number, number>>(new Map<number, number>())
  /**
   * 读者手动收起的记录（键 = 回合号，值 = 收起时的 `answerStep`）：与 `outerAnswerStep`（唤出记录）互斥，
   * 一起构成上游 `turnProcessOpen` 的三态。存世代是为了"世代一变就回默认"（见接口注释）。
   */
  const outerFoldedByReader = signal<ReadonlyMap<number, number>>(new Map<number, number>())
  const revealOuter = (turn: number, answerStep: number): void => {
    // 唤出 = 逆着手动收起（否则同一回合会同时"被收起"和"被唤出"）
    if (outerFoldedByReader.value.has(turn)) {
      const nextFolded = new Map(outerFoldedByReader.value)
      nextFolded.delete(turn)
      outerFoldedByReader.value = nextFolded
    }
    if (outerAnswerStep.value.get(turn) === answerStep) {
      // 已经是这个世代：不产生新 Map（避免每帧新建引用导致订阅者白重渲）
      return
    }
    const next = new Map(outerAnswerStep.value)
    next.set(turn, answerStep)
    outerAnswerStep.value = next
  }
  /** 反向：记下"读者在该世代收起了本回合"并清掉唤出记录 → 回到折起状态（完成态行上的 chevron 用它收起）。 */
  const foldOuter = (turn: number, answerStep?: number): void => {
    // 先记"是读者收的、收在哪一代"：推迟中的回合没有这条记录就会把收起吞掉（真机：点 chevron 没反应）
    const step = answerStep ?? outerAnswerStep.value.get(turn) ?? 0
    if (outerFoldedByReader.value.get(turn) !== step) {
      const nextFolded = new Map(outerFoldedByReader.value)
      nextFolded.set(turn, step)
      outerFoldedByReader.value = nextFolded
    }
    if (!outerAnswerStep.value.has(turn)) {
      return
    }
    const next = new Map(outerAnswerStep.value)
    next.delete(turn)
    outerAnswerStep.value = next
  }
  let rowKey = 1
  /** 本地乐观用户行的 key：用**负数**域，与宿主行（正数）永不冲突，认领时可直接复用、不触发 preact 重挂载。 */
  let optUserKey = -1
  /** 本地时刻的展示文案（与宿主行的 `time` 同格式）。 */
  const nowTime = (): string => formatMsgClock(Date.now())
  /** 当前列表属于哪个会话：会话一变就丢弃上一个会话的本地行（见 installMappedRows） */
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
  /**
   * 按**附件 id** 打开附件（用户消息 / 图片卡里的图与文件在会话里只有 id，没有本地路径）：
   * 交给宿主取字节 → 落临时文件 → 在**编辑区**打开（图片走 VS Code 图片预览、其它文件走编辑器）。
   *
   * ⚠️ "取字节"这一条对**图片与文件是同一条路**（上游 `session/attachment` 只认 id + 会话归属），
   * 所以文件卡也走它 —— 2026-10-12 扩到 `file` 块（事件里同样带 `attachmentId`）。
   */
  function openAttachment(attachmentId: string, name?: string): void {
    if (!attachmentId) return
    host.post({ type: 'openAttachment', attachmentId, ...(name === undefined || name === '' ? {} : { name }) })
  }
  /**
   * 把**还没有附件 id 的字节**在编辑区打开（本地乐观行里刚粘贴/拖进来的图）。
   * 见 `protocol.ts` 那条消息的说明：一旦进日志就换 `openAttachment`（带 id）那条路。
   */
  function openAttachmentBytes(data: string, mediaType?: string, name?: string): void {
    if (!data) return
    host.post({
      type: 'openAttachmentBytes',
      data,
      ...(mediaType === undefined || mediaType === '' ? {} : { mediaType }),
      ...(name === undefined || name === '' ? {} : { name }),
    })
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
        // 本地占位：整表替换时必须被显式保留（见 `installMappedRows` 的 `localPlaceholder`）
        local: true,
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
  function addUser(textMsg: string, imgs: ImageAttachment[] = [], time?: number, refs?: RefSnap[], imageRefs?: AttachmentRef[], files?: Array<{ name: string; path?: string; bytes?: number }>, rpcId?: string, placement: PendingEcho['placement'] = 'transcript'): void {
    // 注意：错误条的清空在 `outbox.send`（提交那一刻，排队路径也覆盖）；这里**不**顺手清，
    // 否则「历史恢复」也会把刚发生的错误抹掉（恢复走 addUser 但不提交任何东西）。
    // **有提交标识 = 刚发出去、还没进日志那条**：只登记会话级回显，**不进行表**
    //（与上游同口径：回显是会话状态，行表里只有日志里的东西）。
    if (rpcId !== undefined && rpcId !== '') {
      pendingEchoes.value = [...pendingEchoes.value, { rpcId, placement, text: textMsg, time: time ?? Date.now(), images: imgs, ...(imageRefs !== undefined && imageRefs.length > 0 ? { imageRefs } : {}), ...(files !== undefined && files.length > 0 ? { files } : {}), ...(refs !== undefined ? { refs } : {}) }]
      return
    }
    // 历史恢复那条路（没有提交标识）：照旧直接进行表
    // 实时本地上送用本地时刻;恢复历史时传入事件自带时间戳,不覆盖为"现在"
    push({ kind: 'user', key: optUserKey--, text: textMsg, images: imgs, time: time !== undefined ? formatMsgClock(time) : nowTime(), refs, ...(imageRefs && imageRefs.length > 0 ? { imageRefs } : {}), ...(files && files.length > 0 ? { files } : {}), ...(rpcId !== undefined ? { rpcId } : {}) })
  }
  /** 接受节点模型映射出的 ChatRow：整表替换 + 回显认领（页面渲染源的唯一入口）。 */
function applyNodeRows(rows: ChatRow[], sessionId?: string, turnActive?: boolean, subagent?: SubagentFacts, seats?: ReadonlyArray<SeatPlanEntry>): void {
    // 座位计划与行表**同帧更新**：它是行的"分组说明书"（哪些行属于同一项），
    // 分两帧更新就会出现"计划指向已经不在的行"这种中间态。
    seatPlan.value = seats ?? []
    installMappedRows(rows, sessionId, turnActive, subagent)
}

function installMappedRows(host: ChatRow[], sessionId?: string, turnActive?: boolean, subagent?: SubagentFacts): void {
    // 会话变了 → 列表里那些「本地已出、尚未被回显认领」的乐观行属于**上一个会话**，必须丢掉：
    // 留着会让 pending 恒非空 → processing 恒真（一直「深度求索中」，停止按钮还对着别人的行）。
    // 上游的做法更彻底（乐观态挂在**会话**上、不混进时间线），这里先按会话归属把它清掉。
    if (sessionId !== undefined) {
      // 只在**确实换过会话**时丢弃：首次还没有归属，不算「换会话」
      // （否则页面刚打开就发消息的话，第一次下发会把那条乐观行清掉）。
      if (rowsSessionId !== undefined && rowsSessionId !== sessionId) {
        /**
         * ⚠️ **本轮正在跑**（`turnActive === true`）时**不整表清空**：
         *
         * 换了会话、而新会话这一帧就说"在跑"，几乎只可能是**在新会话里刚发出第一条** ——
         * 那一刻整表清空会把刚画上的**本地在途行**（乐观提问 + 本地占位回答）一起抹掉，而宿主那两帧
         * 还没到 → 会话区**空一拍再长回来**。真机现象（2026-10-07）：「新会话首次发送，会话区会闪一下」。
         *
         * 只清**宿主行**；本地在途行留给既有的两条回收路（`rpcId` 认领 + 提交台账退休，含 10s 宽限），
         * 所以不会发生"上一条会话的残行留下把 processing 撑住"那件事。
         */
        const midTurn = turnActive === true
        messages.value = midTurn
          ? messages.value.filter(
              (r) => (r.kind === 'user' && r.rpcId !== undefined) || (r.kind === 'assistant' && r.local === true)
            )
          : []
        processing.value = false
        runAnchorMs.value = undefined
        // 本地乐观行的台账镜像属于**上一个会话**：换会话必须清
        pendingSubmissions.value = []
        retiredSubmissions.value = []
        // 会话级回显同理（上游把回显挂在**会话**上，换会话天然不残留）
        pendingEchoes.value = []
        echoKeys.clear()
        // 子会话事实也属于上一个会话：先清掉，等宿主把新的那一份随行帧发来（否则会拿旧会话的
        // "这是子会话"去判新会话的主钮）
        subagentFacts.value = undefined
        turnRunning.value = false
        // 回合号是**会话内**编号：换会话后同一个号会指到别的回合，折叠展开态必须一起清
        turnFoldOpen.value = new Map<number, boolean>()
        // 片级键里也含回合号（`${turn}:${key}`），同样必须清
        groupFoldOpen.value = new Map<string, boolean>()
        // 外层折叠的"已唤出世代"按会话内回合号记 —— 同样必须清（否则新会话的同号回合会继承旧记录）
        outerAnswerStep.value = new Map<number, number>()
        // 读者的手动收起记录同理（换会话不能继承）
        outerFoldedByReader.value = new Map<number, number>()
        // **打开一个会话一律从底部开始**（对齐上游：没有存下的阅读位置时 `toBottom()`）。
        // 少了这一下，新会话的内容是在「保留原 scrollTop」的前提下长出来的 ——
        // 上一条会话若停在靠下的位置，打开新历史会话时视野就留在**最上面**（真机现象「光标跑到最上面去了」）。
        bumpScroll()
      }
      rowsSessionId = sessionId
    }
    const claimed = new Set(
      host
        .filter((r): r is Extract<ChatRow, { kind: 'user' }> => r.kind === 'user')
        .map((r) => r.rpcId)
        .filter((id): id is string => id !== undefined)
    )
    claimedRpcIds = claimed
    // 认领时把**本地独有**的信息并回宿主行（回填源 = **会话级回显**，不再是本地行）：
    //   · `refs`（@ 引用快照）—— 宿主事件里没有，不回填则发出后 chip 立刻消失；
    //   · 文件的**本地绝对路径** —— 宿主的文件只有附件 id（点开要走附件层取字节）；
    //   · **行 key 复用** —— 同一件事换 key 会让 preact 卸载再挂载那一行（首发送「闪一下」的来路）。
    // 图片来源**不回填**：宿主行自带 `imageRefs`，附件层那张才是要显示的那张（维护者定案）。
    const echoByRpc = new Map(pendingEchoes.value.map((e) => [e.rpcId, e]))
    const merged = host.map((r): ChatRow => {
      if (r.kind !== 'user' || r.rpcId === undefined) return r
      const echo = echoByRpc.get(r.rpcId)
      if (echo === undefined) return r
      const files = r.files !== undefined && echo.files !== undefined
        ? r.files.map((f) => {
            const local = echo.files?.find((x) => x.name === f.name && x.path !== undefined)
            return local?.path === undefined ? f : { ...f, path: local.path }
          })
        : r.files
      return {
        ...r,
        key: echoKeyOf(r.rpcId),
        ...(echo.refs !== undefined ? { refs: echo.refs } : {}),
        ...(files !== undefined ? { files } : {}),
      }
    })
    const localOnly = messages.value.filter(
      (r) => r.kind === 'approval' || r.kind === 'notice'
    )
    /**
     * ⚠️ **本地占位回答行一律不保留**（2026-10-07 回退：宁可"闪一下"，也不能多出一条正文）。
     *
     * 曾经为了让"新会话首次发送"不闪，把发送当帧那条本地占位回答行在整表重建时**显式保留**。
     * 代价太大：那条行在页面侧是"当前未定稿行"，一旦它活过宿主已经代表这一轮的那一帧，
     * **同名正文就会出现两遍**（真机 2026-10-08：左侧两段「修仙的我写…」，一段带裸 `**`、一段是渲染后的）。
     * 逐条核对过：宿主建出来的行里**根本没有**第二段那种正文 ⇒ 多出来那条是**页面自己留的**。
     *
     * 结论：占位行只活在"发送当帧 → 宿主第一帧"这一拍（宿主一到就由它代表），
     * 闪一下是可接受的**观感**代价，正文重复是不可接受的**数据**错误。
     */
    messages.value = [...merged, ...localOnly]
    // 提交失败的行（`failed`）留在列表里可读，但**不参与「处理中」** —— 那一栏只看下面三条腿。
    const lastAssistant = [...messages.value].reverse().find((r) => r.kind === 'assistant')
    /**
     * 「处理中」的**三条腿**（后两条是宿主的权威事实，前一条是"提交了但回合还没开跑"那一拍）：
     *   ① 台账里还有**待结算的空闲直发**（`placement === 'transcript'`）—— 上游用 `awaitingFirstTurn`
     *      表达同一件事：点击提交当帧就该显示「深度求索中」，不必等 `turn/start`；
     *   ② 宿主说本轮在跑（`turnActive`）；
     *   ③ 末条回答行还没定稿。
     * **不再有"本地乐观行还没被认领"这条腿** —— 那条腿没人回收时会把「处理中」永远撑住（真机 2026-10-06）。
     */
    const pendingTranscript = pendingSubmissions.value.some((p) => p.placement === 'transcript')
    processing.value =
      pendingTranscript || turnActive === true || (lastAssistant !== undefined && !lastAssistant.done)
    /**
     * 时钟锚点：最后一条**未定稿**的回答行上的回合开始时刻（上游 `runningStartTime` 同义 ——
     * 它取"打开中回合的 `turn.start.time`"）。行定稿（回合关闭）后清掉，状态行也就随之收摊。
     * 拿不到（提交后第一条行还没到）保持 `undefined`：状态行只写「深度求索中」，不起算。
     */
    runAnchorMs.value =
      lastAssistant !== undefined && !lastAssistant.done && lastAssistant.turnStartMs !== undefined
        ? lastAssistant.turnStartMs
        : undefined
    // 停止/插话只认宿主权威：processing 会在回答中被推导成 false
    turnRunning.value = turnActive === true
    // 子会话事实：与行同帧下发（普通会话不带这个键 → 清成 undefined，别留着上一个会话的）
    subagentFacts.value = subagent
  }

  /**
   * 宿主**提交台账**的帧（`submissions`）：整表的待结算提交 + 自上一帧以来退休的那些。
   *
   * 与上游 `SessionSnapshot.pendingSubmissions` 同构：位置由宿主推导、退休由宿主判定。页面拿它做三件事：
   *   ① 撑住"提交之后、回合真正开跑"那一拍的「处理中」（只要还有 `transcript` 待结算）；
   *   ② 把 `queued` 的**本地回显从对话区收掉**（由队列卡表示）—— 上游 `placement === 'queued'` 整类排除；
   *   ③ 把已经退休、又没入档的本地行标成「未提交成功」（不再有"永远在等"的行）。
   * 会话切换 / reset 时整表清空（回显只属于当前会话）。
   */
  function applySubmissions(
    pending: ReadonlyArray<{ rpcId: string; placement: 'transcript' | 'queued' | 'steering'; text: string }>,
    retired: ReadonlyArray<{ rpcId: string; outcome: string }>
  ): void {
    pendingSubmissions.value = pending
    retiredSubmissions.value = retired
    if (retired.length > 0) {
      // **退休单点**（上游 `finishSubmission`，`session-client/src/sessions/session.ts:865-873`）：
      // 不论 `admitted` / `queued` / `failed`，**回显一律从快照里删掉** ——
      // 上游 README 同句：「Identified failures and abandonment retire unadmitted echoes immediately」。
      // 失败的信息面不是"留一条失败气泡"，而是 **composer 的错误条 + 保留的草稿**（`onRetire` 携带 failed）。
      //
      // 真机 2026-10-18（"发送后怎么出现这么多内容"）：一度让 failed 的**留着并标 failed**，
      // 于是每次失败的尝试都留下一个气泡 —— 连发两次失败 + 一次成功 = 三个「1」，
      // 但服务端日志里只有一条 `user/message`（会话日志核对过）。上游没有"未提交成功"这种气泡。
      const outcomeOf = new Map(retired.map((r) => [r.rpcId, r.outcome]))
      pendingEchoes.value = pendingEchoes.value.filter((e) => !outcomeOf.has(e.rpcId))
    }
  }

  /**
   * 本次提交失败：本地乐观行标 `failed`（留作历史，但不再算「在等回显」），仍挂着的回答行定稿成错误。
   * 这是**本地**失败（没工作区 / 服务不可用 / RPC 报错），服务端根本没有这一回合 ——
   * 所以事件流里不会有 turn/end，行的 `endMsg` 只能由这里写进去（与旧通路的 `chatDone(end=error)` 同口径）。
   */
  function failSubmission(rpcId: string | undefined, msgText: string, code?: string): void {
    messages.value = messages.value.map((r): ChatRow => {
      if (r.kind !== 'user' || r.failed === true) return r
      // **只标还没被服务端回显认领的行**：已经认领的说明消息确实送到了，它不该被标成「未提交成功」
      if (r.rpcId === undefined || claimedRpcIds.has(r.rpcId)) return r
      // 没有标识时（宿主没带上）退化为「把所有还没回显的本地行都标掉」，宁可多标也不能留下卡住的
      if (rpcId !== undefined && r.rpcId !== rpcId) return r
      return { ...r, failed: true }
    })
    const idx = activeAssistantIndex()
    if (idx !== -1) {
      const row = messages.value[idx]
      // **本地占位的回答行整条撤掉**（上游：提交失败时服务端根本没有这一回合，界面上也不该出现回答行）。
      // 上一版把它标成 `status: 'error'` 留在表里 —— 后果是对话流里多一条"空的失败回答"，
      // 还会跟着宿主行一起重排（真机 2026-10-18：报错之后顺序错乱、新发的内容看不见）。
      if (row.kind === 'assistant' && row.local === true && row.done === false) {
        removeWhere((r) => r.key === row.key)
      }
    }
    // 原因**不进对话流**：走输入区那条错误条（上游 `promptError` 的同一格），下次提交即清。
    // 以前用 `showNotice` 往 messages 里压一条永久「通知行」—— 红字留着不走，还会插到用户行上面去。
    if (msgText !== '') promptError.value = { message: msgText, ...(code === undefined ? {} : { code }) }
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
  function pushApproval(
    approvalId: string,
    description: string,
    toolName?: string,
    displayReason?: Record<string, string>
  ): void {
    push({
      kind: 'approval',
      key: rowKey++,
      approvalId,
      description,
      ...(displayReason === undefined ? {} : { displayReason }),
      toolName,
    })
  }

  const nextKey = (): number => rowKey++
  const bumpScroll = (): void => {
    scrollPend.value = scrollPend.value + 1
  }
  /** 记下宿主给的窗口事实（跟 `chatEvents` 帧一起来；缺项不动，避免每帧把已知状态清回默认）。 */
  const applyHistory = (info: {
    hasMore?: boolean
    loading?: boolean
    events?: number
    openError?: { message: string; code?: string } | null
  }): void => {
    if (info.hasMore !== undefined) historyHasMore.value = info.hasMore
    if (info.loading !== undefined) historyLoading.value = info.loading
    if (info.events !== undefined) historyEvents.value = info.events
    // 整表语义：给了就照它写（`null` → 清掉横幅）
    if (info.openError !== undefined) sessionOpenError.value = info.openError ?? undefined
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
    // 换会话/重连：上一条提交失败的错误条不属于这个会话，必须清（否则一直挂在输入区上方）
    promptError.value = undefined
    runAnchorMs.value = undefined
    pendingSubmissions.value = []
    retiredSubmissions.value = []
    subagentFacts.value = undefined
    turnRunning.value = false
    turnFoldOpen.value = new Map<number, boolean>()
    groupFoldOpen.value = new Map<string, boolean>()
    outerAnswerStep.value = new Map<number, number>()
    outerFoldedByReader.value = new Map<number, number>()
    // 窗口事实随会话一起换：新会话的窗口由它自己的事件帧重写
    historyHasMore.value = false
    historyLoading.value = false
    historyEvents.value = 0
    // 「打开失败」是**上一个会话**的事实，换会话必须清（否则横幅会挂到别的会话上）
    sessionOpenError.value = undefined
  }

  return {
    store: {
      messages,
      view,
      processing,
      promptError,
      runAnchorMs,
      turnRunning,
      subagentFacts,
      scrollPend,
      seatPlan,
      pendingEchoes,
      visibleRows,
      pendingTranscriptInput,
      historyHasMore,
      historyLoading,
      historyEvents,
      sessionOpenError,
      applyHistory,
      loadOlder,
      showNotice,
      answerApproval,
      openFile,
      openAttachment,
      openAttachmentBytes,
    },
    openFile,
    openAttachment,
    openAttachmentBytes,
    applyNodeRows,
    failSubmission,
    applySubmissions,
    applyHistory,
    loadOlder,
    historyHasMore,
    historyLoading,
    historyEvents,
    seatPlan,
    sessionOpenError,
    pushApproval,
    addUser,
    beginAssistant,
    nextKey,
    push,
    bumpScroll,
    resetRows,
    turnFoldOpen,
    setTurnFoldOpen,
    groupFoldOpen,
    setGroupFoldOpen,
    outerAnswerStep,
    outerFoldedByReader,
    revealOuter,
    foldOuter,
  }
}
