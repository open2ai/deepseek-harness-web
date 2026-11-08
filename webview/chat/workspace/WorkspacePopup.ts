// 工作区下拉的 Preact 实现（替换原命令式 DOM）。
//
// 视觉按 VS Code 尺寸：弹窗宽 360、工作区行 24、会话行 22、字号走 --vscode-font-size；
// 当前工作区在树中原位置高亮；新会话/菜单只在 hover 出现；会话前是状态点。
//
// 数据仍走现有 wsDropdown 协议（list/sessions/wsnew/session/new），不改宿主；
// 全量状态字段（pendingInteraction / runningSubagentCount / completed）先做进模型，
// 宿主暂未下发时自然退化为 idle/ongoing。
import { render } from 'preact'
import { html } from 'htm/preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

export interface WorkspacePopupApi {
  postMessage(msg: unknown): void
  titleWsName: HTMLElement
  titleWsBtn: HTMLElement
  dropdown: HTMLElement
  titleWorkBtn: HTMLElement
  /** 锚点；原生覆盖层无按钮可锚则居中到顶部。 */
  anchor?: HTMLElement | null
  /** 关闭时回调（原生覆盖层据此收起外壳）。 */
  onClose?: () => void
  /** 旧调用点传入；Preact 版不再使用。 */
  search?: HTMLElement
  rows?: HTMLElement
  showErrorToast(message: string): void
  requestSelfInfo(): void
}

export interface WsDropdownItem {
  workspaceId: string
  name: string
  current: boolean
  newable: boolean
}

export interface WsSessionItem {
  sessionId: string
  title: string
  running: boolean
  blank: boolean
  current?: boolean
  /** 上游状态（宿主后续补）：等待审批/计划待审/等待回答。 */
  pendingInteraction?: 'approval' | 'plan-review' | 'question'
  /** 上游状态：n 个子智能体运行中。 */
  runningSubagentCount?: number
  /** 上游状态：有未读完成提醒。 */
  completed?: boolean
}

export interface WorkspacePopup {
  open(): void
  close(): void
  setList(workspaces: WsDropdownItem[]): void
  setSessions(workspaceId: string, sessions: WsSessionItem[]): void
  actionDone(ok: boolean, message?: string): void
  renderName(name?: string): void
}

export type StatusState = 'warning' | 'ongoing' | 'done' | 'idle'

/** 会话状态 → 状态点（优先级与上游 sessionStatuses 一致）。 */
export function statusOf(row: WsSessionItem): StatusState {
  if (row.pendingInteraction !== undefined) return 'warning'
  if (row.running || (row.runningSubagentCount ?? 0) > 0) return 'ongoing'
  if (row.completed === true) return 'done'
  return 'idle'
}

const COLLAPSED_SESSION_LIMIT = 5

/** 行尾状态文案（上游主状态 + 子智能体/完成提醒；当前用“当前”）。 */
function sessionStateLabel(row: WsSessionItem): string {
  const parts: string[] = []
  if (row.current) parts.push('当前')
  const kind = row.pendingInteraction
  if (kind === 'approval') parts.push('待审批')
  else if (kind === 'plan-review') parts.push('计划待审')
  else if (kind === 'question') parts.push('待回答')
  if (row.running) parts.push('运行中')
  if ((row.runningSubagentCount ?? 0) > 0) parts.push(`${String(row.runningSubagentCount)} 子代理`)
  if (row.completed === true) parts.push('已完成')
  return parts.join(' · ')
}

interface PopupState {
  version: number
  open: boolean
  query: string
  list: WsDropdownItem[]
  sessions: Map<string, WsSessionItem[]>
  expanded: Set<string>
  sessionsExpanded: Set<string>
}

interface PopupProps {
  state: PopupState
  close(): void
  post(msg: unknown): void
}

function Popup({ state, close, post }: PopupProps) {
  const searchRef = useRef<HTMLInputElement>(null)
  const [, force] = useState(0)
  useEffect(() => {
    if (state.open) searchRef.current?.focus()
  }, [state.open])

  const query = state.query.trim().toLowerCase()
  const visible = useMemo(() => {
    const match = (text: string): boolean => !query || text.toLowerCase().includes(query)
    const out: Array<{ ws: WsDropdownItem; rows: Array<{ kind: 'session'; s: WsSessionItem } | { kind: 'more'; hidden: number }> }> = []
    for (const ws of state.list) {
      const items = state.sessions.get(ws.workspaceId) ?? []
      const hitSessions = items.filter((s) => match(s.title))
      if (query && !match(ws.name) && hitSessions.length === 0) continue
      const expanded = state.expanded.has(ws.workspaceId) || !!query
      const source = query ? hitSessions : items
      const capped = state.sessionsExpanded.has(ws.workspaceId)
      const ordinary = source.filter((s) => !s.blank)
      const display = capped ? source : [...ordinary.slice(0, COLLAPSED_SESSION_LIMIT), ...source.filter((s) => s.blank)]
      const hidden = source.length - display.length
      out.push({
        ws,
        rows: expanded
          ? [
              ...display.map((s) => ({ kind: 'session' as const, s })),
              ...(hidden > 0 ? [{ kind: 'more' as const, hidden }] : []),
            ]
          : [],
      })
    }
    return out
  }, [state.version, state.list, state.sessions, state.expanded, state.sessionsExpanded, query])

  const toggle = (id: string): void => {
    if (state.expanded.has(id)) {
      state.expanded.delete(id)
    } else {
      state.expanded.add(id)
      if (!state.sessions.has(id)) post({ type: 'wsDropdown', op: 'sessions', workspaceId: id })
    }
    force((n) => n + 1)
  }
  const toggleMore = (id: string): void => {
    if (state.sessionsExpanded.has(id)) state.sessionsExpanded.delete(id)
    else state.sessionsExpanded.add(id)
    state.version += 1
    force((n) => n + 1)
  }

  return html`<div class="ws-pop" onMouseDown=${(e: Event) => e.stopPropagation()}>
    <div class="ws-pop-search">
      <span class="codicon codicon-search" aria-hidden="true"></span>
      <input
        ref=${searchRef}
        type="text"
        value=${state.query}
        placeholder="搜索工作区 / 会话"
        autocomplete="off"
        spellcheck="false"
        onInput=${(e: Event) => { state.query = (e.target as HTMLInputElement).value; force((n) => n + 1) }}
        onKeyDown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            const first = (e.currentTarget as HTMLElement).closest('.ws-pop')?.querySelector<HTMLElement>('[data-act]:not([data-act="none"])')
            first?.click()
            e.preventDefault()
          } else if (e.key === 'Escape') {
            close()
          }
        }}
      />
      ${state.query !== ''
        ? html`<button type="button" class="ws-pop-clear" title="清除搜索" aria-label="清除搜索" onClick=${() => { state.query = ''; state.version += 1; force((n) => n + 1) }}>
            <span class="codicon codicon-close" aria-hidden="true"></span>
          </button>`
        : null}
    </div>

    <div class="ws-pop-rows">
      ${visible.map(({ ws, rows }) => html`
        <div class=${'ws-pop-ws' + (ws.current ? ' is-current' : '')} data-act="ws" data-id=${ws.workspaceId} onClick=${() => toggle(ws.workspaceId)}>
          <span class=${'codicon ws-pop-caret ' + (state.expanded.has(ws.workspaceId) || query ? 'codicon-chevron-down' : 'codicon-chevron-right')} aria-hidden="true"></span>
          <span class="codicon codicon-folder ws-pop-folder" aria-hidden="true"></span>
          <span class="ws-pop-name" title=${ws.name}>${ws.name}</span>
          ${ws.current ? html`<span class="codicon codicon-check ws-pop-state" title="当前工作区" aria-label="当前工作区"></span>` : null}
          ${ws.newable !== false
            ? html`<span class="ws-pop-actions">
                <button type="button" class="ws-pop-icon" title="在此工作区新开会话" aria-label="在此工作区新开会话"
                  onClick=${(e: Event) => { e.stopPropagation(); post({ type: 'wsDropdown', op: 'wsnew', workspaceId: ws.workspaceId }); close() }}>
                  <span class="codicon codicon-comment-discussion" aria-hidden="true"></span>
                </button>
                <button type="button" class="ws-pop-icon" title="更多" aria-label="更多" onClick=${(e: Event) => e.stopPropagation()}>
                  <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
                </button>
              </span>`
            : null}
        </div>
        ${rows.map((row) => row.kind === 'session'
          ? html`<div class=${"ws-pop-session" + (row.s.current ? " is-current" : "")} data-act="session" data-id=${ws.workspaceId} data-sid=${row.s.sessionId}
              onClick=${() => { post({ type: 'wsDropdown', op: 'session', workspaceId: ws.workspaceId, sessionId: row.s.sessionId }); close() }}>
              <span class=${'ws-pop-dot is-' + statusOf(row.s)} aria-hidden="true"></span>
              <span class="ws-pop-name" title=${row.s.title}>${row.s.title}</span>
              ${sessionStateLabel(row.s) !== '' ? html`<span class="ws-pop-state" title=${sessionStateLabel(row.s)}>${sessionStateLabel(row.s)}</span>` : null}
            </div>`
          : html`<button type="button" class="ws-pop-more" onClick=${() => toggleMore(ws.workspaceId)}>
              <span class=${'codicon ' + (state.sessionsExpanded.has(ws.workspaceId) ? 'codicon-chevron-up' : 'codicon-chevron-down')} aria-hidden="true"></span>
              <span>${state.sessionsExpanded.has(ws.workspaceId) ? '收起' : `展开其余 ${String(row.hidden)} 个会话`}</span>
            </button>`)}
      `)}
      ${visible.length === 0 ? html`<div class="ws-pop-empty">${query ? '无匹配的工作区或会话' : '暂无工作区'}</div>` : null}
    </div>

    <div class="ws-pop-footer">
      <button type="button" class="ws-pop-new" data-act="new" onClick=${() => { post({ type: 'wsDropdown', op: 'new' }); close() }}>
        <span class="codicon codicon-add" aria-hidden="true"></span>
        <span>新建工作区…</span>
      </button>
    </div>
  </div>`
}

/**
 * 挂载工作区下拉 Preact 组件。
 * @param api - 宿主注入的容器/按钮/消息回调。
 * @returns 控制器（与旧命令式实现同一套方法，titlebar 无需改调用）。
 */
export function mountWorkspacePopup(api: WorkspacePopupApi): WorkspacePopup {
  api.dropdown.classList.add('ws-pop-shell')
  const state: PopupState = {
    version: 0,
    open: false,
    query: '',
    list: [],
    sessions: new Map(),
    expanded: new Set(),
    sessionsExpanded: new Set(),
  }
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  const host = document.createElement('div')
  api.dropdown.replaceChildren(host)
  const renderTree = (): void => {
    render(html`<${Popup} state=${state} close=${close} post=${(m: unknown) => api.postMessage(m)} />`, host)
  }
  const close = (): void => {
    const wasOpen = state.open
    state.open = false
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer)
      refreshTimer = undefined
    }
    api.dropdown.classList.add('hidden')
    renderTree()
    if (wasOpen) api.onClose?.()
  }
  renderTree()

  // 唯一开关：右侧 📁 按钮；点击外部关闭。
  api.titleWorkBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    if (api.dropdown.classList.contains('hidden')) controller.open()
    else close()
  })
  document.addEventListener('click', (event) => {
    const target = event.target as Node
    if (!api.titleWorkBtn.contains(target) && !api.dropdown.contains(target)) close()
  })

  const controller: WorkspacePopup = {
    open() {
      state.open = true
      state.query = ''
      state.version += 1
      api.dropdown.classList.remove('hidden')
      const width = Math.min(360, window.innerWidth - 16)
      api.dropdown.style.position = 'fixed'
      api.dropdown.style.width = `${String(width)}px`
      const anchor = api.anchor ?? (api.titleWorkBtn.isConnected ? api.titleWorkBtn : null)
      if (anchor !== null) {
        const rect = anchor.getBoundingClientRect()
        api.dropdown.style.left = `${String(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)))}px`
        api.dropdown.style.top = `${String(rect.bottom + 2)}px`
        api.dropdown.style.transform = 'none'
      } else {
        api.dropdown.style.left = '50%'
        api.dropdown.style.top = '48px'
        api.dropdown.style.transform = 'translateX(-50%)'
      }
      api.postMessage({ type: 'wsDropdown', op: 'list' })
      if (refreshTimer !== undefined) clearInterval(refreshTimer)
      // 外部客户端应答/子智能体变化不会推给本页：打开期间每 5 秒重读已展开工作区的会话。
      refreshTimer = setInterval(() => {
        for (const workspaceId of state.expanded) {
          api.postMessage({ type: 'wsDropdown', op: 'sessions', workspaceId })
        }
      }, 5000)
      renderTree()
    },
    close,
    setList(workspaces) {
      state.version += 1
      state.list = workspaces
      state.expanded.clear()
      state.sessions.clear()
      state.sessionsExpanded.clear()
      // 默认展开当前工作区（与设计图一致）：首次列表到达就展开并拉它的会话。
      const current = workspaces.find((w) => w.current)
      if (current !== undefined) {
        state.expanded.add(current.workspaceId)
        api.postMessage({ type: 'wsDropdown', op: 'sessions', workspaceId: current.workspaceId })
      }
      renderTree()
    },
    setSessions(workspaceId, sessions) {
      state.version += 1
      state.sessions.set(workspaceId, sessions)
      renderTree()
    },
    actionDone(ok, message) {
      if (!ok && message) api.showErrorToast(message)
      close()
      if (ok) api.requestSelfInfo()
    },
    renderName(name) {
      const trimmed = name?.trim()
      api.titleWsName.textContent = trimmed ? trimmed : '未选择工作区'
      api.titleWsBtn.title = trimmed ? `工作区：${trimmed}` : '工作区：未选择'
    },
  }
  return controller
}
