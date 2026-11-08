// 编辑器内联 `@` 引用（上游 `ReferenceChipNode` 的等价形态）：
// 引用是原子节点、不占正文；正文可以写在它前面/后面。发送时仍走 store.refs 的 token 注入，
// 因此 chip 只负责显示与位置，不改变消息格式。
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
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

export const REMOVE_REFERENCE_COMMAND = createCommand<NodeKey>('REMOVE_REFERENCE_COMMAND')

export interface LexicalReference {
  key: number
  kind: 'file' | 'directory' | 'session'
  label: string
  token: string
  detail?: string
}

export type SerializedReferenceNode = Spread<
  { ref: LexicalReference; type: 'composer-reference'; version: 1 },
  SerializedLexicalNode
>

/** 一条 `@` 引用的原子节点。 */
export class ReferenceChipNode extends DecoratorNode<HTMLElement> {
  __ref: LexicalReference

  constructor(ref: LexicalReference, key?: NodeKey) {
    super(key)
    this.__ref = ref
  }

  static getType(): string {
    return 'composer-reference'
  }

  static clone(node: ReferenceChipNode): ReferenceChipNode {
    return new ReferenceChipNode(node.__ref, node.__key)
  }

  static importJSON(json: SerializedReferenceNode): ReferenceChipNode {
    return new ReferenceChipNode(json.ref)
  }

  exportJSON(): SerializedReferenceNode {
    return { type: 'composer-reference', version: 1, ref: this.__ref }
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'composer-ref-chip'
    el.contentEditable = 'false'
    el.setAttribute('data-composer-reference', this.__ref.token)
    return el
  }

  updateDOM(): false {
    return false
  }

  isInline(): boolean {
    return true
  }

  /** 引用不进入正文（发送时由 store.refs 注入），所以文本投影为空。 */
  getTextContent(): string {
    return ''
  }

  getReference(): LexicalReference {
    return this.__ref
  }

  decorate(editor: LexicalEditor, _config: EditorConfig): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'composer-ref-body'
    const icon = document.createElement('span')
    icon.className =
      'composer-ref-icon codicon ' +
      (this.__ref.kind === 'directory' ? 'codicon-folder-opened' : this.__ref.kind === 'session' ? 'codicon-comment-discussion' : 'codicon-file')
    const label = document.createElement('span')
    label.className = 'composer-ref-label'
    label.textContent = this.__ref.label
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'composer-ref-remove'
    remove.setAttribute('aria-label', '移除引用')
    remove.title = '移除引用'
    remove.textContent = '✕'
    remove.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    remove.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      editor.dispatchCommand(REMOVE_REFERENCE_COMMAND, this.__key)
    })
    wrap.append(icon, label, remove)
    return wrap
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement('span')
    span.textContent = this.__ref.token
    return { element: span }
  }
}

export function $createReferenceChipNode(ref: LexicalReference): ReferenceChipNode {
  return new ReferenceChipNode(ref)
}

export function $isReferenceChipNode(node: LexicalNode | null | undefined): node is ReferenceChipNode {
  return node instanceof ReferenceChipNode
}

/** 在选区处插入引用 chip（零宽；光标落在 chip 后）。 */
export function $insertReferenceChip(ref: LexicalReference): void {
  const node = $createReferenceChipNode(ref)
  const selection = $getSelection()
  if ($isRangeSelection(selection)) {
    selection.insertNodes([node])
    node.selectNext(0, 0)
    return
  }
  const root = $getRoot()
  const first = root.getFirstChild()
  const paragraph = first !== null && $isElementNode(first) ? first : $createParagraphNode()
  if (first === null) root.append(paragraph)
  paragraph.append(node)
  node.selectNext(0, 0)
}

/** 读取节点里的引用（供草稿投影）。 */
export function referenceOf(node: LexicalNode): LexicalReference | undefined {
  return $isReferenceChipNode(node) ? node.getReference() : undefined
}

