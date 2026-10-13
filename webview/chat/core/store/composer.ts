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
    | 'insertText'
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
  /**
   * 复制一段文本。**两条路都走（无条件）**，任一条成功即成功。
   *
   * ⚠️ **这里曾经是"浏览器成功就返回、只有被拒才回落宿主"** —— 真机反馈「复制按钮点了没反应」。
   * 那种写法漏掉了 VS Code webview 最常见的一种失败：`navigator.clipboard.writeText`
   * 的 Promise **成功 resolve、却没写进系统剪贴板**（webview 未聚焦 / 权限策略）。
   * 于是宿主那条永远不走，页面这边也拿不到任何失败信号 —— 按钮的"复制成功"提示照出，
   * 剪贴板却是空的（假成功）。
   *
   * 现在两条**无条件并行**：浏览器那条负责上游口径（`navigator.clipboard`），
   * 宿主那条（`{type:'copy'}` → VS Code 剪贴板 API）兜底；重复写同样的内容是幂等的，
   * 不会互相覆盖出问题。任一条真的写进去，用户粘贴时就拿得到。
   *
   * @param c - 要复制的文本（空串直接忽略）。
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
    // **先发宿主那条**（同步发出，不受浏览器那条的 Promise 影响），再走浏览器那条。
    viaHost()
    void writeText.call(nav?.clipboard, c).then(
      () => undefined,
      () => undefined
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

  /**
   * 在**光标处**插入一段纯文本（语音转写的落点，对齐上游 `InputActions.insertText`）。
   *
   * 与 `appendDraft` 的区别是刻意的：`appendDraft` 是宿主推来的草稿（整条追加、另起一行），
   * 而这里要**就地插入**到用户当前光标/选中处，并且**不覆盖**用户已经写的字。
   *
   * 选区取当下的真实 DOM 选区（`#input` 的 selectionStart/End）；拿不到（焦点不在输入框）
   * 就落到末尾 —— 与"接着说"的直觉一致。
   *
   * ⚠️ 插入必须让 store 的 `text` 与 DOM 的 value 同步（textarea 是受控的），并给一次 focusTick
   * 让输入框重新聚焦、光标落到插入文本之后，否则用户得自己再点一下输入框。
   *
   * @param insert - 要插入的文本（调用方负责 trim 与非空）。
   */
  function insertText(insert: string): void {
    if (insert === '') return
    const el = typeof document === 'undefined' ? null : (document.getElementById('input') as HTMLTextAreaElement | null)
    const current = text.value
    const start = el !== null && el.selectionStart !== null ? Math.min(el.selectionStart, current.length) : current.length
    const end = el !== null && el.selectionEnd !== null ? Math.min(el.selectionEnd, current.length) : current.length
    const next = current.slice(0, start) + insert + current.slice(Math.max(start, end))
    text.value = next
    focusTick.value++
    if (el !== null) {
      const caret = start + insert.length
      queueMicrotask(() => {
        try {
          el.focus()
          // ⚠️ `setSelectionRange` 在有的 DOM 实现里没有（linkedom 就没有）：光标定位是**锦上添花**，
          // 不能让它在守卫里抛出去把整套断言带走。
          if (typeof el.setSelectionRange === 'function') el.setSelectionRange(caret, caret)
        } catch { /* 光标定不上不影响文本已插入 */ }
      })
    }
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
      insertText,
      readImageFile,
    },
    receiveUpload,
    appendDraft,
    reset,
  }
}
