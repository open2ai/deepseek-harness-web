// 工具行（ToolRow）：收起 = 一行(图标 + 标题 + 摘要 + 状态)，展开按卡体分派。
// 本文件只做两件事：① 算**通用事实**（状态、摘要、图标、退出码、通用头与展开体外壳）；
// ② 按 `TOOL_VIEWS` 的顺序逐项试，第一个返回非 null 的注册项接管这一行（注册表见 `tool-views.ts`）。
// 分派顺序、各卡的判据与卡体都在注册表/各自组件里 —— 加一张卡 = 加一个注册项 + 卡体组件，别在本文件加分支。
// 交付文件（`present`）是**专属行**：自带头部与展开体，不走通用头（见 PresentRow）。
// 铁律：文案/结构与上游一致，不自行翻译、不编造展示。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ComponentChild, VNode } from 'preact'
import type { ChatStore } from '../../core/store/chat'
import { toolTitle, toolIconOfTool, resultFirstLine, autoReviewDenialOf } from '../../core/format'
import { toolGlyphOf } from './ToolIcons'
import { toolStateLabel, ToolState } from '../../core/states'
import { exitBadgeLabel, filePathOf, recordedPathOf, relativizeToCwd, terminalCardModel } from '../../core/terminal'
import { askCardModel } from '../../core/ask-card'
import { skillCardModel } from '../../core/skill-card'
import { detailsCardModel } from '../../core/details-card'
import { todoDiffModel } from '../../core/todo-diff'
import { TOOL_VIEWS, type Tool, type ToolCardInput, type ToolRowState, type ToolViewCtx } from './tool-views'

export function ToolRow({ item, store }: { item: Tool; store: ChatStore }) {
  const [open, setOpen] = useState(false)
  const cwd = store.sessionCwd.value
  // **准备中**（上游 `phase: 'preparing'`）：参数还没到 → 这条行**不可展开**、按运行中的样子画
  //（进行感照旧由掠光带承担）。准备阶段没有任何卡数据，所以卡模型一律按"运行中且无参数"求解；
  // 一旦工具真被调用（`tool/call` 到达）宿主会把它原地升级成 `running`，这里自然恢复正常。
  const preparing = item.status === 'preparing'
  /** 喂给卡模型的形状：准备中一律按「运行中且无参数」求解（准备阶段没有任何卡数据）。 */
  const cards = (preparing ? { ...item, status: ToolState.Running } : item) as ToolCardInput
  // **Auto review 拒绝**：被拒的工具**根本没执行**，专属卡（终端/差异/读文件…）全是空壳。
  // 上游 `ToolCallTree` 遇到它就**绕过 keyed toolview 改走通用卡**，并把摘要与输出换成两句话。
  const autoReview = autoReviewDenialOf(item)
  // 提问卡的「还能不能补答」= 上游 `useProjection('userQuestions')` 的 `answerable`：
  // **必须在求卡模型之前拿到** —— 超时后的两支（`ask.pending` / `ask.closed`）就是靠它分的。
  // **可缺省读取**（与本文件既有约定、`MessageList` 读 `sessionOpenError` 同一口径）：
  // 部分守卫/旧桩的 store 里没有 `canAnswerLate` 这个切片 —— 直接调会 `TypeError` 把**整行渲染**打断
  //（真机不会，但 tmp/ 下十来个挂真 store/DOM 的守卫会整片崩）。缺切片按「不可补答」处理。
  const askAnswerable = item.callId !== undefined && (store.canAnswerLate?.(item.callId) ?? false)
  // **通用头**要用的五个卡模型：状态（提问/终端覆盖宿主判定）与摘要（技能/详情/todo 覆盖通用摘要）
  // 都取自它们，所以必须在分派前求出来；其余卡模型只服务自己的卡体，留在 `tool-views.ts` 里现算
  //（避免给每一行都白解析一遍参数 JSON —— 大 diff 的参数可以很大）。
  const skill = autoReview === null ? skillCardModel(cards) : null
  const ask = autoReview === null ? askCardModel(cards, askAnswerable) : null
  const terminal = autoReview === null ? terminalCardModel(cards, cwd) : null
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
  const rowState: ToolRowState = ask?.state ?? terminal?.state ?? item.status
  const running = rowState === 'running' || preparing
  /**
   * **退出状态胶囊**（上游 `ExitCodeBadge` + `terminalExitLabel`）：只对「已结算、失败、前台」的命令出。
   * 它一旦出现，这一行就不再当作"失败行"渲染（要点与文字都不再切红）—— 退出码本身就是失败原因，
   * 再叠一行红色首行错误只是重复（上游同：`failureLine = state==='error' && exitLabel===null`）。
   */
  const exitLabel = exitBadgeLabel(terminal)
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
  // Auto review 拒绝的摘要位是它自己的文案（上游 `errorSummary = autoReview?.summary ?? model.errorSummary`），
  // 不是结果首行 —— 结果里只有审查器的原始拒绝理由。
  const failureLine = autoReview !== null ? autoReview.summary : ask === null && item.status === 'error' && exitLabel === null ? resultFirstLine(item.output) : null
  // 摘要位后半段（上游 `summaryText = failureLine ?? description ?? summary`）：
  //   文件类工具的摘要是路径 → **相对工作区根**（上游 `abbreviateHomePath(relativizeToCwd(...), home)`；
  //   home 缩写只对 POSIX 家目录生效，Windows 上本插件与上游同样是空操作）。
  //   非路径摘要经 relativizeToCwd 原样返回，不受影响。
  //   **不做 basename**：工作区外的文件仍显示全路径（与上游一致）；卡片内部路径同样按上游
  //   （读卡相对化 / 差异卡 verbatim / 搜索卡原样）。
  const genericSummary = relativizeToCwd(item.summary ?? terminal?.description ?? '', cwd)
  // 提问行摘要照上游 `presentation?.summary ?? answeredSummary() ?? model.summary`：前两级在 ask-card 算出
  // （等待回答 / n 分之 m 已回答 / 已取消 / 已中断），算不出来时（结果坏形、未知错误码）**回落到通用摘要**
  // （`工具名 · 参数首行`）—— 上游此处即取 model.summary，不把摘要位留空。
  const fallbackSummary = ask !== null && ask.summary !== '' ? ask.summary : genericSummary
  // 技能行的摘要来自卡模型（失败 → 结果首行；中止 → 「skill 加载已中止」；否则 → 技能名）——
  // 上游 `summary = state === 'stopped' ? row.stopped : errorSummary ?? model.name`，通用摘要跟不上这三态。
  const skillSummary = skill !== null && skill.summary !== '' ? skill.summary : fallbackSummary
  // 详情卡的收起行摘要（上游 `summary = details.summary ?? items[0].title ?? empty ?? model.summary`）：
  // 结构化摘要（如「3 个智能体」/ 目标 objective）优先于通用摘要。
  const detailsSummary = details !== null ? (details.summary ?? details.items[0]?.title ?? details.empty) : undefined
  const baseSummary = failureLine !== null
    ? failureLine || undefined
    : (detailsSummary !== undefined && detailsSummary !== '' ? detailsSummary : skillSummary || undefined)
  // todo 卡的 diff 摘要（「新增 X · 更新 Y」）跟在「x/y 已完成」之后 —— 上游 `summarySuffix` 的位置。
  // 无法对比（旧清单不可用）时 todoDiff.summary 为 null，不缀。
  const todoDiffSuffix = todoDiff?.summary ?? ''
  const headSummary = todoDiffSuffix !== '' && baseSummary !== undefined ? `${baseSummary} · ${todoDiffSuffix}` : baseSummary
  // 收起行摘要里的文件路径可点击打开（对齐上游 ToolRow 的 filePath/onOpenFile）：
  //   - 只对文件类变体（read/write/edit，含 read_image）有值，取参数里的 path/file_path；
  //   - **失败行不挂**（失败行的摘要位是结果首行，不是路径）；
  //   - 读族带 `meta.offset` 时跳到该行（上游 filePathLine 同口径）。
  const openPath = failureLine === null
    ? (recordedPathOf(item.meta) ?? filePathOf(item.name, item.argsRaw))
    : undefined
  const openLineRaw = (item.meta as { offset?: unknown } | undefined)?.offset
  const openLine = typeof openLineRaw === 'number' && Number.isInteger(openLineRaw) && openLineRaw > 0 ? openLineRaw : undefined
  // 摘要位的**色调跟着行状态走**（上游 ToolRow：`state === 'error' && css.errorSummary`、
  // `state === 'stopped' && css.stoppedSummary`）—— 判据是**行状态**，不是"摘要文字是不是结果首行"。
  // ⚠️ **非零退出 / 被信号终止的 shell 也要着错误色**：那种调用本身 `isError: false`（退出状态是结果数据），
  // 上面 `rowState` 已按终端卡口径覆盖成 `error` —— 文字必须一起变红（真机反馈：「插件运行命令有红色点，
  // 后面的文字怎么没标红色呢，上游的都是红色的」）。文字本身仍走 `failureLine ?? description ?? summary`
  // 那条链：只有真失败（isError）才把摘要换成结果首行，非零退出仍是模型写的那句描述。
  const summaryTone = exitLabel !== null
    ? null
    : rowState === 'error' ? 'error' : rowState === 'stopped' ? 'stopped' : null
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
    ${/* 摘要只在**收起时**显示（上游 `ToolRow.tsx:368-369` **没有**传 `keepContentWhenOpen`，
         而 `DisclosureRow.tsx:112` 是 `(keepContentWhenOpen || !open) && collapsedContent` → 展开即隐藏）。
         2026-10-11 一度改成常显（误以为上游传了 true），已回退。 */ ''}
    ${!open && headSummary
      ? html`<span class="chain-sep" aria-hidden></span>${openPath !== undefined
          ? html`<button type="button" class="chain-row-preview chain-file-link" title=${openPath}
              onClick=${(e: Event) => {
                e.stopPropagation()
                store.openFile(openPath, openLine, cwd)
              }}>${headSummary}</button>`
          : html`<span class=${'chain-row-preview' + (summaryTone === 'error' ? ' is-error' : summaryTone === 'stopped' ? ' is-stopped' : '')}>${headSummary}</span>`}`
      : null}
    ${/* 退出状态胶囊：中性底 + 一个失败点，文案是"退出码 N / 信号 X / 未正常退出"（不发明数字）。
          它在展开态也保留 —— 这是这一行的结果事实，不是摘要的补充。 */ ''}
    ${exitLabel !== null ? html`<span class="chain-exit-badge" data-exit-badge title=${exitLabel}>
      <span class="chain-exit-dot" aria-hidden></span>${exitLabel}</span>` : null}
  </${preparing ? 'div' : 'button'}>`

  /**
   * 嵌套调用（上游 `ToolCallTree` 的 `subCalls`）：PTC 从 `run_code` 里派发的工具。
   *
   * ⚠️ **位置必须与工具行并列、且不受本行开合影响** —— 这是上游的结构，别"顺手挪进展开体"：
   * 是 `<div class=callRow>{toolview}{children}</div>`，
   * 即子调用挂在 **callRow** 里、toolview **之后**；真机 DOM 实测也印证：
   * `[data-subcalls]` 的祖先里**没有** `[data-tool]`（它不是工具行的子节点），
   * 唯一会挡住它的是**片的正文**（`[data-step-process-body][hidden=until-found]`）。
   *
   * 2026-10-11 我一度把它挪进 `wrap()` 的展开体（当时的理由是"父行收起时不该看见子行"），
   * 结果与网页端相反：网页端**片展开后、父`代码`行仍收起时，子行照样显示**。
   */
  const subCallsBody: VNode | null =
    item.subCalls !== undefined && item.subCalls.length > 0
      ? html`<div class="chain-subcalls" data-subcalls>
          ${item.subCalls.map((child) => html`<${ToolRow} key=${child.key} item=${child} store=${store} />`)}
        </div>`
      : null
  /**
   * 收起头 + 展开体（各卡体共用同一层 disclosure 外壳）。准备中的行没有展开体。
   *
   * 返回**片段**：disclosure 之后跟着子调用容器（与上游 `callRow` 同构）。
   */
  const wrap = (body: ComponentChild): VNode =>
    html`<div class=${'chain-disclosure' + (running ? ' is-running' : '')}>
      ${head}
      ${open && !preparing && body !== null ? html`<div class="chain-disclosure-body">${body}</div>` : null}
    </div>${subCallsBody}`

  /**
   * 通用「输入/输出」区（ioCard）：非专属卡的工具走它；提问卡没有问答记录时也落回它。
   * 写成**函数**是刻意的：终端/差异/读文件/搜索/web 各有专属卡，若在分派前先算好，等于
   * 给它们每次都白解析一遍参数 JSON（大 diff 的参数可以很大）。
   */
  const ioBody = (overrideOutput?: string): VNode | null => {
    let bodyText = item.argsRaw ?? ''
    if (bodyText) {
      try {
        bodyText = JSON.stringify(JSON.parse(bodyText), null, 2)
      } catch {
        /* 原样 */
      }
    }
    const outputText = overrideOutput ?? item.output ?? ''
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

  const ctx: ToolViewCtx = {
    store,
    cwd,
    cards,
    rowState,
    autoReview,
    askAnswerable,
    skill,
    ask,
    terminal,
    details,
    todoDiff,
    wrap,
    ioBody,
    subCallsBody,
  }
  // 瀑布：第一个非 null 的注册项接管这一行（顺序见 `tool-views.ts`；最后一项是通用兜底）。
  for (const view of TOOL_VIEWS) {
    const body = view.render(item, ctx)
    if (body !== null) return body
  }
  // 通用兜底恒非 null，正常到不了这里；保留返回以满足类型。
  return null
}

// 这里**不做组件层跳渲**（曾经试过 `memo`）：卡片会读若干**会话级信号**（`sessionCwd`、
// 「设置 → 通用设置 → 工作步骤展示」、反馈/用量…），而 `memo` 只比 props —— 跳渲会把信号变化也一起挡掉，
// 表现为「切设置后卡片不跟着变」。真要做，得先把这些信号以 props 显式喂进来（见 ReasoningRow）。
