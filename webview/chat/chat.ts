// dsh 聊天 webview 入口(bootstrap)。
//   - 唯一一处 acquireVsCodeApi() → 构建 ChatHost(单 window 消息监听、多接收者扇出);
//   - 创建 chat store;宿主消息按类型路由:聊天消息归 store,自绘标题栏消息归 titlebar(同一通道);
//   - preact 渲染 <ChatApp> 到 #app;
//   - 渲染完成后再 init 自绘标题栏(读取 #titlebar DOM)、post ready(host 随后才推 chatInfo)。
// 依赖方向:页面 → components/* + core/store + core/host + titlebar(仅注入句柄)。
import { render } from 'preact'
import { html } from 'htm/preact'
import 'katex/dist/katex.min.css' // KaTeX 自带样式（字体经 esbuild 的 file loader 落到 dist/chat/assets）
import './styles/chat.css' // esbuild 打进 dist/chat/chat.css(index.html 已 <link> 引用)
import { makeWindowMessageHost } from './core/host'
import type { HostToViewMessage } from './core/protocol'
import { createChatStore } from './core/store/chat'
// 代码块工具栏（换行 / 复制）的**全局委托**：装配点在下面，理由见那里的注释
import { installCodeToolbarDelegation } from './core/code-toolbar'
import { ChatApp } from './components/app'
import { initChatTitlebar } from './titlebar'

const vscode = acquireVsCodeApi()
// 页面唯一宿主通道:单 window 监听扇出;页面收发只经 host(自绘标题栏也注册到同一通道)。
const host = makeWindowMessageHost(vscode.postMessage.bind(vscode))

const store = createChatStore(host)

/*
 * **代码块工具栏：全局一次事件委托**。
 *
 * 为什么挂在这里而不是某个渲染点：`renderMd()` 有 **5 个调用点**（回答正文 / 链内程序块 / 细节卡 /
 * plan / 联网卡），工具栏按钮是**渲染在 HTML 字符串里**的 —— 只在正文那一处挂监听，另外四处的
 * 「自动换行 / 复制」两个按钮就全是死的（真机："这些地方的换行点击没反应"）。
 * 委托必须**只此一处**：再在局部挂一份会让换行被切换两次，表现成"点了没反应"。
 */
installCodeToolbarDelegation(document, (text) => store.copy(text))

// 宿主 → store(聊天消息;标题栏消息归 titlebar,store 内部忽略)
host.onMessage((msg) => store.onHostMessage(msg as HostToViewMessage))

// 渲染 UI
const app = document.getElementById('app')
if (app) {
  render(html`<${ChatApp} store=${store} />`, app)
}

// 装配标题栏:把自绘标题栏消息处理注册到同一通道;非 selfDrawn 模式内部直接 return。
// 删自绘标题栏(只留原生) 时删除本行 + titlebar 相关文件即可。
initChatTitlebar({ postMessage: (msg) => host.post(msg), onMessage: (cb) => host.onMessage(cb) })

// 页面脚本就绪(渲染 + 消息监听已挂好)→ 通知扩展推送 chatInfo,避免视图重建时早推丢失
host.post({ type: 'ready' })
