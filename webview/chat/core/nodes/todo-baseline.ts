// **任务清单写入 × 上一次清单**的配对（纯函数）。
//
// 为什么要单独一层：`todo_write` 卡片要显示「与上次清单相比」的增/改/删，而"上次清单"不是这条调用
// 自带的信息 —— 它得从**更早的 `todo/write` 事件**里找。宿主那条路早就这么做了（每条 `todo_write`
// 调用与它**之前最近一次** `todo/write` 落盘的清单配对），但渲染源换成客户端节点模型之后这条路没接上：
//
// 配对口径与宿主一致：**只认"事件序"上更早的那一次**，与回合边界无关（`todo/write` 是投影落盘事件，
// 跨回合存活）；一次写入之后，它自己成为后续调用的基线。
import type { DshTodoItem } from '../../../../src/dsh/rows/types'
import type { SessionEvent } from './types'

/** 一次配对结果：调用 id → 它之前最近一次落盘的清单（`null` = 之前没有过）。 */
export interface TodoBaselines {
    /** 调用 id（`callId` 或 PTC 子调用 id）→ 上一次清单。 */
    baselines: Map<string, DshTodoItem[] | null>
    /** 扫完之后"最近一次落盘的清单"（增量构建时喂给下一段当种子）。 */
    seed: DshTodoItem[] | null
}

/** `todo/write` 事件里的清单（形状不合按"没有"处理，与其它消费者同口径）。 */
function todosOf(event: SessionEvent): DshTodoItem[] | null {
    const todos = event.data['todos']
    return Array.isArray(todos) ? (todos as DshTodoItem[]) : null
}

/**
 * 把一段事件流里的 `todo_write` 调用与它们**之前**的清单配对。
 *
 * @param events - 事件切片（顺序即事件序）。
 * @param seed - 切片之前"最近一次落盘的清单"（增量构建时由上一段带过来）。
 * @returns 配对表 + 扫完后的种子（交给下一段）。
 */
export function pairTodoBaselines(events: readonly SessionEvent[], seed: DshTodoItem[] | null = null): TodoBaselines {
    const baselines = new Map<string, DshTodoItem[] | null>()
    let last = seed
    for (const event of events) {
        if (event.type === 'todo/write') {
            last = todosOf(event)
            continue
        }
        if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') continue
        if (event.data['name'] !== 'todo_write') continue
        const id = event.type === 'tool/call' ? event.data['callId'] : event.data['subCallId']
        if (typeof id !== 'string' || id === '') continue
        // ⚠️ 值是**引用**：清单是整表替换、不会被就地改，直接共享省一次深拷贝。
        baselines.set(id, last)
    }
    return { baselines, seed: last }
}

/**
 * 合并两段扫描的配对表（增量构建：前缀 + 尾巴）。
 *
 * 尾巴若能命中前缀里已配好的 id（理论上不会——id 唯一），以后者为准。
 * @param prefix - 先前那段的结果。
 * @param tail - 之后那段的结果。
 */
export function mergeTodoBaselines(prefix: TodoBaselines, tail: TodoBaselines): TodoBaselines {
    const baselines = new Map(prefix.baselines)
    for (const [id, list] of tail.baselines) baselines.set(id, list)
    return { baselines, seed: tail.seed ?? prefix.seed }
}
