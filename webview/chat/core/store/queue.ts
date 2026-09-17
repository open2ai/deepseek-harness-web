// 队列切片（输入框上方的队列卡）：宿主下发的排队消息整表 + 本地「发送中」条目 + 三个动作。
//
// 队列**不是行**：它不属于任何回合、不进对话流 —— 所以状态自持在这里，绝不写 messages。
// 权威与乐观的边界：宿主帧是唯一权威（整表替换）；本地只允许存在「已提交、还没被权威帧按
// `rpcId` 认领」的发送中条目，认领一到即消失，除此之外不做任何推断。
// 动作**非乐观**：编辑 / 删除 / 插话都等服务端回帧（已被取走的条目服务端会拒），期间该行按钮禁用。
import { computed, signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { QueueItemView } from '../protocol'
import type { ChatStore, PendingSteering, QueueEditing, QueueSending } from './types'

/** 一条排队项上的三种变更（与宿主帧的动作形状一致）。 */
type QueueAction = { kind: 'edit'; text: string } | { kind: 'remove' } | { kind: 'steer' }

export interface QueueSlice {
  store: Pick<
    ChatStore,
    | 'queueItems'
    | 'queueSending'
    | 'queueEditing'
    | 'queueBusy'
    | 'pendingSteering'
    | 'editQueueItem'
    | 'saveQueueEdit'
    | 'cancelQueueEdit'
    | 'removeQueueItem'
    | 'steerQueueItem'
    | 'steerWholeQueue'
  >
  /** 宿主队列帧：整表替换 + 按 `rpcId` 认领本地发送中条目；会话一变即丢本地那两样。 */
  applyQueue(sessionId: string | undefined, items: QueueItemView[]): void
  /** 忙时提交后立刻登记一条「发送中」（等权威帧按 `rpcId` 认领）。 */
  addSending(entry: QueueSending): void
  /** 忙时提交失败：只标这一条（**不碰**对话区里正在跑的那一行）。 */
  failSending(rpcId: string | undefined, message: string): void
  /**
   * 按提交标识认领本地「发送中」条目（对话区的用户行回显也走这里）。
   *
   * 为什么不止看队列帧：忙时/空闲的判定在页面与宿主各有一份，竞态下这次提交也可能**没进队列**
   * 而直接成了本轮提问（用户行回显）。只认队列帧的话，那条「发送中」会永远挂着 —— 一并认领即可。
   */
  claimSending(rpcIds: Iterable<string>): void
  /**
   * 对话区下发的用户行（日志里已落账的提交标识）。
   *
   * 两个用途：① 退休对应的本地回显；② **挡住权威 steering 项的重复显示** —— 取用时，
   * 日志行与收件箱投影分别走两条流，行先到、队列帧后到的那一瞬两者会同时可见（上游在渲染期按
   * `rpcId` 去重，这里等价地在投影期去重）。
   */
  noteDurable(rpcIds: Iterable<string>): void
  /** 队列变更失败：按动作给提示（两种竞态不会走到这里，宿主只刷新）。 */
  showActionFailure(op: 'edit' | 'remove' | 'steer', code?: string): void
  reset(): void
}

/** 失败文案：按动作分档（两种竞态不在这里，它们不是错误）。 */
function failureText(op: 'edit' | 'remove' | 'steer', code?: string): string {
  const base =
    op === 'edit'
      ? '编辑失败：这条消息可能已经开始发送。'
      : op === 'remove'
        ? '删除失败：这条消息可能已经开始发送。'
        : '插话发送失败，请重试。'
  return code === undefined ? base : `${base}（${code}）`
}

export function createQueue(host: ChatHost, notify: (text: string) => void): QueueSlice {
  const queueItems = signal<QueueItemView[]>([])
  const queueSending = signal<QueueSending[]>([])
  const queueEditing = signal<QueueEditing | null>(null)
  const queueBusy = signal<string | null>(null)
  /** 对话区已落账（日志里已有对应用户行）的提交标识：挡 pending 气泡重复显示用（见 noteDurable）。 */
  const durableRpcIds = signal<ReadonlySet<string>>(new Set<string>())
  /**
   * 对话区末尾的 pending 插话气泡：还没进日志的那条插话。
   *
   * 两个来源合成（上游同款：宿主收件箱里的 steering 项 + 本地尚未被认领的回显）：
   *   - 权威项：服务端说「这条还挂在下一步的收件箱里」——回合结束后它仍在这里（停止不清队列）；
   *   - 本地回显：提交那一刻就出气泡（`mode==='steer'` 的发送中条目），被权威帧或用户行按 `rpcId` 认领即消失。
   * 失败的回显**不进这里**（它已经不是「等待取用」，错误在队列卡里显示）。
   */
  const pendingSteering = computed<PendingSteering[]>(() => {
    const out: PendingSteering[] = []
    const localRpcIds = new Set(
      queueSending.value.filter((s) => s.mode === 'steer' && s.failed !== true).map((s) => s.rpcId)
    )
    for (const item of queueItems.value) {
      if (item.placement !== 'steering') {
        continue
      }
      // 权威项已到 → 本地那条不再重复显示（认领通常已退休它，这里再兜一层）
      if (item.rpcId !== undefined && localRpcIds.has(item.rpcId)) {
        continue
      }
      // 日志里已经有这条了（队列帧还慢一帧）→ 不再当 pending 显示，否则与真实行重复
      if (item.rpcId !== undefined && durableRpcIds.value.has(item.rpcId)) {
        continue
      }
      out.push({
        key: `q:${item.id}`,
        text: item.text,
        attachments: (item.attachments ?? []).map((a) => ({
          kind: a.kind,
          ...(a.name === undefined ? {} : { name: a.name }),
          ...(a.bytes === undefined ? {} : { bytes: a.bytes }),
        })),
      })
    }
    for (const s of queueSending.value) {
      if (s.mode !== 'steer' || s.failed === true) {
        continue
      }
      // 权威项没有贴片快照（它只有正文），本地回显带上 → pending 气泡的贴片短名与刚发出去时一致
      out.push({ key: `s:${s.rpcId}`, text: s.text, attachments: s.attachments, ...(s.refs === undefined ? {} : { refs: s.refs }) })
    }
    return out
  })
  /** 当前队列属于哪个会话：会话一变，本地发送中条目与编辑态都必须丢（它们属于上一个会话）。 */
  let queueSessionId: string | undefined

  function postUpdate(itemId: string, action: QueueAction): void {
    queueBusy.value = itemId
    host.post({ type: 'queueUpdate', itemId, action })
  }

  function applyQueue(sessionId: string | undefined, items: QueueItemView[]): void {
    if (sessionId !== undefined) {
      // 与行同款判定：只在**确实换过会话**时丢弃（首次还没有归属，不算换会话）
      if (queueSessionId !== undefined && queueSessionId !== sessionId) {
        queueSending.value = []
        queueEditing.value = null
        durableRpcIds.value = new Set<string>()
      }
      queueSessionId = sessionId
    }
    queueItems.value = [...items]
    // 认领：权威帧里出现的 `rpcId` → 本地那条「发送中」退休（与用户行认领同一手法，但各自独立）
    claimSending(items.map((i) => i.rpcId).filter((id): id is string => id !== undefined))
    // 编辑态收敛：条目已经不在队列里（被取走 / 被删），或文本已经与编辑内容一致 → 结束编辑
    const editing = queueEditing.value
    if (editing !== null) {
      const row = items.find((i) => i.id === editing.id)
      if (row === undefined || row.text.trim() === editing.text.trim()) {
        queueEditing.value = null
      }
    }
    queueBusy.value = null
  }

  function addSending(entry: QueueSending): void {
    queueSending.value = [...queueSending.value, entry]
  }

  function claimSending(rpcIds: Iterable<string>): void {
    const claimed = new Set(rpcIds)
    if (claimed.size === 0 || !queueSending.value.some((s) => claimed.has(s.rpcId))) {
      return
    }
    queueSending.value = queueSending.value.filter((s) => !claimed.has(s.rpcId))
  }

  function noteDurable(rpcIds: Iterable<string>): void {
    durableRpcIds.value = new Set(rpcIds)
    claimSending(rpcIds)
  }

  function failSending(rpcId: string | undefined, message: string): void {
    queueSending.value = queueSending.value.map((s) =>
      rpcId !== undefined && s.rpcId !== rpcId ? s : { ...s, failed: true, error: message }
    )
    queueBusy.value = null
  }

  function showActionFailure(op: 'edit' | 'remove' | 'steer', code?: string): void {
    queueBusy.value = null
    notify(failureText(op, code))
  }

  const editQueueItem = (id: string, text: string): void => {
    queueEditing.value = { id, text }
  }
  const cancelQueueEdit = (): void => {
    queueEditing.value = null
  }
  function saveQueueEdit(): void {
    const editing = queueEditing.value
    if (editing === null || editing.text.trim() === '') {
      return // 空文本不发（服务端同样会拒）；编辑态留着，用户可继续改
    }
    postUpdate(editing.id, { kind: 'edit', text: editing.text })
  }
  const removeQueueItem = (id: string): void => {
    postUpdate(id, { kind: 'remove' })
  }
  const steerQueueItem = (id: string): void => {
    postUpdate(id, { kind: 'steer' })
  }
  /**
   * 全队转插话：逐条发一次变更，**不等回帧**。
   * 每次变更是独立请求，服务端对「已经被取走 / 回合已结束」只会静默拒绝 ——
   * 所以中途回合结束不会把剩下的条目弄坏，它们仍留在队列里。
   */
  function steerWholeQueue(): void {
    for (const item of queueItems.value) {
      if (item.placement !== 'queued') {
        continue
      }
      postUpdate(item.id, { kind: 'steer' })
    }
  }

  function reset(): void {
    queueItems.value = []
    queueSending.value = []
    queueEditing.value = null
    queueBusy.value = null
    durableRpcIds.value = new Set<string>()
    queueSessionId = undefined
  }

  return {
    store: {
      queueItems,
      queueSending,
      queueEditing,
      queueBusy,
      pendingSteering,
      editQueueItem,
      saveQueueEdit,
      cancelQueueEdit,
      removeQueueItem,
      steerQueueItem,
      steerWholeQueue,
    },
    applyQueue,
    addSending,
    claimSending,
    noteDurable,
    failSending,
    showActionFailure,
    reset,
  }
}
