// 回合尾部：本轮文件改动（从写盘调用推导）+ 交付文件（模型声明）。
//
// 位置与上游一致：**回答正文之后、动作条之前**（动作条是回合尾部的下半段，不是正文的一部分）。
// 点任意一项都在**编辑器区**打开（上游把这类路径交给宿主默认程序；本插件聊天区就在 VS Code 里，
// 编辑器打开才顺手，见 extension 侧 openFile 的同一处说明）。
import { html } from 'htm/preact'
import { useMemo, useState } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { baseName, extensionLabel, producedPaths } from '../../core/deliverables'

type AssistantRow = Extract<ChatRow, { kind: 'assistant' }>

/** 交付文件超过这个数先折叠（上游同值） */
const COLLAPSED_PRESENTED_COUNT = 4
/** 本轮文件改动最多平铺几个（上游同值）；多出来的只报数，不再铺开 */
const PRODUCED_SHOWN_LIMIT = 6

/** 卡片状态行：模型说明优先（去掉结尾的括号后缀），否则扩展名，再否则「文件」。 */
function cardNote(description: string | undefined, path: string): string {
  const text = description?.replace(/\s*[（(][^（()）]*[)）]\s*$/, '').trim()
  return text !== undefined && text !== '' ? text : extensionLabel(path) || '文件'
}

export function Deliverables({ row, store }: { row: AssistantRow; store: ChatStore }) {
  // 折叠态属于**这一条回答**（换行即重置），故用组件内状态
  const [expanded, setExpanded] = useState(false)
  // 链不变就不必重算：写盘调用的参数解析要走一遍 JSON.parse
  const produced = useMemo(() => producedPaths(row.chain), [row.chain])
  const presented = row.presentedFiles ?? []
  /**
   * **只有回合（这一段）收官后才出**。
   *
   * 上游这一块挂在 `conversation.chat.turnTail` 槽、由 `TurnTailNodeView` 渲染，
   * 取值还要过 `producedForClosing(…, closingSeq)` —— `closingSeq` 是**收官那条** assistant 的序号，
   * 它之后的结算一律不算。也就是说：**它是回合尾部的报告，不是过程里的进度条**。
   *
   * 本插件的行是流式期间一路重折的，`row.chain` 里的写盘调用一落链就会被看见 ——
   * 少了这道门，模型还在跑的时候「本轮文件改动」就已经列出来、还随每个写盘调用往上长
   *（真机现象：会话没结束就出现「本轮文件改动」，网页端那时候还没有）。
   * 被插话切开的前段：那一段收束时 `done` 也会置真，于是我们与上游一样**逐段**出。
   */
  if (!row.done) return null
  // 上游：**只有开启「代码工作工具」才展示这一区**（关闭时立即隐藏；显式交付卡片与行内文件链接不受影响）。
  // 判据写成「只有显式 false 才隐藏」：上游该项**默认开**，读不到/未装该字段都按开启处理。
  if (store.developerTools?.value === false) return null
  if (produced.length === 0 && presented.length === 0) return null
  const cwd = store.sessionCwd.value
  const open = (p: string): void => store.openFile(p, undefined, cwd)
  const shownProduced = produced.slice(0, PRODUCED_SHOWN_LIMIT)
  const hiddenProduced = produced.length - shownProduced.length
  const shownPresented = expanded ? presented : presented.slice(0, COLLAPSED_PRESENTED_COUNT)
  return html`<div class="turn-deliverables">
    ${produced.length > 0
      ? html`<div class="dv-produced">
          <span class="dv-label">本轮文件改动</span>
          <div class="dv-chips">
            ${shownProduced.map((p) => html`<button type="button" key=${p} class="dv-chip" title=${p}
              onClick=${() => open(p)}><span class="codicon codicon-file dv-chip-ico"></span>${baseName(p)}</button>`)}
            ${hiddenProduced > 0
              ? html`<span class="dv-more">${hiddenProduced === 1 ? '+ 1 个文件' : `+ ${hiddenProduced} 个文件`}</span>`
              : null}
          </div>
        </div>`
      : null}
    ${presented.length > 0
      ? html`<div class="dv-presented">
          <div class="dv-cards">
            ${shownPresented.map((f) => html`<button type="button" key=${f.path} class="dv-card" title=${f.path}
              onClick=${() => open(f.path)}>
              <span class="codicon codicon-file dv-card-ico"></span>
              <span class="dv-card-text">
                <span class="dv-card-name">${baseName(f.path)}</span>
                <span class="dv-card-note">${cardNote(f.description, f.path)}</span>
              </span>
            </button>`)}
          </div>
          ${presented.length > COLLAPSED_PRESENTED_COUNT
            ? html`<button type="button" class="dv-toggle" aria-expanded=${expanded}
                onClick=${() => setExpanded((v) => !v)}>
                <span class=${'codicon ' + (expanded ? 'codicon-chevron-up' : 'codicon-chevron-down')}></span>
                ${expanded ? '收起' : `全部 ${presented.length} 个文件`}
              </button>`
            : null}
        </div>`
      : null}
  </div>`
}
