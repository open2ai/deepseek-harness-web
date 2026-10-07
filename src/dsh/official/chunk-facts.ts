// 增量块的事实（适配上游 0.1.7-rc.2）：镜像上游对**流式增量**的两条规则。
//
// ⚠️ CORE-COUPLED（核心耦合；目录名 official，本仓库注释里称"核心"）——只映射 dsh 核心规则，
// 勿混入插件自有逻辑；核心变化只改本目录。
//
// 上游把增量按 `chunk.index` 累积成「块」（block-start 建块、*-delta 续文本、block-end 定稿），
// 上层判据一律读**块**而不是读事件。本文件是这两条读块规则的镜像：
//   - `isVisibleChunk`：该增量算不算「可见证据」（控制锚取每步**首条可见**证据）；
//   - `isInterruptionEvidenceChunk`：该增量算不算「这一步被中断过」的证据（回合关闭时合成中断回答用）；
//   - `chunkBlockFacts`：该增量让所在步的块**多出哪些事实**（有回答内容 / 有推理 / 有工具调用）。
// 分成三个函数是因为它们回答的是三个不同问题，消费方也只各用其一。

/** 块事实：与结算消息走同一套判据（`blockFacts`），故两边可比较。 */
export interface ChunkBlockFacts {
    /** 存在「非推理、非工具、非空白文本」的块（上游 `hasAssistantReplyContent` 同义） */
    hasReply: boolean;
    hasReasoning: boolean;
    hasToolCall: boolean;
}

/**
 * 该增量块是否算「可见的过程证据」。
 *
 * 用途：过程控制锚（`controlAnchorSeq`）取「每步首条**可见** assistant 证据」的最早值 ——
 * 不可见的块（空文本、纯工具调用的起止）不算证据，否则锚点会被空增量拉早、过程区间跟着变宽。
 *
 * @param chunk - 原始增量块（形状不可信，故收 unknown）
 */
export function isVisibleChunk(chunk: unknown): boolean {
    if (chunk === null || typeof chunk !== 'object') {
        return false;
    }
    const c = chunk as Record<string, unknown>;
    const type = c['type'];
    if (type === 'text-delta' || type === 'reasoning-delta') {
        return typeof c['text'] === 'string' && c['text'].trim() !== '';
    }
    if (type === 'block-start') {
        // 文本 / 推理 / 工具调用的开场不算：真正的证据在它们的增量或收尾块上
        const blockType = c['blockType'];
        return blockType !== 'text' && blockType !== 'reasoning' && blockType !== 'tool-call';
    }
    if (type !== 'block-end') {
        return false;
    }
    const block = c['block'] as { type?: unknown; text?: unknown } | undefined;
    if (block === undefined || block === null || typeof block !== 'object') {
        return false;
    }
    if (block.type === 'tool-call') {
        return false;
    }
    if (block.type === 'text' || block.type === 'reasoning') {
        return typeof block.text === 'string' && block.text.trim() !== '';
    }
    return true;
}

/**
 * 该增量是否构成「这一步有内容」的证据（回合被中断时用来决定要不要合成被中断的回答）。
 *
 * 与 `isVisibleChunk` **不是同一条**：那次判的是"控制锚要不要认它"，**工具调用不算**；
 * 这里判的是"这一步到底有没有产出"，**工具调用算**（有工具调用＝模型确实干过活），
 * 只有空的文本/推理块不算。两条规则各有各的上游依据，别合并。
 *
 * 用途：回合已关闭、而该步**没有定稿助手消息**时，有证据才合成一条带中断标记的回答
 *（正文末尾因此出「已停止」）；没有证据则这一步什么都没产出，不该凭空出一个标记。
 *
 * @param chunk - 原始增量块（形状不可信，故收 unknown）
 */
export function isInterruptionEvidenceChunk(chunk: unknown): boolean {
    if (chunk === null || typeof chunk !== 'object') {
        return false;
    }
    const c = chunk as Record<string, unknown>;
    const type = c['type'];
    if (type === 'text-delta' || type === 'reasoning-delta') {
        return typeof c['text'] === 'string' && c['text'].trim() !== '';
    }
    if (type === 'block-start') {
        // 文本 / 推理的块刚建出来还是空的（证据在它们的增量上）；其余块（工具调用、图片…）建出即算
        const blockType = c['blockType'];
        return blockType !== 'text' && blockType !== 'reasoning';
    }
    if (type === 'tool-call-delta') {
        // 带名字的工具增量已经把 tool-call 块建出来了（参数随后才到）
        return true;
    }
    if (type !== 'block-end') {
        return false;
    }
    const block = c['block'] as { type?: unknown; text?: unknown } | undefined;
    if (block === undefined || block === null || typeof block !== 'object') {
        return false;
    }
    if (block.type === 'text' || block.type === 'reasoning') {
        return typeof block.text === 'string' && block.text.trim() !== '';
    }
    return true;
}

/**
 * 该增量让所在步的块多出哪些事实（**只增不减**：块一旦建出就留在该步里，直到下一步或重试重置）。
 *
 * @param chunk - 原始增量块
 * @returns 该增量贡献的事实（全 false = 这条增量不改判定）
 */
export function chunkBlockFacts(chunk: unknown): ChunkBlockFacts {
    const none: ChunkBlockFacts = { hasReply: false, hasReasoning: false, hasToolCall: false };
    if (chunk === null || typeof chunk !== 'object') {
        return none;
    }
    const c = chunk as Record<string, unknown>;
    const type = c['type'];
    if (type === 'text-delta') {
        return { ...none, hasReply: typeof c['text'] === 'string' && c['text'].trim() !== '' };
    }
    if (type === 'reasoning-delta') {
        return { ...none, hasReasoning: typeof c['text'] === 'string' && c['text'].trim() !== '' };
    }
    if (type === 'block-start') {
        const blockType = c['blockType'];
        if (blockType === 'tool-call') {
            return { ...none, hasToolCall: true };
        }
        if (blockType === 'text' || blockType === 'reasoning') {
            return none;
        }
        // 其余块（图片等）建出来即算回答内容（上游对未知块类型取"可见"）
        return { ...none, hasReply: true };
    }
    if (type !== 'block-end') {
        return none;
    }
    const block = c['block'] as { type?: unknown; text?: unknown } | undefined;
    if (block === undefined || block === null || typeof block !== 'object') {
        return none;
    }
    if (block.type === 'tool-call') {
        return { ...none, hasToolCall: true };
    }
    if (block.type === 'text') {
        return { ...none, hasReply: typeof block.text === 'string' && block.text.trim() !== '' };
    }
    if (block.type === 'reasoning') {
        return { ...none, hasReasoning: typeof block.text === 'string' && block.text.trim() !== '' };
    }
    return { ...none, hasReply: true };
}
