// 工具卡注册表：一张卡一个注册项，**有序**（照上游卡分派的瀑布，先到先得，一个调用只渲染一张卡）。
// 顺序：代码卡 → 交付文件行 → 技能行 → 提问卡 → 终端卡 → 差异卡 → 图片卡 → 读文件卡 → 搜索卡
//      → web 卡 → 任务清单卡 → 详情卡 → Auto review 通用卡 → 通用「输入/输出」兜底。
//
// 为什么要有这张表：原先 ToolRow 把 14 段 `if` 串在一个函数里，加一张卡要读全文才知道插哪；
// 现在「加一张卡 = 加一个注册项 + 卡体组件」。分派顺序由数组顺序说话，不再散落在控制流里。
//
// 懒求值：**只服务某一张卡的模型在它自己的 render 里现算**（差异/图片/读/搜索/web 与代码卡的程序文本）。
// 提问/终端/技能/详情/todo 五个模型的求值时机不在这里 —— 它们是通用头部（状态、摘要、退出码）的
// 输入，必须先于分派算出来，由 `ToolRow` 算好经 ctx 传进来（见 `ToolViewCtx` 里那组字段的注释）。
import { html } from 'htm/preact'
import type { ComponentChild, VNode } from 'preact'
import type { DshTurnProcessItem, ChatStore } from '../../core/store/chat'
import { toolVariantOf, codeBodyOf } from '../../core/format'
import type { autoReviewDenialOf } from '../../core/format'
import { renderMd } from '../../core/markdown'
import { shellWantsGenericCard } from '../../core/terminal'
import type { TermCard, terminalCardModel } from '../../core/terminal'
import { SKILL_LABELS } from '../../core/skill-card'
import type { SkillCard } from '../../core/skill-card'
import type { AskCard } from '../../core/ask-card'
import { diffCardModel } from '../../core/diff-card'
import { readCardModel } from '../../core/read-card'
import { searchCardModel } from '../../core/search-card'
import { imageCardModel } from '../../core/image-card'
import { webCardModel } from '../../core/web-card'
import type { DetailsModel } from '../../core/details-card'
import type { todoDiffModel } from '../../core/todo-diff'
import { WebCard } from './WebCard'
import { PresentRow } from './PresentRow'
import { AskCardBody } from './AskCardBody'
import { ImageCard } from './ImageCard'
import { TerminalBlock } from './TerminalBlock'
import { DiffCard } from './DiffCard'
import { ReadCard } from './ReadCard'
import { SearchCard } from './SearchCard'
import { DetailsCardBody } from './DetailsCardBody'

/** 回合过程里的工具项（ToolRow 的输入形状）。 */
export type Tool = Extract<DshTurnProcessItem, { kind: 'tool' }>

/** 行状态集合：宿主给的五种（提问卡 / 终端卡会在通用事实上覆盖成其中一种）。 */
export type ToolRowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

/** 喂给卡模型的形状（准备中一律按「运行中且无参数」求解，归一化在 `ToolRow`）。 */
export type ToolCardInput = Parameters<typeof terminalCardModel>[0]

/** Auto review 拒绝的展示文案（`autoReviewDenialOf` 的产物）。 */
type AutoReviewDenial = ReturnType<typeof autoReviewDenialOf>

/** 任务清单卡的模型（与详情卡共用 `DetailsModel`；`summary` 是收起行的 diff 摘要）。 */
type TodoDiff = NonNullable<ReturnType<typeof todoDiffModel>>

/**
 * 一张卡的渲染上下文：**通用事实**（由 ToolRow 算好）+ 三件共享渲染件。
 *
 * 这是「通用事实」与「只服务某一卡的求解」的分界：
 *   · 本对象上的事实是头部/状态需要的（每一行都要）；
 *   · 各卡片自己的模型在 `render` 里现算 —— 只有真轮到它时才解析参数/结果 JSON。
 */
export interface ToolViewCtx {
  readonly store: ChatStore
  readonly cwd: string
  /** 准备中已按「运行中且无参数」归一化的卡模型输入 */
  readonly cards: ToolCardInput
  /** 行状态（提问卡覆盖 → 终端卡覆盖 → 宿主判好的 item.status） */
  readonly rowState: ToolRowState
  /** Auto review 拒绝（被拒的调用根本没执行）：专属卡一律让位给通用卡 */
  readonly autoReview: AutoReviewDenial
  /** 提问卡的「还能不能补答」= 上游 `userQuestions` 的 `answerable` */
  readonly askAnswerable: boolean
  // 以下五个卡模型是**通用头**（状态 / 摘要 / 退出码）的输入，必须先于分派求值：
  // 头部在每一行都要画，所以它们不能推迟到各自的 render 里 —— 那样要么重复求值，要么头部无数据。
  readonly skill: SkillCard | null
  readonly ask: AskCard | null
  readonly terminal: TermCard | null
  readonly details: DetailsModel | null
  readonly todoDiff: TodoDiff | null
  /** 收起头 + 展开体的 disclosure 外壳（含子调用容器与运行态样式） */
  readonly wrap: (body: ComponentChild) => VNode
  /** 通用「输入/输出」区；`overrideOutput` 供 Auto review 拒绝时换掉输出段 */
  readonly ioBody: (overrideOutput?: string) => VNode | null
  /** 嵌套调用（PTC 子调用）：与工具行并列，不随本行开合 */
  readonly subCallsBody: VNode | null
}

/** 一个注册项：`null` = 不是这张卡，交给下一项。 */
export interface ToolView {
  readonly id: string
  render(item: Tool, ctx: ToolViewCtx): ComponentChild
}

export const TOOL_VIEWS: readonly ToolView[] = [
  // ---- 代码卡（run_code：展开体是程序本身 + 输出）----
  {
    id: 'code',
    render: (item, ctx) => {
      if (toolVariantOf(item.name) !== 'code') return null
      // 展开体先出**程序**（markdown 围栏 → 上游 `CodeBlock` 同款横幅：语言标签 + 换行开关 + 复制），
      // 再出**输出**段；输入段**不出**（上游 `cardBody = variant === 'code' ? null : bodyText`）。
      // 程序文本取 `formatToolBody` 那一支（见 `codeBodyOf`）；取不到（参数坏形/无 `code`）才退回通用体。
      const program = codeBodyOf(item.argsRaw)
      if (program === null) return ctx.wrap(ctx.ioBody())
      const outputText = item.output ?? ''
      return ctx.wrap(html`<div class="chain-code-card">
        <div class="chain-code-program" dangerouslySetInnerHTML=${{ __html: renderMd('```typescript\n' + program + '\n```') }}></div>
        ${outputText !== ''
          ? html`<div class="chain-io-card">
              <div class="chain-io-section">
                <span class="chain-io-label">输出</span>
                <span class=${'chain-io-text' + (ctx.rowState === 'error' ? ' is-error' : '')}>${outputText}</span>
              </div>
            </div>`
          : null}
      </div>`)
    },
  },
  // ---- 交付文件（`present`）----
  // 专属行：四态标记 + 可见状态词 + 声明路径，展开体只有结果正文。**自带头部、不套通用 disclosure**
  //（上游 `callRow` 里 toolview 之后就是 `{children}`，所以子调用容器照样跟在后面）。
  {
    id: 'present',
    render: (item, ctx) => (item.name === 'present' ? html`<${PresentRow} item=${item} />${ctx.subCallsBody}` : null),
  },
  // ---- 技能行（上游 `ui-skill` 注册在 `key: 'skill'` 上）：只认这一个名字，互斥于其余卡 ----
  {
    id: 'skill',
    render: (_item, ctx) => {
      const skill = ctx.skill
      if (skill === null) return null
      // 上游：`expandable = output !== null`；展开体是一张「说明」卡（`<pre>` 放结果文本）。
      // 结果为空就没有可展开的东西 → 退回通用「输入/输出」区（上游此时整行不可展开、也不出按钮）。
      return ctx.wrap(
        skill.output === null
          ? ctx.ioBody()
          : html`<div class="chain-skill-card">
              <div class="chain-skill-head">${SKILL_LABELS.instructions}</div>
              <pre class="chain-skill-body" data-error=${skill.state === 'error' ? 'true' : undefined}>${skill.output}</pre>
            </div>`
      )
    },
  },
  // ---- 提问卡（ask_user_question）：只做问答记录；交互在 composer 上方 waterfall 弹窗 ----
  // **有问答记录才出提问卡**；无记录（运行中 / 问答配对不上 / 结果坏形）落回通用「输入/输出」区。
  {
    id: 'ask',
    render: (_item, ctx) => {
      const ask = ctx.ask
      if (ask === null) return null
      // 补答入口也算「有内容」：即使问答记录取不到（问题清单坏形），只要该条仍可补答也要出卡片
      const lateAnswerable = ctx.askAnswerable
      return ctx.wrap(
        ask.transcript === null && !lateAnswerable ? ctx.ioBody() : html`<${AskCardBody} card=${ask} store=${ctx.store} />`
      )
    },
  },
  // ---- 终端卡（bash / pwsh / shell）----
  // ⚠️ **不是所有 shell 调用都画终端卡**：上游 `BashRow` 只覆盖"前台、已带 `description`、正常结算"
  // 的那一类，另外三类**故意退回通用「输入 / 输出」卡**（判据见 `shellWantsGenericCard`）——
  // 调用失败（沙箱拒绝之类）正是其中一类，那时上游把**命令原文放进「输入」段**、用错误色渲染「输出」段。
  {
    id: 'terminal',
    render: (item, ctx) => {
      const terminal = ctx.terminal
      if (terminal === null) return null
      if (shellWantsGenericCard(item.name, item.argsRaw, item.output, item.subCalls, item.status)) return null
      return ctx.wrap(html`<${TerminalBlock} card=${terminal} store=${ctx.store} />`)
    },
  },
  // ---- 差异卡（write / edit：文件改动）----
  {
    id: 'diff',
    render: (_item, ctx) => {
      if (ctx.autoReview !== null) return null
      const diff = diffCardModel(ctx.cards)
      return diff === null ? null : ctx.wrap(html`<${DiffCard} card=${diff} store=${ctx.store} />`)
    },
  },
  // ---- 图片卡（read_image：结果里带图片附件引用）----
  // 卡只在「已结算成功 + 工具是 read_image + 内容全由 text/image 构成 + 有信封文本」时出（见 core/image-card）
  {
    id: 'image',
    render: (_item, ctx) => {
      if (ctx.autoReview !== null) return null
      const image = imageCardModel(ctx.cards, ctx.cwd)
      return image === null ? null : ctx.wrap(html`<${ImageCard} card=${image} store=${ctx.store} />`)
    },
  },
  // ---- 读文件卡（read：带行号的文件内容）----
  {
    id: 'read',
    render: (_item, ctx) => {
      if (ctx.autoReview !== null) return null
      const read = readCardModel(ctx.cards, ctx.cwd)
      return read === null ? null : ctx.wrap(html`<${ReadCard} card=${read} store=${ctx.store} />`)
    },
  },
  // ---- 搜索卡（grep / glob）----
  {
    id: 'search',
    render: (_item, ctx) => {
      if (ctx.autoReview !== null) return null
      const search = searchCardModel(ctx.cards)
      return search === null ? null : ctx.wrap(html`<${SearchCard} card=${search} store=${ctx.store} />`)
    },
  },
  // ---- web 卡（web_fetch / web_search）----
  {
    id: 'web',
    render: (_item, ctx) => {
      if (ctx.autoReview !== null) return null
      const web = webCardModel(ctx.cards)
      return web === null ? null : ctx.wrap(html`<${WebCard} card=${web} />`)
    },
  },
  // ---- todo 卡（todo_write：与上次清单的 diff）----
  {
    id: 'todo',
    render: (_item, ctx) =>
      ctx.todoDiff === null ? null : ctx.wrap(html`<${DetailsCardBody} model=${ctx.todoDiff.details} store=${ctx.store} />`),
  },
  // ---- 详情卡（goal / schedule / 子代理协调类）----
  {
    id: 'details',
    render: (_item, ctx) =>
      ctx.details === null ? null : ctx.wrap(html`<${DetailsCardBody} model=${ctx.details} store=${ctx.store} />`),
  },
  // ---- Auto review 拒绝：通用卡 + 换过的输出（`bodyRaw` 不给：拒的是操作本身，参数没有可看的）----
  {
    id: 'autoReview',
    render: (_item, ctx) => (ctx.autoReview === null ? null : ctx.wrap(ctx.ioBody(ctx.autoReview.output))),
  },
  // ---- 通用兜底：其余工具都用通用「输入」调用参数 pretty JSON + 「输出」调用结果 ----
  {
    id: 'generic',
    render: (_item, ctx) => ctx.wrap(ctx.ioBody()),
  },
]
