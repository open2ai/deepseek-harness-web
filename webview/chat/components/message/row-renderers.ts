// 行视图注册表：ChatRow 的每种 kind 对应哪一行组件（适配上游 0.2.1-rc.2）。
// 为什么单独成文件：新增一种行类型时，"忘了补视图"原先只会表现为**运行时少一行**；
// 这里把映射写成映射类型，漏一种 kind 直接编译失败。
// 只放"按 kind 选视图"这一步 —— 可见性过滤、排序、折叠事实、行级错误边界都是整表级事务，
// 留在 MessageList，不要被拆进单行视图。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { UserRow } from './UserRow'
import { AssistantRow } from './AssistantRow'
import { ApprovalRow } from './ApprovalRow'
import { QuestionRow } from './QuestionRow'
import { TriggerRow } from './TriggerRow'
import { NoticeRow } from './NoticeRow'
import { CommandRow } from './CommandRow'
import { CompactionRow } from './CompactionRow'
import { RetryRow } from './RetryRow'
import { TurnNoticeRow } from './TurnNoticeRow'
import { ContextInjectionRow } from './ContextInjectionRow'

/** 一种行类型的渲染器。`K` 把 `row` 收窄到该 kind 那一支，视图里不必再判 kind。 */
export type RowRenderer<K extends ChatRow['kind']> = (
  row: Extract<ChatRow, { kind: K }>,
  ctx: RowRenderCtx,
) => unknown

/**
 * 一条渲染行需要的事实，由 `MessageList` **按行**构造（同一个渲染里各行取值不同）。
 *
 * 为什么用入参而不是让渲染器自己从 store 推：座位、回合头、折叠世代都是"整表算一次、
 * 逐行下发"的事实；让 12 个渲染器各推一遍，判据迟早分叉。
 */
export interface RowRenderCtx {
  readonly store: ChatStore
  /** 整表最后一条**渲染行** */
  readonly latest: boolean
  /** 最后一条用户行且没有在途插话 —— 与 `latest` 是两条判据（见 `MessageList` 的兄弟规则） */
  readonly userLatest: boolean
  /** 本行所在回合的头行；无回合号或座位计划给不出时为 `undefined` */
  readonly turnHead: ChatRow | undefined
  /** 本行是否承着本回合的内容收尾（分叉只允许从这里出发） */
  readonly turnTail: boolean
  /** 本回合**当前回答世代**（座位层优先，行级兜底） */
  readonly currentStepOf: (turn: number) => number | undefined
  /** 本行所属座位的 key（同一座位的多行由此认亲） */
  readonly seatKeyOfRow: (row: { key: number | string }) => string | undefined
  /** 本行是否落在**最新交互段**（收起时机推迟的判据） */
  readonly deferOfRow: (row: { key: number }) => boolean
  /** 本行内容是否被**外层折叠**（更早回答世代，挂 `hidden="until-found"`） */
  readonly outerHidden: (row: Extract<ChatRow, { kind: 'assistant' }>) => boolean
  /** 归并到本行的终局通知行（`tailNotices`） */
  readonly tailNotices: readonly ChatRow[] | undefined
}

/**
 * `kind → 渲染器` 的唯一映射。
 *
 * 用 `satisfies` + 映射类型而不是普通 `Record`：每个 kind 都必须有键、且每个渲染器只接
 * 自己那一支行。新增 kind 却不补视图时，这里就是编译错误。
 */
export const ROW_RENDERERS = {
  user: (row, ctx) => html`<${UserRow} key=${row.key} row=${row} store=${ctx.store} latest=${ctx.userLatest} />`,
  // 已被可见性过滤挡掉（到这里只剩含工具增删块的注入行）；类型上仍可能出现，故保留分支
  context: (row) => html`<${ContextInjectionRow} key=${row.key} row=${row} />`,
  // 聊天区不显示系统提示词（上游 0.1.7-alpha.1 起 `isVisibleChatNode` 排除该 kind）。
  // 数据仍在会话日志里、宿主照旧下发，只是不再渲染 —— 这里返回 null 只作防御。
  sysprompt: () => null,
  assistant: (row, ctx) => {
    const head = ctx.turnHead
    return html`<${AssistantRow} key=${row.key} row=${row} store=${ctx.store} latest=${ctx.latest}
      turnTail=${ctx.turnTail}
      ownsHead=${head === undefined || head.key === row.key}
      outerHidden=${ctx.outerHidden(row)}
      seatKey=${ctx.seatKeyOfRow(row)}
      turnCurrentStep=${row.turn === undefined ? undefined : ctx.currentStepOf(row.turn)}
      deferFold=${ctx.deferOfRow(row)}
      tailNotices=${ctx.tailNotices} />`
  },
  approval: (row, ctx) => html`<${ApprovalRow} key=${row.key} row=${row} store=${ctx.store} />`,
  question: (row, ctx) => html`<${QuestionRow} key=${row.key} row=${row} store=${ctx.store} />`,
  notice: (row) => html`<${NoticeRow} key=${row.key} row=${row} />`,
  // 回合终局通知行（上游 `turn-error` / `turn-max-tokens`）：独立行，永远可见（不参与过程折叠）
  turnNotice: (row) => html`<${TurnNoticeRow} key=${row.key} row=${row} />`,
  // 触发卡（上游 `turn-trigger`）：某条非 human 通知唤醒了本轮，独立行、永远可见
  trigger: (row) => html`<${TriggerRow} key=${row.key} row=${row} />`,
  // 模型重试链（上游 `model-retry`）：一行一条链，首条 `llm/retry` 的 seq 就是它的位置
  retry: (row) => html`<${RetryRow} key=${row.key} row=${row} />`,
  // 自动压缩标记（上游 `compaction`）：只有检查点落地才有这一行，摘要可展开
  compaction: (row, ctx) => html`<${CompactionRow} key=${row.key} row=${row} store=${ctx.store} />`,
  // 手动命令行（上游 `command`）：`permission` 已在可见性过滤里剔除
  command: (row) => html`<${CommandRow} key=${row.key} row=${row} />`,
} satisfies { [K in ChatRow['kind']]: RowRenderer<K> }

/**
 * 按 `row.kind` 取出并调用注册项。
 *
 * 为什么要这一层：`ROW_RENDERERS[row.kind]` 是**联合**函数类型，直接拿联合行去调用会被
 * TypeScript 拒绝（每个渲染器只接受自己那一支）。"哪个 kind 用哪个渲染器"已由表上的
 * `satisfies` 逐键钉住，因此这里收窄到公共签名是安全的。
 */
export function renderRow(row: ChatRow, ctx: RowRenderCtx): unknown {
  const render = ROW_RENDERERS[row.kind] as unknown as (row: ChatRow, ctx: RowRenderCtx) => unknown
  return render(row, ctx)
}
