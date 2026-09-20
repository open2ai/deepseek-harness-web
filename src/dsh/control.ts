// 会话队列的常驻订阅（适配 dsh 0.1.5-rc.2）。
//
// 队列只活在 agent 的收件箱里、**不进日志** —— 所以历史窗口（session/follow）里查不到它。
// 排队项与插话项的权威来源就是这条 **host-wide** 的流：首帧给全部会话的队列，之后按会话推整表替换帧。
// 与 followSession 的分工：那条管「会话内容（行）」，这条只管「还没被取用的输入」。
import { openMuxStream } from './api';
import type { DshQueueItem } from './queue-types';

/** 断线重连的等待时长（与其它常驻流同款）。 */
const RECONNECT_DELAY_MS = 1500;
/** 打开流自身的握手超时。 */
const STREAM_TIMEOUT_MS = 10_000;

/** 订阅回调。 */
export interface DshControlHandlers {
    /** 某会话的队列整表（整表替换语义：收到即代表该会话当前的全部队列项）。 */
    onQueue: (sessionId: string, items: DshQueueItem[]) => void;
    /**
     * 一条**投影更新**（`{type:'projection'}` 帧）。
     *
     * 消费方只关心自己那几个键（如上下文占用、会话统计、token 用量），所以这里原样透传 key/value，
     * 不做白名单 —— 哪些键有用是消费方的事。会话归属也由消费方判（帧里带 sessionId）。
     */
    onProjection?: (sessionId: string, key: string, value: unknown) => void;
    /**
     * 打开时的**整批投影基线**（首帧 `{type:'baseline', value:{projections}}`）。
     *
     * 为什么必须有它：`projection` 帧只在**变化时**推，键的当前值要靠这条基线才拿得到。
     * 少了它，「打开会话就看到统计/用量」要等下一个变化才出现（新建会话甚至永远不出现）。
     */
    onProjectionBaseline?: (bySession: ReadonlyMap<string, Record<string, unknown>>) => void;
}

/** 常驻订阅句柄。 */
export interface DshControlHandle {
    /** 停止订阅（停用扩展时调用）。 */
    cancel(): void;
    /** 立刻重开订阅（不走退避等待）：要一份新的权威整表。 */
    restart(): void;
}

/**
 * 剥掉网关给 direct 流的 `{ value }` 外壳。
 *
 * 帧自身也可能带 `value` 字段（首帧 baseline 就带）：所以**只在没有 `type` 时才剥**。
 * 无条件剥会把 baseline 的载荷当成帧，整条丢掉 —— 表现是「打开面板队列永远空」。
 */
function frameOf(item: unknown): Record<string, unknown> | undefined {
    if (item === null || typeof item !== 'object') {
        return undefined;
    }
    let v = item as Record<string, unknown>;
    if (typeof v['type'] !== 'string') {
        const inner = v['value'];
        if (inner !== null && typeof inner === 'object') {
            v = inner as Record<string, unknown>;
        }
    }
    return v;
}

/** 队列项解析：认不出形状的条目丢掉（往消费方塞未知形状，只会让它多出无从判断的分支）。 */
function toItems(raw: unknown): DshQueueItem[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: DshQueueItem[] = [];
    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') {
            continue;
        }
        const e = entry as Record<string, unknown>;
        const id = e['id'];
        const placement = e['placement'];
        if (typeof id !== 'string') {
            continue;
        }
        if (placement !== 'queued' && placement !== 'steering' && placement !== 'context') {
            continue;
        }
        const message = e['message'] as { content?: unknown } | undefined;
        out.push({
            id,
            placement,
            ...(typeof e['rpcId'] === 'string' ? { rpcId: e['rpcId'] as string } : {}),
            content: Array.isArray(message?.content) ? (message?.content as unknown[]) : [],
        });
    }
    return out;
}

/**
 * 常驻订阅全部会话的队列状态。
 * @param handlers - 队列整表回调
 * @returns 取消/重开句柄
 */
export function followControl(handlers: DshControlHandlers): DshControlHandle {
    let stopped = false;
    let control: { cancel: () => void } | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /** 订阅代数：`restart()` 会立刻换一条新流，旧流的收尾不该动新流的状态（同 followSession）。 */
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
        const isCurrent = (): boolean => !stopped && gen === generation;
        void openMuxStream(
            'session/control',
            { args: {} },
            {
                onItem: (value) => {
                    if (!isCurrent()) {
                        return;
                    }
                    const frame = frameOf(value);
                    if (frame === undefined) {
                        return;
                    }
                    const type = frame['type'];
                    if (type === 'baseline') {
                        const value = frame['value'] as { queues?: unknown; projections?: unknown } | undefined;
                        const queues = value?.queues;
                        if (queues !== null && typeof queues === 'object') {
                            for (const [sessionId, list] of Object.entries(queues as Record<string, unknown>)) {
                                handlers.onQueue(sessionId, toItems(list));
                            }
                        }
                        // 投影基线：每个会话一份 `{ asOfSeq, values }`，只取 values（本插件不按 seq 排序）
                        const blocks = value?.projections;
                        if (handlers.onProjectionBaseline !== undefined && blocks !== null && typeof blocks === 'object') {
                            const bySession = new Map<string, Record<string, unknown>>();
                            for (const [sessionId, block] of Object.entries(blocks as Record<string, unknown>)) {
                                const values = (block as { values?: unknown } | undefined)?.values;
                                if (values !== null && typeof values === 'object') {
                                    bySession.set(sessionId, values as Record<string, unknown>);
                                }
                            }
                            handlers.onProjectionBaseline(bySession);
                        }
                        return;
                    }
                    if (type === 'queue') {
                        const sessionId = frame['sessionId'];
                        if (typeof sessionId === 'string') {
                            handlers.onQueue(sessionId, toItems(frame['items']));
                        }
                        return;
                    }
                    if (type === 'projection') {
                        const sessionId = frame['sessionId'];
                        const key = frame['key'];
                        if (typeof sessionId === 'string' && typeof key === 'string') {
                            handlers.onProjection?.(sessionId, key, frame['value']);
                        }
                        return;
                    }
                    // jobs 帧本插件不用：**静默忽略**，不自作主张当队列处理。
                },
                onError: () => { if (!isCurrent()) { return; } control = undefined; retry(); },
                onEnd: () => { if (!isCurrent()) { return; } control = undefined; retry(); },
                onClose: () => { if (!isCurrent()) { return; } control = undefined; retry(); },
                onFatal: () => { if (!isCurrent()) { return; } control = undefined; retry(); },
            },
            STREAM_TIMEOUT_MS
        )
            .then((c) => {
                if (!isCurrent()) {
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
            generation += 1;
            control?.cancel();
            control = undefined;
            start();
        },
    };
}
