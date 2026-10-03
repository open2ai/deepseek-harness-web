// ⚠️ CORE-COUPLED（核心耦合；目录名 official，本仓库注释里称“核心”）——只映射上游核心规则，勿混入插件自有逻辑；核心变化只改本目录。
// 上游 0.1.5 起，流式增量不再是独立事件，而是内嵌进结算事件（assistant/message、
// assistant/attempt）的 data.stream。本文件是该载体的展开镜像（适配上游 0.1.7-rc.2）
// 的 expandAssistantStream，把内嵌记录还原成带时刻的增量（第 k 个成员的时刻 = time0 加上前 k 项 dt 之和）。
// 与上游的差异只有一处：上游对不合形状的记录抛错，这里跳过——宿主不能因一条脏记录中断整段历史。

/** 还原后的一条增量（对应上游 TimedStreamChunk）。 */
export interface TimedChunk {
    time: number;
    /** 原始 StreamChunk：'chunk' 记录透传，三类 *-chunks 记录按上游规则重建。 */
    chunk: Record<string, unknown>;
}

/**
 * 展开一条结算事件的 `data.stream`。
 * @param stream - 结算事件的内嵌流（形状不可信，故收 unknown）。
 * @returns 带精确时刻的增量序列；形状不符的记录跳过，不抛错。
 */
export function expandAssistantStream(stream: unknown): TimedChunk[] {
    if (!Array.isArray(stream)) {return [];}
    const out: TimedChunk[] = [];
    for (const candidate of stream) {
        if (candidate === null || typeof candidate !== 'object') {continue;}
        const rec = candidate as Record<string, unknown>;
        const type = rec['type'];
        // 'chunk' 记录自带 time，原样透传（block-end 等非增量块走这条）
        if (type === 'chunk') {
            const time = rec['time'];
            const chunk = rec['chunk'];
            if (typeof time !== 'number' || chunk === null || typeof chunk !== 'object') {continue;}
            out.push({ time, chunk: chunk as Record<string, unknown> });
            continue;
        }
        let deltaType: string | undefined;
        if (type === 'text-chunks') {deltaType = 'text-delta';}
        else if (type === 'reasoning-chunks') {deltaType = 'reasoning-delta';}
        else if (type === 'tool-call-chunks') {deltaType = 'tool-call-delta';}
        if (deltaType === undefined) {continue;}
        const time0 = rec['time0'];
        const index = rec['index'];
        if (typeof time0 !== 'number' || typeof index !== 'number') {continue;}
        const members = Array.isArray(rec['texts'])
            ? (rec['texts'] as unknown[])
            : Array.isArray(rec['args'])
                ? (rec['args'] as unknown[])
                : [];
        if (members.length === 0) {continue;}
        const dt = Array.isArray(rec['dt']) ? (rec['dt'] as unknown[]) : [];
        const name = rec['name'];
        let time = time0;
        for (let k = 0; k < members.length; k += 1) {
            if (k > 0) {
                const gap = dt[k - 1];
                time += typeof gap === 'number' ? gap : 0;
            }
            const member = members[k];
            const text = typeof member === 'string' ? member : '';
            out.push({
                time,
                chunk: deltaType === 'tool-call-delta'
                    ? {
                        type: deltaType,
                        index,
                        id: rec['id'],
                        // 上游只在记录确实带 name 时才产出该字段（Object.hasOwn 语义）
                        ...(typeof name === 'string' ? { name } : {}),
                        argumentsDelta: text,
                    }
                    : { type: deltaType, index, text },
            });
        }
    }
    return out;
}
