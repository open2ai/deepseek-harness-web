// 聊天页行模型与 store 接口（仅类型，零运行时代码）。
// 独立成文件是为了让各切片能 Pick<ChatStore, K> 而不与 store/chat.ts 形成环；
// 依赖方向固定为 chat.ts 与各切片 → types.ts。
import type { Signal } from '@preact/signals'
import type { LateAnswerCall, LateAnswerItem, LateAnswerQuestion } from '../late-answer'
import type {
  DshTurnProcess as DshRowProcess,
  DshPresentedFile,
  DshRowGroup,
  DshTodoItem,
  DshChangesSummary,
} from '../../../../src/dsh/rows/types'
import type {
  HostToViewMessage,
  ImageAttachment,
  AttachmentRef,
  PermissionOption,
  QuestionSpec,
  ChatModelInfo,
  SlashCommandInfo,
  SlashSkillInfo,
  AtFileRef,
  AtSessionRef,
  TodoItem,
  QueueItemView,
  ContextBreakdown,
  ContextPressure,
} from '../protocol'

// ---------- 消息行模型(不可变替换,组件用 stable key) ----------

/** 一条 assistant 回合的过程动作（上游"回合过程"里的成员；reasoning 或 tool 各一条，按发生顺序）。 */
export type DshTurnProcessItem =
  | { kind: 'reasoning'; key: number; step?: number; index?: number; text: string }
  | {
      kind: 'tool'
      key: number
      step?: number
      callId?: string
      name: string
      title?: string
      summary?: string
      argsRaw?: string
      status: 'preparing' | 'running' | 'ok' | 'error' | 'stopped'
      error?: string
      /** 错误名（`tool/result.data.error.name`）；交付文件行的兜底正文用它和错误码拼 */
      errorName?: string
      /** tool/result 的结果文本（Terminal/Read 等展开卡展示输出） */
      output?: string
      /** 退出码（输出末尾 marker 解析；Terminal 卡 Pill 展示；输出已剥 marker） */
      exitCode?: number
      /** 终止信号名（[killed by signal: X]；优先于退出码） */
      signal?: string
      /** tool/result.data.meta 原文透传（web_fetch statusCode / web_search sources/answer 等卡数据源） */
      meta?: unknown
      /** 结果原始内容块（**仅当结果含图片块时**带；图片块只含附件引用，字节由附件层按需另取） */
      blocks?: unknown
      /** ask_user_question 的 RPC 交互数据（chatQuestion 配对挂到该工具行：rpcId/sessionId/带选项的 questions） */
      question?: { rpcId?: string; sessionId?: string; questions?: QuestionSpec[] }
      /**
       * **本次 `todo_write` 之前**已落盘的清单（宿主从 `todo/write` 事件折出；仅 todo 工具带）。
       * `null` = 窗口里没有更早的写入；缺省 = 非 todo 工具。todo 卡据此渲染「与上次清单相比」的 diff。
       */
      todoBaseline?: DshTodoItem[] | null
    }
  | {
      kind: 'context'
      key: number
      content: unknown[]
      source: unknown
      provenance: { role: 'inject' | 'recall'; label: string | null }
      form: string | null
    }
  | {
      kind: 'text'
      key: number
      step?: number
      /** **非回答步**的输出文本（过程文本）：一回合只开一条行时，中间步的正文靠它才显示得出来 */
      text: string
    }

/** 过程折叠计数（三个计数：toolCallCount=非 subagent 工具调用数；
 *  messageCount=最终答复前带文本的中间 assistant 消息数；subagentCount=subagent 委派数） */
export interface TurnCounts {
  toolCallCount: number
  messageCount: number
  subagentCount: number
}

/** 用户消息里引用贴片的**本地快照**：贴片本身从正文 token 解析（见 core/ref-mentions），
 *  快照只用来让短名/图标与用户挑选时一致（历史行没有它，全凭正文解析）。 */
export interface RefSnap {
  kind: RefChip['kind']
  label: string
  /** 注入正文的引用文本；命中同一 token 时用这条快照覆盖解析出的短名/图标 */
  token?: string
}

export type ChatRow =
  | { kind: 'user'; key: number; text: string; images: ImageAttachment[]; time: string;
      /** 提交标识：本面板发出的消息带它，服务端回显的 `user/message` 会带回同一个值。
       *  **认领在宿主侧**（见 docs/design/08 §8）：页面这个字段是留作对照与后续节点下发的，
       *  页面自身不据此判重。历史恢复的行没有它。 */
      rpcId?: string;
      /** **插话**：这条消息是被当前回合的下一步取用的（宿主按收件箱 splice 史判定，见 src/dsh/rows/inbox-claims.ts）。
       *  分类**不改变外观**（与普通提问同一个气泡），只作语义标记与样式/排查锚点。 */
      steering?: boolean;
      /** 该次提交**没有成功送到服务端**（宿主回 `chatError`）。这类行永远不会被服务端回显认领，
       *  故必须与「还在等回显」的乐观行区分开：前者只是列表里的历史，后者才代表「本轮在跑」——
       *  不区分的话 `processing` 会因为它恒为真（发消息失败后输入区一直卡在处理中）。 */
      failed?: boolean;
      /** 历史恢复来的图片附件引用（字节不在事件里，由附件层按需取）；实时路径的图在 `images`（内联 base64） */
      imageRefs?: AttachmentRef[];
      /** 随该消息发出的文件（文件上送）：只留显示信息与本地路径，点它用编辑器打开 */
      files?: Array<{ name: string; path?: string; bytes?: number }>;
      /**
       * 「@」引用贴片的**本地快照**（只在本面板刚发出的那条上有）。
       *
       * 贴片本身按正文里的 `token` 解析出来（见 core/ref-mentions）；这里只做覆盖 ——
       * 命中同一 token 时用它的 label/kind（与用户挑选时看到的短名一致）。历史行没有它。
       */
      refs?: RefSnap[] }
  /** 系统提示词行（上游 `system-prompt` 节点）：该回合实际发给模型的 system，可折叠；位置在该回合用户提问之前 */
  | { kind: 'sysprompt'; key: number; text: string }
  /**
   * 回合**终局通知**行（**独立行**，镜像上游 `turn-error` 与 `turn-max-tokens` 两个节点）：
   * 上游两节点都由 `turn/end` 建、与本回合有没有内容无关；都在 `INDEPENDENT` 集合里 → 不被折进过程组。
   * 渲染 `[状态点] 标题 + 文案 [code]`，见 `components/message/TurnNoticeRow.ts`。
   */
  | {
      kind: 'turnNotice'
      key: number
      /** `error` = 回合失败 / `warning` = 输出 token 上限 */
      tone: 'error' | 'warning'
      turn?: number
      step?: number
      /** 失败原文（**仅 `error` 有**；`AUTH` 下不带：可能回显被掩码的凭据） */
      message?: string
      /** 失败标识（上游 `turn/end.reason` 的 code）：页面据此取上游固定中文 */
      code?: string
    }
  /**
   * **模型重试链**（独立行，镜像上游 `model-retry` 节点）：按 `retryId` 聚成一行，只渲染**最后一次尝试**。
   * 文案与倒计时见 `core/retry-copy.ts`（纯函数、有守卫）。
   */
  /**
   * **自动压缩标记**（独立行，镜像上游 `compaction` 节点）：只在**检查点落地**时出现的那一行，
   * 摘要与计数取自它引用的 `compaction/summary`。文案见 `core/compaction-copy.ts`。
   */
  /**
   * **手动命令行**（独立行，镜像上游 `command` 节点）：`command/run` + `command/done` 按 `commandId` 配成一行。
   * 标题 = 裸命令名、摘要 = 结算 `text`（缺则按 kind 给固定文案）；文案见 `core/command-copy.ts`。
   * ⚠️ `name === 'permission'` 的一律不显示（上游 `isVisibleChatNode` 剔除）。
   */
  | {
      kind: 'command'
      key: number
      commandId: string
      name: string | null
      outcome?: { kind: 'success' | 'error'; text?: string }
    }
  | {
      kind: 'compaction'
      key: number
      compactionId: string
      /** 检查点事件序号（= 这一行的锚点） */
      seq: number
      summaryEventSeq?: number
      /** 摘要正文；缺省 = 不可展开（上游同：`expandable = summary !== null`） */
      summary?: string
      shadowedItemCount?: number
      shadowedTokenCount?: number
      sourceCommandId?: string
    }
  | {
      kind: 'retry'
      key: number
      retryId: string
      /** 已排过的尝试次数（末条 `llm/retry` 的 `retry`） */
      retry: number
      turn?: number
      step?: number
      provider?: string
      mode?: string
      /** 上限（只 `mode === 'normal'` 有；`always` 上游显示 `∞`） */
      maxRetries?: number
      delayMs?: number
      failure?: { message?: string; code?: string }
      /** **哪一次**尝试已真正开始（收到过 `llm/retry-started` 的那个序号）；未开始 = 缺省 */
      started?: number
      /** 结算时仍停在 `scheduled` 且回合已关闭 → 上游派生的 `cancelled` */
      cancelled?: boolean
    }
  | {
      kind: 'context'
      key: number
      time?: string
      content: unknown[]
      source: unknown
      provenance: { role: 'inject' | 'recall'; label: string | null }
      form: string | null
    }
  | {
      kind: 'assistant'
      key: number
      time: string
      done: boolean
      prompt: string
      text: string
      stats: string
      /** chatDone.stats 原始值（含 usage 与 provider/model/ttftSec/tps/wallSec），供用量/用时弹窗 */
      usageRaw?: Record<string, unknown>
      /** **消息级**「这条回答被中断」：正文末尾出「已停止」（上游 `AssistantMarkdown` 的位置） */
      interrupted?: true
      /** 停止状态展示文案（已停止 · Stopped），仅被停止/中断/取消的回答有 */
      status?: string
      /** 过程链：思考/工具按发生顺序排列（折叠窗口成员） */
      chain: DshTurnProcessItem[]
      /** 过程折叠计数（上游口径）；定稿前为 0，chatDone 附 counts 后回填 */
      counts: TurnCounts
      /** 正文首 chunk 是否已到达（正文开始 = 过程定稿，链可收起） */
      bodyStarted: boolean
      /**
       * **本地占位行**（发送当帧那条"思考中…"）：宿主行里根本不会有的行，只是页面为了"点了就有反应"
       * 先画一条。宿主的下一次整表推行里当然没有它 —— 所以它**必须被显式保留**，否则会在**第一帧
       * 宿主行到达时被整段丢掉**（真机 2026-10-07：「新会话首次发送，会话区闪一下」＝占位行消失一拍、
       * 等宿主的回答行到了再冒出来）。宿主那条未定稿回答行一到就退休，不会两个"回答中"并存。
       */
      local?: true
      /**
       * 本回合 `turn/start` 的**时刻**（epoch 毫秒，宿主下发）：左下角「深度求索中，用时 X」的时钟锚点。
       * 上游锚的是**回合开始时刻**（不是页面挂载时刻），所以面板中途打开/切回来不会从 0 重新计。
       */
      turnStartMs?: number
      /** 折叠判定的事实（宿主下发，见 docs/design/08 §12）：回答锚点非空 = 末步是有回答内容的定稿步 */
      process?: DshRowProcess
      /**
       * **过程分组**（上游 step-group；宿主在「带回答内容的步」处收口时下发）。
       *
       * 有它 → 页面**按片**渲染（每片一个折叠头、每片自己的事实与展开态）；
       * 没有 → 退回整回合一条头的既有形态（旧宿主 / 单回答步的回合）。
       */
      groups?: DshRowGroup[]
      /** 回答锚点的事件序号：仅在「显示层」用于「从此处分叉」的禁用判定与传参（宿主侧 fork 的 atSeq） */
      seq?: number
      /** 回答锚点的消息标识：消息反馈（👍/👎）的目标；缺失即该条不提供反馈 */
      messageId?: string
      /** 本回合模型声明的交付文件（宿主事件带来；缺失 = 本回合没有声明，此时不渲染那一区） */
      presentedFiles?: DshPresentedFile[]
      /**
       * 所属回合号（宿主给）。**同一回合可能有多条回答行**（插话切成「前段 / 后段」）。
       *
       * 过程折叠是**回合级**的：上游只有 `turn-process` 那一个控制节点渲染折叠头，被它收起来的是整个回合
       * 过程区间里的节点。页面据此把同回合的行归成一组 —— 只让首行出折叠头，其余行跟随同一个展开态。
       */
      turn?: number
      /**
       * 本回合 `workspace/changes` 宣告的事件序号（宿主从事件折出，见 `rows/types.ts`）。
       * 「改动文件卡」的取数钥匙：宿主拿它去读 Host 内存态的改动摘要。
       */
      changesSeq?: number
      /**
       * 宿主按 `changesSeq` 取回的**回合改动摘要**；缺省 = 还没取到 / Host 已经没有它。
       *
       * 上游 `ChangedFiles` 就是用这份摘要渲染的（相对路径 + `+x/-y` 行数）；**拿不到就不出那张卡**
       * —— Host 重启或会话被释放后历史回合的摘要就没了，网页端同样不显示。
       */
      changesSummary?: DshChangesSummary
    }
  | {
      kind: 'approval'
      key: number
      approvalId: string
      /** 上游 `request.reason`：审计原文（英文），本地化文案缺失时的回退 */
      description: string
      /** 上游 `request.displayReason`（dsh 0.1.7-rc.2 新增）：本地化展示文案 `{ en, zh, … }` */
      displayReason?: Record<string, string>
      toolName?: string
    }
  | { kind: 'question'; key: number; rpcId: string; sessionId?: string; questions: QuestionSpec[]; disabled: boolean }
  | { kind: 'notice'; key: number; text: string; command?: string; tone?: 'error' | 'ok' }

/** 本地「发送中」条目里的附件：比权威条目多一份**本地图片预览**（内联 base64，只有本地回显拿得到）。 */
export interface QueueSendingAttachment {
  kind: 'image' | 'file'
  name?: string
  bytes?: number
  /** 图片的内联预览（仅本地回显；权威条目只有引用与名字，取不到字节） */
  preview?: { mediaType: string; data: string }
}

/** 对话区末尾的 pending 插话气泡：还没进日志的那条插话（本地回显或服务端收件箱里的 steering 项）。 */
export interface PendingSteering {
  /** 稳定 key：权威条目用条目 id，本地回显用 rpcId（两类不会同时存在同一条） */
  key: string
  text: string
  attachments: QueueSendingAttachment[]
  /** 引用贴片快照（见 `RefSnap`）：本地回显先把贴片补齐，权威帧到达后由正文解析接手 */
  refs?: RefSnap[]
}

/** 本地「发送中」的排队条目：忙时提交后立刻显示，宿主队列帧按 `rpcId` 认领后消失。 */
export interface QueueSending {
  /** 提交标识（本面板 mint）：与队列帧里的 `rpcId` 配对 */
  rpcId: string
  /** 投递方式：queue = 排队发送；steer = 插话发送 */
  mode: 'queue' | 'steer'
  text: string
  attachments: QueueSendingAttachment[]
  /** 引用贴片快照（见 `RefSnap`） */
  refs?: RefSnap[]
  /** 提交失败（宿主回的 `chatError{scope:'queue'}`）：留在卡里作历史，但不再算「在等」 */
  failed?: boolean
  error?: string
}

/** 队列卡里的行内编辑态（纯页面态，不发给宿主）。 */
export interface QueueEditing {
  id: string
  text: string
}

/** 输入区暂存的待发送文件（文件上送）：选中即上传，**就绪后才能发送**。 */
export interface StagedFile {
  /** webview 生成的稳定 key（多文件并发对得上宿主回包） */
  key: string
  /** 本地绝对路径（宿主据此读字节上传；发送后也用于「点开文件」） */
  path: string
  /** 显示名（文件名） */
  name: string
  state: 'uploading' | 'ready' | 'error'
  /** 就绪后拿到的上传凭据（随 prompt 引用；发出后服务端即 retire，故发送时清空暂存） */
  receiptId?: string
  /** 文件字节数（就绪态显示大小） */
  bytes?: number
  /** 失败原因（原样展示） */
  error?: string
}

/** 附件字节缓存条目（附件大类）：loading 取件中 / ready 就绪 / error 失败（可重试）。 */
export interface AttachmentEntry {
  state: 'loading' | 'ready' | 'error'
  /** 就绪时的媒体类型（如 image/png） */
  mediaType?: string
  /** 就绪时的**裸 base64**（无 data: 前缀，渲染时自行拼） */
  data?: string
  /** 失败原因（原样展示） */
  error?: string
}

/** 输入框引用贴片（@ 选出，不进正文；发送时转成引用行）。 */
export interface RefChip {
  key: number
  kind: 'file' | 'directory' | 'session'
  label: string
  /** 发送时注入 prompt 的引用文本（文件 @path / 会话 @[label](dsh-session:…)） */
  token: string
  /** 供 tooltip 展示的完整相对路径/会话 id 等 */
  detail?: string
}

export interface SelectorState {
  permOptions: PermissionOption[]
  currentPerm: string
  modelGroups: ChatModelInfo['groups']
  modelFailures: unknown[]
  curProvider: string
  curModel: string
  curEffort: string
  modeOptions: Array<{ id: string; name?: string; description?: string }>
  currentMode: string
  modeLocked: boolean
}

/** 会话统计投影（`sessionStats`）：都是绝对量（毫秒 / 计数），没有比例字段。缺项即"没这项统计"。 */
export interface SessionStatsView {
  /** 含至少一个 `step/end` 的不同回合数 */
  turns?: number
  /** `step/end` 数（含失败/取消） */
  steps?: number
  /** `step/start` → `assistant/message` 之和 */
  llmMs?: number
  /** `tool/call` → `tool/result` 按 callId 配对之和 */
  toolMs?: number
  /** 首 token 延迟合计与其步数（平均要自己除） */
  ttftMs?: number
  ttftSteps?: number
  /** 首 token → 消息 的解码时长与输出 token（算速度要自己除） */
  decodeMs?: number
  decodeTokens?: number
}

/** Token 用量投影（`tokenUsage`）：四个**互斥桶**，覆盖整份会话日志的累计值。 */
export interface TokenUsageView {
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * 会话目标（目标条的数据源）。形状按上游 `GoalProjection.goal`（= `GoalSnapshot`）+ 前端补的两个展示字段。
 *
 * `phase` 是**durable** 阶段（`active|paused|blocked|complete`）；上游另有一个 process-local 的
 * `activation`（armed/disarmed，决定"进行中"还是"未运行"）—— 它**不在投影里**（上游明说 never
 * persisted、deliberately absent），另走一条路到达：见下面的 `GoalActivationView`。
 */
export interface GoalView {
  objective: string
  phase: string
  /** CAS 引用的一半：动作（edit/pause/resume/clear）要拿 `{id, revision}` 打上游。 */
  id?: string
  revision?: number
  /** 仅 `phase === 'blocked'` 时有：挂成条上的 title（上游同口径）。 */
  blockedReason?: string
}

/**
 * 目标条的 activation（`{id?, revision?, activation?}`）。
 *
 * 来源是宿主的一次读 + 边沿订阅（宿主 `src/dsh/goal-activation.ts`），随 `projections` 帧到达。
 * `{}` = 没有当前目标 / 还没读到（两种在 wire 上同形）。
 *
 * ⚠️ 用时**必须按 `(id, revision)` 与投影里的活跃目标对账**：它与投影是两条来路，
 * 晚到的那一份可能已经过期 —— 对不上就当作"还不知道"（不要当成"没有激活"）。
 */
export interface GoalActivationView {
  id?: string
  revision?: number
  activation?: 'armed' | 'disarmed'
}

export interface ChatStore {
  // 信号
  messages: Signal<ChatRow[]>
  view: Signal<'welcome' | 'chat'>
  processing: Signal<boolean>
  /**
   * 左下角「深度求索中，用时 X」的**时钟锚点**（epoch 毫秒）：= 正在跑的那一回合的 `turn/start` 时刻。
   *
   * 由 `messages` 切片从宿主行上取（最后一条**未定稿**的回答行的 `turnStartMs`）。
   * `undefined` = 还不知道本回合何时开始（提交后、第一条行到达前）→ 状态行按上游只显示「深度求索中」。
   */
  runAnchorMs: Signal<number | undefined>
  /** 宿主权威的「一轮在跑」（`rows` 帧 `turnActive`）。停止/插话只认它；`processing` 是推导值，会提前变假。 */
  turnRunning: Signal<boolean>
  /**
   * **子会话事实**（`rows` 帧的 `subagent` 字段；普通会话 = `undefined`）。
   *
   * 页面据此判停止控件：主钮能不能让出「停止」（子会话永远不能）、要不要另挂一个独立 Stop、
   * 输入区要不要被"父离线"锁住 —— 判据在 `core/stop-control.ts`，事实由宿主下发。
   */
  subagentFacts: Signal<import('../stop-control').SubagentFacts | undefined>
  /** 过渡态：恢复历史/切工作区等无明确进度等待（驱动 composer 禁用 + 占位/骨架）。null=空闲 */
  busy: Signal<'loading' | 'switching' | null>
  /** 当前会话工作区根路径；'' = 未知。终端卡的 cwd 标签在工具调用未带 workdir 时用它兜底（上游同口径） */
  sessionCwd: Signal<string>
  text: Signal<string>
  attachments: Signal<StagedFile[]>
  images: Signal<ImageAttachment[]>
  /** 「@」引用贴片（不进正文；发送时转为引用行） */
  refs: Signal<RefChip[]>
  focusTick: Signal<number>
  sel: Signal<SelectorState>
  openPopup: Signal<'perm' | 'model' | 'mode' | 'modelSearch' | null>
  /** 会话统计投影（`sessionStats` 原文）：输入框下方「会话统计」卡的数据源；null=没有这项统计 */
  sessionStats: Signal<SessionStatsView | null>
  /** Token 用量投影（`tokenUsage` 原文）：输入框下方「Token 用量」卡的数据源；null=没有用量 */
  tokenUsage: Signal<TokenUsageView | null>
  /** 上下文占用投影（`contextPressure` + `contextBreakdown`）：发送按钮左侧那个环的数据源。
   *  null = 该 dsh 没有这两条投影（整个环不渲染）；两条可各自缺失。 */
  contextFacts: Signal<{ pressure?: ContextPressure; breakdown?: ContextBreakdown } | null>
  /** 「/」菜单目录(host 命令+技能)；null=还没有可用快照（cold/failed，见 `needsSlashList`） */
  slashCatalog: Signal<{ commands: SlashCommandInfo[]; skills: SlashSkillInfo[] } | null>
  /** 「@」引用候选(文件/目录+会话)；null=尚未拉到/换会话清空；query=该候选对应的查询串 */
  atCatalog: Signal<{ query: string; files: AtFileRef[]; sessions: AtSessionRef[] } | null>
  /** plan 协作状态(投影 plan)；null=未启用/无该能力 */
  planState: Signal<{ active: boolean; pending: boolean } | null>
  /** 会话目标(投影 goal)；null=无目标/能力缺失。目标条的数据源（形状按上游 GoalProjection.goal）。
   *  `id`/`revision` 是**动作的 CAS 引用**（上游 `GoalRef`）——缺任一个就只能只读展示，动不了。 */
  goalState: Signal<GoalView | null>
  /**
   * 目标条的 process-local activation（`armed`/`disarmed`；`{}` = 没有当前目标或还没读到）。
   *
   * 它是**另一条来路**（`goals/get` + `goal/activation-changed`，见 `GoalActivationView` 的注释），
   * 与 `goalState` 同帧到达但**不保证同一个目标**：用时按 `(id, revision)` 对账。
   */
  goalActivation: Signal<GoalActivationView>
  /**
   * 目标条的动作（edit/pause/resume/clear）：交给宿主打上游 goal RPC 并等回执。
   * 不走 `/goal` 命令 —— 命令要下一轮才被 agent 处理，而这些按钮是即时操作（上游同口径）。
   * @returns 失败时 `{error: '<message> (<code>)'}`；成功 `{}`（新目标随投影帧回来）
   */
  goalAction(action: 'edit' | 'pause' | 'resume' | 'clear', objective?: string): Promise<{ error?: string }>
  /** 任务清单（宿主从 `todo/write` 事件折叠后整表下发）：输入框上方常驻卡片的数据源；
   *  空数组 = 没有清单（卡片整块不渲染）。它不是行 —— 清单不属于任何一个回合 */
  todos: Signal<TodoItem[]>
  /** 排队消息（宿主下发的整表；队列卡数据源）。**不是行** —— 队列不属于任何回合，空数组 = 卡片不渲染 */
  queueItems: Signal<QueueItemView[]>
  /** 本地「发送中」的排队条目（忙时提交后立刻显示；宿主队列帧按 `rpcId` 认领即消失） */
  queueSending: Signal<QueueSending[]>
  /** 正在行内编辑的排队项；null = 没有在编辑 */
  queueEditing: Signal<QueueEditing | null>
  /** 正在提交变更的条目标识：该行三个按钮禁用；null = 空闲 */
  queueBusy: Signal<string | null>
  /** 对话区末尾的 pending 插话气泡（还没进日志的插话：服务端收件箱里的 steering 项 + 本地回显） */
  pendingSteering: Signal<PendingSteering[]>
  /** 上游「设置 → 通用设置 → 工作步骤展示」的只读镜像（四档 → 插件两档）：
   *  compact=定稿收起成折叠头（上游 compact/standard/detailed 三档都收起），normal=过程行平铺（仅上游 verbose）。
   *  全局偏好，**不随会话切换清空**（见 store/prefs）。 */
  transcriptView: Signal<'normal' | 'compact'>
  /** 上游「性能与用量」：`compact` 时不显示会话统计与每轮用量 */
  performanceUsage: Signal<'compact' | 'detailed'>
  /** 上游「代码工作工具」（默认开）：关掉时不显示会话模式选择器与交付卡片 */
  developerTools: Signal<boolean>
  /** 上游「繁忙时的发送行为」：空闲/繁忙时按 Enter 的投递方式；加速键（Ctrl/Cmd+Enter）取相反值 */
  busyEnter: Signal<'queue' | 'steer'>
  /** 上游四档策略门（`presentation-policy.ts`）：已定稿思考行是否在标题旁预览首行（`compact` 关） */
  settledReasoningPreview: Signal<boolean>
  /** 上游四档策略门：进行中是否显示过程细节（`compact`/`verbose` 关） */
  liveProcessDetail: Signal<boolean>
  /** 上游四档策略门（`presentation-policy.ts` 的 `stepGrouping`）：过程分组头的覆盖范围 ——
   *  `collapsed`=所有回合都有（含进行中）、`history`=仅已关闭回合（进行中平铺）、`none`=不分组。
   *  消费点在 `core/process-fold.ts`（决定进行中回合出不出折叠头）。 */
  stepGrouping: Signal<'collapsed' | 'history' | 'none'>
  /** 渲染源开关（宿主下发，见 docs/design/08 §11）：true = 页面只认宿主下发的「行」，
   *  忽略旧的渲染指令（两条通路二选一，不能同时改列表）。 */
  /** 上游 waterfall 提问弹窗（输入框上方）：pending 时让用户选择/提交/取消/关闭；null=无 */
  pendingQuestion: Signal<{ rpcId?: string; sessionId?: string; questions: QuestionSpec[]; callId?: string } | null>
  /** 仍可补答的限时提问（投影 `userQuestions` 里 `state === 'continued'` 的那些；阻塞式会话恒空） */
  lateCalls: Signal<LateAnswerCall[]>
  /** 正在补答的那一条；非 null 时提问弹窗进入补答模式 */
  lateDraft: Signal<{ callId: string; questions: LateAnswerQuestion[] } | null>
  /** 该条调用当前是否该显示补答入口（已提交过的先收起来，等投影收敛） */
  canAnswerLate(callId: string): boolean
  /** 点提问卡上的「回答」：用该条的问题清单进入补答模式 */
  openLateDraft(callId: string): void
  closeLateDraft(): void
  /** 提交补答（经宿主走补答通道；作答会成为新一轮用户消息） */
  submitLateAnswer(callId: string, answers: LateAnswerItem[]): void
  /** 主动触底请求计数：用户发送/恢复会话时 +1（MessageList 消费后清零并强制滚到底） */
  scrollPend: Signal<number>
  /** 更早的历史还没进窗口（宿主事实）：列表顶端据此出「加载更早」。 */
  historyHasMore: Signal<boolean>
  /** 「加载更早」这一页是否在飞（宿主事实）：按钮据此禁用并换成进行时文案。 */
  historyLoading: Signal<boolean>
  /** 当前窗口里的事件条数（诊断与直观量，不参与判定）。 */
  historyEvents: Signal<number>
  /** 记下宿主给的窗口事实（随 `rows` 帧一起来）。 */
  applyHistory(info: {
    hasMore?: boolean
    loading?: boolean
    events?: number
    /** 整表语义：`null` = 没有失败（用来清掉横幅） */
    openError?: { message: string; code?: string } | null
  }): void
  /** **打开历史失败**的事实（上游 `openState === 'error'` + `openError`）：列表顶端横幅读它。 */
  sessionOpenError: Signal<{ message: string; code?: string } | undefined>
  /** 往前翻一页历史（宿主读更早一页并 prepend）；在飞时不重复发。 */
  loadOlder(): void
  /**
   * 回合级过程折叠的展开态（key = 会话内回合号）。
   *
   * 为什么按回合而不是按行：过程折叠是**回合级**的 —— 上游只有 `turn-process` 那一个控制节点渲染
   * 折叠头，被它收起来的是整个回合过程区间里的节点；一个回合被插话切成多段行时，这些行共用同一个
   * 展开态。未记录的回合按默认值（进行中展开、定稿收起）。
   */
  turnFoldOpen: Signal<ReadonlyMap<number, boolean>>
  /** 记下某个回合的折叠展开态。 */
  setTurnFoldOpen(turn: number, open: boolean): void
  /**
   * **片**级过程折叠的展开态（B′：按片渲染后各片独立开合），键 = `${turn}:${group.key}`。
   *
   * 为什么另立一个信号而不是把 `turnFoldOpen` 的键改成字符串：整回合路径（无 `groups` 的旧宿主 /
   * 片数对不上的回退）仍按 `turn` 走；两条路径的键**同时存在**、互不干扰，回退时旧键自然还在。
   * 回合号是**会话内**编号，所以换会话要整表清掉（与 `turnFoldOpen` 同一处清理）。
   */
  groupFoldOpen: Signal<ReadonlyMap<string, boolean>>
  /** 记下**某片**的折叠展开态（键由 `turn` 与片的稳定 key 拼出）。 */
  setGroupFoldOpen(turn: number, groupKey: string, open: boolean): void
  /**
   * **外层折叠**的"已唤出世代"（上游 `turnProcesses {turn, answerStep}`）：键 = 会话内回合号。
   *
   * 缺省（没记录）= 已关闭的回合只留**当前回答世代**可见，更早的世代整片用 `hidden="until-found"`
   * 折起（可被网页查找命中、命中即唤出）。用户唤出后记下当前 `answerStep`，之后就按记录判定。
   * 键是会话内回合号，换会话整表清。
   */
  outerAnswerStep: Signal<ReadonlyMap<number, number>>
  /** 记下某回合"已唤出到的回答世代"（点开隐藏片 / 网页查找命中时调用）。 */
  revealOuter(turn: number, answerStep: number): void
  /** 反向：清掉该回合的"已唤出世代" → 回到"只留当前世代"的折起状态（完成态行上的 chevron 用它收起）。 */
  foldOuter(turn: number): void
  /** 附件字节缓存（附件大类，按 attachmentId；子类卡渲染时读） */
  attachmentCache: Signal<Record<string, AttachmentEntry>>
  // ---- 消息反馈（👍/👎） ----
  /** 当前会话已记录的评价（messageId → 评价 + 版本）；懒加载，换会话清空 */
  feedbackItems: Signal<ReadonlyMap<string, { rating: 'positive' | 'negative'; version: string }>>
  /** 「提交反馈」弹窗；null = 未打开 */
  feedbackDialog: Signal<{ messageId: string; rating: 'positive' | 'negative'; category: string | null; note: string; submitting: boolean; errorCode: string | null } | null>
  /** 结果提示（成功/失败），显示后由组件自行计时清除 */
  feedbackToast: Signal<{ text: string; tone: 'ok' | 'error'; id: number } | null>
  /** 分类 id 全表（宿主下发一次） */
  feedbackCategories: Signal<readonly string[]>
  /** 首次悬停/聚焦时读一次反馈表（懒加载，见 store/feedback） */
  ensureFeedbackLoaded(): void
  /** 点 👍/👎：同一评价 = 撤回，否则开弹窗（与上游同判定） */
  chooseFeedback(messageId: string, rating: 'positive' | 'negative'): void
  editFeedbackDialog(patch: { category?: string | null; note?: string }): void
  submitFeedbackDialog(): void
  closeFeedbackDialog(): void
  permNameOf: Map<string, string>
  // 动作
  /** 发送。忙时 mode 决定去向：queue = 排队（默认）、steer = 插话；空闲恒排队 */
  send(mode?: 'queue' | 'steer'): void
  cancel(): void
  /** 打开某条排队消息的行内编辑（含非文本附件的条目不该调它） */
  editQueueItem(id: string, text: string): void
  /** 保存行内编辑（空文本不发；是否生效以队列帧为准） */
  saveQueueEdit(): void
  cancelQueueEdit(): void
  /** 删除一条排队消息 */
  removeQueueItem(id: string): void
  /** 把一条排队消息转成插话（投到当前回合的下一步） */
  steerQueueItem(id: string): void
  /** 把当前所有排队消息按顺序转成插话（输入为空时的加速键手势） */
  steerWholeQueue(): void
  /** 行首 `/` 菜单需要目录时调用(宿主异步回 slashCatalog；在飞则并入、失败后按间隔自动重试)。
   *  `force = true` 为**按需强拉**（跳过失败后的间隔限制），用于回车裁决 `/xxx` 前补一次。 */
  requestSlashList(force?: boolean): void
  /** 手头没有可用「/」目录且没有在飞的拉取（cold/failed）——菜单据此决定要不要补拉。
   *  「ready + 空」为 false：那是服务端明确回答「这个会话没有命令/技能」。 */
  needsSlashList(): boolean
  /** 按查询串请求「@」候选(文件/目录+会话)；宿主异步回 atCatalog，最新查询 wins */
  requestAtList(query: string): void
  /** 执行一条 dsh 斜杠命令(发宿主 slashRun；清空输入) */
  runSlash(text: string): void
  suggestion(p: string): void
  /** 从某条回答分叉出新会话（建子会话与切换在宿主）；seq = 该回答的事件序号 */
  forkAt(seq: number): void
  copy(text: string): void
  pickFile(): void
  addImage(img: ImageAttachment): void
  removeImage(i: ImageAttachment): void
  addAttachment(p: string): void
  /** 重试一次失败的上传 */
  retryUpload(key: string): void
  /** 按 attachmentId 懒取附件字节（已就绪/在飞时不重复发；失败可重试） */
  requestAttachment(attachmentId: string): void
  /** 在编辑器区打开文件（相对路径按 cwd 解析；line 为 1 起的行号） */
  openFile(path: string, line?: number, cwd?: string): void
  removeAttachment(key: string): void
  /** 添加一条 @ 引用贴片（文件/目录/会话） */
  addRef(kind: RefChip['kind'], label: string, token: string, detail?: string): void
  removeRef(key: number): void
  readImageFile(file: File): void
  togglePopup(w: 'perm' | 'model' | 'mode'): void
  /** 打开「仅模型列表的可搜索弹窗」（/model 斜杠入口用；与按钮的完整模型弹窗区分） */
  openModelSearch(): void
  /** 标记下一次 selectModel 是「/」菜单发起（结果追加到对话区）；按钮入口不调用。
   *  权限不在此列：切权限在对话区不显示任何行（上游 `isVisibleChatNode()` 排除权限命令）。 */
  markSlashPick(kind: 'model'): void
  closePopups(): void
  selectPerm(value: string): void
  selectModel(provider: string, model: string, effort?: string): void
  selectMode(id: string): void
  /** 查看某个会话模式声明的子插件组合（宿主 `agentPresets/read` → 打开只读 YAML）【v0.1.15 · dsh 0.1.7】 */
  openModeConfig(agentPreset: string): void
  answerApproval(approvalId: string, allow: boolean, key: number): void
  submitQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined, answers: Array<{ id: string; selected: string[]; custom?: string }>): void
  cancelQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined): void
  showNotice(text: string, command?: string, tone?: 'error' | 'ok'): void
  onHostMessage(m: HostToViewMessage): void
}
