// 会话的常驻订阅（适配上游 0.1.7-rc.2）：会话打开即订阅，与页面同生命周期。
//
// 与「一轮一条」的 waitTurn（stream.ts）的区别：它**不随本轮 turn/end 关闭** ——
//   停止之后服务端补发的补记事件（如工具的取消结果）、以及别处（浏览器 / 另一面板）
//   驱动同一会话的事件，都靠它收到。见 docs/design/08 §8「事件层专项分析」。
import { openMuxStream } from './api';
import { snapshotRecordsToEvents, toRawEvent, type RawEvent } from './session';

/** 断线重连的等待时长（与 $events 流同款）。 */
const RECONNECT_DELAY_MS = 1500;
/** 打开流自身的握手超时。 */
const STREAM_TIMEOUT_MS = 10_000;

/**
 * 打开（含重连）时的快照页。
 *
 * **它是事件窗口的替换源，不是窗口里的一条记录** —— 消费方收到后应当**整窗替换**。
 * 当成普通事件追加会积压（每重连一份完整 records），而且拿不到进行中尝试的基线。
 */
export interface DshFollowWindow {
    /** 窗口记录：持久事件（内嵌增量已展开成 `assistant/chunk`、按 `seq` 排序）。 */
    events: RawEvent[];
    /**
     * 更早的历史还没进这份窗口（上游快照的 `hasMore`）。
     *
     * 缺省 = `false`：快照**完整**。上游 `SessionFollowRequest` 支持 `maxMessages` 限额，
     * 限额到顶时服务端给 `hasMore: true` —— 列表顶端的「加载更早」按钮就是它的消费方。
     */
    hasMore?: boolean;
    /** 进行中尝试的紧凑基线：`stream` 是本次订阅之前已流出的增量。缺省 = 打开时没有在跑的尝试。 */
    assistantStream?: Record<string, unknown>;
}

/** 订阅回调。**分帧种类在传输层完成**（与上游 transport 同层），消费方不必再按形状猜。 */
export interface DshFollowHandlers {
    /** 一条事件原文（持久事件 / 实时增量帧；`{ value }` 与 `{ type:'event', event }` 两层包装已剥净）。 */
    onEvent: (event: unknown) => void;
    /** 快照页：消费方据此**替换**事件窗口。 */
    onSnapshot: (window: DshFollowWindow) => void;
}

/** 常驻订阅句柄。 */
export interface DshFollowHandle {
    /** 停止订阅（切换会话 / 停用扩展时调用）。 */
    cancel(): void;
    /**
     * 立刻重开订阅（不走退避等待）：用来要一份**新的「窗口 + 增量基线」原子对**。
     * 消费方发现实时增量不连续时调它定基 —— 上游同一动作（客户端折叠判出 rebaseline 后重开监听）。
     */
    restart(): void;
}

/**
 * 常驻订阅一个会话的事件。
 * @param sessionId - 目标会话
 * @param handlers - 事件与快照页的回调
 * @returns 取消/重开句柄
 */
export function followSession(sessionId: string, handlers: DshFollowHandlers): DshFollowHandle {
    let stopped = false;
    let control: { cancel: () => void } | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * 订阅代数：`restart()` 会立刻换一条新流，而旧流可能还会回调（关闭/出错）。
     * 每次 `start()` 取号，回调先比号 —— 旧流的收尾不会去动新流的状态、也不会安排一次多余的重连。
     */
    let generation = 0;

    const retry = (): void => {
        if (stopped) {
            return;
        }
        retryTimer = setTimeout(start, RECONNECT_DELAY_MS);
    };

    const start = (): void => {
        if (stopped) {
            return;
        }
        const gen = ++generation;
        // 每条流的收尾都只在自己仍是当前代数时才生效
        const isCurrent = (): boolean => !stopped && gen === generation;
        void openMuxStream(
            'session/follow',
            { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 5000, assistantStream: true } } },
            {
                onItem: (value) => {
                    if (!isCurrent()) {
                        return;
                    }
                    const v = (value as { value?: unknown } | undefined)?.value ?? value;
                    const frame = v as Record<string, unknown> | undefined;
                    if (frame?.['type'] === 'snapshot') {
                        handlers.onSnapshot({
                            events: snapshotRecordsToEvents(
                                Array.isArray(frame['records']) ? frame['records'] : []
                            ),
                            // 快照分页事实：限额到顶时服务端说还有更早的（「加载更早」的门）
                            hasMore: frame['hasMore'] === true,
                            ...(frame['assistantStream'] === undefined
                                ? {}
                                : { assistantStream: frame['assistantStream'] as Record<string, unknown> }),
                        });
                        return;
                    }
                    // 实时增量帧：顶层即帧，且**没有持久序号** —— 不能走 toRawEvent
                    // （那条路要求 seq，会把本帧判为无效整条丢掉）。
                    if (frame?.['type'] === 'assistant-stream') {
                        handlers.onEvent(frame);
                        return;
                    }
                    // 其余按持久事件解析（含 `{ type:'event', event }` 外壳）。
                    // **认不出的帧丢弃**：往消费方塞未知形状，只会让下游多出无从判断的分支。
                    const ev = toRawEvent(v);
                    if (ev !== undefined) {
                        handlers.onEvent(ev);
                    }
                },
                // 收尾一律先比代数：旧流的关闭/出错不该动新流、也不该再排一次重连
                onError: () => { if (!isCurrent()) { return; } control = undefined; retry(); },
                onEnd: () => { if (!isCurrent()) { return; } control = undefined; retry(); },
                onClose: () => { if (!isCurrent()) { return; } control = undefined; retry(); },
                onFatal: () => { if (!isCurrent()) { return; } control = undefined; retry(); },
            },
            STREAM_TIMEOUT_MS
        )
            .then((c) => {
                if (!isCurrent()) {
                    // 已被 restart/cancel 取代：这条多余的流直接关掉
                    c.cancel();
                    return;
                }
                control = c;
            })
            .catch(() => {
                if (!isCurrent()) {
                    return;
                }
                control = undefined;
                retry();
            });
    };

    start();
    return {
        cancel: () => {
            stopped = true;
            generation += 1; // 让在途流的回调全部失效
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = undefined;
            }
            control?.cancel();
            control = undefined;
        },
        restart: () => {
            if (stopped) {
                return;
            }
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = undefined;
            }
            // 先作废在途流（它的回调会因代数不符被忽略），再立刻起一条新的
            generation += 1;
            control?.cancel();
            control = undefined;
            start();
        },
    };
}
