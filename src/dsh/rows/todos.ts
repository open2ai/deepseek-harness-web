// 任务清单的折叠（适配上游 0.1.7-rc.2）：`todo/write` 整表快照 + 新一轮清空。
//
// 为什么由插件自己折：清单活在会话事件流里（宿主投影不随事件推给插件），而「本轮开始就清空、
// 回合结束仍保留」这条口径只有从事件里才拿得到 —— 少了它，跑完的那份清单会在回合结束时消失。
import type { DshStreamEvent, DshTodoItem } from './types';

/** 三态取值（事件载荷形状不可信，逐个校验而不是强转）。 */
const TODO_STATUSES = new Set<string>(['pending', 'in_progress', 'completed']);

/**
 * 事件载荷 → 清单。**整表语义**：形状不合（不是数组）返回 null（当作没写，保留上一份），
 * 单条形状不合就丢掉那一条（宁缺勿错，不把坏条渲染成一条空任务）。
 */
function itemsOf(value: unknown): DshTodoItem[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const out: DshTodoItem[] = [];
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object') {
            continue;
        }
        const rec = entry as { content?: unknown; status?: unknown };
        const content = typeof rec.content === 'string' ? rec.content : '';
        const status = typeof rec.status === 'string' ? rec.status : '';
        if (content.trim() === '' || !TODO_STATUSES.has(status)) {
            continue;
        }
        out.push({ content, status: status as DshTodoItem['status'] });
    }
    return out;
}

/**
 * 从事件窗口折叠出**当前**清单。
 *
 * 口径：`todo/write` 整表覆盖（后写胜），`turn/start` 置空，**`turn/end` 不清空** ——
 * 跑完的那份清单要留在界面上，直到下一轮开始才让位。
 * @param events - 事件窗口（按序号有序；顺序无关，只按出现先后折叠）
 * @returns 当前清单；`null` = 从未写过或新一轮已开始（消费方据此不渲染卡片）
 */
export function foldTodos(events: readonly DshStreamEvent[]): DshTodoItem[] | null {
    let state: DshTodoItem[] | null = null;
    for (const event of events) {
        if (event.type === 'turn/start') {
            state = null;
            continue;
        }
        if (event.type !== 'todo/write') {
            continue;
        }
        const parsed = itemsOf(event.data?.['todos']);
        if (parsed !== null) {
            state = parsed;
        }
    }
    return state;
}
