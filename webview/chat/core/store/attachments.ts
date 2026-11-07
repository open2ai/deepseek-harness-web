// 附件大类切片：按 attachmentId 懒取字节的缓存与请求，供各**子类卡**（图片卡…）共用。
//
// 为什么单独成切片：结果帧里**没有字节**（只有附件引用），要显示就得按需向宿主取；而「取件 /
// 缓存 / 加载中 / 失败可重试 / 换会话清空」是各类附件共用的机制，渲染与判定留给孩子卡。
// 不在这里做任何「什么工具、什么形状」的判定 —— 那是子类卡的事。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { AttachmentEntry, ChatStore } from './types'

export interface AttachmentsSlice {
  store: Pick<ChatStore, 'attachmentCache' | 'requestAttachment'>
  /** 宿主回帧：落缓存（成功与失败都记；失败态可由 requestAttachment 重新发起）。 */
  receiveAttachment(attachmentId: string, entry: { state: 'ready'; mediaType: string; data: string } | { state: 'error'; error: string }): void
  /** 清空缓存与在飞标记（换会话/清屏）。 */
  reset(): void
}

export function createAttachments(host: ChatHost): AttachmentsSlice {
  const attachmentCache = signal<Record<string, AttachmentEntry>>({})
  /** 已发出、还没回帧的 id：避免同一附件并发重复取。 */
  const inflight = new Set<string>()

  /**
   * 取件的引用字段。0.2.2 的 `session/attachment` 描述符是 strict codec：`attachmentId` +
   * `mediaType` + `bytes` + `width` + `height` 全部 required —— 有就原样转给宿主、缺了宿主会
   * 直接走本地对象库（不再发一条注定被拒的 RPC）。
   */
  type AttachmentRef = { attachmentId: string; mediaType?: string; bytes?: number; width?: number; height?: number; name?: string }

  function requestAttachment(ref: AttachmentRef): void {
    if (ref.attachmentId === '') return
    const known = attachmentCache.value[ref.attachmentId]
    // 已就绪或正在取 → 不再发；只有「失败」允许重试
    if (known !== undefined && known.state !== 'error') return
    if (inflight.has(ref.attachmentId)) return
    inflight.add(ref.attachmentId)
    attachmentCache.value = { ...attachmentCache.value, [ref.attachmentId]: { state: 'loading' } }
    host.post({
      type: 'attachmentReq',
      attachmentId: ref.attachmentId,
      ...(ref.mediaType === undefined ? {} : { mediaType: ref.mediaType }),
      ...(ref.bytes === undefined ? {} : { bytes: ref.bytes }),
      ...(ref.width === undefined ? {} : { width: ref.width }),
      ...(ref.height === undefined ? {} : { height: ref.height }),
      ...(ref.name === undefined ? {} : { name: ref.name }),
    })
  }

  function receiveAttachment(
    attachmentId: string,
    entry: { state: 'ready'; mediaType: string; data: string } | { state: 'error'; error: string }
  ): void {
    inflight.delete(attachmentId)
    attachmentCache.value = { ...attachmentCache.value, [attachmentId]: entry }
  }

  function reset(): void {
    inflight.clear()
    attachmentCache.value = {}
  }

  return { store: { attachmentCache, requestAttachment }, receiveAttachment, reset }
}
