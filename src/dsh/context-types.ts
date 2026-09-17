// 上下文占用的**形状**（只类型、零运行时代码）。
//
// 与队列同一理由：页面要 `import type` 取用，不能让宿主那串 node 依赖被拖进 webview 的类型工程。
// 两个投影都由 dsh 的 token-meter 提供，插件只搬运事实，占用率与分段宽度都在页面算（展示派生在页面）。

/** 上下文压力：最近一次请求的 prompt 大小 + 最新已知的路线容量（都缺省 = 该 dsh 没这个能力）。 */
export interface DshContextPressure {
    /** 最近一次请求由提供方回报的 prompt 大小（未缓存输入 + 缓存读 + 缓存写；不含输出） */
    pressureTokens?: number;
    /** 下一次请求的 prompt 预估：在 `pressureTokens` 上叠加此后增删的估算（压缩后也会立刻反映） */
    projectedTokens?: number;
    /** 最新已知的上下文窗口大小 */
    contextWindow?: number;
}

/** 下一次请求上下文的**启发式构成**（不是费用，只是大致配比：三者之和不必等于上面那个占用数）。 */
export interface DshContextBreakdown {
    /** 最后一段非空 system 提示词的估算 token */
    systemTokens: number;
    /** 最新请求信封里工具定义的估算 token */
    toolsTokens: number;
    /** 其余可见内容的估算 token */
    messageTokens: number;
}

/** 一个会话的上下文占用事实（两条投影各自可能缺失）。 */
export interface DshContextFacts {
    pressure?: DshContextPressure;
    breakdown?: DshContextBreakdown;
}
