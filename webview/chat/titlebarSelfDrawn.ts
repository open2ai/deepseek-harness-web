// ===== 自绘标题栏（页内 #titlebar）webview 独立模块 =====
// 本文件承载「自绘标题栏」整套逻辑：工作区名/切换 dropdown（复刻原生 QuickPick + 搜索）、
// 面板态联动显隐（🌐/⬇/⟳）、⋯ more 菜单、以及对应的 window message 监听。
// 装配：webview/chat/titlebar.ts 唯一 import 本模块，chat.ts 只调 initChatTitlebar(vscode)。
//
// 与原生标题栏（VS Code view/title）的关系：
//   - 本模块是自绘标题栏分支的 webview 侧实现；原生标题栏分支无任何 webview 代码（宿主渲染原生头）。
//   - 删自绘标题栏（只留原生）时：删本文件 + webview/chat/titlebar.ts（chat.ts 顶部 import 一并删）+
//     index.html 的 #titlebar CSS(18-111)/DOM(496-524)。删原生标题栏时本文件不受影响。
//
// 约束：
//   - acquireVsCodeApi() 一个 webview 只能调一次（chat.ts 已调），故不自取句柄，
//     由 chat.ts 注入 api = { postMessage }。
//   - 所有 DOM 自查（不依赖 chat.ts 顶层 const），避免模块间耦合。
//   - 全部逻辑放在 initSelfDrawnTitlebar 闭包内：原生标题栏模式 / 已删 #titlebar 时直接 return，
//     模块加载永不因找不到元素而抛错。

import { createWorkspaceDropdown } from './workspace/dropdown'

export interface SelfDrawnTitlebarApi {
  postMessage(msg: unknown): void
  /** 订阅宿主消息（注册到页面唯一 message 通道，不自加 window 监听） */
  onMessage(cb: (msg: unknown) => void): () => void
}

export function initSelfDrawnTitlebar(api: SelfDrawnTitlebarApi): void {
  // —— 守卫：仅 自绘标题栏 模式、且 #titlebar 仍存在时启用（非原子删自绘的兜底）——
  if (document.body?.dataset.titlebarMode !== 'selfDrawn') return
  const titlebar = document.getElementById('titlebar')
  if (!titlebar) return

  const vscode = api

  // 自查 DOM（与 chat.ts 顶层 const 解耦）
  const welcome = document.getElementById('welcome')
  const messagesEl = document.getElementById('messages')
  // #titleWs = “> 工作区名”纯指示（悬停显示全称，不再开下拉）
  const titleWsBtn = document.getElementById('titleWs') as HTMLButtonElement
  const titleWsName = document.getElementById('titleWsName') as HTMLElement
  // #titleWorkBtn = 📁 独立按钮：工作区下拉的唯一开关
  const titleWorkBtn = document.getElementById('titleWorkBtn') as HTMLButtonElement
  const titleMoreBtn = document.getElementById('titleMoreBtn') as HTMLButtonElement
  const titleMorePopup = document.getElementById('titleMorePopup') as HTMLElement
  const titleWsDropdown = document.getElementById('titleWsDropdown') as HTMLElement
  if (!titleWsBtn || !titleWsName || !titleWorkBtn || !titleMoreBtn || !titleMorePopup || !titleWsDropdown) return

  // ---- 面板态（浏览器/本地/刷新按钮显隐，对齐原生 view/title 的 when）----
  let wsPanelOpen = false
  let wsViewMode: 'internal' | 'browser' = 'internal'
  function applyPanelState(): void {
    const vis: Record<string, boolean> = {
      // 浏览器打开：仅 面板开着 + 内部模式
      openInBrowser: wsPanelOpen && wsViewMode === 'internal',
      // 本地打开：面板没开 或 处于浏览器模式
      openInEditor: !wsPanelOpen || wsViewMode === 'browser',
      // 刷新：面板开着才刷得到
      reload: wsPanelOpen,
    }
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>('.title-btn[data-cmd]'))) {
      const cmd = btn.dataset['cmd'] ?? ''
      if (cmd in vis) {
        btn.classList.toggle('hidden', !vis[cmd])
      }
    }
  }

  // ---- 页内错误提示（wsActionDone 失败用）----
  function showErrorToast(message: string): void {
    if (!messagesEl || !welcome) return
    const safe = message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
    const el = document.createElement('div')
    el.className = 'msg assistant'
    el.innerHTML =
      `<div class="avatar" style="color:var(--vscode-errorForeground,#f14c4c)"><span class="codicon codicon-warning"></span></div>` +
      `<div class="col"><div class="body" style="color:var(--vscode-errorForeground,#f14c4c);background:rgba(241,76,76,0.08);border-radius:8px;padding:8px 10px;font-size:12px;">${safe}</div></div>`
    messagesEl.classList.remove('hidden')
    welcome.classList.add('hidden')
    messagesEl.appendChild(el)
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  // ---- 标题栏动作 → 扩展 dsh.* 命令 ----
  function runTitleCommand(cmd: string): void {
    if (!cmd) return
    vscode.postMessage({ type: 'titleAction', cmd })
  }

  // 工作区下拉已独立到 ./workspace/dropdown.ts；这里只负责注入 DOM 与消息。
  const workspaceDropdown = createWorkspaceDropdown({
    postMessage: (msg) => vscode.postMessage(msg),
    titleWsName,
    titleWsBtn,
    titleWorkBtn,
    dropdown: titleWsDropdown,
    showErrorToast,
    requestSelfInfo: () => vscode.postMessage({ type: 'selfInfoReq' }),
  })

  // ---- 标题栏动作/更多菜单事件（工作区下拉已在模块内绑定） ----
  // ⋯ 更多按钮：独立绑定（它没有 data-cmd）
  titleMoreBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    titleMorePopup.classList.toggle('hidden')
  })
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('.title-btn[data-cmd]'))) {
    const cmd = btn.dataset['cmd'] ?? ''
    btn.addEventListener('click', () => {
      runTitleCommand(cmd)
      titleMorePopup.classList.add('hidden')
    })
  }
  for (const item of Array.from(document.querySelectorAll<HTMLElement>('.title-more-item'))) {
    const cmd = item.dataset['cmd'] ?? ''
    item.addEventListener('click', () => {
      runTitleCommand(cmd)
      titleMorePopup.classList.add('hidden')
    })
  }
  document.addEventListener('click', (e) => {
    const t = e.target as Node
    if (titleMoreBtn && !titleMoreBtn.contains(t) && titleMorePopup && !titleMorePopup.contains(t)) {
      titleMorePopup.classList.add('hidden')
    }
  })

  // ---- 自绘标题栏消息：注册到页面唯一 message 通道（chat.ts 的 host 扇出）----
  // 只处理自绘关心的消息；其它 type 忽略（与 chat.ts 通用处理并存、互不吞消息）。
  api.onMessage((mRaw) => {
    const m = mRaw as Record<string, unknown>
    const type = typeof m?.type === 'string' ? m.type : ''
    if (!type) return

    if (type === 'panelState') {
      const ps = m as { panelOpen?: boolean; viewMode?: 'internal' | 'browser' }
      wsPanelOpen = !!ps.panelOpen
      if (ps.viewMode === 'internal' || ps.viewMode === 'browser') {
        wsViewMode = ps.viewMode
      }
      applyPanelState()
    } else if (type === 'selfInfo') {
      // B 专属自请求响应：当前工作区名 + 面板态（不与通用 chatInfo 耦合）
      const si = m as { workspaceName?: string; panelOpen?: boolean; viewMode?: 'internal' | 'browser' }
      workspaceDropdown.renderName(si.workspaceName)
      if (typeof si.panelOpen === 'boolean' && (si.viewMode === 'internal' || si.viewMode === 'browser')) {
        wsPanelOpen = si.panelOpen
        wsViewMode = si.viewMode
        applyPanelState()
      }
    } else if (type === 'wsDropdownList') {
      const dl = m as { workspaces?: Array<{ workspaceId: string; name: string; current?: boolean; newable?: boolean }> }
      workspaceDropdown.setList(
        (dl.workspaces ?? []).map((w) => ({
          workspaceId: w.workspaceId,
          name: w.name,
          current: !!w.current,
          newable: w.newable !== false,
        }))
      )
    } else if (type === 'wsDropdownSessions') {
      const ds = m as { workspaceId?: string; sessions?: Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current?: boolean }> }
      if (ds.workspaceId) workspaceDropdown.setSessions(ds.workspaceId, ds.sessions ?? [])
    } else if (type === 'wsActionDone') {
      const ad = m as { ok?: boolean; message?: string }
      workspaceDropdown.actionDone(!!ad.ok, ad.message)
    }
  })

  // 初始化即请求 selfInfo（扩展应答前标题显示「未选择工作区」，随后刷新）
  vscode.postMessage({ type: 'selfInfoReq' })
}
