// next-step 收件箱的 splice 折叠（适配上游 0.1.7-rc.2）：判定一条人类消息是**插话**还是普通提问。
//
// 为什么只能从事件史判：一条 `user/message` 的 source 只说「谁发的」，区分不出它走的是
// next-turn（排队，自己单独一轮）还是 next-step（插话，投到当前回合的下一步）—— 两者都记成
// `{kind:'user'}` 的持久消息。收件箱的 splice 事件才是这件事的事实来源。
//
// 折叠语义与上游同一套（三条，别自行简化）：
//   1. **claim 才产生「当前这批」**：`removedCount > 0` 且 `outcome !== 'canceled'` 的那次 splice，
//      把此前累积的待处理链**落成快照**，被取走的那段 id 即「本步取用的批次」；
//   2. 其余 splice 只是追加，记成待处理链（不改变「当前这批」）；
//   3. 若后来的 splice 把某个已 claim 的 id **又插回**收件箱，就把它从「当前这批」里去掉。
//
// 消费方式：构建器按事件顺序喂 `accept`，在遇到 `user/message` 的那一刻问 `claimed(id)` ——
// 与上游「取该事件之前的最新折叠状态」同一时点，不是事后整表判断。
import type { DshStreamEvent } from './types';

/** 一次 splice 的坐标与内容（`inserted` 只留消息 id）。 */
interface PendingSplice {
    start: number;
    removedCount: number;
    inserted: string[];
}

/** 待处理链：快照（claim 之后的基线）或用前一个状态 + 一次 splice 表达。 */
type PendingState =
    | { kind: 'snapshot'; ids: string[] }
    | { kind: 'splice'; previous: PendingState; start: number; removedCount: number; inserted: string[] };

export interface InboxClaimFold {
    /** 喂一条事件（只认 `agent/inbox/spliced` 且 `target === 'next-step'`；其余原样忽略）。 */
    accept(event: DshStreamEvent): void;
    /** 该消息 id 是否属于**当前这批**被取用的批次（即插话）。 */
    claimed(messageId: string): boolean;
}

/** `inserted` 里的消息 id（形状不对的条目跳过：宁可少标一条，也不误标）。 */
function insertedIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: string[] = [];
    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') {
            continue;
        }
        const id = (entry as { id?: unknown }).id;
        if (typeof id === 'string') {
            out.push(id);
        }
    }
    return out;
}

/** 把待处理链展开成 id 列表（与上游的物化同义：从最旧的快照起依次套用 splice）。 */
function materialize(state: PendingState): string[] {
    const splices: Array<Extract<PendingState, { kind: 'splice' }>> = [];
    let current = state;
    while (current.kind === 'splice') {
        splices.push(current);
        current = current.previous;
    }
    const out = [...current.ids];
    for (const splice of splices.reverse()) {
        out.splice(splice.start, splice.removedCount, ...splice.inserted);
    }
    return out;
}

/**
 * 建一次会话窗口的折叠器。
 *
 * 它**无状态跨构建**：每次 `buildRows` 都从头重放整个窗口，所以每构建一次新建一个即可
 * （这也让「窗口被替换后重新定基」自然正确）。
 */
export function createInboxClaimFold(): InboxClaimFold {
    let pending: PendingState = { kind: 'snapshot', ids: [] };
    let currentClaimed: ReadonlySet<string> = new Set<string>();

    return {
        accept(event: DshStreamEvent): void {
            if (event.type !== 'agent/inbox/spliced') {
                return;
            }
            const data = event.data as
                | { target?: unknown; start?: unknown; removedCount?: unknown; inserted?: unknown; outcome?: unknown }
                | undefined;
            if (data === undefined || data.target !== 'next-step') {
                return;
            }
            // 坐标缺失即整条丢掉：拿一个错位的 start 去 splice，会把无关消息标成插话
            if (typeof data.start !== 'number') {
                return;
            }
            const start = data.start;
            const removedCount = typeof data.removedCount === 'number' ? data.removedCount : 0;
            const inserted = insertedIds(data.inserted);

            if (removedCount > 0 && data.outcome !== 'canceled') {
                // claim：待处理链落成快照，被取走的这一段就是「当前这批」
                const ids = materialize(pending);
                const claimed = ids.splice(start, removedCount, ...inserted);
                pending = { kind: 'snapshot', ids };
                currentClaimed = new Set(claimed);
                return;
            }
            // 非 claim：记成待处理链；顺带把又被插回来的 id 从「当前这批」里摘掉
            let next: Set<string> | undefined;
            for (const id of inserted) {
                if (!currentClaimed.has(id)) {
                    continue;
                }
                next ??= new Set(currentClaimed);
                next.delete(id);
            }
            if (next !== undefined) {
                currentClaimed = next;
            }
            pending = { kind: 'splice', previous: pending, start, removedCount, inserted };
        },

        claimed(messageId: string): boolean {
            return currentClaimed.has(messageId);
        },
    };
}
