// 队列切片（输入框上方的队列卡）：宿主下发的排队消息整表 + 插话气泡 + 三个动作。
//
// 队列**不是行**：它不属于任何回合、不进对话流 —— 所以状态自持在这里，绝不写 messages。
// 权威与乐观的边界：宿主帧是唯一权威（整表替换）。**「发送中…」行与插话气泡都由宿主台账
// （`submissions.pending`，见 `messages.pendingSubmissions`）推导** —— 页面不持第二份本地行状态，
// 也没有"按 rpcId 认领"那一步（上游 `QueueDock` 的 `pendingQueue` / `pendingInputs` 同款）。
// 动作**非乐观**：编辑 / 删除 / 插话都等服务端回帧（已被取走的条目服务端会拒），期间该行按钮禁用。
import { computed, signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { QueueItemView } from '../protocol'
import type { ChatStore, PendingSteering, PendingSubmission, QueueEditing } from './types'

/** 一条排队项上的三种变更（与宿主帧的动作形状一致）。 */
type QueueAction = { kind: 'edit'; text: string } | { kind: 'remove' } | { kind: 'steer' }

export interface QueueSlice {
  store: Pick<
    ChatStore,
    | 'queueItems'
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
  /** 宿主队列帧：整表替换；会话一变即丢编辑态与去重记录。 */
  applyQueue(sessionId: string | undefined, items: QueueItemView[]): void
  /**
   * 对话区下发的用户行（日志里已落账的提交标识）。
   *
   * **挡住权威 steering 项的重复显示** —— 取用时，日志行与台账/收件箱投影分别走两条流，
   * 行先到、帧后到的那一瞬两者会同时可见（上游在渲染期按 `rpcId` 去重，这里等价地在投影期去重）。
   */
  noteDurable(rpcIds: Iterable<string>): void
  /** 队列变更失败：按动作给上游文案（不带错误码后缀；插话的两种竞态由宿主收敛，走不到这里）。 */
  showActionFailure(op: 'edit' | 'remove' | 'steer'): void
  /** 动作已结算（宿主 ack）：无条件清该行忙碌态（上游在动作 Promise 的 finally 里清）。 */
  clearBusy(itemId?: string): void
  reset(): void
}

/** 失败文案：按动作分档，与上游 locale 逐字同句（不带错误码后缀；错误码只留在协议帧/日志里）。 */
function failureText(op: 'edit' | 'remove' | 'steer'): string {
  if (op === 'edit') {
    return '编辑失败：这条消息可能已经开始发送。'
  }
  if (op === 'remove') {
    return '删除失败：这条消息可能已经开始发送。'
  }
  return '插话发送失败，请重试。'
}

export function createQueue(
  host: ChatHost,
  notify: (text: string) => void,
  pendingSubmissions: () => readonly PendingSubmission[]
): QueueSlice {
  const queueItems = signal<QueueItemView[]>([])
  const queueEditing = signal<QueueEditing | null>(null)
  const queueBusy = signal<string | null>(null)
  /** 对话区已落账（日志里已有对应用户行）的提交标识：挡 pending 气泡重复显示用（见 noteDurable）。 */
  const durableRpcIds = signal<ReadonlySet<string>>(new Set<string>())
  /**
   * 对话区末尾的 pending 插话气泡：还没进日志的那条插话。
   *
   * 两个来源合成（上游同款：收件箱里的 steering 项 + 台账里 `placement='steering'` 的待结算提交）：
   *   - 权威项：服务端说「这条还挂在下一步的收件箱里」——回合结束后它仍在这里（停止不清队列）；
   *   - 台账项：提交那一刻就登记（`beginSubmission` 在提示词发出前），被收件箱/日志按 `rpcId` 接管后消失。
   * 失败的回显**不进这里**（台账已把它退休，错误在输入区错误条）。
   */
  const pendingSteering = computed<PendingSteering[]>(() => {
    const out: PendingSteering[] = []
    const authoritative = new Set<string>()
    for (const item of queueItems.value) {
      if (item.placement !== 'steering') {
        continue
      }
      if (item.rpcId !== undefined) {
        authoritative.add(item.rpcId)
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
    for (const sub of pendingSubmissions()) {
      if (sub.placement !== 'steering') {
        continue
      }
      // 收件箱项/日志行已接管 → 台账还没退休的那一拍不重复画
      if (authoritative.has(sub.rpcId) || durableRpcIds.value.has(sub.rpcId)) {
        continue
      }
      out.push({ key: `s:${sub.rpcId}`, text: sub.text, attachments: sub.attachments })
    }
    return out
  })
  /** 当前队列属于哪个会话：会话一变，编辑态与去重记录都必须丢（它们属于上一个会话）。 */
  let queueSessionId: string | undefined

  function postUpdate(itemId: string, action: QueueAction): void {
    queueBusy.value = itemId
    host.post({ type: 'queueUpdate', itemId, action })
  }

  function applyQueue(sessionId: string | undefined, items: QueueItemView[]): void {
    if (sessionId !== undefined) {
      // 与行同款判定：只在**确实换过会话**时丢弃（首次还没有归属，不算换会话）
      if (queueSessionId !== undefined && queueSessionId !== sessionId) {
        queueEditing.value = null
        durableRpcIds.value = new Set<string>()
      }
      queueSessionId = sessionId
    }
    queueItems.value = [...items]
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

  function noteDurable(rpcIds: Iterable<string>): void {
    durableRpcIds.value = new Set(rpcIds)
  }

  /** 动作已结算（宿主 ack）：无条件清该行忙碌态（上游在动作 Promise 的 finally 里清）。 */
  function clearBusy(itemId?: string): void {
    if (itemId === undefined || queueBusy.value === itemId) {
      queueBusy.value = null
    }
  }

  function showActionFailure(op: 'edit' | 'remove' | 'steer'): void {
    queueBusy.value = null
    notify(failureText(op))
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
    queueEditing.value = null
    queueBusy.value = null
    durableRpcIds.value = new Set<string>()
    queueSessionId = undefined
  }

  return {
    store: {
      queueItems,
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
    noteDurable,
    showActionFailure,
    clearBusy,
    reset,
  }
}
