// 公共输入区组件：**核心类型（无框架、无宿主依赖）**。
//
// 设计目标：这一层可以被别的项目直接复用 —— 不 import 任何 DeepSeek Harness / VSCode 代码，
// 只描述「草稿 + 引用 + 编辑器适配器 + 控制器」。
// 与上游 dsh 网页端的对应：`ComposerQuote` 对应 `QuoteNode` 序列化后的区间；
// `ComposerReference` 对应 `ReferenceChipNode` / `TextRefNode` 的展示信息。

/** 引用区间：`at` = 在正文纯文本里的起始偏移（序列化时映射为 `offset`/`length`）。 */
export interface ComposerQuote {
  text: string
  at: number
}

/** `@` 引用贴片（文件 / 目录 / 会话等，`kind` 由宿主定义）。 */
export interface ComposerReference {
  /** 宿主内稳定标识（用于删除/去重）。 */
  id: string
  /** 宿主自定义类别，例如 `file` / `directory` / `session`。 */
  kind: string
  /** 短展示名。 */
  label: string
  /** 注入正文的 token（例如 `@rel/path`），由宿主决定是否使用。 */
  token: string
  /** 可选的正文偏移（内联 chip 恢复位置；缺省放开头）。 */
  at?: number
}

/** 输入区草稿（公共模型）。 */
export interface ComposerDraft {
  text: string
  quotes: readonly ComposerQuote[]
  references: readonly ComposerReference[]
}

/** 编辑器实现种类：当前只有 Lexical（textarea 已在 Phase 5 删除）。 */
export type ComposerEditorKind = 'lexical'

/**
 * 编辑器适配器：负责把「草稿模型」挂到一个具体编辑器实现上。
 *
 * 公共层只认这份接口；`editors/textarea` 与 `editors/lexical` 各自实现，
 * 上层组件/宿主不感知内部是 textarea 还是 Lexical。
 */
export interface ComposerEditorAdapter {
  readonly kind: ComposerEditorKind
  /** 挂载到容器（组件层负责调用；contenteditable 实现会创建编辑器实例）。 */
  mount(container: HTMLElement): void
  unmount(): void
  getDraft(): ComposerDraft
  setDraft(draft: ComposerDraft): void
  insertText(text: string): void
  /** 插入换行（Shift+Enter；textarea 由原生行为处理，可不实现）。 */
  insertNewline?(): void
  focus(): void
  setDisabled(disabled: boolean): void
  /** 草稿变化订阅；返回取消订阅函数。 */
  subscribe(fn: (draft: ComposerDraft) => void): () => void
  /** 触发器菜单（@ / 斜杠）用的文本+光标访问；textarea 旧路径可不实现。 */
  inputAccess?(): ComposerInputAccess
}

/**
 * 控制器：给宿主/特性插件用的命令式 API（不直接操纵 DOM）。
 *
 * 特性插件（引用、@ 提及、斜杠、附件、语音）通过控制器改变草稿，
 * 不各自去摸 `<textarea>` / 编辑器内部 —— 这是「换编辑器不动特性」的前提。
 */
export interface ComposerController {
  focus(): void
  insertText(text: string): void
  insertQuote(text: string): void
  removeQuote(index: number): void
  setDraft(draft: ComposerDraft): void
  getDraft(): ComposerDraft
  /** 提交（宿主接管发送；返回是否提交成功，供失败时还原草稿）。 */
  submit(): Promise<boolean>
}

/**
 * 输入区的「文本 + 光标」访问抽象：给触发器菜单（@ / 斜杠）用。
 *
 * textarea 与 Lexical 两种编辑器各实现一份；replaceRange 是**按纯文本偏移**替换
 * （Lexical 实现内部会重建草稿并把引用区间按位移调整）。
 */
export interface ComposerInputAccess {
  getText(): string
  getCaret(): number
  setCaret(pos: number): void
  replaceRange(start: number, end: number, value: string): void
  focus(): void
  contains(node: Node | null): boolean
  /** 当前光标在视口里的矩形（缺省 = 该编辑器不提供；输入区参数提示用）。 */
  caretRect?(): DOMRect | null
  /** 把「已认领命令」作为编辑器原子 chip 插入（缺省 = 该编辑器不支持，调用方退回纯文本）。 */
  insertCommand?(name: string): void
  /** 把一条 @ 引用作为编辑器原子 chip 插入（缺省 = 不支持，调用方退回 store.addRef）。 */
  insertReference?(ref: ComposerReference): void
}
