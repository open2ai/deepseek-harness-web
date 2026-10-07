// **提交台账**（宿主侧）：本面板每次提交的一条"本地回显"，与上游 `SessionSnapshot.pendingSubmissions` 同构。
//
// 为什么必须有它（真机 2026-10-06）：页面自己记着"我提交了、等权威帧按 `rpcId` 认领"，
// 而**页面判忙/闲与宿主判忙/闲不是同一份事实** —— 页面以为空闲、宿主那边这一轮还在跑，于是这次提交
// 变成"忙时提交"进了收件箱；收件箱项若被丢掉，`user/message` 永远不会来，页面那条本地行**永远认领不到**，
// 「处理中」于是被一条没人回收的腿撑住：一直「深度求索中」、停止按钮点了也没反应（`session.cancel`
// 对"本来就没有在跑的回合"是空操作）。上游不会这样 —— 它的回显挂在**会话对象**上，由**会话**在提交
// 那一刻推导 placement，并由会话的四个时刻退休（见下）。
//
// 上游那套规则（`api/session-controller` 的 README §"本地提交回显" 与 `sessions/session.ts`）：
//   · `beginSubmission` 在提示词发出**之前**同步登记一条回显，带**投递位置**：
//     空闲 → `transcript`；忙时排队 → `queued`；忙时插话 → `steering`（由模式 + 当时是否在跑推导）；
//   · 关联标识 = 提示词的 `requestId`：Host 把它回显成 durable `user/message.source.rpcId`，
//     inbox 投影里的待处理消息也保留同一个 `source`；
//   · **入档（被日志观察到）→ 退休**；**排队回显在队列接受后退休**（由队列卡/收件箱接管）；
//     **带标识的失败或被放弃 → 立即退休**（未结算的按 failed 退休）。
//
// 本文件就是这套规则的宿主实现：唯一的**权威**台账，页面只消费它的快照与退休事件 ——
// 页面不再自己推断"这条还会不会来"。
import type { DshQueueItem } from './queue-types';

/** 一次提交的投递位置（与上游同字面量）。 */
export type DshSubmitPlacement = 'transcript' | 'queued' | 'steering';

/**
 * 提交的最终去向（上游把"未结算"的一律按 failed 退休，这里把几路分开以便页面区分呈现）：
 *   · `admitted` —— 已被日志观察到（durable `user/message` 回显了同一个 `rpcId`）：回显退休，行以宿主那条为准；
 *   · `queued` —— 队列接下了它（收件箱投影里有它）：回显退休，交给队列卡/收件箱表示；
 *   · `failed` —— 带标识的失败 / 被放弃 / 收件箱项消失：回显退休并标「未提交成功」。
 */
export type DshSubmitOutcome = 'admitted' | 'queued' | 'failed';

/** 台账里一条待结算的提交（下发给页面的形状）。 */
export interface DshPendingSubmission {
    rpcId: string;
    placement: DshSubmitPlacement;
    /** 正文（没带 `rpcId` 的旧回显只能靠它兜底认领，与上游"标识为准 + 文案兜底"的次序一致）。 */
    text: string;
}

/** 已退休的一条（下发给页面：页面据此收掉本地行）。 */
export interface DshRetiredSubmission {
    rpcId: string;
    outcome: DshSubmitOutcome;
}

/** 台账快照（随帧下发）。 */
export interface DshSubmitSnapshot {
    pending: DshPendingSubmission[];
    /** **自上一帧以来**退休的那些：页面只消费一次，故用增量（新页面没有本地行，不需要历史）。 */
    retired: DshRetiredSubmission[];
}

/**
 * 由「当前是否在跑」与「页面选的投递模式」推导投递位置 —— 与上游 `beginSubmission` 同一推导。
 *
 * 注意**判据是宿主自己的在跑事实**（`isTurnActive()`），不是页面的 `processing`：页面那份是推导值，
 * 竞态下会与宿主不一致（正是本次事故的来路）。
 */
export function placementOf(turnActive: boolean, mode: 'queue' | 'steer'): DshSubmitPlacement {
    if (!turnActive) {
        return 'transcript';
    }
    return mode === 'steer' ? 'steering' : 'queued';
}

/** 台账（每个会话一份；换会话时把旧会话未结算的按 failed 退休，与上游 disposal 同口径）。 */
export interface SubmitLedger {
    /** 换会话：旧会话未结算的全部按 failed 退休，再切到新会话。 */
    useSession(sessionId: string | undefined): void;
    /** 提交那一刻登记（必须在提示词发出**之前**）。 */
    begin(rpcId: string, placement: DshSubmitPlacement, text: string): void;
    /** 日志里观察到这些 `rpcId`（durable 回显）→ 退休为 `admitted`。 */
    admitById(rpcIds: Iterable<string>): void;
    /**
     * 日志里出现了一条**没有** `rpcId` 的用户消息（旧形状）→ 按文案兜底认领一条同文案的 `transcript`。
     * 与页面原先那条同文案兜底同义，只是判据从"页面猜"搬到了权威侧。
     */
    admitByText(texts: Iterable<string>): void;
    /** 收件箱投影：`queued` 的条目被队列接下 → 退休为 `queued`；曾经在、现在不见了 → 退休为 `failed`。 */
    observeInbox(items: readonly DshQueueItem[]): void;
    /** 带标识的失败 / 被放弃（停止、提交抛错）→ 立即退休为 `failed`。 */
    fail(rpcId: string | undefined, filter?: 'transcript' | 'all'): void;
    /** 自上一帧以来的增量快照。 */
    takeSnapshot(): DshSubmitSnapshot;
    /** 当前待结算的条数（宿主诊断用）。 */
    pendingCount(): number;
}

/** 已退休记录的保留上限（下发给页面的增量只留最近这些，避免无界增长）。 */
const RETIRED_KEEP = 64;

export function createSubmitLedger(): SubmitLedger {
    let sessionId: string | undefined;
    /** 待结算：`rpcId` → 提交事实（保持提交次序）。 */
    const pending = new Map<string, DshPendingSubmission>();
    /** 曾经在收件箱里见过的 `rpcId`（用来判"被丢掉了"）。 */
    const seenInInbox = new Set<string>();
    /** 上一次取快照之后退休的（增量）。 */
    let retiredSince: DshRetiredSubmission[] = [];
    /** 更早的退休记录（上限内保留，供 takeSnapshot 的增量滚动）：只保最近 RETIRED_KEEP 条。 */
    let retiredHistory: DshRetiredSubmission[] = [];

    const retire = (rpcId: string, outcome: DshSubmitOutcome): void => {
        if (!pending.delete(rpcId)) {
            // 已经退休过 / 不是本面板提交的：不重复下发（幂等）
            return;
        }
        seenInInbox.delete(rpcId);
        const entry = { rpcId, outcome };
        retiredSince.push(entry);
        retiredHistory.push(entry);
        if (retiredHistory.length > RETIRED_KEEP) {
            retiredHistory = retiredHistory.slice(-RETIRED_KEEP);
        }
    };

    return {
        useSession(next: string | undefined): void {
            if (sessionId === next) {
                return;
            }
            sessionId = next;
            // 换会话：旧会话未结算的回显按 failed 退休（上游 disposal 同口径 —— 回显只活在内存里）
            for (const rpcId of [...pending.keys()]) {
                retire(rpcId, 'failed');
            }
            seenInInbox.clear();
        },
        begin(rpcId: string, placement: DshSubmitPlacement, text: string): void {
            pending.set(rpcId, { rpcId, placement, text });
            seenInInbox.delete(rpcId);
        },
        admitById(rpcIds: Iterable<string>): void {
            for (const rpcId of rpcIds) {
                retire(rpcId, 'admitted');
            }
        },
        admitByText(texts: Iterable<string>): void {
            const wanted = new Set(texts);
            for (const entry of [...pending.values()]) {
                if (wanted.has(entry.text)) {
                    retire(entry.rpcId, 'admitted');
                }
            }
        },
        observeInbox(items: readonly DshQueueItem[]): void {
            const live = new Set<string>();
            for (const item of items) {
                if (item.rpcId === undefined || item.placement === 'context') {
                    continue;
                }
                live.add(item.rpcId);
                // 队列接下了它：**排队**的回显退休（交给队列卡）；插话的回显留到入档（上游同）
                if (item.placement === 'queued') {
                    retire(item.rpcId, 'queued');
                    continue;
                }
                seenInInbox.add(item.rpcId);
            }
            // 曾经在收件箱里、现在不见了、又没入档 → 这次提交不会再有回显了（真机那个"被丢掉"的形状）
            for (const rpcId of [...seenInInbox]) {
                if (!live.has(rpcId)) {
                    retire(rpcId, 'failed');
                }
            }
        },
        fail(rpcId: string | undefined, filter: 'transcript' | 'all' = 'all'): void {
            for (const entry of [...pending.values()]) {
                if (rpcId !== undefined && entry.rpcId !== rpcId) {
                    continue;
                }
                if (filter === 'transcript' && entry.placement !== 'transcript') {
                    continue;
                }
                retire(entry.rpcId, 'failed');
            }
        },
        takeSnapshot(): DshSubmitSnapshot {
            const snapshot: DshSubmitSnapshot = {
                pending: [...pending.values()],
                retired: retiredSince,
            };
            retiredSince = [];
            return snapshot;
        },
        pendingCount(): number {
            return pending.size;
        },
    };
}
