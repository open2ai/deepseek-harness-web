// 供 webview/chat 类型检查用：acquireVsCodeApi() 是 VS Code 在 webview 页面运行时
// 注入的全局函数（@types/vscode 只描述扩展宿主侧 API，不含它），TS 默认不认识 → 报红。
// 这里补最小声明即可让 chat.ts:10 的 `const vscode = acquireVsCodeApi()` 有类型。
//
// 注意：每个 webview 只能调用一次 acquireVsCodeApi()（chat.ts 已调）；
// 标题栏等其它 webview 模块不要自取，复用 chat.ts 注入的句柄（见 titlebar.ts 的 ChatTitlebarApi）。
interface VSCodeWebviewApi<S = unknown> {
  /** 向扩展宿主发消息（扩展侧 webview.onDidReceiveMessage 接收） */
  postMessage(message: unknown): void
  /** 读取本 webview 的持久化状态 */
  getState(): S | undefined
  /** 写入本 webview 的持久化状态 */
  setState(state: S): void
}

declare function acquireVsCodeApi<S = unknown>(): VSCodeWebviewApi<S>

// 真机排查滚动跟随时用的临时钩子（Console 里 `window.__dshFollow.debug()` / 设
// `window.__dshFollowDebug = true` 看每帧状态）。非必需路径，故标可选。
interface DshFollowDebugHandle {
  debug(): { stick: boolean; top: number; maxTop: number; height: number; observed: number }
  settle(): void
  toBottom(): void
}

/** 接线好的 FollowHost（`box()` = 滚动视口矩形、`rows()` = 行节点）—— 排查「观察了谁/视口是谁」用。 */
interface DshFollowHostHandle {
  box(): { top: number; bottom: number }
  rows(): HTMLElement[]
}

interface Window {
  /** 当前会话的滚动跟随状态机（每次重挂会换成新的实例）。 */
  __dshFollow?: DshFollowDebugHandle
  /** 接线好的 FollowHost（同上，重挂即换）。 */
  __dshFollowHost?: DshFollowHostHandle
  /** 置 true 后，每次滚动都往 Console 打一行跟随状态。 */
  __dshFollowDebug?: boolean
}
