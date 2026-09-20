// 聊天 UI 组件层(preact + htm)。组件只读 store 信号并渲染;改动一律经 store 动作。
// DOM 结构与旧 index.html 骨架、类名、图标逐一对应,沿用全局 VSCode 主题 CSS。
// 顶部 ChatApp 不读信号 → 挂载后不整体重渲;#titlebar / #dshModal 等命令式子树因此不被 Preact 覆写。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ChatStore } from '../core/store/chat'
import type { ImageAttachment } from '../core/protocol'
import { MODE_NAMES, DANGEROUS_PERMS } from '../core/format'
import { showDialog } from '../modal'
import { fileLabels, fileExt, fileSizeText } from '../core/file-labels'
import { fileUriToPath } from '../core/format'
import { SearchPicker } from './SearchPicker'
import { ModelPicker } from './ModelPicker'
import { keepRowVisible } from '../core/scroll'
import { useTriggerMenu } from '../core/trigger/useTrigger'
import { decideInputKey } from '../core/inputKeys'
import { slashTrigger } from '../core/trigger/slash'
import { atTrigger } from '../core/trigger/at'
import { MessageList } from './message/MessageList'
import { QuestionDialog } from './message/QuestionDialog'
import { FeedbackDialog } from './message/FeedbackDialog'
import { FeedbackToast } from './FeedbackToast'
import { TodoCard } from './TodoCard'
import { QueueCard } from './QueueCard'
import { ContextMeter } from './ContextMeter'
import { StatsCards } from './StatsCards'
import { GoalBar } from './goal/GoalBar'

// ---------------- Welcome ----------------
function Welcome({ store }: { store: ChatStore }) {
  if (store.view.value !== 'welcome') return null
  const sugg: Array<[string, string]> = [
    ['解释选中代码', '请解释一下我选中的代码'],
    ['重构这段代码', '请把这段代码重构得更清晰，并说明改动'],
    ['写单元测试', '请为这段代码写单元测试'],
  ]
  return html`<div id="welcome">
    <div class="welcome-title">AI 助手</div>
    <div class="welcome-desc">通过本地 DeepSeek Harness 对话。选中代码右键可 @ 到输入框。</div>
    <div class="suggestions">
      ${sugg.map(([label, p]) => html`<button class="suggestion" key=${p} onClick=${() => store.suggestion(p)}>${label}</button>`)}
    </div>
  </div>`
}

// ---------------- 附件 chips ----------------
function AttachmentBar({ store }: { store: ChatStore }) {
  const imgs = store.images.value
  const paths = store.attachments.value
  if (imgs.length === 0 && paths.length === 0) {
    return html`<div id="attachments" class="hidden"></div>`
  }
  return html`<div id="attachments">
    ${imgs.map(
      (img) => html`<span class="img-chip" key=${img.name}>
        <img class="img-thumb" src=${`data:${img.mediaType};base64,${img.data}`} title=${img.name} />
        <span class="x" onClick=${() => store.removeImage(img)}>✕</span></span>`
    )}
    ${paths.map((f) => {
      const labels = fileLabels()
      if (f.state === 'error') {
        return html`<span class="file-chip is-error" key=${f.key} title=${f.error ?? labels.failed}>
          <span class="ficon"><span class="codicon codicon-warning"></span></span>
          <button type="button" class="fname" title=${labels.retry(f.name)} onClick=${() => store.retryUpload(f.key)}>${labels.failed}</button>
          <span class="x" title=${labels.remove(f.name)} onClick=${() => store.removeAttachment(f.key)}>✕</span></span>`
      }
      const meta = f.state === 'uploading' ? labels.uploading : [fileExt(f.name), fileSizeText(f.bytes)].filter(Boolean).join(' ')
      return html`<span class="file-chip${f.state === 'uploading' ? ' is-uploading' : ''}" key=${f.key} title=${f.path}>
        <span class="ficon"><span class="codicon codicon-file"></span></span>
        <span class="fname">${f.name}</span>
        <span class="fmeta">${meta}</span>
        <span class="x" title=${labels.remove(f.name)} onClick=${() => store.removeAttachment(f.key)}>✕</span></span>`
    })}
  </div>`
}

// ---------------- 权限 / 模型 / 模式 弹窗 ----------------
function Popup({ store }: { store: ChatStore }) {
  const open = store.openPopup.value
  const sel = store.sel.value
  const composerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    composerRef.current = document.getElementById('composer')
  })
  // 模式弹窗的键盘光标位：底色=光标、✓=当前生效模式（与权限/模型弹窗同一语义）
  const [modeIdx, setModeIdx] = useState(0)
  const modeRef = useRef<HTMLDivElement | null>(null)
  const modeCount = sel.modeOptions.length
  const modeActive = modeCount === 0 ? 0 : Math.min(Math.max(modeIdx, 0), modeCount - 1)
  // 打开时定位到当前模式，并把 DOM 焦点交给容器——否则按键仍落在 textarea 上，收不到 ↑↓。
  // 依赖只取 open：模式目录中途刷新(chatInfo)不重置用户已移动的光标
  useEffect(() => {
    if (open !== 'mode') return
    const i = sel.modeOptions.findIndex((m) => m.id === sel.currentMode)
    setModeIdx(i < 0 ? 0 : i)
    modeRef.current?.focus()
  }, [open])
  // 光标移动时把高亮行滚进容器可视区（#modePopup 自身 overflow-y:auto）
  useEffect(() => {
    if (open !== 'mode') return
    keepRowVisible(modeRef.current, modeActive)
  }, [open, modeActive])
  // 锚定到对应按钮上方(与旧 anchorPopup 一致)
  const style = (
    btnId: string,
    fixed: boolean
  ): { bottom?: string; left?: string; position?: string; width?: string; maxHeight?: string } => {
    const c = composerRef.current
    const b = document.getElementById(btnId)
    if (!c || !b) return {}
    const cr = c.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    const bottomPx = Math.round(cr.bottom - br.top + 6)
    const leftPx = Math.round(br.left - cr.left)
    const base: { bottom: string; left: string } = { bottom: bottomPx + 'px', left: Math.max(4, Math.min(leftPx, cr.width - 24)) + 'px' }
    if (fixed) {
      const vw = window.innerWidth || document.documentElement.clientWidth
      const vh = window.innerHeight || document.documentElement.clientHeight
      const width = Math.min(360, vw - 16)
      return {
        position: 'fixed',
        left: Math.max(8, Math.min(br.left, vw - width - 8)) + 'px',
        bottom: Math.max(8, vh - br.top + 8) + 'px',
        width: width + 'px',
        maxHeight: Math.max(120, Math.min(vh * 0.46, br.top - 8)) + 'px',
      }
    }
    return base
  }

  // 权限（公共可搜索选择弹窗 SearchPicker：顶部搜索 + 方向键选择）
  let permPopup = html`<div id="permPopup" class="popup hidden"></div>`
  if (open === 'perm') {
    const permOpts = sel.permOptions.map((o) => ({ value: o.value, name: o.name, description: o.description }))
    const pickPerm = (o: { value: string; name?: string }): void => {
      if (o.value === sel.currentPerm) {
        store.closePopups()
        return
      }
      if (DANGEROUS_PERMS.has(o.value)) {
        store.closePopups()
        const label = o.value === 'danger-full-access' ? 'Full access' : o.name || o.value
        void showDialog({
          icon: 'warn',
          title: `确认启用 ${label}？`,
          body:
            `启用 ${label} 后，agent 将减少确认步骤，并且可以直接执行更多操作，` +
            `包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。`,
          ack: '我已了解风险，并愿意继续',
          okText: '启用',
          okStyle: 'danger',
          cancelText: '取消',
        }).then((ok) => {
          if (ok) store.selectPerm(o.value)
        })
        return
      }
      store.selectPerm(o.value)
    }
    permPopup = html`<div id="permPopup" class="popup" style=${style('permBtn', false)}>
      <${SearchPicker} title="权限" options=${permOpts} currentId=${sel.currentPerm}
        onPick=${pickPerm} onClose=${() => store.closePopups()} emptyText="没有可用的权限" />
    </div>`
  }

  // 模型 + 推理等级：按钮入口 = 完整分组 + 推理等级(保持旧版)；/model 斜杠入口 = 仅可搜索模型列表
  let modelPopup = html`<div id="modelPopup" class="popup hidden"></div>`
  if (open === 'model') {
    // 模型图标入口的完整「模型+推理等级」view（独立组件 ModelPicker，便于后续单独改样式）
    modelPopup = html`<div id="modelPopup" class="popup" style=${style('modelBtn', false)}>
      <${ModelPicker} store=${store} />
    </div>`
  } else if (open === 'modelSearch') {
    // /model：摊平成单列表供 SearchPicker 搜索(名称/提供方)，选完即关
    const modelOptions = (sel.modelGroups ?? []).flatMap((g) =>
      g.models.map((m) => ({
        value: `${g.id}::${m.id}`,
        name: m.name || m.id,
        description: `${g.name || g.id}${m.description ? ` · ${m.description}` : ''}`,
      }))
    )
    const currentModelValue = sel.curProvider && sel.curModel ? `${sel.curProvider}::${sel.curModel}` : ''
    const pickModel = (o: { value: string }): void => {
      const sep = o.value.indexOf('::')
      if (sep < 0) return
      const provider = o.value.slice(0, sep)
      const model = o.value.slice(sep + 2)
      store.selectModel(provider, model)
      store.closePopups()
    }
    modelPopup = html`<div id="modelPopup" class="popup" style=${style('modelBtn', false)}>
      ${sel.modelFailures.length > 0
        ? html`<div class="popup-fail" title=${JSON.stringify(sel.modelFailures)}><span class="codicon codicon-warning inline-ico"></span>${sel.modelFailures.length} 组模型加载失败</div>`
        : null}
      <${SearchPicker} title="模型" options=${modelOptions} currentId=${currentModelValue}
        onPick=${pickModel} onClose=${() => store.closePopups()} emptyText="没有可用的模型" />
    </div>`
  }

  // 模式(固定位)：↑↓ 循环、Enter 选中、Esc 关闭；底色=光标位、✓=当前生效模式
  let modePopup = html`<div id="modePopup" class="popup hidden"></div>`
  if (open === 'mode') {
    // 关闭后把焦点交还输入框：弹窗卸载后焦点会掉到 body，接着打字/敲 "/" 都会失效
    const backToInput = (): void => {
      queueMicrotask(() => document.getElementById('input')?.focus())
    }
    const pickMode = (id: string): void => {
      store.selectMode(id) // 内部 closePopups
      backToInput()
    }
    const onModeKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (modeCount > 0) setModeIdx((i) => (i + 1) % modeCount)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (modeCount > 0) setModeIdx((i) => (i - 1 + modeCount) % modeCount)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const m = sel.modeOptions[modeActive]
        if (m) pickMode(m.id)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        store.closePopups()
        backToInput()
      }
    }
    modePopup = html`<div id="modePopup" class="popup" style=${style('modeBtn', true)} tabIndex=${-1}
      role="listbox" aria-label="会话模式" ref=${modeRef} onKeyDown=${onModeKeyDown}>
      <div class="popup-title">会话模式</div>
      ${modeCount === 0
        ? html`<div class="opt" style=${{ opacity: 0.6 }}>暂无可用模式</div>`
        : sel.modeOptions.map(
            (m, i) => html`<div class=${'opt' + (i === modeActive ? ' selected' : '')} key=${m.id}
              role="option" aria-selected=${i === modeActive} data-idx=${i}
              onMouseEnter=${() => setModeIdx(i)}
              onClick=${() => pickMode(m.id)}>
              <span>${m.id === sel.currentMode ? '✓ ' : ''}${m.name || MODE_NAMES[m.id] || m.id}</span>
              ${m.description ? html`<span class="opt-desc">${m.description}</span>` : null}
            </div>`
          )}
    </div>`
  }

  return html`${permPopup}${modelPopup}${modePopup}`
}

// ---------------- Composer ----------------
// 导出供脚本级验收（`tmp/_composer.dom.test.mjs`）用真组件渲染。
export function Composer({ store }: { store: ChatStore }) {
  const text = store.text.value
  const processing = store.processing.value
  // 「空」= 草稿 + 附件 + 图片 + 引用**全都空**（上游 `InputBar.tsx:75` 的同一判据）
  const empty =
    text.trim() === '' &&
    store.attachments.value.length === 0 &&
    store.images.value.length === 0 &&
    store.refs.value.length === 0
  const running = store.turnRunning.value
  // 主钮三态照上游 `InputBar.tsx:346-365`：`primaryStops = running && subagent===null && (empty || blocked)`
  //（后者本插件取「普通会话」那一支：拿不到 subagent/blocked）。
  // 于是：**只有输入区空着才是「停止生成」**；非空时主钮是发送（忙时=排队发送）。
  const stops = (running || processing) && empty
  const busy = store.busy.value // 过渡态：恢复历史/切工作区时禁用输入
  const sendLabel = stops ? '停止生成' : busy ? '加载中…' : running ? '排队发送' : '发送消息'
  const sel = store.sel.value
  const focusTick = store.focusTick.value
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const refRowRef = useRef<HTMLDivElement | null>(null)

  // draft 到来 → 聚焦
  useEffect(() => {
    if (focusTick > 0) taRef.current?.focus()
  }, [focusTick])

  // 贴片叠在首行行首：按 #refRow 实际宽度只缩进 textarea 的第一行(text-indent)，
  // 后续行/回车换行自然回到最左；垂直方向按 textarea 实测行高+上内距把贴片中心对准首行文字中心
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const row = refRowRef.current
    if (row) {
      const w = Math.min(row.scrollWidth, Math.max(0, ta.clientWidth * 0.62))
      ta.style.textIndent = `${w}px`
      const cs = getComputedStyle(ta)
      let lh = parseFloat(cs.lineHeight)
      if (!Number.isFinite(lh) || lh <= 0) lh = Math.round((parseFloat(cs.fontSize) || 13) * 1.4)
      const pt = parseFloat(cs.paddingTop)
      const chipH = row.firstElementChild ? (row.firstElementChild as HTMLElement).offsetHeight : 20
      row.style.top = `${Math.max(4, Math.round(pt + lh / 2 - chipH / 2))}px`
    } else {
      ta.style.textIndent = ''
    }
  })

  // 点击外部关闭弹窗（触发器菜单由 useTriggerMenu 自管关闭）
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Node
      // 事件路径在**派发时**取（composedPath）：只认 `el.contains(target)` 会漏判 ——
      // 点击弹窗内的入口若触发了重渲染（如模型弹窗从一级换到二级），那个按钮此刻已被卸载，
      // target 脱离文档 → contains 为假 → 被误判成「点在弹窗外」而立刻关掉弹窗
      // （真机现象：点一级入口后二级没出现，弹窗直接消失）。
      const path = typeof e.composedPath === 'function' ? e.composedPath() : []
      const inSel = (id: string): boolean => {
        const el = document.getElementById(id)
        return !!el && (el.contains(t) || path.includes(el))
      }
      if (inSel('permPopup') || inSel('modelPopup') || inSel('modePopup') || inSel('permBtn') || inSel('modelBtn') || inSel('modeBtn') || inSel('triggerPopup')) return
      if (store.openPopup.value) store.closePopups()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  const permName = (): string => {
    const s = store.sel.value
    const found = s.permOptions.find((o) => o.value === s.currentPerm)
    return found ? found.name || found.value : store.permNameOf.get(s.currentPerm) ?? ''
  }
  const modelName = (): string => {
    const s = store.sel.value
    if (!s.curProvider || !s.curModel) return ''
    const g = s.modelGroups?.find((x) => x.id === s.curProvider)
    const m = g?.models.find((x) => x.id === s.curModel)
    let label = m?.name || s.curModel
    // 等级位对齐上游 ModelSelect.effortLabel 的三级取值：当前值 → 该模型 defaultEffort → 上游字典的 Default。
    // 末级不是空——没有它，切到无默认等级的模型时等级位会整个消失
    const effId = s.curEffort || m?.reasoning?.defaultEffort
    const effort = m?.reasoning?.efforts?.find((x) => x.id === effId)
    if (m?.reasoning) label += ' · ' + (effort?.name || effId || 'Default')
    return label
  }
  const modeName = (): string => {
    const s = store.sel.value
    const found = s.modeOptions.find((m) => m.id === s.currentMode)
    return found?.name || MODE_NAMES[s.currentMode] || s.currentMode
  }

  // 输入触发器菜单："/" 斜杠 与 "@" 引用各自独立成模块(core/trigger/*.ts)；加新触发只需在数组追加一项
  const trigger = useTriggerMenu([slashTrigger(store), atTrigger(store)], store, taRef)

  // 参数阶段占位 hint：输入恰为「/命令 」时，在光标后以灰色显示该命令 input.hint（如 <text>）
  const slashHint = ((): string => {
    const v = text
    if (!v || v.includes('\n')) return ''
    if (!/^\/\S+[\t 　]+$/.test(v)) return ''
    const name = v.slice(1).trim().split(/[\s　]+/)[0].toLowerCase()
    const c = store.slashCatalog.value?.commands.find((cc) => cc.name.toLowerCase() === name)
    return c?.input?.hint ?? ''
  })()
  const [ghostX, setGhostX] = useState(0)
  const [ghostY, setGhostY] = useState(0)
  useEffect(() => {
    const el = taRef.current
    if (!slashHint || !el) {
      setGhostX(0)
      setGhostY(0)
      return
    }
    const cs = getComputedStyle(el)
    const probe = document.createElement('span')
    probe.style.cssText =
      `position:absolute;visibility:hidden;white-space:pre;pointer-events:none;` +
      `font-family:${cs.fontFamily};font-size:${cs.fontSize};line-height:${cs.lineHeight};`
    probe.textContent = el.value
    document.body.appendChild(probe)
    const w = probe.getBoundingClientRect().width
    probe.remove()
    const box = el.closest('#inputbox')
    const er = el.getBoundingClientRect()
    const br = box?.getBoundingClientRect()
    setGhostX((br ? er.left - br.left : 0) + parseFloat(cs.paddingLeft) + w)
    setGhostY((br ? er.top - br.top : 0) + parseFloat(cs.paddingTop))
  }, [slashHint, text])

  // 已 claim 的斜杠命令行（/命令 参数…，首词命中带 hint 的 host 命令）：普通 Enter 直接执行（对齐上游）
  const argCommand = ((): string | null => {
    const v = text
    if (!v || v.includes('\n') || !v.startsWith('/')) return null
    const t = v.trimEnd()
    const name = t.slice(1).split(/[\s　]+/)[0]?.toLowerCase()
    if (!name || !/\s/.test(t.slice(1))) return null // 至少 token+空格才算进入参数
    const c = store.slashCatalog.value?.commands.find((cc) => cc.name.toLowerCase() === name)
    return c?.input?.hint ? t : null
  })()
  // 已认领的技能行(/技能 参数…)：Enter = 作为技能正常发送（chatSend，宿主 pre-step 识别 /技能名）
  const skillClaim = ((): string | null => {
    const v = text
    if (!v || v.includes('\n') || !v.startsWith('/')) return null
    const t = v.trimEnd()
    const name = t.slice(1).split(/[\s　]+/)[0]?.toLowerCase()
    if (!name || !/\s/.test(t.slice(1))) return null
    return store.slashCatalog.value?.skills.some((sk) => sk.name.toLowerCase() === name) ? t : null
  })()
  /**
   * 输入框键位：判定全在 `core/inputKeys`（纯函数、脚本可覆盖），这里只按结果派发。
   * 顺序要紧：先让触发菜单/弹层吃事件（`defaultPrevented` 就收手），再做输入框自己的判定。
   */
  const inputKeyDown = (e: KeyboardEvent): void => {
    trigger.onKeyDown(e)
    if (e.defaultPrevented) return
    onBackspace(e)
    if (e.defaultPrevented) return
    const decided = decideInputKey(e, {
      text,
      menuOpen: trigger.open,
      claim: argCommand !== null ? 'command' : skillClaim !== null ? 'skill' : null,
      running: store.turnRunning.value,
      queued: store.queueItems.value.some((i) => i.placement === 'queued'),
    })
    switch (decided.action) {
      case 'none':
      case 'newline':
        // `newline` 什么都不做 = 交给 textarea 原生换行；`none`（如空草稿下的发送键）也不拦
        return
      case 'menu-pick':
        // 交给触发菜单自己处理（它已经处理过一轮；这里只保证不被当成发送）
        return
      case 'run-command':
        e.preventDefault()
        store.text.value = '' // 回车执行 host 指令：无条件清空输入
        store.runSlash(argCommand as string)
        return
      case 'send':
        e.preventDefault()
        store.send(decided.mode)
        return
      case 'steer-whole-queue':
        e.preventDefault()
        store.steerWholeQueue()
        return
    }
  }

  /** 退格：贴片在文字之前 —— 光标在最左（前面没有字符）时删除最靠右（离文字最近）的贴片。 */
  const onBackspace = (e: KeyboardEvent): void => {
    if (e.key !== 'Backspace') return
    const ta = taRef.current
    const refs = store.refs.value
    if (ta && refs.length > 0 && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      e.preventDefault()
      store.removeRef(refs[refs.length - 1].key)
    }
  }

  const canSend =
    text.trim().length > 0 ||
    store.attachments.value.length > 0 ||
    store.images.value.length > 0 ||
    store.refs.value.length > 0
  const plan = store.planState.value
  return html`<div id="composer" class=${busy ? 'is-busy' : ''}
    onDragOver=${(e: Event) => e.preventDefault()}
    onDrop=${(e: DragEvent) => {
      e.preventDefault()
      const dt = e.dataTransfer
      if (!dt) return
      for (const f of Array.from(dt.files ?? [])) {
        if (f.type && f.type.startsWith('image/')) store.readImageFile(f)
      }
      const uri = dt.getData('text/uri-list')
      if (uri) {
        // 一次可拖多个（uri-list 逐行一个 URI）；路径解析走 fileUriToPath
        // （`file:///C:/…` 直接 slice(7) 会得到 `/C:/…`，多一个前导斜杠 → 宿主读文件会 ENOENT）
        for (const line of uri.split(/\r?\n/)) {
          const path = fileUriToPath(line)
          if (path !== undefined) store.addAttachment(path)
        }
      }
    }}>
    <${Popup} store=${store} />
    ${trigger.popup}
    ${busy
      ? html`<div class="composer-busy" aria-hidden="true">
          <span class="codicon codicon-loading codicon-modifier-spin"></span>
          ${busy === 'switching' ? '正在切换…' : '正在加载会话…'}
        </div>`
      : null}
    <${AttachmentBar} store=${store} />
    <${TodoCard} todos=${store.todos.value} />
    <${QueueCard} store=${store} />
    ${/* 目标条必须挂在 `#inputbox` **外面**（对齐上游 `conversation.input.dock`）：它是个带边框的
         flex 列容器，塞进去会掉到「输入框内底部」并把边框撑高。 */ ''}
    <${GoalBar} store=${store} />
    <div id="inputbox">
      ${store.refs.value.length > 0
        ? html`<div id="refRow" ref=${refRowRef}>${store.refs.value.map(
            (r) => html`<span class="ref-chip" key=${r.key} title=${r.token || r.detail || ''}>
              <span class="ficon codicon codicon-${r.kind === 'directory' ? 'folder-opened' : r.kind === 'session' ? 'comment-discussion' : 'file'}"></span>
              <span class="fname">${r.label}</span>
              <span class="x" onClick=${() => store.removeRef(r.key)}>✕</span>
            </span>`
          )}</div>`
        : null}
      <textarea id="input" ref=${taRef} placeholder=${text || store.refs.value.length > 0 ? '' : '向 AI 提问（Enter 发送，Shift+Enter 换行）'} value=${text}
        onInput=${(e: Event) => { store.text.value = (e.target as HTMLTextAreaElement).value; trigger.sync() }}
        onKeyDown=${inputKeyDown}
        onKeyUp=${trigger.sync}
        onSelect=${trigger.sync}
        onClick=${trigger.sync}
        onPaste=${(e: ClipboardEvent) => {
          const items = e.clipboardData?.items
          if (!items) return
          for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (file) {
                e.preventDefault()
                store.readImageFile(file)
              }
            }
          }
        }}></textarea>
      ${slashHint ? html`<span class="input-ghost" style=${{ left: ghostX + 'px', top: ghostY + 'px' }}>${slashHint}</span>` : null}
      <div id="inputbar">
        <button id="attach" title="添加文件/图片" onClick=${() => store.pickFile()}>＋</button>
        <div class="sel-group">
          <button id="permBtn" title=${permName() ? `权限：${permName()}` : '权限'} class=${store.openPopup.value === 'perm' ? 'active' : ''}
            onClick=${() => store.togglePopup('perm')}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>
          </button>
          <span id="permLabel" class="sel-label">${permName()}</span>
        </div>
        <div class="sel-group">
          <button id="modelBtn" title=${modelName() ? `模型：${modelName()}` : '模型与推理等级'} class=${store.openPopup.value === 'model' ? 'active' : ''}
            onClick=${() => store.togglePopup('model')}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>
          </button>
          <span id="modelLabel" class="sel-label">${modelName()}</span>
        </div>
        <div class="sel-group">
          <button id="modeBtn" title=${sel.modeLocked ? `${modeName()}（已固定）` : modeName()} class=${'mode' + (store.openPopup.value === 'mode' ? ' active' : '') + (sel.modeLocked ? ' readonly' : '')}
            onClick=${() => { if (!sel.modeLocked) store.togglePopup('mode') }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/></svg>
          </button>
          <span id="modeLabel" class="sel-label">${modeName()}</span>
        </div>
        <span class="send-group">
          <${ContextMeter} store=${store} />
          <button id="send" title=${sendLabel} class=${stops ? 'stop' : ''} disabled=${stops ? false : (!canSend || !!busy)}
            onClick=${() => (stops ? store.cancel() : store.send())}>
            <svg class="send-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 14V3"/><path d="M3.5 6.5 8 2l4.5 4.5"/></svg>
            <svg class="stop-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>
          </button>
        </span>
      </div>
      ${plan && (plan.active || plan.pending)
        ? html`<div id="chipRow">
            <button id="planChip" disabled=${plan.pending ? true : undefined}
              title=${plan.pending ? 'Plan 切换中…' : 'Plan 模式中，点击退出'}
              onClick=${() => store.runSlash('/plan off')}>plan${plan.pending ? '…' : ' ✕'}</button>
          </div>`
        : null}
    </div>
  </div>`
}

// ---------------- 弹窗 / 标题栏 静态壳(命令式子树) ----------------
function ModalShell() {
  return html`<div id="dshModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="dshModalTitle">
    <div class="modal-card">
      <div class="modal-head">
        <span id="dshModalIcon" class="modal-icon modal-icon--info" aria-hidden="true"></span>
        <div><div id="dshModalTitle" class="modal-title"></div><div id="dshModalSub" class="modal-sub"></div></div>
      </div>
      <div id="dshModalCode" class="modal-code hidden"></div>
      <div id="dshModalBody" class="modal-body"></div>
      <label id="dshModalAck" class="modal-ack hidden"><input id="dshModalAckCheck" type="checkbox" /><span id="dshModalAckText"></span></label>
      <div class="modal-actions">
        <button id="dshModalCancel" class="btn btn-ghost" type="button">Cancel</button>
        <button id="dshModalOk" class="btn btn-primary" type="button"></button>
      </div>
    </div>
  </div>`
}

function TitlebarShell() {
  return html`<div id="titlebar">
    <button id="titleWs" title="工作区"><span class="codicon codicon-chevron-right title-ws-caret"></span><span id="titleWsName"></span></button>
    <div class="title-spacer"></div>
    <div id="titleWorkWrap">
      <button class="title-btn" id="titleWorkBtn" title="工作区"><span class="codicon codicon-folder"></span></button>
      <div id="titleWsDropdown" class="hidden"><input id="wsSearch" type="text" placeholder="搜索工作区/会话" autocomplete="off" spellcheck="false" /><div id="wsRows"></div></div>
    </div>
    <button class="title-btn" data-cmd="newSession" title="开启新会话"><span class="codicon codicon-add"></span></button>
    <button class="title-btn hidden" data-cmd="openInBrowser" title="在浏览器中打开"><span class="codicon codicon-globe"></span></button>
    <button class="title-btn" data-cmd="openInEditor" title="在本地打开"><span class="codicon codicon-desktop-download"></span></button>
    <button class="title-btn hidden" data-cmd="reload" title="刷新 dsh 页面"><span class="codicon codicon-refresh"></span></button>
    <button class="title-btn hidden" data-cmd="closeSidebar" title="关闭侧边栏"><span class="codicon codicon-eye"></span></button>
    <button class="title-btn" data-cmd="moveToEditor" title="移动到编辑器"><span class="codicon codicon-open-preview"></span></button>
    <div id="titleMoreWrap">
      <button class="title-btn" id="titleMoreBtn" title="更多"><span class="codicon codicon-ellipsis"></span></button>
      <div id="titleMorePopup" class="hidden"><button class="title-more-item" data-cmd="usage"><span class="codicon codicon-graph-line"></span>查看消费记录</button></div>
    </div>
  </div>`
}

// ---------------- ChatApp(不读信号 → 挂载后不重渲) ----------------
// 入口 chat.ts 已把 <ChatApp> 渲染进 index.html 的 #app,#app 自身只承担纵向 flex 布局;
// ChatApp 不应再自包一层 id="app"(会与挂载点重复 → 嵌套双 #app)。直接返回各列块子树,
// 由挂载点 #app 统一排布(标题栏 / 消息区 / 输入区 / 状态栏)。
function ChatApp({ store }: { store: ChatStore }) {
  return html`${TitlebarShell()}
    <${Welcome} store=${store} />
    <${MessageList} store=${store} />
    <${QuestionDialog} key=${store.pendingQuestion.value?.rpcId ?? 'none'} store=${store} />
    <${FeedbackDialog} store=${store} />
    <${FeedbackToast} store=${store} />
    <${Composer} store=${store} />
    <${StatsCards} store=${store} />
    ${ModalShell()}`
}

export { ChatApp }
export type { ImageAttachment }
