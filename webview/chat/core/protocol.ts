/**
 * 宿主 ↔ 聊天页 协议类型(单一来源)。
 * 约束:消息 type 名与 payload 形状与宿主侧(src/extension.ts、src/titlebar/selfDrawn)
 * 一字不差 —— 宿主不改,这里就是聊天页侧的权威契约;改协议必须同步两侧。
 * 标题栏(selfDrawn)专属消息也在本文件,归 titlebar driver 消费。
 */

// ---------- 共享形状 ----------
/** 任务清单条目（宿主侧折叠 `todo/write` 后下发的形状；两侧同一定义，页面侧叫 TodoItem）。 */
import type { DshTodoItem as TodoItem } from '../../../src/dsh/rows/types'
export type { TodoItem }

// 排队项的展示形状由宿主侧定义（与行、清单同一做法）：形状改动只落在宿主，页面只消费。
// 它**不是行**：队列不属于任何回合，也不进对话流。
import type { DshQueueItemView as QueueItemView } from '../../../src/dsh/queue-types'
export type { QueueItemView }

// 上下文占用的形状同样由宿主侧定义（只类型、零运行时）：页面只消费，不解析原始投影。
import type {
  DshContextBreakdown as ContextBreakdown,
  DshContextPressure as ContextPressure,
} from '../../../src/dsh/context-types'
export type { ContextBreakdown, ContextPressure }

export interface ImageAttachment {
  mediaType: string
  data: string
  name: string
}

/** 附件引用（图片）：事件里只有引用、没有字节，字节由附件层按需取（见 store/attachments）。 */
export interface AttachmentRef {
  attachmentId: string
  mediaType: string
  name?: string
  /** 固有像素宽（图廊按它定尺寸） */
  width?: number
  /** 固有像素高 */
  height?: number
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionSpec {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

export interface ChatModelGroup {
  id: string
  name: string
  models: Array<{
    id: string
    name: string
    description?: string
    reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string }
  }>
}

export interface ChatModelInfo {
  current?: { provider?: string; model?: string; reasoningEffort?: string }
  groups?: ChatModelGroup[]
  /** 上游对加载失败 provider/组的提示（上游形状未定型，原样透传，UI 只显示组数） */
  failures?: unknown[]
}

export interface PermissionOption {
  value: string
  name: string
  description?: string
}

export interface ChatAgentPreset {
  id: string
  name?: string
  description?: string
  isDefault?: boolean
  broken?: string
}

/** 「/」菜单：dsh 斜杠命令目录条目（commands/list 返回值）。 */
export interface SlashCommandInfo {
  name: string
  description: string
  /** 带参数命令的输入提示（如 permission 的 "<preset>"）。 */
  input?: { hint: string }
}
/** 「/」菜单：当前会话可用技能条目（skills/list 返回值）。 */
export interface SlashSkillInfo {
  name: string
  description: string
  /** 是否允许模型自行调用；false 时仅用户可调（用户斜杠发送仍可用）。 */
  modelInvocable: boolean
}

/** 「@」引用：文件/目录候选（fileReferences/list 返回；path 为相对工作区，无前导斜杠）。 */
export interface AtFileRef {
  path: string
  kind: 'file' | 'directory'
}
/** 「@」引用：会话候选（sessionReferenceResolver/candidates 返回；mention 即选中后应插入的正文 token）。 */
export interface AtSessionRef {
  sessionId: string
  label: string
  sameWorkspace?: boolean
  mention: string
}

// ---------- 宿主 → 页面 ----------
/** 消息反馈的评价取值（与上游 wire 字面量一致，不做本地映射）。 */
export type FeedbackRating = 'positive' | 'negative'

export type HostToViewMessage =
  | {
      type: 'chatApproval'
      approvalId?: string
      /** 上游 `request.reason`：审计原文（英文），`displayReason` 缺失时的回退文案 */
      description?: string
      /** 上游 `request.displayReason`（dsh 0.1.7-rc.2 新增）：本地化展示文案 `{ en, zh, … }` */
      displayReason?: Record<string, string>
      toolName?: string
    }
  | {
      type: 'chatQuestion'
      rpcId?: string
      sessionId?: string
      questions?: QuestionSpec[]
      /** 限时提问（dsh 0.2.0）的调用标识：超时后投影里就是同一个 `callId`。 */
      callId?: string
    }
  | { type: 'questionClosed'; rpcId?: string }
  // 账号类提示（宿主 `$events` 的 emit → 对话区一行）：文案由宿主按上游 locale 给全，
  // 页面不翻译、不拼接（与 notice 行同形，见 core/store/messages.ts 的 showNotice）
  | { type: 'notice'; text?: string; tone?: 'error' | 'ok' }
  // 提交失败（宿主侧本地失败：没有工作区 / 服务不可用 / RPC 报错）——**不是渲染指令**：
  // 它属于与审批、提问同一类的「交互事实」。为什么必须单开一条：这类失败发生在服务端**没有回合**的情况下，
  // 事件流里既不会有 turn/end、也没有对应的行，错误无处承载（行模型的 endMsg 只来自 turn/end）。
  // rpcId = 该次提交的标识，页面据此把对应那条本地乐观行标为「未提交成功」。
  // scope='queue' = **忙时提交失败**：只标掉队列卡里那条「发送中」，**不得**去定稿对话区里
  // 正在跑的回答行（那一轮不是这次提交的）。缺省 'turn' = 现有语义。
  | { type: 'chatError'; message?: string; rpcId?: string; scope?: 'turn' | 'queue' }
  // 排队消息（输入框上方的队列卡）：**整表替换**，`items` 为空即没有排队消息（卡片整块不渲染）。
  // 与「行」不同源：队列只在服务端的收件箱里、不进日志，它来自队列流的投影。
  | { type: 'queue'; sessionId?: string; items?: QueueItemView[] }
  // 队列动作失败（编辑 / 删除 / 转插话）：宿主只给动作与错误码，文案由页面按动作选。
  // 两种竞态（条目已被取走 / 回合已不在跑）宿主**不发**这一帧 —— 那表示「刷新即可」，不是错误。
  | { type: 'queueActionFailed'; op: 'edit' | 'remove' | 'steer'; code?: string }
  // 上下文占用（发送按钮左侧的环）：两条投影各自可能缺失；都缺 = 该 dsh 没这个能力 → 页面不渲染那个环
  | { type: 'context'; sessionId?: string; pressure?: ContextPressure; breakdown?: ContextBreakdown }
  // 会话投影**整表**（会话统计 / token 用量 / plan / goal / 权限…）：来自宿主的 `session/control` 订阅，
  // 投影一变就推一份当前值。**整表语义**：收到即代表该会话此刻的全部投影（缺键 = 能力未组合）。
  // 页面的「会话统计 / Token 用量」两张卡读它，因此流式期间会跟着变（不是只在打开会话时刷一次）。
  | {
      type: 'projections'
      sessionId?: string
      values?: Record<string, unknown>
      /**
       * 目标条的 activation：`armed`（本进程可以自动续跑）/ `disarmed`（不能）/
       * `{}`（没有当前目标，或还没读到 —— 这两种在 wire 上同形，页面按投影的阶段再分）。
       *
       * 它**不是投影**（那个值从不落盘、故意不放进投影），另有一条来路（见宿主
       * `src/dsh/goal-activation.ts`）。跟投影**同一帧**下发是有意的：页面要拿它跟投影里的
       * 活跃目标按 `(id, revision)` 对账，对不上就当作"还不知道" —— 分两帧到就会错配。
       */
      goalActivation?: { id?: string; revision?: number; activation?: 'armed' | 'disarmed' }
    }
  // 任务清单（输入框上方的常驻条）：整表替换，`null`/缺省 = 没有清单（该区整块不渲染）。
  // 与「行」同源、但不是行：清单不属于任何一个回合，位置也不在对话流里。
  | { type: 'todos'; todos?: TodoItem[] | null }
  // 目标条动作的结果：失败时页面在条内联显示 `message (code)`（上游 GoalBar 同口径）；
  // `key` 原样回带，页面据此兑现对应的 Promise（见 core/host.ts 的 requestGoalAction）。
  | { type: 'goalActionResult'; key: string; action: 'edit' | 'pause' | 'resume' | 'clear'; error?: string }
  | { type: 'filePicked'; path?: string }
  | { type: 'fileUploaded'; key: string; receiptId?: string; name?: string; bytes?: number; error?: string }
  // 附件字节（附件大类）：结果帧只带附件引用，渲染层要显示时按 id 向宿主懒取
  | { type: 'attachmentBytes'; attachmentId: string; mediaType?: string; data?: string; error?: string }
  | {
      type: 'chatInfo'
      projections?: Record<string, unknown>
      /** 当前会话工作区根路径：终端卡 cwd 标签在工具调用未带 workdir 时兜底（上游同口径） */
      cwd?: string
      models?: ChatModelInfo
      agentPresets?: { presets?: ChatAgentPreset[] }
      agentPreset?: string
      agentPresetLocked?: boolean
    }
  // 显示偏好（全局，与会话无关）：单独一条轻消息，实时跟随只推它，不重拉 chatInfo 那串 RPC。
  // 四项都来自上游「设置 → 通用设置」（宿主 `dsh/settings.ts` 读 + `settings/document-updated` 跟随）；
  // 缺哪个字段 = 那个字段不改（宿主读不到设置时一个字段都不推）。
  | {
      type: 'chatPrefs'
      /** 工作步骤展示（上游四档 → 插件折叠两档：只有 `verbose` 是平铺） */
      transcriptView?: 'normal' | 'compact'
      /** 性能与用量：`compact` 时不显示会话统计与每轮用量 */
      performanceUsage?: 'compact' | 'detailed'
      /** 代码工作工具（上游 `ui-settings.enabled`，默认开）：关掉时不显示会话模式选择器与交付卡片 */
      developerTools?: boolean
      /** 繁忙时的发送行为：空闲 Enter 的投递方式；加速键取相反值 */
      busyEnter?: 'queue' | 'steer'
      /** 上游四档策略门：已定稿思考行是否预览首行（`compact` 关，其余三档开） */
      settledReasoningPreview?: boolean
      /** 上游四档策略门：进行中是否显示过程细节（`compact`/`verbose` 关，`standard`/`detailed` 开） */
      liveProcessDetail?: boolean
      /** 上游四档策略门：过程分组头的覆盖范围（`collapsed` 所有回合 / `history` 仅已关闭回合 / `none` 不分组） */
      stepGrouping?: 'collapsed' | 'history' | 'none'
    }
  // 宿主下发的「行」（阶段 4 切渲染源后页面据此渲染；开关关闭时不下发，见 docs/design/08 §11）。
  // 形状为宿主侧的行模型（`src/dsh/rows/types.ts`），页面消费时做一次映射。
  | {
      type: 'rows'
      rows?: unknown[]
      /**
       * **本帧变了/新增的行**（§3.3 的"只发变动的行"）：与 `rowKeys` 一起给。
       * 页面按 `key` 覆盖缓存，再按 `rowsKeys`（原文 `rowKeys`）重排 —— 结果与整表逐字节等价。
       */
      rowDelta?: unknown[]
      /** **全量顺序**（行的 `key`）：几百个小整数，每帧全发也不值一提；页面靠它拼回渲染顺序。 */
      rowKeys?: number[]
      /** 该批行属于哪个会话（页面据此丢弃上一个会话的本地乐观行） */
      sessionId?: string
      /** 本会话是否有一轮**正在跑**（显式事实：页面据此决定「停止」按钮可用，不从行推导） */
      turnActive?: boolean
      /** 更早的历史还没进窗口（窗口分页事实）：列表顶端据此出「加载更早」。 */
      historyHasMore?: boolean
      /** 「加载更早」这一页是否在飞（宿主侧的事实，页面按钮据此禁用）。 */
      historyLoading?: boolean
      /** 当前窗口里的事件条数（诊断用；页面只展示不判定）。 */
      historyEvents?: number
      /**
       * **打开历史失败**（上游 `openState === 'error'` 的 `chat.loadError` 横幅）。
       * **整表语义**：`null` = 当前没有失败（页面据此清掉上一条横幅）。
       */
      sessionOpenError?: { message: string; code?: string } | null
    }
  // 消息反馈的状态回帧（列表 / 写入结果 / 业务失败）。**不是渲染指令**：它只喂反馈切片。
  | {
      type: 'feedbackState'
      sessionId?: string
      items?: Array<{ messageId: string; rating: 'positive' | 'negative'; version: string }>
      /** 分类 id 全表（首次下发时带一次；页面按 `category.<id>` 取中文标签，认不出就回显 id） */
      categories?: string[]
      /** 业务失败码原样带（version-conflict / note-too-large / …），页面按码选文案 */
      errorCode?: string
      /** 成功写入了一条评价（成功后弹一次「感谢你的反馈」） */
      recorded?: boolean
    }
  | { type: 'draft'; text?: string }
  | { type: 'clear' }
  | { type: 'busy'; kind?: 'loading' | 'switching' | null }
  // 自绘标题栏专属(selfDrawn 模式才出现;原生模式宿主不发)
  | { type: 'panelState'; panelOpen?: boolean; viewMode?: 'internal' | 'browser' }
  | { type: 'selfInfo'; workspaceName?: string; panelOpen?: boolean; viewMode?: 'internal' | 'browser' }
  | {
      type: 'wsDropdownList'
      currentId?: string
      /** `newable: false` = 这一行不能"在此新开会话"（「未分组」没有工作区实体） */
      workspaces?: Array<{ workspaceId: string; name: string; current?: boolean; newable?: boolean }>
    }
  | {
      type: 'wsDropdownSessions'
      workspaceId?: string
      sessions?: Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current?: boolean }>
    }
  | { type: 'wsActionDone'; ok?: boolean; message?: string }
  // 「/」菜单：目录(命令+技能)与命令执行结果。
  // `slashCatalog` 两侧**都可缺**：缺 = 那一侧本次没拉到（拉取失败 / 服务没就绪），
  // 页面据此**保留原有目录**，不要把它当成「这个会话没有命令/技能」。两侧都缺 = 整次失败。
  | { type: 'slashCatalog'; commands?: SlashCommandInfo[]; skills?: SlashSkillInfo[] }
  | { type: 'slashResult'; ok?: boolean; command?: string; message?: string }
  // 「@」引用：候选(文件/目录 + 会话)，query=候选对应查询串
  | { type: 'atCatalog'; query: string; files: AtFileRef[]; sessions: AtSessionRef[] }

// ---------- 页面 → 宿主 ----------
export type ViewToHostMessage =
  | { type: 'ready' }
  // rpcId：本面板 mint 的提交标识，宿主拿它当 session/prompt 的 requestId；
  // 服务端回显 user/message 时带回同一值，页面据此认领本地已出的一行（避免重复出行）
  // mode：投递方式 —— 空闲发送恒 queue；忙时由键位决定（queue = 排队，steer = 插话，投到当前回合的下一步）
  | { type: 'chatSend'; text: string; images?: ImageAttachment[]; files?: Array<{ receiptId: string; name: string; path?: string }>; rpcId?: string; mode?: 'queue' | 'steer' }
  // 排队项变更（编辑 / 删除 / 转插话）：宿主转成服务端的队列变更调用，结果以队列帧为准（非乐观）。
  // edit 只带**文本**：含图/文件的条目在卡片上已被禁用编辑。
  | { type: 'queueUpdate'; itemId: string; action: { kind: 'edit'; text: string } | { kind: 'remove' } | { kind: 'steer' } }
  | { type: 'cancel' }
  // 从某条回答分叉出新会话（上游 `session/fork`）：atSeq 是该回答的事件序号，
  // 省略 = 从最后一条已完成回合分叉。宿主负责建子会话、升号并切过去。
  | { type: 'chatFork'; atSeq?: number }
  | { type: 'copy'; text: string }
  | { type: 'approvalResponse'; approvalId: string; allow: boolean }
  // 消息反馈（👍/👎）：list = 读全表（首次交互时懒加载）；rate = 写入/替换；retract = 撤回。
  // ifVersion 是**观察到的现值版本**（null = 首次评价），服务端据此做 CAS。
  | {
      type: 'feedback'
      op: 'list' | 'rate' | 'retract'
      messageId?: string
      rating?: 'positive' | 'negative'
      note?: string
      category?: string
      ifVersion?: string | null
    }
  | { type: 'questionResponse'; rpcId?: string; sessionId?: string; answers: Array<{ id: string; selected: string[]; custom?: string }> }
  | { type: 'questionCancel'; rpcId?: string; sessionId?: string }
  /**
   * 补答一道**限时提问**（超时后转入「已继续」态的那些）：
   * 走宿主侧另一条远端调用，补答会作为新一轮用户消息被投递（与上面的 `questionResponse` 不是同一条路）。
   */
  | { type: 'questionLateAnswer'; sessionId?: string; callId: string; answers: Array<{ id: string; selected: string[]; custom?: string }> }
  | { type: 'chatSelectPermission'; preset: string }
  | { type: 'goalAction'; key: string; action: 'edit' | 'pause' | 'resume' | 'clear'; objective?: string }
  | { type: 'chatSelectModel'; provider: string; model: string; reasoningEffort?: string }
  | { type: 'chatSelectMode'; agentPreset: string }
  // 查看某个会话模式声明的子插件组合（宿主 agentPresets/read → 打开只读 YAML）【v0.1.15 · dsh 0.1.7】
  | { type: 'chatModeConfig'; agentPreset: string }
  | { type: 'pickFile' }
  | { type: 'attachmentReq'; attachmentId: string }
  // 在编辑器区打开一个文件（相对路径由宿主按 cwd 解析）；line 为 1 起的行号
  | { type: 'openFile'; path: string; line?: number; cwd?: string }
  // 文件上送：webview 只给路径，字节由宿主读并上传；key 由 webview 生成（多文件并发对得上）
  | { type: 'fileUploadReq'; key: string; path: string }
  // 自绘标题栏专属
  | { type: 'titleAction'; cmd: string }
  | {
      type: 'wsDropdown'
      op: 'list' | 'sessions' | 'wsnew' | 'session' | 'new'
      workspaceId?: string
      sessionId?: string
    }
  | { type: 'selfInfoReq' }
  // 「/」菜单：请求目录(命令+技能)、执行一条 dsh 斜杠命令
  | { type: 'slashListReq' }
  | { type: 'slashRun'; text: string }
  // 「@」引用：按查询串请求文件/会话候选
  | { type: 'atListReq'; query: string }
  // 往前翻一页历史（对齐上游 `ISession.loadOlder()`）：宿主读更早的一页并 prepend 到窗口，
  // 然后用 `rows` 帧（带 `historyHasMore`/`historyLoading`）回答。页面在飞时不重复发。
  | { type: 'loadOlder' }
