// **回合座位的事实**（纯函数）：一个回合的"头 / 段 / 当前世代"由**座位计划**说话。
//
// 为什么需要它：这三件事原先都在渲染层**逐行近似**出来 ——
//   · 「谁是回合头」= 该回合第一条**可见**行（行级推断）；
//   · 「这个回合有几段」= 按行收集 `generation` 去重（行级推断）；
//   · 「当前世代是哪一段」= 遍历该回合所有行取 `answerStep` 最大值（行级推断）。
// 三处的共同毛病是：**答案其实由节点模型决定好了**（回合过程项是一个 render entry，
// 它的回答按段切成多行），却在渲染层靠"行的性质"反推 —— 行一旦被过滤、被挪位、被补容器行，
// 推断就会跟着漂。这里改成从座位计划直读：一条 entry 一项，项内的行就是那一段。
//
// 这一层不依赖 DOM 与 store，便于脚本级守卫逐形状断言。
import type { RenderSeatKeys } from './render-plan'

/** 一个回合的座位级事实。 */
export interface TurnSeatFacts {
    /** 承该回合控制块的那一行（= 回合过程项那一支的**首行**）；该回合没有过程项时为 `undefined`。 */
    headRowKey: string | undefined
    /** 该回合过程项**占用的行数**（= 段数：每段一条回答行）。 */
    rowCount: number
    /** **当前世代**：项内各行 `answerStep` 的最大值（每行带自己那一段的步号）。 */
    currentStep: number | undefined
    /** 该回合过程项的座位 key（"同一回合的多行"由此认亲）。 */
    seatKey: string | undefined
}

/** 取一行事实所需的最小形状（只要这几个字段，便于守卫构造夹具）。 */
export interface TurnSeatRowLike {
    key: string | number
    turn?: number
    /** 世代号（`generation`）：只在**插话**时递增，"每片一个回答步"不递增。行级兜底会读它。 */
    generation?: number
    process?: { answerStep?: number | null }
}

/**
 * 按回合汇总座位级事实。
 *
 * @param seats - 座位计划（`nodesToSeatRows` 的产物，行 key 已转成行表 key）。
 * @param rowsByKey - 行 key → 行（渲染层给的是 Map；也能传一个查表函数）。
 * @returns 回合号 → 事实。只包含**有回合过程项**的回合。
 */
export function turnSeatFacts(
    seats: readonly RenderSeatKeys[],
    rowsByKey: { get(key: string): TurnSeatRowLike | undefined },
): Map<number, TurnSeatFacts> {
    const facts = new Map<number, TurnSeatFacts>()
    for (const seat of seats) {
        // 只认**回合过程项**这一支：回合的头、段、世代都挂在它身上
        //（其它种类各自一行，没有"多项一行"的结构）。
        if (seat.nodeKind !== 'turn-process') continue
        let headRowKey: string | undefined
        let currentStep: number | undefined
        let rowCount = 0
        for (const rowKey of seat.rowKeys) {
            const row = rowsByKey.get(rowKey)
            if (row === undefined) continue
            if (headRowKey === undefined) headRowKey = rowKey
            rowCount += 1
            const step = row.process?.answerStep
            if (typeof step === 'number' && (currentStep === undefined || step > currentStep)) currentStep = step
        }
        facts.set(seat.turn, { headRowKey, rowCount, currentStep, seatKey: seat.key })
    }
    return facts
}

/**
 * **行级兜底**：座位计划读不到（旧宿主 / mock 夹具）时，按行推出"回合头"与"世代集合"。
 *
 * 为什么单独抽出来：这两段原先散在渲染体里内联，改一处要读整段渲染才知道它从哪来。
 * 抽成具名函数之后，它明确地只做两件事，而且**只在座位层给不出答案时**才被调用：
 *   · `headRow` —— 该回合**第一条可见行**（座位层给的是"过程项首行"，两者在正常会话里一致）；
 *   · `generations` —— 按 `generation` 去重（没有该字段的行按自己的 key 各算一代）。
 *
 * @param rows - 已过滤可见的行（顺序即渲染顺序）。
 * @param seatHeadOf - 座位层给的"该回合过程项首行 key"；给不出时返回 `undefined`。
 * @returns 回合 → 头行 / 世代集合。
 */
export function turnRowIndex<T extends TurnSeatRowLike & { key: number | string }>(
    rows: readonly T[],
    seatHeadOf: (turn: number) => string | undefined,
): { headRow: Map<number, T>; generations: Map<number, Set<number | string>> } {
    const headRow = new Map<number, T>()
    const generations = new Map<number, Set<number | string>>()
    for (const row of rows) {
        if (row.turn === undefined) continue
        if (isAssistant(row)) {
            const set = generations.get(row.turn) ?? new Set<number | string>()
            set.add(row.generation ?? row.key)
            generations.set(row.turn, set)
        }
        // 只有 assistant 行能承控制块（回合过程项带出的那些行都是 assistant）。
        if (!isAssistant(row)) continue
        if (headRow.has(row.turn)) continue
        const seatHead = seatHeadOf(row.turn)
        // **座位优先**：只有座位首行才配当回合头；座位层给不出答案时才退回"第一条可见行"。
        if (seatHead === undefined || String(row.key) === seatHead) headRow.set(row.turn, row)
    }
    return { headRow, generations }
}

/** 该行是不是 assistant 行（按形状判，避免这一层依赖 store 类型）。 */
function isAssistant(row: TurnSeatRowLike): boolean {
    return (row as { kind?: unknown }).kind === 'assistant'
}

/**
 * **某一行是不是它所在座位的首行**（= 该座位控制的落点）。
 *
 * 上游的渲染单位是 entry：控制节点自己是一个 entry，它下面挂该回合的内容；
 * 插件把"回合过程项"切成多行（一段一行），于是"控件落在哪一行"必须有个确定答案 ——
 * 就是**座位首行**。行级近似（"该回合第一条可见行"）会把控件挪到别的段上去。
 *
 * @param seats - 座位计划。
 * @param rowKey - 待判的行 key（行表口径）。
 * @returns 该行是所在座位首行时为 `true`；不在任何座位里（乐观行）时为 `false`。
 */
export function isSeatLeadRow(seats: readonly RenderSeatKeys[], rowKey: string | number): boolean {
    const key = String(rowKey)
    for (const seat of seats) {
        if (seat.rowKeys[0] === key) return true
        if (seat.rowKeys.includes(key)) return false
    }
    return false
}
