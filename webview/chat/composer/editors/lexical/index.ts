// Lexical 编辑器实现（按需引入；默认输入区仍走 textarea 适配器，直到 Phase 5 收敛）。
export { createLexicalComposer } from './editor'
export type { LexicalComposerHandle, LexicalComposerOptions } from './editor'
export { createLexicalEditorAdapter } from './adapter'
