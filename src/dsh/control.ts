// 会话队列与投影的常驻订阅（**只适配 dsh 0.1.7+**；自 v0.1.15 起不再支持 0.1.5-rc.x）。
//
// 队列只活在 agent 的收件箱里、**不进日志** —— 所以历史窗口（session/follow）里查不到它。
// 它的权威来源就是这条 **host-wide** 的 `session/control` 流，0.1.7 把队列放在 `inbox` 投影里：
//
//   · 首帧 `baseline.value.projections[会话].values.inbox`，之后 `{type:'projection',key:'inbox'}`；
//     `SessionControlFrame` 只有 `baseline` 与 `projection` 两种帧。
//   · inbox 形状：`{'next-turn': 消息[], 'next-step': 消息[]}`；条目就是 UserMessage，
//     没有 placement、也没有顶层 rpcId（提交标识在 `source.rpcId`，仅 `source.kind==='user'` 才有）；
//     `placement` 由本层按下标推出来（见 inboxItems）。
//
// **本版删除了 0.1.5-rc.x 的另一种承载**（`baseline.value.queues` + `{type:'queue'}` 帧 + 条目自带
// `placement`/顶层 `rpcId`）：那些字段是上游自己删掉的旧形状，插件不再双形状嗅探，改与上游同口径
// （单代 + 明确判定）。万一连到旧主机，本层会经 `DshControlHandlers.onLegacyHost` **明确报告**
// （这行原文只进日志；给用户的通知是 `dshService.reportLegacyHost` 里写死的固定文案），
// 而不是静默给一个空队列；沿革与恢复办法见 `tmp/版本差异记录/`。
//
// 本文件是**唯一**允许出现上游形状的地方：对外统一成 `DshQueueItem`（见 queue-types.ts），
// 页面与 `queue-view.ts` 对上游换形状零感知（分层铁律）。
//
// 本文件同时负责**权限预设目录的拼接**：0.1.7 的 `permissions` 投影只剩 `{currentValue}`，
// 选项目录在进程级 remote `permissionPresets/catalog`。这里读目录、与投影的 currentValue
// 拼成插件内部既有形状 `{options, currentValue}` 再下发 —— 页面与 selector 因此一行不用改。
import { openMuxStream, readPermissionPresetCatalog } from './api';
import type { DshPermissionPresetOption } from './api';
import type { DshQueueItem } from './queue-types';
import { dshEvents } from './events';

/** 断线重连的等待时长（与其它常驻流同款）。 */
const RECONNECT_DELAY_MS = 1500;
/** 打开流自身的握手超时。 */
const STREAM_TIMEOUT_MS = 10_000;
/** 上游权限目录变更的 emit 事件名（`API_REMOTE_FORWARDED_EVENTS` 里的转发项）。 */
const PERMISSION_CATALOG_EVENT = 'permission-presets/catalog-changed';
/** 上游用来表示「当前值不在目录里」的派生取值（`permission-presets` 的 `custom`）。 */
const CUSTOM_PRESET = 'custom';

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
    /**
     * 连到了**旧代** dsh（`dsh-0.1.5-rc.x` 那一代的队列承载）时的通知 —— **只给日志**。
     *
     * 本插件自 v0.1.15 起只支持 dsh 0.1.7+，不再双形状嗅探：旧承载必须**响亮地**报出来，
     * 否则用户只会看到一个永远空着的队列卡（这一层历史上的失效方式就是静默的）。
     * 消费方负责去重（`dshService.ensureControl` 走一次性告警）：这行原文进 `console.warn`，
     * 给用户的通知是那边写死的固定文案（用户看不懂帧名与字段名，见 `reportLegacyHost`）。
     *
     * 两条纪律：
     *   · **不知道的不写** —— 判定只看"帧里带着旧承载"，**对端到底是哪个版本推不出来**
     *     （记录里那一代记作 `dsh-0.1.5-rc.x`，可能是其中任一 rc，也可能更早），所以这里只写
     *     **我们核过**的版本：`dsh-0.1.7-alpha.2` 的基线帧里已无该字段、`dsh-0.1.7-rc.1` /
     *     `dsh-0.1.7-rc.2` 复核同；
     *   · **版本标识写全**（带 `dsh` 前缀与预发布号）—— 光写 `0.1.7` 分不清 alpha / rc / 正式版，
     *     而这几次预发布之间正是承载搬家发生的区间。
     */
    onLegacyHost?: (detail: string) => void;
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

function asRecord(raw: unknown): Record<string, unknown> | undefined {
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/** 去掉本层自己消费的键（`inbox`），其余原样透传给投影消费方。 */
function withoutInbox(values: Record<string, unknown>): Record<string, unknown> {
    if (!Object.hasOwn(values, 'inbox')) {
        return values;
    }
    const { inbox: _consumed, ...rest } = values;
    return rest;
}

/** 内容块数组（形状不对即空数组：宁可少显示，也不把未知对象塞进页面）。 */
function contentOf(raw: unknown): unknown[] {
    return Array.isArray(raw) ? raw : [];
}

/** inbox 里的一条消息（只认 id；其余字段按需读）。 */
interface InboxMessage {
    id: string;
    /** 是否是注入的上下文（`source.kind !== 'user'`）。 */
    context: boolean;
    /** 提交标识（`source.rpcId`），仅人类消息才有。 */
    rpcId?: string;
    content: unknown[];
}

/** inbox 的一条 `UserMessage` → 本层条目；缺 id 即丢。 */
function parseInboxMessage(entry: unknown): InboxMessage | undefined {
    const e = asRecord(entry);
    if (e === undefined) {
        return undefined;
    }
    const id = e['id'];
    if (typeof id !== 'string') {
        return undefined;
    }
    const source = asRecord(e['source']);
    const rpcId = source?.['rpcId'];
    return {
        id,
        context: source === undefined || source['kind'] !== 'user',
        ...(typeof rpcId === 'string' ? { rpcId } : {}),
        content: contentOf(e['content']),
    };
}

/**
 * **0.1.7-alpha.2 形状**：把 inbox 投影的两条数组读成统一条目。
 *
 * `placement` 是**推**出来的，不是读出来的（上游已删该字段）：
 *   · `next-turn` → `queued`（排到下一轮，自己单独一轮）
 *   · `next-step` → `steering`（插话，投到当前回合的下一步）
 * `source.kind !== 'user'` 的条目是注入的上下文（recall / 插件注入等），标成 `context` ——
 * 页面据此不下发（见 `queue-view` 的说明）。位置仍记所属数组：上游把「下一步的插话」与
 * 「下一步的上下文」放在同一个数组里，靠 source 区分。
 */
function inboxItems(raw: unknown): DshQueueItem[] {
    const inbox = asRecord(raw);
    if (inbox === undefined) {
        return [];
    }
    const out: DshQueueItem[] = [];
    // 顺序即上游语义：先排队的，再插话的。
    for (const [key, placement] of [['next-turn', 'queued'], ['next-step', 'steering']] as const) {
        const list = inbox[key];
        if (!Array.isArray(list)) {
            continue;
        }
        for (const entry of list) {
            const item = parseInboxMessage(entry);
            if (item === undefined) {
                continue;
            }
            out.push({
                id: item.id,
                placement: item.context ? 'context' : placement,
                ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
                content: item.content,
            });
        }
    }
    return out;
}

/**
 * 把进程级目录与某个会话的 `currentValue` 拼回 **0.1.5 的旧形状** `{options, currentValue}`。
 *
 * 三件事与上游语义一致（其预设目录的 `optionsOf` 与它消费的选择结构）：
 *   1. `options` 用目录的；目录缺失（读取失败 / 老版本无此 remote）时**不下发 options 键**，
 *      让消费方保留自己已有的一份，而不是把选择器清空 —— 上游对目录失败也是「保留并重试」。
 *   2. `currentValue` 不在目录里（上游的派生 `custom`：三个旋钮的组合不匹配任何预设）时，
 *      **追加一条派生项**，否则当前值在界面上无名可显示。
 *   3. 其余情况原样透传。
 */
export function withPermissionOptions(value: unknown, catalog: readonly DshPermissionPresetOption[] | undefined): unknown {
    const selection = asRecord(value);
    if (selection === undefined || catalog === undefined) {
        return value;
    }
    const currentValue = selection['currentValue'];
    const options: DshPermissionPresetOption[] = [...catalog];
    const known = typeof currentValue === 'string' && options.some((o) => o.value === currentValue);
    if (typeof currentValue === 'string' && currentValue !== '' && currentValue !== CUSTOM_PRESET && !known) {
        options.push({ value: currentValue, name: currentValue });
    }
    if (currentValue === CUSTOM_PRESET && !known) {
        options.push({ value: CUSTOM_PRESET, name: CUSTOM_PRESET });
    }
    return { ...selection, options };
}

/**
 * 投影基线里某个会话的 `{values, asOfSeq}`。
 *
 * asOfSeq 要交给调用方当水位：基线可能比已经到账的投影帧旧，
 * 直接用会把新值冲回旧值（重连窗口里就会看到这种乱序）。
 */
function baselineValues(block: unknown): { values: Record<string, unknown>; seq: number | undefined } | undefined {
    const b = asRecord(block);
    if (b === undefined) {
        return undefined;
    }
    const values = asRecord(b['values']);
    if (values === undefined) {
        return undefined;
    }
    const asOfSeq = b['asOfSeq'];
    return { values, seq: typeof asOfSeq === 'number' ? asOfSeq : undefined };
}

/**
 * 一条 `session/control` 帧的归约：认形状、推 placement、按水位过滤，再交给消费方。
 *
 * 为什么单独成函数：**这一层的错误不会抛异常**（上游换形状时，最坏的结果是「队列卡永远空」，
 * 而不是报错），所以它必须是可直接喂帧、可直接断言的对象。参见 `scripts/verify-control-frames.mjs`。
 *
 * @param frame - 已剥壳的帧（见 frameOf）
 * @param handlers - 消费方回调
 * @param projectionSeq - 每会话投影水位（seq 大者胜），跨帧存活
 * @param permissionCatalog - 进程级权限预设目录（0.1.7 起由 `permissionPresets/catalog` 提供）；
 *   传给 `onPermissionValue`，供调用方缓存以便目录变更时重新拼接
 * @returns 无
 */
export function reduceControlFrame(
    frame: Record<string, unknown> | null | undefined,
    handlers: DshControlHandlers,
    projectionSeq: Map<string, number>,
    permissionCatalog?: readonly DshPermissionPresetOption[],
    onPermissionValue?: (sessionId: string, value: unknown) => void
): void {
    // 坏形状一律静默：网关/上游换形状时不应把插件打挂（旧实现同样在这里挡住）。
    const f = asRecord(frame);
    if (f === undefined) {
        return;
    }
    /**
     * 过一道水位：**无条件**推进水位到本次 seq，再回答「这条该不该丢」。
     *
     * 为什么要无条件推进：基线是**整批**给的（`asOfSeq` 对全部键生效），
     * 若只按「先比较、不推进」处理，同一批里排在前面的键会把水位抬到 asOfSeq，
     * 后面的键（以及同一批里的 inbox）就会被自己这批的同 seq 判为旧而丢掉 ——
     * 表现为「基线里别的投影都到了，队列却是空的」。
     */
    const staleAt = (sessionId: string, seq: number | undefined): boolean => {
        if (seq === undefined) {
            return false;
        }
        const seen = projectionSeq.get(sessionId);
        if (seen === undefined || seq > seen) {
            projectionSeq.set(sessionId, seq);
        }
        return seen !== undefined && seq < seen;
    };

    /**
     * 一条投影值：先过水位，`permissions` 再拼上进程级目录，最后交给消费方。
     *
     * 记下**原始** `currentValue`（不记拼好的）：目录变化时要靠它重新拼一次，
     * 而拼好的那份带着 options，下次拿它当输入会把旧目录钉死。
     */
    const applyProjection = (sessionId: string, key: string, value: unknown, seq: number | undefined): void => {
        if (staleAt(sessionId, seq)) {
            return;
        }
        if (key === 'permissions') {
            onPermissionValue?.(sessionId, value);
            handlers.onProjection?.(sessionId, key, withPermissionOptions(value, permissionCatalog));
            return;
        }
        handlers.onProjection?.(sessionId, key, value);
    };

    /**
     * 一条队列整表：走**同一套水位**。
     *
     * 为什么队列也要过水位：基线是整批给的，可能比已到账的 projection 帧旧 ——
     * 不过水位就会出现「刚提交的条目被旧基线抹掉」。上游客户端同口径（同 key 比 seq）。
     */
    const applyQueue = (sessionId: string, items: DshQueueItem[], seq: number | undefined): void => {
        if (staleAt(sessionId, seq)) {
            return;
        }
        handlers.onQueue(sessionId, items);
    };

    const type = f['type'];
    if (type === 'baseline') {
        const base = asRecord(f['value']);
        if (base === undefined) {
            return;
        }
        // 旧代（`dsh-0.1.5-rc.x` 那一代）的队列整表：上游已删该字段，本插件也不再读 —— 但要**报出来**
        // （静默的话用户只会看到一个永远空着的队列卡）。这行只进日志，见 `onLegacyHost` 的说明。
        if (asRecord(base['queues']) !== undefined) {
            handlers.onLegacyHost?.(
                '`session/control` 首帧带着 `value.queues`（`dsh-0.1.7-alpha.2` 的基线帧里已无此字段，`dsh-0.1.7-rc.1` / `dsh-0.1.7-rc.2` 复核同）'
            );
        }
        const blocks = asRecord(base['projections']);
        if (blocks === undefined) {
            return;
        }
        const bySession = new Map<string, Record<string, unknown>>();
        for (const [sessionId, block] of Object.entries(blocks)) {
            const parsed = baselineValues(block);
            if (parsed === undefined) {
                continue;
            }
            // 基线里的每个键都要过水位：比已应用的帧旧的键不该落地。
            for (const [key, keyValue] of Object.entries(parsed.values)) {
                if (key === 'inbox') {
                    continue; // 本层自己消费的键，走下面的队列通道，不进投影整表
                }
                applyProjection(sessionId, key, keyValue, parsed.seq);
            }
            // 0.1.7+：队列就在这条投影里（`key === 'inbox'`）。
            if (parsed.values['inbox'] !== undefined) {
                applyQueue(sessionId, inboxItems(parsed.values['inbox']), parsed.seq);
            }
            // `inbox` 是本层**自己消费**的键（已转成队列项）：不能再混进「投影整表」下发，
            // 否则上下文注入的原文会随整表到页面 —— 那正是 queue-view 刻意挡掉的。
            bySession.set(sessionId, withoutInbox(parsed.values));
        }
        handlers.onProjectionBaseline?.(bySession);
        return;
    }
    if (type === 'projection') {
        const sessionId = f['sessionId'];
        const key = f['key'];
        if (typeof sessionId !== 'string' || typeof key !== 'string') {
            return;
        }
        const seq = typeof f['seq'] === 'number' ? (f['seq'] as number) : undefined;
        // 队列在 0.1.7+ 走的就是这条投影，**不进**投影整表（见上面 withoutInbox 的理由）。
        if (key === 'inbox') {
            applyQueue(sessionId, inboxItems(f['value']), seq);
            return;
        }
        applyProjection(sessionId, key, f['value'], seq);
        return;
    }
    // 旧代（`dsh-0.1.5-rc.x` 那一代）的队列帧：上游已删该帧，本插件也不再读 —— 只报告（同上）。
    if (type === 'queue') {
        handlers.onLegacyHost?.("收到 `{type:'queue'}` 帧（`dsh-0.1.7-rc.1` / `dsh-0.1.7-rc.2` 复核里不会出现此帧：上游已删）");
    }
    // jobs 帧本插件不用：**静默忽略**，不自作主张当队列处理。
}

/**
 * 常驻订阅全部会话的队列与投影状态。
 * @param handlers - 队列整表 / 投影回调
 * @returns 取消/重开句柄
 */
export function followControl(handlers: DshControlHandlers): DshControlHandle {
    let stopped = false;
    let control: { cancel: () => void } | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /** 订阅代数：`restart()` 会立刻换一条新流，旧流的收尾不该动新流的状态（同 followSession）。 */
    let generation = 0;
    /**
     * 每个会话的投影水位（seq 大者胜）。
     *
     * 为什么必须有：首帧基线是**整批**给的，而 projection 帧与它可能交错 ——
     * 基线带的 `asOfSeq` 比已应用的帧旧时，照单全收等于把新值冲回旧值。
     * 上游客户端同口径（`ProjectionValueStore.apply`：`seq <= row.seq` 即丢）。
     */
    let projectionSeq = new Map<string, number>();
    /**
     * 进程级权限预设目录 + 各会话**原始**的 permissions 投影值。
     *
     * 目录只读一次、变更时重读（上游在贡献变化时发 emit）；原始值留着是为了目录变化时
     * 能重新拼一次并补发 —— 否则「注册了 auto 预设」要等该会话下一次投影变化才出现在界面上。
     */
    let permissionCatalog: readonly DshPermissionPresetOption[] | undefined;
    const permissionValueBySession = new Map<string, unknown>();
    let stopCatalogEvents: (() => void) | undefined;

    /** 目录变化（或首次读到）后，把每个已知会话的 permissions 重新拼一次补发下去。 */
    const republishPermissions = (): void => {
        for (const [sessionId, value] of permissionValueBySession) {
            handlers.onProjection?.(sessionId, 'permissions', withPermissionOptions(value, permissionCatalog));
        }
    };

    /** 重读进程级权限目录；失败（老版本无此 remote / 网络问题）保留上一次的目录。 */
    const refreshPermissionCatalog = (): void => {
        void readPermissionPresetCatalog()
            .then((catalog) => {
                if (stopped || catalog === undefined) {
                    return;
                }
                permissionCatalog = catalog.options;
                republishPermissions();
            })
            .catch(() => {
                // 0.1.5-rc.2 没有 permissionPresets/catalog：目录恒为 undefined，
                // 此时 withPermissionOptions 原样透传，走的是该代投影自带的 options。
            });
    };

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
        // 新的一条流 = 新的 host 生成：水位作废，首帧基线重新定基。
        projectionSeq = new Map<string, number>();
        permissionValueBySession.clear();
        // 目录随 host 生成变化，且上游会发 emit 通知失效（订阅在 start 前建好，避免漏掉订阅前的变更）。
        refreshPermissionCatalog();
        stopCatalogEvents?.();
        stopCatalogEvents = dshEvents.subscribeStream({
            onEmit: (event) => {
                if (event === PERMISSION_CATALOG_EVENT) {
                    refreshPermissionCatalog();
                }
            },
            onReady: () => {
                // 断线期间的 emit 不补发：重连后对齐一次。
                refreshPermissionCatalog();
            },
        });
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
                    reduceControlFrame(frame, handlers, projectionSeq, permissionCatalog, (sessionId, permissionValue) => {
                        permissionValueBySession.set(sessionId, permissionValue);
                    });
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
            stopCatalogEvents?.();
            stopCatalogEvents = undefined;
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
