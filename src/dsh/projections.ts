// 会话投影**基线**的取值与判空 —— 独立纯函数文件（适配 dsh 0.1.7+）。
//
// 为什么单独一层：输入框下方那两块读数（会话统计 / 模型用量）、上下文环、目标条、plan
// **全部**来自这份投影整表；而它有两个来路、形状还不完全一样：
//   · `session/follow` 快照里的 `projections:{ asOfSeq, values }` —— **不保证带**：
//     旧会话、控制流还没有基线时就是缺的（插件此前只认这一条，于是"输入框下面什么都没有"）；
//   · 专用 remote `session/projections` —— 会话不存在时 `null`；正常是带 `kind: 'sequenced'` 的精确基线；
//     只有**需要先迁移格式**的旧会话才返回 `kind: 'migration-required'`，且**不带** `asOfSeq`
//     （那份 `values` 是缓存提示，可能过时）。
//
// I/O 留在 `session.ts`（两个来路各一个薄封装），这里只做形状归一与判空，便于直接喂用例。
// **认不出就返回 undefined**（不是空表）：调用方据此保留上一次的表，而不是把界面清空。

/** 投影基线的两种形态（`sequenced` = 可当精确基线；`migration-required` = 仅供兜底显示的缓存提示）。 */
export type ProjectionBaselineKind = 'sequenced' | 'migration-required';

export interface ProjectionBaseline {
    readonly kind: ProjectionBaselineKind;
    readonly values: Record<string, unknown>;
    /** 只对 `sequenced` 有意义：这份基线对应的会话事件序号（水位）。 */
    readonly asOfSeq?: number;
}

/**
 * 从投影基线值里取**整表**。
 * @param value - `{ kind?, asOfSeq?, values }` 形状的基线值（可能是 `null`、可能形状不符）。
 * @returns 投影整表；`null` / 缺 `values` / `values` 不是对象时 `undefined`。
 */
export function projectionValuesOf(value: unknown): Record<string, unknown> | undefined {
    return projectionBaselineOf(value)?.values;
}

/**
 * 把一次投影读取归一成「带形态的基线」。
 *
 * 判据（三种输入都要认）：
 * - 缺 `kind`：**0.2.0 及更早的宿主**只有 `{ asOfSeq, values }`，按 `sequenced` 处理
 *   （这是插件支持 `0.1.7+` 所必需的；把"缺 kind"当成未知会把水位整条丢掉）；
 * - `kind: 'sequenced'`：精确基线，`asOfSeq` 是数字时一并取出；
 * - `kind: 'migration-required'`：缓存提示，**没有水位**，调用方只能用它的 `values` 兜底显示；
 * - 其他 `kind` 字符串：认不出，返回 `undefined`（调用方保留上一次的表，不清空界面）。
 * @param value - remote 的原始返回值。
 * @returns 归一后的基线；形状不符 / 认不出的形态时 `undefined`。
 */
export function projectionBaselineOf(value: unknown): ProjectionBaseline | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value as { kind?: unknown; asOfSeq?: unknown; values?: unknown };
    const values = record.values;
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        return undefined;
    }
    const table = values as Record<string, unknown>;
    if (record.kind === 'migration-required') {
        return { kind: 'migration-required', values: table };
    }
    if (record.kind !== undefined && record.kind !== 'sequenced') {
        return undefined;
    }
    const asOfSeq = record.asOfSeq;
    return {
        kind: 'sequenced',
        values: table,
        ...(typeof asOfSeq === 'number' && Number.isFinite(asOfSeq) ? { asOfSeq } : {}),
    };
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
