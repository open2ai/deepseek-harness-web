// 目标条「未运行的目标」那一档要的 activation 读数：读一次 + 接边沿（适配上游 0.2.0-rc.2）。
//
// 为什么不能从投影里算：`activation`（armed = 本进程可以自动续跑这个目标 / disarmed = 不能）
// **从不落盘**，投影里**故意没有它** —— 所以它只有两条来路，而且**两条都要**：
//   · 读一次拿初值（投影一变、或在跑状态翻转时重读）；
//   · 接边沿拿后续变化，因为"真的翻转"与"投影变化"并不同时发生。
//
// 两条路之间有竞态：晚到的读可能盖掉更新的事件。这里用**值级**护栏 —— 读回来的
// `(id, revision)` 必须与**此刻**投影里的活跃目标一致，否则这次读数作废（比按序号设护栏好读也好测）。
import { dshEvents } from './events';
import { rpcCall } from './rpc';

/** 上游 `GoalActivation`。 */
export type DshGoalActivationState = 'armed' | 'disarmed';

/**
 * 一份 activation 快照（上游 `GoalActivationSnapshot`：`{id?, revision?, activation?}`）。
 * 空对象 = **没有当前目标 / 还不知道**（两种情况在上游同形，页面按投影的 phase 区分）。
 */
export interface DshGoalActivation {
    readonly id?: string;
    readonly revision?: number;
    readonly activation?: DshGoalActivationState;
}

/** 激活边沿的事件名（emit 帧，无 agentId、无需应答）。 */
export const GOAL_ACTIVATION_EVENT = 'goal/activation-changed';

/** 从任意值里取普通对象（坏形一律 undefined）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** 取 `activation` 字段（只认上游那两个枚举值）。 */
function activationOf(value: unknown): DshGoalActivationState | undefined {
    return value === 'armed' || value === 'disarmed' ? value : undefined;
}

/**
 * 把一次 `goals/get` 的返回值收成快照。
 *
 * - `undefined` / `null`：该 remote 对"没有当前目标"返回 `undefined` → 收成 **`{}`**
 *   （空快照 = 没有当前目标，与"还没读到"同形，页面按投影的阶段再分）；
 * - 形状齐（`id` 非空串 + `revision` 有限数 + `activation` 认得出）：收成该快照；
 * - 其它（坏形 / 缺字段）：返回 **`undefined` = 读不到**，调用方**保留上次值**
 *   （与 `settings.ts` 同口径：读失败不返回默认值，免得把"读不到"伪装成"状态变了"）。
 *
 * @param value - `goals/get` 的返回值
 */
export function goalActivationOf(value: unknown): DshGoalActivation | undefined {
    if (value === undefined || value === null) {
        return {};
    }
    const rec = asRecord(value);
    if (rec === undefined) {
        return undefined;
    }
    const id = rec['id'];
    const revision = rec['revision'];
    const activation = activationOf(rec['activation']);
    if (typeof id !== 'string' || id === '' || typeof revision !== 'number' || !Number.isFinite(revision)
        || activation === undefined) {
        return undefined;
    }
    return { id, revision, activation };
}

/**
 * 把一条激活边沿的 emit `args` 收成 `{sessionId, 快照}`。
 *
 * 载荷形状 = `[{ sessionId, goal?: {id, revision, activation} }]`；
 * `goal` 缺席 = 当前没有目标 → 空快照（上游在目标被清除时就是这么发的）。
 * @param args - emit 帧的 args 数组
 */
export function goalActivationEventOf(
    args: readonly unknown[]
): { sessionId: string; activation: DshGoalActivation } | undefined {
    const payload = asRecord(args[0]);
    if (payload === undefined) {
        return undefined;
    }
    const sessionId = payload['sessionId'];
    if (typeof sessionId !== 'string' || sessionId === '') {
        return undefined;
    }
    const goal = asRecord(payload['goal']);
    if (goal === undefined) {
        return { sessionId, activation: {} };
    }
    const id = goal['id'];
    const revision = goal['revision'];
    const activation = activationOf(goal['activation']);
    if (typeof id !== 'string' || id === '' || typeof revision !== 'number' || !Number.isFinite(revision)
        || activation === undefined) {
        return undefined;
    }
    return { sessionId, activation: { id, revision, activation } };
}

/**
 * 从 goal **投影**里取当前**活跃**目标的 `{id, revision}`：只有 `phase === 'active'` 才算"有当前目标"——
 * paused / blocked / complete 都没有"续跑与否"这一档（上游的活跃引用也这么取）。
 *
 * 形状兼容两层（与 `dshService.goalRefOf` 同一口径）：`{ goal: {…} }` 与扁平 `{…}`。
 * @param raw - 投影里 `goal` 那个键的值
 */
export function activeGoalRefOf(raw: unknown): { id: string; revision: number } | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    const outer = asRecord(raw);
    if (outer === undefined) {
        return undefined;
    }
    const nested = asRecord(outer['goal']);
    const src = nested ?? outer;
    if (src['phase'] !== 'active') {
        return undefined;
    }
    const id = src['id'];
    const revision = src['revision'];
    if (typeof id !== 'string' || id === '' || typeof revision !== 'number' || !Number.isFinite(revision)) {
        return undefined;
    }
    return { id, revision };
}

/** 两份快照是否同值（少推一帧用；`{}` 与 `{id,revision,activation}` 不同值）。 */
export function sameGoalActivation(left: DshGoalActivation | undefined, right: DshGoalActivation): boolean {
    return left !== undefined
        && left.id === right.id
        && left.revision === right.revision
        && left.activation === right.activation;
}

/** 读一次该会话的 activation。读失败 / 形状不认 → `undefined`（调用方保留上次值）。 */
export async function readGoalActivation(sessionId: string): Promise<DshGoalActivation | undefined> {
    try {
        return goalActivationOf(await rpcCall('goals/get', { agentId: sessionId }));
    } catch {
        // 服务未就绪 / 会话不在 / 这一版没有 goals/get：都当作"这次读不到"
        return undefined;
    }
}

/** 激活边沿的订阅者。 */
export interface GoalActivationHandlers {
    /** 一条激活边沿（emit 帧）。 */
    onActivation?: (sessionId: string, activation: DshGoalActivation) => void;
    /** `$events` （重）连成功：断线期间错过的边沿不会补发，订阅方应重读一次对齐。 */
    onReady?: () => void;
}

const handlers = new Set<GoalActivationHandlers>();
let unsubscribeStream: (() => void) | undefined;

/** emit 分发：只认激活事件，且形状不符时**直接丢**（这条边沿没有可"保守重读"的兜底语义）。 */
function onEmit(event: string, args: readonly unknown[]): void {
    if (event !== GOAL_ACTIVATION_EVENT) {
        return;
    }
    const parsed = goalActivationEventOf(args);
    if (parsed === undefined) {
        return;
    }
    for (const handler of handlers) {
        handler.onActivation?.(parsed.sessionId, parsed.activation);
    }
}

/**
 * 订阅目标激活边沿（首个订阅者建立 `$events` 流，无人订阅时释放）。
 * @param handler - 边沿 / 重连回调
 * @returns 退订函数
 */
export function subscribeGoalActivation(handler: GoalActivationHandlers): () => void {
    handlers.add(handler);
    if (unsubscribeStream === undefined) {
        unsubscribeStream = dshEvents.subscribeStream({
            onEmit,
            onReady: () => {
                for (const h of handlers) {
                    h.onReady?.();
                }
            },
        });
    }
    return () => {
        handlers.delete(handler);
        if (handlers.size === 0 && unsubscribeStream !== undefined) {
            unsubscribeStream();
            unsubscribeStream = undefined;
        }
    };
}
