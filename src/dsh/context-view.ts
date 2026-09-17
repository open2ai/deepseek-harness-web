// 上下文占用投影的读取（宿主侧）：只搬运、只校验形状，判定与显示派生留给消费方。
//
// 为什么单独一个文件：这两个投影由 dsh 的 token-meter 提供，**不同组合可能根本没有它们**
// （键缺失、或形状不符）—— 读不出来就当没有，页面据此整个不渲染那个环，而不是画一个 0%。
import type { DshContextBreakdown, DshContextPressure } from './context-types';

/** 取一个有限的非负数值；其它一律当缺省。 */
function num(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** 读上下文压力：`pressureTokens` / `projectedTokens` / `contextWindow` 都是可选事实，缺哪个就当没有。 */
export function readContextPressure(value: unknown): DshContextPressure | undefined {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const v = value as Record<string, unknown>;
    const pressureTokens = num(v['pressureTokens']);
    const projectedTokens = num(v['projectedTokens']);
    const contextWindow = num(v['contextWindow']);
    if (pressureTokens === undefined && projectedTokens === undefined && contextWindow === undefined) {
        return undefined;
    }
    return {
        ...(pressureTokens === undefined ? {} : { pressureTokens }),
        ...(projectedTokens === undefined ? {} : { projectedTokens }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
    };
}

/** 读上下文构成：三个数缺一不可（缺一个就整条不算，免得画出对不上的分段）。 */
export function readContextBreakdown(value: unknown): DshContextBreakdown | undefined {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const v = value as Record<string, unknown>;
    const systemTokens = num(v['systemTokens']);
    const toolsTokens = num(v['toolsTokens']);
    const messageTokens = num(v['messageTokens']);
    if (systemTokens === undefined || toolsTokens === undefined || messageTokens === undefined) {
        return undefined;
    }
    return { systemTokens, toolsTokens, messageTokens };
}
