// 回合过程事实（适配上游 0.1.7-rc.2）：回答锚点 / 过程区间 / 控制锚 / 过程外置。
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
import { chunkBlockFacts, isVisibleChunk } from '../official/chunk-facts';import type { DshRowGroup, DshTurnProcess } from './types';

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
    /**
     * 一次工具调用。
     *
     * `ask` = 这是一次**提问工具**调用（`ask_user_question` / `request_user_input`）。
     * 它**照常计入"过程外置"**（上游判据只数可见节点，工具节点一律可见）。字段保留仅作事实标注。
     */
    | { kind: 'tool-call'; seq?: number; step?: number; ask?: boolean }
    /** `tool/result`（只有 `append` 才算「其它」证据） */
    | { kind: 'tool-result'; seq?: number; append: boolean }
    /**
     * 上下文注入：进过程区间（上游的独立节点类型不含它）。
     *
     * `visible` = 这条注入在链上真的会显示（只有含**工具增删块**的才留一行）。
     * **只有可见的才算"过程外置"**，否则"只有提问 + 一条被隐藏的注入"的回合会被误判成有过程内容。
     */
    | { kind: 'context'; seq?: number; visible?: boolean }
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

/**
 * 这条增量是否会**在链上留下可见的思考行**（推理有正文的那种增量）。
 *
 * 与 `isVisibleChunk` 的区别：这里**只认推理**（`reasoning-delta` 有正文 / `block-end` 的推理块有正文），
 * 工具调用与图片不算 —— 它服务于 `inlineReasoning`（"回答步自带推理"这一门）。
 *
 * @param chunk - 原始增量块。
 */
function hasReasoningChunk(chunk: unknown): boolean {
    if (chunk === null || typeof chunk !== 'object') {
        return false;
    }
    const c = chunk as { type?: unknown; text?: unknown; block?: { type?: unknown; text?: unknown } };
    if (c.type === 'reasoning-delta') {
        return typeof c.text === 'string' && c.text.trim() !== '';
    }
    if (c.type === 'block-end') {
        const block = c.block;
        return (
            block !== undefined &&
            block !== null &&
            block.type === 'reasoning' &&
            typeof block.text === 'string' &&
            block.text.trim() !== ''
        );
    }
    return false;
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
    /**
     * 非 assistant 步的过程成员（工具 / 上下文 / 重试）：算「过程外置」时按区间筛。
     * `ask` = 提问工具调用，照常计入（仅作事实标注）。
     */
    const otherMembers: Array<{ seq: number; step: number | undefined; kind: 'tool' | 'context' | 'retry'; ask?: boolean }> = [];
    /** 本回合的人类消息序号（插话与追加提问都算）：`compactAnswer` 与插话判据共用 */
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
                    // 提问调用与别的工具一样计入（上游对 `tool/call` 一视同仁），并推进"过程起点"
                    otherMembers.push({ seq: e.seq, step: e.step, kind: 'tool' });
                    otherStartSeq = min(otherStartSeq, e.seq);
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
                // **只有会显示的注入**才算候选，且**不推进过程起点**：被隐藏的注入在屏幕上是空的，
                // 算进去会让"只有提问"的回合被误判成有过程内容。
                if (e.seq !== undefined && e.visible !== false) {
                    otherMembers.push({ seq: e.seq, step: undefined, kind: 'context' });
                    otherStartSeq = min(otherStartSeq, e.seq);
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

    /**
     * **过程区间里有没有"被插进来的话"**（上游 `hasInterleavedInput`）：与上面的 `compactAnswer`
     * 共用判据，只是**不设回答锚点上界**。上游 `turnProcessAlwaysOpen()` 的一项 —— 有插话就不许折。
     */
    const hasInterleavedInput = humans.some(
        (seq) => openingHumanAnchor === undefined || seq > openingHumanAnchor
    );

    const memberSeqs: Array<{ seq: number; step: number | undefined; assistant: boolean; ask?: boolean }> = [];
    for (const [step, s] of steps) {
        const anchor = s.settledSeq ?? s.firstVisibleSeq;
        if (anchor === undefined) {
            continue;
        }
        if (!s.hasReply && !s.hasReasoning) {
            continue;
        }
        memberSeqs.push({ seq: anchor, step, assistant: true });
    }
    for (const m of otherMembers) {
        memberSeqs.push({ seq: m.seq, step: m.step, assistant: false });
    }
    /**
     * 该步的推理**会不会在链上留下思考行**：`inlineReasoning` 只有"真的留下思考行"时才算可折内容
     * （上游那一路还有 `processMember` 这一门，这里用"链上真有思考行"等价替代）。
     *
     * @param step - 目标步。
     */
    const stepHasVisibleReasoning = (step: number | undefined): boolean =>
        step !== undefined && input.entries.some((e) => e.kind === 'chunk' && e.step === step && hasReasoningChunk(e.chunk));

    /**
     * **过程分组的收口循环**（两条路共用：这一轮有定稿回答 / 没有）。
     *
     * 上游在遇到「带回答内容的步」时收口，该步自身成为一个独立可见节点；插件把中间步的文本留在链里
     * （`12` §1.5 的适配），所以这里只产出**分界**：每一片 = 上一次收口之后到这一次收口之间的一段过程。
     * 片级事实与回合级**同一套判据**（`memberSeqs` / `compactAnswerOf` / 定稿口径），只是区间换成片内。
     *
     * @param fromSeq - 第一片的起点（回合起点；没有回答时取控制锚 —— 上游同）。
     * @param stopStep - 收到这一步为止（回答步本身不单独成片，它的正文就是行的正文）；`undefined` = 全扫。
     */
    const buildGroups = (fromSeq: number, stopStep: number | undefined): DshRowGroup[] => {
        const out: DshRowGroup[] = [];
        let from = fromSeq;
        let fromStep: number | null = null;
        for (const step of stepOrder) {
            if (step === undefined || (stopStep !== undefined && step >= stopStep)) {
                break;
            }
            const s = steps.get(step);
            if (s === undefined || !s.hasReply) {
                continue;
            }
            const anchor = s.settledSeq ?? s.firstVisibleSeq;
            if (anchor === undefined) {
                continue;
            }
            out.push({
                key: `s${String(fromStep ?? step)}-${String(step)}@${String(anchor)}`,
                fromStep,
                toStep: step,
                facts: {
                    answerAnchorSeq: anchor,
                    answerStep: step,
                    inlineReasoning: s.hasReasoning && stepHasVisibleReasoning(step),
                    turnStarted: input.turnStartSeq !== undefined,
                    controlAnchorSeq,
                    processStartSeq: from,
                    hasExternalProcess: memberSeqs.some(
                        // 与回合级**同一判据**（提问也包括，见上面成员构造的注释）
                        (m) => m.seq >= from && m.seq < anchor && !(m.assistant && m.step === step)
                    ),
                    compactAnswer: compactAnswerOf(anchor),
                },
            });
            from = anchor;
            fromStep = step;
        }
        return out;
    };

    if (answer === null) {
        // ⚠️ **没有定稿回答的回合也要产出分组**：上游对"无回答"没有特例（同一句注释见下面 `inlineReasoning`
        // 那行）——「该步产出回答文本就收口」与"这一轮最终有没有定稿回答"无关。先前这里直接 return，
        // 于是整回合一个组都不出 → 页面退回"整回合单头"（真机对照：网页端有「已完成分析」，插件没有）。
        const bareGroups = buildGroups(controlAnchorSeq, undefined);
        return {
            answerAnchorSeq: null,
            answerStep: null,
            // ⚠️ **没有回答也要按可见过程成员算**（上游 `derivePresentation` 没有"无回答"特例）。
            // 写死 false 会让"只有思考/提问、没有回答"的回合（被终止的那种）在折起态**没有摘要行**，
            // 而 web 端有一条 `已完成分析` —— 真机对照图就是这么暴露的。
            inlineReasoning: memberSeqs.some((m) => m.assistant && stepHasVisibleReasoning(m.step)),
            turnStarted: input.turnStartSeq !== undefined,
            controlAnchorSeq,
            // 上游：没有回答时过程起点就取控制锚
            processStartSeq: controlAnchorSeq,
            hasExternalProcess: memberSeqs.some((m) => !m.assistant),
            hasInterleavedInput,
            compactAnswer: compactAnswerOf(null),
            ...(bareGroups.length === 0 ? {} : { groups: bareGroups }),
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
    /** 回答步的推理是否会在链上留下思考行。 */
    const answerHasVisibleReasoning = stepHasVisibleReasoning(answer.step ?? undefined);
    const hasExternalProcess = memberSeqs.some(
        (m) =>
            m.seq >= processStartSeq &&
            m.seq < answer.seq &&
            !(m.assistant && m.step === answer.step)
    );

    /**
     * **过程分组**（上游 step-group）：上游在遇到「带回答内容的步」（`reply()`）时收口，
     * 该步自身成为一个独立可见节点；插件把中间步的文本留在链里（`12` §1.5 的适配），
     * 所以这里只产出**分界**：每一片 = 上一次收口之后到这一次收口之间的一段过程。
     *
     * 片的判据与回合级**完全同一套**（`memberSeqs` / `compactAnswerOf` / 定稿口径），只是区间换成片内：
     *   · 片的回答锚点 = 收口那一步的定稿序号（缺则首条可见证据）；
     *   · 片的 `hasExternalProcess` = 片区间内除收口步外还有别的过程成员；
     *   · 片的 `inlineReasoning` = 收口那一步自带推理。
     * **回答步本身不单独成片**（它的正文就是行的正文），故循环在 `answer.step` 处收住。
     */
    // 兜底再归一化一次：`answer.step` 只该是数字或 `undefined`（`null` 在上游 `answerOf` 已归一），
    // 这里按"非数字即未知"处理 —— 未知就**不收口**，照常按步扫下去。
    const groups = buildGroups(processStartSeq, typeof answer.step === 'number' ? answer.step : undefined);

    return {
        answerAnchorSeq: answer.seq,
        // 步号缺失（历史里偶见）记 null —— 与"没有回答"同形，靠 `answerAnchorSeq` 区分
        answerStep: answer.step ?? null,
        inlineReasoning: answer.hasReasoning && answerHasVisibleReasoning,
        turnStarted: input.turnStartSeq !== undefined,
        controlAnchorSeq,
        processStartSeq,
        hasExternalProcess,
        hasInterleavedInput,
        compactAnswer: compactAnswerOf(answer.seq),
        // **只在真有分组时才带上这个键**：单步回合（最常见）保持与既有完全一致的载荷，
        // 免得几十套逐字节比对的行守卫因为多一个空数组而全红。
        ...(groups.length === 0 ? {} : { groups }),
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
    // ⚠️ **`null` 要当成"步号未知"**：历史/持久化载荷里"步号缺失"落成的是 `null`，
    // 而 `null !== undefined` 为真、`step >= null` 又恒为真 —— 下游（分组的收口循环）会因此在
    // 第 0 步就 break、整回合一个组都不出（真机现象：本该有两片却只剩"整回合单头"）。
    const stepNo = typeof step === 'number' ? step : undefined;
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
    return { seq, step: stepNo, hasReasoning: s.hasReasoning };

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

/**
 * **按行过滤过程分组**（2026-10-02 · `14` §6.3 的 (a)）。
 *
 * 问题：宿主在回合收官时把整回合的 `processFacts`（含 `groups`）写给本回合**每一条**回答行，
 * 而每条行只持有自己那截链（插话/中断把回合切成多段）—— 于是"别的段"那些组的步号区间在这截链里
 * **一个项都收不到**，页面侧切片会因此对不上、整条退回整回合单头（实测 30 会话 199 条带 `groups`
 * 的行里，13 条这样）。
 *
 * 做法：只把"与该行链的步号跨度**相交**"的组发给它。**相交判据用闭区间**（`[fromStep, toStep]`
 * 与链步号区间有交集）：因为页面侧的归片口径是 `(fromStep, toStep]`、缝里的项还会就近归片，
 * 用半开区间会把只差一个端点的组误丢。
 *
 * 过滤后**一个组都不剩**时返回 `undefined` —— 调用方据此**不带 `groups` 键**，该行走既有的
 * "整回合一条头"路径（绝不半新半旧）。
 *
 * @param groups - 回合级的过程分组。
 * @param chainSteps - 该行链上出现过的步号（升序、去重都行；空数组 = 这一行没有步号事实）。
 * @returns 该行该拿到的组（原对象、不复制）；一个都没有时 `undefined`。
 */
export function filterGroupsForChain(
    groups: readonly DshRowGroup[],
    chainSteps: readonly number[],
    answerStep?: number | null
): DshRowGroup[] | undefined {
    if (groups.length === 0) {
        return undefined;
    }
    if (chainSteps.length === 0) {
        // 该行链上没有步号事实（空链 / 旧形状）：保留整份，交由页面侧的口径去判
        return [...groups];
    }
    // ⚠️ 不要命名成 `min`/`max`：本文件底部那个 `min()` 是**函数**，同名会遮蔽它（读起来像 bug）。
    let lowest = chainSteps[0] as number;
    let highest = lowest;
    for (const step of chainSteps) {
        if (step < lowest) {
            lowest = step;
        }
        if (step > highest) {
            highest = step;
        }
    }
    const kept = groups.filter((group) => {
        const from = group.fromStep ?? Number.NEGATIVE_INFINITY;
        const to = group.toStep ?? Number.POSITIVE_INFINITY;
        // ① 与本行链的步号跨度相交（否则这片在这截链里一个项都收不到）；
        // ② 收口步**不晚于本行的回答世代**（超出的那些组是别的段收口的，发给本行只会造成
        //    "组数 == 片数"对不上 —— 实测：`toStep > answerStep` 的组正是让这 13 行整条作废的那一批）；
        //    行/回合缺 `answerStep` 时这一条不生效（保留）。
        const withinGeneration = typeof answerStep !== 'number' || to <= answerStep;
        return to >= lowest && from <= highest && withinGeneration;
    });
    return kept.length === 0 ? undefined : kept;
}
