// dsh 0.1.7+ 的 Remote Event（$events）监听器（自 v0.1.15 起只支持 0.1.7+）。
//
// rc.1 移除旧 /api/respond 后，审批与提问改为：
//   - 通过 /api/remote.mux 打开逻辑流 `$events`（payload { args: {} }）；
//   - 服务端下发 ready（clientId）与 waterfall（event/eventId/agentId/request）帧；
//   - 应答方通过 unary `$events/result` 回传 outcome。
// 本模块负责维护一条可重连的 $events 流，并按会话把请求投递给聊天层。
// 另有 emit 帧（上游广播，无 agentId、无需应答）走 subscribeStream，给非会话作用域的订阅者
// （如设置文档变更）——两条通道各自分发，互不影响。
import { openMuxStream, sendRemoteEventResult } from './api';
import { jsonPreview } from './trace';

export interface DshRemoteApprovalRequest {
    readonly clientId: string;
    readonly eventId: string;
    readonly agentId: string;
    /** 上游 request.toolName；缺失时为 undefined，不自行造默认工具名 */
    readonly toolName?: string;
    readonly callId?: string;
    readonly reason?: string;
    /**
     * 上游 `request.displayReason`（**dsh 0.1.7-rc.2 新增**）：**给人看的本地化文案**
     * （形状 `{ en, zh, … }`），与 `reason`（审计原文、会写进会话日志）**并行存在、互不覆盖**。
     * 产地：沙箱提权 `sandbox/src/escalation.ts`（`允许本次操作使用 … 权限：…`）、
     * Auto review 拒绝转人工、`PreToolDecision.ask`。
     * 本层只**原样搬运**：决议用哪门语言是展示层的事 —— 宿主代选会让 `description`
     * 出现第二套语义（既可能是 reason 也可能是 displayReason），复查时无法区分。
     */
    readonly displayReason?: Readonly<Record<string, string>>;
}

export interface DshRemoteQuestionRequest {
    readonly clientId: string;
    readonly eventId: string;
    readonly agentId: string;
    readonly questions: Array<{
        id: string;
        question: string;
        header?: string;
        detail?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
    }>;
    /**
     * 限时提问（dsh 0.2.0）的等待标识：**只有**限时形态的请求带它。
     *
     * 它与投影 `userQuestions` 里的 `callId` 是同一个键 —— 界面据此把「这条提问」与
     * 「它超时后转入的『已继续』态」对上（超时后弹窗必须关掉，改由提问卡提供补答入口）。
     */
    readonly callId?: string;
}

/** 某个会话等待期间感兴趣的 $events 回调。 */
export interface DshSessionEventHandlers {
    onApproval?: (request: DshRemoteApprovalRequest) => void;
    onQuestion?: (request: DshRemoteQuestionRequest) => void;
    onCancel?: (eventId: string) => void;
}

/**
 * 取上游的本地化文案字段（`displayReason`，形状 `{ en, zh, … }`）。
 *
 * 只认「值是字符串的普通对象」：畸形载荷（`null` / 数组 / 数字 / 嵌套对象）一律当没有 ——
 * 上游把该字段定义为**仅用于展示、不进审计**，所以宁可退回英文审计原文，
 * 也不把任意 payload 灌进 UI。一个可用字符串都没有时同样返回 `undefined`（等同上游没给）。
 */
function localeText(value: unknown): Readonly<Record<string, string>> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const out: Record<string, string> = {};
    for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
        if (typeof text === 'string') {
            out[key] = text;
        }
    }
    return Object.keys(out).length === 0 ? undefined : out;
}

/** 非会话作用域（emit 帧）的 $events 回调。 */
export interface DshStreamEventHandlers {
    /** 上游广播的一条 emit：事件名与 args 原样透传（形状由订阅方自行解析） */
    onEmit?: (event: string, args: readonly unknown[]) => void;
    /** 流（重）连成功。断线期间错过的 emit 不会补发，订阅方应借此重读一次对齐 */
    onReady?: () => void;
}

interface RemoteInvocation {
    readonly clientId: string;
    readonly eventId: string;
    readonly agentId: string;
    readonly event: string;
}

const RECONNECT_DELAY_MS = 1500;
const STREAM_TIMEOUT_MS = 10_000;

/**
 * $events 流单例：整条流由本模块持有，外部按 sessionId 订阅感兴趣的事件。
 * 断线后自动重连；重连不会影响仍由上游页面/其它客户端持有的事件。
 */
class RemoteEventHub {
    private started = false;
    private stopping = false;
    private generation = 0;
    private clientId: string | undefined;
    private readonly handlers = new Map<string, Set<DshSessionEventHandlers>>();
    private readonly streamHandlers = new Set<DshStreamEventHandlers>();
    private readonly pending = new Map<string, RemoteInvocation>();

    /** 订阅某个 agent/session 在等待期间的审批/提问事件。 */
    subscribe(sessionId: string, handlers: DshSessionEventHandlers): () => void {
        void this.ensureStarted();
        let set = this.handlers.get(sessionId);
        if (set === undefined) {
            set = new Set();
            this.handlers.set(sessionId, set);
        }
        set.add(handlers);
        return () => {
            const current = this.handlers.get(sessionId);
            if (current === undefined) {
                return;
            }
            current.delete(handlers);
            if (current.size === 0) {
                this.handlers.delete(sessionId);
            }
        };
    }

    /** 订阅非会话作用域的 emit 事件（订阅即确保流已拉起）。 */
    subscribeStream(handlers: DshStreamEventHandlers): () => void {
        void this.ensureStarted();
        this.streamHandlers.add(handlers);
        return () => {
            this.streamHandlers.delete(handlers);
        };
    }

    /** 应答审批：返回是否命中本地正在等待的 $events 事件。 */
    async approve(eventId: string, outcome: 'allowed-once' | 'rejected'): Promise<boolean> {
        const pending = this.pending.get(eventId);
        if (pending === undefined) {
            return false;
        }
        await sendRemoteEventResult(pending.clientId, eventId, {
            kind: 'result',
            value: outcome,
        });
        this.pending.delete(eventId);
        return true;
    }

    /** 应答提问：value 结构与 AskUserQuestionAnswer 一致。 */
    async answerQuestion(
        eventId: string,
        answers: Array<{ id: string; selected: string[]; custom?: string }>
    ): Promise<boolean> {
        const pending = this.pending.get(eventId);
        if (pending === undefined) {
            return false;
        }
        await sendRemoteEventResult(pending.clientId, eventId, {
            kind: 'result',
            value: { answers },
        });
        this.pending.delete(eventId);
        return true;
    }

    /** 取消提问：与上游页面一致，以 UserQuestionError/ASK_CANCELLED 拒绝该 waterfall。 */
    async cancelQuestion(eventId: string): Promise<boolean> {
        const pending = this.pending.get(eventId);
        if (pending === undefined) {
            return false;
        }
        await sendRemoteEventResult(pending.clientId, eventId, {
            kind: 'rejected',
            error: {
                name: 'UserQuestionError',
                message: 'the user cancelled ask_user_question',
                code: 'ASK_CANCELLED',
            },
        });
        this.pending.delete(eventId);
        return true;
    }

    /** 停用（服务退出/扩展停用）。 */
    stop(): void {
        this.stopping = true;
        this.started = false;
        this.generation += 1;
        this.pending.clear();
        this.handlers.clear();
        this.streamHandlers.clear();
        this.control?.cancel();
        this.control = undefined;
    }

    /**
     * 让当前这条流收尾，随后由重连循环立刻重开 —— 用来在**端点变化**后重新指向。
     * 不在这里直接重开：新端点是 `openOnce` 每次现读的，交给循环走同一套收尾/重连逻辑（只写一份）。
     */
    restart(): void {
        if (this.stopping || !this.started) {
            return;
        }
        this.generation += 1;
        this.control?.cancel();
        this.control = undefined;
    }

    private async ensureStarted(): Promise<void> {
        if (this.started || this.stopping) {
            return;
        }
        this.started = true;
        this.stopping = false;
        void this.run();
    }

    private async run(): Promise<void> {
        while (!this.stopping) {
            const generation = ++this.generation;
            try {
                await this.openOnce(generation);
            } catch (e) {
                if (!this.stopping) {
                    console.warn(`[dsh-events] $events 监听失败：${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (this.stopping) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
        }
    }

    /** 打开一次 $events 流并等到它关闭。 */
    private openOnce(generation: number): Promise<void> {
        return new Promise<void>((resolve) => {
            let settled = false;
            const done = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                // 收尾**不按代数设门**：run() 是串行的，一次只有一条流在跑，
                // 这条必然是"当前那条"。按代数设门会让 restart()（换端点）时的
                // 「清 clientId / 通知 pending 提问作废 / 清表」被跳过，留下过期条目。
                this.clientId = undefined;
                // 流断了 = 这些提问此刻已无法应答（拒绝也送不到服务端）。先通知各 handler
                // 关掉弹窗再清表：否则弹窗会留成一个「点了没反应」的死窗口——用户点取消
                // 只会得到「未找到对应的提问」并把整轮对话停掉。
                // 重连后上游会重放仍挂起的提问，那时会重新弹出，用户照样能答。
                for (const eventId of this.pending.keys()) {
                    for (const set of this.handlers.values()) {
                        for (const handler of set) {
                            handler.onCancel?.(eventId);
                        }
                    }
                }
                this.pending.clear();
                resolve();
            };
            void openMuxStream(
                '$events',
                { args: {} },
                {
                    onItem: (value) => {
                        if (generation === this.generation && !this.stopping) {
                            this.onFrame(value);
                        }
                    },
                    onError: () => done(),
                    onEnd: () => done(),
                    onClose: () => done(),
                    onFatal: () => done(),
                },
                STREAM_TIMEOUT_MS
            )
                .then((control) => {
                    if (generation !== this.generation || this.stopping) {
                        control.cancel();
                        done();
                        return;
                    }
                    this.control = control;
                })
                .catch(() => done());
        });
    }

    private control: { cancel: () => void } | undefined;

    private onFrame(value: unknown): void {
        // 实验抓帧（$events）：env DSH_RAWLOG=1/full
        const logMode = process.env['DSH_RAWLOG'];
        if (logMode) {
            const f = value as { type?: string; event?: string; eventId?: string; agentId?: string } | undefined;
            if (logMode === 'full') {
                console.log(`[dsh-raw] events ` + jsonPreview(value, 200_000));
            } else {
                console.log(
                    `[dsh-raw] events ${String(f?.type ?? 'frame')}${f?.event ? ' event=' + f.event : ''}${f?.eventId ? ' eventId=' + f.eventId : ''}${f?.agentId ? ' agentId=' + f.agentId : ''}`
                );
            }
        }
        const frame = value as
            | { type?: string; clientId?: string; eventId?: string; event?: string; agentId?: string; request?: Record<string, unknown>; args?: unknown }
            | undefined;
        if (!frame || typeof frame !== 'object') {
            return;
        }
        if (frame.type === 'ready' && typeof frame.clientId === 'string') {
            this.clientId = frame.clientId;
            // 重连后对齐：断线期间的 emit 不会补发，交给订阅方自己重读一次
            for (const handler of this.streamHandlers) {
                handler.onReady?.();
            }
            return;
        }
        if (frame.type === 'cancel' && typeof frame.eventId === 'string') {
            this.pending.delete(frame.eventId);
            for (const set of this.handlers.values()) {
                for (const handler of set) {
                    handler.onCancel?.(frame.eventId);
                }
            }
            return;
        }
        // emit 帧：上游广播，无 agentId、无需应答（与 waterfall 的审批/提问是两条独立通道）
        if (frame.type === 'emit' && typeof frame.event === 'string') {
            const args = Array.isArray(frame.args) ? frame.args : [];
            for (const handler of this.streamHandlers) {
                handler.onEmit?.(frame.event, args);
            }
            return;
        }
        if (frame.type !== 'waterfall' || typeof frame.eventId !== 'string' || typeof frame.agentId !== 'string') {
            return;
        }
        const invocation: RemoteInvocation = {
            clientId: this.clientId ?? '',
            eventId: frame.eventId,
            agentId: frame.agentId,
            event: frame.event ?? '',
        };
        const set = this.handlers.get(frame.agentId);
        // 诊断（DSH_RAWLOG）：这一层最容易**静默失效** —— 没有 handler 的 waterfall 帧被直接丢弃，
        // 上游那个工具调用就一直等审批，界面什么都不显示（表现为「卡住不动，不自己判断」）。
        // 实证（扫 ~/.dsh/sessions 下全部会话日志）：存在**未配对**的 approval/asked —— 请求已入日志、
        // 却没有任何 approval/decided，会话就停在 approval/asked 上。同型样本含
        // 「read-only 下 write 被拒 → 请求提权到 workspace-write → 无人应答」。
        // 归属：**插件自身的 bug，与 dsh 0.1.x 的版本无关** —— 同型日志早于后来那次升级（最早 2026-08-31），
        // 因为病灶在页面侧的行合并（见 webview/chat/core/store/messages.ts 的 applyHostRows）。
        // 注：不要在这里写死命中条数（每复现一次就变），需要时重跑扫描脚本。
        if (process.env['DSH_RAWLOG'] !== undefined) {
            console.warn(
                `[dsh-ask] waterfall event=${frame.event} agentId=${String(frame.agentId).slice(0, 12)}… ` +
                    `handlers=${set?.size ?? 0} subscribedKeys=[${[...this.handlers.keys()].map((k) => String(k).slice(0, 12)).join(',')}] ` +
                    `requestKeys=${Object.keys(frame.request ?? {}).join(',')}`
            );
        }
        // 键对不上时的兜底：**只在恰好一个会话在订阅时**把帧交给它。
        // 为什么安全：这张表只会由 `subscribe(sessionId, …)` 写入，而插件同一时刻只订阅当前会话；
        // 只有一个订阅者时，不存在「投错会话」的可能。这样 agentId 与会话 id 不一致
        // （子代理会话、或上游换了 agent 身份）就不再静默丢弃 —— 丢掉就等于让 agent 一直等。
        // 多个订阅者时不猜：那才是真的分不清归属，宁可不动（并已被上面的诊断记录）。
        let target = set;
        if ((target === undefined || target.size === 0) && this.handlers.size === 1) {
            const only = [...this.handlers.values()][0];
            if (only !== undefined && only.size > 0) {
                target = only;
                if (process.env['DSH_RAWLOG'] !== undefined) {
                    console.warn(
                        `[dsh-ask] agentId=${String(frame.agentId).slice(0, 12)}… 与订阅键不符，` +
                            `唯一订阅者兜底投递 event=${frame.event}`
                    );
                }
            }
        }
        if (target === undefined || target.size === 0) {
            return;
        }
        this.pending.set(frame.eventId, invocation);
        const request = frame.request ?? {};
        if (frame.event === 'approval/request') {
            const toolName = typeof request['toolName'] === 'string' ? request['toolName'] : undefined;
            const callId = typeof request['callId'] === 'string' ? request['callId'] : undefined;
            const reason = typeof request['reason'] === 'string' ? request['reason'] : undefined;
            // dsh 0.1.7-rc.2 起上游并列给出本地化展示文案；本层只校验形状 + 原样搬运。
            const displayReason = localeText(request['displayReason']);
            for (const handler of target) {
                handler.onApproval?.({
                    clientId: invocation.clientId,
                    eventId: frame.eventId,
                    agentId: frame.agentId,
                    toolName,
                    ...(callId === undefined ? {} : { callId }),
                    ...(reason === undefined ? {} : { reason }),
                    ...(displayReason === undefined ? {} : { displayReason }),
                });
            }
            return;
        }
        if (frame.event === 'user-questions/request') {
            const rawQuestions = Array.isArray(request['questions']) ? request['questions'] : [];
            // 限时形态的请求多一个 `wait`（只读它需要的字段；没有就是阻塞式提问）
            const wait = request['wait'] !== null && typeof request['wait'] === 'object'
                ? (request['wait'] as Record<string, unknown>)
                : undefined;
            const callId = typeof wait?.['callId'] === 'string' && wait['callId'] !== '' ? wait['callId'] : undefined;
            for (const handler of target) {
                handler.onQuestion?.({
                    clientId: invocation.clientId,
                    eventId: frame.eventId,
                    agentId: frame.agentId,
                    questions: rawQuestions as DshRemoteQuestionRequest['questions'],
                    ...(callId === undefined ? {} : { callId }),
                });
            }
        }
    }
}

/** 全局唯一的 $events 流维护者。 */
export const dshEvents = new RemoteEventHub();
