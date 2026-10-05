// `rows` 帧的**增量差分**（§3.3 的那半：只发变动的行）。
//
// 为什么要它：长会话每帧推「整份行 JSON」——实测（`tmp/_rows.payload.probe.mjs`，17,441 事件的会话）
// 平均 **11.96 MB/帧、最坏 15.25 MB**，而那一帧**真正变了的行只有 3.0 行**（116 行里的 2.6%）。
// 流式期间每几十毫秒一帧，等于把 12 MB 反复序列化 + 过 postMessage。
//
// 协议（与 `rows` 帧同形，字段语义见 `webview/chat/core/protocol.ts`）：
//   · `rowKeys`：**全量**顺序（行的 `key` 数组）。它是几百个小整数，压不动也不需要压 ——
//     有了它，页面就能按 key 拼回完整顺序，不必收整份行对象。
//   · `rowDelta`：**本帧变了或新增的**行（整行对象）。页面按 `key` 覆盖自己的缓存。
//   · `rows`：**只在差分不可用时**才给整表（`reason` 说明原因）：首帧、行键顺序重排、
//     变化面过大、或页面明确要求。页面见到 `rows` 就整表替换。
//
// **等价性是硬约束**：页面按 (上一次的缓存 + 本帧 rowDelta) 依 rowKeys 重排，结果必须与整表逐字节一致。
// 守卫 `tmp/_rows.diff.test.mjs` 逐前缀比对两种口径。

/** 行上唯一且稳定的键（宿主侧行模型每条都有 `key`）。 */
interface KeyedRow {
    key: number;
}

/** 一帧的下发形态（`rows` 与 `rowDelta` 互斥：给了 `rows` 就是整表）。 */
export interface RowsPayload<T extends KeyedRow> {
    /** 整表（只在差分不可用时给） */
    rows?: T[];
    /** 本帧变了/新增的行 */
    rowDelta?: T[];
    /** 全量顺序（行的 key） */
    rowKeys?: number[];
    /** 给整表时的原因（诊断用） */
    fullReason?: 'first' | 'reordered' | 'churn' | 'requested';
}

/** 一次差分的结果：要发的帧 + 这次量到的 JSON 字节数（供节流预算复用，免得再序列化一遍）。 */
export interface DiffOutcome<T extends KeyedRow> {
    payload: RowsPayload<T>;
    /** 整表等价 JSON 的字节数（**本帧顺手量出来的**：差分期本来就要序列化每行去比较） */
    fullBytes: number;
}

/** 变化面超过这个比例就给整表（差分本身也要序列化行，超了不如直发）。 */
const FULL_REBUILD_RATIO = 0.4;
/** 新增行超过这个比例，说明窗口被整表替换了（快照重开）→ 给整表，别让页面按 key 逐个补。 */
const FRESH_FULL_RATIO = 0.25;

/**
 * 逐帧比较行表的差分器（**每个会话一个实例**；换会话/窗口整表替换时 `reset()`）。
 *
 * 内部只留上一帧的「key → 该行 JSON」与顺序：比较就是字符串比较，不必深比对象。
 */
export class RowDiffer<T extends KeyedRow> {
    /** 上一帧发出去的行：key → JSON 文本（下一帧只比字符串）。 */
    private sent = new Map<number, string>();
    /** 上一帧**收到的行对象**：key → 对象引用。引用没变就不必再序列化（增量的行构建只重建变化的行）。 */
    private lastObjects = new Map<number, T>();
    /** 上一帧的顺序（判"重排"用：顺序变了就不能只发 delta）。 */
    private order: number[] = [];
    /** 上一帧整表的等价字节数（节流预算复用）。 */
    private bytes = 0;

    /** 强制下一帧发整表（页面要求 / 会话切换 / 快照整窗替换后）。 */
    private forceFull = true;

    /** 让下一帧走整表（页面重连、切会话、整窗替换都该调它）。 */
    requestFull(): void {
        this.forceFull = true;
    }

    /** 上一帧整表等价载荷的字节数（节流用它，不必再序列化一次）。 */
    lastFullBytes(): number {
        return this.bytes;
    }

    /**
     * 比一次，给出本帧该发什么。
     * @param rows - 本帧的完整行表（顺序即渲染顺序）。
     * @returns 该发的帧与整表等价字节数。
     */
    diff(rows: readonly T[]): DiffOutcome<T> {
        const keys: number[] = [];
        /** 本帧每行的 JSON：引用没变的行直接复用上一帧的文本（这就是省下的那笔序列化）。 */
        const serialized = new Map<number, string>();
        let fullBytes = 2; // 方括号
        for (const row of rows) {
            const cachedJson = this.sent.get(row.key);
            const json =
                this.lastObjects.get(row.key) === row && cachedJson !== undefined
                    ? cachedJson
                    : JSON.stringify(row);
            keys.push(row.key);
            serialized.set(row.key, json);
            fullBytes += json.length + 1;
        }
        this.bytes = fullBytes;

        if (this.forceFull) {
            this.forceFull = false;
            return this.commit(rows, keys, serialized, fullBytes, { rows: [...rows], fullReason: 'first' });
        }
        const delta: T[] = [];
        for (const row of rows) {
            if (this.sent.get(row.key) !== serialized.get(row.key)) {
                delta.push(row);
            }
        }
        /**
         * **重排不整表**：`rowKeys` 全是小整数（实测几百个），每帧发全量的代价可以忽略，
         * 而"顺序变了"在长会话里**每批都发生**（行锚点按 `:not([hidden])` 规则插在隐藏行之间，
         * 一条隐藏行的动态跳过就会让相邻关系变）—— 先前按它判整表，等于 40% 的帧白推 13 MB。
         *
         * 真正必须整表的只有一种情况：**新增的行很多**（那说明窗口被整表替换了，比如快照重开）。
         * 少量新增走 delta（页面按 `key` 补进缓存即可）。
         */
        const known = new Set(this.order);
        const fresh = delta.filter((row) => !known.has(row.key)).length;
        const appendedWindow = fresh > FRESH_FULL_RATIO * rows.length && rows.length > 8;
        if (delta.length > rows.length * FULL_REBUILD_RATIO && rows.length > 8) {
            // 变化面过大：差分要送的东西已经接近整表，直发更省一次拼装
            return this.commit(rows, keys, serialized, fullBytes, { rows: [...rows], fullReason: 'churn' });
        }
        if (appendedWindow) {
            return this.commit(rows, keys, serialized, fullBytes, { rows: [...rows], fullReason: 'reordered' });
        }
        return this.commit(rows, keys, serialized, fullBytes, { rowDelta: delta, rowKeys: keys });
    }

    /** 记下这一帧发了什么（下一帧的比较基线）。 */
    private commit(
        rows: readonly T[],
        keys: number[],
        serialized: Map<number, string>,
        fullBytes: number,
        payload: RowsPayload<T>
    ): DiffOutcome<T> {
        this.sent = serialized;
        this.order = keys;
        this.lastObjects = new Map(rows.map((row) => [row.key, row]));
        return { payload, fullBytes };
    }
}
