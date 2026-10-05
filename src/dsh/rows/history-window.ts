// 事件窗口（宿主侧）：**行构建的唯一输入**该怎么长。
//
// 为什么单列一个类：这段逻辑决定「用户能看到多早以前」，而它埋在 2400 行的 `dshService` 里时
// 既没法单测、也看不清两条通路（打开历史 / 实时跟随）的差别。抽出来之后：
//   · 三种进窗口的方式各一个方法：`replace`（快照，替换语义）、`append`（实时追加）、`prepend`（更早的一页）；
//   · 页面要的两个事实（`hasMore` / `loadingOlder`）由窗口自己维持，宿主只读。
//
// **窗口不按条数裁剪**（与上游一致）：上游 `session-controller/src/client` 只设取数页大小
//（`PAGE_MESSAGES = 50` / `JUMP_PAGE_MESSAGES = 200`），窗口按 `seq` 合并、**从不删**
//（`client/contract/events.ts` 的 `publish`），显示量交给渲染层虚拟化。
//
// 为什么这里**一个裁剪都不留**：
//   · 按条数裁是私加的限制（上游没有），违反「不得私自加限制」；
//   · 落刀只能落在 `turn/start` 上，而**正在跑的那一轮**的事件就在被丢的那一头附近 ——
//     丢掉之后行构建器拿到的是**残缺的回合**，行数与正文整段塌掉
//     （`tmp/_livecap.probe.mjs`：6 回合会话配上界后行数 12→4、正文 90→30 字）；
//   · 它要解决的问题（长会话卡顿）的正解是**渲染层虚拟化**，不是删数据 —— 见 `12` §3.3（B 类待办）。
// 所以：**这个类永远不删事件**，`list()` 里有什么就是服务端给过什么。

import type { TrimEnd } from './paging';

/**
 * 窗口里的一条事件（只要求「有类型、可能要序号」这两件事，便于脚本构造假事件）。
 */
export interface WindowEventLike {
    type?: string;
    seq?: number;
}

/** 一页更早的历史（`pageSessionEvents` 的返回值形状）。 */
export interface OlderPage<E extends WindowEventLike> {
    events: E[];
    hasMore: boolean;
}

/** 一次进窗口的结果（供宿主落日志；判定都在窗口里）。 */
export interface WindowChange {
    /** 本次新增的事件数（`replace` 时 = 新窗口长度）。 */
    added: number;
    /**
     * 被丢弃的条数。**恒为 0** —— 这个窗口不裁剪。保留字段是为了让调用方与下游形状稳定
     *（也防住"以后又有人把裁剪加回来"时静默改变语义）。
     */
    dropped: number;
    /** 裁剪方向（恒为 `undefined`：不裁剪）。 */
    trimmedEnd?: TrimEnd;
}

/**
 * 事件窗口。泛型参数是事件的精确类型（宿主传 `DshStreamEvent`，脚本传最小形状）。
 */
export class HistoryWindow<E extends WindowEventLike> {
    private events: E[] = [];
    private more = false;
    private loading = false;

    constructor() {}

    /** 当前窗口（只读视图；宿主与 `buildRows` 直接消费）。 */
    list(): readonly E[] {
        return this.events;
    }

    /** 窗口条数。 */
    size(): number {
        return this.events.length;
    }

    /** 更早的历史还没进窗口（页面「加载更早」的门）。 */
    hasMore(): boolean {
        return this.more;
    }

    /** 「加载更早」是否在飞（页面按钮据此禁用）。 */
    isLoadingOlder(): boolean {
        return this.loading;
    }

    /** 清空（换会话）。 */
    clear(): void {
        this.events = [];
        this.more = false;
        this.loading = false;
    }

    /**
     * 整窗替换（`session/follow` 的首帧快照、以及重开订阅的新快照）：**它就是窗口本身**。
     *
     * 为什么不是"合并"：快照就是窗口本身，服务端在每条订阅（含重连）的首帧给出它。
     * 合并会把「订阅先于读取到达」当成要特判的竞态来兜，而替换天然没有这个窗口。
     */
    replace(events: readonly E[], hasMore: boolean): WindowChange {
        this.events = [...events];
        this.more = hasMore;
        return { added: this.events.length, dropped: 0 };
    }

    /**
     * 实时追加（流式到达的持久事件 / 增量帧）。
     *
     * **不裁**：新内容追加在末尾，已有的一段原样保留（与上游一致）。
     */
    append(events: readonly E[]): WindowChange {
        // 逐条 push，不用 `push(...events)`：`append` 会收到批量（快照合并/基线回放），
        // 展开运算符在几十万条上会爆调用栈（`RangeError: Maximum call stack size exceeded`）。
        for (const e of events) {
            this.events.push(e);
        }
        return { added: events.length, dropped: 0 };
    }

    /**
     * 前插一页更早的历史（「加载更早」）。
     *
     * **前插就是纯前插**：可见范围整体向过去扩展，已经有的那段一条不动
     *（所以刚读进来的这一页一定在）。
     *
     * `hasMore` 取**这一页**的返回值（不是"裁过就置真"）：往前翻到底时它自然变假，按钮消失。
     */
    prepend(page: OlderPage<E>): WindowChange {
        this.events = [...page.events, ...this.events];
        this.more = page.hasMore;
        return { added: page.events.length, dropped: 0 };
    }

    /** 标记/解除「加载更早」的进行态（按钮禁用态的唯一来源）。 */
    setLoadingOlder(loading: boolean): void {
        this.loading = loading;
    }

    /**
     * 窗口里最老事件的序号（`beforeSeq` 的来源）。
     * @returns `undefined` = 窗口里没有带序号的事件（还没定基，不该发起翻页）
     */
    oldestSeq(): number | undefined {
        let oldest: number | undefined;
        for (const e of this.events) {
            if (e.seq === undefined) {
                continue;
            }
            oldest = oldest === undefined ? e.seq : Math.min(oldest, e.seq);
        }
        return oldest;
    }

    /**
     * 窗口里最新事件的序号（`throughSeq` 的来源 = 服务端那边的**流游标**）。
     *
     * ⚠️ 这个值**必须**传：服务端按 `end = min(throughSeq + 1, beforeSeq)` 决定这一页读到哪儿，
     * 传 `-1` 会让 `end` 变成 0 —— 返回**空页**、`hasMore` 恒为假，按钮点一次就再不出来
     *（真机："加载更早怎么就一次"）。先前首屏一次要 5000 条、按钮几乎不出现，所以一直没暴露。
     * @returns `undefined` = 窗口里没有带序号的事件（还没定基，不该发起翻页）
     */
    newestSeq(): number | undefined {
        let newest: number | undefined;
        for (const e of this.events) {
            if (e.seq === undefined) {
                continue;
            }
            newest = newest === undefined ? e.seq : Math.max(newest, e.seq);
        }
        return newest;
    }

    /**
     * 按序号去重后并入（重连会**重放**已收到的事件）。
     * @param seen - 宿主维护的已收序号集合
     * @returns 真正新收下的事件（`seq` 缺失的一律视为新，交由调用方决定）
     */
    static freshOf<E extends WindowEventLike>(incoming: readonly E[], seen: Set<number>): E[] {
        const fresh: E[] = [];
        for (const e of incoming) {
            if (e.seq === undefined) {
                fresh.push(e);
                continue;
            }
            if (seen.has(e.seq)) {
                continue;
            }
            seen.add(e.seq);
            fresh.push(e);
        }
        return fresh;
    }
}
