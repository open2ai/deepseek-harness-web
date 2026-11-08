// 已认领的斜杠命令（上游 `CommandChipNode` 的等价形态）：
// 选中带参命令后，编辑器里是一条**原子命令 chip**（不是普通文本），光标在其后继续输参数。
// 序列化/投影口径：chip 的文本就是 `/命令名`，因此现有「文本以 `/` 开头 → 命令执行」的判定不用改。
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $getSelection,
  $isRangeSelection,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'

export type SerializedCommandChipNode = Spread<
  { name: string; type: 'composer-command'; version: 1 },
  SerializedLexicalNode
>

/** 一条已认领命令的原子节点。 */
export class CommandChipNode extends DecoratorNode<HTMLElement> {
  __name: string

  constructor(name: string, key?: NodeKey) {
    super(key)
    this.__name = name
  }

  static getType(): string {
    return 'composer-command'
  }

  static clone(node: CommandChipNode): CommandChipNode {
    return new CommandChipNode(node.__name, node.__key)
  }

  static importJSON(json: SerializedCommandChipNode): CommandChipNode {
    return new CommandChipNode(json.name)
  }

  exportJSON(): SerializedCommandChipNode {
    return { type: 'composer-command', version: 1, name: this.__name }
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'composer-command-chip'
    el.contentEditable = 'false'
    el.setAttribute('data-composer-command', this.__name)
    return el
  }

  updateDOM(): false {
    return false
  }

  isInline(): boolean {
    return true
  }

  /** 投影成普通文本（上游 command chip 同样以 token 文本参与草稿）。 */
  getTextContent(): string {
    return `/${this.__name}`
  }

  getCommandName(): string {
    return this.__name
  }

  /** 纯显示：上游 `CommandChip` 复用 ReferenceChip 的外观但不带图标。 */
  decorate(_editor: LexicalEditor, _config: EditorConfig): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'composer-command-body'
    const label = document.createElement('span')
    label.className = 'composer-command-label'
    label.textContent = `/${this.__name}`
    wrap.append(label)
    return wrap
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement('span')
    span.textContent = `/${this.__name}`
    return { element: span }
  }
}

export function $createCommandChipNode(name: string): CommandChipNode {
  return new CommandChipNode(name)
}

export function $isCommandChipNode(node: LexicalNode | null | undefined): node is CommandChipNode {
  return node instanceof CommandChipNode
}

/** 在选区处插入命令 chip，并补一个空格（参数从空格后开始输）。 */
export function $insertCommandChip(name: string): void {
  const node = $createCommandChipNode(name)
  const selection = $getSelection()
  if ($isRangeSelection(selection)) {
    // 一次插入 chip + 空格（分两次插入会把后续文本拆到新段落）
    const space = $createTextNode(' ')
    selection.insertNodes([node, space])
    space.selectEnd()
    return
  }
  const first = $getRoot().getFirstChild()
  const target = first !== null && $isElementNode(first) ? first : $createParagraphNode()
  if (first === null) $getRoot().append(target)
  const space = $createTextNode(' ')
  target.append(node, space)
  space.selectEnd()
}
