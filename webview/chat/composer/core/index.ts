// 公共输入区组件：核心入口（**其它项目直接 import 这里**，不需要 dsh/VSCode 代码）。
export type {
  ComposerDraft,
  ComposerQuote,
  ComposerReference,
  ComposerEditorAdapter,
  ComposerEditorKind,
  ComposerController,
  ComposerInputAccess,
} from './types'
export type { ComposerHost, ComposerCommand } from './host'
export type {
  ComposerOptions,
  ComposerPlugin,
  ComposerPluginContext,
  ComposerSlotName,
  ComposerEventMap,
  ComposerEventName,
} from './plugin'
