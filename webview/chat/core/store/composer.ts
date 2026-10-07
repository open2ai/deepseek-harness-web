// 输入区切片：文本、图片、附件、@ 引用贴片，以及不经由消息行的宿主直通动作
// （取消 / 复制 / 选文件 / 执行斜杠命令）。不依赖 messages 信号。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { StagedFile } from './types'
import type { ImageAttachment } from '../protocol'
import type { ChatStore, RefChip } from './types'

export interface ComposerSlice {
  store: Pick<
    ChatStore,
    | 'text'
    | 'attachments'
    | 'images'
    | 'refs'
    | 'focusTick'
    | 'runSlash'
    | 'pickFile'
    | 'copy'
    | 'cancel'
    | 'addImage'
    | 'removeImage'
    | 'addAttachment'
    | 'removeAttachment'
    | 'retryUpload'
    | 'addRef'
    | 'removeRef'
    | 'readImageFile'
  >
  /** 宿主草稿消息到达：并入输入框文本并触发焦点。 */
  appendDraft(draft: string | undefined): void
  /** 宿主回帧：就绪（带凭据/大小）或失败（带原因）。 */
  receiveUpload(key: string, result: { receiptId?: string; name?: string; bytes?: number; error?: string }): void
  reset(): void
}

export function createComposer(host: ChatHost): ComposerSlice {
  const text = signal('')
  const attachments = signal<StagedFile[]>([])
  const images = signal<ImageAttachment[]>([])
  const refs = signal<RefChip[]>([])
  const focusTick = signal(0)
  let refKey = 1

  /** 执行一条 dsh 斜杠命令：清空输入后发宿主（不入聊天气泡）。 */
  function runSlash(line: string): void {
    const t = (line ?? '').trim()
    if (!t.startsWith('/')) return
    if (text.value === t) text.value = ''
    host.post({ type: 'slashRun', text: t })
  }
  /**
   * 复制一段文本。**两条路都要走**（真机 2026-10-07：「复制按钮点了没反应」）：
   *
   * ① 先试**浏览器剪贴板**（上游那条路：`navigator.clipboard.writeText`）—— 在 webview 里通常可用，
   *    且不依赖宿主的往返；拿不到（非安全上下文）或被拒（权限 / iframe 策略）时，
   * ② **退回宿主**那条（`{type:'copy'}` → VS Code 的剪贴板 API）。
   *
   * ⚠️ **不能只留宿主那条**：宿主那条只要有一环失效（webview 未聚焦、宿主侧写入被拒），页面这边
   * 就完全静默 —— 按钮看着能点、内容却进不了剪贴板。两条并用时，任一条成功即成功。
   */
  const copy = (c: string): void => {
    if (!c) return
    const viaHost = (): void => {
      host.post({ type: 'copy', text: c })
    }
    const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator)
    const writeText = nav?.clipboard?.writeText
    if (typeof writeText !== 'function') {
      viaHost()
      return
    }
    void writeText.call(nav?.clipboard, c).then(
      () => undefined,
      // 浏览器那条被拒（未聚焦 / 权限）：退回宿主，别让用户看到"点了没反应"
      () => {
        viaHost()
      }
    )
  }
  const pickFile = (): void => {
    host.post({ type: 'pickFile' })
  }
  function cancel(): void {
    host.post({ type: 'cancel' })
  }

  // ---------- 附件 / 图片 ----------
  function renderAttachmentsDeps(): void {
    // images/attachments 是信号,改动即触发重渲;此函数仅为保持调用点语义占位
  }
  function addImage(img: ImageAttachment): void {
    images.value = [...images.value, img]
    renderAttachmentsDeps()
  }
  const removeImage = (img: ImageAttachment): void => {
    images.value = images.value.filter((i) => i !== img)
  }
  let fileKey = 1
  const baseName = (p: string): string => p.split(/[\/]/).pop() || p
  /** 发起一次上传（选中即传；宿主读字节，webview 只给路径）。 */
  function requestUpload(entry: StagedFile): void {
    host.post({ type: 'fileUploadReq', key: entry.key, path: entry.path })
  }
  function addAttachment(p: string): void {
    if (!p) return
    const entry: StagedFile = { key: `f${fileKey++}`, path: p, name: baseName(p), state: 'uploading' }
    attachments.value = [...attachments.value, entry]
    requestUpload(entry)
  }
  /** 宿主回帧：就绪（带凭据/大小）或失败（带原因）。 */
  function receiveUpload(key: string, result: { receiptId?: string; name?: string; bytes?: number; error?: string }): void {
    attachments.value = attachments.value.map((a) => {
      if (a.key !== key) return a
      if (result.receiptId === undefined) return { ...a, state: 'error' as const, error: result.error ?? '上传失败' }
      return {
        ...a,
        state: 'ready' as const,
        receiptId: result.receiptId,
        ...(result.name === undefined ? {} : { name: result.name }),
        ...(result.bytes === undefined ? {} : { bytes: result.bytes }),
      }
    })
  }
  /** 失败重试：回到上传中再发一次（key 不变，回帧仍能对上）。 */
  function retryUpload(key: string): void {
    const entry = attachments.value.find((a) => a.key === key)
    if (entry === undefined) return
    const next: StagedFile = { ...entry, state: 'uploading', error: undefined }
    attachments.value = attachments.value.map((a) => (a.key === key ? next : a))
    requestUpload(next)
  }
  const removeAttachment = (key: string): void => {
    attachments.value = attachments.value.filter((a) => a.key !== key)
  }
  /** 添加一条 @ 引用贴片（label 用于显示，token 为发送时注入 prompt 的引用文本）。 */
  function addRef(kind: RefChip['kind'], label: string, token: string, detail?: string): void {
    refs.value = [...refs.value, { key: refKey++, kind, label, token, detail }]
  }
  const removeRef = (key: number): void => {
    refs.value = refs.value.filter((r) => r.key !== key)
  }
  function readImageFile(file: File): void {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(result)
      if (!m) return
      addImage({ mediaType: m[1], data: m[2], name: file.name || '图片' })
    }
    reader.readAsDataURL(file)
  }

  function appendDraft(draft: string | undefined): void {
    text.value = text.value ? text.value + '\n' + (draft ?? '') : draft ?? ''
    focusTick.value++
  }

  /** 新会话清空：只清输入区四项，不动 focusTick 与内部 refKey。 */
  function reset(): void {
    attachments.value = []
    images.value = []
    refs.value = []
    text.value = ''
  }

  return {
    store: {
      text,
      attachments,
      images,
      refs,
      focusTick,
      runSlash,
      pickFile,
      copy,
      cancel,
      addImage,
      removeImage,
      addAttachment,
      removeAttachment,
      retryUpload,
      addRef,
      removeRef,
      readImageFile,
    },
    receiveUpload,
    appendDraft,
    reset,
  }
}
