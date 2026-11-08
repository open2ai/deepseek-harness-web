// Lexical 引用节点（对应上游 dsh 客户端的 `QuoteNode` / `QuotePreview`）：
// 编辑器里的**原子节点**，正文可以出现在它前面/后面/两句引用之间；
// 序列化时用 `formatQuoteText` 还原成引用块，并在草稿里以 `offset`/`length` 表示位置。
//
// 外观与交互逐项对齐上游 `UIQuotePreview`（`client-ui-primitives`）：
//   · 前端先是「引用图标」按钮：悬停/聚焦换成「✕」，点它只删这一条；
//   · 正文是单行截断文本（**始终可见**），点击左/右半边把光标放到该引用前/后；
//   · 文本被截断时，悬停出「全文」浮层（固定定位、主题色、内容超高纵向滚动）。
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  createCommand,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import { formatQuoteText } from '../../model/quote'

/** 插入引用命令：payload = 引用正文。 */
export const INSERT_QUOTE_COMMAND = createCommand<string>('INSERT_QUOTE_COMMAND')
/** 删除某条引用命令：payload = 节点 key。 */
export const REMOVE_QUOTE_COMMAND = createCommand<NodeKey>('REMOVE_QUOTE_COMMAND')

export type SerializedQuoteNode = Spread<
  { text: string; type: 'composer-quote'; version: 1 },
  SerializedLexicalNode
>

/** 引用图标（上游 `QuoteMark` artboard 16，两段引号同一路径）。 */
const QUOTE_MARK = `
<svg class="composer-quote-quote" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <g transform="translate(6.8 2.4)">
    <path d="M2.8125 0.583008L3.2002 1.16602C2.43912 1.6713 1.88491 2.41238 1.60547 3.25684H2.98926V6.70605H0V4.52148C1.96593e-05 2.70313 0.9109 1.00575 2.42578 0L2.8125 0.583008Z" fill="currentColor"/>
    <path d="M7.50781 0.583008L7.89551 1.16602C7.13443 1.6713 6.58022 2.41238 6.30078 3.25684H7.68457V6.70605H4.69531V4.52148C4.69533 2.70313 5.60621 1.00575 7.12109 0L7.50781 0.583008Z" fill="currentColor"/>
  </g>
</svg>`

/** 关闭图标（上游 `IconCloseOutlineRegular`，12px）：与引用图标同格叠放，靠 opacity 切换。 */
const CLOSE_MARK = `
<svg class="composer-quote-close" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`

/** 当前挂着的「全文」浮层（同一时刻只允许一个）。 */
let activeTip: { el: HTMLDivElement; hide: () => void } | undefined

function hideQuoteTip(): void {
  activeTip?.hide()
  activeTip = undefined
}

/**
 * 引用文本被截断时的全文浮层：固定定位、内容超高纵向滚动（上游 `HoverCard` + `popoverText` 同形）。
 * 只有 `scrollWidth > clientWidth` 才挂（与上游 `disabled: !truncated` 一致）。
 */
function showQuoteTip(anchor: HTMLElement, text: string): void {
  hideQuoteTip()
  const el = document.createElement('div')
  el.className = 'composer-quote-tip'
  el.setAttribute('data-quote-tip', '')
  el.setAttribute('role', 'tooltip')
  el.textContent = text
  document.body.appendChild(el)
  const rect = anchor.getBoundingClientRect()
  const tip = el.getBoundingClientRect()
  let left = rect.left
  left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8))
  let top = rect.top - tip.height - 6
  if (top < 8) top = rect.bottom + 6
  el.style.left = `${String(left)}px`
  el.style.top = `${String(Math.max(8, top))}px`
  const hide = (): void => {
    window.removeEventListener('scroll', hide, true)
    document.removeEventListener('pointermove', onMove)
    el.remove()
    if (activeTip?.el === el) activeTip = undefined
  }
  const onMove = (): void => {
    if (!anchor.isConnected) hide()
  }
  window.addEventListener('scroll', hide, true)
  document.addEventListener('pointermove', onMove)
  activeTip = { el, hide }
}

/** 一条引用的原子节点（`contenteditable=false` 的 chip）。 */
export class QuoteNode extends DecoratorNode<HTMLElement> {
  __text: string

  constructor(text: string, key?: NodeKey) {
    super(key)
    this.__text = text
  }

  static getType(): string {
    return 'composer-quote'
  }

  static clone(node: QuoteNode): QuoteNode {
    return new QuoteNode(node.__text, node.__key)
  }

  static importJSON(json: SerializedQuoteNode): QuoteNode {
    return new QuoteNode(json.text)
  }

  exportJSON(): SerializedQuoteNode {
    return { type: 'composer-quote', version: 1, text: this.__text }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('span')
    element.className = 'composer-quote-chip'
    element.contentEditable = 'false'
    element.setAttribute('data-quote-preview', '')
    element.setAttribute('data-removable', '')
    return element
  }

  updateDOM(): false {
    return false
  }

  isInline(): boolean {
    return true
  }

  getTextContent(): string {
    return formatQuoteText(this.__text)
  }

  /** 供 Preact 侧装饰器挂载器读取。 */
  getQuoteText(): string {
    return this.__text
  }

  /** 装饰器：前端「引用/✕」按钮 + 单行截断正文（点击左/右半边定位光标到引用前/后）。 */
  decorate(editor: LexicalEditor, _config: EditorConfig): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'composer-quote-body'

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'composer-quote-remove'
    remove.setAttribute('aria-label', '清除引用')
    remove.title = '清除引用'
    remove.innerHTML = QUOTE_MARK + CLOSE_MARK
    remove.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    remove.addEventListener('keydown', (event) => { event.stopPropagation() })
    remove.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      hideQuoteTip()
      editor.dispatchCommand(REMOVE_QUOTE_COMMAND, this.__key)
    })

    const text = document.createElement('span')
    text.className = 'composer-quote-text'
    text.setAttribute('data-quote-preview-text', '')
    text.textContent = this.__text

    // 悬停全文：只在文本被截断时挂（上游 `HoverCard disabled={!truncated}`）
    wrap.addEventListener('pointerenter', () => {
      if (text.scrollWidth > text.clientWidth) showQuoteTip(text, this.__text)
    })
    wrap.addEventListener('pointerleave', hideQuoteTip)

    // 点击引用正文：按左右半边把光标放到引用前/后（原子节点不能被“点进文字中间”）
    wrap.addEventListener('mousedown', (event) => {
      if (event.target === remove || remove.contains(event.target as Node)) return
      event.preventDefault()
      hideQuoteTip()
      const rect = wrap.getBoundingClientRect()
      const after = event.clientX >= rect.left + rect.width / 2
      editor.focus()
      editor.update(() => {
        const node = $getNodeByKey(this.__key)
        if (node === null) return
        const sibling = after ? node.getNextSibling() : node.getPreviousSibling()
        if (sibling !== null && $isTextNode(sibling)) {
          if (after) sibling.selectEnd()
          else sibling.selectStart()
          return
        }
        if (after) node.selectNext(0, 0)
        else node.selectPrevious(0, 0)
      })
    })

    wrap.append(remove, text)
    return wrap
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span')
    element.dataset.quoteText = this.__text
    element.textContent = formatQuoteText(this.__text)
    return { element }
  }
}

/**
 * 创建引用节点。
 * @param text - 引用正文
 * @returns 节点实例
 */
export function $createQuoteNode(text: string): QuoteNode {
  return new QuoteNode(text)
}

/** 是否是引用节点。 */
export function $isQuoteNode(node: LexicalNode | null | undefined): node is QuoteNode {
  return node instanceof QuoteNode
}

/** 在选区处插入引用；无选区时追加到根。 */
export function $insertQuote(text: string): void {
  const node = $createQuoteNode(text)
  const selection = $getSelection()
  if ($isRangeSelection(selection)) selection.insertNodes([node])
  else {
    const first = $getRoot().getFirstChild()
    const paragraph = first !== null && $isElementNode(first) ? first : $createParagraphNode()
    if (first === null) $getRoot().append(paragraph)
    paragraph.append(node)
  }
}
