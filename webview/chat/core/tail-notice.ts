// 回合终局通知的**排序锚点**（镜像上游 `turn-max-tokens` 的 `noticeAnchor()`）。
//
// 上游把 token 上限那条放在**收官回答与 turn-tail 之间**，源码注释写明理由：
// 「让 turn-tail 保持该回合最后一个 Chat 节点、保住它的分叉动作」；没有收官回答时退回 `turn/end` 的 seq。
// 插件把 turn-tail（动作条 + 交付区）放在回答行**内部**，所以等价位置 = **回答行内、动作条之前** ——
// 这里把紧跟回答行的 `warning` 通知归并给那一行，由 `AssistantRow` 在尾部之前渲染。
//
// **`error` 档不并**：上游 `turn-error` 的排序键就是 `turn/end` 的 seq（落在 turn-tail 之后），
// 与插件「独立行排在回答行之后」一致。
//
// 纯函数（无 Preact/DOM），便于守卫直接钉住（`tmp/_rows.rc2.wiring.test.mjs`）。

/** 通知行里本模块要看的字段（只取判据用得到的形状）。 */
export interface AttachNoticeLike {
    readonly kind: string;
    readonly key: number;
    readonly tone?: string;
    readonly turn?: number;
}

/** 一行 + 归并到它尾部的通知（渲染顺序：行正文 → 这些通知 → 动作条）。 */
export interface RowWithTailNotices<T> {
    readonly row: T;
    readonly tailNotices: readonly T[];
}

/**
 * 把紧跟回答行的 `warning` 通知归并到那一行；被归并的通知在顶层列表里**不再单独渲染**。
 * @param rows - 当前行列表（顺序即渲染顺序）。
 * @returns 每行（原顺序）+ 归并进来的尾部通知。
 */
export function attachTailNotices<T extends AttachNoticeLike>(rows: readonly T[]): Array<RowWithTailNotices<T>> {
    const out: Array<RowWithTailNotices<T>> = [];
    const consumed = new Set<number>();
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row.kind !== 'assistant') {
            if (!consumed.has(row.key)) {
                out.push({ row, tailNotices: [] });
            }
            continue;
        }
        const tail: T[] = [];
        for (let j = i + 1; j < rows.length; j += 1) {
            const next = rows[j];
            if (next.kind !== 'turnNotice' || next.tone !== 'warning') {
                break;
            }
            // 同一个回合才归并（两侧都给了回合号时判等）
            if (row.turn !== undefined && next.turn !== undefined && row.turn !== next.turn) {
                break;
            }
            tail.push(next);
            consumed.add(next.key);
        }
        out.push({ row, tailNotices: tail });
    }
    return out;
}
