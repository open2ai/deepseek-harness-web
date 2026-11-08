// Lexical 编辑器封装：在 plain-text + history 之上加入
// `QuoteNode`（对应上游 dsh 客户端的 `QuoteNode`）：引用是编辑器内原子节点，
// 正文可在引用之间；草稿用 `{ text, quotes:[{text,at}] }` 表示。
//
// 不引 `@lexical/react`：装饰器节点的 DOM 由本文件手写的 decorator 监听器挂进
// 节点容器（`editor.getElementByKey`），与上游手写绑定同思路。
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  createEditor,
  type LexicalEditor,
  TextNode,
  type LexicalNode,
  type NodeKey,
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import type { ComposerQuote } from '../../core/types'
import { INSERT_QUOTE_COMMAND, REMOVE_QUOTE_COMMAND, QuoteNode, $createQuoteNode, $insertQuote, $isQuoteNode } from './quote-node'
import { $insertCommandChip, $isCommandChipNode, CommandChipNode } from './command-node'
import { $createReferenceChipNode, $insertReferenceChip, $isReferenceChipNode, ReferenceChipNode, REMOVE_REFERENCE_COMMAND, type LexicalReference } from './reference-node'
import { $createTextRefNode, $isTextRefNode, textRefTokenOf, TextRefNode } from './text-ref-node'

/** 草稿快照（纯文本 + 引用区间）。 */
export interface LexicalDraft {
  text: string
  quotes: ComposerQuote[]
  references: Array<LexicalReference & { at: number }>
}

/** 编辑器句柄：挂载/卸载、草稿读写、聚焦、引用命令。 */
export interface LexicalComposerHandle {
  readonly editor: LexicalEditor
  mount(container: HTMLElement): void
  dispose(): void
  focus(): void
  getText(): string
  insertText(text: string): void
  insertNewline(): void
  setEditable(editable: boolean): void
  setText(text: string): void
  getDraft(): LexicalDraft
  setDraft(draft: LexicalDraft): void
  insertQuote(text: string): void
  /** 把「已认领命令」作为编辑器内原子 chip 插到光标处（上游 CommandChipNode）。 */
  insertCommand(name: string): void
  /** 把一条 @ 引用作为编辑器内原子 chip 插到光标处（上游 ReferenceChipNode）。 */
  insertReference(ref: LexicalReference): void
  removeQuote(index: number): void
  /** 纯文本光标偏移（引用节点记 0 宽，与草稿 `text` 口径一致）。 */
  getCaretOffset(): number
  setCaretOffset(offset: number): void
  /** 按纯文本偏移替换一段（触发器 pick 用；内部重建草稿并平移引用区间）。 */
  replaceTextRange(start: number, end: number, value: string): void
  /** contenteditable 根元素（判断点击是否在输入区内）。 */
  rootElement(): HTMLElement | null
  /** 当前光标的视口矩形（参数提示定位用）。 */
  caretRect(): DOMRect | null
}

export interface LexicalComposerOptions {
  /** 草稿变化回调（每次编辑器 update 后）。 */
  onChange?: (draft: LexicalDraft) => void
  namespace?: string
  /** 历史合并延迟（与上游 `HISTORY_MERGE_DELAY_MS` 同义）。 */
  historyMergeDelay?: number
}

/** 从根节点按顺序读出「纯文本 + 引用区间」。 */
function readDraftFromRoot(): LexicalDraft {
  const root = $getRoot()
  let text = ''
  const quotes: ComposerQuote[] = []
  const references: Array<LexicalReference & { at: number }> = []
  const walk = (node: LexicalNode): void => {
    if (node === root) {
      const children = $getRoot().getChildren()
      children.forEach((child, index) => {
        if (index > 0) text += '\n'
        walk(child)
      })
      return
    }
    if ($isReferenceChipNode(node)) {
      references.push({ ...node.getReference(), at: text.length })
      return
    }
    if ($isQuoteNode(node)) {
      quotes.push({ text: node.getQuoteText(), at: text.length })
      return
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) walk(child)
      return
    }
    text += node.getTextContent()
  }
  walk(root)
  return { text, quotes, references }
}

/** 按顺序找第 index 个引用节点。 */
function quoteNodeAt(index: number): QuoteNode | null {
  let seen = 0
  let found: QuoteNode | null = null
  const walk = (node: LexicalNode): void => {
    if (found !== null) return
    if ($isQuoteNode(node)) {
      if (seen === index) found = node
      seen += 1
      return
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child)
  }
  walk($getRoot())
  return found
}

/** 选区锚点 → 纯文本偏移（引用节点 0 宽）。 */
function $caretOffset(): number {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return 0
  const anchor = selection.anchor
  const target = anchor.getNode()
  let offset = 0
  let found = false
  const walk = (node: LexicalNode): void => {
    if (found) return
    if (node === $getRoot()) {
      const children = $getRoot().getChildren()
      children.forEach((child, index) => {
        if (found) return
        if (index > 0) offset += 1
        walk(child)
      })
      return
    }
    if ($isQuoteNode(node) || $isReferenceChipNode(node)) return
    if ($isCommandChipNode(node)) {
      offset += node.getTextContent().length
      return
    }
    if (node === target && $isElementNode(node)) {
      // 元素点（例如段落末尾）：offset = 前面子节点的文本长度之和
      const children = node.getChildren()
      const count = Math.min(anchor.offset, children.length)
      for (let index = 0; index < count; index += 1) {
        const child = children[index]
        if ($isQuoteNode(child)) continue
        offset += child.getTextContentSize()
      }
      found = true
      return
    }
    if ($isTextNode(node)) {
      const length = node.getTextContentSize()
      if (node === target) {
        offset += Math.min(anchor.offset, length)
        found = true
        return
      }
      offset += length
      return
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child)
  }
  walk($getRoot())
  return offset
}

/** 把光标放到纯文本偏移处（找不到就落到末尾）。 */
function $selectOffset(offset: number): void {
  let remaining = Math.max(0, offset)
  let done = false
  const walk = (node: LexicalNode): void => {
    if (done) return
    if (node === $getRoot()) {
      const children = $getRoot().getChildren()
      children.forEach((child, index) => {
        if (done) return
        if (index > 0) {
          if (remaining === 0) {
            const previous = children[index - 1]
            if (previous instanceof TextNode) previous.selectEnd()
            done = true
            return
          }
          remaining -= 1
        }
        walk(child)
      })
      return
    }
    if ($isQuoteNode(node) || $isReferenceChipNode(node)) return
    if ($isCommandChipNode(node)) {
      const length = node.getTextContent().length
      if (remaining <= length) {
        node.selectNext(0, 0)
        done = true
        return
      }
      remaining -= length
      return
    }
    if ($isTextNode(node)) {
      const length = node.getTextContentSize()
      if (remaining <= length) {
        node.select(remaining, remaining)
        done = true
        return
      }
      remaining -= length
      return
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child)
  }
  walk($getRoot())
  if (!done) $getRoot().selectEnd()
}

/** 用草稿重建根内容（text + 原子引用节点），可在 update 内复用。 */
function $writeDraft(draft: LexicalDraft): void {
  const root = $getRoot()
  root.clear()
  const paragraph = $createParagraphNode()
  const entries: Array<{ at: number; node: LexicalNode }> = []
  for (const quote of draft.quotes) entries.push({ at: quote.at, node: $createQuoteNode(quote.text) })
  for (const reference of draft.references) entries.push({ at: reference.at, node: $createReferenceChipNodeFromRef(reference) })
  entries.sort((a, b) => a.at - b.at)
  let cursor = 0
  for (const entry of entries) {
    const at = Math.max(cursor, Math.min(entry.at, draft.text.length))
    if (at > cursor) paragraph.append($createTextNode(draft.text.slice(cursor, at)))
    paragraph.append(entry.node)
    cursor = at
  }
  if (cursor < draft.text.length) paragraph.append($createTextNode(draft.text.slice(cursor)))
  if (paragraph.getChildrenSize() === 0) paragraph.append($createTextNode(''))
  root.append(paragraph)
}

function $createReferenceChipNodeFromRef(ref: LexicalReference): ReferenceChipNode {
  return $createReferenceChipNode(ref)
}

/**
 * 创建一个带 `QuoteNode` 的 Lexical 输入编辑器。
 * @param options - 回调与命名空间
 * @returns 编辑器句柄
 */
export function createLexicalComposer(options: LexicalComposerOptions = {}): LexicalComposerHandle {
  const editor = createEditor({
    namespace: options.namespace ?? 'composer',
    nodes: [QuoteNode, CommandChipNode, ReferenceChipNode, TextRefNode],
    onError: (error) => { throw error },
  })
  registerPlainText(editor)
  const history = registerHistory(editor, createEmptyHistoryState(), options.historyMergeDelay ?? 500)

  // 引用插入/删除命令（编辑器内原子节点）
  const unregisterInsert = editor.registerCommand(INSERT_QUOTE_COMMAND, (text: string) => {
    editor.update(() => { $insertQuote(text) })
    return true
  }, 0)
  const insertCommand = (name: string): void => {
    editor.update(() => { $insertCommandChip(name) })
  }
  const insertReference = (ref: LexicalReference): void => {
    editor.update(() => { $insertReferenceChip(ref) })
  }
  // 直接键入的 `/命令` / `@路径` → TextRefNode（可编辑的引用文本；上游 TextRefNode 等价形态）
  const TOKEN_RE = /(@[^\s]+|\/[A-Za-z][\w-]*)/gu
  const splitTextRefs = (node: TextNode, text: string): void => {
    const matches = [...text.matchAll(TOKEN_RE)]
    if (matches.length === 0) {
      if ($isTextRefNode(node)) node.replace($createTextNode(text))
      return
    }
    const selection = $getSelection()
    const anchorInNode = $isRangeSelection(selection)
      && (selection.anchor.getNode() === node || selection.focus.getNode() === node)
    const anchorOffset = anchorInNode ? selection.anchor.offset : 0
    let cursor = 0
    const parts: LexicalNode[] = []
    for (const match of matches) {
      const start = match.index ?? 0
      if (start > cursor) parts.push($createTextNode(text.slice(cursor, start)))
      parts.push($createTextRefNode(match[0]))
      cursor = start + match[0].length
    }
    if (cursor < text.length) parts.push($createTextNode(text.slice(cursor)))
    if (parts.length === 0) return
    const first = parts[0]
    node.replace(first)
    let previous = first
    for (const part of parts.slice(1)) {
      previous.insertAfter(part)
      previous = part
    }
    // 拆节点会复位选区；把光标映射到拆分后的同一字符位置（否则继续输入会插到前面）。
    if (!anchorInNode) return
    let position = 0
    for (const part of parts) {
      const length = part.getTextContentSize()
      if (anchorOffset <= position + length) {
        if (part instanceof TextNode || $isTextRefNode(part)) part.select(anchorOffset - position, anchorOffset - position)
        return
      }
      position += length
    }
  }
  const unregisterTextRefsPlain = editor.registerNodeTransform(TextNode, (node) => {
    splitTextRefs(node, node.getTextContent())
  })
  // 子类 TextNode 不一定命中基类 transform（各 Lexical 版本实现不同）；再显式注册一次实体节点。
  const unregisterTextRefsEntity = editor.registerNodeTransform(TextRefNode, (node) => {
    const text = node.getTextContent()
    if (textRefTokenOf(text) !== undefined) return
    splitTextRefs(node, text)
  })
  const unregisterTextRefs = (): void => {
    unregisterTextRefsPlain()
    unregisterTextRefsEntity()
  }
  const unregisterRemoveReference = editor.registerCommand(REMOVE_REFERENCE_COMMAND, (key: NodeKey) => {
    editor.update(() => { $getNodeByKey(key)?.remove() })
    return true
  }, 0)
  const unregisterRemove = editor.registerCommand(REMOVE_QUOTE_COMMAND, (key: NodeKey) => {
    editor.update(() => {
      $getNodeByKey(key)?.remove()
    })
    return true
  }, 0)

  // 装饰器节点：把 `decorate()` 产出的 DOM 挂进节点容器（手写 Preact 绑定的一部分）
  const unregisterDecorators = editor.registerDecoratorListener((decorators) => {
    for (const [key, decorator] of Object.entries(decorators)) {
      const host = editor.getElementByKey(key)
      if (host !== null && decorator instanceof HTMLElement) host.replaceChildren(decorator)
    }
  })

  const unsubscribeUpdate = editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => { options.onChange?.(readDraftFromRoot()) })
  })

  return {
    editor,
    mount: (container) => {
      /**
       * Lexical 的 setRootElement 只接管事件/渲染，**不会**把容器变成 contenteditable
       *（React 版由 <ContentEditable> 负责这层）。少了它：点击不聚焦、光标不出现、键盘也进不来 ——
       * 真机「鼠标点输入区没反应」就是这条。
       */
      container.setAttribute('contenteditable', 'true')
      container.setAttribute('role', 'textbox')
      container.setAttribute('aria-multiline', 'true')
      editor.setRootElement(container)
      // 空编辑器也要有一个段落和折叠光标：否则首次 insertText/insertQuote 走"无选区"分支，
      // 后续文本会落到新段落里、引用落点全变成同一个偏移（真 Chrome 守卫暴露过）。
      editor.update(() => {
        if ($getRoot().getFirstChild() === null) $getRoot().append($createParagraphNode())
        if (!$isRangeSelection($getSelection())) $getRoot().selectStart()
      })
    },
    dispose: () => {
      unsubscribeUpdate()
      unregisterDecorators()
      unregisterInsert()
      unregisterTextRefs()
      unregisterRemoveReference()
      unregisterRemove()
      history()
      editor.setRootElement(null)
    },
    focus: () => { editor.focus() },
    insertCommand,
    insertReference,
    getText: () => {
      let text = ''
      editor.getEditorState().read(() => { text = $getRoot().getTextContent() })
      return text
    },
    setText: (text) => {
      editor.update(() => { $writeDraft({ text, quotes: [], references: [] }) })
    },
    getDraft: () => {
      let draft: LexicalDraft = { text: '', quotes: [], references: [] }
      editor.getEditorState().read(() => { draft = readDraftFromRoot() })
      return draft
    },
    setDraft: (draft) => {
      editor.update(() => { $writeDraft(draft) })
    },
    getCaretOffset: () => {
      let offset = 0
      editor.getEditorState().read(() => { offset = $caretOffset() })
      return offset
    },
    setCaretOffset: (offset) => {
      editor.update(() => { $selectOffset(offset) })
    },
    replaceTextRange: (start, end, value) => {
      editor.update(() => {
        const current = readDraftFromRoot()
        const from = Math.max(0, Math.min(start, current.text.length))
        const to = Math.max(from, Math.min(end, current.text.length))
        const text = current.text.slice(0, from) + value + current.text.slice(to)
        const delta = value.length - (to - from)
        const quotes = current.quotes.map((quote) => {
          if (quote.at >= to) return { text: quote.text, at: quote.at + delta }
          if (quote.at > from) return { text: quote.text, at: from }
          return quote
        })
        // 引用随编辑平移（零宽，只影响插入位置）
        const references = current.references.map((ref) => {
          if (ref.at >= to) return { ...ref, at: ref.at + delta }
          if (ref.at > from) return { ...ref, at: from }
          return ref
        })
        $writeDraft({ text, quotes, references })
        $selectOffset(from + value.length)
      })
    },
    rootElement: () => editor.getRootElement(),
    caretRect: () => {
      const root = editor.getRootElement()
      const domSelection = window.getSelection()
      if (root === null || domSelection === null || domSelection.rangeCount === 0) return null
      const range = domSelection.getRangeAt(0)
      if (!root.contains(range.startContainer)) return null
      return range.getBoundingClientRect()
    },
    insertText: (text) => {
      editor.update(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) selection.insertText(text)
        else $getRoot().append($createParagraphNode().append($createTextNode(text)))
      })
    },
    insertNewline: () => {
      editor.update(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) selection.insertParagraph()
        else $getRoot().append($createParagraphNode())
      })
    },
    setEditable: (editable) => { editor.setEditable(editable) },
    insertQuote: (text) => { editor.dispatchCommand(INSERT_QUOTE_COMMAND, text) },
    removeQuote: (index) => {
      editor.update(() => { quoteNodeAt(index)?.remove() })
    },
  }
}
