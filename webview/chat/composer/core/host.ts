// 公共输入区组件：**宿主能力注入接口**。
//
// 组件本身不直接调 fetch / VSCode / dsh RPC；需要什么就通过 `ComposerHost` 注入。
// 这样别的项目接入时只需要实现这一份接口（不需要的能项可以省略）。
import type { ComposerDraft, ComposerReference } from './types'

/** 斜杠命令目录项。 */
export interface ComposerCommand {
  name: string
  description?: string
}

/** 宿主注入能力；除 `t` 外全部可选，缺项对应特性自动禁用。 */
export interface ComposerHost {
  /** 本地化；`key` 由组件/特性定义（如 `quote.remove`）。 */
  t(key: string, params?: Record<string, string | number>): string
  /** 读剪贴板文本（粘贴/复制兜底）；缺省时用浏览器 Clipboard API。 */
  readClipboardText?: () => Promise<string>
  /** 写剪贴板；缺省时用浏览器 Clipboard API。 */
  writeClipboardText?: (text: string) => Promise<void> | void
  /** 选择文件（图片/普通附件）。 */
  pickFiles?: () => Promise<File[]>
  /** 按路径读文件字节（图片预览/在编辑器打开）。 */
  readFileBytes?: (path: string) => Promise<{ mediaType: string; data: string } | undefined>
  /** 在宿主编辑器/系统中打开文件。 */
  openFile?: (path: string, line?: number) => void
  /** 打开外链。 */
  openLink?: (url: string) => void
  /** 附件上送（返回宿主回执；失败抛出）。 */
  uploadAttachment?: (file: { name: string; bytes?: number; path?: string }) => Promise<{ receiptId: string }>
  /** `@` 候选搜索（文件/目录/会话由宿主决定）。 */
  searchReferences?: (query: string) => Promise<ComposerReference[]>
  /** 斜杠命令目录。 */
  listCommands?: () => Promise<ComposerCommand[]>
  /** 提交草稿；`submit` 由控制器调用，返回 false 表示失败（组件保留草稿）。 */
  submit?: (draft: ComposerDraft) => Promise<boolean>
  /** 当前时间（测试可注入固定值）。 */
  now?: () => number
  /** 运行状态：忙碌时禁止发送/显示停止按钮（由宿主决定语义）。 */
  busy?: boolean
  /** 输入区高度上限（px）；缺省由组件样式决定。 */
  maxHeight?: number
}
