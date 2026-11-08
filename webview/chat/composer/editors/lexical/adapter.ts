// Lexical 版 ComposerEditorAdapter：引用是编辑器内原子节点，
// 草稿 = { text, quotes:[{text, at}], references:[{...ref, at}] }。
import type { ComposerDraft, ComposerEditorAdapter } from '../../core/types'
import { createLexicalComposer, type LexicalComposerHandle } from './editor'

/** 创建 Lexical 编辑器适配器。 */
export function createLexicalEditorAdapter(): ComposerEditorAdapter {
  let handle: LexicalComposerHandle | undefined
  let draft: ComposerDraft = { text: '', quotes: [], references: [] }
  const listeners = new Set<(draft: ComposerDraft) => void>()
  const emit = (): void => {
    for (const listener of listeners) listener(draft)
  }
  return {
    kind: 'lexical',
    mount: (container) => {
      handle = createLexicalComposer({
        onChange: (next) => {
          draft = {
            ...draft,
            text: next.text,
            quotes: next.quotes,
            references: next.references.map((ref) => ({
              id: String(ref.key),
              kind: ref.kind,
              label: ref.label,
              token: ref.token,
              at: ref.at,
            })),
          }
          emit()
        },
      })
      handle.mount(container)
    },
    unmount: () => {
      handle?.dispose()
      handle = undefined
      listeners.clear()
    },
    getDraft: () => draft,
    setDraft: (next) => {
      draft = { text: next.text, quotes: [...next.quotes], references: [...next.references] }
      handle?.setDraft({
        text: next.text,
        quotes: [...next.quotes],
        references: next.references.map((ref) => ({
          key: Number(ref.id) || 0,
          kind: ref.kind === 'directory' || ref.kind === 'session' ? ref.kind : 'file',
          label: ref.label,
          token: ref.token,
          at: ref.at ?? 0,
        })),
      })
      emit()
    },
    insertText: (text) => { handle?.insertText(text) },
    insertNewline: () => { handle?.insertNewline() },
    focus: () => { handle?.focus() },
    setDisabled: (disabled) => { handle?.setEditable(!disabled) },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    inputAccess: () => ({
      getText: () => draft.text,
      getCaret: () => handle?.getCaretOffset() ?? 0,
      setCaret: (pos) => { handle?.setCaretOffset(pos) },
      replaceRange: (start, end, value) => { handle?.replaceTextRange(start, end, value) },
      focus: () => { handle?.focus() },
      contains: (node) => node !== null && handle?.rootElement()?.contains(node) === true,
      caretRect: () => handle?.caretRect() ?? null,
      insertCommand: (name) => { handle?.insertCommand(name) },
      insertReference: (ref) => { handle?.insertReference({
        key: Number(ref.id) || 0,
        kind: ref.kind === 'directory' || ref.kind === 'session' ? ref.kind : 'file',
        label: ref.label,
        token: ref.token,
      }) },
    }),
  }
}
