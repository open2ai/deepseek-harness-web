// 实时增量帧（`assistant-stream`）的**连续性判据**（纯函数，适配上游 0.1.5-rc.2）。
//
// 为什么单独成模块：这条判据一旦判错，代价是「重开订阅 + 整窗替换 + 全量重折」——
// 观感上就是"卡一下、然后内容一下刷出来"。而它的正确形状**只有对着上游的 `ClientAssistantStream`
// 才说得清**（见下），所以它必须能被脚本直接喂帧驱动（`tmp/_stream.continuity.test.mjs`），
// 而不是埋在 `dshService` 的私有方法里靠真机试。
//
// 上游的形状（`session-controller/src/client/sessions/assistant-stream.ts`）：
//   · 它**不校验 `revision`**。订阅是**中途**打开的，服务端只为当前订阅者广播之后的帧，
//     「快照 revision」与「第一帧 revision」之间差几帧是**常态**，不是丢帧的证据。
//   · 它的连续性判据只有两条：`attemptId` 对得上，且 `frame.index` 等于「期望的下一个块号」。
//   · `chunk` / `end` 若**没有**对应的活跃尝试（或 attemptId 不符）→ **静默忽略**，
//     不是 rebaseline：那正是"订阅后挂上、错过了 start 帧"的正常情形。
//   · `start` 到来时若上一个尝试还没收尾 → rebaseline（服务端基线才说得清当前状态）。
import type { DshStreamEvent } from './rows/types';

/** 连续性状态：进行中尝试的标识 + 下一个期望的块号。 */
export interface AssistantStreamContinuity {
    /** 进行中尝试的标识（`start` 帧给，`end` 帧清）。 */
    attemptId: string | undefined;
    /** 下一个**期望**的块序号（`start` 置 0，每个 `chunk` +1）。 */
    nextIndex: number;
    /** 最近一帧的版本号：**只记不判**（诊断日志用，理由见文件头）。 */
    revision: number | undefined;
}

/** 一帧的判定结果。 */
export type AssistantStreamVerdict =
    /** 该帧入列。 */
    | { action: 'accept'; state: AssistantStreamContinuity }
    /** 该帧丢弃，但**不**重开订阅（错过了 start 的尾巴，等下一个 start）。 */
    | { action: 'drop'; state: AssistantStreamContinuity }
    /** 增量链断了：重开订阅要一份新的「窗口 + 基线」原子对。 */
    | { action: 'rebaseline'; reason: string; state: AssistantStreamContinuity };

/** 空状态（还没见过任何帧）。 */
export function initialContinuity(): AssistantStreamContinuity {
    return { attemptId: undefined, nextIndex: 0, revision: undefined };
}

/**
 * 判一帧。
 * @param state - 当前状态
 * @param frame - `assistant-stream` 帧的 `frame` 载荷（形状不认时按入列处理，交给行构建判）
 * @returns 动作与下一个状态
 */
export function judgeAssistantFrame(
    state: AssistantStreamContinuity,
    frame: Record<string, unknown> | undefined
): AssistantStreamVerdict {
    if (frame === undefined) {
        return { action: 'accept', state };
    }
    const revision = typeof frame['revision'] === 'number' ? (frame['revision'] as number) : undefined;
    // 版本号只记不判：订阅中途打开时它与快照对不上是常态，拿它当判据会让每次重连都白重开一次
    const next: AssistantStreamContinuity = revision === undefined ? state : { ...state, revision };
    const kind = frame['type'];
    const attemptId = typeof frame['attemptId'] === 'string' ? (frame['attemptId'] as string) : undefined;
    const index = typeof frame['index'] === 'number' ? (frame['index'] as number) : undefined;

    if (kind === 'start') {
        // 上一个尝试没收尾就又开一个：只有服务端侧的基线能说清当前状态（上游同判据）
        if (state.attemptId !== undefined) {
            return { action: 'rebaseline', reason: '上一个尝试未收尾就又开新尝试', state: next };
        }
        return { action: 'accept', state: { ...next, attemptId, nextIndex: 0 } };
    }
    if (kind !== 'chunk' && kind !== 'end') {
        return { action: 'accept', state: next };
    }
    // 没有 start 就来的帧（订阅是后挂上的）：**丢掉即可**，等下一个 start —— 与上游同一处理
    if (state.attemptId === undefined || attemptId === undefined || attemptId !== state.attemptId) {
        return { action: 'drop', state: next };
    }
    if (index !== undefined && index !== state.nextIndex) {
        return { action: 'rebaseline', reason: '增量块缺号', state: next };
    }
    if (kind === 'chunk') {
        return { action: 'accept', state: { ...next, nextIndex: state.nextIndex + 1 } };
    }
    // end：尝试收尾（放弃与否由行构建按 outcome 处理）
    return { action: 'accept', state: { ...next, attemptId: undefined, nextIndex: 0 } };
}

/** 从事件里取 `assistant-stream` 的 `frame` 载荷（其余事件返回 undefined）。 */
export function frameOfEvent(event: DshStreamEvent): Record<string, unknown> | undefined {
    return event.type === 'assistant-stream' ? event.frame : undefined;
}
