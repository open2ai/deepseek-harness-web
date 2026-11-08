// 输入区表面：@ 引用行 + Lexical 编辑器宿主 + 占位符。
//
// 输入区**只有 Lexical 一种实现**（引用是编辑器内原子节点，正文可夹在引用之间）。
// 编辑器走可选 chunk（`lexical.js`，宿主注入 URI + 重试）；加载彻底失败时显示错误与「重试」，
// 不再回退到旧 textarea。
//
// 只负责**画**与编辑器内的输入交互；提交、触发器（@/斜杠）、附件等由外层通过回调注入。
import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import type { ComposerInputAccess } from '../core/types'
import type { createLexicalEditorAdapter as CreateLexicalAdapter } from '../editors/lexical'

export interface ComposerInputProps {
  store: ChatStore
  /** 当前草稿正文（只用于空态占位符；正文真值在编辑器与 store 之间同步）。 */
  text: string
  placeholder: string
  /** 键盘事件（发送/菜单/粘贴由外层与编辑器共同处理）。 */
  onKeyDown: (event: KeyboardEvent) => void
  /** 把「文本+光标」访问交给外层（触发器菜单用）。 */
  onInputAccess?: (access: ComposerInputAccess | null) => void
  /** 编辑器内容变化（外层据此刷新触发器命中）。 */
  onDraftChange?: () => void
}

export function ComposerInput({ store, text, placeholder, onKeyDown, onInputAccess, onDraftChange }: ComposerInputProps) {
  const editorHost = useRef<HTMLDivElement | null>(null)
  const keyDownRef = useRef(onKeyDown)
  keyDownRef.current = onKeyDown
  const lexical = useRef<ReturnType<typeof CreateLexicalAdapter> | undefined>(undefined)
  /** chunk 加载失败：显示错误 + 重试（不静默、不回退旧输入区）。 */
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 重试计数：变化时重跑挂载 effect。 */
  const [retryToken, setRetryToken] = useState(0)
  /** 把编辑器光标同步回 store（语音插入/引用落点依赖 store.caret）。 */
  const syncCaret = (): void => {
    const access = lexical.current?.inputAccess?.()
    if (access !== undefined) {
      store.setCaret(access.getCaret())
      onDraftChange?.()
    }
  }
  useLayoutEffect(() => {
    if (editorHost.current === null) return
    let disposed = false
    let off: (() => void) | undefined
    const host = editorHost.current
    /**
     * 编辑器是可选 chunk：宿主把 `lexical.js` 的 asWebviewUri 注入 meta（带构建戳）；
     * 首次失败重试一次，仍失败则显示错误与「重试」。
     */
    void (async () => {
      let create: typeof CreateLexicalAdapter
      const meta = document.querySelector('meta[name="dsh-composer-editor"]')?.getAttribute('content') ?? null
      let url: string | null = meta
      if (url === null) {
        // 旧页面/脚本级 DOM：没有宿主注入的地址时退回相对解析；baseURI 不可用则直接报可读错误。
        try { url = new URL('lexical.js', document.baseURI).href } catch { url = null }
      }
      if (url === null) {
        if (!disposed) setLoadError('缺少编辑器资源地址（宿主未注入）')
        return
      }
      const target: string = url
      try {
        let mod: { createLexicalEditorAdapter: typeof CreateLexicalAdapter }
        try {
          mod = await import(/* @vite-ignore */ target) as { createLexicalEditorAdapter: typeof CreateLexicalAdapter }
        } catch (first) {
          // 单次重试：构建戳/缓存竞态、或资源服务刚就绪时的瞬时失败
          const retry = target + (target.includes('?') ? '&' : '?') + 'r=1'
          mod = await import(/* @vite-ignore */ retry) as { createLexicalEditorAdapter: typeof CreateLexicalAdapter }
          console.warn('[composer] 编辑器首次加载失败，重试成功', first)
        }
        create = mod.createLexicalEditorAdapter
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[composer] 编辑器加载失败', error)
        if (!disposed) setLoadError(message)
        return
      }
      if (disposed) return
      const adapter = create()
      lexical.current = adapter
      adapter.mount(host)
      setLoadError(null)
      off = adapter.subscribe((draft) => {
        store.setText(draft.text)
        store.setQuotes(draft.quotes.map((quote) => ({ text: quote.text, at: quote.at })))
        store.setReferences(draft.references.map((ref) => ({
          key: Number(ref.id) || 0,
          kind: ref.kind === 'directory' || ref.kind === 'session' ? ref.kind : 'file',
          label: ref.label,
          token: ref.token,
        })))
        syncCaret()
      })
      adapter.setDraft({ text: store.text.value, quotes: store.quotes.value, references: store.refs.value.map((ref) => ({ id: String(ref.key), kind: ref.kind, label: ref.label, token: ref.token, at: 0 })) })
      onInputAccess?.(adapter.inputAccess?.() ?? null)
    })()
    return () => {
      disposed = true
      off?.()
      lexical.current?.unmount()
      lexical.current = undefined
      onInputAccess?.(null)
    }
  }, [retryToken])
  useEffect(() => {
    lexical.current?.focus()
  }, [store.focusTick.value, retryToken])
  useLayoutEffect(() => {
    const el = editorHost.current
    if (el === null) return
    const handle = (event: KeyboardEvent): void => {
      keyDownRef.current(event)
      if (event.defaultPrevented) {
        // 发送/菜单/命令已经处理：阻止 Lexical 再按 Enter 插换行（否则它会把旧正文+\n 写回 store）
        event.stopPropagation()
        return
      }
      if (event.key === 'Enter' && event.isComposing !== true) {
        event.preventDefault()
        event.stopPropagation()
        lexical.current?.insertNewline?.()
      }
    }
    el.addEventListener('keydown', handle, true)
    return () => { el.removeEventListener('keydown', handle, true) }
  }, [retryToken, loadError])

  useEffect(() => {
    lexical.current?.setDisabled(store.busy.value !== null)
  }, [store.busy.value])
  /**
   * 外层状态（引用按钮增删、发送后清空、草稿还原）→ 编辑器草稿。
   *
   * 以「编辑器草稿 vs store」比较避免回环：编辑器变化时订阅已先写回 store，
   * 两个快照相等就直接返回；外部改动时才整体重建（引用按 at 重新插入原子节点）。
   */
  useEffect(() => {
    const adapter = lexical.current
    if (adapter === undefined) return
    const editorDraft = adapter.getDraft()
    const storeText = store.text.value
    const storeQuotes = store.quotes.value.map((quote) => ({ text: quote.text, at: quote.at }))
    // 引用位置以编辑器当前值为准（store.refs 只存内容；外部还原时没有位置就放开头）
    const refs = store.refs.value.map((ref) => {
      const existing = editorDraft.references.find((item) => Number(item.id) === ref.key)
      return { id: String(ref.key), kind: ref.kind, label: ref.label, token: ref.token, at: existing?.at ?? 0 }
    })
    const sameQuotes = JSON.stringify(editorDraft.quotes) === JSON.stringify(storeQuotes)
    const sameRefs = JSON.stringify(editorDraft.references) === JSON.stringify(refs)
    if (editorDraft.text === storeText && sameQuotes && sameRefs) return
    adapter.setDraft({ text: storeText, quotes: storeQuotes, references: refs })
    // 外部改写（语音插入/发送清空/草稿还原）后把光标放回 store 记录的位置
    adapter.inputAccess?.().setCaret(store.caret.value)
  }, [store.text.value, store.quotes.value, store.refs.value])

  return html`${loadError === null
      ? html`<div class="composer-editor" ref=${editorHost} data-placeholder=${placeholder}
          onKeyUp=${syncCaret}
          onMouseUp=${syncCaret}
          onPaste=${(event: ClipboardEvent) => {
            const items = event.clipboardData?.items
            if (!items) return
            for (const item of items) {
              if (item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile()
                if (file) {
                  event.preventDefault()
                  store.readImageFile(file)
                }
              }
            }
          }}></div>
          ${text === '' && store.quotes.value.length === 0 && store.refs.value.length === 0 ? html`<div class="composer-placeholder" aria-hidden="true">${placeholder}</div>` : null}`
      : html`<div class="composer-editor-fallback" role="alert">
          <span class="codicon codicon-error" aria-hidden="true"></span>
          <span class="composer-editor-fallback-text">输入区编辑器加载失败：${loadError}</span>
          <button type="button" class="composer-editor-retry"
            onClick=${() => { setLoadError(null); setRetryToken((n) => n + 1) }}>重试</button>
        </div>`}`
}
