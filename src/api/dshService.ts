// 服务层：面向 UI 的干净接口。UI 层只依赖本模块；dsh 协议层在 src/dsh/（门面 src/dsh/index.ts）。
// 职责：进程管理、共享会话、对话、DSH 面板、查看模式、全量 DSH API 通用通道。
import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcess, type SpawnOptions, type StdioOptions } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
    DEFAULT_DSH_PORT,
    getEndpoint,
    setEndpoint,
    onEndpointChange,
    probeDsh,
    probeCapabilities,
    setCapabilities,
    createSession,
    sendPrompt,
    forkSession as forkSessionRpc,
    cancelSession,
    interruptSubagent,
    listMessageFeedback,
    putMessageFeedback,
    deleteMessageFeedback,
    type MessageFeedbackItem,
    type FeedbackOutcome,
    type FeedbackRating,
    type FeedbackCategory,
    getSessionProjections,
    activeGoalRefOf,
    readGoalActivation,
    sameGoalActivation,
    subscribeGoalActivation,
    type DshGoalActivation,
    type DshEndpoint,
    type DshReplyStats,
    type DshTurnCounts,
    type DshApproval,
    type DshContentPart,
    type DshQuestionRequest,
    lateAnswerArgs,
    type DshLateAnswerItem,
    type SessionMessageItem,
    rpcCall,
    runSessionCommand,
    readSessionAttachment,
    modelCatalog,
    workspaceList,
    dshEvents,
    followSession,
    buildRowsIncremental,
    type RowsFoldCheckpoint,
    foldTodos,    type DshFollowHandle,
    type DshFollowWindow,
    type DshStreamEvent,
    type DshStreamRow,
    type DshTodoItem,
    type DshChangesSummary,
    followControl,
    type DshQueueItem,
    type DshControlHandle,
    // 0.1.7 起 permissions 投影只剩 currentValue，选项目录在进程级 remote —— 见 currentProjections
    withPermissionOptions,
    readPermissionPresetCatalog,
    type DshPermissionPresetOption,
    updateQueue as updateQueueRpc,
    type DshPromptMode,
    type DshQueueAction,
    readContextPressure,
    readContextBreakdown,
    HISTORY_PAGE,
    pageSessionEvents,
    HistoryWindow,
    type WindowChange,
    type DshContextFacts,
    // 回合改动摘要（Host 内存态）：回合尾部「改动文件卡」的数据源，见 withChangesSummaries
    fetchChangesSummary,
    listAgentPresets as listAgentPresetsRpc,
    selectAgentPreset as selectAgentPresetRpc,
    readAgentPreset as readAgentPresetRpc,
    readChatPrefs as readChatPrefsRpc,
    getCachedChatPrefs as getCachedChatPrefsRpc,
    subscribeChatPrefs as subscribeChatPrefsRpc,
    type DshAgentPresetRoster,
    type DshAgentPresetDocument,
    type DshChatPrefs,
    DshRpcError,
} from '../dsh';
import { sessionDisplayTitle } from '../dsh/official/session-title';
import { initialContinuity, judgeAssistantFrame } from '../dsh/stream-continuity';
import { foldTurnState, openFromTurnBoundary, windowHasOpenTurn } from '../dsh/turn-state';
import { stopTargetOf, type DshSubagentAddress } from '../dsh/stop-target';
import { liveChunkSeq } from '../dsh/official/live-chunk-seq';
import { expandAssistantStream } from '../dsh/official/assistant-stream';

const NODE_REQUIREMENT = '^22.19.0 || >=24.0.0';
/**
 * 「上次自起的那个实例」在 globalState 里的落盘键：`{ port, pid?, authUrl? }`。
 *
 * 为什么需要：自起用的是 `--port 0`（随机端口），而重新发现只探 `dsh.port` / 3080 ——
 * 于是扩展宿主被强杀 / 崩溃后，旧实例还在跑却找不回来，下次又起一个，端口与进程越堆越多。
 * 落盘后下次先探它、探到就复用。
 */
const OWNED_ENDPOINT_KEY = 'dsh.ownedEndpoint';

/**
 * 断点续折的校验抽样：每这么多次**复用旧断点**的构建，全量重折一遍做逐字节比对。
 *
 * 校验不便宜（一次全量 = 几百毫秒），而它防的是「断点折叠与全量折叠不等价」——
 * 那种问题的判据在**真实会话**上（`tmp/_rows.checkpoint.test.mjs` 已逐回合钉住），
 * 生产里再按轮次抽样属于兜底：真出现了就自愈，而不是让正文悄悄错一段。
 */
const CHECKPOINT_VERIFY_EVERY = 5;

/**
 * 投递节流里「每 MB 载荷记多少毫秒」。
 *
 * 整表下发的载荷与窗口长度成正比（实测 48 回合 = 17MB、`stringify` 78ms），页面侧还要解析与重渲。
 * 取 6ms/MB 是保守估计（比实测的 `stringify` 便宜），只用来避免「构建快了就以十几毫秒的间隔推十几 MB」。
 */
const PAYLOAD_MS_PER_MB = 6;

/**
 * 「这一轮还在跑吗」安全网轮询的周期（见 `startTurnWatch`）。
 *
 * 只在插件认为**有轮在跑**时开表，所以正常情况下它一次都不跑（权威投影帧先到就先停了）。
 * 2 秒是「别处停掉之后，按钮最多滞后这么久复位」与「一条轻量投影 RPC」之间的折中。
 */
const TURN_WATCH_INTERVAL_MS = 2000;

/**
 * 事件窗口**不设条数上界**（与上游一致）。
 *
 * 上游 `session-controller/src/client` 里只有**取数页大小**（`PAGE_MESSAGES = 50` /
 * `JUMP_PAGE_MESSAGES = 200`），窗口本身按 `seq` 合并、**从不按条数裁剪**（`contract/events.ts`
 * 的 `publish`），显示量交给渲染层虚拟化。长会话卡顿的正解是**渲染层虚拟化**（登记在 `12` §3.3，
 * B 类待办），不是删数据。
 */

/** 进程是否还活着（`kill(pid, 0)` 只做存在性探测；`EPERM` 说明存在但没权限动它）。 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** 工作区视图（workspace.list / workspace.create 返回） */
export interface WorkspaceView {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
    /** ISO-8601 创建时刻（dsh workspace 域持久化，同 workspace.json） */
    createdAt?: string;
    /** ISO-8601 最近一次落盘变更时刻（会话挂载/改名等会刷新；同 workspace.json 的 updatedAt） */
    updatedAt?: string;
}

/**
 * 解析 dsh web 打印的 URL 行（上游就绪信号，默认 printUrl=true）：
 *   dsh web: http://127.0.0.1:PORT?token=... (LAN: ...)
 * 只取第一段 loopback URL；拿不到端口返回 undefined。
 */
function parseWebUrlLine(text: string): DshEndpoint | undefined {
    const m = /dsh web: (https?:\/\/[^\s]+)/.exec(text);
    if (!m) {
        return undefined;
    }
    console.warn(`[dsh-debug] stdout 命中行=${m[0].trim()}`);
    try {
        const u = new URL(m[1].trim());
        const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
        if (!Number.isInteger(port) || port <= 0) {
            return undefined;
        }
        return { port, authUrl: u.href };
    } catch {
        return undefined;
    }
}

/** 工作区路径归一化（分隔符统一 /、去尾斜杠、小写）用于匹配 */
function normalizePath(p?: string): string {
    return (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 从 goal 投影里取出**CAS 引用** `{id, revision}`（上游 `GoalRef`）。
 *
 * 形状兼容两层：上游 `GoalProjection = { goal: GoalSnapshot, … }`（`goal/src/types.ts:107`），
 * 但也见过扁平写法（`{id, revision, phase, …}`），两种都收。
 * 缺 `revision` 时返回 undefined —— 没有版本号就无法 compare-and-set，宁可什么都不做也不盲打
 *（盲打会被服务端按"版本不符"拒掉，用户看到的是一个没头没尾的报错）。
 */
function goalRefOf(raw: unknown): { id: string; revision: number } | undefined {
    if (raw === null || typeof raw !== 'object') {
        return undefined;
    }
    const outer = raw as Record<string, unknown>;
    const nested = outer['goal'];
    const src = nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>) : outer;
    const id = src['id'];
    const revision = src['revision'];
    if (typeof id !== 'string' || id === '' || typeof revision !== 'number' || !Number.isFinite(revision)) {
        return undefined;
    }
    return { id, revision };
}

/** 上游 session.list 列表 item 的 durable title：优先顶层 title，回退 projectionValues / projections.values 里的 title。
 *  空/缺返回 undefined（交 sessionDisplayTitle 走 cwd basename / sessionId 兜底）。 */
function durableTitleOf(s: {
    title?: string;
    projectionValues?: Record<string, unknown>;
    projections?: { values?: Record<string, unknown> };
}): string | undefined {
    if (typeof s.title === 'string' && s.title.trim() !== '') {
        return s.title;
    }
    const pv = s.projectionValues ?? (s.projections?.values as Record<string, unknown> | undefined);
    const t = pv?.['title'];
    return typeof t === 'string' && t.trim() !== '' ? t : undefined;
}

/** 建会话需要工作区却没有（无任何 dsh 工作区、且没有可映射的 VS Code 文件夹时抛出）。
 *  上层据此提示“请先选择/创建工作区”，而不是静默建出“未分组”会话。 */
export class DshNoWorkspaceError extends Error {
    readonly code = 'NO_WORKSPACE';
    constructor() {
        super('请先选择或创建工作区，再开启会话');
        this.name = 'DshNoWorkspaceError';
    }
}


export class DshService {
    /**
     * 事件窗口（分页）：**它才是窗口的真正持有者**，`streamEvents` 只是它的只读视图。
     *
     * 为什么单列一个类：这段逻辑决定「用户能看到多早以前」，埋在服务里既没法单测、也看不清
     * 两条通路（打开历史 / 实时跟随）的差别。三种进窗口的方式各一个方法（见 `history-window.ts`）。
     * 上游对应物是 `SessionEvents` 的窗口。
     *
     * **窗口不按条数裁剪**（与上游一致）：上游只设取数页大小、窗口按 `seq` 合并、从不删。
     */
    constructor() {
        this.window = this.makeWindow();
    }

    private makeWindow(): HistoryWindow<DshStreamEvent> {
        return new HistoryWindow<DshStreamEvent>();
    }

    // 进程状态
    private dshProcess: ChildProcess | null = null;
    private dshStartedByUs = false;
    /** 自起实例的落盘位置（见 attachGlobalState / OWNED_ENDPOINT_KEY）。 */
    private ownedState: vscode.Memento | undefined;
    private dshStderr = '';
    private dshStdout = '';
    private ready = false;
    private starting = false;
    private ensurePromise: Promise<boolean> | undefined;
    // 共享会话（右键/对话/网页同一条线）
    private currentSessionId: string | undefined;
    /** 会话的常驻订阅句柄：会话切换时换掉（见 setCurrentSession）。 */
    private followHandle: DshFollowHandle | undefined;
    /** 队列的常驻订阅句柄：host-wide 一条流服务所有会话，**不随会话切换重开**（见 ensureControl）。 */
    private controlHandle: DshControlHandle | undefined;
    /** 各会话的队列整表缓存：队列只在收件箱里、不进日志，刷新后由队列流的首帧重建。 */
    private queueBySession = new Map<string, DshQueueItem[]>();
    /** 各会话的上下文占用缓存：由队列流（`session/control`）的投影帧与 chatInfo 快照共同填充。 */
    private contextBySession = new Map<string, DshContextFacts>();
    /**
     * 各会话的**投影值缓存**（`session/control` 的基线 + 逐键更新帧）。
     *
     * 上游客户端就是这套（`ProjectionValueStore`）：宿主只算一份，客户端按 key 存**完整值**。
     * 本插件相应地也存整份，投影一变就把**整表**推给页面（值很小、条数很少），
     * 页面因此拿到的永远是当前快照 —— 输入框下方的「会话统计 / Token 用量」在流式期间
     * 会跟着变（从前它们只在 `chatInfo` 快照时刷一次，所以整轮都不动）。
     */
    private projectionsBySession = new Map<string, Record<string, unknown>>();
    /**
     * 进程级权限预设目录（dsh 0.1.7 起由 `permissionPresets/catalog` 提供）。
     *
     * 为什么这里也留一份：`permissions` 投影在 0.1.7 只剩 `currentValue`，选项目录在**进程级**；
     * 而本类还有第二条投影来路 —— `session/follow` 快照（`refreshProjections` / `seedProjections`），
     * 它绕过 `control.ts` 的拼接。两条来路都要拼同一份目录，否则「换会话」时权限选择器又变回空。
     *
     * `undefined` = 还没读到（或该 dsh 版本没有这条 remote，如 0.1.5-rc.2）：
     * 此时原样透传，走该代投影自带的 options。
     */
    private permissionCatalog: DshPermissionPresetOption[] | undefined;
    /** 进程级权限目录是否已尝试读取（失败也不反复重试，避免每次投影推送都打一次 RPC）。 */
    private permissionCatalogRequested = false;
    /** 本会话收到的事件（保结构）：**行构建的唯一输入**；换会话时清空。 */
    private streamEvents: DshStreamEvent[] = [];
    /** 事件窗口的当前实例（不按条数裁剪；见 `history-window.ts` 的类注释）。 */
    private window: HistoryWindow<DshStreamEvent>;
    /**
     * **回合改动摘要**缓存（`seq` → 摘要 / `null` = Host 已经没有了），key 是行上的 `changesSeq`。
     *
     * 用途：回合尾部的「改动文件卡」。上游这张卡的数据来自 **Host 内存态**
     *（`GET /api/changes.summary`），Host 重启/会话释放后就拿不到了 —— 那时上游**也不显示**该卡
     *（`docs/design/12` §2.1.7）。所以本插件同样**问一次、拿到才画**，不自己从 `write`/`edit`
     * 调用重建（重建会让历史会话凭空多出上游没有的卡：2026-10-04 真机截图现象）。
     * `null` 也缓存（上游 `retryable: () => false`：一次说没有就不再重问）。换会话清空。
     */
    private changesSummaries = new Map<number, DshChangesSummary | null>();
    /** 正在取回的 `changesSeq`（避免同一帧里重复发起）。 */
    private changesSummaryPending = new Set<number>();

    /** 已收到的**持久**事件的最大序号（**不含**合成序号）：实时帧的合成序号以它为基准。 */
    private durableSeq = -1;
    /** 距上一条持久事件以来已收到的实时帧数：合成序号靠它保持帧间递增，持久事件一到即归零。 */
    private transientInGap = 0;
    /**
     * 本轮是否进行中。**提交这一刻就置真**，不等 `turn/start` 到达 ——
     * 否则从「用户消息回显（乐观行被认领）」到「turn/start 到达」之间有个窗口：
     * 那时既没有待认领的乐观行、事件流里也还没有 turn/start，
     * 页面据此算「处理中」会算成假 → 「终止」按钮中途变回「发送」并禁用（真机现象）。
     */
    private turnRunning = false;
    /**
     * 目标条的 **process-local activation**（上游 `GoalActivationSnapshot`：`armed` = 本进程可以
     * 自动续跑该目标、`disarmed` = 不能 / `{}` = 没有当前目标或还不知道）。
     *
     * 它**不在投影里**（上游明说 never persisted、deliberately absent），所以只能：
     * 读 `goals/get`（投影里的 goal 一变、或在跑翻转时，见 `refreshGoalActivation`）
     * + 接 `goal/activation-changed` 边沿（见 `ensureGoalActivationSubscription`）。
     * 按会话存；页面侧再按 `(id, revision)` 过滤（上游 `GoalDock` 同口径）。
     */
    private goalActivations = new Map<string, DshGoalActivation>();
    /** 激活边沿的订阅句柄（首次需要时建立；面板存续期常驻）。 */
    private goalActivationUnsub: (() => void) | undefined;
    /**
     * 本插件自己提交、还没结算的回合数。记账**只认自己提交的回合** ——
     * 别处（浏览器 / 另一个面板）驱动的回合同样会产生 `turn/end`，
     * 把它们一起记进来，消费记录就会把别人的用量算到本面板头上。
     */
    private ownPendingTurns = 0;
    /** 本批入列的事件里有本插件回合的 `turn/end`：结算等这一批的整表构建（见 flushRows）。 */
    private settlePending = false;
    /**
     * 已收到事件的 `seq`（**去重**）。重连时服务端会**重放**已收到的事件（同 `seq`），
     * 重复入列会让行构建把同一段正文累加两次 —— 真机现象：对话区出现**重复内容**，且只在
     * 重连时发生（偶现）。（快照合并那条路径本来就按 `seq` 去重，只有实时这条漏了。）
     */
    private seenSeqs = new Set<number>();
    /**
     * 等「本轮结束」的等待者。**骑在已有那条常驻订阅上** —— 不再每轮另开一条 `session/follow`：
     * 两条订阅会让临时流一断就被误判成回合失败（真机事故 `DSH 会话流关闭`），也多一个订阅者扰动会话生命周期。
     */
    private turnWaiters: Array<{ sessionId: string; afterSeq: number; settle: (error?: Error) => void }> = [];
    /**
     * 本会话的窗口是否已收到过**首帧快照**。没收到时水位（`durableSeq`）还是 -1，
     * 拿它当基线会把快照回放里的**历史** `turn/end` 当成刚刚结束的那一轮。
     */
    private windowSeeded = false;
    /** 等首帧快照的就绪者（见 awaitWindowSeeded）。 */
    private seedWaiters: Array<() => void> = [];
    // ---------- 实时增量的连续性（不连续就重开订阅定基，而不是继续攒一个带洞的正文） ----------
    /**
     * 增量流的连续性状态（判据全在 `dsh/stream-continuity.ts`，那是**纯函数**、可脚本驱动）。
     *
     * 要点：`revision` **只记不判**。订阅是**中途**打开的，服务端只为当前订阅者广播之后的帧，
     * 「快照 revision」与「第一帧 revision」之间差几帧是常态；拿它当判据会让**每次开着流式打开/重连
     * 都必然触发一次"重新定基"**（整窗替换 + 断点作废 + 全量重折）—— 观感就是"卡一下、然后一下刷出来"。
     * 上游客户端同样不校验 revision，它只校验 `attemptId` + `index`。
     */
    private continuity = initialContinuity();
    /** 正在重开订阅：避免同一次不一致触发多次。新快照到达（adoptBaseline）即解除。 */
    private rebaselining = false;
    /** 连续「打开页缺基线」的次数：只重试一次，仍缺就降级继续（防与不合规的服务端死循环）。 */
    private missingBaselineStreak = 0;
    /** 上一条已下发的任务清单指纹（去重用；窗口重建时清掉，见 emitTodos）。 */
    private todosKey = '';
    /** 合并窗口的定时器（见 emitRows）：非空 = 已排队，不重复安排。 */
    private rowsTimer: ReturnType<typeof setTimeout> | undefined;
    /** 上一次构建的耗时（毫秒）：节流的下限取它，慢会话不会把自己堆死。 */
    private lastBuildMs = 0;
    /**
     * 上一批行构建留下的断点（见 `buildRowsIncremental`）。
     *
     * 它把「一次构建遍历整个窗口」变成「只重折当前回合」：一个上百万事件的会话里，
     * 全量重折要 600ms 以上，而流式期间每一批事件都要重建一次 —— 跟不上时正文就停在半截，
     * 等回合结束一次性刷出来（真机现象「快到最后字不出了，然后一下刷出很多」）。
     * 窗口被替换（换会话 / 重定基）或历史前插时，断点自带的判据会判定失效并自动退回全量。
     */
    private rowsCheckpoint: RowsFoldCheckpoint | undefined;
    /** 断点校验的抽样计数：每 `CHECKPOINT_VERIFY_EVERY` 次新的断点全量核对一次（见 buildCurrentRows）。 */
    private checkpointUses = 0;
    /**
     * 上一次投递的行载荷大小（MB）。整表语义下它与窗口长度成正比：48 回合 / 105 万事件的会话是
     * **17MB**（`tmp/_buildrows.budget.probe.mjs`），`JSON.stringify` 一项就要 78ms。
     * 节流要把它算进去，否则「构建很快」会变成「十几毫秒推十几 MB」。
     */
    private lastPayloadMb = 0;
    /** 上次算出的 turnActive（诊断日志只在翻转且 DSH_RAWLOG 时打，见 flushRows）。 */
    private lastTurnActiveLogged: boolean | undefined;
    /** 权威回合状态（`turnBoundary` 投影）：undefined = 还没读到，此时退回窗口扫描。 */
    private turnOpenFromHost: boolean | undefined;
    /**
     * 已知的最大回合号（`turn/start` / `turn/end` 的 `turn` 字段）。
     *
     * 只用来挡**迟到的** `turn/end`：它会把刚起来的那一轮一起关掉（状态行消失、停止按钮复位），
     * 而这一轮其实还在跑。`turn/start` 必先于 `turn/end` 到达，所以「收官号 < 已知最大号」即迟到。
     */
    private lastTurnSeen = 0;
    /** 「这一轮还在跑吗」的安全网轮询（见 startTurnWatch）：只在插件认为有轮在跑时开表。 */
    private turnWatchTimer: ReturnType<typeof setInterval> | undefined;
    /** 当前会话的 `$events` 常驻订阅（审批/提问）。与回合无关：上游同口径（`ui-user-questions` 常驻监听）。 */
    private askHandle: (() => void) | undefined;
    /** 「无正文」自愈的重开次数（每会话限次：与服务端互相踢比缺正文更糟）。 */
    private reseedCount = 0;
    /** 已报过的「无正文」窗口形态（同一个形态只报一次，否则每次 flush 都刷屏）。 */
    private blankAnswerKey = '';
    // 当前工作区（缺省按 VS Code 文件夹自动解析，避免会话全部掉进"未分组"）
    private currentWorkspaceId: string | undefined;

    /** 更早的历史还没进窗口（页面「加载更早」的门）。 */
    historyHasMore(): boolean {
        return this.window.hasMore();
    }

    /**
     * **打开历史失败**的事实（上游 `openState === 'error'` + `openError`）：页面据此在列表顶端出一条横幅。
     * 读到过快照后就不再置（之后的断流属可重连的运行态，见 `follow.ts` 的 `sawSnapshot`）；换会话时清空。
     */
    private sessionOpenError: { message: string; code?: string } | undefined;

    /** 打开历史失败的事实（页面横幅读它；`undefined` = 没有失败）。 */
    sessionOpenFailure(): { message: string; code?: string } | undefined {
        return this.sessionOpenError;
    }

    /** 「加载更早」是否在飞（页面按钮据此禁用）。 */
    historyLoading(): boolean {
        return this.window.isLoadingOlder();
    }

    /** 当前窗口里的事件条数（诊断与直观量）。 */
    windowEventCount(): number {
        return this.window.size();
    }

    /** 立刻重算并下发行（「加载更早」收尾用：那一步不走事件到账的节流路径）。 */
    flushRowsNow(): void {
        this.flushRows();
    }

    /**
     * 「这一轮已经不在跑了」——**停止按钮被服务端接受之后**由宿主立刻置位并下发行。
     *
     * 为什么需要它：页面把「终止」态挂在 `rows` 帧的 `turnActive` 上，而那一帧平时只在
     * 事件到账时才重发。取消被接受后要先等服务端补发 `turn/end` 才复位 —— 那段空档里
     * 用户点完看不到任何变化。这里主动推一帧，让「点 → 按钮立刻回到发送态」这一步成立；
     * 随后真正的 `turn/end` 到达时再按权威事实覆盖。
     *
     * 只用于**已经确认取消被接受**的场合（`session.cancel` 返回成功），不是乐观猜测。
     */
    markTurnStopped(): void {
        this.turnRunning = false;
        this.turnOpenFromHost = false;
        this.flushRows();
    }

    /**
     * 往前翻一页历史并**前插**进窗口（对齐上游 `ISession.loadOlder()`）。
     *
     * 与「整窗替换」的区别：`session/follow` 的首帧快照是**替换**语义（它就是窗口本身），
     * 而这一页是**追加在窗口前面**的一段更早历史 —— 所以走 `prepend`：
     *   ① 以窗口最老事件的 `seq` 为 `beforeSeq` 读一页；
     *   ② 按 `seq` 去重后并入窗口（`appendEvents` 已有去重与排序）；
     *   ③ 用这一页的 `hasMore` 刷新「还有更早的吗」。
     *
     * 失败处理：**窗口不动、`loadingOlder` 复位**，由调用方记一条日志 —— 读不到更早的历史不是错误操作。
     */
    async loadOlderPage(): Promise<void> {
        if (this.window.isLoadingOlder()) {
            return;
        }
        const sessionId = this.currentSessionId;
        const oldest = this.window.oldestSeq();
        // `throughSeq` = 窗口里最新那条的 seq（服务端的"游标"）。**不能省略、更不能传 -1**：
        // 服务端按 `end = min(throughSeq + 1, beforeSeq)` 切页，-1 会切出空页 + `hasMore:false`，
        // 按钮就永远只会出现一次（真机："加载更早怎么就一次"）。
        const newest = this.window.newestSeq();
        // 窗口还没定基（没有快照）或已经到最老：没有可翻的页，别白跑一次 RPC
        if (sessionId === undefined || oldest === undefined || newest === undefined || !this.window.hasMore()) {
            return;
        }
        this.window.setLoadingOlder(true);
        // 先下发一次「加载中」：按钮要立刻变成进行时，而不是等这一页读完才反应
        this.flushRows();
        try {
            const page = await pageSessionEvents(sessionId, oldest, HISTORY_PAGE.maxMessages, newest);
            // 会话可能在读这一页期间被切走：此时这一页属于上一个会话，丢弃
            if (this.currentSessionId !== sessionId) {
                return;
            }
            // 前插：窗口**不裁**（这就是纯前插，已有的一段一条不动），
            // 并用**这一页**的 hasMore 刷新「还有更早的吗」——翻到底时按钮自然消失。
            this.applyWindowChange(this.window.prepend({ events: page.events, hasMore: page.hasMore }));
        } finally {
            this.window.setLoadingOlder(false);
        }
    }

    /** 窗口变过之后同步只读视图（窗口不裁剪，所以这里只做一次拷贝）。 */
    private applyWindowChange(_change: WindowChange): void {        this.streamEvents = [...this.window.list()];
    }

    /**
     * 通用通道：可调任意 DSH API（session / goal / subagent / workspace / llm / host ...）。
     * 新增功能只需调用 call(method, payload)，无需改动本层。
     */
    call<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
        return rpcCall<T>(method, payload);
    }

    // ---------- 进程 ----------

    private isNodeCompatible(version: string): boolean {
        const [major, minor] = version.split('.').map((s) => parseInt(s, 10));
        if (major === 22) {
            return minor >= 19;
        }
        return major >= 24;
    }

    private checkSystemNode(): Promise<{ ok: boolean; version?: string }> {
        return new Promise((resolve) => {
            execFile('node', ['--version'], (err, stdout) => {
                if (err) {
                    resolve({ ok: false });
                    return;
                }
                const version = (stdout || '').trim().replace(/^v/, '');
                resolve({ ok: this.isNodeCompatible(version), version });
            });
        });
    }

    /**
     * 组装插件自启 dsh web 的启动参数。
     * 固定部分始终包含 `web --no-open --port 0`（stdout 动态发现端口 + 不弹浏览器）；
     * `dsh.webArgs` 只追加额外参数（如 --host / --trusted-host），不负责选择哪个 dsh。
     */
    private launchWebArgs(): string[] {
        const base = ['web', '--no-open', '--port', '0'];
        const configured = vscode.workspace.getConfiguration('dsh').get<unknown>('webArgs', []);
        if (!Array.isArray(configured)) {
            return base;
        }
        const extra = configured
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
        return [...base, ...extra];
    }

    /**
     * 解析 dsh 启动器（动态识别，四档回退）：
     *   ① dsh.cliPath 显式 CLI 路径
     *   ② dsh.repoPath 源码仓（开发环境在 .vscode/settings.json 配置）→ 仓库根 `pnpm dsh web`
     *   ③ PATH 上的本机 dsh（dsh / dsh.cmd）
     *   ④ npx --yes @deepseek-ai/dsh 兜底
     * 不修改 dsh 任何文件。versionCmd 用于尽力捕获版本（诊断用）。
     */
    private async resolveDshLauncher(): Promise<{ cmd: string; args: string[]; cwd: string; versionCmd?: { cmd: string; args: string[]; cwd: string } }> {
        const isWin = process.platform === 'win32';
        const webArgs = this.launchWebArgs();
        // ① 显式 CLI 路径
        const cliPath = vscode.workspace.getConfiguration('dsh').get<string>('cliPath', '').trim();
        if (cliPath && fs.existsSync(cliPath)) {
            return {
                cmd: isWin ? 'cmd.exe' : cliPath,
                args: isWin ? ['/c', cliPath, ...webArgs] : webArgs,
                cwd: os.homedir(),
                versionCmd: {
                    cmd: isWin ? 'cmd.exe' : cliPath,
                    args: isWin ? ['/c', cliPath, '--version'] : ['--version'],
                    cwd: os.homedir(),
                },
            };
        }
        // ② 源码仓（仅开发调试，需在 .vscode/settings.json 配置 dsh.repoPath）→ 仓库根 `pnpm dsh web`
        const repoPath = vscode.workspace.getConfiguration('dsh').get<string>('repoPath', '').trim();
        if (repoPath && fs.existsSync(path.join(repoPath, 'package.json'))) {
            return {
                cmd: isWin ? 'cmd.exe' : 'pnpm',
                args: isWin ? ['/c', 'pnpm', 'dsh', ...webArgs] : ['dsh', ...webArgs],
                cwd: repoPath,
                versionCmd: {
                    cmd: isWin ? 'cmd.exe' : 'pnpm',
                    args: isWin ? ['/c', 'pnpm', 'dsh', '--version'] : ['dsh', '--version'],
                    cwd: repoPath,
                },
            };
        }
        // ③ PATH 上的本机 dsh
        const candidates = isWin ? ['dsh.cmd'] : ['dsh'];
        for (const cmd of candidates) {
            const found = await new Promise<boolean>((resolve) => {
                // Windows 用 where / POSIX 用 which：只查 PATH，不执行目标
                execFile(isWin ? 'where' : 'which', [cmd], { windowsHide: true }, (err) => resolve(!err));
            });
            if (found) {
                return {
                    cmd: isWin ? 'cmd.exe' : cmd,
                    args: isWin ? ['/c', cmd, ...webArgs] : webArgs,
                    cwd: os.homedir(),
                    versionCmd: {
                        cmd: isWin ? 'cmd.exe' : cmd,
                        args: isWin ? ['/c', cmd, '--version'] : ['--version'],
                        cwd: os.homedir(),
                    },
                };
            }
        }
        // ④ npx 兜底（版本捕获跳过，避免联网）
        return {
            cmd: isWin ? 'cmd.exe' : 'npx',
            args: isWin ? ['/c', 'npx', '--yes', '@deepseek-ai/dsh', ...webArgs] : ['--yes', '@deepseek-ai/dsh', ...webArgs],
            cwd: os.homedir(),
        };
    }

    /** 尽力捕获 dsh 版本（非阻塞；失败静默） */
    private captureVersion(vc: { cmd: string; args: string[]; cwd: string }): void {
        execFile(vc.cmd, vc.args, { cwd: vc.cwd, windowsHide: true, timeout: 8000 }, (err, stdout) => {
            if (err) {
                return;
            }
            const v = (stdout || '').trim().split(/\r?\n/)[0].trim();
            if (v) {
                setCapabilities({ version: v });
            }
        });
    }

    /** 启动 dsh web（--port 0 动态端口）；stdout 累积供 URL 行解析（P0-1） */
    private spawnDsh(): Promise<ChildProcess> {
        return new Promise((resolve, reject) => {
            void (async () => {
                try {
                    const launcher = await this.resolveDshLauncher();
                    const opts: SpawnOptions = {
                        cwd: launcher.cwd,
                        windowsHide: true,
                        stdio: ['ignore', 'pipe', 'pipe'] as StdioOptions,
                        ...(process.platform === 'win32' ? {} : { detached: true }),
                    };
                    const child = spawn(launcher.cmd, launcher.args, opts);
                    this.dshProcess = child;
                    this.dshStderr = '';
                    this.dshStdout = '';
                    if (launcher.versionCmd) {
                        this.captureVersion(launcher.versionCmd);
                    }
                    child.stdout?.on('data', (d: Buffer) => { this.dshStdout += d.toString(); });
                    child.stderr?.on('data', (d: Buffer) => { this.dshStderr += d.toString(); });
                    child.once('spawn', () => resolve(child));
                    child.once('error', (err) => reject(err));
                } catch (e) {
                    reject(e as Error);
                }
            })();
        });
    }

    /**
     * 等待子进程 stdout 出现 `dsh web: <url>` 行（含端口 + 鉴权 token）。
     * 超时或进程提前退出仍未出现 → undefined（回退探测默认端口）。
     */
    private waitForWebUrl(child: ChildProcess, timeoutMs: number): Promise<DshEndpoint | undefined> {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const timer = setInterval(() => {
                const ep = parseWebUrlLine(this.dshStdout);
                if (ep) {
                    clearInterval(timer);
                    resolve(ep);
                } else if (Date.now() > deadline) {
                    clearInterval(timer);
                    resolve(undefined);
                }
            }, 100);
            child.once('exit', () => {
                clearInterval(timer);
                resolve(parseWebUrlLine(this.dshStdout));
            });
        });
    }

    /**
     * 注入持久化存储（`context.globalState`）：用来记住**自起实例的端口与 pid**，下次先找它。
     * 不在构造里注入是因为 `dsh` 是模块级单例，只有 `activate(context)` 里才拿得到。
     */
    attachGlobalState(state: vscode.Memento): void {
        this.ownedState = state;
    }

    /**
     * 端点端口变化时，把**在途**的东西重新指向（见 `onEndpointChange` 的说明）。
     * 只动插件自己的连接与代理，**不碰服务端进程** —— 侧栏 / 本地面板 / 外部浏览器都连同一个实例，
     * 任何"重启服务"的动作都会把另外两个一起打断。
     */
    private watchEndpoint(): void {
        if (this.endpointWatch !== undefined) {
            return;
        }
        this.endpointWatch = onEndpointChange(() => {
            this.followHandle?.restart();
            dshEvents.restart();
            this.onEndpointChanged?.(getEndpoint().port);
        });
    }
    private endpointWatch: (() => void) | undefined;
    /** 端点变化的外部回调（装配层用来重绑本地网页代理并刷新内嵌面板）。 */
    onEndpointChanged: ((port: number) => void) | undefined;

    private killDshIfOwned() {
        const child = this.dshProcess;
        if (!child || !child.pid || !this.dshStartedByUs) {
            this.dshProcess = null;
            return;
        }
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch {
                try {
                    child.kill('SIGTERM');
                } catch {
                    /* 进程已退出 */
                }
            }
        }
        this.dshProcess = null;
        this.dshStartedByUs = false;
        // 我们自己把它杀了：落盘记录随之作废，否则下次会去探一个已死的端口
        void this.ownedState?.update(OWNED_ENDPOINT_KEY, undefined);
    }

    /**
     * 确保 DSH 服务在运行；未运行自动拉起并等待就绪。
     * 端点动态识别链路：① 探测既有实例（默认端口 3080）→ ② 启动器三档回退
     * （源码仓 pnpm dsh web / PATH dsh / npx）→ ③ 解析 stdout 的 URL 行（真实端口 + 鉴权 token）→ ④ 握手探测验证信封。
     */
    async ensureRunning(): Promise<boolean> {
        if (this.ensurePromise) {
            // 并发入口（聊天初始化/工作区/本地打开）共享同一次启动，等待其完成即可。
            return this.ensurePromise;
        }
        const task = this.runEnsure();
        this.ensurePromise = task;
        try {
            return await task;
        } finally {
            if (this.ensurePromise === task) {
                this.ensurePromise = undefined;
            }
        }
    }

    private async runEnsure(): Promise<boolean> {
        if (this.ready) {
            // 快速校验当前端点仍存活（DSH 可能已重启 / 换端口 / 停止），避免用旧端口
            const alive = await probeDsh(getEndpoint().port);
            if (alive.ok) {
                return true;
            }
            this.ready = false; // 失联：重置，走重新发现（探测默认端口或自启）
        }
        if (this.starting) {
            vscode.window.showInformationMessage('DSH 服务正在启动中，请稍候…');
            return false;
        }
        this.starting = true;
        try {
            // 装端点变化监听：此后任何一次端口变更都会让在途连接重新指向（见 watchEndpoint）
            this.watchEndpoint();
            // 显式配置的端口**优先于一切**：配了 `dsh.port` 就只认它，连"上次自起的实例"也不看
            const cfgPort = vscode.workspace.getConfiguration('dsh').get<number>('port', 0);
            // ① 先找**上次自起的那个实例**：还在就直接复用。
            //    它可能正被外部浏览器连着，所以复用**不接管清理**（`dshStartedByUs=false`）——
            //    停用插件不会把它杀掉，用户那边的浏览器视图继续可用。
            const remembered = cfgPort > 0
                ? undefined
                : this.ownedState?.get<{ port: number; pid?: number; authUrl?: string }>(OWNED_ENDPOINT_KEY);
            if (remembered !== undefined) {
                const alive = remembered.pid === undefined || isProcessAlive(remembered.pid);
                if (alive && (await probeDsh(remembered.port)).ok) {
                    setEndpoint({
                        port: remembered.port,
                        ...(remembered.authUrl === undefined ? {} : { authUrl: remembered.authUrl }),
                    });
                    this.dshStartedByUs = false;
                    this.ready = true;
                    console.warn(`[dsh-debug] 复用上次自起的实例 port=${remembered.port} pid=${String(remembered.pid)}`);
                    return true;
                }
                // 陈旧记录（进程没了 / 端口不通）：清掉再走正常发现
                await this.ownedState?.update(OWNED_ENDPOINT_KEY, undefined);
            }
            // ② 探测既有实例：dsh.port > 0 时严格指向该端口（未运行则报错，不自动启动）；
            //    否则探测默认端口 3080，命中直接复用（不接管清理）
            const probePort = cfgPort > 0 ? cfgPort : DEFAULT_DSH_PORT;
            const existing = await probeDsh(probePort);
            if (existing.ok) {
                setEndpoint(existing.endpoint);
                this.dshStartedByUs = false;
                this.ready = true;
                return true;
            }
            if (cfgPort > 0) {
                vscode.window.showErrorMessage(`dsh.port 配置的端口 ${cfgPort} 没有检测到 DSH 服务在运行`);
                return false;
            }
            // ② Node 版本检查
            const node = await this.checkSystemNode();
            if (!node.ok) {
                const pick = await vscode.window.showErrorMessage(
                    `未检测到可用的 Node.js（要求 ${NODE_REQUIREMENT}），启动 DSH 需要 Node 环境。`,
                    '打开 Node.js 官网',
                    '取消'
                );
                if (pick === '打开 Node.js 官网') {
                    vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
                }
                return false;
            }
            // ③ 启动（本机已安装 dsh 优先，npx 兜底）
            try {
                await this.spawnDsh();
                this.dshStartedByUs = true;
            } catch (e) {
                vscode.window.showErrorMessage(`启动 DSH 失败：${(e as Error).message}`);
                return false;
            }
            // ④ 等待 stdout URL 行（动态端口 + 鉴权 token）；超时回退探测默认端口
            const child = this.dshProcess;
            const discovered = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在启动 DeepSeek Harness 服务…' },
                () => (child ? this.waitForWebUrl(child, 90_000) : Promise.resolve(undefined))
            );
            if (discovered) {
                setEndpoint(discovered);
            }
            console.warn(`[dsh-debug] ensureRunning discovered=${JSON.stringify(discovered)}`);
            // ⑤ 握手探测：验证信封（P0-2）；失败给出明确原因而非难懂报错
            const probe = await probeDsh(discovered?.port ?? DEFAULT_DSH_PORT);
            console.warn(`[dsh-debug] probe ok=${probe.ok} authRequired=${probe.authRequired} reason=${probe.reason}`);
            if (!probe.ok) {
                const hint = (this.dshStderr.trim().split('\n').pop() || probe.reason || '未知错误').trim();
                vscode.window.showErrorMessage(`DSH 启动失败：${hint}`);
                this.killDshIfOwned();
                return false;
            }
            setEndpoint({ port: probe.endpoint.port, authUrl: discovered?.authUrl });
            // 记下这个自起实例：下次先找它，避免随机端口把实例越堆越多（见 OWNED_ENDPOINT_KEY）
            await this.ownedState?.update(OWNED_ENDPOINT_KEY, {
                port: probe.endpoint.port,
                ...(this.dshProcess?.pid === undefined ? {} : { pid: this.dshProcess.pid }),
                ...(discovered?.authUrl === undefined ? {} : { authUrl: discovered.authUrl }),
            });
            // 能力探测（P2）：mux WS 可用性决定审批/提问走 mux 还是 history 兜底
            setCapabilities(await probeCapabilities(probe.endpoint.port));
            if (probe.authRequired) {
                vscode.window.showWarningMessage(probe.reason ?? 'DSH 需要鉴权，请打开 dsh 网页面板完成登录');
            }
            this.ready = true;
            return true;
        } finally {
            this.starting = false;
        }
    }

    /** 扩展停用时收尾：回收 dsh 协议流与后台进程（Webview 面板由 DshPanel 先关闭）。 */
    dispose(): void {
        this.ready = false;
        // 已排队的合并窗口要丢掉：停用后再发一次行没有意义（页面可能已经没了）
        if (this.rowsTimer !== undefined) {
            clearTimeout(this.rowsTimer);
            this.rowsTimer = undefined;
        }
        // 等待者必须先放掉：订阅停了以后它们的收尾事件永远不会来
        this.settleTurnWaiters(new Error('会话服务已停用'));
        this.stopTurnWatch();
        this.controlHandle?.cancel();
        this.controlHandle = undefined;
        this.askHandle?.();
        this.askHandle = undefined;
        dshEvents.stop();
        this.killDshIfOwned();
    }

    // ---------- 共享会话 / 对话 ----------

    /** 取当前共享会话，没有则创建 */
    /** 行变更回调：装配层接到下发给页面的通道上（渲染**只剩这一条通路**，见 docs/design/08 §13）。 */
    onRows: ((rows: DshStreamRow[], turnActive: boolean) => void) | undefined;

    /**
     * 任务清单变更回调（输入框上方的常驻条；`null` = 没有清单）。
     *
     * 与行**同源**：都从 `streamEvents` 派生，因此只在 `emitRows` 那一处算 —— 两条通路各算一遍，
     * 「什么算当前清单」这件事迟早只落在一半。它不是行：清单不属于任何一个回合，位置也不在对话流里。
     */
    onTodos: ((todos: DshTodoItem[] | null) => void) | undefined;

    /**
     * 队列整表回调（输入框上方的队列卡；空表 = 没有排队消息）。
     *
     * 与行**不同源**：队列不在会话日志里，它只来自队列流的投影（见 ensureControl）。
     * 它与行一样是**整表**语义：收到即代表该会话当前的全部队列项，页面直接替换。
     */
    onQueue: ((sessionId: string, items: DshQueueItem[]) => void) | undefined;

    /**
     * 当前会话的**投影整表**回调（会话统计 / token 用量 / plan / goal / 权限…）。
     *
     * 与队列同一条流（`session/control`）、同样是整表语义：投影一变就推一份当前值。
     * 页面的输入框下方那两张卡就读它 —— 早先它们只在 `chatInfo`（打开会话/切换时）刷一次，
     * 于是流式期间「轮数/步数/token」整轮都不动，与网页端不一致。
     */
    /**
     * 投影整表变化（`session/control` 的投影帧 / `chatInfo` 基线）。
     *
     * 第三个参数是**目标条的 process-local activation**：它不是投影（上游明说 never persisted），
     * 但必须与投影**同帧到达**才不会被错配 —— 页面按 `(id, revision)` 与投影里的活跃目标对账，
     * 对不上就当作"还不知道"（上游 `GoalDock` 同口径）。
     */
    onProjections: ((sessionId: string, values: Record<string, unknown>, goalActivation: DshGoalActivation) => void) | undefined;

    /**
     * 事件窗口的诊断出口（写进扩展的 Output 面板，见 `extension.ts` 的 `logRows`）。
     *
     * 为什么单开一条：分页事实全在宿主侧（`hasMore`、快照多少条、进来多少条），
     * 页面上只看得到「列表变没变」—— 用户报「历史看不全 / 看不到『加载更早』」时无从自查。
     */
    onWindowLog: ((line: string) => void) | undefined;

    /**
     * 上下文占用回帧（发送按钮左侧那个环）。
     *
     * 单独一条轻帧：投影值本身很小，而 `chatInfo` 那串要跑几次 RPC —— 环每次更新都重推整串不值当。
     * 键缺失（该 dsh 没组合 token-meter）时下发空对象，页面据此整个不渲染那个环。
     */
    onContext: ((sessionId: string, value: DshContextFacts) => void) | undefined;

    /**
     * 本插件提交的回合结算回调（用量记账与统计刷新的**唯一时机**）。
     *
     * 空闲提交与忙时提交都经由它记账：先前只有空闲那条路（`askStreaming` 返回后）会记，
     * 忙时提交没有返回值可挂，只能收在事件层这一处（见 noteTurnSettled）。
     */
    onTurnSettled: ((info: { sessionId: string; stats: DshReplyStats; timeMs?: number }) => void) | undefined;

    /** 审批请求（对话行上的授权卡）：随会话常驻，不随回合开关。 */
    onApproval: ((a: DshApproval) => void) | undefined;

    /** 提问请求（输入框上方 waterfall 弹窗）：随会话常驻。 */
    onQuestion: ((q: DshQuestionRequest) => void) | undefined;

    /** 提问已失效（`$events` 断流、pending 作废）：UI 关掉弹窗，别留成死窗口。 */
    onQuestionClosed: ((rpcId: string) => void) | undefined;

    /**
     * 当前会话的唯一收口：标识一变就把常驻订阅换掉。
     * 为什么收在一处：订阅是事件层的地基（会话打开即订阅、与页面同生命周期），
     * 会话标识散在各处赋值会让"何时该换订阅"无从追踪。
     */
    private setCurrentSession(sessionId: string | undefined): boolean {
        if (this.currentSessionId === sessionId) {
            return false;
        }
        this.currentSessionId = sessionId;
        this.resetEvents();
        this.turnRunning = false; // 换会话：上一个会话的「进行中」不该带过来
        this.lastTurnSeen = 0; // 回合号是会话内的编号：换会话必须清零，否则会拦掉新会话的收官
        this.turnOpenFromHost = undefined; // 权威读数属于上一个会话，重读前先退回窗口扫描
        this.ownPendingTurns = 0; // 上一个会话没结算完的提交不再由本会话的 turn/end 结算
        // 新会话的窗口还没收到快照 → 水位不可信；同时把上一会话的等待者与就绪者放掉（否则它们永远挂着）
        this.windowSeeded = false;
        for (const resume of this.seedWaiters.splice(0)) {
            resume();
        }
        this.settleTurnWaiters(new Error('会话已切换，本轮等待已取消'));
        this.followHandle?.cancel();
        this.followHandle = undefined;
        // 审批/提问的常驻订阅随会话换（与 followHandle 同生命周期）
        this.ensureAskSubscription();
        if (sessionId !== undefined) {
            // 队列流是 host-wide 的：建一次就够（不随会话切换重开），这里只确保它已经在
            this.ensureControl();
            this.pushQueue();
            this.pushContext();
            this.pushProjections();
            // 换到没有缓存投影的会话（控制流基线里没有它）→ 主动要一份，别让卡片空着，
            // 也别让页面继续显示上一个会话的统计（重置由页面的 clear 帧负责，这里补新值）。
            if (this.projectionsBySession.get(sessionId) === undefined) {
                void this.refreshProjections();
            }
            // 订阅的**首帧就是快照页**，它替换整个事件窗口（上游同口径）——所以不必再单独读一次快照：
            // 重连也由它把断线期间错过的记录补齐（断线窗口内的帧不会补发）。
            this.followHandle = followSession(sessionId, {
                onSnapshot: (win) => {
                    this.replaceWindow(win);
                },
                // 打开历史失败（上游 `openState === 'error'` 那条横幅）：拿到过快照就不再报（见 follow.ts）
                onOpenError: (error) => {
                    this.sessionOpenError = error;
                    this.flushRows();
                },
                onEvent: (event) => {
                    const ev = event as DshStreamEvent;
                    // 回合状态的事件级判据（**含「迟到的 turn/end 不许关掉当前这一轮」**）：
                    // 判错的表现是「深度求索中…」中途消失 / 停止按钮提前复位。判据在
                    // `dsh/turn-state.ts`（纯函数，由 `tmp/_turn.state.test.mjs` 钉住）。
                    if (ev.type === 'turn/start' || ev.type === 'turn/end') {
                        const verdict = foldTurnState(
                            { lastTurn: this.lastTurnSeen, open: this.turnOpenFromHost },
                            ev
                        );
                        this.lastTurnSeen = verdict.state.lastTurn;
                        if (verdict.closesCurrentTurn) {
                            this.turnRunning = false; // 本轮结束（不论正常还是被停止）
                            this.turnOpenFromHost = false; // 权威结论，不用等重读
                        } else if (verdict.ignoredReason !== undefined && process.env['DSH_RAWLOG'] !== undefined) {
                            console.warn(`[dsh-turn] 忽略 ${verdict.ignoredReason}`);
                        } else if (ev.type === 'turn/start') {
                            this.turnOpenFromHost = true;
                        }
                    }
                    // 增量帧先过连续性校验：不连续的那一帧**不入列**，改为重开订阅要一份新基线
                    if (ev.type === 'assistant-stream' && !this.acceptAssistantFrame(ev)) {
                        return;
                    }
                    this.ingestEvents([ev]);
                },
            });
        }
        return true;
    }

    /**
     * 本会话是否有一轮在跑。优先读上游 `turnBoundary` 投影；未读到时退回窗口扫描。
     *
     * 「为真」时顺手开安全网轮询（`startTurnWatch`）—— 每次行下发都会走到这里，
     * 于是不管是本插件提交的、还是别处驱动的一轮，只要插件认为在跑，就有人盯着权威读数。
     */
    private turnActive(): boolean {
        const active = this.turnOpenFromHost ?? this.turnActiveFromWindow();
        if (active) {
            this.startTurnWatch();
        }
        return active;
    }

    /**
     * 「这一轮还在跑吗」的**安全网**轮询。
     *
     * 投影帧（`turnBoundary`）是首选：实时、且是权威读数。但**不能只靠它** ——
     * 控制流断线重连、或服务端没组合该投影时，插件就只剩窗口扫描，而窗口扫描只看得见
     * **自己这条路**收到的事件。别处把这一轮停掉时，停止按钮就会一直停在停止态
     *（真机现象：网页端已经停了、图标回到发送箭头，插件端还是停止按钮）。
     *
     * 所以只在「插件认为有轮在跑」时按 `TURN_WATCH_INTERVAL_MS` 重读一次权威值：
     * 一条轻量 RPC、只读投影，读到的结论一变就重推行。结论为「没在跑」时自动停表。
     */
    private stopTurnWatch(): void {
        if (this.turnWatchTimer !== undefined) {
            clearInterval(this.turnWatchTimer);
            this.turnWatchTimer = undefined;
        }
    }

    /** 按需打开安全网轮询（已在跑则不动）。 */
    private startTurnWatch(): void {
        if (this.turnWatchTimer !== undefined) {
            return;
        }
        this.turnWatchTimer = setInterval(() => {
            if (!this.turnActive()) {
                // 已经不在跑了（权威帧先到 / 窗口扫描已定论）：停表
                this.stopTurnWatch();
                return;
            }
            void this.refreshTurnOpen().then(() => {
                if (this.turnOpenFromHost === false) {
                    this.stopTurnWatch();
                    this.flushRows();
                }
            });
        }, TURN_WATCH_INTERVAL_MS);
    }

    /** 窗口扫描兜底：从尾部往回看，先遇 `turn/end` 为假、先遇 `turn/start` 为真。 */
    private turnActiveFromWindow(): boolean {
        for (let i = this.streamEvents.length - 1; i >= 0; i -= 1) {
            const t = this.streamEvents[i].type;
            if (t === 'turn/end') {
                this.turnRunning = false; // 事件流已有定论，乐观标记作废
                return false;
            }
            if (t === 'turn/start') {
                return true;
            }
        }
        // 没有未闭合回合：兜住「刚提交、turn/start 未到」那一瞬
        return this.turnRunning;
    }

    /** 重读 `turnBoundary` 并缓存为同步值。读失败沿用上次结论：不因一次 RPC 抖动关掉「终止」。 */
    private async refreshTurnOpen(): Promise<void> {
        const sid = this.currentSessionId;
        if (sid === undefined) {
            this.turnOpenFromHost = undefined;
            return;
        }
        try {
            const proj = await getSessionProjections(sid);
            if (this.currentSessionId !== sid) {
                return; // 期间换过会话：这次读数作废
            }
            this.applyTurnBoundary(proj['turnBoundary']);
            /**
             * 权威说「在跑」时补两件事（真机 2026-10-06：「网页端还在跑，插件打开后整轮已经结束」）：
             *
             * ① **开安全网轮询** —— 否则别处（网页端 / 另一个面板）把它停掉时，插件这边没人再读权威读数，
             *    按钮与状态行就停在"结束"上；
             * ② **本窗口里没有未闭合回合 → 换一份权威窗口**（`requestRebaseline`）：这一份是旧的
             *    （刚打开面板时的快照、或断线重连前留下的那一份），不换的话整轮都会显示成"已完成"。
             *    限次（与"无正文自愈"共用预算），避免与服务端互相踢。
             */
            if (this.turnOpenFromHost === true) {
                this.startTurnWatch();
                if (windowHasOpenTurn(this.streamEvents) === false && this.reseedCount < 3 && this.followHandle !== undefined) {
                    this.reseedCount += 1;
                    this.requestRebaseline('权威说在跑，但本窗口里没有未闭合回合');
                }
            }
        } catch {
            // 保持上次结论
        }
    }

    /**
     * 把 `turnBoundary` 投影折成「是否有一轮在跑」。
     *
     * 为什么值得单列：**这是权威读数，而且控制流会实时推它**
     * （`sessionProjections.onChanged('turnBoundary')` → `{type:'projection'}` 帧）。
     * 上游客户端读的是 agent 的 `running` 状态（`useSession(s => s.running)`），
     * 本插件的窗口扫描只能看到**自己这条路**收到的事件 —— 别处（浏览器 / 另一个面板）
     * 把这一轮停掉时，插件那边唯一的线索就是这个投影。少了它，「停止」按钮会一直停在停止态。
     * @param raw - 投影值（形状：`{ openTurnStartSeq }`；缺键 = 能力未组合 → 退回窗口扫描）
     * @returns 结论是否**变了**（调用方据此决定要不要重推行）
     */
    private applyTurnBoundary(raw: unknown): boolean {
        const before = this.turnOpenFromHost;
        this.turnOpenFromHost = openFromTurnBoundary(raw);
        if (this.turnOpenFromHost === false) {
            // 权威说「没在跑」：乐观标记与窗口扫描都要让步
            this.turnRunning = false;
        }
        if (before !== this.turnOpenFromHost && process.env['DSH_RAWLOG'] !== undefined) {
            // 「深度求索中…」忽然消失 / 停止按钮不复位，都看这一行：谁把 turnOpen 改成了什么
            const seq = (raw as { openTurnStartSeq?: unknown } | undefined)?.openTurnStartSeq;
            console.warn(
                `[dsh-turn] turnOpen ${String(before)} → ${String(this.turnOpenFromHost)}` +
                    `（投影 openTurnStartSeq=${JSON.stringify(seq ?? null)} 已知回合=${String(this.lastTurnSeen)}）`
            );
        }
        return before !== this.turnOpenFromHost;
    }

    /**
     * 会话的审批/提问**常驻**订阅（上游口径：`ui-user-questions` 等是会话打开即监听）。
     * 挂在回合上的话，`$events` 会把无 handler 的 waterfall 帧直接丢弃（`events.ts` 的 `handlers` 为空即 return），
     * 面板没开时到达的提问就永久不可见。
     */
    private ensureAskSubscription(): void {
        this.askHandle?.();
        this.askHandle = undefined;
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return;
        }
        this.askHandle = dshEvents.subscribe(sid, {
            onApproval: (request) => {
                this.onApproval?.({
                    approvalId: request.eventId,
                    sessionId: request.agentId,
                    toolName: request.toolName,
                    description: request.reason, // reason 为真实原因；无则 UI 用 toolName 拼提示
                    // 本地化展示文案（dsh 0.1.7-rc.2 新增）：与 description 并行透传，
                    // 由 webview 决定用哪门语言（宿主不代选，见 stream.ts 的 DshApproval 注释）
                    ...(request.displayReason === undefined ? {} : { displayReason: { ...request.displayReason } }),
                });
            },
            onQuestion: (request) => {
                // 诊断（DSH_RAWLOG 时才打）：核对「订阅按会话注册、帧按 agentId 派发」两者是否同一个键
                if (process.env['DSH_RAWLOG'] !== undefined) {
                    console.warn(`[dsh-ask] question agentId=${request.agentId} current=${String(this.currentSessionId)}`);
                }
                this.onQuestion?.({
                    rpcId: request.eventId,
                    sessionId: request.agentId,
                    questions: request.questions,
                    ...(request.callId === undefined ? {} : { callId: request.callId }),
                });
            },
            // 断流：这些提问此刻已无法应答，让 UI 关掉弹窗
            onCancel: (eventId) => {
                this.onQuestionClosed?.(eventId);
            },
        });
    }

    /**
     * 页面就绪（含面板重新打开）时补发当前会话的行：页面是**重建**的，而行的唯一来源是宿主，
     * 不补则重开面板后对话区空白（旧的历史指令在开关打开时被忽略）。
     */
    pushCurrentRows(): void {
        if (this.currentSessionId !== undefined) {
            this.flushRows();
        }
        this.pushQueue();
        this.pushContext();
        this.pushProjections();
    }

    /**
     * 控制流订阅（host-wide）：一条流服务所有会话，建一次就够。
     *
     * 两类内容都在这里：
     *   · **队列**只活在 agent 的收件箱里、**不进日志**，`session/follow` 的历史窗口里没有它 ——
     *     页面刷新/重连之后，队列只能由这条流的首帧整表重建；
     *   · **投影**（统计 / 用量 / 上下文 / plan / goal…）由宿主逐键推送，上游客户端也是这条
     *     （`SessionControlController.control`）。首帧基线给每个键的**当前值**，之后只推变化。
     */
    private ensureControl(): void {
        if (this.controlHandle !== undefined) {
            return;
        }
        this.controlHandle = followControl({
            onQueue: (sessionId, items) => {
                this.queueBySession.set(sessionId, items);
                if (sessionId !== this.currentSessionId) {
                    return; // 别的会话的队列：缓存着，页面只认当前会话
                }
                this.pushQueue();
            },
            onProjectionBaseline: (bySession) => {
                for (const [sessionId, values] of bySession) {
                    this.projectionsBySession.set(sessionId, { ...values });
                }
                this.seedProjections(this.projectionsBySession.get(this.currentSessionId ?? '') ?? {});
                this.pushProjections();
            },
            onProjection: (sessionId, key, value) => {
                this.noteProjection(sessionId, key, value);
            },
            onLegacyHost: (detail) => {
                this.reportLegacyHost(detail);
            },
        });
    }

    /** 旧代主机只告警一次（这条流每帧都可能带旧承载，逐帧报会把用户刷屏）。 */
    private legacyHostReported = false;
    /**
     * 连到的 dsh 是旧代（`dsh-0.1.5-rc.x` 那一代的队列承载）时的**一次性**告警。
     *
     * 本插件自 v0.1.15 起只支持 dsh 0.1.7+、不再双形状嗅探：必须让用户知道"为什么队列不动"，
     * 而不是让他面对一个永远空着的队列卡（历史上这一层的失效方式就是静默的）。
     *
     * 两份输出各归其位：`console.warn` 打 `control.ts` 给的那行原文（**只有开发者看得到**，
     * 要开扩展宿主的开发者工具 —— 见 `extension.ts` 顶部同样的说明）；给用户的 `showWarningMessage`
     * 是**写死的固定文案**，不带帧名/字段名，也**不猜对端版本**（判定只看"帧里带着旧承载"，
     * 对端到底是哪版推不出来）。
     */
    private reportLegacyHost(detail: string): void {
        if (this.legacyHostReported) {
            return;
        }
        this.legacyHostReported = true;
        console.warn(`[dsh] 当前 dsh 版本过旧：${detail}`);
        void vscode.window.showWarningMessage('dsh 版本不匹配：请参考插件适配的 dsh 版本，升级 dsh 后重启服务。');
    }

    /** 当前会话的队列整表（页面就绪、动作回帧后补发）。 */
    currentQueue(): DshQueueItem[] {
        const sid = this.currentSessionId;
        return sid === undefined ? [] : this.queueBySession.get(sid) ?? [];
    }

    /** 把当前会话的队列整表下发给页面（与行各走一条下行通道，见 onQueue）。 */
    pushQueue(): void {
        this.onQueue?.(this.currentSessionId ?? '', this.currentQueue());
    }

    /**
     * 当前会话的投影整表（页面就绪、会话切换、任意投影变化时）。
     *
     * `permissions` 在这里**补一次**进程级目录的拼接：`session/follow` 快照那条来路
     * （`seedProjections`）不走 `control.ts`，而 0.1.7 起的投影只有 `currentValue` ——
     * 不在这里拼，换一次会话权限选择器就又变回空。`control.ts` 那条来路已拼过，
     * 重复拼是幂等的（同样的目录 + 同样的 currentValue）。
     */
    currentProjections(): Record<string, unknown> {
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return {};
        }
        const values = this.projectionsBySession.get(sid);
        if (values === undefined) {
            return {};
        }
        const permissions = values['permissions'];
        if (permissions === undefined) {
            return values;
        }
        this.ensurePermissionCatalog();
        return { ...values, permissions: withPermissionOptions(permissions, this.permissionCatalog) };
    }

    /**
     * 懒读一次进程级权限目录（dsh 0.1.7 的 `permissionPresets/catalog`）。
     *
     * 只读一次、失败不重试：0.1.5-rc.2 上这条 remote 不存在，重试只会反复打 404 噪音；
     * 目录随贡献变化时由 `control.ts` 的 emit 订阅负责重读并补发。
     */
    private ensurePermissionCatalog(): void {
        if (this.permissionCatalogRequested) {
            return;
        }
        this.permissionCatalogRequested = true;
        void readPermissionPresetCatalog()
            .then((catalog) => {
                if (catalog === undefined) {
                    return;
                }
                this.permissionCatalog = catalog.options;
                // 目录晚于首次推送到达：补推一次，让已经打开的页面拿到选项。
                this.pushProjections();
            })
            .catch(() => {
                // 老版本无此前端：保持 undefined，走投影自带的 options。
            });
    }

    /** 把当前会话的投影整表下发给页面（整表语义，见 onProjections）。 */
    pushProjections(): void {
        if (this.onProjections === undefined) {
            return;
        }
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return;
        }
        // 激活随投影同帧下发：没有条目 = 这个会话还没有读数 → 发空快照（页面据此显示"不知道"那一档，
        // **不能省略字段**，否则换会话后页面会留着上一个会话的档）
        this.onProjections(sid, this.currentProjections(), this.goalActivations.get(sid) ?? {});
    }

    /**
     * 重读当前会话的目标激活（上游 `activation-source.ts` 的 `refreshProjection` + `startRead`）。
     *
     * 触发面与上游一致：**投影里的 goal 一变**、**「在跑」翻转**（上游 `onRunning`）、
     * **`$events` 重连**（上游 `subscribeReset`）、以及**会话基线到来**（`seedProjections`）。
     *
     * 两条护栏（都是上游 epoch 护栏的**值级**等价物，更好读也更好测）：
     *   · 投影里**没有活跃目标**（`activeGoalRefOf` 为空）→ 直接发空快照，不去读 ——
     *     上游 `refreshProjection` 就是这么清掉上一档的（目标被清除/暂停时靠它，不靠读失败）；
     *   · 读回来的 `(id, revision)` 必须与**此刻**投影里的活跃目标一致，否则这次读数作废
     *     （期间目标换了身份/版本 —— 晚到的读不许盖掉更新的事实）。
     */
    private refreshGoalActivation(): void {
        this.ensureGoalActivationSubscription();
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return;
        }
        if (this.activeGoalRef(sid) === undefined) {
            this.setGoalActivation(sid, {});
            return;
        }
        void readGoalActivation(sid).then((snapshot) => {
            if (snapshot === undefined) {
                return; // 读不到：保留上次值（与 settings.ts 同口径：不把"读不到"伪装成"状态变了"）
            }
            if (this.currentSessionId !== sid) {
                return; // 中途换过会话：这次读数作废
            }
            const now = this.activeGoalRef(sid);
            if (now === undefined || now.id !== snapshot.id || now.revision !== snapshot.revision) {
                return;
            }
            this.setGoalActivation(sid, snapshot);
        });
    }

    /** 投影里此刻的活跃目标引用（只有 `phase === 'active'` 才算）。 */
    private activeGoalRef(sessionId: string): { id: string; revision: number } | undefined {
        return activeGoalRefOf(this.projectionsBySession.get(sessionId)?.['goal']);
    }

    /** 存一份激活快照；**只在与上次不同值时**重推投影帧（避免 emit 密集时反复重推整表）。 */
    private setGoalActivation(sessionId: string, snapshot: DshGoalActivation): void {
        if (sameGoalActivation(this.goalActivations.get(sessionId), snapshot)) {
            return;
        }
        this.goalActivations.set(sessionId, snapshot);
        if (sessionId === this.currentSessionId) {
            this.pushProjections();
        }
    }

    /** 建立激活边沿的订阅（幂等）。 */
    private ensureGoalActivationSubscription(): void {
        if (this.goalActivationUnsub !== undefined) {
            return;
        }
        this.goalActivationUnsub = subscribeGoalActivation({
            onActivation: (sessionId, snapshot) => {
                // 只认当前会话：其它会话的边沿与本面板无关（也不需要缓存 —— 切回去时基线会重读）
                if (sessionId === this.currentSessionId) {
                    this.setGoalActivation(sessionId, snapshot);
                }
            },
            onReady: () => {
                // $events 重连：断线期间的边沿不会补发 → 重读一次对齐（上游 `subscribeReset` 同义）
                this.refreshGoalActivation();
            },
        });
    }

    /**
     * 当前会话投影表里**有哪些键**（诊断用：输入框下方那两块读数全来自投影，
     * 真机排查「统计/用量不显示」时先看这几个键到没到）。
     * @returns 键名（按字典序）；没有会话时为空数组。
     */
    projectionKeys(): string[] {
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return [];
        }
        return Object.keys(this.projectionsBySession.get(sid) ?? {}).sort();
    }

    /**
     * 一条投影帧：**整份**存下来（上游客户端同口径：客户端持有宿主算好的完整值，不做本地折叠），
     * 再把整表推给页面 —— 页面因此不需要知道「哪一帧改了什么键」。
     *
     * 上下文占用那两个键另外喂一份给上下文环（那条轻帧只带两个字段，不重推整表）。
     */
    private noteProjection(sessionId: string, key: string, value: unknown): void {
        const values = this.projectionsBySession.get(sessionId) ?? {};
        values[key] = value;
        this.projectionsBySession.set(sessionId, values);
        this.noteContextProjection(sessionId, key, value);
        if (sessionId !== this.currentSessionId) {
            return;
        }
        // `turnBoundary` 一变就说明回合开了或关了 —— 这是**权威且实时**的那条：
        // 别处（浏览器 / 另一个面板）把这一轮停掉时，插件只有靠它才能把「停止」按钮复位
        //（窗口扫描只看得到自己收到的事件）。结论变了就立刻重推行，不用等下一次事件到账。
        const boundaryChanged = key === 'turnBoundary' && this.applyTurnBoundary(value);
        if (boundaryChanged) {
            this.flushRows();
            this.stopTurnWatch();
        }
        // 目标激活：投影里的 `goal` 一变、或「在跑」翻转（上游 `onRunning`）就重读一次。
        // 注意顺序 —— 先把激活对齐，再推投影帧，页面拿到的两半才是同一时刻的。
        if (key === 'goal' || boundaryChanged) {
            this.refreshGoalActivation();
        }
        this.pushProjections();
    }

    /**
     * `session/control` 的投影帧里上下文占用那两个键：形状解析后缓存，走单独一条轻帧下发给环。
     *
     * 其余键（统计 / 用量 / plan / goal / 权限…）由 `noteProjection` 整表下发 —— 两侧不是同一份数据的
     * 两个来源，而是同一份数据的两种**呈现通道**（环要的是极小的两个字段，没必要跟着整表走）。
     */
    private noteContextProjection(sessionId: string, key: string, value: unknown): void {
        if (key !== 'contextPressure' && key !== 'contextBreakdown') {
            return;
        }
        const cur = this.contextBySession.get(sessionId) ?? {};
        if (key === 'contextPressure') {
            const pressure = readContextPressure(value);
            if (pressure === undefined) {
                if (process.env['DSH_RAWLOG'] !== undefined) {
                    console.warn(`[dsh-context] 投影帧 contextPressure 形状不符：${JSON.stringify(value).slice(0, 200)}`);
                }
                return;
            }
            cur.pressure = pressure;
        } else {
            const breakdown = readContextBreakdown(value);
            if (breakdown === undefined) {
                return;
            }
            cur.breakdown = breakdown;
        }
        this.contextBySession.set(sessionId, cur);
        if (process.env['DSH_RAWLOG'] !== undefined) {
            console.warn(
                `[dsh-context] 投影帧 sid=${sessionId.slice(0, 8)}… key=${key} pressure=${JSON.stringify(cur.pressure ?? null)}`
            );
        }
        if (sessionId === this.currentSessionId) {
            this.pushContext();
        }
    }

    /**
     * 用一次投影**快照**（`chatInfo` 那条路 / 控制流基线）补当前会话的投影整表与上下文占用。
     *
     * 整表替换而不是逐键合并：这份就是该会话此刻的权威读数（服务端算好的完整值），
     * 合并会让**已经消失的键**（如目标被清除、plan 退出）永远留在页面上。
     * 上下文那两个键另外过一遍形状解析（认不出的形状不该覆盖已有缓存，见下）。
     */
    seedProjections(projections: Record<string, unknown>): void {
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return;
        }
        this.projectionsBySession.set(sid, { ...projections });
        this.pushProjections();
        // 会话基线（含换会话后的首个基线）：激活重读一次 —— 上面那帧先给页面"不知道"，
        // 读回来再补一帧准确值（上游 `activation-source` 的 `start()` 也是先 refresh 再读）
        this.refreshGoalActivation();
        const pressure = readContextPressure(projections['contextPressure']);
        const breakdown = readContextBreakdown(projections['contextBreakdown']);
        // 诊断（DSH_RAWLOG 时才打）：环不显示时先看这里 —— 是投影没给键，还是给了但形状不认
        if (process.env['DSH_RAWLOG'] !== undefined) {
            console.warn(
                `[dsh-context] 快照 sid=${sid.slice(0, 8)}… pressure=${pressure === undefined ? '(缺/形状不符)' : JSON.stringify(pressure)} ` +
                    `breakdown=${breakdown === undefined ? '(缺/形状不符)' : 'ok'}`
            );
        }
        if (pressure === undefined && breakdown === undefined) {
            return;
        }
        this.contextBySession.set(sid, {
            ...(pressure === undefined ? {} : { pressure }),
            ...(breakdown === undefined ? {} : { breakdown }),
        });
        this.pushContext();
    }

    /** 把当前会话的上下文占用下发给页面（页面就绪、换会话、投影更新时）。 */
    pushContext(): void {
        const sid = this.currentSessionId;
        this.onContext?.(sid ?? '', sid === undefined ? {} : this.contextBySession.get(sid) ?? {});
    }

    /** 本会话是否有一轮在跑：页面据此决定「插话」是否可用（在跑的回合才收插话）。 */
    isTurnActive(): boolean {
        return this.turnActive();
    }

    /**
     * 忙时提交：把消息交给服务端排队（queue）或插话（steer），**只提交、不等整轮**。
     *
     * 与 askStreaming 的分工：那条是「提交 + 等这一轮结束」（空闲发送用，返回值就是本轮的用量）。
     * 忙时不能走它 —— 正在跑的回合已经有常驻订阅在渲染，等下去只会把这次提交绑到**别人的回合**上。
     * 用量改由事件层结算（见 noteTurnSettled），与空闲那条路同一份实现。
     */
    async submitQueued(content: DshContentPart[], opts: { requestId?: string; mode: DshPromptMode }): Promise<void> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法对话');
        }
        const sid = await this.getSession();
        this.ownPendingTurns += 1;
        try {
            await sendPrompt(sid, content, opts.requestId, opts.mode);
        } catch (e) {
            // 没排上队：撤销登记，否则下一次（别人的）turn/end 会被当成这一轮的结算
            this.ownPendingTurns = Math.max(0, this.ownPendingTurns - 1);
            throw e;
        }
    }

    /** 变更一条还挂着的排队项（错误原样上抛：调用方按错误码决定是提示还是静默刷新）。 */
    async updateQueue(itemId: string, action: DshQueueAction): Promise<void> {
        const sid = this.currentSessionId;
        if (sid === undefined) {
            throw new Error('当前没有会话，无法修改排队消息');
        }
        await updateQueueRpc(sid, itemId, action);
    }

    /** 实时增量帧的连续性校验通过则返回真（该帧应入列）；不通过则就地请求重开订阅并返回假。 */
    private acceptAssistantFrame(ev: DshStreamEvent): boolean {
        const verdict = judgeAssistantFrame(this.continuity, ev.frame);
        this.continuity = verdict.state;
        if (verdict.action === 'accept') {
            return true;
        }
        if (verdict.action === 'rebaseline') {
            this.requestRebaseline(verdict.reason);
        }
        return false;
    }

    /**
     * 重开订阅，去要一份**新的「窗口 + 增量基线」原子对**。
     *
     * 为什么不是就地修补：正文是「持久事件 + 瞬态增量」拼出来的，一旦增量链断过，
     * 服务端手里那份基线才说得清当前到底流到哪儿；重开订阅能拿到与基线**同一切点**的窗口，
     * 两者是原子的。上游判定 rebaseline 后同样是重开监听，而不是自己拼。
     */
    private requestRebaseline(reason: string): void {
        if (this.rebaselining) {
            return;
        }
        this.rebaselining = true;
        // 连续性状态作废：新的窗口与基线到达时由 adoptBaseline 重新定基
        this.continuity = initialContinuity();
        console.warn(`[dsh-follow] 增量流不连续（${reason}）：重开订阅重新定基`);
        this.followHandle?.restart();
    }

    /** 新快照到达：以服务端给的那份基线重新定基（版本号、进行中尝试与期望块序号）。 */
    private adoptBaseline(assistantStream: Record<string, unknown> | undefined): void {
        if (assistantStream === undefined) {
            // 订阅是按 `assistantStream: true` 打开的，快照就**必须**给这份基线；
            // 缺了说明这一帧不是可信的打开页（上游同样把它当违约，而不是当作"没有进行中尝试"）。
            // 只重试一次：再缺就按"没有进行中尝试"降级继续 —— 否则与不合规的服务端会来回重开。
            this.missingBaselineStreak += 1;
            if (this.missingBaselineStreak <= 1) {
                this.requestRebaseline('打开页缺少增量基线');
                return;
            }
            console.warn('[dsh-follow] 打开页仍缺增量基线：按「没有进行中尝试」继续（正文可能少一截）');
            this.continuity = initialContinuity();
            this.rebaselining = false;
            return;
        }
        this.missingBaselineStreak = 0;
        this.rebaselining = false;
        const revision = assistantStream['revision'];
        const attempt = assistantStream['activeAttempt'] as Record<string, unknown> | undefined;
        // 版本号只记不判（见 continuity 的注释）；块号与尝试标识才是判据
        this.continuity = {
            attemptId: typeof attempt?.['attemptId'] === 'string' ? (attempt['attemptId'] as string) : undefined,
            nextIndex: typeof attempt?.['nextIndex'] === 'number' ? (attempt['nextIndex'] as number) : 0,
            revision: typeof revision === 'number' ? revision : undefined,
        };
    }

    /**
     * 快照页 → **整窗替换**（上游同口径：窗口是"替换"语义，只有实时尾部才是"追加"）。
     *
     * 为什么不是"合并"：快照就是窗口本身，服务端在每条订阅（含重连）的首帧给出它。
     * 合并会把「订阅先于读取到达」当成要特判的竞态来兜，而替换天然没有这个窗口；
     * 进行中尝试的那部分内容由基线回放补回（见 appendBaseline）。
     *
     * 顺序要紧：先灌记录（持久事件定下序号的基准），再回放基线 —— 基线的合成序号取自该基准。
     */
    private replaceWindow(win: DshFollowWindow): void {
        // 历史已经显示出来了 → "打开失败"这条事实作废（上游同：打开成功即离开 error 态）
        this.sessionOpenError = undefined;
        // 诊断（打开历史"看不到正文"时用这一行分辨两种来路）：
        // 「快照里就没有结算消息」= 服务端没给；「快照里有、入列后变少」= 去重/入列丢的。
        const messagesInSnapshot = win.events.filter((e) => e.type === 'assistant/message').length;
        this.resetEvents();
        // 整窗替换：**快照就是窗口**，一条不裁（与上游一致），
        // 并用快照的 `hasMore` 决定顶端出不出「加载更早」。
        this.applyWindowChange(this.window.replace(win.events as unknown as readonly DshStreamEvent[], win.hasMore === true));
        this.seenSeqs = new Set<number>();
        for (const e of this.streamEvents) {
            if (e.seq !== undefined) {
                this.seenSeqs.add(e.seq);
            }
        }
        console.log(
            `[dsh-rows] 快照窗口已应用：记录=${String(win.events.length)} 事件=${String(this.streamEvents.length)} ` +
                `hasMore=${String(this.window.hasMore())} ` +
                `结算消息=${String(messagesInSnapshot)}→${String(this.streamEvents.filter((e) => e.type === 'assistant/message').length)}`
        );
        // 「为什么没看到『加载更早』/ 为什么历史不全」这一问的**唯一判据**：服务端这一页是不是完整历史。
        // 判据来自服务端 `paginate()`：它数的是**消息**（`user/message` + `assistant/message`）条数，
        // 数够请求的 `maxMessages` 才切；没数够就整份给。故「事件多」不等于「历史被截断」——
        // 一个 155 步的回合能产出几万条流式增量块，而它只对应十几条消息。
        console.log(
            `[dsh-rows] 历史完整性：${this.window.hasMore()
                ? '服务端分页截断（有更早的）→ 顶端应出现「加载更早」'
                : '快照即完整历史（服务端没有更早的）→ 不出现「加载更早」是正常的'}`
        );
        this.onWindowLog?.(
            `打开会话：快照 ${String(win.events.length)} 条 → 窗口 ${String(this.streamEvents.length)} 条` +
                ` · hasMore=${String(this.window.hasMore())}` +
                `${this.streamEvents.length < win.events.length
                    ? ` · ⚠ 少了 ${String(win.events.length - this.streamEvents.length)} 条（去重/入列丢的，**不是**裁剪：窗口不裁）`
                    : ' · 一条不少'}`
        );
        // 先定基再回放：基线里的 `nextIndex` 决定回放多少，同时把版本号/进行中尝试交给连续性校验
        this.adoptBaseline(win.assistantStream);
        this.appendBaseline(win.assistantStream);
        // 快照只是记录，读不到权威回合边界（它在投影里）——补读一次，别让「终止」按钮等下一次 turn 事件
        void this.refreshTurnOpen().then(() => { this.flushRows(); });
        // 首帧快照到位 = 水位可信（见 windowSeeded / awaitWindowSeeded）
        if (!this.windowSeeded) {
            this.windowSeeded = true;
            for (const resume of this.seedWaiters.splice(0)) {
                resume();
            }
        }
        this.flushRows();
    }

    /** 等首帧快照（水位变得可信）。**有界**：订阅起不来时不能把发送整个卡住，超时后按当前水位走。 */
    private awaitWindowSeeded(): Promise<void> {
        if (this.windowSeeded) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.seedWaiters.push(resolve);
            setTimeout(() => {
                const at = this.seedWaiters.indexOf(resolve);
                if (at !== -1) {
                    this.seedWaiters.splice(at, 1);
                }
                resolve();
            }, 3000);
        });
    }

    /**
     * 放掉所有等待者；`error` 非空则以失败结束它们。
     * @param error - 失败原因（换会话/停用）；省略 = 正常结束。
     */
    private settleTurnWaiters(error?: Error): void {
        for (const waiter of [...this.turnWaiters]) {
            waiter.settle(error);
        }
    }

    /**
     * 等**这一轮**结束：骑在已有那条常驻订阅上，靠 `turn/end` 到来收尾。
     *
     * `afterSeq` 是提交前的水位：只有**序号更大**的 `turn/end` 才算这一轮，
     * 否则会把窗口里已有的上一轮当成刚结束（提交后立刻返回、用量记错轮）。
     * @param sessionId - 目标会话。
     * @param afterSeq - 提交前的事件水位。
     * @param isCancelled - 调用方取消判据（轮询兜底；正常仍由服务端的 turn/end 收尾）。
     * @returns `done` 等待句柄与 `cancel`（发送失败时撤销登记，别把下一次 turn/end 认成这一轮）。
     */
    private watchTurnEnd(
        sessionId: string,
        afterSeq: number,
        isCancelled?: () => boolean
    ): { done: Promise<void>; cancel: () => void } {
        let settled = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let resolveDone!: () => void;
        let rejectDone!: (e: Error) => void;
        const done = new Promise<void>((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });
        const waiter: { sessionId: string; afterSeq: number; settle: (error?: Error) => void } = {
            sessionId,
            afterSeq,
            settle: (error?: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearInterval(timer);
                    timer = undefined;
                }
                const at = this.turnWaiters.indexOf(waiter);
                if (at !== -1) {
                    this.turnWaiters.splice(at, 1);
                }
                if (error) {
                    rejectDone(error);
                } else {
                    resolveDone();
                }
            },
        };
        this.turnWaiters.push(waiter);
        if (isCancelled) {
            timer = setInterval(() => {
                if (isCancelled()) {
                    waiter.settle();
                }
            }, 400);
        }
        return { done, cancel: () => waiter.settle() };
    }

    /** 新入列的事件里有没有「这一轮」的 `turn/end`；有就放掉对应等待者。 */
    private noteTurnEnd(event: DshStreamEvent): void {
        if (event.type !== 'turn/end' || this.turnWaiters.length === 0) {
            return;
        }
        const seq = event.seq;
        for (const waiter of [...this.turnWaiters]) {
            if (waiter.sessionId !== this.currentSessionId) {
                continue;
            }
            if (seq !== undefined && seq <= waiter.afterSeq) {
                continue;
            }
            waiter.settle();
        }
    }

    /**
     * 本插件提交的回合结束了：把这一轮的用量交给装配层记账。
     *
     * 空闲提交与忙时提交**共用这一处**：先前只有空闲那条路会记（`askStreaming` 返回后），
     * 忙时提交没有返回值可挂。用量的事实来自行（`stats`），而「谁提交的、什么时候结束」
     * 只有事件层知道 —— 放在这里，两条路径就不会各写一份口径。
     *
     * 「只记自己提交的」由 ownPendingTurns 把关：别处驱动的回合不产生消费记录。
     */
    private noteTurnSettled(rows: readonly DshStreamRow[]): void {
        // 回合边界已过：重读权威值再下发一次，页面侧的「终止」按钮据此复位（不用等下一次 turn 事件）
        void this.refreshTurnOpen().then(() => { this.flushRows(); });
        if (this.ownPendingTurns <= 0) {
            return;
        }
        this.ownPendingTurns -= 1;
        const sid = this.currentSessionId;
        if (this.onTurnSettled === undefined || sid === undefined) {
            return;
        }
        const assistants = rows.filter(
            (r): r is Extract<DshStreamRow, { kind: 'assistant' }> => r.kind === 'assistant'
        );
        const row = assistants[assistants.length - 1];
        if (row === undefined) {
            return;
        }
        this.onTurnSettled({
            sessionId: sid,
            stats: (row.stats ?? {}) as DshReplyStats,
            ...(row.timeMs === undefined ? {} : { timeMs: row.timeMs }),
        });
    }

    /**
     * 进行中尝试的**基线回放**：订阅打开时若已有活跃尝试，它此前流出的增量不在窗口记录里。
     * 不回放的话，「打开一个正在生成的会话」在接入时刻之前的正文整段不显示。
     *
     * 先补一条合成的 `start` 帧：后续实时帧的 `step` **只随 start 帧到达**，缺了它推理段会断；
     * 放弃尝试时的回滚也以它为基线（打开时上游本就不重放 start 帧，故这里自己补）。
     */
    private appendBaseline(assistantStream: Record<string, unknown> | undefined): void {
        const attempt = assistantStream?.['activeAttempt'] as Record<string, unknown> | undefined;
        if (attempt === undefined) {
            return;
        }
        const nextIndex = typeof attempt['nextIndex'] === 'number' ? (attempt['nextIndex'] as number) : 0;
        const step = typeof attempt['step'] === 'number' ? (attempt['step'] as number) : undefined;
        // 只取**已真流出去**的前 nextIndex 个：更靠后的成员还没发出去（上游 replace 同此）
        const members = expandAssistantStream(attempt['stream']).slice(0, Math.max(0, nextIndex));
        if (members.length === 0) {
            return;
        }
        this.pushTransient({ type: 'assistant-stream', frame: { type: 'start', step } });
        for (const member of members) {
            this.pushTransient({
                type: 'assistant-stream',
                time: member.time,
                frame: { type: 'chunk', step, chunk: member.chunk },
            });
        }
    }

    /** 合成序号的入列（基线回放用）：口径见 official/live-chunk-seq。 */
    private pushTransient(event: DshStreamEvent): void {
        this.transientInGap += 1;
        this.streamEvents.push({ ...event, seq: liveChunkSeq(this.durableSeq, this.transientInGap) });
    }

    /**
     * 会话事件的**唯一写入口**：按 `seq` 去重、并入、必要时排序，然后下发一次行。
     *
     * 为什么收成一个口：原先有**两条写入路径**（实时入列 / 快照合并），而**只有快照那条做了去重** ——
     * 重连时服务端重放已收到的事件，实时那条会重复入列，行构建（全量重跑）于是把同一段正文
     * 累加两次（真机现象：对话区出现重复内容、偶现）。**同一份数据只留一个写入口**，
     * 规则就不会只落在一半的路径上。
     */
    private ingestEvents(incoming: readonly DshStreamEvent[]): void {
        this.appendEvents(incoming);
        // 回合结束**立刻**下发：末尾那几个事件正是答案本身（正文与终止原因），
        // 排在合并窗口后面就是"跑完了但正文还没上屏"（真机现象）。
        if (incoming.some((e) => e.type === 'turn/end')) {
            this.flushRows();
            return;
        }
        this.emitRows();
    }

    /** 入列（不发）：按 `seq` 去重、给实时帧合成序号、必要时排序。发不发由调用方定（见 emitRows）。 */
    private appendEvents(incoming: readonly DshStreamEvent[]): void {
        const fresh: DshStreamEvent[] = [];
        for (const e of incoming) {
            if (e.seq !== undefined) {
                if (this.seenSeqs.has(e.seq)) {
                    continue;
                }
                this.seenSeqs.add(e.seq);
                // 持久事件：合成序号的基准前移、帧计数归零（顺序与上游处理持久事件时一致）
                this.durableSeq = Math.max(this.durableSeq, e.seq);
                this.transientInGap = 0;
                fresh.push(e);
                continue;
            }
            if (e.type === 'assistant-stream') {
                // 实时增量帧本无持久序号 → 合成一个（口径见 official/live-chunk-seq）。
                // **不写进去重集合**：合成序号是本地派的号，服务端不会重放它。
                this.transientInGap += 1;
                fresh.push({ ...e, seq: liveChunkSeq(this.durableSeq, this.transientInGap) });
                continue;
            }
            // 其余无序号的事件（如 `snapshot` 帧）原样收：不认识的类型不自作主张（见 design/08 §9.4）
            fresh.push(e);
        }
        if (fresh.length === 0) {
            return;
        }
        // 实时事件按 seq 递增到达 —— 只在"插进来的不在末尾"时才需要排序（快照合并那种情形）。
        // 仍无序号的事件用 MAX 让稳定排序把它留在末尾（`snapshot` 帧，构建器不消费它）。
        const tailSeq = this.lastEventSeq();
        // 入窗（**纯追加，一条不裁** —— 与上游一致；正在跑的那一轮绝不能被抽走）
        this.applyWindowChange(this.window.append(fresh));
        if (this.streamEvents.some((e) => e.seq !== undefined && e.seq <= tailSeq)) {
            this.streamEvents.sort(
                (a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
            );
        }
        // 本轮等待者的收尾口：快照回放与实时两条来路都经过这里，所以只在这一处判（同一规则只写一份）
        for (const e of fresh) {
            this.noteTurnEnd(e);
        }
        // 本插件提交的回合结束了：结算留到**这一批的整表构建**里做（见 flushRows）——
        // 在这里再建一次行，等于每个回合结束都白算一整份窗口（长会话上是百毫秒级）。
        if (fresh.some((e) => e.type === 'turn/end')) {
            this.settlePending = true;
        }
    }

    /**
     * 行是**整表**下发：一次投递是整份 JSON。逐事件各做一次，
     * 在长会话上会**算不过来** —— 真机量到：8.5 万条事件的会话，单次构建 115ms、载荷 1.45MB，
     * 而流式期间每秒有几十个帧。跟不上时最后那几个事件（**含最终 `assistant/message` 的正文**）
     * 一直排在积压里，界面于是停在"链和卡片都在、正文没有"的那个中间状态。
     *
     * 故这里**合并**：一串事件只换一次重建，且下一次至少等上一次构建的耗时才动（自适应节流）。
     * 但有两种情形必须**立刻**下发、不能等：回合结束（末尾那几个事件正是答案本身）与快照替换（打开会话）。
     *
     * 节流上限压到一顿饭那么短（120ms）：一次构建如今只在**当前回合**上重折（见 `rowsCheckpoint`），
     * 那个量级是几毫秒到几十毫秒，不再需要为「几百毫秒一次的全量重建」留出 300ms 的空档。
     */
    /**
     * 行是**整表**下发的：一串事件只换一次重建，且下一次至少等上一次的代价才动（自适应节流）。
     * 但有两种情形必须**立刻**下发、不能等：回合结束（末尾那几个事件正是答案本身）与快照替换（打开会话）。
     *
     * 节流的依据是**这次投递要付多少**，而不是只有构建：
     *   · 构建（断点续折后是几毫秒到几十毫秒，见 `rowsCheckpoint`）；
     *   · **载荷**：整表 JSON 是几 MB 到十几 MB，页面侧要解析、要重渲。
     *
     * 早先只看构建耗时、上限写死 300ms —— 那是「全量重折 600ms」时代的余量。现在构建快了，
     * 若还按老公式（`buildMs * 2`，上限 120ms）就会**以十几毫秒的间隔推十几 MB**，
     * 把页面侧压死（观感反而更糟）。所以载荷也进预算：每 MB 记 `PAYLOAD_MS_PER_MB` 毫秒，
     * 两条取大值。这不是"又加了个上限"，而是把**已有的投递成本**如实计进节流。
     */
    private emitRows(): void {
        if (this.onRows === undefined) {
            return;
        }
        if (this.rowsTimer !== undefined) {
            return;
        }
        const buildBudget = this.lastBuildMs * 2;
        const payloadBudget = this.lastPayloadMb * PAYLOAD_MS_PER_MB;
        const delay = Math.min(1000, Math.max(24, buildBudget, payloadBudget));
        this.rowsTimer = setTimeout(() => {
            this.rowsTimer = undefined;
            this.flushRows();
        }, delay);
    }

    /**
     * 当前窗口的行（断点续折）。
     *
     * 所有需要读行的调用点都走这一处：构建一次要遍历整个窗口，三个调用点各建一次就是三倍成本
     * （真机量到过 999ms/次）。断点只在**本实例**内传递，窗口一换就自动失效。
     */
    private buildCurrentRows(): DshStreamRow[] {
        const result = buildRowsIncremental(this.streamEvents, {
            ...(this.rowsCheckpoint === undefined ? {} : { checkpoint: this.rowsCheckpoint }),
            // 校验（最强那种：同跑一次全量并逐字节比对）按轮次抽样，且只在**复用旧断点**时才付这份钱。
            // 它换来的是「断点与全量不等价」这类问题在真实会话里自动被发现并以全量为准，
            // 而不是让正文悄悄错一段 —— 代价是每 N 轮多一次全量重折。
            verify: this.rowsCheckpoint !== undefined && this.checkpointUses % CHECKPOINT_VERIFY_EVERY === 0,
        });
        this.rowsCheckpoint = result.checkpoint;
        if (result.checkpoint !== undefined) {
            this.checkpointUses += 1;
        }
        return this.withChangesSummaries(result.rows);
    }

    /**
     * 给行挂上**改动摘要**，并为还没问过的 `changesSeq` 起一次取回（见 `dsh/changes-summary.ts`）。
     *
     * 为什么挂在行上而不是另开一帧：摘要是**回合级事实**，与「本轮文件改动」的渲染一一对应；
     * 行帧本来就是这个插件下发行事实的唯一通道（`host-rows.ts` 只搬运、不判断）。
     * 取回是异步的：**到账前那张卡不出现**（与上游一致：摘要没读到就没有卡），到账后 `emitRows()`
     * 重发一帧，卡片自然浮现。`null` 也进缓存 —— 一次说没有就不再重问（上游 `retryable: () => false`）。
     */
    private withChangesSummaries(rows: readonly DshStreamRow[]): DshStreamRow[] {
        const sessionId = this.currentSessionId;
        const out: DshStreamRow[] = [];
        for (const row of rows) {
            // 早退而不是三元：`row` 要在这里**收窄成 assistant 变体**，后面才敢拼 `changesSummary`
            if (row.kind !== 'assistant' || row.changesSeq === undefined) {
                out.push(row);
                continue;
            }
            const seq = row.changesSeq;
            if (!this.changesSummaries.has(seq) && !this.changesSummaryPending.has(seq) && sessionId !== undefined) {
                this.changesSummaryPending.add(seq);
                void fetchChangesSummary(sessionId, seq).then((summary) => {
                    this.changesSummaryPending.delete(seq);
                    this.changesSummaries.set(seq, summary);
                    // 摘要到账 / 确认没有 → 重发一帧（卡片出现，或确定不再出现）
                    this.emitRows();
                });
            }
            const summary = this.changesSummaries.get(seq);
            out.push(summary === undefined || summary === null || summary.files.length === 0 ? row : { ...row, changesSummary: summary });
        }
        return out;
    }

    /** 立刻构建并下发（回合结束 / 快照替换 / 页面就绪用；丢弃已排队的合并窗口）。 */
    private flushRows(): void {
        if (this.rowsTimer !== undefined) {
            clearTimeout(this.rowsTimer);
            this.rowsTimer = undefined;
        }
        if (this.onRows === undefined) {
            return;
        }
        const started = Date.now();
        const rows = this.buildCurrentRows();
        const active = this.turnActive();
        // 诊断（DSH_RAWLOG 时才打）：只在翻转时打印 —— 查「终止按钮变回发送/禁用」时要看的就是这个布尔值
        if (active !== this.lastTurnActiveLogged) {
            this.lastTurnActiveLogged = active;
            if (process.env['DSH_RAWLOG'] !== undefined) {
                console.warn(`[dsh-turn] turnActive=${String(active)} events=${String(this.streamEvents.length)}`);
            }
        }
        this.onRows(rows, active);
        // 已到期的回合结算（用**这一份**刚建好的行，不重算；见 noteTurnSettled）
        if (this.settlePending) {
            this.settlePending = false;
            this.noteTurnSettled(rows);
        }
        this.lastBuildMs = Date.now() - started;
        this.noteBlankAnswer(rows);
        this.emitTodos();
    }

    /**
     * 记下这一帧的载荷量级（MB），供节流预算用（见 `emitRows` / `lastPayloadMb`）。
     *
     * 由**发送处**实测填入（见 `extension.ts` 的 `onRows`）：那一层为了「只发变动的行」本来就要
     * 把每行序列化一遍去比较，顺手就有真实字节数 —— 本类不再自己 `JSON.stringify` 整表
     *（13 MB 整表上要几十毫秒，等于每帧白付一倍）。
     * @param bytes - 本帧**实际发出去**的字节数。
     */
    setSentPayloadBytes(bytes: number): void {
        this.lastPayloadMb = bytes / (1024 * 1024);
    }

    /**
     * 「回合已结束、链上有内容、正文却为空」的诊断与自愈。
     *
     * 判据收紧到**本回合一条结算消息都没有**：末步只调工具的回合本来就没有回答文本（正常），
     * 但一个已经 `turn/end` 的回合**至少该有一条 `assistant/message`** —— 一条都没有，
     * 说明这个窗口缺的正是权威日志里有的东西（真机现象：工具行/卡片都在、正文没有）。
     * 这时不去猜，直接把订阅重开一次，用服务端那份快照把窗口换成权威版本（上行自带的恢复动作）。
     */
    private noteBlankAnswer(rows: readonly DshStreamRow[]): void {
        const last = [...rows].reverse().find((r): r is Extract<DshStreamRow, { kind: 'assistant' }> => r.kind === 'assistant');
        if (last === undefined || !last.done || last.text !== '' || last.chain.length === 0) {
            return;
        }
        let turnStart = 0;
        for (let i = this.streamEvents.length - 1; i >= 0; i -= 1) {
            if (this.streamEvents[i].type === 'turn/start') {
                turnStart = i;
                break;
            }
        }
        const turn = this.streamEvents.slice(turnStart);
        // 只判**已经结束**的回合：刚开的那个回合还没有结算消息是正常的（此时末条回答行属于上一轮），
        // 少了这道门，任何一次"新回合刚起步"的 flush 都会被误判成缺消息而去重开订阅。
        if (!turn.some((e) => e.type === 'turn/end')) {
            return;
        }
        // 有结算消息却没有正文 = 本回合确实没有回答文本（末步只调工具），正常，到此为止
        if (turn.some((e) => e.type === 'assistant/message')) {
            return;
        }
        const counts = new Map<string, number>();
        for (const e of turn) {
            const k = e.type ?? '(无类型)';
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const hist = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([k, v]) => `${k}×${String(v)}`)
            .join(', ');
        const tail = turn
            .slice(-8)
            .map((e) => `${String(e.seq)}:${e.type ?? ''}`)
            .join(' ');
        // 同一个窗口形态只报一次（每 ≤300ms 一次 flush，否则会刷屏）
        const key = `${String(rows.length)}:${String(last.chain.length)}:${String(turn.length)}`;
        if (key !== this.blankAnswerKey) {
            this.blankAnswerKey = key;
            console.warn(
                `[dsh-rows] 回合已结束但窗口里没有结算消息（末条回答无正文）：窗口=${String(this.streamEvents.length)} ` +
                    `本回合=${String(turn.length)} 链=${String(last.chain.length)} seq=${String(last.seq)}`
            );
            console.warn(`[dsh-rows]   本回合类型：${hist}`);
            console.warn(`[dsh-rows]   末尾事件：${tail}`);
        }
        // 自愈：重开订阅换一份权威窗口（限次，防与服务端互相踢）
        if (this.reseedCount < 3 && this.followHandle !== undefined) {
            this.reseedCount += 1;
            this.requestRebaseline('回合已结束但窗口里没有结算消息');
        }
    }

    /**
     * 下发当前窗口折叠出的任务清单。
     *
     * 去重是必要的：清单只在 `todo/write` 与 `turn/start` 时才变，而行的下发是逐批（甚至逐事件）触发的 ——
     * 不去重就是每次都白发一条同样的消息。指纹在窗口重建时清掉（换会话/重定基），
     * 否则「新会话的清单恰好与旧会话相同」会因为没有指纹变化而漏发。
     */
    private emitTodos(): void {
        if (this.onTodos === undefined) {
            return;
        }
        const todos = foldTodos(this.streamEvents);
        const key = JSON.stringify(todos);
        if (key === this.todosKey) {
            return;
        }
        this.todosKey = key;
        this.onTodos(todos);
    }

    /**
     * 本轮**新增**的回答行（没有新增返回 undefined）。
     * 为什么按「新增」判：本轮若一行回答都没产出（例如提交就被拒），末条回答行属于**上一轮**，
     * 直接取末条会把上一轮的用量再记一次。
     * @param before - 提交前的 assistant 行条数（assistantRowCount）。
     */
    private newAssistantRow(before: number): Extract<DshStreamRow, { kind: 'assistant' }> | undefined {
        const assistants = this.buildCurrentRows().filter(
            (r): r is Extract<DshStreamRow, { kind: 'assistant' }> => r.kind === 'assistant'
        );
        return assistants.length > before ? assistants[assistants.length - 1] : undefined;
    }

    /** 当前窗口里 assistant 行的条数。 */
    private assistantRowCount(): number {
        return this.buildCurrentRows().filter((r) => r.kind === 'assistant').length;
    }

    /** 末尾**带序号**的事件的序号；一条都没有时 -1。不能直接取末元素 —— 末元素可能是无序号的事件。 */
    private lastEventSeq(): number {
        for (let i = this.streamEvents.length - 1; i >= 0; i -= 1) {
            const seq = this.streamEvents[i].seq;
            if (seq !== undefined) {
                return seq;
            }
        }
        return -1;
    }

    /** 清空本会话的事件与去重集合（换会话时）。 */
    private resetEvents(): void {
        this.streamEvents = [];
        // 窗口（分页事实）一起清：换会话后「还有更早的吗」「加载中」都不该沿用上一个会话
        this.window.clear();
        this.seenSeqs.clear();
        this.durableSeq = -1;
        this.transientInGap = 0;
        // 改动摘要按 seq 缓存 → 换会话必须清（不同会话的 seq 会撞）
        this.changesSummaries.clear();
        this.changesSummaryPending.clear();
        // 指纹一起清：否则"新会话的清单恰好与旧会话相同"会因为没有指纹变化而漏发一次
        this.todosKey = '';
        // 自愈配额与诊断去重按会话重置：新会话该有新的机会
        this.reseedCount = 0;
        this.blankAnswerKey = '';
        // 到期的结算属于上一个会话的窗口：换会话时丢掉，别让它记到新会话上
        this.settlePending = false;
        // 已排队的合并窗口一起丢：它要发的是**上一个会话**的窗口，留着会覆盖新会话的行
        if (this.rowsTimer !== undefined) {
            clearTimeout(this.rowsTimer);
            this.rowsTimer = undefined;
        }
        // 行构建的断点属于上一个会话的窗口：留着虽会被判据挡下（首事件序号对不上），
        // 但那是**巧合性**的防护 —— 换了会话就该从零开始（顺带放掉它引用的那一串行）
        this.rowsCheckpoint = undefined;
        this.checkpointUses = 0;
        // 载荷读数同理：新会话第一次投递不该按上一个会话的十几 MB 去等
        this.lastPayloadMb = 0;
        // 回合安全网轮询跟着会话走：上一个会话的表不该在新会话上继续跑
        this.stopTurnWatch();
    }

    /**
     * 提交一轮对话时调用：把「进行中」立起来（见 turnRunning 的说明）。
     * 注意它**只改事实、不发帧** —— 页面那个瞬间的「处理中」由它自己上送时的本地乐观行撑着
     * （`outbox.send()` 里置 processing）；本方法只保证之后任何一次行下发算出的 `turnActive` 是对的。
     */
    beginTurn(): void {
        this.turnRunning = true;
        // 记账登记（见 noteTurnSettled）：一次提交对应一次结算
        this.ownPendingTurns += 1;
        // 认为自己在跑 → 开安全网轮询（见 startTurnWatch）：别处停掉时按钮要能自己复位
        this.startTurnWatch();
    }

    /**
     * 提交失败时调用：解除「进行中」（失败的提交不会有 turn/end 来清它）。
     * 与 beginTurn 同：只改事实、不发帧；让页面复位的是随后的 `chatError`（它把乐观行标为未提交成功）。
     */
    endTurn(): void {
        this.turnRunning = false;
        this.ownPendingTurns = Math.max(0, this.ownPendingTurns - 1);
        this.stopTurnWatch();
    }

    async getSession(): Promise<string> {
        if (this.currentSessionId) {
            return this.currentSessionId;
        }
        return this.newSession();
    }

    /**
     * 该工作区内可复用的现存空会话（blank、未归档、**且确实登记在该工作区成员表里**），无则 undefined。
     *
     * 「复用现成的新会话」避免反复新建越积越多，但**判据只能是成员表**：
     *   - 上游网页端也是这么判的（`summary.blank && summary.cwd === workspace.path && workspace.sessionIds.includes(id)`）；
     *   - 曾经这里还允许「cwd 与工作区一致但未登记」的空白会话，那是个**坑**：复用它之后要补登记，
     *     而补登记当时走的是 `workspace.insertSessionBefore`（**排序** API，对未登记的会话直接抛
     *     `WorkspaceMoveInvalidError: the session is not accounted`），异常被吞 → 这条会话谁都不属于，
     *     空白时列表里不显示、**一开口就冒进「未分组」**（真机现象：在工作区里点「新开会话」却落到未分组）。
     *     现在改成只复用成员（非成员一律走下面的新建，`session.create { workspaceId }` 由宿主 attach 登记）。
     */
    private async findReusableBlank(workspaceId: string): Promise<string | undefined> {
        try {
            const { items: wsItems, archivedSessionIds } = await this.listWorkspaces();
            const ws = wsItems.find((w) => w.workspaceId === workspaceId);
            if (!ws) {
                return undefined;
            }
            const archived = new Set(archivedSessionIds ?? []);
            const memberIds = new Set(ws.sessionIds ?? []);
            const sessionList = await this.call<{
                items?: Array<{ sessionId?: string; blank?: boolean; origin?: string }>;
            }>('session.list', {});
            // 仅复用**属于目标工作区**的空白会话：既优先当前正在用的(避免反复“新建”跳去更旧的空会话)，
            // 也绝不跨工作区复用——否则切到新工作区后“新建”会复用旧工作区的当前空白，导致新会话没归对该工作区。
            const members = (sessionList.items ?? []).filter(
                (s) => !!s.sessionId && s.blank === true && s.origin !== 'subagent' && !archived.has(s.sessionId!) && memberIds.has(s.sessionId!)
            );
            const currentFirst = members.find((s) => s.sessionId === this.currentSessionId);
            return currentFirst ? currentFirst.sessionId : members[0]?.sessionId;
        } catch {
            // 列表拉取失败不阻塞：照常新建
        }
        return undefined;
    }

    /**
     * 开启新会话并设为当前。指定 workspaceId 时归入该工作区，缺省用当前文件夹对应的工作区（无文件夹才回未分组）。
     * 同一工作区已存在空白“新会话”时先复用它，不重复创建 → 反复点“新建会话”不会越积越多。
     */
    async newSession(workspaceId?: string): Promise<string> {
        // 工作区优先取显式指定 → 当前 → 自动默认（dsh 里最新 / 当前 VS Code 文件夹）。
        // 三者皆无时不再回退到不带 workspaceId 的 createSession（会落“未分组”），而是抛错让上层引导选工作区。
        let wsId = workspaceId ?? this.currentWorkspaceId;
        if (!wsId) {
            wsId = await this.ensureCurrentWorkspace();
        }
        if (!wsId) {
            throw new DshNoWorkspaceError();
        }
        this.currentWorkspaceId = wsId;
        const reusable = await this.findReusableBlank(wsId);
        if (reusable) {
            // 复用的空白会话可能是靠 cwd 匹配进来的（并未登记在工作区成员表里）→ 补登记，
            // 否则「新建会话」出来的会话在网页端仍落在未分组（真机现象）。
            await this.bindSessionToWorkspace(wsId, reusable).catch(() => false);
            this.setCurrentSession(reusable);
            return reusable;
        }
        const sid = await createSession({ workspaceId: wsId });
        this.setCurrentSession(sid);
        return sid;
    }

    // ---------- 工作区 / 会话历史恢复 ----------

    /**
     * 列出全部工作区（含归档）。
     * 适配 dsh v0.1.5-rc.2：该版本没有 `workspace.list` 远程方法，工作区枚举由 api.workspaceList()
     * 经 `workspace/follow`（/api/remote.mux 流）的 baseline 帧返回（详见 src/dsh/api.ts 中 workspaceList 的 JSDoc）。
     */
    async listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: string[] }> {
        return workspaceList();
    }

    /** 新建工作区：采用一个目录 */
    async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
        return this.call('workspace.create', { path });
    }

    /**
     * 把**尚未归属任何工作区**的会话登记进指定工作区（上游 `workspace.insertSessionBefore` 的登记用途）。
     *
     * 为什么需要：`session.create` 只在**新建时**归属工作区 —— 会话一旦以别的归属（或更早版本、
     * 别的客户端）建出来，就只能靠这个接口补登记。侧栏与网页端的「未分组」判据都是「不在任何工作区的
     * 成员表里」（`listWorkspaceSessions` / `listUngroupedSessions` 都只看成员表，**不按 cwd 推断**），
     * 所以缺登记时它会两边都显示成未分组 —— 补登记之后两边就一致了。
     *
     * **只登记，不搬家**：已经在**任何**工作区成员表里的会话一律不动（那属于"移动"，
     * 不该由"用户点开看了一眼"触发）；工作区不存在也不写。
     *
     * **实现用「幂等收养」而不是 `workspace.insertSessionBefore`**：后者是**排序** API ——
     * `if (!record.sessionIds.includes(id)) throw WorkspaceMoveInvalidError('the session is not accounted')`，
     * 对"还没登记"的会话必然抛错（这个方法存在的意义正是这种会话，所以那条路等于永远无效）。
     * 真正能把已有会话挂进工作区的是 `session.create { sessionId, workspaceId }`：宿主会
     * `ensureSession(id, workspace.path, checkPersistedIdentity=true)` **收养**这条已有会话（历史与 id 都不变），
     * 校验通过后 `workspace.attachSession(id)` 写进成员表；cwd 与工作区路径不一致时明确抛
     * `ApiSessionCwdConflict`（不会把会话挪到错的地方）。
     * 代价：收养会把该会话 resume 成活 agent（等于打开它一次）。
     * @param workspaceId - 目标工作区
     * @param sessionId - 要登记进去的会话
     * @returns 真的补登记了才返回 true
     */
    async bindSessionToWorkspace(workspaceId: string, sessionId: string): Promise<boolean> {
        const { items } = await this.listWorkspaces();
        const target = (items ?? []).find((w) => w.workspaceId === workspaceId);
        if (target === undefined) {
            return false;
        }
        const claimed = (items ?? []).some((w) => (w.sessionIds ?? []).includes(sessionId));
        if (claimed) {
            return false;
        }
        // 幂等收养：同一个 id 再调一次不会新建会话（宿主按 id 收养），只在 cwd 不符时抛冲突。
        await createSession({ sessionId, workspaceId });
        return true;
    }

    /** 当前共享会话 id（webview 会话下拉回显用） */
    getSessionId(): string | undefined {
        return this.currentSessionId;
    }

    /** 当前工作区 id（无则 undefined） */
    getCurrentWorkspaceId(): string | undefined {
        return this.currentWorkspaceId;
    }

    /** 手动切换当前工作区（UI 下拉） */
    setCurrentWorkspace(workspaceId?: string): void {
        this.currentWorkspaceId = workspaceId;
    }

    /**
     * 为当前 VS Code 工作区文件夹解析/复用 DSH 工作区并设为当前；
     * 无文件夹返回 undefined（此时会话回未分组）。按路径归一化匹配，避免重复建。
     */
    async ensureWorkspaceForFolder(): Promise<string | undefined> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.currentWorkspaceId = undefined;
            return undefined;
        }
        const target = normalizePath(folder.uri.fsPath);
        const list = await this.listWorkspaces();
        const existing = (list.items ?? []).find((w) => normalizePath(w.path) === target);
        if (existing?.workspaceId) {
            this.currentWorkspaceId = existing.workspaceId;
            return existing.workspaceId;
        }
        const created = await this.call<{ workspace?: { workspaceId?: string } }>('workspace.create', { path: folder.uri.fsPath });
        this.currentWorkspaceId = created.workspace?.workspaceId;
        return this.currentWorkspaceId;
    }

    /**
     * 解析“当前工作区”，与 dsh 自身一致：插件不额外存记录，直接取 dsh 持久化的
     * workspace 数据（workspace.list ← ~/.dsh/storages/workspace.json 同一份存储）
     * 里 updatedAt 最新者（同值按返回顺序决平手）。
     * 切换工作区 = 给目标工作区挂会话（newSession），其 updatedAt 随之刷新为最新，
     * 下次解析仍是它。仅当 dsh 里一个工作区都没有（全新环境）才回退到
     * “按当前 VS Code 文件夹建首个工作区”兜底，避免会话掉进未分组。
     */
    async ensureCurrentWorkspace(): Promise<string | undefined> {
        if (this.currentWorkspaceId) {
            return this.currentWorkspaceId;
        }
        try {
            const { items } = await this.listWorkspaces();
            let best: WorkspaceView | undefined;
            let bestTime = Number.NEGATIVE_INFINITY;
            for (const w of items) {
                const t = Date.parse(w.updatedAt ?? '');
                if (Number.isNaN(t)) {
                    continue;
                }
                if (t > bestTime) {
                    bestTime = t;
                    best = w;
                }
            }
            if (best) {
                this.currentWorkspaceId = best.workspaceId;
                return best.workspaceId;
            }
        } catch {
            // 列表读不到时落到文件夹兜底
        }
        return this.ensureWorkspaceForFolder();
    }

    /**
     * 当前工作区的根路径（终端卡 cwd 标签的兜底来源）。
     * **只读**：不新建工作区、不改归属——拿不到就返回 undefined，让标签回退 `$`。
     * 工具调用参数里通常不带 workdir，此时用会话工作区根兜底，本方法提供同一份数据。
     */
    async currentWorkspacePath(): Promise<string | undefined> {
        const id = this.currentWorkspaceId;
        if (!id) {
            return undefined;
        }
        try {
            const { items } = await this.listWorkspaces();
            const ws = items.find((w) => w.workspaceId === id);
            // **原样返回作者写法**（只去尾部分隔符），**不要走 normalizePath**：这个值一路传到 webview
            // 当"显示用的相对根"（收起行摘要、读卡横幅、终端卡 cwd 标签），小写化会把 `MyProject`
            // 显示成 `myproject`；换成正斜杠又会让工具给的 Windows 路径（`C:\...`）对不上前缀，
            // 相对化直接失效、整条绝对路径被原样画出来。需要比较归属的地方用 normalizePath，别在这里归一化。
            const path = (ws?.path ?? '').replace(/[/\\]+$/, '');
            return path !== '' ? path : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * 列出某工作区下的已有会话（workspace.list 的 sessionIds + session.list 汇总映射标题）。
     * 排除 subagent 内部会话；空白会话展示为「新会话」；运行中排前。
     * 注意：新建会话不做强制改名，问答后沿用 dsh 自动生成的会话标题。
     */
    async listWorkspaceSessions(
        workspaceId: string
    ): Promise<Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current: boolean }>> {
        const wsList = await this.listWorkspaces();
        const ws = (wsList.items ?? []).find((w) => w.workspaceId === workspaceId);
        const ids = new Set(ws?.sessionIds ?? []);
        if (ids.size === 0) {
            return [];
        }
        const sessionList = await this.call<{
            items?: Array<{
                sessionId?: string;
                running?: boolean;
                blank?: boolean;
                origin?: string;
                cwd?: string;
                /** 上游列表 item：durable title 投影在顶层 title 字段（非空字符串才设置） */
                title?: string;
                /** 上游列表 item：当前 host 计算的投影值包（键含 title 等） */
                projectionValues?: Record<string, unknown>;
                projections?: { values?: Record<string, unknown> };
            }>;
        }>('session.list', {});
        const out: Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current: boolean }> = [];
        for (const s of sessionList.items ?? []) {
            if (!s.sessionId || s.origin === 'subagent') {
                continue;
            }
            const inWorkspace = ids.has(s.sessionId);
            if (!inWorkspace) {
                continue;
            }
            const isCurrent = s.sessionId === this.currentSessionId;
            // 纯空「新会话」：除非它就是当前正在用的会话(显示为选中)，否则不列出
            //（与 dsh 网页一致：无内容的旧会话不占列表，避免越积越多）。运行中的保留。
            if (s.blank && !s.running && !isCurrent) {
                continue;
            }
            out.push({
                sessionId: s.sessionId,
                // 上游三层 fallback：title → cwd basename → sessionId（blank 由 UI 显示“新会话”）
                // durable title 读上游列表 item 顶层 title；兼容旧/变体形状回退 projectionValues / projections.values.title。
                title:
                    s.blank
                        ? '新会话'
                        : sessionDisplayTitle({
                              title: durableTitleOf(s),
                              cwd: s.cwd,
                              sessionId: s.sessionId ?? '',
                          }),
                running: !!s.running,
                blank: !!s.blank,
                current: isCurrent,
            });
        }
        out.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.running) - Number(a.running));
        // 会话名一致性诊断：打印上游返回的每条 sessionId+title（env DSH_RAWLOG=1/full）
        if (process.env['DSH_RAWLOG']) {
            for (const r of out) {
                console.log(`[dsh-raw] session-list ${r.sessionId} title=${JSON.stringify(r.title)} running=${r.running} blank=${r.blank} current=${r.current}`);
            }
        }
        return out;
    }

    /**
     * 列出**不属于任何工作区**的会话（网页端的「未分组」那一组）。
     *
     * 判据与网页端**完全一致**：不属于**任何**工作区的成员表（`owningGroupKey` 的口径）就是未分组 ——
     * 不按 `cwd` 推断、也没有标题门槛。这样同一个会话在两侧的分组必然相同。
     * 与工作区列表一样：排除 subagent（它们在网页端是父会话下的子行）、排除归档、
     * 不列没用过的空白会话（正在用/运行中的除外）。
     * @returns 与工作区列表同形状的行（空数组 = 侧栏不显示这一组）
     */
    async listUngroupedSessions(): Promise<
        Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current: boolean }>
    > {
        const { items: wsItems, archivedSessionIds } = await this.listWorkspaces();
        const memberIds = new Set<string>();
        for (const w of wsItems ?? []) {
            for (const id of w.sessionIds ?? []) {
                memberIds.add(id);
            }
        }
        const archived = new Set(archivedSessionIds ?? []);
        const sessionList = await this.call<{
            items?: Array<{
                sessionId?: string;
                running?: boolean;
                blank?: boolean;
                origin?: string;
                cwd?: string;
                title?: string;
                projectionValues?: Record<string, unknown>;
                projections?: { values?: Record<string, unknown> };
            }>;
        }>('session.list', {});
        const out: Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current: boolean }> = [];
        /** 诊断用：未分组会话按 cwd 归类（见方法末尾的日志）。 */
        const cwdCount = new Map<string, number>();
        for (const s of sessionList.items ?? []) {
            if (!s.sessionId || s.origin === 'subagent' || archived.has(s.sessionId)) {
                continue;
            }
            if (memberIds.has(s.sessionId)) {
                continue;
            }
            const isCurrent = s.sessionId === this.currentSessionId;
            if (s.blank && !s.running && !isCurrent) {
                continue;
            }
            const cwdKey = typeof s.cwd === 'string' && s.cwd !== '' ? s.cwd : '(无 cwd)';
            cwdCount.set(cwdKey, (cwdCount.get(cwdKey) ?? 0) + 1);
            out.push({
                sessionId: s.sessionId,
                title: s.blank
                    ? '新会话'
                    : sessionDisplayTitle({
                          title: durableTitleOf(s),
                          cwd: s.cwd,
                          sessionId: s.sessionId ?? '',
                      }),
                running: !!s.running,
                blank: !!s.blank,
                current: isCurrent,
            });
        }
        // 诊断（真机排查「会话为什么在未分组」）：**未分组会话按 cwd 归类**，并把各工作区的路径与成员数一并打出。
        // 判读：某个 cwd 与某工作区路径相同却仍在这里 → 宿主那一侧的 cwd 过滤/索引没认它（不是"没有归属"）；
        // cwd 五花八门或为空 → 这些会话本来就没归属（旧版本建的 / 网页端 / 终端建的）。
        // 宿主的工作区投影原样是 `record.sessionIds.filter(id => sessionPath(id) === record.path)`（见 dsh-workspace entity）。
        if (out.length > 0) {
            const top = [...cwdCount].sort((a, b) => b[1] - a[1]).slice(0, 6);
            console.warn(
                `[dsh-ws] ungrouped=${out.length}；工作区=${(wsItems ?? [])
                    .map((w) => `${w.path}(${(w.sessionIds ?? []).length})`)
                    .join(' , ') || '(无)'}`
            );
            console.warn(
                `[dsh-ws] ungrouped cwd 分布（前 ${top.length}）：${top.map(([cwd, n]) => `${n}× ${cwd}`).join(' | ')}`
            );
        }
        out.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.running) - Number(a.running));
        return out;
    }

    /**
     * 从一段已完成回合分叉出新会话（标题升号交给宿主，见下）。
     * 为什么升号：分叉会把源会话的**标题事件一并复制**进子会话，不升号两者在会话列表里同名。
     * **升号是宿主的能力**（分叉请求里带 `increaseTitle`，与上游客户端同一做法）——客户端自己
     * `durableTitleFor` + 算号 + `rename` 是把这个能力重做一遍，而且本地只拿得到**源标题**、
     * 看不到已有的兄弟会话，于是同一个源分叉两次会得到两个 `(1)`（真机反馈）。
     * @param sessionId - 源会话。
     * @param atSeq - 切点事件序号；省略 = 从最后一条已完成回合分叉。
     * @returns 子会话标识与它的标题（读不到标题时为 undefined）。
     */
    async forkSession(sessionId: string, atSeq?: number): Promise<{ sessionId: string; title?: string }> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法分叉会话');
        }
        const childId = await forkSessionRpc(sessionId, atSeq);
        // 归属：子会话**继承源会话的工作区**。
        // 为什么必须自己登记：`session.fork` 只在**源会话**上做文章（复制历史、按 cwd 继承工作目录），
        // 不会把子会话写进任何工作区的成员表；而侧栏/网页端的「未分组」判据**只看成员表**（不按 cwd 推断），
        // 于是分叉出来的会话一落地就掉进「未分组」（真机现象）——与当初「新建会话」那次是同一个坑。
        // 源会话自己就没归属（未分组）时**不动**：那不是搬家，是"跟着源走"。
        await this.bindForkChild(sessionId, childId);
        // 子会话事实（谁是它的父 + 父在不在）：刚分叉出来的子会话马上就会用上 —— 它在跑的时候
        // 「停止」要走父级中断，不能等下一次列表刷新才知道自己的父是谁。
        await this.refreshSubagentFacts();
        // 标题由**宿主**升号（分叉请求里的 `increaseTitle`）——这里只把结果读回来给提示用；
        // 读不到就只提示"已分叉"，**不再自己算名字**（客户端算号会与宿主打架，且看不到兄弟会话）。
        let title: string | undefined;
        try {
            const name = await this.durableTitleFor(childId);
            if (name !== '') {
                title = name;
            }
        } catch {
            // 读标题失败不影响分叉本身
        }
        // 分叉是"看着没有任何变化"的操作（子会话继承到切点为止的完整历史，界面内容一模一样），
        // 所以把每一步留在控制台，出问题时能一眼看出是没触发、失败、还是成功但看不出差别。
        console.warn(
            `[dsh-fork] source=${sessionId} atSeq=${String(atSeq)} child=${childId} ` +
                `title=${title ?? '(未读到标题)'}`
        );
        return { sessionId: childId, ...(title === undefined ? {} : { title }) };
    }

    /** 直接父地址表：`childSessionId` → 地址（来源与上游同：父会话自有的子目录投影）。 */
    private subagentAddresses = new Map<string, DshSubagentAddress>();
    /** 父 Agent 可用性（列表 summary 的 `agentAvailable`）；缺项 = 还没读到。 */
    private subagentParentAvailable = new Map<string, boolean>();
    /** 列表事实是否读到过（没读到就不下"父不可用"的结论）。 */
    private subagentFactsReady = false;

    /**
     * 刷新**子会话事实**：谁是谁的子会话 + 父 Agent 是否可用。
     *
     * 上游的两条来源：① 父会话自有的 `subagentCatalog` 投影（条目 `{id, mode, …}`，客户端据它拼出
     * `{parentSessionId, childSessionId, mode}`）；② 列表 summary 的 `agentAvailable` 当"父是否可用"。
     * 插件**不另开订阅**：`session/list` 的每一项本来就带自己的投影值与可用性，一次调用就够
     * （与上游"子会话经 Host 列表到达、地址从目录投影读"同口径）。
     *
     * 失败只记日志：这只是停止分流用的辅助事实，读不到就退回"没有地址"那条路（`session.cancel`）。
     */
    async refreshSubagentFacts(): Promise<void> {
        try {
            const list = await this.call<{
                items?: Array<{
                    sessionId?: string;
                    agentAvailable?: boolean;
                    projections?: { values?: Record<string, unknown> };
                }>;
            }>('session.list', {});
            const addresses = new Map<string, DshSubagentAddress>();
            const available = new Map<string, boolean>();
            for (const item of list.items ?? []) {
                if (typeof item.sessionId !== 'string') {
                    continue;
                }
                if (typeof item.agentAvailable === 'boolean') {
                    available.set(item.sessionId, item.agentAvailable);
                }
                const catalog = item.projections?.values?.['subagentCatalog'];
                if (!Array.isArray(catalog)) {
                    continue;
                }
                for (const entry of catalog) {
                    const row = entry as { id?: unknown; mode?: unknown };
                    if (typeof row.id !== 'string') {
                        continue;
                    }
                    addresses.set(row.id, {
                        parentSessionId: item.sessionId,
                        childSessionId: row.id,
                        mode: typeof row.mode === 'string' ? row.mode : 'unknown',
                    });
                }
            }
            this.subagentAddresses = addresses;
            this.subagentParentAvailable = available;
            this.subagentFactsReady = true;
        } catch (e) {
            console.warn(`[dsh-subagent] 读取子会话事实失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * 当前会话的子会话事实（页面据此判主钮能不能让出「停止」、要不要另挂独立 Stop、输入区是否被锁）。
     * @param sessionId - 目标会话。
     * @returns 地址（没有 = 普通会话）与父可用性（`undefined` = 还不知道）。
     */
    subagentFactsOf(sessionId: string | undefined): {
        address?: DshSubagentAddress;
        parentAvailable?: boolean;
    } {
        if (sessionId === undefined) {
            return {};
        }
        const address = this.subagentAddresses.get(sessionId);
        if (address === undefined) {
            return {};
        }
        const parentAvailable = this.subagentParentAvailable.get(address.parentSessionId);
        return { address, ...(parentAvailable === undefined ? {} : { parentAvailable }) };
    }

    /** 列表事实是否读到过（页面据此决定"父不可用"要不要下结论）。 */
    subagentFactsReadyNow(): boolean {
        return this.subagentFactsReady;
    }

    /**
     * 停止当前这一轮：**普通会话走 `session.cancel`，子会话走父级中断**（分流判据见 `stop-target.ts`）。
     *
     * 与上游同一个 `Session.cancel()`：有父地址就走 `subagents.interruptByParent(child, parent,
     * 'continuable')`（持久父地址权威，父不在线也能中断），否则退回 `session.cancel`。
     * @param sessionId - 要停的会话（缺省 = 当前会话）。
     */
    async cancelTurn(sessionId?: string): Promise<void> {
        const sid = sessionId ?? (await this.getSession());
        const target = stopTargetOf(sid, this.subagentAddresses.get(sid));
        if (target.method === 'subagents.interruptByParent') {
            await interruptSubagent(target.params['childSessionId'] as string, target.params['parentSessionId'] as string);
            return;
        }
        await cancelSession(sid);
    }

    /**
     * 把分叉出来的子会话登记进**源会话所在的工作区**（源会话没归属时不动）。     *
     * 为什么要有这一步：`session.fork` 只复制历史与 cwd，**不会**写工作区成员表；而「未分组」的判据
     * 就是「不在任何工作区的成员表里」——不登记就会分叉完立刻掉进未分组。
     * 失败只记日志：分叉本身已经成功，归属没写上不该把它算成失败（用户可再点开该会话补登记）。
     * @param sourceId - 源会话。
     * @param childId - 刚建好的子会话。
     */
    private async bindForkChild(sourceId: string, childId: string): Promise<void> {
        try {
            const { items } = await this.listWorkspaces();
            const owner = (items ?? []).find((w) => (w.sessionIds ?? []).includes(sourceId));
            if (owner === undefined) {
                return;
            }
            const bound = await this.bindSessionToWorkspace(owner.workspaceId, childId);
            console.warn(`[dsh-fork] 子会话归属：workspace=${owner.workspaceId} bound=${String(bound)}`);
        } catch (e) {
            console.warn(`[dsh-fork] 子会话归属登记失败（分叉本身已完成）：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** 指定会话的 durable 标题（空串 = 它还没有标题）；读列表失败也返回空串，由调用方决定跳过。 */
    private async durableTitleFor(sessionId: string): Promise<string> {
        const list = await this.call<{
            items?: Array<{
                sessionId?: string;
                blank?: boolean;
                title?: string;
                projectionValues?: Record<string, unknown>;
                projections?: { values?: Record<string, unknown> };
            }>;
        }>('session.list', {});
        const item = (list.items ?? []).find((s) => s.sessionId === sessionId);
        if (!item || item.blank) {
            return '';
        }
        return durableTitleOf(item) ?? '';
    }

    // ---------- 消息反馈（👍/👎） ----------

    /** 读该会话的全部消息反馈（UI 首次交互时才调；结果只进会话日志，不进模型上下文）。 */
    async listFeedback(sessionId: string): Promise<MessageFeedbackItem[]> {
        return await listMessageFeedback(sessionId);
    }

    /**
     * 写入或替换一条反馈。`ifVersion` 用**观察到的现值版本**做 CAS（null = 首次评价）；
     * 业务失败（冲突/超长/目标不存在）**不抛错**，原样返回给调用方按 code 决定文案。
     */
    async putFeedback(
        sessionId: string,
        messageId: string,
        rating: FeedbackRating,
        note: string | undefined,
        category: FeedbackCategory | undefined,
        ifVersion: string | null
    ): Promise<FeedbackOutcome<MessageFeedbackItem>> {
        return await putMessageFeedback({
            sessionId,
            messageId,
            rating,
            ...(note === undefined || note === '' ? {} : { note }),
            ...(category === undefined ? {} : { category }),
            ifVersion,
        });
    }

    /** 撤回一条反馈（同版本 CAS；已不存在时服务端直接成功）。 */
    async deleteFeedback(
        sessionId: string,
        messageId: string,
        ifVersion: string
    ): Promise<FeedbackOutcome<{ absent: true }>> {
        return await deleteMessageFeedback({ sessionId, messageId, ifVersion });
    }

    /** 恢复会话：设为当前共享会话并返回消息历史（供 UI 渲染，协议解析复用事件投影） */
    async restoreSession(sessionId: string): Promise<SessionMessageItem[]> {
        // ⚠️ **同一个会话再打开时，只有"手上这份窗口是空的"才重读快照**。
        //
        // 只做 `pushCurrentRows()` 是把**上一次那份窗口**再推一遍：万一那次订阅恰好是空的
        //（快照到得早/当时还没内容），这份空窗口会被反复推下去 —— 同一个会话**永远**打不开
        //（真机现象：分叉出来的子会话、以及别的历史会话"打开没内容、没反应"）。
        // 但**无脑重读**会把"切回上一个会话"也变成整份重载（真机反馈：打开会话卡顿）——
        // 手上明明有内容时没有理由丢掉它。所以：空窗口才走重开（`setCurrentSession(undefined)`
        // 取消旧订阅并复位水位，随后那条路 = 换会话：重开订阅 + 首帧快照替换窗口）。
        if (this.currentSessionId === sessionId && this.window.list().length === 0) {
            this.setCurrentSession(undefined);
        }
        // 会话标识没变时 setCurrentSession 直接返回（不重读快照、不下发任何行），
        // 而**行的唯一来源就是宿主下发**（开关打开时旧的历史指令被忽略）——
        // 页面这时可能刚打开/刚清空，必须补一次基线，否则打开该会话是空白。
        if (!this.setCurrentSession(sessionId)) {
            this.pushCurrentRows();
        }
        // **不读**旧格式的历史：行由宿主下发，这次读取既用不上，
        // 一旦它失败还会把调用方卡在 loading（真机现象「有的会话打开一直显示深度求索中」）。
        return [];
    }


    // ---------- 上游投影 / 模型 / 权限 ----------

    /**
     * 读取当前会话的上游投影（sessionStats / tokenUsage / permissions / title 等）。
     *
     * `permissions` 这里必须拼上进程级目录再返回 —— **页面看到的 chatInfo.projections 就是本方法的返回值**
     * （`extension.postChatInfo` 直接把它塞进 chatInfo），而 0.1.7 起的投影只有 `currentValue`。
     * 只改 `currentProjections()` 是不够的：那条只喂「会话统计 / 上下文环」的整表推送，与 chatInfo 各走一条路。
     */
    async getProjections(): Promise<Record<string, unknown>> {
        const sid = this.currentSessionId;
        if (!sid) {
            return {};
        }
        const projections = await getSessionProjections(sid);
        const permissions = projections['permissions'];
        if (permissions === undefined) {
            return projections;
        }
        this.ensurePermissionCatalog();
        return { ...projections, permissions: withPermissionOptions(permissions, this.permissionCatalog) };
    }

    /**
     * 主动重读一次投影并喂进缓存（换到控制流基线里没有的会话时用；失败静默 —— 常驻控制流随后会推）。
     *
     * 为什么需要这一下：控制流的**基线只在订阅打开时给一次**，此后新建的会话不在里面；
     * 不主动读一次，输入框下方那两张卡要等这个会话第一次产生投影变化才出现。
     */
    private async refreshProjections(): Promise<void> {
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return;
        }
        try {
            const projections = await this.getProjections();
            if (this.currentSessionId !== sid || Object.keys(projections).length === 0) {
                return; // 期间换过会话 / 读不到：这次读数作废
            }
            this.seedProjections(projections);
        } catch {
            // 服务未就绪：控制流随后会推变化
        }
    }

    /**
     * 目标条的动作（编辑 / 暂停 / 恢复 / 清除）——**直接打上游的 goal RPC**，不走 `/goal` 命令。
     *
     * 为什么不用 `/goal`：命令要**下一轮**才被 agent 处理（会多跑一次模型回合），而目标条上的按钮
     * 是即时操作。上游 `ui-goal` 也是这么打的（`ctx.remote.goals.edit|pause|resume|clear`，
     * `client/index.ts:102-120`）。
     *
     * **CAS 用投影里的 `{id, revision}`**：上游服务端拿它做 compare-and-set（`expectCurrent`），
     * 版本不符会报错 —— 所以每次动作**现读投影**、不缓存，避免拿旧 revision 撞 CAS。
     * 上游动作失败时返回 `{ok:false,error}` 由条内联显示；这里同口径：返回错误文案给页面。
     *
     * @param action - edit（带 objective）/ pause / resume / clear
     * @returns 成功时返回空对象；失败时返回 `{ error: '<message> (<code>)' }`
     */
    async goalAction(
        action: 'edit' | 'pause' | 'resume' | 'clear',
        objective?: string
    ): Promise<{ error?: string }> {
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return { error: 'no-current-goal (当前没有会话)' };
        }
        const proj = await getSessionProjections(sid);
        const ref = goalRefOf(proj['goal']);
        if (ref === undefined) {
            return { error: 'no-current-goal (会话里没有目标)' };
        }
        const method = `goals/${action}`;
        const args: Record<string, unknown> = { agentId: sid, ref };
        if (action === 'edit') {
            args['request'] = { objective: objective ?? '' };
        }
        try {
            await this.call(method, args);
            return {};
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const code = e instanceof DshRpcError ? e.code : undefined;
            return { error: code === undefined ? msg : `${msg} (${code})` };
        }
    }

    /** 列出可用模型 + 当前选择 + 推理等级（rc1：目录=session/modelCatalog，当前=modelSelection 投影） */
    async listModels(): Promise<{
        current?: { provider?: string; model?: string; reasoningEffort?: string };
        groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string; reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string } }> }>;
        /** 上游对加载失败 provider/组的提示（原样透传；UI 只显示组数） */
        failures?: unknown[];
    }> {
        const catalog = await modelCatalog();
        let current: { provider?: string; model?: string; reasoningEffort?: string } | undefined;
        // 有当前会话 → 读它的 modelSelection 投影；无会话但已有当前工作区 → 先挂一个（已带工作区，不会落未分组）；
        // 两者皆无（尚未选工作区）→ 只返回全局模型目录、当前选择留空，绝不静默建“未分组”会话。
        const sid = this.currentSessionId ?? (this.currentWorkspaceId ? await this.getSession() : undefined);
        if (sid) {
            try {
                const proj = await getSessionProjections(sid);
                const sel = proj['modelSelection'] as
                    | { next?: { provider?: string; model?: string; reasoningEffort?: string } | null; lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null }
                    | undefined;
                current = sel?.next ?? sel?.lastUsed ?? undefined;
            } catch {
                // 投影读不到不阻塞
            }
        }
        return {
            current: current ?? catalog.default,
            groups: catalog.groups,
            failures: catalog.failures,
        };
    }

    /** 选择模型 / 推理等级 */
    async selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void> {
        const sid = await this.getSession();
        await this.call('session.selectModel', {
            sessionId: sid,
            provider,
            model,
            ...(reasoningEffort ? { reasoningEffort } : {}),
        });
    }

    /** 列出 dsh 支持的 agent 模式（当前会话仍按投影 agentPreset 单独读） */
    async listAgentPresets(): Promise<DshAgentPresetRoster> {
        return listAgentPresetsRpc();
    }

    /**
     * 读某个模式声明的**子插件组合**（F9 的「查看配置」，上游 `agentPresets/read`，dsh 0.1.7 新增）。
     * 仅供查看：上游标注 for viewing only，插件不据此做生效判断、也不写回。
     */
    async readAgentPreset(agentPreset: string): Promise<DshAgentPresetDocument> {
        return readAgentPresetRpc(agentPreset);
    }

    /**
     * 读上游「设置 → 通用设置」四项偏好（工作步骤展示 / 性能与用量 / 代码工作工具 / 繁忙时的发送行为）。
     * 只读透传：读不到返回 undefined，调用方应保留上次值，别拿它当默认值（那会把读失败伪装成用户选择）。
     */
    async readChatPrefs(): Promise<DshChatPrefs | undefined> {
        return readChatPrefsRpc();
    }

    /** 最近一次读到的四项偏好（新面板回填用，省一次 RPC） */
    getCachedChatPrefs(): DshChatPrefs | undefined {
        return getCachedChatPrefsRpc();
    }

    /** 订阅上游「设置 → 通用设置」四项偏好变更（emit 实时跟随 + 重连后重读对齐）；返回退订函数 */
    subscribeChatPrefs(cb: (prefs: DshChatPrefs) => void): () => void {
        return subscribeChatPrefsRpc(cb);
    }

    /** 切换当前会话的 agent 模式（仅空白会话可切，后端会拒绝已开始的会话） */
    async switchAgentPreset(agentPreset: string): Promise<string> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法切换模式');
        }
        const sid = await this.getSession();
        return selectAgentPresetRpc(sid, agentPreset);
    }

    /**
     * 读取图片附件字节（会话内**被引用过**的附件；供聊天页图片卡按需取，见 webview 的附件大类）。
     * @param attachmentId - 结果 image 块里的 `attachment.attachmentId` 原值（不透明，不解析）。
     * @returns 媒体类型 + 裸 base64。
     */
    async readImageAttachment(attachmentId: string): Promise<{ mediaType: string; data: string }> {
        const sid = await this.getSession();
        return readSessionAttachment(sid, attachmentId);
    }

    /**
     * 切换权限预设：执行 `/permission` 斜杠命令（走 commands/execute 斜杠端点，勿用 session.prompt 文本）。
     *
     * 返回值是上游的**结算文案**（成功为 `preset <name>`）。当前调用方不用它 —— 上游
     * `chat-visibility.ts` 的 `isVisibleChatNode()` **显式把权限命令排除在 chat 行之外**，
     * 所以切权限在对话区本就不该有任何回显。保留返回值是为了把上游契约写在这里，
     * 免得后人再拿 `result.text` 去拼一行。
     */
    async setPermissionPreset(preset: string): Promise<string> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法切换权限');
        }
        const sid = await this.getSession();
        const exec = await runSessionCommand(sid, `/permission ${preset}`);
        const text = exec?.result?.text;
        if (!exec || exec.result?.kind === 'error') {
            throw new Error(text || `未知权限预设：${preset}`);
        }
        return text ?? `preset ${preset}`;
    }

    /** 对话：发消息到共享会话并等回复（正文从构建出的行里取，见 askStreaming）。 */
    async ask(text: string, opts: { isCancelled?: () => boolean } = {}): Promise<string> {
        const result = await this.askStreaming([{ type: 'text', text }], opts);
        return result.text;
    }

    /** 响应审批：允许一次 / 拒绝（rc.1 走 $events 流应答） */
    async approvalResponse(approvalId: string, allow: boolean): Promise<void> {
        const handled = await dshEvents.approve(approvalId, allow ? 'allowed-once' : 'rejected');
        if (!handled) {
            throw new Error('未找到对应的审批请求（可能已过期或已在网页端处理），请到 dsh 网页面板确认');
        }
    }

    /**
     * 提交一轮对话并等它结束。
     *
     * **不另开 `session/follow`**：本轮等待骑在会话已有的那条常驻订阅上（见 watchTurnEnd），
     * 内容的渲染由那条订阅构建的行承载。返回的 text/stats/counts 全部从**构建出的行**里取，
     * 不再由这条通路自己解析事件 —— 同一份数据只有一个来源（`CLAUDE.md` §5.1）。
     */
    async askStreaming(
        content: DshContentPart[],
        opts: {
            isCancelled?: () => boolean;
            /** 提交标识（页面 mint）：原样传给 `session/prompt` 的 requestId，回显据此认领 */
            requestId?: string;
        } = {}
    ): Promise<{ text: string; stats: DshReplyStats; time?: number; end?: { kind: string; message?: string }; counts?: DshTurnCounts }> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法对话');
        }
        const sid = await this.getSession();
        // 水位要等首帧快照到位才可信；否则会把快照回放里的历史 turn/end 当成这一轮
        await this.awaitWindowSeeded();
        const assistantsBefore = this.assistantRowCount();
        const watch = this.watchTurnEnd(sid, this.durableSeq, opts.isCancelled);
        try {
            await sendPrompt(sid, content, opts.requestId);
        } catch (e) {
            // 没发出去：撤销登记，否则下一次 turn/end 会被认成这一轮
            watch.cancel();
            throw e;
        }
        try {
            await watch.done;
        } finally {
            watch.cancel();
        }
        const row = this.newAssistantRow(assistantsBefore);
        return {
            text: row?.text ?? '',
            stats: (row?.stats ?? {}) as DshReplyStats,
            ...(row?.timeMs === undefined ? {} : { time: row.timeMs }),
            // 失败原因不再挂在回答行上（它是**独立行**，镜像上游 `turn-error`），所以这里只带终止档位；
            // 本条 payload 属**已退役**的旧 `chatDone` 通路（`extension.ts` 的调用点不接返回值），保留形状即可
            ...(row?.status === undefined ? {} : { end: { kind: row.status } }),
            ...(row === undefined ? {} : { counts: row.counts }),
        };
    }

    /** 回答 ask_user_question（rc.1 走 $events 流应答） */
    async answerQuestion(
        rpcId: string,
        answers: Array<{ id: string; selected: string[]; custom?: string }>
    ): Promise<void> {
        const handled = await dshEvents.answerQuestion(rpcId, answers);
        if (!handled) {
            throw new Error('未找到对应的提问（可能已过期或已在网页端处理），请到 dsh 网页面板确认');
        }
    }

    /**
     * **补答**一道限时提问（timed 提问超时后转入的「已继续」态）。
     *
     * 与 `answerQuestion` 是**两条通道**，别混：那条走 `$events` 瀑布（当前这一轮的阻塞式提问应答），
     * 这条走平铺 args 的远端调用，补答会被投递成**新一轮用户消息**。
     * @param callId - 该次提问的调用标识（来自会话投影 `userQuestions` 的 `active`）。
     * @param answers - 每条作答，上游要求恰好覆盖该次提问的每道题一次。
     * @param sessionId - 会话 id；缺省用当前会话（页面不单独持有会话 id）。
     * @returns `true` = 已被受理（回复排队等待投递）；`false` = 该题已不是可补答态（**不是错误**）；
     *          `undefined` = 远端没有给出布尔（保守按已受理处理）。
     */
    async answerLateQuestion(
        callId: string,
        answers: readonly DshLateAnswerItem[],
        sessionId?: string
    ): Promise<boolean | undefined> {
        const target = sessionId === undefined || sessionId === '' ? this.currentSessionId : sessionId;
        if (target === undefined || target === '') {
            throw new Error('当前没有打开的会话，无法补答这道提问');
        }
        const value = await rpcCall<boolean | undefined>('userQuestions/answer', lateAnswerArgs(target, callId, answers));
        return typeof value === 'boolean' ? value : undefined;
    }

    /** 取消 ask_user_question（rc.1 以 UserQuestionError/ASK_CANCELLED 拒绝该 waterfall） */
    /**
     * 取消一次挂起的提问。
     * @returns 是否真的取消到了（`false` = 该提问已不在挂起表里）。
     *
     * **「找不到」不是错误**：它意味着这次提问已经处理完了 —— 可能是用户先停了本轮（服务端随即 resolve 掉它）、
     * 也可能 `$events` 断流时清过表、或在网页端答过。把它当失败去回退，会把「已经好了」当成「出错了」。
     * 只有**发送取消结果本身失败**（网络/网关）才抛错，由调用方决定是否回退。
     */
    async cancelQuestion(rpcId: string, sessionId: string): Promise<boolean> {
        void sessionId;
        return await dshEvents.cancelQuestion(rpcId);
    }

}
