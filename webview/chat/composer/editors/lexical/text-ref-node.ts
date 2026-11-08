// 编辑器里的「文本引用」（上游 `TextRefNode` 的等价形态）：
// 用户**直接键入**的 `/命令` / `@路径` token 保持普通可编辑文本，但被标记成引用样式并可以继续编辑。
// 与 `ReferenceChipNode` 的区别：chip 是插入的原子节点；TextRef 只是 TextNode 的一个子类（可编辑、可切分）。
import { TextNode, type EditorConfig } from 'lexical'

/** 一个完整 token：`/命令名` 或 `@路径`（允许后面跟空白）。 */
const REF_TOKEN = /^(@[^\s]+|\/[A-Za-z][\w-]*)(\s*)$/u

export function textRefTokenOf(text: string): string | undefined {
  const match = REF_TOKEN.exec(text)
  return match === null ? undefined : match[1]
}

/** 一个被样式化的文本引用节点（内容仍可正常编辑）。 */
export class TextRefNode extends TextNode {
  static getType(): string {
    return 'composer-text-ref'
  }

  static clone(node: TextRefNode): TextRefNode {
    return new TextRefNode(node.__text, node.__key)
  }

  static importJSON(json: unknown): TextRefNode {
    const value = json as { text?: unknown } | null
    const text = value !== null && typeof value?.text === 'string' ? value.text : ''
    return new TextRefNode(text)
  }

  createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config)
    el.className = el.className === '' ? 'composer-text-ref' : `${el.className} composer-text-ref`
    el.setAttribute('spellcheck', 'false')
    el.setAttribute('data-composer-text-ref', '')
    return el
  }

  isTextEntity(): true {
    return true
  }

  canInsertTextBefore(): boolean {
    return true
  }
}

export function $createTextRefNode(text: string): TextRefNode {
  return new TextRefNode(text)
}

export function $isTextRefNode(node: unknown): node is TextRefNode {
  return node instanceof TextRefNode
}
