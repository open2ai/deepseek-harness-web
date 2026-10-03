// 会话投影**基线**的取值与判空 —— 独立纯函数文件（适配 dsh 0.1.7+）。
//
// 为什么单独一层：输入框下方那两块读数（会话统计 / 模型用量）、上下文环、目标条、plan
// **全部**来自这份投影整表；而它有两个来路、形状还不完全一样：
//   · `session/follow` 快照里的 `projections:{ asOfSeq, values }` —— **不保证带**：
//     旧会话、控制流还没有基线时就是缺的（插件此前只认这一条，于是"输入框下面什么都没有"）；
//   · 专用 remote `session/projections` → `{ asOfSeq, values } | null`（会话不存在时 null）——
//     任何时刻都能读到权威整表，上游客户端也是单独调它。
//
// I/O 留在 `session.ts`（两个来路各一个薄封装），这里只做形状归一与判空，便于直接喂用例。
// **认不出就返回 undefined**（不是空表）：调用方据此保留上一次的表，而不是把界面清空。

/**
 * 从投影基线值里取整表。
 * @param value - `{ asOfSeq, values }` 形状的基线值（可能是 `null`、可能形状不符）。
 * @returns 投影整表；`null` / 缺 `values` / `values` 不是对象时 `undefined`。
 */
export function projectionValuesOf(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const values = (value as { values?: unknown }).values;
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        return undefined;
    }
    return values as Record<string, unknown>;
}

/**
 * 投影整表是否**没有内容**（键数为 0）。
 *
 * 用来决定"要不要再问一次另一个来路"：空表不是"没有功能"，而是"这次没读到"。
 * @param table - 投影整表。
 */
export function isEmptyProjections(table: Record<string, unknown>): boolean {
    return Object.keys(table).length === 0;
}
