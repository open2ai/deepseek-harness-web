// 回合过程事实（适配上游 0.1.5-rc.2）：回答锚点 / 过程区间 / 控制锚 / 过程外置。
//
// 上游把这件事分成两步：**逐事件累积证据**（过程节点定义）与**回合结束时派生事实**（过程规格 + 呈现投影）。
// 本文件是这两步的镜像 —— 只收条目、只吐事实，不碰行模型与渲染，取值口径集中在这一处。
// 构建器那边只登记「发生了什么」（`TurnProcessEntry`），判定不散落在事件分派里。
//
// 两条与上游同源的硬规则（都踩过）：
//   1. **证据与"已定稿"是两回事**：控制锚取「每步首条**可见**证据」（含目前还不合格的证据，锚点要稳）；
//      而回答锚点要求该步**已定稿** —— 没定稿的步不产生回答，整回合不折叠。
//   2. **结算整条替换、重试重置**：durable 的 `assistant/message`（仅 append）把该步的块**整条换掉**，
//      不是叠加；`llm/retry` 把该步累积的块**清空**。按"只增不减"会让被放弃的半截留在判据里。
import { chunkBlockFacts, isVisibleChunk } from '../official/chunk-facts';
import type { DshTurnProcess } from './types';

/**
 * 合成锚点偏移（镜像上游 `CHAT_SYNTHETIC_SEQ_OFFSETS` 里本插件用到的那一项）。
 * 中断回答在时间线上要落在**关闭边界之前**、其它事件之后，故取负的小数偏移。
 */
const INTERRUPTED_ASSISTANT_OFFSET = -0.9;

/** 一条会**建过程节点**的事件（按到达次序登记；与上游遍历节点同义）。 */
export type TurnProcessEntry =
    /** `step/start`：开一个步（步内状态按 turn+step 归并） */
    | { kind: 'step'; step?: number }
    /** `step/end`：该步的关闭边界（中断回答的合成锚点以它为先，其次才是回合边界） */
    | { kind: 'step-end'; seq?: number; step?: number }
    /** 实时增量帧 / 历史展开的增量 */
    | { kind: 'chunk'; seq?: number; step?: number; chunk: unknown }
    /** durable `assistant/message`（**仅 append** 才登记） */
    | { kind: 'message'; seq?: number; step?: number; hasReply: boolean; hasReasoning: boolean; hasToolCall: boolean }
    /** `llm/retry`：重置该步累积的块，同时算「其它」证据 */
    | { kind: 'retry'; seq?: number; step?: number }
    | { kind: 'tool-call'; seq?: number; step?: number }
    /** `tool/result`（只有 `append` 才算「其它」证据） */
    | { kind: 'tool-result'; seq?: number; append: boolean }
    /** 上下文注入：进过程区间（上游的独立节点类型不含它） */
    | { kind: 'context'; seq?: number }
    /**
     * 本回合的人类消息（用户提问 / 插话）。
     *
     * 只用于 `compactAnswer` 的判据；**不带插话标记** —— 上游那条判据对 user 与 steering
     * 一视同仁（插话分类落在**行**上，见 `rows/inbox-claims.ts`）。
     */
    | { kind: 'human'; seq?: number };

/** 一个回合的过程事实**输入**：构建器只往里登记条目，判定全在本文件。 */
export interface TurnProcessInput {
    /** `turn/start` 的 seq（过程起点的首选；缺失时按上游回退到最早的其它证据） */
    turnStartSeq?: number;
    /** `turn/end` 的 seq：步没有自己的关闭边界时，中断回答以它为基准 */
    turnEndSeq?: number;
    entries: TurnProcessEntry[];
}

export function createTurnProcessInput(): TurnProcessInput {
    return { entries: [] };
}

/** 一个步的块事实（镜像上游步骤节点的状态；只留判据需要的部分）。 */
interface StepFacts {
    hasReply: boolean;
    hasReasoning: boolean;
    hasToolCall: boolean;
    /** 该步首条**可见**证据的 seq */
    firstVisibleSeq?: number;
    /** durable 结算的 seq —— 有它即「已定稿」 */
    settledSeq?: number;
    /** 该步的关闭边界（`step/end` 的 seq） */
    endSeq?: number;
}

interface AnswerFacts {
    seq: number;
    step: number | undefined;
    hasReasoning: boolean;
}

/**
 * 派生一个回合的过程事实。
 * @param input - 该回合登记的过程条目
 * @returns 事实；**没有过程证据时返回 `null`** —— 上游此时根本没有控制条节点，整个呈现都不存在
 */
export function deriveTurnProcess(input: TurnProcessInput): DshTurnProcess | null {
    const steps = new Map<number | undefined, StepFacts>();
    const stepOrder: Array<number | undefined> = [];
    const stepOf = (step: number | undefined): StepFacts => {
        let s = steps.get(step);
        if (s === undefined) {
            s = { hasReply: false, hasReasoning: false, hasToolCall: false };
            steps.set(step, s);
            stepOrder.push(step);
        }
        return s;
    };
    /** 控制锚的另一类证据：工具调用 / 工具结果(append) / 重试 */
    let otherStartSeq: number | undefined;
    /** 非 assistant 步的过程成员（工具 / 上下文 / 重试）：算「过程外置」时按区间筛 */
    const otherMembers: Array<{ seq: number; step: number | undefined; kind: 'tool' | 'context' | 'retry' }> = [];
    /** 本回合的人类消息序号（插话与追加提问都算）：`compactAnswer` 的判据 */
    const humans: number[] = [];

    for (const e of input.entries) {
        switch (e.kind) {
            case 'step':
                stepOf(e.step);
                break;
            case 'step-end': {
                const s = stepOf(e.step);
                if (e.seq !== undefined) {
                    s.endSeq = e.seq;
                }
                break;
            }
            case 'chunk': {
                const s = stepOf(e.step);
                const facts = chunkBlockFacts(e.chunk);
                s.hasReply = s.hasReply || facts.hasReply;
                s.hasReasoning = s.hasReasoning || facts.hasReasoning;
                s.hasToolCall = s.hasToolCall || facts.hasToolCall;
                if (e.seq !== undefined && s.firstVisibleSeq === undefined && isVisibleChunk(e.chunk)) {
                    s.firstVisibleSeq = e.seq;
                }
                break;
            }
            case 'message': {
                const s = stepOf(e.step);
                // 结算**整条替换**该步的块（上游同）
                s.hasReply = e.hasReply;
                s.hasReasoning = e.hasReasoning;
                s.hasToolCall = e.hasToolCall;
                if (e.seq !== undefined) {
                    s.settledSeq = e.seq;
                    if (s.firstVisibleSeq === undefined && (e.hasReply || e.hasReasoning)) {
                        s.firstVisibleSeq = e.seq;
                    }
                }
                break;
            }
            case 'retry': {
                const s = stepOf(e.step);
                // 重试重置该步累积的块（上游同）：被放弃的半截不得留在判据里
                s.hasReply = false;
                s.hasReasoning = false;
                s.hasToolCall = false;
                s.firstVisibleSeq = undefined;
                if (e.seq !== undefined) {
                    otherStartSeq = min(otherStartSeq, e.seq);
                    otherMembers.push({ seq: e.seq, step: e.step, kind: 'retry' });
                }
                break;
            }
            case 'tool-call': {
                if (e.seq !== undefined) {
                    otherStartSeq = min(otherStartSeq, e.seq);
                    otherMembers.push({ seq: e.seq, step: e.step, kind: 'tool' });
                }
                break;
            }
            case 'tool-result': {
                if (e.append) {
                    otherStartSeq = min(otherStartSeq, e.seq);
                }
                break;
            }
            case 'context': {
                if (e.seq !== undefined) {
                    otherMembers.push({ seq: e.seq, step: undefined, kind: 'context' });
                }
                break;
            }
            case 'human': {
                if (e.seq !== undefined) {
                    humans.push(e.seq);
                }
                break;
            }
        }
    }

    // 控制锚 = 两类证据里最早的一个。**包含目前还不合格的证据**（上游注释）——
    // 过程一开始动，控制条就不该跟着往后跳。
    let controlAnchorSeq: number | undefined;
    for (const s of steps.values()) {
        controlAnchorSeq = min(controlAnchorSeq, s.firstVisibleSeq);
    }
    controlAnchorSeq = min(controlAnchorSeq, otherStartSeq);
    if (controlAnchorSeq === undefined) {
        return null;
    }

    const answer = answerOf(steps.get(stepOrder[stepOrder.length - 1]), stepOrder[stepOrder.length - 1], input.turnEndSeq);

    // 「开场人类锚点」= 控制锚**之前**最早的人类消息（没有则 undefined）：回合是怎么被发起的那一条。
    let openingHumanAnchor: number | undefined;
    for (const seq of humans) {
        if (seq < controlAnchorSeq) {
            openingHumanAnchor = min(openingHumanAnchor, seq);
        }
    }
    /**
     * 紧凑回答（上游 `compactAnswer`）：开场锚点之后、回答锚点之前**又出现人类消息** → 假。
     *
     * 含义是「过程区间里有人插了话」，回答就不该被当作紧贴折叠头的那一段（上游据此把间距放宽）。
     * 没有回答锚点时用 `null`：此时任何一条后续人类消息都让它为假（与上游同）。
     */
    const compactAnswerOf = (answerAnchorSeq: number | null): boolean =>
        !humans.some(
            (seq) =>
                (openingHumanAnchor === undefined || seq > openingHumanAnchor) &&
                (answerAnchorSeq === null || seq < answerAnchorSeq)
        );

    if (answer === null) {
        return {
            answerAnchorSeq: null,
            answerStep: null,
            inlineReasoning: false,
            controlAnchorSeq,
            // 上游：没有回答时过程起点就取控制锚
            processStartSeq: controlAnchorSeq,
            hasExternalProcess: false,
            compactAnswer: compactAnswerOf(null),
        };
    }

    // 过程起点：优先回合起点；缺失时取「回答步之前最早的 assistant 证据」与「其它证据」中更早的一个
    const earlierAssistantSeq = min(
        undefined,
        ...[...steps]
            .filter(([step]) => typeof step === 'number' && answer.step !== undefined && step < answer.step)
            .map(([, s]) => s.firstVisibleSeq)
    );
    const externalProcessSeq = min(otherStartSeq, earlierAssistantSeq);
    const processStartSeq = input.turnStartSeq ?? (externalProcessSeq ?? answer.seq);

    // 过程外置 = 区间 [过程起点, 回答锚点) 内、**不是回答步自身**的过程节点。
    // 用节点（工具/上下文/重试各算一个）而不是"还有没有别的 assistant 消息"：漏掉任一类都会让折叠头该出不出的。
    const memberSeqs: Array<{ seq: number; step: number | undefined; assistant: boolean }> = [];
    for (const [step, s] of steps) {
        const anchor = s.settledSeq ?? s.firstVisibleSeq;
        if (anchor !== undefined) {
            memberSeqs.push({ seq: anchor, step, assistant: true });
        }
    }
    for (const m of otherMembers) {
        memberSeqs.push({ seq: m.seq, step: m.step, assistant: false });
    }
    const hasExternalProcess = memberSeqs.some(
        (m) =>
            m.seq >= processStartSeq &&
            m.seq < answer.seq &&
            !(m.assistant && m.step === answer.step)
    );

    return {
        answerAnchorSeq: answer.seq,
        // 步号缺失（历史里偶见）记 null —— 与"没有回答"同形，靠 `answerAnchorSeq` 区分
        answerStep: answer.step ?? null,
        inlineReasoning: answer.hasReasoning,
        controlAnchorSeq,
        processStartSeq,
        hasExternalProcess,
        compactAnswer: compactAnswerOf(answer.seq),
    };
}

/**
 * 该步是否产出「回答」（上游 `latestAnswer` 的四条件：末步 + 已定稿 + 有回答内容 + 不含工具调用）。
 *
 * 「已定稿」有两条路径：durable 结算，或**步/回合已关闭且有中断证据**时合成的中断回答
 * —— 后者是半截回答仍算回答的唯一来源（没有它，被中断的回合永远不折叠）。
 */
function answerOf(s: StepFacts | undefined, step: number | undefined, turnEndSeq: number | undefined): AnswerFacts | null {
    if (s === undefined) {
        return null;
    }
    const boundary = s.endSeq ?? turnEndSeq;
    const settled = s.settledSeq;
    const seq =
        settled ??
        (boundary !== undefined && (s.hasReply || s.hasReasoning || s.hasToolCall)
            ? boundary + INTERRUPTED_ASSISTANT_OFFSET
            : undefined);
    if (seq === undefined || !s.hasReply || s.hasToolCall) {
        return null;
    }
    return { seq, step, hasReasoning: s.hasReasoning };

}

/** 取更小的一个；`undefined` 视为「还没有」。 */
function min(current: number | undefined, ...rest: Array<number | undefined>): number | undefined {
    let out = current;
    for (const v of rest) {
        if (v === undefined) {
            continue;
        }
        out = out === undefined ? v : Math.min(out, v);
    }
    return out;
}
