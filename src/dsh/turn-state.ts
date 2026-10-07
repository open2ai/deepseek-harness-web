// 「这一轮还在跑吗」这件事的**事件级**判据（纯函数，适配上游 0.1.7-rc.2）。
//
// 为什么单列：状态行（「深度求索中…」）与停止按钮都挂在这个布尔值上，而它的两个输入端
// （`session/follow` 的事件、`session/control` 的 `turnBoundary` 投影）各来自一条流 ——
// 任何一端说错了，用户看到的就是「状态字忽然消失」或「停止按钮不复位」。判据能被脚本
// 直接喂事件驱动（`tmp/_turn.state.test.mjs`），比在真机上试快得多。
//
// 上游投影的形状（`turnBoundaryProjectionDefinition`）：
//   · `turn/start` → `openTurnStartSeq = seq`（在跑）
//   · `turn/end`   → `openTurnStartSeq = null`（跑完了）
// 于是「投影说的」就是权威。事件侧只用它做一件事：**挡掉迟到的 `turn/end`**。
import type { DshStreamEvent } from './rows/types';

/** 事件侧回合状态。 */
export interface TurnState {
    /** 已知的最大回合号（`turn/start` 与 `turn/end` 的 `data.turn`）。 */
    lastTurn: number;
    /** 由**事件**得出的在跑结论；`undefined` = 事件侧还没有定论（交给投影/窗口）。 */
    open: boolean | undefined;
}

/** 一条事件对回合状态的判定结果。 */
export interface TurnStateVerdict {
    state: TurnState;
    /**
     * 该事件是否**应当**被当作「这一轮的收尾」。
     *
     * `false` = 迟到的上一轮收官：**不能**据此关掉当前这一轮 ——
     * 那会让状态行整个卸载（时钟重置）、停止按钮提前复位，而这一轮其实还在跑。
     */
    closesCurrentTurn: boolean;
    /** 被忽略的原因（仅用于诊断日志）。 */
    ignoredReason?: string;
}

/** 空状态。 */
export function initialTurnState(): TurnState {
    return { lastTurn: 0, open: undefined };
}

/** 从事件里取回合号（`turn/start` / `turn/end` 的 `data.turn`）。 */
function turnOf(event: DshStreamEvent): number | undefined {
    const turn = (event.data as { turn?: unknown } | undefined)?.turn;
    return typeof turn === 'number' ? turn : undefined;
}

/**
 * 折一条事件。
 * @param state - 当前状态
 * @param event - 会话事件（非回合边界事件原样返回）
 * @returns 下一个状态与「是否算本轮收尾」
 */
export function foldTurnState(state: TurnState, event: DshStreamEvent): TurnStateVerdict {
    if (event.type === 'turn/start') {
        const turn = turnOf(event);
        return {
            state: {
                lastTurn: turn === undefined ? state.lastTurn : Math.max(state.lastTurn, turn),
                open: true,
            },
            closesCurrentTurn: false,
        };
    }
    if (event.type !== 'turn/end') {
        return { state, closesCurrentTurn: false };
    }
    const turn = turnOf(event);
    // 没有回合号（形状不合）：不敢挡也不能挡 —— 按"就是本轮的收尾"处理，与旧行为一致
    if (turn === undefined) {
        return { state: { ...state, open: false }, closesCurrentTurn: true };
    }
    if (turn < state.lastTurn) {
        // 迟到的上一轮收官：忽略。当前这一轮仍在跑（`turn/start` 必先于它到达）
        return {
            state,
            closesCurrentTurn: false,
            ignoredReason: `turn/end turn=${String(turn)} < 已知最大 ${String(state.lastTurn)}`,
        };
    }
    // 本轮或更晚的收官都算收尾：更晚说明中间那几轮的事件没到齐，但"没在跑"是确定的
    return { state: { ...state, open: false }, closesCurrentTurn: true };
}

/** 投影值（`turnBoundary`）→ 在跑结论；`undefined` = 该投影未组合，交给事件/窗口。 */
export function openFromTurnBoundary(raw: unknown): boolean | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const seq = (raw as { openTurnStartSeq?: unknown }).openTurnStartSeq;
    return seq !== null && seq !== undefined;
}

/**
 * **本窗口里有没有未闭合的回合**（纯函数，与 `dshService.turnActiveFromWindow` 同一套走法）。
 *
 * 为什么要单独抽出来：权威读数（`turnBoundary` 投影）说"在跑"、而**自己这条路的事件窗口**里
 * 却先遇到 `turn/end`（或压根没有回合事件）时，说明这条窗口是**旧的** —— 典型场景是刚打开面板
 * 或断线重连之前留下的那一份。真机现象：网页端那一轮还在跑，插件这边整轮已经"结束"了
 * （没有状态行、主钮是发送）。
 *
 * @param events - 当前事件窗口（顺序即日志顺序）。
 * @returns `true` = 先遇到 `turn/start`；`false` = 先遇到 `turn/end`；`undefined` = 窗口里没有回合事件。
 */
export function windowHasOpenTurn(events: readonly { type?: string }[]): boolean | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const type = events[i]?.type;
        if (type === 'turn/end') {
            return false;
        }
        if (type === 'turn/start') {
            return true;
        }
    }
    return undefined;
}
