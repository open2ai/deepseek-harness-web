// 工具行（ToolRow，纯分发器）：收起 = 一行(图标 + 标题 + 摘要 + 状态)，展开按卡体分派。
// 分派顺序照上游 ToolRow 的瀑布（先到先得，一个调用只渲染一张卡）：
//   交付文件行 → 提问卡 → 终端卡 → 差异卡 → 图片卡 → 读文件卡 → 搜索卡 → web 卡 → 通用「输入/输出」卡（兜底）
// 交付文件（`present`）是**专属行**：自带头部与展开体，不走上面的通用头（见 PresentRow）。
// 提问卡只在取到问答记录时接管；取不到（进行中/配对不上/结果坏形）同样落到通用卡（上游同口径）。
// 各卡体独立文件，改一种不影响其它。
// 铁律：文案/结构与上游一致，不自行翻译、不编造展示。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { DshTurnProcessItem, ChatStore } from '../../core/store/chat'
import { toolTitle, toolIconOfTool, resultFirstLine } from '../../core/format'
import { toolGlyphOf } from './ToolIcons'
import { toolStateLabel, ToolState } from '../../core/states'
import { filePathOf, terminalCardModel, relativizeToCwd } from '../../core/terminal'
import { webCardModel } from '../../core/web-card'
import { askCardModel } from '../../core/ask-card'
import { diffCardModel } from '../../core/diff-card'
import { readCardModel } from '../../core/read-card'
import { searchCardModel } from '../../core/search-card'
import { imageCardModel } from '../../core/image-card'
import { detailsCardModel } from '../../core/details-card'
import { todoDiffModel } from '../../core/todo-diff'
import { WebCard } from './WebCard'
import { PresentRow } from './PresentRow'
import { AskCardBody } from './AskCardBody'
import { ImageCard } from './ImageCard'
import { TerminalBlock } from './TerminalBlock'
import { DiffCard } from './DiffCard'
import { ReadCard } from './ReadCard'
import { SearchCard } from './SearchCard'
import { DetailsCardBody } from './DetailsCardBody'

type Tool = Extract<DshTurnProcessItem, { kind: 'tool' }>

export function ToolRow({ item, store }: { item: Tool; store: ChatStore }) {
  const [open, setOpen] = useState(false)
  const cwd = store.sessionCwd.value
  // **准备中**（上游 `phase: 'preparing'`）：参数还没到 → 这条行**不可展开**、按运行中的样子画
  //（进行感照旧由掠光带承担）。准备阶段没有任何卡数据，所以卡模型一律按"运行中且无参数"求解；
  // 一旦工具真被调用（`tool/call` 到达）宿主会把它原地升级成 `running`，这里自然恢复正常。
  const preparing = item.status === 'preparing'
  /** 喂给卡模型的形状：准备中一律按「运行中且无参数」求解（准备阶段没有任何卡数据）。 */
  type CardInput = Parameters<typeof terminalCardModel>[0]
  const cards = (preparing ? { ...item, status: ToolState.Running } : item) as CardInput
  // 六个卡模型都求值，按上游瀑布取第一个命中的（各自形状不符即 null，自然落到下一张）
  const ask = askCardModel(cards)
  const terminal = terminalCardModel(cards, cwd)
  const diff = diffCardModel(cards)
  const read = readCardModel(cards, cwd)
  const image = imageCardModel(cards, cwd)
  const search = searchCardModel(cards)
  const web = webCardModel(cards)
  // 详情卡（goal / schedule / 子代理协调类）与 todo 卡（todo_write）只在**专属工具**上命中；
  // 形状不符一律 null，自然落到下面的通用卡。两者只认 `item`（含 todoBaseline），不走 `cards`。
  const details = detailsCardModel(item)
  // 可缺省读取（与 `MessageList` 读 `sessionOpenError` 同一口径）：部分守卫/旧桩的 store 里没有这个切片
  const todoDiff = todoDiffModel(item, store.historyHasMore?.value === true)

  // 行状态三级（**单一来源**：卡内状态点与文案取的就是这个 rowState，行与卡不可能打架）：
  //   1) 提问卡可覆盖（ASK_CANCELLED→ok / ASK_ABORTED→stopped，见 ask-card）
  //   2) 终端卡：覆盖已在 model 里算完——非零退出/被信号终止的调用本身 isError:false
  //      （退出状态是结果数据，不是调用失败），由 `terminal.state` 按上游 `terminalFailed` 口径标成 error，
  //      与调用真失败（isError）同序；行不再自己判一次
  //   3) 其余用宿主判好的 item.status（由 isError + code 特例判出，见 src/dsh/official/tool-status.ts）
  const rowState = ask?.state ?? terminal?.state ?? item.status
  const running = rowState === 'running' || preparing
  // ① leading 二选一（上游 leadingFor）：error→红点、stopped→琥珀点；**其余（含 running）显变体图标**。
  // 行尾不再有状态角标——上游整行只有这一个标记位；running 的进行感由行上的掠光带（②）承担。
  const dotState = rowState === 'error' ? 'error' : rowState === 'stopped' ? 'warning' : null
  // ③ 状态点与掠光都是 colour-only 且 aria-hidden，读屏靠这段视觉隐藏文字播报
  //（**准备中**按运行中播报：上游那阶段没有独立状态词）
  const stateLabel = toolStateLabel(rowState === 'preparing' ? ToolState.Running : rowState)

  // 收起行预览，优先级照上游 `summaryText = failureLine ?? description ?? summary`：
  //   真失败行（⑤）→ 结果文本首行；其余 → item.summary（终端卡回落 description）
  // ⑤ **只认宿主判出的 `item.status === 'error'`（= isError）**，与上游 `model.state === 'error'` 同口径：
  //   非零退出/被信号终止的 shell 调用 `isError: false`（退出状态是结果数据，不是调用失败），
  //   它的失败只由上面 rowState 的展示层覆盖表达（行首红点 + 卡内退出码 Pill），**摘要位仍是描述**——上游亦然。
  // 首行为空行（`''`）时不落回描述、摘要位整体不显示——与上游 `'' ?? …` 的短路结果一致。
  // 提问行除外：上游 `AskQuestionRow` **不传** `errorSummary`（只传 summary/output/state），
  // 所以提问行永远不会被换成结果首行。
  const failureLine = ask === null && item.status === 'error' ? resultFirstLine(item.output) : null
  // 摘要位后半段（上游 `summaryText = failureLine ?? description ?? summary`）：
  //   文件类工具的摘要是路径 → **相对工作区根**（上游 `abbreviateHomePath(relativizeToCwd(...), home)`；
  //   home 缩写只对 POSIX 家目录生效，Windows 上本插件与上游同样是空操作）。
  //   非路径摘要经 relativizeToCwd 原样返回，不受影响。
  //   **不做 basename**：工作区外的文件仍显示全路径（与上游一致）；卡片内部路径同样按上游
  //   （读卡相对化 / 差异卡 verbatim / 搜索卡原样），见 docs/design/09 §4。
  const genericSummary = relativizeToCwd(item.summary ?? terminal?.description ?? '', cwd)
  // 提问行摘要照上游 `presentation?.summary ?? answeredSummary() ?? model.summary`：前两级在 ask-card 算出
  // （等待回答 / n 分之 m 已回答 / 已取消 / 已中断），算不出来时（结果坏形、未知错误码）**回落到通用摘要**
  // （`工具名 · 参数首行`）—— 上游此处即取 model.summary，不把摘要位留空。
  const fallbackSummary = ask !== null && ask.summary !== '' ? ask.summary : genericSummary
  // 详情卡的收起行摘要（上游 `summary = details.summary ?? items[0].title ?? empty ?? model.summary`）：
  // 结构化摘要（如「3 个智能体」/ 目标 objective）优先于通用摘要。
  const detailsSummary = details !== null ? (details.summary ?? details.items[0]?.title ?? details.empty) : undefined
  const baseSummary = failureLine !== null
    ? failureLine || undefined
    : (detailsSummary !== undefined && detailsSummary !== '' ? detailsSummary : fallbackSummary || undefined)
  // todo 卡的 diff 摘要（「新增 X · 更新 Y」）跟在「x/y 已完成」之后 —— 上游 `summarySuffix` 的位置。
  // 无法对比（旧清单不可用）时 todoDiff.summary 为 null，不缀。
  const todoDiffSuffix = todoDiff?.summary ?? ''
  const headSummary = todoDiffSuffix !== '' && baseSummary !== undefined ? `${baseSummary} · ${todoDiffSuffix}` : baseSummary
  // 收起行摘要里的文件路径可点击打开（对齐上游 ToolRow 的 filePath/onOpenFile）：
  //   - 只对文件类变体（read/write/edit，含 read_image）有值，取参数里的 path/file_path；
  //   - **失败行不挂**（失败行的摘要位是结果首行，不是路径）；
  //   - 读族带 `meta.offset` 时跳到该行（上游 filePathLine 同口径）。
  const openPath = failureLine === null ? filePathOf(item.name, item.argsRaw) : undefined
  const openLineRaw = (item.meta as { offset?: unknown } | undefined)?.offset
  const openLine = typeof openLineRaw === 'number' && Number.isInteger(openLineRaw) && openLineRaw > 0 ? openLineRaw : undefined
  // 摘要位的**色调跟着行状态走**（上游 ToolRow：`state === 'error' && css.errorSummary`、
  // `state === 'stopped' && css.stoppedSummary`）—— 判据是**行状态**，不是"摘要文字是不是结果首行"。
  // ⚠️ **非零退出 / 被信号终止的 shell 也要着错误色**：那种调用本身 `isError: false`（退出状态是结果数据），
  // 上面 `rowState` 已按终端卡口径覆盖成 `error` —— 文字必须一起变红（真机反馈：「插件运行命令有红色点，
  // 后面的文字怎么没标红色呢，上游的都是红色的」）。文字本身仍走 `failureLine ?? description ?? summary`
  // 那条链：只有真失败（isError）才把摘要换成结果首行，非零退出仍是模型写的那句描述。
  const summaryTone = rowState === 'error' ? 'error' : rowState === 'stopped' ? 'stopped' : null
  // 行首图标二选一：这一族有**上游图形**就用它（内联 SVG，见 `ToolIcons.ts`），其余仍走 codicon 近似
  const glyph = toolGlyphOf(item.name)

  // 展开体的门：**准备中的行不给展开**（上游 README：准备中节点渲染成一条不可展开的行）
  const head = html`<${preparing ? 'div' : 'button'} class="chain-row-head" data-state=${preparing ? 'running' : rowState}
    data-preparing=${preparing ? 'true' : undefined}
    onClick=${preparing ? undefined : () => setOpen((o) => !o)}
    aria-expanded=${preparing ? undefined : open} title=${item.name}>
    ${stateLabel ? html`<span class="chain-row-state">${stateLabel}</span>` : null}
    ${preparing ? null : html`<span class=${'codicon chain-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>`}
    ${dotState !== null
      ? html`<span class=${'chain-tool-dot is-' + dotState} data-state=${dotState} aria-hidden></span>`
      : glyph !== undefined
        ? html`<span class="chain-tool-ico is-upstream" aria-hidden>${glyph}</span>`
        : html`<span class="chain-tool-ico codicon codicon-${toolIconOfTool(item.name)}"></span>`}
    <span class="chain-tool-title">${item.title ?? toolTitle(item.name)}</span>
    ${!open && headSummary
      ? html`<span class="chain-sep" aria-hidden></span>${openPath !== undefined
          ? html`<button type="button" class="chain-row-preview chain-file-link" title=${openPath}
              onClick=${(e: Event) => {
                e.stopPropagation()
                store.openFile(openPath, openLine, cwd)
              }}>${headSummary}</button>`
          : html`<span class=${'chain-row-preview' + (summaryTone === 'error' ? ' is-error' : summaryTone === 'stopped' ? ' is-stopped' : '')}>${headSummary}</span>`}`
      : null}
  </${preparing ? 'div' : 'button'}>`

  /** 收起头 + 展开体（各卡体共用同一层 disclosure 外壳）。准备中的行没有展开体。 */
  const wrap = (body: unknown): unknown =>
    html`<div class=${'chain-disclosure' + (running ? ' is-running' : '')}>
      ${head}
      ${open && !preparing && body !== null ? html`<div class="chain-disclosure-body">${body}</div>` : null}
    </div>`

  /**
   * 通用「输入/输出」区（ioCard）：非专属卡的工具走它；提问卡没有问答记录时也落回它。
   * 写成**函数**是刻意的：终端/差异/读文件/搜索/web 各有专属卡，若在分派前先算好，等于
   * 给它们每次都白解析一遍参数 JSON（大 diff 的参数可以很大）。
   */
  const ioBody = (): unknown => {
    let bodyText = item.argsRaw ?? ''
    if (bodyText) {
      try {
        bodyText = JSON.stringify(JSON.parse(bodyText), null, 2)
      } catch {
        /* 原样 */
      }
    }
    const outputText = item.output ?? ''
    return bodyText !== '' || outputText !== ''
      ? html`<div class="chain-io-card">
          ${bodyText !== ''
            ? html`<div class="chain-io-section">
                <span class="chain-io-label">输入</span>
                <span class="chain-io-text">${bodyText}</span>
              </div>`
            : null}
          ${bodyText !== '' && outputText !== '' ? html`<span class="chain-io-divider" aria-hidden></span>` : null}
          ${outputText !== ''
            ? html`<div class="chain-io-section">
                <span class="chain-io-label">输出</span>
                <span class=${'chain-io-text' + (rowState === 'error' ? ' is-error' : '')}>${outputText}</span>
              </div>`
            : null}
        </div>`
      : null
  }

  // ---- 交付文件（`present`）----
  // 专属行：四态标记 + 可见状态词 + 声明路径，展开体只有结果正文。**先于通用头返回**（自带头部）。
  if (item.name === 'present') return html`<${PresentRow} item=${item} />`

  // ---- 提问卡（ask_user_question）：只做问答记录；交互在 composer 上方 waterfall 弹窗 ----
  // **有问答记录才出提问卡**；无记录（运行中 / 问答配对不上 / 结果坏形）落回通用「输入/输出」区。
  // **只影响 ask 行**：其余卡的分派与渲染一字未动。
  if (ask !== null) {
    // 补答入口也算「有内容」：即使问答记录取不到（问题清单坏形），只要该条仍可补答也要出卡片
    const lateAnswerable = ask.lateCallId !== undefined && store.canAnswerLate(ask.lateCallId)
    return wrap(
      ask.transcript === null && !lateAnswerable ? ioBody() : html`<${AskCardBody} card=${ask} store=${store} />`
    )
  }

  // ---- 终端卡（bash / pwsh / shell）----
  if (terminal !== null) return wrap(html`<${TerminalBlock} card=${terminal} store=${store} />`)

  // ---- 差异卡（write / edit：文件改动）----
  if (diff !== null) return wrap(html`<${DiffCard} card=${diff} store=${store} />`)

  // ---- 图片卡（read_image：结果里带图片附件引用）----
  // 卡只在「已结算成功 + 工具是 read_image + 内容全由 text/image 构成 + 有信封文本」时出（见 core/image-card）
  if (image !== null) return wrap(html`<${ImageCard} card=${image} store=${store} />`)

  // ---- 读文件卡（read：带行号的文件内容）----
  if (read !== null) return wrap(html`<${ReadCard} card=${read} store=${store} />`)

  // ---- 搜索卡（grep / glob）----
  if (search !== null) return wrap(html`<${SearchCard} card=${search} store=${store} />`)

  // ---- web 卡（web_fetch / web_search）----
  if (web !== null) return wrap(html`<${WebCard} card=${web} />`)

  // ---- todo 卡（todo_write：与上次清单的 diff）----
  if (todoDiff !== null) return wrap(html`<${DetailsCardBody} model=${todoDiff.details} store=${store} />`)

  // ---- 详情卡（goal / schedule / 子代理协调类）----
  if (details !== null) return wrap(html`<${DetailsCardBody} model=${details} store=${store} />`)

  // ---- 通用兜底：其余工具都用上面的 ioBody（「输入」调用参数 pretty JSON + 「输出」调用结果）----
  return wrap(ioBody())
}

// 这里**不做组件层跳渲**（曾经试过 `memo`）：卡片会读若干**会话级信号**（`sessionCwd`、
// 「设置 → 通用设置 → 工作步骤展示」、反馈/用量…），而 `memo` 只比 props —— 跳渲会把信号变化也一起挡掉，
// 表现为「切设置后卡片不跟着变」。真要做，得先把这些信号以 props 显式喂进来（见 ReasoningRow）。
