// 回合尾部：本轮文件改动（Host 的改动摘要）+ 交付文件（模型声明）。
//
// 位置与上游一致：**回答正文之后、动作条之前**（动作条是回合尾部的下半段，不是正文的一部分）。
// 点任意一项都在**编辑器区**打开（上游把这类路径交给宿主默认程序；本插件聊天区就在 VS Code 里，
// 编辑器打开才顺手，见 extension 侧 openFile 的同一处说明）。
//
// **改动卡的存在性由 Host 决定**（2026-10-05 修正）：上游 `ChangedFiles` 的数据来自 Host 内存态的
// 改动摘要（`GET /api/changes.summary`；数据在宿主，页面只渲染），
// 而 Host 的契约是「**该会话被释放或本进程从没记过就没有**」——所以**摘要取不到就不出这张卡**
//（Host 重启后打开历史会话，网页端也没有这张卡）。插件早先从 `write`/`edit` 调用**重建**清单，
// 于是历史会话凭空多出一张上游没有的卡（2026-10-04 真机截图）；现改为**宿主取回 + 原样渲染**。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import type { DshChangesSummary } from '../../../../src/dsh/rows/types'
import { baseName, extensionLabel } from '../../core/deliverables'

type AssistantRow = Extract<ChatRow, { kind: 'assistant' }>

/** 交付文件超过这个数先折叠（上游同值） */
const COLLAPSED_PRESENTED_COUNT = 4
/** **本轮文件改动**列表超过这个行数先折叠（上游 `COLLAPSED_ROWS` 同值） */
const COLLAPSED_ROWS = 4

/** 卡片状态行：模型说明优先（去掉结尾的括号后缀），否则扩展名，再否则「文件」。 */
function cardNote(description: string | undefined, path: string): string {
  const text = description?.replace(/\s*[（(][^（()）]*[)）]\s*$/, '').trim()
  return text !== undefined && text !== '' ? text : extensionLabel(path) || '文件'
}

export function Deliverables({ row, store }: { row: AssistantRow; store: ChatStore }) {
  // 折叠态属于**这一条回答**（换行即重置），故用组件内状态。
  // 两块**各自一份**：改动列表与交付卡片的行数不同、用户会分别开合，共用一个状态会互相带开。
  const [changesExpanded, setChangesExpanded] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const presented = row.presentedFiles ?? []
  /**
   * **只有回合（这一段）收官后才出**。
   *
   * 上游这一块挂在 `conversation.chat.turnTail` 槽、由 `TurnTailNodeView` 渲染，
   * 取值还要过 `presentedForClosing` / 摘要读取 —— 也就是说：**它是回合尾部的报告，不是过程里的进度条**。
   * 本插件的行是流式期间一路重折的，写盘调用一落链就会被看见 —— 少了这道门，模型还在跑的时候
   * 「本轮文件改动」就已经列出来、还随每个写盘调用往上长。被插话切开的前段：那一段收束时 `done`
   * 也会置真，于是我们与上游一样**逐段**出。
   */
  if (!row.done) return null
  /**
   * 上游 `Deliverables`：**改动卡**受「代码工作工具」（`showCodeDiff`）管，**交付卡片不受它影响**。
   * 改动卡的另一个门是**Host 得拿得出那份摘要**（`row.changesSummary` 缺省 = 拿不到）——
   * 判据写成「只有显式 false 才隐藏」：该项上游**默认开**，读不到/未装该字段都按开启处理。
   */
  const fetched: DshChangesSummary | undefined = store.developerTools?.value === false ? undefined : row.changesSummary
  // 摘要里一个文件都没有 → 同样不出卡（上游 `summary.files.length > 0` 是那张卡的存在条件之一）
  const summary = fetched !== undefined && fetched.files.length > 0 ? fetched : undefined
  if (summary === undefined && presented.length === 0) return null
  const cwd = store.sessionCwd.value
  const open = (p: string): void => store.openFile(p, undefined, cwd)
  /**
   * **本轮文件改动**（上游 `ChangedFiles` 的形态）：
   * 标题 = `已编辑 {total} 个文件`（**恰好一个文件时**是 `已编辑 {name}`），下面**竖排**行
   * （`display` 相对路径 + 右侧 `+x/-y` 行数，二进制/超大给固定词），超过 `COLLAPSED_ROWS` 行折叠成
   * `全部 {n} 个文件`。计数与文件清单**一律取 Host 的摘要**，不自己数（数出来就会与卡上的标题打架）。
   *
   * ⚠️ **恰好一个文件时，那一格本身必须是可点的**（真机 2026-10-07：维护者问「只有一个已编辑文件时
   * 插件无法在编辑区打开吗」）。上游那一支把**表头本身**渲染成 `<button onClick={() => openReview(0)}>`
   *（图标 + `已编辑 {name}` + 增删计数），点它打开这一处改动的**评审视图**；插件没有那个评审面，
   * 等价动作就是**在编辑区打开这个文件**（与多文件时每一行的动作一致）。此前插件这一格是纯 `<span>`，
   * 点了没有任何反应 —— 单文件时整张卡**一个可点的东西都没有**。
   */
  const files = summary?.files ?? []
  const changesFoldable = files.length > COLLAPSED_ROWS
  const shownFiles = changesFoldable && !changesExpanded ? files.slice(0, COLLAPSED_ROWS) : files
  const single = summary !== undefined && summary.total === 1 ? files[0] : undefined
  const shownPresented = expanded ? presented : presented.slice(0, COLLAPSED_PRESENTED_COUNT)
  return html`<div class="turn-deliverables">
    ${summary !== undefined
      ? html`<div class="dv-produced">
          ${single === undefined
            ? html`<div class="dv-changes-head">
                <span class="dv-changes-title">已编辑 ${String(summary.total)} 个文件</span>
              </div>`
            : html`<button type="button" class="dv-changes-head dv-changes-head-open" title=${single.display}
                onClick=${() => open(single.path)}>
                <span class="dv-changes-title">已编辑 ${baseName(single.path)}</span>
                <span class="dv-changes-counts">
                  ${single.binary === true
                    ? html`<span class="dv-changes-kind">二进制</span>`
                    : single.oversized === true
                      ? html`<span class="dv-changes-kind">过大</span>`
                      : html`<span class="dv-added">+${String(single.added)}</span><span class="dv-deleted">-${String(single.deleted)}</span>`}
                </span>
              </button>`}
          ${single === undefined
            ? html`<ul class="dv-changes-list">
                ${shownFiles.map((f) => html`<li key=${f.path}>
                  <button type="button" class="dv-changes-row" title=${f.display} onClick=${() => open(f.path)}>
                    <span class="dv-changes-path">${f.display}</span>
                    <span class="dv-changes-counts">
                      ${f.binary === true
                        ? html`<span class="dv-changes-kind">二进制</span>`
                        : f.oversized === true
                          ? html`<span class="dv-changes-kind">过大</span>`
                          : html`<span class="dv-added">+${String(f.added)}</span><span class="dv-deleted">-${String(f.deleted)}</span>`}
                    </span>
                  </button>
                </li>`)}
              </ul>`
            : null}
          ${changesFoldable
            ? html`<button type="button" class="dv-changes-toggle" aria-expanded=${changesExpanded}
                onClick=${() => setChangesExpanded((v) => !v)}>
                <span class="dv-changes-toggle-text">${changesExpanded ? '收起' : `全部 ${String(files.length)} 个文件`}</span>
                <span class=${'codicon ' + (changesExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down') + ' dv-changes-toggle-chev'} aria-hidden="true"></span>
              </button>`
            : null}
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
                ${expanded ? '收起' : `全部 ${String(presented.length)} 个文件`}
              </button>`
            : null}
        </div>`
      : null}
  </div>`
}
