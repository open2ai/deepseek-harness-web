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
  const wsSearchEl = document.getElementById('wsSearch') as HTMLInputElement
  const wsRowsEl = document.getElementById('wsRows') as HTMLElement
  if (!titleWsBtn || !titleWsName || !titleWorkBtn || !titleMoreBtn || !titleMorePopup || !titleWsDropdown || !wsSearchEl || !wsRowsEl) return

  // ---- 状态 ----
  interface WsDropdownItem {
    workspaceId: string
    name: string
    current: boolean
    /** false = 这一行不能"在此新开会话"（「未分组」没有工作区实体） */
    newable: boolean
  }
  interface WsSessionItem {
    sessionId: string
    title: string
    running: boolean
    blank: boolean
    current?: boolean
  }
  let wsDropdownList: WsDropdownItem[] = []
  const wsDropdownExpanded = new Set<string>()
  const wsDropdownSessions = new Map<string, WsSessionItem[]>()
  const wsSessionsRequested = new Set<string>()
  /** 已点过"展开其余 N 个会话"的分组（每组一份本地状态，打开下拉即重置） */
  const wsSessionsExpanded = new Set<string>()

  /** 每组先列几条普通会话（与网页端同一上限；空白会话不占额）与溢出条数。 */
  const COLLAPSED_SESSION_LIMIT = 5
  function cappedSessionRows(sessions: WsSessionItem[]): { rows: WsSessionItem[]; hiddenCount: number } {
    let ordinary = 0
    const rows = sessions.filter((s) => {
      if (s.blank) {
        return true
      }
      if (ordinary >= COLLAPSED_SESSION_LIMIT) {
        return false
      }
      ordinary += 1
      return true
    })
    return { rows, hiddenCount: sessions.length - rows.length }
  }

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

  // ---- 工作区名显示 ----
  function renderTitleWorkspace(name?: string): void {
    titleWsName.textContent = name?.trim() ? name.trim() : '未选择工作区'
    titleWsBtn.title = name?.trim() ? `工作区：${name.trim()}` : '工作区：未选择'
  }

  // ---- 工作区 dropdown（复刻原生 QuickPick：搜索框 + 当前行 + 工作区树 + 底部新建）----
  /** 若该工作区会话尚未拉取则请求（带去重，避免反复弹） */
  function requestSessionsIfNeeded(wsId: string): void {
    if (wsDropdownSessions.has(wsId) || wsSessionsRequested.has(wsId)) return
    wsSessionsRequested.add(wsId)
    vscode.postMessage({ type: 'wsDropdown', op: 'sessions', workspaceId: wsId })
  }

  /** 建一行工作区行（button）；act/id 用于点击委派 */
  function makeWsRow(act: string, opts: { id?: string; icon: string; iconClass?: string; text: string; desc?: string; cls?: string; sid?: string; disabled?: boolean }): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'wsrow' + (opts.cls ? ' ' + opts.cls : '')
    b.dataset['act'] = act
    if (opts.id) b.dataset['id'] = opts.id
    if (opts.sid) b.dataset['sid'] = opts.sid
    if (opts.disabled) b.disabled = true
    b.innerHTML =
      `<span class="codicon codicon-${opts.icon} ${opts.iconClass ?? ''} ws-${act}-icon"></span>` +
      `<span class="ws-name"></span>` +
      (opts.desc ? `<span class="ws-desc"></span>` : ``)
    const n = b.querySelector('.ws-name')!
    n.textContent = opts.text
    if (opts.desc) b.querySelector('.ws-desc')!.textContent = opts.desc
    // 名称过长省略时悬停显示全文
    b.title = opts.text
    return b
  }

  /** 会话是否与当前搜索词匹配（本地小写子串匹配） */
  function wsSessionMatches(s: WsSessionItem, q: string): boolean {
    if (!q) return true
    return s.title.toLowerCase().includes(q)
  }
  function wsNameMatches(name: string, q: string): boolean {
    if (!q) return true
    return name.toLowerCase().includes(q)
  }

  /** 复刻原生工作区面板：当前工作区行 + 工作区树（可展开会话/新会话）+ 底部新建；支持搜索过滤 */
  function renderWsDropdown(): void {
    const q = (wsSearchEl.value ?? '').trim().toLowerCase()
    const curWs = wsDropdownList.find((w) => w.current)
    const frag = document.createDocumentFragment()
    const appendSessionRows = (w: WsDropdownItem, sessions: WsSessionItem[]): void => {
      // 「未分组」没有工作区实体 → 不给"在此新开会话"（新会话必须归属某个工作区）
      if (w.newable !== false) {
        frag.appendChild(
          makeWsRow('wsnew', {
            id: w.workspaceId,
            icon: 'add',
            iconClass: 'ws-session-icon',
            text: '在此工作区新开会话',
          })
        )
      }
      // 每组最多先列 5 条普通会话（空白会话不占额），其余折成一行"展开其余 N 个会话"。
      // 与网页端同一口径（它对每个工作区用同一个上限 + 本地溢出控件）。
      const visible = sessions.filter((s) => wsSessionMatches(s, q))
      const isExpanded = wsSessionsExpanded.has(w.workspaceId)
      const capped = cappedSessionRows(visible)
      const shown = isExpanded ? visible : capped.rows
      for (const s of shown) {
        // 当前会话标「当前」+ 选中图标，置顶直观看到正在用的新会话/历史会话
        frag.appendChild(
          makeWsRow('session', {
            id: w.workspaceId,
            sid: s.sessionId,
            icon: s.current ? 'check' : s.running ? 'sync' : 'history',
            iconClass: 'ws-session-icon',
            text: s.title,
            desc: s.current ? '当前' : s.running ? '运行中' : '恢复',
          })
        )
      }
      if (capped.hiddenCount > 0) {
        frag.appendChild(
          makeWsRow('wsmore', {
            id: w.workspaceId,
            icon: isExpanded ? 'chevron-up' : 'chevron-down',
            iconClass: 'ws-caret',
            text: isExpanded ? '收起' : `展开其余 ${capped.hiddenCount} 个会话`,
            cls: 'ws-more-row',
          })
        )
      }
    }

    // 顶部：当前工作区（原生首行 info 语义，非可点）
    if (!q) {
      frag.appendChild(
        makeWsRow('info', {
          icon: 'folder-opened',
          text: `工作区：${curWs ? curWs.name : '未分组'}`,
          desc: curWs ? '当前' : '未选择',
          cls: 'ws-current-row',
        })
      )
    }

    // 搜索时：所有工作区都会尝试拉会话，便于跨工作区搜会话
    for (const w of wsDropdownList) {
      const open = wsDropdownExpanded.has(w.workspaceId)
      const sessions = wsDropdownSessions.get(w.workspaceId)
      const nameHit = wsNameMatches(w.name, q)
      const hitSessions = (sessions ?? []).filter((s) => wsSessionMatches(s, q))

      // 搜索模式：只显示名字命中 或 其下会话命中的工作区
      if (q && !nameHit && hitSessions.length === 0) continue

      const row = makeWsRow('ws', {
        id: w.workspaceId,
        icon: open ? 'chevron-down' : 'chevron-right',
        iconClass: 'ws-caret',
        text: w.name,
        desc: w.current ? '当前' : undefined,
      })
      if (w.current && !q) {
        row.querySelector('.ws-caret')!.insertAdjacentHTML('afterend', `<span class="codicon codicon-check ws-check"></span>`)
      }
      frag.appendChild(row)

      // 需要展示会话但未拉取 → 请求（返回后 wsDropdownSessions 会再 render）
      if ((open || !!q) && !sessions) {
        requestSessionsIfNeeded(w.workspaceId)
      }
      if (sessions && (open || q)) {
        appendSessionRows(w, sessions)
      }
    }
    if (!q) {
      frag.appendChild(
        makeWsRow('new', {
          icon: 'new-folder',
          iconClass: 'ws-session-icon',
          text: '＋ 新建工作区…',
          cls: 'ws-new-row',
        })
      )
    }
    // 搜索无命中时 wsRows 为空 → 由 CSS #wsRows:empty::after 显示「无匹配」提示
    wsRowsEl.replaceChildren(frag)
  }

  function openWsDropdown(): void {
    wsSearchEl.value = ''
    wsRowsEl.replaceChildren()
    titleWsDropdown.classList.remove('hidden')
    vscode.postMessage({ type: 'wsDropdown', op: 'list' })
    renderWsDropdown()
    wsSearchEl.focus()
  }
  function closeWsDropdown(): void {
    titleWsDropdown.classList.add('hidden')
  }

  // ---- 事件绑定 ----
  // 工作区下拉的唯一开关是右侧 📁(titleWorkBtn)；左侧“> 工作区名”仅指示、悬停看全名
  titleWorkBtn.addEventListener('click', () => {
    if (titleWsDropdown.classList.contains('hidden')) {
      openWsDropdown()
    } else {
      closeWsDropdown()
    }
  })
  // 搜索框输入即重渲染；命中未拉会话的工作区时按需拉取
  wsSearchEl.addEventListener('input', () => {
    const q = (wsSearchEl.value ?? '').trim().toLowerCase()
    if (q) {
      for (const w of wsDropdownList) {
        if (!wsDropdownSessions.has(w.workspaceId)) requestSessionsIfNeeded(w.workspaceId)
      }
    }
    renderWsDropdown()
  })
  wsSearchEl.addEventListener('keydown', (e) => {
    // Enter：聚焦列表第一行并模拟点击首个可点行（会话/工作区/新建 均可）
    if (e.key === 'Enter') {
      const first = wsRowsEl.querySelector<HTMLElement>('.wsrow[data-act]:not([data-act="info"])')
      first?.click()
      e.preventDefault()
    }
  })
  titleWsDropdown.addEventListener('click', (e) => {
    // 阻止冒泡到 document 关闭监听：展开/折叠会 replaceChildren 把被点行移出 DOM，
    // 不拦截会令 contains(旧节点) 判 false → 下拉被误关（“还没选就关”）。
    e.stopPropagation()
    const row = (e.target as HTMLElement).closest<HTMLElement>('.wsrow')
    if (!row) {
      return
    }
    const act = row.dataset['act']
    const id = row.dataset['id']
    if (act === 'ws' && id) {
      if (wsDropdownExpanded.has(id)) {
        wsDropdownExpanded.delete(id)
      } else {
        wsDropdownExpanded.add(id)
      }
      renderWsDropdown()
    } else if (act === 'wsmore' && id) {
      // 「展开其余 N 个会话 / 收起」：只切这一组的本地展开态，不重新拉数据
      if (wsSessionsExpanded.has(id)) {
        wsSessionsExpanded.delete(id)
      } else {
        wsSessionsExpanded.add(id)
      }
      renderWsDropdown()
    } else if (act === 'wsnew' && id) {
      vscode.postMessage({ type: 'wsDropdown', op: 'wsnew', workspaceId: id })
      closeWsDropdown()
    } else if (act === 'session' && id && row.dataset['sid']) {
      vscode.postMessage({
        type: 'wsDropdown',
        op: 'session',
        workspaceId: id,
        sessionId: row.dataset['sid'],
      })
      closeWsDropdown()
    } else if (act === 'new') {
      vscode.postMessage({ type: 'wsDropdown', op: 'new' })
      closeWsDropdown()
    }
  })

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
    if (titleWorkBtn && !titleWorkBtn.contains(t) && titleWsDropdown && !titleWsDropdown.contains(t)) {
      closeWsDropdown()
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
      renderTitleWorkspace(si.workspaceName)
      if (typeof si.panelOpen === 'boolean' && (si.viewMode === 'internal' || si.viewMode === 'browser')) {
        wsPanelOpen = si.panelOpen
        wsViewMode = si.viewMode
        applyPanelState()
      }
    } else if (type === 'wsDropdownList') {
      const dl = m as { workspaces?: Array<{ workspaceId: string; name: string; current?: boolean; newable?: boolean }> }
      wsDropdownList = (dl.workspaces ?? []).map((w) => ({
        workspaceId: w.workspaceId,
        name: w.name,
        current: !!w.current,
        newable: w.newable !== false,
      }))
      // 会话缓存/展开状态/拉取标记随列表刷新
      wsDropdownExpanded.clear()
      wsDropdownSessions.clear()
      wsSessionsRequested.clear()
      wsSessionsExpanded.clear()
      renderWsDropdown()
    } else if (type === 'wsDropdownSessions') {
      const ds = m as { workspaceId?: string; sessions?: Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current?: boolean }> }
      if (ds.workspaceId) {
        wsDropdownSessions.set(ds.workspaceId, ds.sessions ?? [])
        wsSessionsRequested.delete(ds.workspaceId)
        renderWsDropdown()
      }
    } else if (type === 'wsActionDone') {
      const ad = m as { ok?: boolean; message?: string }
      if (!ad.ok && ad.message) {
        showErrorToast(ad.message)
      }
      closeWsDropdown()
      // 工作区可能已切换（wsnew/session/new 成功）→ 重新取 selfInfo 刷新名字
      if (ad.ok) {
        vscode.postMessage({ type: 'selfInfoReq' })
      }
    }
  })

  // 初始化即请求 selfInfo（扩展应答前标题显示「未选择工作区」，随后刷新）
  vscode.postMessage({ type: 'selfInfoReq' })
}
