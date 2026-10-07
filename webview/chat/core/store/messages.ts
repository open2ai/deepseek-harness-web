// 消息行模型切片：宿主下发的行（整表替换 + 乐观行认领）、通知行与审批行。
// 行 key 计数器在本切片内（per-store），不跨 store 实例共享——key 只用于同一列表内的替换匹配
// 与列表渲染 diff，各自从 1 计数即可。
import { computed, signal, type Signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { ImageAttachment, AttachmentRef } from '../protocol'
import { formatMsgClock } from '../format'
import type { DshStreamRow } from '../../../../src/dsh/rows/types'
import type { SubagentFacts } from '../stop-control'
import { toChatRows } from './host-rows'
import type { ChatRow, ChatStore, RefSnap } from './types'

export interface MessagesSlice {
  store: Pick<
    ChatStore,
    | 'messages'
    | 'view'
    | 'processing'
    | 'runAnchorMs'
    | 'turnRunning'
    | 'subagentFacts'
    | 'scrollPend'
    | 'historyHasMore'
    | 'historyLoading'
    | 'historyEvents'
    | 'sessionOpenError'
    | 'applyHistory'
    | 'loadOlder'
    | 'showNotice'
    | 'answerApproval'
    | 'openFile'
  >
  /**
   * 追加一条审批行。
   * `description` 是上游审计 `reason`；`displayReason` 是 dsh 0.1.7-rc.2 起并列给出的
   * 本地化展示文案，二者都原样存下行、由 `core/approval-text.ts` 决议最终显示哪一条。
   */
  pushApproval(approvalId: string, description: string, toolName?: string, displayReason?: Record<string, string>): void
  /** 追加一条用户行（本地乐观行：发出即显示，等宿主行回显后由提交标识认领）。 */
  addUser(text: string, imgs?: ImageAttachment[], time?: number, refs?: RefSnap[], imageRefs?: AttachmentRef[], files?: Array<{ name: string; path?: string; bytes?: number }>, rpcId?: string): void
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
  /** 直接追加一行（历史恢复构行用）。 */
  push(row: ChatRow): void
  /** 请求滚到底（+1 由列表组件消费后清零）。 */
  bumpScroll(): void
  /** 清空消息与进行中标记；不动 scrollPend 与 key 计数器。 */
  resetRows(): void
  /** 接受宿主下发的行（阶段 4）：映射后写入列表，并保留本地尚未被回显认领的乐观行。
   *  `sessionId` 用于判归属：会话一变，上一个会话的乐观行必须丢弃（否则 processing 恒真）。 */
  applyHostRows(rows: unknown, sessionId?: string, turnActive?: boolean, subagent?: SubagentFacts): void
  /** 更早的历史还没有进窗口（宿主给的窗口事实）：列表顶端据此出「加载更早」。 */
  historyHasMore: Signal<boolean>
  /** 「加载更早」是否在飞：按钮据此禁用并换成进行时文案。 */
  historyLoading: Signal<boolean>
  /** 窗口里的事件条数（诊断与「还需要往下翻多久」的直观量，不参与判定）。 */
  historyEvents: Signal<number>
  /** **打开历史失败**的事实（上游 `openState === 'error'`）：列表顶端据此出一条横幅；`undefined` = 没有失败。 */
  sessionOpenError: Signal<{ message: string; code?: string } | undefined>
  /** 记下宿主给的窗口事实（跟 `rows` 帧一起来，见 core/protocol 的 `rows`）。 */
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
   *  并把仍挂着的回答行定稿成错误。不这么做的话，它会一直被当成「在等回显」→ `processing` 恒真。 */
  failSubmission(rpcId: string | undefined, message: string): void
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
  /** 记下某回合"已唤出到的回答世代"（用户展开隐藏片 / 网页查找命中时调用）。 */
  revealOuter: (turn: number, answerStep: number) => void
  /** 反向：清掉该回合的"已唤出世代" → 回到"只留当前世代"的折起状态（完成态行上的 chevron 用它收起）。 */
  foldOuter: (turn: number) => void
}

/** 本地时刻串（实时上送用；历史恢复走事件自带时刻）。 */
const nowTime = (): string => formatMsgClock(Date.now())

/**
 * 本地回显**既没被宿主行认领、也不在提交台账里**时，最多还留多久（毫秒）。
 *
 * 为什么要有这条上限：本地乐观行本来靠两条权威事实回收 —— 宿主行里的 `rpcId`（入档回显）与台账的
 * 退休增量。两条都没有的旧回显原先**无限期留着**，而它又会被插到「未定稿回答行之前」，
 * 于是每一轮跑起来就重新冒出来一次（真机 2026-10-07：最早那条提问又出现在「思考 / 求索中」上方）。
 * 台帐帧在提交后几个毫秒内就到，所以这个宽限期只兜"这条回显谁也不认识"的情形：
 * 真入档的消息由宿主那条行表示，没入档的由台账标 `failed`，都不是这里丢的。
 */
const UNKNOWN_ECHO_GRACE_MS = 10_000

/**
 * 宿主行表里**同一条提交标识只留一行**（页面的最后一道闸）。
 *
 * 为什么放在页面这一层：宿主已经按消息 id 挡了一道（见 `src/dsh/rows/build.ts`），但页面拿到的是
 * 拼装后的整表 —— 窗口整表替换、行缓存与差分帧交错这些来路都在宿主与页面之间，多一道廉价的闸
 * 比在真机上再看到一次"提问重复"划算。同一 `rpcId` 的两行内容必然相同（它就是那一次提交的回显），
 * 而**用户真的连发两条同文案**时两条的 `rpcId` 不同、不受影响。
 */
function dropDuplicateUserRows(rows: ChatRow[]): ChatRow[] {
  const seen = new Set<string>()
  const out: ChatRow[] = []
  for (const row of rows) {
    if (row.kind === 'user' && row.rpcId !== undefined) {
      if (seen.has(row.rpcId)) {
        if (typeof console !== 'undefined') {
          console.warn(`[chat] 宿主行里同一条提交标识出现两次（rpcId=${row.rpcId}）：只留第一行`)
        }
        continue
      }
      seen.add(row.rpcId)
    }
    out.push(row)
  }
  return out
}

export function createMessages(host: ChatHost): MessagesSlice {
  const messages = signal<ChatRow[]>([])
  const view = computed<'welcome' | 'chat'>(() => (messages.value.length === 0 ? 'welcome' : 'chat'))
  const processing = signal(false)
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
  /**
   * 「宿主谁也不认识这条本地回显」的起点时刻（`rpcId` → epoch ms）：只由宽限期那条路读写
   *（见 `UNKNOWN_ECHO_GRACE_MS`），行被认领/退休后随即清掉，不会无界增长。
   */
  const unknownEchoAt = new Map<string, number>()
  const scrollPend = signal(0)
  /** 更早的历史还没进窗口（宿主事实，见 `src/api/dshService.ts` 的窗口分页）。 */
  const historyHasMore = signal(false)
  const historyLoading = signal(false)
  const historyEvents = signal(0)
  /** **打开历史失败**（上游 `openState === 'error'` 的 `openError`）：列表顶端横幅读它。 */
  const sessionOpenError = signal<{ message: string; code?: string } | undefined>(undefined)
  /**
   * **待结算的提交**（宿主台账的镜像：与上游 `SessionSnapshot.pendingSubmissions` 同构）。
   *
   * 页面不再自己推断"这条本地行还会不会来" —— 位置（`transcript` / `queued` / `steering`）与退休
   * 都由宿主判定（见 `src/dsh/submissions.ts`）：`queued` 交给队列卡表示、`steering` 留到入档、
   * `transcript` 在"提交之后、回合真正开跑"那一拍撑住「处理中」（上游 `awaitingFirstTurn` 的等价物）。
   * 于是「处理中」不再有一条"没人回收的本地乐观行"的腿（真机 2026-10-06 的卡死来路）。
   */
  const pendingSubmissions = signal<ReadonlyArray<{ rpcId: string; placement: 'transcript' | 'queued' | 'steering'; text: string }>>([])
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
  const revealOuter = (turn: number, answerStep: number): void => {
    if (outerAnswerStep.value.get(turn) === answerStep) {
      // 已经是这个世代：不产生新 Map（避免每帧新建引用导致订阅者白重渲）
      return
    }
    const next = new Map(outerAnswerStep.value)
    next.set(turn, answerStep)
    outerAnswerStep.value = next
  }
  /** 反向：把"已唤出世代"删掉 → 该回合回到"只留当前世代"的折起状态（完成态行上的 chevron 用它收起）。 */
  const foldOuter = (turn: number): void => {
    if (!outerAnswerStep.value.has(turn)) {
      return
    }
    const next = new Map(outerAnswerStep.value)
    next.delete(turn)
    outerAnswerStep.value = next
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
        // 本地占位：整表推行时必须被显式保留（见 `applyHostRows` 的 `localPlaceholder`）
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
  function addUser(textMsg: string, imgs: ImageAttachment[] = [], time?: number, refs?: RefSnap[], imageRefs?: AttachmentRef[], files?: Array<{ name: string; path?: string; bytes?: number }>, rpcId?: string): void {
    // 实时本地上送用本地时刻;恢复历史时传入事件自带时间戳,不覆盖为"现在"
    push({ kind: 'user', key: rowKey++, text: textMsg, images: imgs, time: time !== undefined ? formatMsgClock(time) : nowTime(), refs, ...(imageRefs && imageRefs.length > 0 ? { imageRefs } : {}), ...(files && files.length > 0 ? { files } : {}), ...(rpcId !== undefined ? { rpcId } : {}) })
  }
  /**
   * 接受宿主下发的行（阶段 4，见 docs/design/08 §11）：**整表替换** —— 宿主是行列表的唯一权威。
   * 只有一种例外：本地已出、但尚未被回显认领的**乐观行**要留住（否则刚发出去的消息会一闪而没）。
   * 认领判定用提交标识：宿主行里已有同标识 → 已被认领；没有 → 还没回显，保留在末尾。
   */
  function applyHostRows(rows: unknown, sessionId?: string, turnActive?: boolean, subagent?: SubagentFacts): void {
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
        // 宽限期那张表同理（键是 `rpcId`，属于上一个会话）
        unknownEchoAt.clear()
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
        // **打开一个会话一律从底部开始**（对齐上游：没有存下的阅读位置时 `toBottom()`）。
        // 少了这一下，新会话的内容是在「保留原 scrollTop」的前提下长出来的 ——
        // 上一条会话若停在靠下的位置，打开新历史会话时视野就留在**最上面**（真机现象「光标跑到最上面去了」）。
        bumpScroll()
      }
      rowsSessionId = sessionId
    }
    const host = dropDuplicateUserRows(toChatRows(Array.isArray(rows) ? (rows as DshStreamRow[]) : []))
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
    /**
     * **本地在等这条腿由宿主台账说了算**（真机 2026-10-06 的卡死来路）。
     *
     * 上游的规则是：回显的**位置**（`transcript` / `queued` / `steering`）在提交那一刻由**会话**推导，
     * 并由会话在四个时刻退休（入档 / 队列接受 / 失败或被放弃 / 销毁）。页面原先靠"`rpcId` 认领 + 同文案
     * 兜底"两条路回收本地行，缺"这条永远不会来了"那一条 → 页面判忙/闲与宿主不一致时（竞态），
     * 本地行永远认领不到，`processing` 被一条没人回收的腿撑住：一直「深度求索中」（且没有时长锚点）、
     * 停止按钮点了也没反应（`session.cancel` 对"本来没有在跑的回合"是空操作）。
     *
     * 现在：台账下发的 `retired` 是**权威的退休事件**（`admitted` → 宿主那条行已经在列表里；
     * `queued` → 队列卡接管；`failed` → 标「未提交成功」），页面只消费，不再推断。
     */
    /** 台账刚退休的那几条（`rpcId` → 去向）：决定本地行是"消失"还是"标未提交成功"。 */
    const justRetired = new Map<string, string>()
    for (const entry of retiredSubmissions.value) {
      justRetired.set(entry.rpcId, entry.outcome)
    }
    const retired = pendingKept.flatMap((r): Array<Extract<ChatRow, { kind: 'user' }>> => {
      if (r.rpcId === undefined) {
        return [r]
      }
      if (pendingSubmissions.value.some((p) => p.rpcId === r.rpcId)) {
        // 台账里还挂着：`queued` 交给队列卡表示（对话区这条退休）；`transcript` / `steering` 留着
        const entry = pendingSubmissions.value.find((p) => p.rpcId === r.rpcId)
        return entry?.placement === 'queued' ? [] : [r]
      }
      const outcome = justRetired.get(r.rpcId)
      if (outcome === undefined) {
        // 台账没交代它（帧还没到，或宿主没登记过）→ 先留着：宁可多留一会儿，也不要把正常提交标成失败。
        // **但只留一个宽限期**（见 `UNKNOWN_ECHO_GRACE_MS`）：无限期留着的话，一条宿主行表早就不含它
        // （入档那条行已经在加载窗口之外）、台账早已把它的退休增量吐完的旧回显，会在**每一轮**
        // 「未定稿回答行之前」重新插出来 —— 真机 2026-10-07：发新问题时最早那条提问又冒出来一次。
        const since = unknownEchoAt.get(r.rpcId)
        if (since === undefined) {
          unknownEchoAt.set(r.rpcId, Date.now())
          return [r]
        }
        if (Date.now() - since < UNKNOWN_ECHO_GRACE_MS) {
          return [r]
        }
        if (typeof console !== 'undefined') {
          console.warn(`[chat] 本地回显既没被宿主行认领、也不在提交台账里（rpcId=${r.rpcId}）：超过 ${String(UNKNOWN_ECHO_GRACE_MS)}ms，丢弃`)
        }
        return []
      }
      if (outcome === 'failed') {
        return [{ ...r, failed: true }]
      }
      // `admitted` / `queued`：回显退休（宿主那条行、或队列卡已经在表示它）
      return []
    })
    // 宽限期那张表的**清理**：只保留这一帧还在等认领的那些 id（行一被认领/退休/丢弃就随之删掉）
    if (unknownEchoAt.size > 0) {
      const waiting = new Set(pendingKept.map((r) => r.rpcId).filter((id): id is string => id !== undefined))
      for (const id of [...unknownEchoAt.keys()]) {
        if (!waiting.has(id)) {
          unknownEchoAt.delete(id)
        }
      }
    }
    /**
     * **本地独有行**：宿主行里根本不会有的那些 —— 审批卡、斜杠结果/错误提示。
     *
     * 为什么必须在这里挑出来：本函数是**整表替换**（`messages.value = ...`），而 `merged` 只是宿主行、
     * `pendingKept` 只留用户乐观行 —— 不显式保留的话，审批卡会在**宿主下一次推行的瞬间被整段丢掉**。
     *
     * 这正是真机现象「审批请求到了、授权卡却不出现」的成因：提权发生在回合进行中，
     * 而回合进行中每一步都会推一次行（`tool/call`、流式增量…），所以卡片几乎立刻被冲掉。
     * 帧侧是好的（`$events` 已收到、agentId 与会话键一致），坏的是这里。
     *
     * 位置：统一附在**末尾**。审批卡是「等你操作」的交互卡，不随时间线滚动，附末尾最直观
     * （上游的审批是覆盖层，也不在时间线里）。会话切换时由上面的分支整表清空，不会带到别的会话。
     */
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
    const localPlaceholder: ChatRow[] = []
    messages.value = [
      ...(openAssistantAt === -1
        ? [...merged, ...retired]
        : [...merged.slice(0, openAssistantAt), ...retired, ...merged.slice(openAssistantAt)]),
      ...localPlaceholder,
      ...localOnly,
    ]
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
          bodyStarted: true,
        })
        hit = true
        // 原因**不进回答行**：本地失败在服务端没有这一回合 → 没有 `turn/end`，上游也不会出 `turn-error` 行；
        // 走与「没有回答行可挂」时同一条通路（通知行），不伪造回合失败行
        if (msgText !== '') showNotice(msgText)
      }
    }
    if (!hit && msgText !== '') showNotice(msgText)
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
  /** 记下宿主给的窗口事实（跟 `rows` 帧一起来；缺项不动，避免每帧把已知状态清回默认）。 */
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
    runAnchorMs.value = undefined
    pendingSubmissions.value = []
    retiredSubmissions.value = []
    unknownEchoAt.clear()
    subagentFacts.value = undefined
    turnRunning.value = false
    turnFoldOpen.value = new Map<number, boolean>()
    groupFoldOpen.value = new Map<string, boolean>()
    outerAnswerStep.value = new Map<number, number>()
    // 窗口事实随会话一起换：新会话的窗口由它自己的 `rows` 帧重写
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
      runAnchorMs,
      turnRunning,
      subagentFacts,
      scrollPend,
      historyHasMore,
      historyLoading,
      historyEvents,
      sessionOpenError,
      applyHistory,
      loadOlder,
      showNotice,
      answerApproval,
      openFile,
    },
    openFile,
    applyHostRows,
    failSubmission,
    applySubmissions,
    applyHistory,
    loadOlder,
    historyHasMore,
    historyLoading,
    historyEvents,
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
    revealOuter,
    foldOuter,
  }
}
