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
    renameSession,
    listMessageFeedback,
    putMessageFeedback,
    deleteMessageFeedback,
    type MessageFeedbackItem,
    type FeedbackOutcome,
    type FeedbackRating,
    type FeedbackCategory,
    getSessionProjections,
    type DshEndpoint,
    type DshReplyStats,
    type DshTurnCounts,
    type DshApproval,
    type DshContentPart,
    type DshQuestionRequest,
    type SessionMessageItem,
    rpcCall,
    runSessionCommand,
    readSessionAttachment,
    modelCatalog,
    workspaceList,
    dshEvents,
    followSession,
    buildRows,
    foldTodos,
    type DshFollowHandle,
    type DshFollowWindow,
    type DshStreamEvent,
    type DshStreamRow,
    type DshTodoItem,
    followControl,
    type DshQueueItem,
    type DshControlHandle,
    updateQueue as updateQueueRpc,
    type DshPromptMode,
    type DshQueueAction,
    readContextPressure,
    readContextBreakdown,
    type DshContextFacts,
    listAgentPresets as listAgentPresetsRpc,
    selectAgentPreset as selectAgentPresetRpc,
    readTranscriptView as readTranscriptViewRpc,
    getCachedTranscriptView as getCachedTranscriptViewRpc,
    subscribeTranscriptView as subscribeTranscriptViewRpc,
    type DshAgentPresetRoster,
    type DshTranscriptView,
} from '../dsh';
import { sessionDisplayTitle } from '../dsh/official/session-title';
import { liveChunkSeq } from '../dsh/official/live-chunk-seq';
import { expandAssistantStream } from '../dsh/official/assistant-stream';
import { increasedForkTitle } from '../dsh/official/fork-title';

const NODE_REQUIREMENT = '^22.19.0 || >=24.0.0';
/**
 * 「上次自起的那个实例」在 globalState 里的落盘键：`{ port, pid?, authUrl? }`。
 *
 * 为什么需要：自起用的是 `--port 0`（随机端口），而重新发现只探 `dsh.port` / 3080 ——
 * 于是扩展宿主被强杀 / 崩溃后，旧实例还在跑却找不回来，下次又起一个，端口与进程越堆越多。
 * 落盘后下次先探它、探到就复用。
 */
const OWNED_ENDPOINT_KEY = 'dsh.ownedEndpoint';

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
    /** 本会话收到的事件（保结构）：**行构建的唯一输入**；换会话时清空。 */
    private streamEvents: DshStreamEvent[] = [];
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
    /** 当前增量流版本号（取自快照基线；实时帧必须逐帧 +1）。 */
    private assistantRevision: number | undefined;
    /** 进行中尝试的标识与**下一个期望的块序号**（取自快照基线 + 实时 start 帧）。 */
    private attemptId: string | undefined;
    private attemptNextIndex = 0;
    /** 正在重开订阅：避免同一次不一致触发多次。新快照到达（adoptBaseline）即解除。 */
    private rebaselining = false;
    /** 连续「打开页缺基线」的次数：只重试一次，仍缺就降级继续（防与不合规的服务端死循环）。 */
    private missingBaselineStreak = 0;
    /** 上一条已下发的任务清单指纹（去重用；窗口重建时清掉，见 emitTodos）。 */
    private todosKey = '';
    /** 合并窗口的定时器（见 emitRows）：非空 = 已排队，不重复安排。 */
    private rowsTimer: ReturnType<typeof setTimeout> | undefined;
    /** 上一次全量构建的耗时（毫秒）：节流的下限取它，慢会话不会把自己堆死。 */
    private lastBuildMs = 0;
    /** 「无正文」自愈的重开次数（每会话限次：与服务端互相踢比缺正文更糟）。 */
    private reseedCount = 0;
    /** 已报过的「无正文」窗口形态（同一个形态只报一次，否则每次 flush 都刷屏）。 */
    private blankAnswerKey = '';
    // 当前工作区（缺省按 VS Code 文件夹自动解析，避免会话全部掉进"未分组"）
    private currentWorkspaceId: string | undefined;

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
        this.controlHandle?.cancel();
        this.controlHandle = undefined;
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
        this.ownPendingTurns = 0; // 上一个会话没结算完的提交不再由本会话的 turn/end 结算
        // 新会话的窗口还没收到快照 → 水位不可信；同时把上一会话的等待者与就绪者放掉（否则它们永远挂着）
        this.windowSeeded = false;
        for (const resume of this.seedWaiters.splice(0)) {
            resume();
        }
        this.settleTurnWaiters(new Error('会话已切换，本轮等待已取消'));
        this.followHandle?.cancel();
        this.followHandle = undefined;
        if (sessionId !== undefined) {
            // 队列流是 host-wide 的：建一次就够（不随会话切换重开），这里只确保它已经在
            this.ensureControl();
            this.pushQueue();
            this.pushContext();
            // 订阅的**首帧就是快照页**，它替换整个事件窗口（上游同口径）——所以不必再单独读一次快照：
            // 重连也由它把断线期间错过的记录补齐（断线窗口内的帧不会补发）。
            this.followHandle = followSession(sessionId, {
                onSnapshot: (win) => {
                    this.replaceWindow(win);
                },
                onEvent: (event) => {
                    const ev = event as DshStreamEvent;
                    if (ev.type === 'turn/end') {
                        this.turnRunning = false; // 本轮结束（不论正常还是被停止）
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
     * 本会话是否**有一轮正在跑**：从事件尾部往回看，先遇到 `turn/end` 就是已结束、先遇到 `turn/start` 就是在跑。
     * 页面需要这个**显式事实** —— 只从「行」推导不出来：用户消息回显后、回答行还没建的那一瞬，
     * 末行是用户行，推导会把「处理中」算成 false（按钮中途变回「发送」并禁用）。
     */
    private turnActive(): boolean {
        for (let i = this.streamEvents.length - 1; i >= 0; i -= 1) {
            const t = this.streamEvents[i].type;
            if (t === 'turn/end') {
                // 事件流已经给出定论：**顺手清掉那个缓存标记** —— 它只是用来盖住
                // 「提交了但 turn/start 还没到」的窗口，事件流一旦有定论就不该再影响判断。
                // 否则任何一次没收到 turn/end 的回合都会让它永远为真（打开任何会话都显示「终止」）。
                this.turnRunning = false;
                return false;
            }
            if (t === 'turn/start') {
                return true;
            }
        }
        // 事件流里没有未闭合的回合：这在正常会话里意味着「不在跑」，
        // 唯一例外是刚提交、`turn/start` 尚未到达 —— 那正是缓存标记要覆盖的窗口。
        return this.turnRunning;
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
    }

    /**
     * 队列订阅（host-wide）：一条流服务所有会话，建一次就够。
     *
     * 队列只活在 agent 的收件箱里、**不进日志**，所以 `session/follow` 的历史窗口里没有它 ——
     * 页面刷新/重连之后，队列只能由这条流的首帧整表重建。
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
            onProjection: (sessionId, key, value) => {
                this.noteContextProjection(sessionId, key, value);
            },
        });
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
     * `session/control` 的投影帧：只认上下文占用那两个键。
     *
     * 其余键（todos / goal / plan / 统计…）本插件另有来路（`session/follow` 快照 + `chatInfo`），
     * 在这里一并处理就等于同一份数据有两个来源，迟早只更新到一半。
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

    /** 用一次投影快照（`chatInfo` 那条路）补上下文占用；两个键都没有时**不覆盖**已有缓存。 */
    seedContext(projections: Record<string, unknown>): void {
        const sid = this.currentSessionId;
        if (sid === undefined) {
            return;
        }
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
        const frame = ev.frame;
        if (frame === undefined) {
            return true;
        }
        // 版本号必须逐帧 +1：跳变说明中间丢过帧，此时攒出来的正文是**带洞**的
        const revision = typeof frame['revision'] === 'number' ? (frame['revision'] as number) : undefined;
        if (revision !== undefined) {
            if (this.assistantRevision !== undefined && revision !== this.assistantRevision + 1) {
                this.requestRebaseline('增量帧版本号跳变');
                return false;
            }
            this.assistantRevision = revision;
        }
        const kind = frame['type'];
        const frameAttempt = typeof frame['attemptId'] === 'string' ? (frame['attemptId'] as string) : undefined;
        const index = typeof frame['index'] === 'number' ? (frame['index'] as number) : undefined;
        if (kind === 'start') {
            // 上一个尝试没收尾就又开一个：只有服务端侧的基线能说清当前状态 → 重新定基
            if (this.attemptId !== undefined) {
                this.requestRebaseline('上一个尝试未收尾就又开新尝试');
                return false;
            }
            this.attemptId = frameAttempt;
            this.attemptNextIndex = 0;
            return true;
        }
        if (kind !== 'chunk' && kind !== 'end') {
            return true;
        }
        // 没有 start 就来的帧（订阅是后挂上的）：丢掉即可，等下一个 start —— 与上游同一处理
        if (this.attemptId === undefined || frameAttempt === undefined || frameAttempt !== this.attemptId) {
            return false;
        }
        if (index !== undefined && index !== this.attemptNextIndex) {
            this.requestRebaseline('增量块缺号');
            return false;
        }
        if (kind === 'chunk') {
            this.attemptNextIndex += 1;
            return true;
        }
        // end：尝试收尾（放弃与否由行构建按 outcome 处理）
        this.attemptId = undefined;
        this.attemptNextIndex = 0;
        return true;
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
        this.attemptId = undefined;
        this.attemptNextIndex = 0;
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
            this.assistantRevision = undefined;
            this.attemptId = undefined;
            this.attemptNextIndex = 0;
            this.rebaselining = false;
            return;
        }
        this.missingBaselineStreak = 0;
        this.rebaselining = false;
        const revision = assistantStream['revision'];
        this.assistantRevision = typeof revision === 'number' ? revision : undefined;
        const attempt = assistantStream['activeAttempt'] as Record<string, unknown> | undefined;
        if (attempt === undefined) {
            this.attemptId = undefined;
            this.attemptNextIndex = 0;
            return;
        }
        this.attemptId = typeof attempt['attemptId'] === 'string' ? (attempt['attemptId'] as string) : undefined;
        this.attemptNextIndex = typeof attempt['nextIndex'] === 'number' ? (attempt['nextIndex'] as number) : 0;
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
        // 诊断（打开历史"看不到正文"时用这一行分辨两种来路）：
        // 「快照里就没有结算消息」= 服务端没给；「快照里有、入列后变少」= 去重/入列丢的。
        const messagesInSnapshot = win.events.filter((e) => e.type === 'assistant/message').length;
        this.resetEvents();
        this.appendEvents(win.events as unknown as readonly DshStreamEvent[]);
        console.log(
            `[dsh-rows] 快照窗口已应用：记录=${String(win.events.length)} 事件=${String(this.streamEvents.length)} ` +
                `结算消息=${String(messagesInSnapshot)}→${String(this.streamEvents.filter((e) => e.type === 'assistant/message').length)}`
        );
        // 先定基再回放：基线里的 `nextIndex` 决定回放多少，同时把版本号/进行中尝试交给连续性校验
        this.adoptBaseline(win.assistantStream);
        this.appendBaseline(win.assistantStream);
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
        // **不要写成 `push(...fresh)`**：展开传参有数量上限（V8 大约十几万），而一份订阅快照
        // 展开后能到二十几万条（155 步的会话实测 228502 条）——超了直接 `RangeError: Maximum call
        // stack size exceeded`，**整个窗口替换失败**（真机现象：打开历史什么都没有）。
        for (const e of fresh) {
            this.streamEvents.push(e);
        }
        if (fresh.some((e) => e.seq !== undefined && e.seq <= tailSeq)) {
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
     * 行是**整表**下发：一次构建要遍历整个事件窗口，一次投递是整份 JSON。逐事件各做一次，
     * 在长会话上会**算不过来** —— 真机量到：8.5 万条事件的会话，单次构建 115ms、载荷 1.45MB，
     * 而流式期间每秒有几十个帧。跟不上时最后那几个事件（**含最终 `assistant/message` 的正文**）
     * 一直排在积压里，界面于是停在"链和卡片都在、正文没有"的那个中间状态。
     *
     * 故这里**合并**：一串事件只换一次重建，且下一次至少等上一个重建的耗时那么久（自适应节流）。
     * 但有两种情形必须**立刻**下发、不能等：回合结束（末尾那几个事件正是答案本身）与快照替换（打开会话）。
     */
    private emitRows(): void {
        if (this.onRows === undefined) {
            return;
        }
        if (this.rowsTimer !== undefined) {
            return;
        }
        // 上一次构建多慢，就至少等**它的两倍**那么久再建下一次：留出对半的余量，
        // 否则慢会话会把 CPU 全吃掉、页面侧的重渲也一直排不上（刷新反而更晚）。上限保证它仍在跳。
        const delay = Math.min(300, Math.max(24, this.lastBuildMs * 2));
        this.rowsTimer = setTimeout(() => {
            this.rowsTimer = undefined;
            this.flushRows();
        }, delay);
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
        const rows = buildRows(this.streamEvents);
        this.onRows(rows, this.turnActive());
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
        const assistants = buildRows(this.streamEvents).filter(
            (r): r is Extract<DshStreamRow, { kind: 'assistant' }> => r.kind === 'assistant'
        );
        return assistants.length > before ? assistants[assistants.length - 1] : undefined;
    }

    /** 当前窗口里 assistant 行的条数。 */
    private assistantRowCount(): number {
        return buildRows(this.streamEvents).filter((r) => r.kind === 'assistant').length;
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
        this.seenSeqs.clear();
        this.durableSeq = -1;
        this.transientInGap = 0;
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
    }

    /**
     * 提交失败时调用：解除「进行中」（失败的提交不会有 turn/end 来清它）。
     * 与 beginTurn 同：只改事实、不发帧；让页面复位的是随后的 `chatError`（它把乐观行标为未提交成功）。
     */
    endTurn(): void {
        this.turnRunning = false;
        this.ownPendingTurns = Math.max(0, this.ownPendingTurns - 1);
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
     * 从一段已完成回合分叉出新会话，并给子会话升号（见 `official/fork-title`）。
     * 为什么升号：上游分叉会把源会话的**标题事件一并复制**进子会话，不升号的话两者在会话列表里同名，
     * 用户根本分不出哪个是新分叉。源会话没有 durable 标题时**不改名**（上游同：没有标题就没有可升的号）。
     * @param sessionId - 源会话。
     * @param atSeq - 切点事件序号；省略 = 从最后一条已完成回合分叉。
     * @returns 子会话标识与它的标题（源会话没有 durable 标题时不改名，标题为 undefined）。
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
        let title: string | undefined;
        try {
            const source = await this.durableTitleFor(sessionId);
            if (source !== '') {
                title = increasedForkTitle(source);
                await renameSession(childId, title);
            }
        } catch {
            // 升号失败不影响分叉本身：子会话已建好，只是与源会话同名（上游同样静默）
        }
        // 分叉是"看着没有任何变化"的操作（子会话继承到切点为止的完整历史，界面内容一模一样），
        // 所以把每一步留在控制台，出问题时能一眼看出是没触发、失败、还是成功但看不出差别。
        console.warn(
            `[dsh-fork] source=${sessionId} atSeq=${String(atSeq)} child=${childId} ` +
                `title=${title ?? '(源会话无标题，未改名)'}`
        );
        return { sessionId: childId, ...(title === undefined ? {} : { title }) };
    }

    /**
     * 把分叉出来的子会话登记进**源会话所在的工作区**（源会话没归属时不动）。
     *
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

    /** 读取当前会话的上游投影（sessionStats / tokenUsage / permissions / title 等） */
    async getProjections(): Promise<Record<string, unknown>> {
        const sid = this.currentSessionId;
        if (!sid) {
            return {};
        }
        return getSessionProjections(sid);
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
     * 读上游「设置 → 对话显示」（紧凑/标准）。
     * 只读透传：读不到返回 undefined，调用方应保留上次值，别拿它当默认值（那会把读失败伪装成用户选择）。
     */
    async readTranscriptView(): Promise<DshTranscriptView | undefined> {
        return readTranscriptViewRpc();
    }

    /** 最近一次读到的对话显示形态（新面板回填用，省一次 RPC） */
    getCachedTranscriptView(): DshTranscriptView | undefined {
        return getCachedTranscriptViewRpc();
    }

    /** 订阅上游「设置 → 对话显示」变更（emit 实时跟随 + 重连后重读对齐）；返回退订函数 */
    subscribeTranscriptView(cb: (value: DshTranscriptView) => void): () => void {
        return subscribeTranscriptViewRpc(cb);
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

    /** 切换权限预设：执行 /permission 斜杠命令（走 commands/execute 斜杠端点，勿用 session.prompt 文本） */
    async setPermissionPreset(preset: string): Promise<void> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法切换权限');
        }
        const sid = await this.getSession();
        const exec = await runSessionCommand(sid, `/permission ${preset}`);
        if (!exec || exec.result?.kind === 'error') {
            throw new Error(exec?.result?.text || `未知权限预设：${preset}`);
        }
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
            onApproval?: (a: DshApproval) => void;
            onQuestion?: (q: DshQuestionRequest) => void;
            /** 提问已失效（$events 流断，pending 作废）：UI 应关掉对应弹窗，别留成死窗口 */
            onQuestionClosed?: (rpcId: string) => void;
            isCancelled?: () => boolean;
            /** 提交标识（页面 mint）：原样传给 `session/prompt` 的 requestId，回显据此认领 */
            requestId?: string;
        } = {}
    ): Promise<{ text: string; stats: DshReplyStats; time?: number; end?: { kind: string; message?: string }; counts?: DshTurnCounts }> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法对话');
        }
        const sid = await this.getSession();
        const unsubscribe = dshEvents.subscribe(sid, {
            onApproval: (request) => {
                opts.onApproval?.({
                    approvalId: request.eventId,
                    sessionId: request.agentId,
                    toolName: request.toolName,
                    description: request.reason, // reason 为真实原因；无则 UI 用 toolName 拼提示
                });
            },
            onQuestion: (request) => {
                opts.onQuestion?.({
                    rpcId: request.eventId,
                    sessionId: request.agentId,
                    questions: request.questions,
                });
            },
            // $events 流断时上游会给每个 pending 提问回调一次：此刻它已无法应答，
            // 让 UI 关掉弹窗（否则用户点取消只会得到「未找到对应的提问」）
            onCancel: (eventId) => {
                opts.onQuestionClosed?.(eventId);
            },
        });
        try {
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
                ...(row?.status === undefined
                    ? {}
                    : { end: { kind: row.status, ...(row.endMsg === undefined ? {} : { message: row.endMsg }) } }),
                ...(row === undefined ? {} : { counts: row.counts }),
            };
        } finally {
            unsubscribe();
        }
    }

    /** 回答 ask_user_question（rc.1 走 $events 流应答） */
    async answerQuestion(
        rpcId: string,
        sessionId: string,
        answers: Array<{ id: string; selected: string[]; custom?: string }>
    ): Promise<void> {
        const handled = await dshEvents.answerQuestion(rpcId, answers);
        if (!handled) {
            throw new Error('未找到对应的提问（可能已过期或已在网页端处理），请到 dsh 网页面板确认');
        }
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
