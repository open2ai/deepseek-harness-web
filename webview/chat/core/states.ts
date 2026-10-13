// 对话/任务 状态类型模块（低耦合：纯类型 + 常量 + 文案，不 import 任何 UI/DOM/i18n）。
// 用途：聊天 UI 各组件(思考指示/生成态/工具行/过渡态…)统一从这里取"状态"定义与文案，
// 避免状态名散落各组件、口径不一致。分类对应 AI 对话界面常见的状态表格；标 [未接线] 的
// 分类/条目为可扩展预留（当前插件场景用不到，如语音），接线时才在组件里消费。

// ---------- 1. 核心处理与反馈 ----------
/** 一条 assistant 消息 / 一次生成的生命周期阶段。 */
export const GenerationPhase = {
  /** 已收到指令，模型尚未输出可见文本（后台推理中）。 */
  Thinking: 'thinking',
  /** 已开始逐字流式输出正文（打字机）。 */
  Generating: 'generating',
  /** 已产出全部内容（含 usage），等待查看。 */
  Done: 'done',
  /** 被停止/中断/取消。 */
  Stopped: 'stopped',
  /** 出错（配合 errorText/errorCode 展示）。 */
  Error: 'error',
} as const
export type GenerationPhase = (typeof GenerationPhase)[keyof typeof GenerationPhase]

/** 无明确进度的通用等待（历史装载/切换等）。 */
export const BusyKind = {
  /** 会话/工作区切换、历史恢复中。 */
  Loading: 'loading',
  /** 模式/计划切换 pending（读投影前的中间态）。 */
  Switching: 'switching',
  /** 提交发送（用户回车后到首个 token 前）。 */
  Sending: 'sending',
} as const
export type BusyKind = (typeof BusyKind)[keyof typeof BusyKind]

// ---------- 2. UI 视觉与占位 ----------
/** 占位/骨架屏角色：决定 loading 时显示什么形状。 */
export const PlaceholderKind = {
  /** 欢迎页建议卡（已有首轮建议）。 */
  Welcome: 'welcome',
  /** 消息流为空、首个 assistant 内容未到前的占位行。 */
  FirstReply: 'first-reply',
  /** 输入框 placeholder（"向 AI 提问…"）。 */
  Composer: 'composer',
  /** 斜杠命令参数 ghost（"/cmd <hint>"）。 */
  SlashHint: 'slash-hint',
} as const
export type PlaceholderKind = (typeof PlaceholderKind)[keyof typeof PlaceholderKind]

/** 打字指示器形态。 */
export const TypingIndicator = {
  /** 生成中正文尾脉冲竖条（当前实现）。 */
  Caret: 'caret',
  /** 三圆点跳动（预留：无正文、纯思考占位用）。 */
  Dots: 'dots',
} as const
export type TypingIndicator = (typeof TypingIndicator)[keyof typeof TypingIndicator]

/** 菊花旋转（codicon-loading + codicon-modifier-spin）。 */
export const Spinner = { Loading: 'codicon-loading codicon-modifier-spin' } as const

// ---------- 4. Agent 任务执行与工具状态 ----------
/** 单条工具调用生命周期。 */
export const ToolState = {
  /** 正在调用（转圈/脉冲）。 */
  Running: 'running',
  /** 调用完成且成功。 */
  Ok: 'ok',
  /** 失败（带 errorCode）。 */
  Error: 'error',
  /** 任务被中断/停止，工具未完成。 */
  Stopped: 'stopped',
} as const
export type ToolState = (typeof ToolState)[keyof typeof ToolState]

/**
 * 工具行状态的**无障碍文字**（zh 原文取自上游字典 `row.running`/`row.failed`/`row.stopped`）。
 * 为什么需要：状态点与 running 的掠光带都是 colour-only、且标了 aria-hidden，视觉上能看出运行/失败/中断，
 * 读屏却读不到——靠这段视觉隐藏的文字播报。`ok` 返回 null（不播报，图标+摘要已说明）。
 */
export function toolStateLabel(state: ToolState): string | null {
  switch (state) {
    case ToolState.Running:
      return '运行中'
    case ToolState.Error:
      return '失败'
    case ToolState.Stopped:
      return '已停止'
    default:
      return null
  }
}

/** 一次多动作过程(折叠窗口)整体状态：进行中 / 定稿。 */
export const ChainState = {
  /** 过程仍在推进（有工具在跑/思考中）。 */
  Active: 'active',
  /** 正文已开始或整轮完成，过程定稿可折叠成计数行。 */
  Settled: 'settled',
} as const
export type ChainState = (typeof ChainState)[keyof typeof ChainState]

/** 需要用户输入（多步任务中 ask_user_question / approval 暂停点）。 */
export const NeedsInput = {
  Question: 'question',
  Approval: 'approval',
} as const
export type NeedsInput = (typeof NeedsInput)[keyof typeof NeedsInput]

// ---------- 5. 系统资源与负载 ----------（[未接线] 需宿主投影 context 压力后接）
export const ResourceState = {
  Light: 'light', // 轻负载/上下文偏长
  Degraded: 'degraded', // 降级模式（低算力）
} as const
export type ResourceState = (typeof ResourceState)[keyof typeof ResourceState]

// ---------- 6. 终态与异常 ----------（与 GenerationPhase.Done/Stopped/Error 对齐；此处是"回合/任务终态"别名）
export const TerminalState = {
  Completed: 'completed',
  Error: 'error',
  MaxTokens: 'max-tokens',
  Interrupted: 'interrupted',
  Blocked: 'blocked',
  Aborted: 'aborted',
} as const
export type TerminalState = (typeof TerminalState)[keyof typeof TerminalState]

// ---------- 7. 趣味化/拟人化加载提示（Spinner Verbs） ----------
/** 等待文案可轮换的"动作动词"集。仅作占位，不编造未发生的动作；按等待场景分组。 */
export const SpinnerVerbs: Record<'thinking' | 'tool' | 'loading', string[]> = {
  thinking: ['正在思考…', '正在梳理上下文…', '正在组织思路…', '正在整理要点…'],
  tool: ['正在执行…', '正在调用工具…', '正在读取结果…'],
  loading: ['正在加载…', '正在连接…', '正在同步…'],
}

/** 与上游文案一致：工具调用次数 / 中间消息数 折叠行用词。 */
export const foldSeparator = ' · '
