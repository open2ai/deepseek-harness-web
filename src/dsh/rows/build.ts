// 事件流的行构建（适配上游 0.1.7-rc.2）：把事件序列归约成**行模型**。
//
// 为什么放在宿主（见 docs/design/08 §9）：
//   - 解包（三层嵌套 / 结果文本展平 / 退出码 / 上下文投影）只此一份，就在本层（`official/`）；
//   - 认领（提交标识 ↔ 服务端回显）也在这层 —— 认领操作的就是行模型，同侧才不用跨层传标识；
//   - 历史重建与实时因此能共用同一个构建器，两条链合并。
// 纯函数：输入事件数组、输出行数组，不依赖宿主进程状态，便于脚本级验证。
import { contextForm, contextProvenance, isContextMessage } from '../official/context-projection';
import { deriveTurnFacts, deriveTurnTokenUsage, type TurnLikeEvent } from '../official/turn-stats';
import { parseExitStatus } from '../official/exit-status';
import { fileRefsOf, hasImageBlock, imageRefsOf, readToolResult, resultText, textOnly } from '../official/result-text';
import { readSystemPrompt } from '../official/system-prompt';
import { toolStatusOf } from '../official/tool-status';
import { turnEndFailure, type DshTurnFailure } from '../official/turn-end';
import { createTurnProcessInput, deriveTurnProcess, filterGroupsForChain } from './turn-process';
import { createInboxClaimFold } from './inbox-claims';
import { todoItemsOf } from './todos';
import type { DshPresentedFile, DshRowItem, DshStreamEvent, DshStreamRow, DshTodoItem } from './types';
type AssistantRow = Extract<DshStreamRow, { kind: 'assistant' }>;

/** 非空字符串取值（空串按缺省处理，与既有通路的同义 helper 一致）。 */
function stringOf(v: unknown): string | undefined {
    return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 从 content 块数组里取纯文本（只认 text 块；其余忽略）。 */
function contentText(content: unknown): string {
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
            ? String((b as { text?: unknown }).text ?? '')
            : ''))
        .join('');
}

/**
 * 这条**上下文注入**在聊天区里会不会显示出来（内容里有工具增删块才留一行）。
 *
 * 与页面侧 `webview/chat/core/chat-visibility.ts` 的 `hasToolChangeBlock()` **同一判据**
 * （刻意的两处实现：宿主构建时不依赖 webview 模块图 —— 那是另一套 bundle）。
 * 两处必须同改；上游依据：`isVisibleChatNode` 把普通 `context` 节点排除
 * （`node.kind !== 'context'`），只有带工具增删块的那条在本插件里会渲染成"工具变更通知行"。
 *
 * @param content - 内容块数组（坏形认不出 → 不算）。
 */
function hasToolChangeBlocks(content: readonly unknown[]): boolean {
    return content.some((block) => {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) {
            return false;
        }
        const type = (block as { type?: unknown }).type;
        return type === 'tool-addition' || type === 'tool-removal';
    });
}

/**
 * 从 `user/message` 事件里认出**压缩检查点**（自动压缩把被压掉的那段历史替换成一条摘要消息）。
 *
 * 判据 = `surfaceOp` 是 **replace 型**（不是 `append`）+ 源里带 `compactionId`。两种源形状都收：
 *   · `{ kind: 'plugin', plugin: 'compact', compactionId }` —— **本机 0.2.0-rc.2 的真实日志形状**；
 *   · `{ kind: 'compact-checkpoint', compactionId }` —— 上游 `compactCheckpointSource()` 的构造（读上游代码时以它为准）。
 * 两者都表示同一件事，不认会导致这条上万字的摘要被当成用户消息/普通注入。
 *
 * `sourceCommandId` 一并带出：**带它的检查点归手动压缩命令**（上游把这类事件判给 `command` 节点）。
 *
 * @param event - 候选事件。
 * @returns 事务标识与（可能有的）发起命令；不是检查点则 undefined。
 */
function compactionCheckpoint(event: { type: string; surfaceOp?: unknown; data?: Record<string, unknown> }): {
    compactionId: string;
    sourceCommandId?: string;
} | undefined {
    if (event.type !== 'user/message') {
        return undefined;
    }
    const op = event.surfaceOp;
    if (op === undefined || op === 'append') {
        return undefined;
    }
    const source = event.data?.['source'];
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
        return undefined;
    }
    const record = source as { kind?: unknown; plugin?: unknown; compactionId?: unknown; sourceCommandId?: unknown };
    const isCheckpoint = record.kind === 'compact-checkpoint' || (record.kind === 'plugin' && record.plugin === 'compact');
    if (!isCheckpoint || typeof record.compactionId !== 'string' || record.compactionId === '') {
        return undefined;
    }
    return {
        compactionId: record.compactionId,
        ...(typeof record.sourceCommandId === 'string' ? { sourceCommandId: record.sourceCommandId } : {}),
    };
}

/**
 * 从 `compaction/summary.data` 取呈现要的事实（上游 `compactSummary` 同口径）：
 * 摘要 = `summary` 里 text 块拼接后 trim（全空 → 不带，即"不可展开"）；
 * 条目数 = `shadowedSeqs.length`（**须全为非负安全整数**，否则不带）；token 数须为非负安全整数。
 *
 * @param d - `compaction/summary` 的 data。
 */
function compactionSummaryFacts(d: Record<string, unknown>): {
    summary?: string;
    shadowedItemCount?: number;
    shadowedTokenCount?: number;
} {
    const blocks = d['summary'];
    let summary: string | undefined;
    if (Array.isArray(blocks)) {
        const text = blocks
            .map((b) => (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? ((b as { text: string }).text) : ''))
            .join('');
        if (text.trim() !== '') {
            summary = text;
        }
    }
    const shadowedSeqs = Array.isArray(d['shadowedSeqs']) ? d['shadowedSeqs'] : undefined;
    const seqsOk = shadowedSeqs !== undefined && shadowedSeqs.every((s) => Number.isSafeInteger(s) && (s as number) >= 0);
    const tokens = d['shadowedTokenCount'];
    const tokensOk = Number.isSafeInteger(tokens) && (tokens as number) >= 0;
    return {
        ...(summary === undefined ? {} : { summary }),
        ...(seqsOk ? { shadowedItemCount: (shadowedSeqs as unknown[]).length } : {}),
        ...(tokensOk ? { shadowedTokenCount: tokens as number } : {}),
    };
}

/**
 * 从 `llm/retry.data.failure` 取重试行展开区要的两项（`message` / `code`）；都没有就不带。
 *
 * 中文不在这里选：`code` → 本地化由页面按上游 `failureMessage()` 的口径决议（同终局通知行）。
 * @param raw - `failure` 原文。
 */
function retryFailure(raw: unknown): { message?: string; code?: string } | undefined {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const record = raw as { message?: unknown; code?: unknown };
    const message = typeof record.message === 'string' ? record.message : undefined;
    const code = typeof record.code === 'string' ? record.code : undefined;
    if (message === undefined && code === undefined) {
        return undefined;
    }
    return { ...(message === undefined ? {} : { message }), ...(code === undefined ? {} : { code }) };
}

/**
 * 内容块分类：折叠判定看的是**块**（与上游同口径），不是事件类型 ——
 * 「有回答内容」= 存在非推理、非工具、非空白文本的块；「含工具调用」会让该步**不算回答**。
 */
function blockFacts(content: unknown): { hasReply: boolean; hasToolCall: boolean; hasReasoning: boolean } {
    let hasReply = false;
    let hasToolCall = false;
    let hasReasoning = false;
    if (!Array.isArray(content)) {
        return { hasReply, hasToolCall, hasReasoning };
    }
    for (const block of content) {
        const b = block as { type?: unknown; text?: unknown } | null | undefined;
        const kind = b?.type;
        if (kind === 'tool-call') {
            hasToolCall = true;
        } else if (kind === 'reasoning') {
            if (typeof b?.text === 'string' && b.text.trim() !== '') {
                hasReasoning = true;
            }
        } else if (kind === 'text') {
            if (typeof b?.text === 'string' && b.text.trim() !== '') {
                hasReply = true;
            }
        } else if (kind !== undefined) {
            // 其余块（图片等）也算回答内容 —— 上游「非推理、非工具、非空白文本」同口径
            hasReply = true;
        }
    }
    return { hasReply, hasToolCall, hasReasoning };
}

/**
 * 增量折叠的断点：**一个已收官回合的边界**处的折叠状态。
 *
 * 为什么需要它：行是整表下发的，一次构建要遍历**整个事件窗口**。一个 48 回合的会话窗口里有上百万条
 * 事件（其中 99% 是流式增量块），全量重折实测 **600ms+**（`tmp/_buildrows.budget.probe.mjs`），
 * 而流式期间每几十毫秒就来一批新事件 —— 跟不上时正文就停在那里，等回合结束一次性刷出来
 * （真机现象：「快到最后字不出了，然后一下刷出很多」）。
 *
 * 断点取在 `turn/start`，因为那里**只有一个变量跨回合存活**（见下方 `resumed` 分支的注释），
 * 其余状态都被 `turn/start` 就地重置；于是「前缀折到断点 + 只重折这一回合」与「从零全量重折」
 * 逐字节等价（由 `tmp/_rows.checkpoint.probe.mjs` 在真实会话的每个回合上逐轮核对）。
 */
export interface RowsFoldCheckpoint {
    /** 断点位置：`events[tailStart]` 必须是那个 `turn/start`。 */
    tailStart: number;
    /** 该断点处**窗口的首个事件序号**：历史前插会让下标整体后移，对不上即作废。 */
    windowHeadSeq: number | undefined;
    /** 该断点处的**窗口条数**：窗口变短（替换/裁掉）时 `tailStart` 会落到别处，条数兜住这一路。 */
    windowLen: number;
    /** 断点前已定稿的行（原样复用）。 */
    rows: readonly DshStreamRow[];
    /** 下一个可用的行/链项 key（必须延续，否则页面按 key 复用 DOM 会串行）。 */
    nextKey: number;
    /** 跨回合的两个读数：`openAssistant` 给新行写 `turn`，`step` 用作过程成员定位的兜底。 */
    currentTurn: number | undefined;
    currentStep: number | undefined;
    /** 前缀里「用户行 key → 它属于哪个回合」：系统提示词按回合认位要用（行模型不带这个字段）。 */
    userTurns: ReadonlyArray<readonly [number, number | undefined]>;
    /**
     * **跨批次的配对表**（`commandId` / `compactionId` / `retryId` → 行下标）。
     *
     * 为什么必须进断点：一次「用户命令」（`/plan`、`/compact`…）的 `command/run` 与 `command/done`
     * **可以隔着一个回合边界** —— 真实日志里 run 落在 `turn/end` 之后、done 落在下一个 `turn/start`
     * 之后。断点正好建在那个 `turn/start` 上，于是 run 被封进前缀、done 在新批次里找不到它，
     * 结果**同一个命令出两行**（`plan ｜ 执行中…` 与 `指令 ｜ …`）。三个表同理。
     *
     * 下标语义：恢复时 `rows` 由 `[...checkpoint.rows]` 起头，前缀部分的位置不变，所以下标直接可用。
     */
    commandRowAt: ReadonlyArray<readonly [string, number]>;
    compactionRowAt: ReadonlyArray<readonly [string, number]>;
    retryRowAt: ReadonlyArray<readonly [string, number]>;
    /** 摘要先于检查点到达时的暂存（同上，跨批次也要活下来）。 */
    pendingCompactionSummary: ReadonlyArray<
        readonly [string, { summaryEventSeq?: number; summary?: string; shadowedItemCount?: number; shadowedTokenCount?: number }]
    >;
    /** 最近一次 `todo/write` 落盘的清单（todo 卡 diff 基线；跨回合、跨批次都要活下来）。 */
    lastTodoWrite: DshTodoItem[] | null;
}

/** 增量折叠的产物：行 + 下一次可用的断点。 */
export interface RowsFoldResult {
    rows: DshStreamRow[];
    /** 本次构建到达的最后一个**已收官回合**边界；`undefined` = 这一段还没有可用的断点。 */
    checkpoint: RowsFoldCheckpoint | undefined;
}

export interface BuildRowsOptions {
    /** 上一轮的断点；给定时只重折它之后的事件。 */
    checkpoint?: RowsFoldCheckpoint;
    /**
     * 是否校验断点（默认开）。
     *
     * 校验方式是最强的那个：**同时**跑一次全量重折并逐字节比对，不一致就以全量结果为准并丢弃断点。
     * 这不便宜（一次全量 = 几百毫秒），所以按轮次抽样（见调用方），把「断点折叠与全量折叠不等价」
     * 这类问题在真实会话里**自动发现并自愈**，而不是让正文悄悄错一段。
     */
    verify?: boolean;
}

/** 把事件序列归约为行。语义与既有实时通路一致：正文增量累加、结算事件整条覆盖；思考同 step+index 续接。 */
export function buildRows(events: readonly DshStreamEvent[]): DshStreamRow[] {
    return buildRowsIncremental(events).rows;
}

/**
 * 增量折叠：在上一轮的断点上继续，只重折断点之后的这一段。
 *
 * 与 `buildRows`（从零全量）**必须等价** —— 调用方拿到的行是页面唯一真相，
 * 「前缀用记忆、尾巴重折」只是省掉重复劳动，不改变任何判据。
 * @param events - 当前窗口的全部事件（按下标递增；历史前插会让断点失效，此时自动退回全量）
 * @param options - 断点与校验开关，见 `BuildRowsOptions`
 * @returns 行与本次到达的新断点
 */
export function buildRowsIncremental(
    events: readonly DshStreamEvent[],
    options: BuildRowsOptions = {}
): RowsFoldResult {
    const prev = options.checkpoint;
    // 断点可用性：① 那个位置确实还是一个 `turn/start`；② 窗口首事件没换过（前插会让下标错位）；
    //              ③ 窗口不比断点时更短（替换/截断会让同一个下标指到别的事件上）
    const at = prev?.tailStart;
    const usable =
        prev !== undefined &&
        at !== undefined &&
        at < events.length &&
        events[at]?.type === 'turn/start' &&
        events[0]?.seq === prev.windowHeadSeq &&
        events.length >= prev.windowLen;
    const rows: DshStreamRow[] = [];
    let key = 1;
    /** 当前未定稿的回答行下标；-1 = 没有在跑的回合 */
    let active = -1;
    /** 活跃 attempt 所在步：**只有 start 帧带 step**，增量帧没有 —— 不缓存则同一次推理的增量各成一段 */
    let liveStep: number | undefined;
    /** 当前 `row.text` 里装的是**哪一步**的正文（见 applyChunk：正文按步累积，跨步不接） */
    let liveTextStep: number | undefined;
    /**
     * 最近一次「带步号的事件」说的是哪一步（`step/start` / 增量块 / 工具调用都会带）。
     *
     * 给**不带步号的过程成员**定位用：上下文注入（`user/message` with `source !== 'user'`）自己不带
     * `step`，只有这个读数能让它落进**发生的那一步**。没有它，`reorderChainByStep` 会把注入当成
     * 「无步号项」排到**所有已知步之后** —— 真机现象就是「工具行上下文注入跑到下面去了」。
     */
    let currentStep: number | undefined;
    /** 当前回合号（随 `turn/start` 推进）：用户行靠它认领所属回合 */
    let currentTurn: number | undefined;
    /** 用户行 key → 所属回合。系统提示词要落在**它那一回合**的用户行之前 ——
     *  不能用「最近一条用户行」代替：历史恢复时事件顺序与实时不同，那会把多条提示词堆到同一处。 */
    const userTurn = new Map<number, number | undefined>();
    /** 本轮 assistant 消息摘要（按到达顺序）：算回答锚点与过程区间用 */
    let turnMessages: Array<{ seq: number | undefined; step: number | undefined; hasReply: boolean; hasToolCall: boolean; hasReasoning: boolean }> = [];
    /**
     * 本回合的过程事实**输入**：这里只登记「发生了什么」（条目），判定全在 `turn-process.ts`。
     * 分开的理由与上游一致 —— 事件分派只负责"哪些事件建过程节点"，取值口径集中在一处，
     * 加一类证据只动那一处。
     */
    let processInput = createTurnProcessInput();
    /**
     * 收件箱折叠（**整个窗口共用**，不随回合重置）：插话的分类依据是收件箱的 splice 史，
     * 它跨回合存在（一条插话属于当前回合，但它进的是 next-step 收件箱）。
     */
    const inboxFold = createInboxClaimFold();
    /** 本回合起始序号（turn/start 的 seq） */
    let turnStartSeq: number | undefined;
    /** 本回合各步的文本：回合结束时定哪条是回答（正文）、其余进过程链 */
    const stepTexts = new Map<number | undefined, string>();
    /** 已经**固定到链上**的步 → 它那条文本项的 key（"还在链上"的**证据**，不是"曾经插过"的标记） */
    const appendedStepText = new Map<number | undefined, number>();
    /** 已到步边界、但**本步工具还没落链**因而暂缓定稿的步（工具一到即补插，见 `flushSettledStepText`） */
    const settledStepText = new Set<number | undefined>();
    /** 本回合各步在链上的**首个**项下标（只记第一次）：步骤文本据此插到**本步块首** */
    const stepFirstChainIdx = new Map<number | undefined, number>();
    /** 本回合各步在链上的**末个**项下标：下一条文本要插在「上一步的块尾」之后 */
    const stepLastChainIdx = new Map<number | undefined, number>();
    /** 步的出现次序（本回合内）：文本定位时用来找「上一步」 */
    const stepOrder: Array<number | undefined> = [];
    /** 记下某步的链项位置（首项只记第一次，末项每次更新）。 */
    const noteChainStep = (step: number | undefined, at: number): void => {
        if (!stepFirstChainIdx.has(step)) {
            stepFirstChainIdx.set(step, at);
            stepOrder.push(step);
        }
        stepLastChainIdx.set(step, at);
    };
    /**
     * 步骤文本该插在链的哪个下标：**本步块的起点** = 上一步块的末尾之后（本步是本回合的第一步时插到最前）。
     *
     * 判据用「上一步的块尾」而不是「本步自己的首项」，也不用「第一个属于本步的工具项」：
     *   · 本步还没有任何链项时（文本先到、工具后到）也要能定位，且不能顶到上一步的块里去；
     *   · 历史快照把同一步的增量按 `seq - 1/(k+1)` 排在结算消息之前，**工具块往往先落链**，
     *     按「第一个本步工具」的写法会把文本插到不该在的位置（真机现象：工具行之间的文字次序与网页端对不上）。
     * 块内次序由事件因果自己决定（推理先到就在前、文本先到就在前），这里只保证不越过步边界。
     */
    const textInsertAt = (chain: readonly DshRowItem[], step: number | undefined): number => {
        // 本步的**工具**已经在链上：文本插到它之前（模型的说明写在调用之前）
        const first = stepFirstChainIdx.get(step);
        if (first !== undefined) {
            for (let i = first; i < chain.length; i += 1) {
                const item = chain[i];
                if (item.kind === 'tool' && item.step === step) {
                    return i;
                }
            }
        }
        // 其余情形插在**上一步块尾之后**（步边界）
        const orderIdx = stepOrder.indexOf(step);
        if (orderIdx <= 0) {
            return Math.min(chain.length, first ?? chain.length);
        }
        const previous = stepLastChainIdx.get(stepOrder[orderIdx - 1]);
        const at = previous === undefined ? 0 : previous + 1;
        return Math.min(at, chain.length);
    };
    /** 本回合是否已收到结算（assistant/message）：回滚只在「该尝试期间无结算」时进行 */
    let sawMessage = false;
    /**
     * 本回合被**插话**切开的前段（其正文已显示在自己那条行里）。收尾时这些文本不得再当「过程文本」
     * 重复进最后一段的链，否则同一条正文会出现两遍。
     */
    let closedSegmentTexts: string[] = [];
    /**
     * 插话把当前回答行**收束**了：后续增量要另开一行 —— 由此得到与上游一致的节点顺序
     * 「前段回答 → 插话 → 后段回答」。没有它，插话只能被塞进整条回答行的前面或后面。
     */
    let segmentClosed = false;
    /** 活跃尝试的回滚基线：正文 + **链长**（放弃时该尝试的推理/增量一并撤回 —— 上游按 attempt 删全部瞬态）；
     *  `sealed` = 该尝试开始时是否已结算过；`liveTextStep` = 当时正文装的是哪一步（回滚要一起复原） */
    let attemptBase: { text: string; chainLen: number; sealed: boolean; liveTextStep: number | undefined } | undefined;

    const activeRow = (): AssistantRow | undefined => (active >= 0 ? (rows[active] as AssistantRow) : undefined);
    /** 一条链上出现过的步号（按行过滤 `groups` 用；见 `filterGroupsForChain`）。 */
    const stepsOfChain = (chain: readonly DshRowItem[]): number[] => {
        const out: number[] = [];
        for (const item of chain) {
            if (typeof item.step === 'number') {
                out.push(item.step);
            }
        }
        return out;
    };
    const replaceActive = (next: AssistantRow): void => {
        rows[active] = next;
    };
    // 本回合的折叠计数（上游口径）：subagent 委派**不计入**工具数，单独计；消息数按步去重
    let toolCallCount = 0;
    let subagentCount = 0;
    /** 带**回答内容**的 assistant/message 按步计数：同一 step 多条**各计一次**（上游按事件计，不按步去重） */
    const replyMsgByStep = new Map<number | undefined, number>();
    // 统计所需的事件序列（与实时通路同义：增量重打包成内部标签，**计算**一律交给 official/turn-stats）
    const turnEvents: TurnLikeEvent[] = [];
    let lastTimeMs: number | undefined;
    /**
     * 本条回答的**锚点**：本回合最后一条**带文本**的 append 结算消息。
     * 两个消费方各取一个字段，口径就是上游「末尾回答节点」的同一处取值：
     *   seq  → 「从此处分叉」传给 `session/fork` 的 `atSeq`（服务端据此切到该回合末尾）；
     *   id   → 消息反馈（👍/👎）的 `messageId`（服务端只认 append 语义的 assistant 消息）。
     * 只认带文本的那条：含工具调用的末步不算回答，与折叠判据同一口径。
     */
    let replySeq: number | undefined;
    let replyMessageId: string | undefined;
    /**
     * 本回合模型声明的交付文件：**同一路径只留最后一次声明**，顺序按首见（声明可以重复，后一次覆盖前一次）。
     * 只在收到 `deliverables/presented` 时写：那个事件是工具的落账，成功才有。
     */
    const presentedByPath = new Map<string, DshPresentedFile>();
    /**
     * **重试链的行位置**（`retryId` → 行下标）。
     *
     * 上游按 `retryId` 把同一条链的事件聚成**一个节点**：只有 `retry === 1` 的 `llm/retry` 会**开链**
     * （窗口里丢了首条就整链不渲染），后续 `llm/retry` 只更新该行，`llm/retry-started` 把该次标成已开始。
     */
    const retryRowAt = new Map<string, number>();
    /** 自动压缩标记的行位置（`compactionId` → 行下标）：检查点落地时建、`compaction/summary` 到账时补摘要。 */
    const compactionRowAt = new Map<string, number>();
    /** 手动命令行的行位置（`commandId` → 行下标）：`command/run` 建行、`command/done` 只补结果。 */
    const commandRowAt = new Map<string, number>();
    /** 摘要先于检查点到达时的暂存（罕见；上游靠 `matches` 兜底，这里等价用一个小表）。 */
    const pendingCompactionSummary = new Map<
        string,
        { summaryEventSeq?: number; summary?: string; shadowedItemCount?: number; shadowedTokenCount?: number }
    >();
    /**
     * **最近一次 `todo/write` 落盘的清单**（窗口级、跨回合存活，**不随 `turn/start` 清空**）。
     *
     * 这是 todo 卡 diff 的基线（镜像上游 `tool-todo-history`：每条 `todo_write` 调用都与它之前
     * 最近一次 `todo/write` 事件配对）。与 `todos.ts` 的 `foldTodos`（输入框常驻卡、本轮清空）**不是
     * 同一份**——那份看「当前清单」，这份看「上一份落盘清单」，两者口径刻意分开。
     * `null` = 窗口里还没有 `todo/write`（页面据此再按 `historyHasMore` 分「首次记录/旧清单不可用」）。
     */
    let lastTodoWrite: DshTodoItem[] | null = null;

    const openAssistant = (): void => {
        // 计数在**定稿**时写入（进行中页面用链内实时数，与既有口径一致）
        rows.push({
            kind: 'assistant',
            key: key++,
            text: '',
            done: false,
            ...(currentTurn === undefined ? {} : { turn: currentTurn }),
            chain: [],
            counts: { toolCallCount: 0, messageCount: 0, subagentCount: 0 },
        });
        active = rows.length - 1;
        segmentClosed = false;
    };
    const ensureActive = (): AssistantRow | undefined => {
        if (activeRow() === undefined || segmentClosed) {
            openAssistant();
        }
        return activeRow();
    };

    /**
     * 回合**终局通知**行（**独立行**，镜像上游 `turn-error` 与 `turn-max-tokens` 两个节点）：
     * 只搬运事实，文案由页面决议。上游两节点都由 `turn/end`（失败那个还要 `turn/start`）建、
     * 与本回合有无内容无关，且在 `INDEPENDENT` 集合里（不被折进过程组）；
     * 位置 = 该回合末尾，所以调用点都在回答行收完之后。
     */
    const pushTurnNotice = (rowKey: number, tone: 'error' | 'warning', failure?: DshTurnFailure): void => {
        rows.push({
            kind: 'turnNotice',
            key: rowKey,
            tone,
            ...(currentTurn === undefined ? {} : { turn: currentTurn }),
            ...(currentStep === undefined ? {} : { step: currentStep }),
            ...(failure?.message === undefined ? {} : { message: failure.message }),
            ...(failure?.code === undefined ? {} : { code: failure.code }),
        });
    };

    /** 思考增量：同 step+index 续接成一段，否则新起一段。 */
    const appendReasoning = (step: number | undefined, index: number | undefined, text: string): void => {
        const row = ensureActive();
        if (row === undefined || text === '') {
            return;
        }
        const chain = row.chain;
        const last = chain[chain.length - 1];
        const same = last !== undefined && last.kind === 'reasoning' && last.step === step && last.index === index;
        if (same) {
            replaceActive({
                ...row,
                chain: chain.map((c, i): DshRowItem => (i === chain.length - 1 && c.kind === 'reasoning' ? { ...c, text: c.text + text } : c)),
            });
            return;
        }
        noteChainStep(step, chain.length);
        replaceActive({ ...row, chain: [...chain, { kind: 'reasoning', key: key++, step, index, text }] });
    };

    /**
     * 某一步的文本**离开正文、固定到链上**。
     *
     * 位置由 `textInsertAt` 决定：本步工具已在链上就插到它**之前**（模型的说明写在调用之前），
     * 否则接在**上一步块尾之后**（不越过步边界）。块内「推理与文本谁先」由事件因果决定，
     * 不做二次排序 —— 上游按块次序持有 `anchorSeq`，插件按到达次序近似，见 `docs/design/06`。
     */
    const appendStepTexts = (step: number | undefined, texts: readonly string[]): number[] => {
        const row = ensureActive();
        const keys: number[] = [];
        if (row === undefined) {
            return keys;
        }
        let chain = row.chain;
        for (const text of texts) {
            if (text === '') {
                continue;
            }
            // 位置规则见 `textInsertAt`：插在**本步工具之前**（模型先说明、再动手），不越过步边界
            const at = textInsertAt(chain, step);
            const itemKey = key++;
            chain = chain.slice();
            chain.splice(at, 0, { kind: 'text', key: itemKey, step, text });
            keys.push(itemKey);
            // 插点**之后**的各项位置后移一格。插点本身**不动**：它记的若是本步首项（工具），
            // 文本就永远插在它前面，不会因为这次插入把位置让到工具之后。
            for (const [st, idx] of stepFirstChainIdx) {
                if (idx > at) {
                    stepFirstChainIdx.set(st, idx + 1);
                }
            }
            for (const [st, idx] of stepLastChainIdx) {
                if (idx >= at) {
                    stepLastChainIdx.set(st, idx + 1);
                }
            }
        }
        replaceActive({ ...row, chain });
        return keys;
    };

    /**
     * 该步的文本**此刻确实在链上**吗（按 key 在链里核实，而不是查"插过没有"的标记）。
     *
     * 为什么必须核实：回合收尾会把「被误当成过程文本的最终回答」从链里**取走**（那时才知道它是回答）。
     * 只删标记漏删一半，或者标记与链不一致时，后面就会以"已经在链上"为名跳过补插 ——
     * 那句文字**链上没有、正文里也没有**，整段消失（真机现象，2026-09-19 复现于真实会话）。
     */
    const stepTextOnChain = (step: number | undefined): boolean => {
        const itemKey = appendedStepText.get(step);
        if (itemKey === undefined) {
            return false;
        }
        const row = activeRow();
        return row !== undefined && row.chain.some((c) => c.key === itemKey);
    };

    /** 把某一步的当前正文文本固定到链上（步切换或回合结束时调用）。 */
    const appendStepText = (step: number | undefined, text: string): void => {
        if (text === '' || stepTextOnChain(step)) {
            return;
        }
        const keys = appendStepTexts(step, [text]);
        if (keys.length > 0) {
            appendedStepText.set(step, keys[keys.length - 1]);
        }
    };

    /** 该步的链块自首项起是否已经出现工具（出现即「已能定位」→ 可以补插文本）。 */
    const chainNeedsStepText = (step: number | undefined, firstIdx: number): boolean => {
        const row = activeRow();
        if (row === undefined) {
            return false;
        }
        return row.chain.slice(firstIdx).some((item) => item.kind === 'tool' && item.step === step);
    };

    /**
     * **步切换**：上一步的正文文本就此固定到链上（它已经说完，不再是"当前这一步"）。
     *
     * 只有「上一步还没固定过」时才动 —— 结算、步边界、下一次增量都会走到这里，重复调用必须无副作用
     * （否则同一条文本会进链两次，真机就是「同一段话出现两遍」）。
     */
    const settleStepText = (nextStep: number | undefined): void => {
        const previous = liveTextStep;
        if (previous === undefined || previous === nextStep || stepTextOnChain(previous)) {
            return;
        }
        // 只**登记**，不立刻插：插入点要等本步的过程成员（工具）落链才算得准。
        // 急着插会落到该步块的最前面（推理之前）—— 模型是「推理 → 说明 → 调工具」。
        settledStepText.add(previous);
        flushSettledStepText();
    };

    /**
     * 把已登记的步骤文本补插到链上（见 `settleStepText`）：该步的工具一落链、或回合收尾时各调一次。
     * 本步根本没有工具的，由回合收尾的兜底 `toChain` 接住，位置再由 `reorderChainByStep` 归位。
     */
    const flushSettledStepText = (): void => {
        for (const step of [...settledStepText]) {
            const text = stepTexts.get(step) ?? '';
            // 已登记的步即便仍被 `liveTextStep` 指着也算「说完」：它是在步切换时登记的，
            // 那一刻正文已经换到下一步（`liveTextStep` 随后就被赋成新步）。
            if (stepTextOnChain(step) || text === '') {
                continue;
            }
            const first = stepFirstChainIdx.get(step);
            if (first === undefined || !chainNeedsStepText(step, first)) {
                continue;
            }
            const before = activeRow()?.chain.length ?? 0;
            appendStepText(step, text);
            // 这一段**刚刚落链**（`beginStep` 时它还没进链、不敢清正文）：现在它有地方待了，
            // 正文里那份必须撤掉 —— 否则同一段文字「链上一份 + 正文一份」两份都在（真机事故）。
            const landsNow = (activeRow()?.chain.length ?? 0) > before;
            if (landsNow && liveTextStep !== step) {
                clearActiveText();
            }
        }
    };

    /**
     * 某一步的文本在当前链上那一条的 key（按**步号 + 文本**在链里核实，不是查"插过没有"的标记）。
     *
     * 为什么必须核实：回合收尾会把「被误当成过程文本的最终回答」从链里**取走**（那时才知道它是回答）。
     * 只删标记漏删一半，或者标记与链不一致时，后面就会以"已经在链上"为名跳过补插 ——
     * 那句文字**链上没有、正文里也没有**，整段消失（真机现象，2026-09-19 复现于真实会话）。
     */
    const stepTextItemKey = (step: number | undefined): number | undefined => {
        const row = activeRow();
        if (row === undefined) {
            return undefined;
        }
        const hit = row.chain.find((c) => c.kind === 'text' && c.step === step);
        return hit === undefined ? undefined : hit.key;
    };

    /** 记下某一步的**正文文本**（增量与结算共用）：回合结束时据此挑出最终回答。 */
    const noteStepText = (step: number | undefined, text: string): void => {
        stepTexts.set(step, text);
    };

    /**
     * 回合收尾时把链**按步归位**：同一步的项聚成一块，块内**步骤文本在前**、过程成员（思考/工具/注入）在后，
     * 块与块的先后 = 各步首个链项在链上的先后。
     *
     * 为什么必须在收尾时统一重排一次：步骤文本进入链的时机有三条路（步切换时的 `settleStepText`、
     * 结算消息、回合收尾的兜底 `toChain`），它们到达的先后与步的先后**无关**（历史快照里
     * `assistant/message` 的 `data.stream` 按块展开、工具块常常更早落链）。任何一处"插到本步块首"的
     * 局部写法都只在**该步的块已经出现**时才对，先到的那一步会被后到的插到后面 —— 真机现象就是
     * 「工具行之间的文字排到了链尾/链首」，与网页端的次序对不上。
     *
     * 稳定性：块内**保持原相对顺序**（只把文本提到该步过程成员之前），没有步号的项自成一块、位置不变。
     */
    const reorderChainByStep = (chain: readonly DshRowItem[]): DshRowItem[] => {
        const groups = new Map<number | undefined, DshRowItem[]>();
        const stepOf = (item: DshRowItem): number | undefined =>
            item.kind === 'tool' || item.kind === 'reasoning' || item.kind === 'text' || item.kind === 'context'
                ? item.step
                : undefined;
        // 出现次序（没有步号的项与只出现过工具、还没有文本的步都靠它定位）
        const seen: Array<number | undefined> = [];
        for (const item of chain) {
            const step = stepOf(item);
            let group = groups.get(step);
            if (group === undefined) {
                group = [];
                groups.set(step, group);
                seen.push(step);
            }
            group.push(item);
        }
        for (const st of stepFirstChainIdx.keys()) {
            if (!groups.has(st)) {
                groups.set(st, []);
                seen.push(st);
            }
        }
        // **按步号升序**：步号就是模型思考的次序，链上各项落链的先后并不可靠（见函数注释）。
        // 只有步号缺失的项不可比，保留它们在链上的相对位置（排在所有已知步之后）。
        const numeric: number[] = [];
        const unknown: Array<number | undefined> = [];
        for (const step of seen) {
            if (typeof step === 'number') {
                numeric.push(step);
            } else {
                unknown.push(step);
            }
        }
        numeric.sort((a, b) => a - b);
        const out: DshRowItem[] = [];
        for (const step of [...numeric, ...unknown]) {
            // 块内**保持原相对次序**：本步的推理与文本谁先到谁在前（块次序就是因果次序）；
            // 唯一要拉回来的是「文本落在本步**工具之后**」—— 说明写在调用之前，这是硬规则。
            const group = groups.get(step) ?? [];
            const firstTool = group.findIndex((item) => item.kind === 'tool');
            const lastText = group.reduce((acc, item, i) => (item.kind === 'text' ? i : acc), -1);
            if (firstTool !== -1 && lastText > firstTool) {
                const later = group.filter((item, i) => i > firstTool && item.kind === 'text');
                const rest = group.filter((item, i) => !(i > firstTool && item.kind === 'text'));
                out.push(...later, ...rest);
                continue;
            }
            for (const item of group) {
                out.push(item);
            }
        }
        return out.length === chain.length ? out : [...chain];
    };

    const appendTool = (
        name: string,
        callId: string | undefined,
        argsRaw: string | undefined,
        step: number | undefined,
    ): void => {
        const row = ensureActive();
        if (row === undefined) {
            return;
        }
        // 已经有一条**准备中**的同 callId 调用（来自带名字的工具增量）→ **原地升级**它，不新增第二条：
        // 否则「准备中 + 运行中」会变成两条行，调用数也多算一次（上游是一个节点两个阶段）。
        if (callId !== undefined) {
            const at = row.chain.findIndex(
                (c) => c.kind === 'tool' && c.callId === callId && c.status === 'preparing'
            );
            if (at >= 0) {
                const tool = row.chain[at] as Extract<DshRowItem, { kind: 'tool' }>;
                const chain = [...row.chain];
                chain[at] = { ...tool, status: 'running', argsRaw, step };
                replaceActive({ ...row, chain });
                flushSettledStepText();
                return;
            }
        }
        // 计数只在**新调用**上做（准备中那条已经计过；升级不算新调用）
        if (name === 'subagent' || name.startsWith('subagent_')) {
            subagentCount += 1;
        } else {
            toolCallCount += 1;
        }
        noteChainStep(step, row.chain.length);
        replaceActive({
            ...row,
            chain: [...row.chain, {
                kind: 'tool', key: key++, step, callId, name, argsRaw, status: 'running',
                // todo 卡 diff 基线：此刻「本次写入」的 todo/write 还没到（工具先调用、后落盘），
                // lastTodoWrite 就是**上一次**的清单，正是 diff 要的基线。
                ...(name === 'todo_write' ? { todoBaseline: lastTodoWrite } : {}),
            }],
        });
        // 该步的工具落链了：先前「等过程成员出现再定稿」的步骤文本此刻可以补插（位置才准）
        flushSettledStepText();
    };

    /**
     * **准备中**的调用（带名字的工具增量，见 `applyChunk`）：算一次调用、不解析参数、不落 `argsRaw`。
     *
     * 同一 `callId` 只落一条；没有 `callId` 时按「同名且已在准备中」去重。
     */
    const notePreparingTool = (
        name: string,
        id: string | number | undefined,
        step: number | undefined,
        seq: number | undefined
    ): void => {
        const row = ensureActive();
        if (row === undefined) {
            return;
        }
        const callId = id === undefined ? undefined : String(id);
        const known = row.chain.some(
            (c) =>
                c.kind === 'tool' &&
                (callId === undefined ? c.name === name && c.status === 'preparing' : c.callId === callId)
        );
        if (known) {
            return;
        }
        if (name === 'subagent' || name.startsWith('subagent_')) {
            subagentCount += 1;
        } else {
            toolCallCount += 1;
        }
        // 准备中的调用**也是过程节点**（上游那个 tool-call 节点从此刻就存在），故照常登记过程证据。
        // 提问工具（`ask_user_question` / `request_user_input`）**标记 `ask`**：它不参与"过程外置"
        // （web 的可见节点里没有提问），否则"只有提问"的回合折起后会多出一行 `向用户提出了问题`。
        processInput.entries.push({
            kind: 'tool-call',
            seq,
            step,
            ...(name === 'ask_user_question' || name === 'request_user_input' ? { ask: true } : {}),
        });
        noteChainStep(step, row.chain.length);
        replaceActive({
            ...row,
            chain: [...row.chain, {
                kind: 'tool', key: key++, step, callId, name, status: 'preparing',
                // 准备中的 todo_write 同样带上基线（升级成 running 时经 `...tool` 原样保留）。
                ...(name === 'todo_write' ? { todoBaseline: lastTodoWrite } : {}),
            }],
        });
        flushSettledStepText();
    };

    /**
     * **一步开始**：上一步的正文文本就此固定到链上（它已经说完，不再是"当前这一步"）。
     *
     * 触发者必须是**任何**过程证据的步变化，而不只是下一条**文本**增量：
     *   · 实时帧里 `step/start` 是带的，但**历史快照没有** `step/start`/`step/end`
     *     （步边界只体现在结算事件的 `step` 字段上），只靠它切步会漏；
     *   · 更常见的是「一句话说完 → 下一步直接推理 / 直接调工具」—— 下一步**根本没有文本增量**，
     *     只在文本增量里切步就永远不触发。
     * 真机现象（2026-09-19 复现于真实会话 turn 18）：那一行**只剩一句正文挂在对话区最下面**，
     * 链上只挂着更早一步的文本，工具行之间该有的那句整段不见。
     */
    const beginStep = (step: number | undefined): void => {
        if (liveTextStep === undefined || liveTextStep === step) {
            return;
        }
        const previousStep = liveTextStep;
        // 先摘掉「当前步」再结算：`flushSettledStepText` 以 `liveTextStep` 判「这段文本还在正文里」，
        // 不摘的话上一步的文本会被它自己挡在链外
        liveTextStep = undefined;
        settleStepText(step);
        // **正文里不能再留着上一步那段**：它已经作为过程文本进了链，而正文是"当前这一步"的位置。
        // 留着就会出现**同一段文字两份** —— 一份在工具行旁边（链上）、一份在对话区最下面（正文）。
        // 下一步的文本增量一到达就把正文补上（`applyChunk` 的 `stepped` 分支从空串起算）。
        //
        // **只在这段文本确实已经在链上时才清**：`settleStepText` 可能只是把它**登记**进
        // `settledStepText` 等本步过程成员落链（位置才准）。那时正文是它唯一的落点 ——
        // 提前清掉就会「文字整段消失」（真机现象，见 `settleStepText` 的注释）。
        // 登记的那种情形由 `flushSettledStepText` 补插成功后再清（见那里的 `landsNow`）。
        if (stepTextOnChain(previousStep)) {
            clearActiveText();
        }
    };

    /** 把当前回答行的正文清空（切步时用；没有活跃行时什么都不做）。 */
    const clearActiveText = (): void => {
        const row = activeRow();
        if (row !== undefined && row.text !== '') {
            replaceActive({ ...row, text: '' });
        }
    };

    /**
     * 增量块落行：**实时帧与历史展开事件共用这一处** —— 两者同义，只是包装不同
     * （实时是 `assistant-stream` 帧的 `frame.chunk`；历史是内部标签 `assistant/chunk` 的 `data.chunk`）。
     */
    const applyChunk = (
        chunk: { type?: string; text?: string; index?: number; name?: string; id?: string | number } | undefined,
        step: number | undefined,
        seq: number | undefined,
    ): void => {
        // **没有块就没有增量**：实时流里的 `start` / `end` 帧不带 `chunk`，若照样登记一条
        // `{kind:'chunk', step:undefined}` 的过程事实，就会在步表里凭空多出一个「未知步」并成为**最后一步**
        // —— 回答锚点按最后一步算，于是整个回合被判成「没有回答」而永不折叠。
        // 历史通路没有这两帧（增量内嵌在结算事件里），所以历史正常、实时不折叠
        //（真机现象：打开历史有折叠头，实时跑完那一轮没有）。
        if (chunk === undefined) {
            return;
        }
        // 增量也是过程事实的输入（「每步首条可见证据」取自它，可见性判据在 official/chunk-facts）
        processInput.entries.push({ kind: 'chunk', seq, step, chunk });
        if (step !== undefined) {
            // 步号读数：增量是最常带步号的证据（`step/start` 在历史快照里没有）
            currentStep = step;
        }
        // 段标识取**块**序号（chunk 自带，同一次推理的各增量共享它）；
        // 帧顶层的 index 是**帧序号**、逐帧递增，拿它判段会让每个增量各成一段。
        const index = typeof chunk.index === 'number' ? chunk.index : undefined;
        // 推理也是「新的一步开始了」的证据：这一步的推理落链之前，先把上一步的文本固定好
        beginStep(step);
        if (chunk.type === 'tool-call-delta') {
            // **带名字的工具增量** = 「这个工具已经声明、参数还没到」→ 先落一条**准备中**的调用
            //（上游 `phase: 'preparing'` 的唯一来源）。`tool/call` 一到就把它**原地升级**成运行中，
            // 不新增第二条；历史通路没有这一步（直接从 `tool/call` 开始，上游 README 同口径）。
            const name = typeof chunk.name === 'string' ? chunk.name : '';
            if (name !== '') {
                notePreparingTool(name, chunk.id, step, seq);
            }
            return;
        }
        if (chunk.type === 'reasoning-delta') {
            appendReasoning(step, index, typeof chunk.text === 'string' ? chunk.text : '');
            return;
        }
        if (chunk.type === 'text-delta') {
            const delta = typeof chunk.text === 'string' ? chunk.text : '';
            const row = ensureActive();
            if (row === undefined || delta === '') {
                return;
            }
            const previous = liveTextStep;
            const stepped = previous !== step;
            // 正文按**步**累积：一步的文本就是那一步的正文。跨步直接往同一行上接，
            // 会把两步的话连成一段（真机现象：插件里连着两句、网页端只显示当前这一步那句）。
            const base = stepped ? '' : row.text;
            liveTextStep = step;
            const next = base + delta;
            noteStepText(step, next);
            replaceActive({ ...row, text: next });
        }
    };

    /**
     * 工具结果：解包后按配对标识更新链上那一条。
     *
     * 从**最新一行往前找**持有该调用的回答行，而不是只看当前行：回合被插话切成多段时，
     * 正在等的调用可能登记在**前段**那条行上 —— 只认当前行会让它永远停在「进行中」。
     */
    const applyToolResult = (data: Record<string, unknown>): void => {
        const payload = readToolResult(data);
        const error = data['error'] as { name?: unknown; code?: unknown } | undefined;
        const errCode = typeof error?.code === 'string' ? error.code : undefined;
        const errName = typeof error?.name === 'string' ? error.name : undefined;
        const withImage = hasImageBlock(payload.blocks);
        // 含图片块时只留干净文本（图片字节由附件层按需取），原始块另带
        const raw = withImage ? textOnly(payload.blocks) : resultText(payload.blocks, error);
        const exit = parseExitStatus(raw);
        // **不截断**：上游展平层没有字符上限（超长由工具自身的正式文案与 UI 的按行折叠处理），
        // 自造截断会静默丢掉输出尾部。
        const output = exit.output;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            const row = rows[i];
            if (row.kind !== 'assistant') {
                continue;
            }
            let matched = false;
            const chain = row.chain.map((c): DshRowItem => {
                if (matched || c.kind !== 'tool') {
                    return c;
                }
                const hit = payload.callId !== undefined
                    ? c.callId === payload.callId
                    : c.status === 'running' || c.status === 'preparing';
                if (!hit) {
                    return c;
                }
                matched = true;
                return {
                    ...c,
                    status: toolStatusOf(errCode, payload.isError),
                    error: errCode,
                    errorName: errName,
                    output: output !== '' ? output : c.output,
                    exitCode: exit.exitCode,
                    signal: exit.signal,
                    // 卡数据源（web 卡的 statusCode/sources、读族的 offset…）**原文透传**：
                    // 不传则那些卡取不到数据，一律退回通用卡（「输入 / 输出」）。
                    meta: data['meta'],
                    // 内容块**始终**透传（上游的结果节点一直带 content）：卡怎么判定、怎么显示都留在渲染侧，
                    // 只按「含图片才带」会让搜索卡等的恢复定位符拿不到内容。
                    blocks: payload.blocks,
                };
            });
            if (matched) {
                rows[i] = { ...row, chain };
                return;
            }
        }
    };

    const timeOf = (event: DshStreamEvent): number | undefined =>
        typeof event.time === 'number' ? event.time : undefined;

    /**
     * 组装用量 / 用时（**计算**一律交给 official/turn-stats，这里只按页面要的形状组一份）。
     *
     * @param seq - 本回合的统计序列（`turnEvents`）。
     * @param withUsage - 要不要给**用量**（上游 `closing`：没有定稿回答就不给）。
     *   **用时不受它影响**：`runMs` 只取 turn 起止时刻，被停止/收在工具调用上的回合照样有总用时
     *   （2026-10-02 修：此前两者被同一个门吞掉，287 条历史行里 43 条因此既没用量也没用时）。
     */
    const buildStats = (seq: readonly TurnLikeEvent[], withUsage = true): Record<string, unknown> | undefined => {
        const usage = deriveTurnTokenUsage(seq);
        const facts = deriveTurnFacts(seq);
        // 本轮是哪个 turn：用时那边的 runMs 只要有 turn 起止时刻就有，
        // 拿它当锚（用量不可证时它仍在）；都没有才算这一轮没有任何统计。
        const turnKey = [...facts.runMs.keys()].pop() ?? [...usage.keys()][0];
        if (turnKey === undefined) {
            return undefined;
        }
        const out: Record<string, unknown> = {};
        const u = withUsage ? usage.get(turnKey) : undefined;
        if (u !== undefined) {
            out.inputTokens = u.uncachedInputTokens;
            out.outputTokens = u.outputTokens;
            if (u.cacheReadTokens !== undefined) {
                out.cacheReadTokens = u.cacheReadTokens;
            }
            if (u.cacheWriteTokens !== undefined) {
                out.cacheWriteTokens = u.cacheWriteTokens;
            }
            if (u.reasoningTokens !== undefined) {
                out.reasoningTokens = u.reasoningTokens;
            }
            if (u.routes !== undefined && u.routes.length === 1) {
                out.provider = u.routes[0].provider;
                out.model = u.routes[0].model;
            }
        }
        // 用时 / TTFT / TPS 与用量**各自独立**：用量不可证只是「没有用量」，用时照常给。
        const m = facts.metrics.get(turnKey);
        // 展示精度照上游：<10 保留一位小数、否则取整（<10 时取整会把 2.4 写成 2）
        if (m?.ttftMs !== undefined) {
            const sec = m.ttftMs / 1000;
            out.ttftSec = sec < 10 ? Math.round(sec * 10) / 10 : Math.round(sec);
        }
        if (m?.tokensPerSecond !== undefined) {
            out.tps =
                m.tokensPerSecond < 10
                    ? Math.round(m.tokensPerSecond * 10) / 10
                    : Math.round(m.tokensPerSecond);
        }
        const rm = facts.runMs.get(turnKey);
        if (rm !== undefined) {
            out.wallSec = rm / 1000; // 不预舍入：展示端按上游整秒向下取整
        }
        return Object.keys(out).length > 0 ? out : undefined;
    };

    /** 统计序列：turn 边界与带文本的 assistant 消息原样收；增量帧重打包成内部标签（与实时通路同义）。 */
    const collectTurnEvent = (type: string, event: DshStreamEvent, d: Record<string, unknown>): void => {
        if (type === 'assistant-stream') {
            const chunk = event.frame?.['chunk'];
            if (chunk !== undefined) {
                turnEvents.push({ type: 'assistant/chunk', time: timeOf(event), data: { chunk } } as TurnLikeEvent);
            }
            return;
        }
        if (type === 'assistant/chunk') {
            // 历史侧：结算事件里内嵌的增量被展开成这个内部标签（形状与实时帧同义，只是包装不同）。
            // **它必须进统计序列** —— 「首 token 时刻」就取自这些增量，漏收会让历史会话
            // 永远没有 TTFT / TPS（真机现象：历史里用量/时长有，速度两项恒缺）。
            turnEvents.push({ type, time: timeOf(event), data: d } as TurnLikeEvent);
            return;
        }
        if (type === 'turn/start' || type === 'step/start' || type === 'assistant/message' || type === 'turn/end') {
            turnEvents.push({ type, time: timeOf(event), data: d } as TurnLikeEvent);
        }
    };

    /**
     * 断点续折的入口状态。
     *
     * 断点落在 `turn/start`，而 `turn/start` 会把**本回合的一切**就地重置（统计、步表、
     * 过程事实、尝试基线、各类下标映射…），所以这里只要接上**跨回合存活的那几个量**：
     * `rows` / `key` / `currentTurn` / `currentStep`；`inboxFold` 是**窗口级**的收件箱折叠史，
     * 必须从零重放（它决定插话归属，跨回合有效）。`userTurn` 同样跨回合（系统提示词按回合认位），
     * 从空表重建即可 —— 但**重建需要前缀里的用户行**，所以断点前那一截不参与本次循环时，
     * 这个表由断点自己带上（见 `RowsFoldCheckpoint`）。
     */
    let fromIndex = 0;
    let closedAtPreviousTurn = false;
    let resumedFromCheckpoint = false;
    let promoted: RowsFoldCheckpoint | undefined;
    if (usable && prev !== undefined && at !== undefined) {
        rows.push(...prev.rows);
        key = prev.nextKey;
        currentTurn = prev.currentTurn;
        currentStep = prev.currentStep;
        resumedFromCheckpoint = true;
        // 前缀里的用户行 → 回合号：系统提示词按回合认位（见 `system/message` 分支），
        // 只重折尾巴就必须把前缀那份补回来 —— 行模型不带 `turn`，所以断点自带这份表。
        for (const [rowKey, turn] of prev.userTurns) {
            userTurn.set(rowKey, turn);
        }
        // 跨批次的配对表：一次用户命令的 run/done 可能被断点切开（见 `RowsFoldCheckpoint`），
        // 不还原就会把同一个命令渲染成两行。下标语义与 `prev.rows` 对齐（前缀位置不变）。
        for (const [id, at] of prev.commandRowAt) {
            commandRowAt.set(id, at);
        }
        for (const [id, at] of prev.compactionRowAt) {
            compactionRowAt.set(id, at);
        }
        for (const [id, at] of prev.retryRowAt) {
            retryRowAt.set(id, at);
        }
        for (const [id, pending] of prev.pendingCompactionSummary) {
            pendingCompactionSummary.set(id, pending);
        }
        // todo 卡 diff 基线跨回合存活：断点恢复时把前缀里最后一次 `todo/write` 的清单接回来，
        // 否则尾巴里的 todo_write 会把基线当成 null（首次记录），diff 静默退化成「无对比」。
        lastTodoWrite = prev.lastTodoWrite;
        fromIndex = at;
        // 断点处的 `turn/start` 本身还没有被消费过（断点记的是"这一回合从这里开始"）：
        // 它与后续事件一起走正常流程，`turn/start` 分支会把本回合状态重置一遍。
    }

    for (let i = fromIndex; i < events.length; i += 1) {
        const event = events[i] as DshStreamEvent;
        const type = event.type ?? '';
        const d = event.data ?? {};
        if (type === 'turn/start') {
            // 上一回合已在本下标之前收官 → 这里就是可用的断点：把**此刻**的状态封存下来。
            // 顺序要紧：先封存（`currentTurn` 等还是上一回合的读数、`rows` 里是该回合的行），
            // 再走下面的重置 —— 断点记的是「这一回合从这里开始」，恢复时这个 `turn/start` 会被重新消费。
            if (closedAtPreviousTurn && !resumedFromCheckpoint) {
                promoted = {
                    tailStart: i,
                    windowHeadSeq: events[0]?.seq,
                    windowLen: events.length,
                    rows: [...rows],
                    nextKey: key,
                    currentTurn,
                    currentStep,
                    userTurns: [...userTurn],
                    commandRowAt: [...commandRowAt],
                    compactionRowAt: [...compactionRowAt],
                    retryRowAt: [...retryRowAt],
                    pendingCompactionSummary: [...pendingCompactionSummary],
                    lastTodoWrite,
                };
                if (process.env['DSH_ROWS_DEBUG'] !== undefined) {
                    console.warn(`[dsh-ckpt] 封存断点 at=${String(i)} rows=${String(rows.length)} key=${String(key)} turn=${String(currentTurn)}`);
                }
            }
            closedAtPreviousTurn = false;
            resumedFromCheckpoint = false;
        }
        // 一轮的统计**只属于本轮**：构建器对全量事件重跑，不重置就会把前几轮的累积量写进本轮的行
        // （用量尤甚——`buildStats` 取序列里的第一个回合，表现为「每轮用量都一样」）。
        if (type === 'turn/start') {
            toolCallCount = 0;
            subagentCount = 0;
            replyMsgByStep.clear();
            turnEvents.length = 0;
            lastTimeMs = undefined;
            liveStep = undefined;
            liveTextStep = undefined;
            sawMessage = false;
            attemptBase = undefined;
            if (typeof d['turn'] === 'number') {
                currentTurn = d['turn'] as number;
            }
            turnMessages = [];
            replySeq = undefined;
            replyMessageId = undefined;
            presentedByPath.clear();
            closedSegmentTexts = [];
            segmentClosed = false;
            turnStartSeq = typeof event.seq === 'number' ? event.seq : undefined;
            processInput = createTurnProcessInput();
            processInput.turnStartSeq = turnStartSeq;
            stepTexts.clear();
            stepFirstChainIdx.clear();
            stepLastChainIdx.clear();
            stepOrder.length = 0;
            settledStepText.clear();
            // ⚠️ **换回合就要把上一回合还活跃的行收口**（2026-10-03 修 · `14` §24）——**必须放在**
            // 上面那行 `segmentClosed = false` **之后**，否则会被它覆盖（第一版就踩了这个空。
            // 现象：上一回合**没有 `turn/end`**（被插话/转向切开，真机 `36d0` 的 turn=21 正是如此）
            // 而它的行仍被 `ensureActive()` 视作活跃 → **新回合的工具继续往旧回合的行里追加**
            // （实测：`turn=22` 的 5 次工具全落在 `turn=21` 的行上，`turn=22` 自己一条行都没有）。
            // 只在"确实换了回合且旧行有内容"时收口：空行不造新行（页面也会跳渲空行）。
            {
                const stale = activeRow();
                if (stale !== undefined && currentTurn !== undefined && stale.turn !== currentTurn
                    && (stale.chain.length > 0 || stale.text !== '')) {
                    segmentClosed = true;
                }
            }
        }
        // 回合号以**事件自带**为准：快照窗口可能从回合中间开始（缺 `turn/start`），那之后的行
        // 还得认得出自己属于哪个回合（页面按回合归组做外层折叠，见 `turn` 字段）。
        // 只认这几类**回合内过程事件**，不认 `deliverables/presented` —— 后者自带 `turn` 是拿来
        // 做「串台防护」的（见下文该分支），拿它覆盖当前回合号会把别的回合的声明放进来。
        if (type === 'step/start' || type === 'step/end' || type === 'assistant-stream' || type === 'assistant/chunk' || type === 'assistant/message' || type === 'tool/call' || type === 'tool/result' || type === 'llm/retry') {
            const turn = d['turn'];
            if (typeof turn === 'number') {
                currentTurn = turn;
            }
        }
        collectTurnEvent(type, event, d);
        // 步边界是过程事实的输入：步内状态按 turn+step 归并，中断回答还要用该步的关闭边界
        if (type === 'step/start' || type === 'step/end') {
            const step = typeof d['step'] === 'number' ? (d['step'] as number) : undefined;
            if (step !== undefined) {
                // 步号读数：不带步号的过程成员（上下文注入）靠它落进正确的那一步
                currentStep = step;
            }
            processInput.entries.push({
                kind: type === 'step/start' ? 'step' : 'step-end',
                seq: typeof event.seq === 'number' ? event.seq : undefined,
                step,
            });
            // 新的一步开始 = 上一步的文本说完 → 固定到链上。放在这里而不只放在增量路径：
            // 有些回合的步内容**不走增量**（历史快照把增量内嵌在结算里），只按增量切步会漏。
            if (type === 'step/start') {
                settleStepText(step);
            }
        }

        // 收件箱 splice：只喂给「插话判定」的折叠（不产出行）。**必须排在 user/message 之前** ——
        // 它决定紧随其后的那条人类消息算不算插话（按事件顺序取「当时」的状态，不是事后整表判断）。
        if (type === 'agent/inbox/spliced') {
            inboxFold.accept(event);
            continue;
        }

        // `developer/message`：上游 `developerMessageDefinition` 复用**上下文行的呈现**，
        // 故这里也入链成一条 context 项。内容全是工具增删块时，页面按上游 `ContextInjectionRow`
        // 的规则改走「工具已更新」形态（`webview/chat/core/context-body.ts`）。
        if (type === 'developer/message') {
            const raw = d['message'];
            const message = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
                ? (raw as Record<string, unknown>)
                : undefined;
            const content = message === undefined ? undefined : message['content'];
            const blocks = Array.isArray(content) ? (content as unknown[]) : [];
            if (blocks.length === 0) {
                continue;
            }
            // 与上下文注入同一条口径：**看不见的（非工具增删块）不许自己开一行**，
            // 否则会得到「有控制行、无内容」的假回答行（见 user/message 上下文分支的注释）。
            const row = ensureActive();
            if (row === undefined || blocks.length === 0) {
                continue;
            }
            const source = message === undefined ? undefined : message['source'];
            const item: DshRowItem = {
                kind: 'context',
                key: key++,
                content: blocks,
                source,
                provenance: contextProvenance(source),
                form: contextForm(source),
                // 与上下文注入同因：不带步号会被 `reorderChainByStep` 恒定排到链尾
                step: typeof d['step'] === 'number' ? (d['step'] as number) : currentStep,
            };
            replaceActive({ ...row, chain: [...row.chain, item] });
            if (typeof event.seq === 'number') {
                processInput.entries.push({ kind: 'context', seq: event.seq });
            }
            continue;
        }

        if (type === 'command/run' || type === 'command/done') {
            // 手动命令（上游 `command` / `manual-compaction` 节点）：`command/run`（start）+ `command/done`（update）
            // 按 `commandId` 配成**一条独立行**；两者都是 log-only 事件（不进派生历史），只按 seq 折成一个节点。
            const commandId = typeof d['commandId'] === 'string' ? (d['commandId'] as string) : '';
            if (commandId !== '') {
                const at = commandRowAt.get(commandId);
                if (type === 'command/run') {
                    if (at === undefined) {
                        commandRowAt.set(commandId, rows.length);
                        rows.push({
                            kind: 'command',
                            key: key++,
                            commandId,
                            name: typeof d['name'] === 'string' ? (d['name'] as string) : null,
                        });
                    }
                } else {
                    // `command/done` 只补结果：**行不移动**（上游 `commandFromDone` 保留 run 的 seq/time/name）
                    const outcome = {
                        kind: (d['kind'] === 'error' ? 'error' : 'success') as 'success' | 'error',
                        ...(typeof d['text'] === 'string' ? { text: d['text'] as string } : {}),
                    };
                    if (at === undefined) {
                        // run 在窗口外：上游照样建节点（name/args = null）
                        commandRowAt.set(commandId, rows.length);
                        rows.push({ kind: 'command', key: key++, commandId, name: null, outcome });
                    } else {
                        rows[at] = { ...(rows[at] as Extract<DshStreamRow, { kind: 'command' }>), outcome };
                    }
                }
            }
            continue;
        }

        if (compactionCheckpoint({ type, surfaceOp: event.surfaceOp, data: d }) !== undefined || type.startsWith('compaction/')) {
            // 自动压缩：**只有检查点落地才出行**（上游 `buildViewNode` 在没有 checkpoint 时返回 null）。
            // 三类 `compaction/*` 事件只做登记/更新：`start`/`end` 对呈现惰性，`summary` 提供摘要与计数。
            const checkpoint = compactionCheckpoint({ type, surfaceOp: event.surfaceOp, data: d });
            const compactionId = type.startsWith('compaction/')
                ? (typeof d['compactionId'] === 'string' ? (d['compactionId'] as string) : undefined)
                : checkpoint?.compactionId;
            if (compactionId !== undefined && compactionId !== '') {
                // 手动压缩（`/compact`）归命令行（上游把这四个事件都判给 `command` 节点）→ 这里不建行
                const sourceCommandId = type.startsWith('compaction/')
                    ? (typeof d['sourceCommandId'] === 'string' ? (d['sourceCommandId'] as string) : undefined)
                    : checkpoint?.sourceCommandId;
                // 手动压缩（`/compact`）归命令行（上游把这类事件判给 `command` 节点）→ 这里不建行
                if (sourceCommandId === undefined) {
                    const at = compactionRowAt.get(compactionId);
                    if (type === 'compaction/summary') {
                        const patch = {
                            ...(typeof event.seq === 'number' ? { summaryEventSeq: event.seq } : {}),
                            ...compactionSummaryFacts(d),
                        };
                        if (at !== undefined) {
                            rows[at] = { ...(rows[at] as Extract<DshStreamRow, { kind: 'compaction' }>), ...patch };
                        } else {
                            // 摘要先于检查点到达（罕见）：先记下来，等检查点落地时一起写
                            pendingCompactionSummary.set(compactionId, patch);
                        }
                    } else if (!type.startsWith('compaction/')) {
                        // 检查点本体：**这一条才让行出现**，锚点就是它的 seq
                        if (at === undefined) {
                            const pending = pendingCompactionSummary.get(compactionId);
                            pendingCompactionSummary.delete(compactionId);
                            const seq = typeof event.seq === 'number' ? event.seq : undefined;
                            if (seq !== undefined) {
                                compactionRowAt.set(compactionId, rows.length);
                                rows.push({
                                    kind: 'compaction',
                                    key: key++,
                                    compactionId,
                                    seq,
                                    ...(pending ?? {}),
                                });
                            }
                        }
                    }
                }
            }
            continue;
        }

        if (type === 'user/message') {
            if (isContextMessage({ type: 'user/message', data: d })) {
                // 系统提示词形态（instructions）不入链：它由 system/message 那条单独承载
                const form = contextForm(d['source']);
                if (form === 'instructions') {
                    continue;
                }
                // 上下文注入属于**过程**：入当前回答行的链（与既有通路一致，见 design/06 §2「过程折叠内」）。
                // **照旧开行** —— 「这条注入看不看得见、要不要占一行」是**渲染层**的事，与上游同机制：
                // 上游为每条注入建一个 `context` 节点（`conversation-nodes/message.ts:76-91`），
                // 由 `orderedVisibleChatNodes()` 的 `filter(isVisibleChatNode)` 把不可见的排除在**行**之外
                //（`chat-snapshot-builder.ts:496-509`）；插件对应 `webview/chat/core/chat-visibility.ts`。
                const row = ensureActive();
                if (row === undefined) {
                    continue;
                }
                const item: DshRowItem = {
                    kind: 'context',
                    key: key++,
                    content: Array.isArray(d['content']) ? (d['content'] as unknown[]) : [],
                    source: d['source'],
                    provenance: contextProvenance(d['source']),
                    form,
                    // **必须带步号**：不带的话 `reorderChainByStep` 会把它归进「无步号项」，
                    // 而那一组恒定排在所有已知步**之后** → 注入跑到链尾（真机现象「上下文注入跑到下面去了」）。
                    // 事件自己带 `step` 就用它，否则用最近一次带步号事件的读数（注入紧跟在那一步之后到达）。
                    step: typeof d['step'] === 'number' ? (d['step'] as number) : currentStep,
                };
                replaceActive({ ...row, chain: [...row.chain, item] });
                // 上下文注入也是一个过程节点（上游的独立节点类型里不含它 → 落在区间内即算「过程外置」）。
                // ⚠️ **只有会显示出来的注入才算**（`visible`）：上游 `isVisibleChatNode` 明确把
                // **普通 `context` 节点排除**（`node.kind !== 'context'`），只有带工具增删块的那一条
                // 在插件里会渲染成"工具变更通知行"。把看不见的注入算进过程外置，会让"只有提问"的回合
                // 折起后多出一行（真机取证 + 上游源码见 `14` §17）。
                if (typeof event.seq === 'number') {
                    processInput.entries.push({
                        kind: 'context',
                        seq: event.seq,
                        visible: hasToolChangeBlocks(Array.isArray(d['content']) ? (d['content'] as unknown[]) : []),
                    });
                }
                continue;
            }
            const source = d['source'] as { kind?: string; rpcId?: string } | undefined;
            // 只认 `kind === 'user'`。dsh 0.2.0 新增的 `'user-question-reply'`（timed 等待的迟到回答）
            // 会落到下面的 continue（被判成上下文注入）。当前**不可达**：它的唯一生产者
            // `userQuestions.answer` 只对 `continued` 问题生效，而 `continued` 只能由 `askTimed` 产生，
            // `tool-ask-user` 的 `mode` 默认仍是 `legacy`（三个出厂 preset 都不带 config）。
            // 若上游把默认改成 `timed`，本处与 `session.ts:eventIsSurfaceHuman`、`official/context-projection.ts`、
            // `control.ts` 的人类锚点要**一起收口**（否则迟到回答会被渲染成上下文行且不写人类锚点）。
            if (source?.kind !== 'user') {
                continue;
            }
            const text = contentText(d['content']);
            const imageRefs = imageRefsOf(d['content']);
            const files = fileRefsOf(d['content']);
            // 插话分类：这条消息是否属于本步从 next-step 收件箱取用的那一批（见 rows/inbox-claims）。
            // 只影响行的种类与 compactAnswer 锚点判定，不影响正文/附件读法。
            const messageId = typeof d['id'] === 'string' ? (d['id'] as string) : undefined;
            const steering = messageId !== undefined && inboxFold.claimed(messageId);
            // 人类锚点（提问 / 插话）进过程事实：`compactAnswer` 判「区间内有没有人插话」要用
            if (typeof event.seq === 'number') {
                processInput.entries.push({ kind: 'human', seq: event.seq });
            }
            // **一律出行**（含只有附件、甚至内容为空）：该事件本身就是一条用户消息，
            // 加「内容为空就丢」会让它在对话区整条消失。
            // 诊断（`DSH_RAWLOG=full` 时才打）：页面靠 `rpcId` 认领本地乐观行 ——
            // 这里打出来，和 `[dsh-send] rpcId=…` 一比就能断定标识到底配不配得上。
            if (process.env['DSH_RAWLOG'] === 'full') {
                console.log(`[dsh-raw] user/message seq=${String(event.seq)} rpcId=${typeof source.rpcId === 'string' ? source.rpcId : '(无 → 本地行认领不到)'} sourceKeys=${Object.keys(source).join(',') || '(none)'}`);
            }
            const userKey = key++;
            const userRow: DshStreamRow = {
                kind: 'user',
                key: userKey,
                text,
                ...(typeof source.rpcId === 'string' ? { rpcId: source.rpcId } : {}),
                ...(steering ? { steering: true as const } : {}),
                ...(typeof event.time === 'number' ? { timeMs: event.time } : {}),
                ...(imageRefs.length > 0 ? { imageRefs } : {}),
                ...(files.length > 0 ? { files } : {}),
            };
            // 位置规则分两种来路，**不能混用**：
            //  · 插话（steering）：它是回合内的一条新输入，位置就按到达顺序（紧跟在已生成内容之后），
            //    并把当前回答行**收束成一段** —— 后续增量另开一行，得到上游的节点顺序
            //    「前段回答 → 插话 → 后段回答」。若照下面那条规则插到回答行**之前**，已生成的内容会被
            //    整个挤到插话下面（位置与上游相反），且流式期间画面会跟着上下跳。
            //  · 普通提问（含迟到的回显）：**插到当前这条未定稿回答行之前**。理由与上游同构：上游把流式内容
            //    当作该回合 step 节点的更新、位置由 `step/start` 这类边界事件建立，回答永远落在问话下面；
            //    而本构建器一回合只开一条行、由内容懒开，于是「回显比该回合头几个增量到得更晚」时回答行先建出来 ——
            //    这里按同一语义纠正：**只要还有未定稿的回答行，它属于当前回合**。
            if (steering) {
                const cur = activeRow();
                if (cur !== undefined && !cur.done) {
                    // 只把这一段**收束**（`done`）：过程事实是**回合级**的，统一在 `turn/end` 写给本回合
                    // 每一条回答行（上游只有一份 `turn-process` 规格，所有节点看到的是同一份）。
                    replaceActive({ ...cur, done: true });
                    if (cur.text !== '') {
                        closedSegmentTexts.push(cur.text);
                    }
                    segmentClosed = true;
                    // 进行中的尝试属于刚收束的那一段：放弃它的回滚基线一并作废
                    //（留着会把前段的正文写进后段行；宁可少撤一次半截，也不串段）
                    attemptBase = undefined;
                }
                rows.push(userRow);
            } else if (active >= 0) {
                rows.splice(active, 0, userRow);
                active += 1; // 回答行下标随插入后移
                if (process.env['DSH_RAWLOG'] === 'full') {
                    console.log(`[dsh-raw] user/message 晚于本轮增量到达（seq=${String(event.seq)}）：已插到回答行之前`);
                }
            } else {
                rows.push(userRow);
            }
            userTurn.set(userKey, currentTurn);
            continue;
        }

        if (type === 'system/message') {
            // 该回合实际发给模型的 system 提示词（上游在同回合开头渲染一条可折叠行）。
            // 读法复用 official/system-prompt（与既有通路同一份）；**不去重** ——
            // 上游是「每个非空 append 各成一张卡」，按 (turn, step) 去重会吞掉重复下发的那张。
            const sp = readSystemPrompt(d);
            if (sp.text !== '') {
                // 位置：**它所属那回合**的用户提问之前 —— 等价于上游「本 step 可见消息序列的起点」
                // （step 1 取 turn/start 的 seq，其余取 step/start 的 seq，两者都落在该回合用户行之前）。
                // 按 turn 匹配而不用「最近一条用户行」：历史恢复时事件顺序与实时不同，
                // 取最近一条会把多条提示词堆到同一处（真机现象）。
                let at = -1;
                if (sp.turn !== undefined) {
                    for (let i = rows.length - 1; i >= 0; i -= 1) {
                        const r = rows[i];
                        if (r.kind === 'user' && userTurn.get(r.key) === sp.turn) {
                            at = i;
                            break;
                        }
                    }
                }
                const row: DshStreamRow = { kind: 'sysprompt', key: key++, text: sp.text };
                if (at === -1) {
                    // 该回合的用户行还没建（上游把它排在本回合 user **之前**，见事件序号）：
                    // 此时列表末尾就是该回合的开头，直接落末尾即可 ——
                    // **不能**退回「最近一条用户行」，那会插到上一个回合里（多条提示词因此堆在一处）。
                    rows.push(row);
                } else {
                    rows.splice(at, 0, row);
                    if (active >= at) {
                        active += 1;
                    }
                }
            }
            continue;
        }

        if (type === 'assistant-stream') {
            const frame = event.frame;
            // step 与 index 都在**里面那层**：step 只随 start 帧到达（缓存给后续增量用），
            // index 在 chunk 上（frame 顶层的 index 是帧序号，不是块序号）。
            const frameKind = frame?.['type'];
            if (frame !== undefined && frameKind === 'start') {
                if (typeof frame['step'] === 'number') {
                    liveStep = frame['step'] as number;
                }
                // 记下该尝试的正文基线：它被放弃（abandoned）时流出的半截文本必须撤回 ——
                // 那是**瞬态**数据，没有持久结算事件来覆盖，不撤就会冒充一条正常回答留在界面上。
                const baseRow = activeRow();
                attemptBase = {
                    text: baseRow?.text ?? '',
                    chainLen: baseRow?.chain.length ?? 0,
                    sealed: sawMessage,
                    liveTextStep,
                };
            }
            if (frame !== undefined && frameKind === 'end') {
                const outcome = frame['outcome'] as { kind?: string } | undefined;
                const row = activeRow();
                // 该尝试期间发生过结算的话，正文已被服务端整条文本覆盖（权威），
                // 再回滚到尝试起点反而会把已确认的正文一并抹掉。
                if (
                    outcome?.kind === 'abandoned' &&
                    attemptBase !== undefined &&
                    row !== undefined &&
                    sawMessage === attemptBase.sealed
                ) {
                    // 正文与**链**一起回滚：该尝试流出的推理/工具增量都是瞬态数据，
                    // 不撤就会留在界面上，刷新（走历史）后又消失 —— 实时与历史不一致。
                    replaceActive({ ...row, text: attemptBase.text, chain: row.chain.slice(0, attemptBase.chainLen) });
                    liveTextStep = attemptBase.liveTextStep;
                }
                attemptBase = undefined;
                liveStep = undefined;
            }
            applyChunk(
                frame?.['chunk'] as { type?: string; text?: string; index?: number } | undefined,
                liveStep,
                typeof event.seq === 'number' ? event.seq : undefined,
            );
            continue;
        }

        if (type === 'assistant/chunk') {
            // 历史侧：快照把它内嵌的增量展开成这个内部标签（形状与实时帧同义，只是包装不同）
            applyChunk(
                d['chunk'] as { type?: string; text?: string; index?: number } | undefined,
                typeof d['step'] === 'number' ? (d['step'] as number) : undefined,
                typeof event.seq === 'number' ? event.seq : undefined,
            );
            continue;
        }

        if (type === 'assistant/message') {
            // 只认 `append` 结算（上游同口径）：`replace` 语义的消息不覆盖正文，也**不算**「本尝试已结算」
            // —— 后者会影响放弃尝试时的回滚判定。
            if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
                continue;
            }
            sawMessage = true;
            const row = ensureActive();
            if (row === undefined) {
                continue;
            }
            const content = (d['message'] as { content?: unknown } | undefined)?.content;
            const text = contentText(content);
            // 回答步的判定看**块**（含 tool-call 的末步不算回答），故这里按块记摘要
            const facts = blockFacts(content);
            const seq = typeof event.seq === 'number' ? event.seq : undefined;
            const msgStep = typeof d['step'] === 'number' ? (d['step'] as number) : undefined;
            turnMessages.push({
                seq,
                step: msgStep,
                ...facts,
            });
            // 过程证据交给派生模块归类（「每步首条**可见** assistant 证据」），这里只登记事件。
            // `hasToolCall` 取本条结算消息的块事实：**该步最后一条** assistant 消息里若含工具调用，
            // 这一回合就没有回答正文（上游 `latestAnswer` 的「不含工具调用」正是按末条消息判）。
            // ⚠️ 曾经想用「该步用过工具」来代替，那是错的：先说话、再调工具的步，末条消息是纯文本，
            // 上游把它当回答 —— 用「用过工具」会把它误判成无回答、把回答正文也塞进链里。
            processInput.entries.push({
                kind: 'message',
                seq,
                step: msgStep,
                hasReply: facts.hasReply,
                hasReasoning: facts.hasReasoning,
                hasToolCall: facts.hasToolCall,
            });
            lastTimeMs = timeOf(event);
            if (text !== '') {
                // 消息数按**步**去重：同一步的多条消息算一条（与既有口径一致）
                // 折叠计数只数**有回答内容**的消息，且只认 append 结算（replace 语义的不算）——上游同口径
                const isAppend = event.surfaceOp === undefined || event.surfaceOp === 'append';
                if (facts.hasReply && isAppend) {
                    replyMsgByStep.set(msgStep, (replyMsgByStep.get(msgStep) ?? 0) + 1);
                    // 回答锚点随之推进（只取 id 非空的那条：null id 的消息在服务端不构成反馈目标）
                    replySeq = seq;
                    const id = (d['message'] as { id?: unknown } | undefined)?.id;
                    replyMessageId = typeof id === 'string' && id !== '' ? id : undefined;
                }
                // 各步文本都留着：回合结束时回答步的那条当正文，其余全部固定在过程链上
                // （否则后来的那条会把整条正文覆盖掉、中间步的话整段消失）
                settleStepText(msgStep);
                noteStepText(msgStep, text);
                // 已被插话切开的前段行已经显示过这条文本：不再写进当前（后段）的正文，否则内容串段
                // （正常事件顺序下前段的结算先到、插话后到，这里是兜底）
                if (!closedSegmentTexts.includes(text)) {
                    replaceActive({ ...row, text });
                }
            }
            // 消息级「这条回答被中断」：上游读的就是 `event.data.interrupted`（见 `conversation-nodes/assistant.ts:207`），
            // 正文末尾据此出「已停止」（与上游同位）。放在最后写入，
            // 免得被上面的正文写入用旧 row 覆盖掉。
            if (d['interrupted'] === true) {
                replaceActive({ ...(activeRow() ?? row), interrupted: true });
            }
            continue;
        }

        // `todo/write`（投影落盘事件，log-only）：只更新 todo 卡 diff 的基线，**不产出行**。
        // 基线口径镜像上游 `tool-todo-write`：**不清空**（与输入框常驻卡的 `foldTodos`「本轮清空」不同）、
        // 后写胜；坏形（不是数组）保留上一份（与 `foldTodos` 的容错同口径）。
        if (type === 'todo/write') {
            const parsed = todoItemsOf(d['todos']);
            if (parsed !== null) {
                lastTodoWrite = parsed;
            }
            continue;
        }

        if (type === 'tool/call') {
            // `toolName` 是同义兜底字段（既有实时通路即 `name ?? toolName`）：只认一个会让这类调用整条不出现
            const name = stringOf(d['name']) ?? stringOf(d['toolName']) ?? '';
            if (name === '') {
                continue;
            }
            // subagent 委派单独计数、不进工具数（与上游同口径）。
            // 计数落在 `appendTool` 里：那里才知道这次是**新调用**还是把「准备中」那条原地升级
            //（升级不能重复计数 —— 准备中的调用已经算过一次）。
            // 工具调用是过程节点，也是控制锚的「其它证据」之一。
            // ⚠️ **提问工具要标记 `ask`** —— 这是**历史/durable 那条**登记路径（实时那条在
            // `appendTool` 附近，两处必须一致）。漏了它，"只有提问"的回合在历史会话里仍会被判成
            // "有过程外置" → 折起后多出一行 `向用户提出了问题`（真机现象，只发生在历史侧）。
            processInput.entries.push({
                kind: 'tool-call',
                seq: typeof event.seq === 'number' ? event.seq : undefined,
                step: typeof d['step'] === 'number' ? (d['step'] as number) : undefined,
                ...(name === 'ask_user_question' || name === 'request_user_input' ? { ask: true } : {}),
            });
            // 「一句话说完就直接调工具」是最常见的形状：上一步的文本要在**这一步的工具落链之前**归位
            // （少了它，那句说明会一直挂在正文，工具行之间永远看不到 —— 见 `beginStep`）
            beginStep(typeof d['step'] === 'number' ? (d['step'] as number) : undefined);
            appendTool(
                name,
                typeof d['callId'] === 'string' ? d['callId'] : undefined,
                typeof d['arguments'] === 'string' ? d['arguments'] : undefined,
                typeof d['step'] === 'number' ? (d['step'] as number) : undefined,
            );
            continue;
        }

        if (type === 'tool/result') {
            // 只有 `append` 语义的结果算「其它证据」（上游同口径：replace 不是一次新的过程动作）
            processInput.entries.push({
                kind: 'tool-result',
                seq: typeof event.seq === 'number' ? event.seq : undefined,
                append: event.surfaceOp === undefined ? false : event.surfaceOp === 'append',
            });
            applyToolResult(d);
            continue;
        }

        // `workspace/changes`（回合改动**宣告**，log-only）：**不产出行**，只把这个 seq 记到该回合的行上。
        //
        // 用途：回合尾部的「改动文件卡」。上游拿这个 seq 去读 **Host 内存态**的改动摘要
        //（`GET /api/changes.summary?sessionId&seq`）—— Host 重启或会话被释放后摘要就没了，
        // **那张卡也就不出现**（`docs/design/12` §2.1.7）。宣告事件本身在日志里一直都在，所以 seq 一直都在；
        // 「有没有卡」由宿主按这个 seq 去问 Host 决定（见 `dsh/changes-summary.ts`）。
        //
        // ⚠️ 按行扫一遍而**不是**只认「当前活跃行」：同回合被插话切成的多条行都要拿到同一个 seq。
        if (type === 'workspace/changes') {
            const turn = typeof d['turn'] === 'number' ? (d['turn'] as number) : undefined;
            const seq = typeof event.seq === 'number' ? event.seq : undefined;
            if (turn !== undefined && seq !== undefined) {
                for (let i = 0; i < rows.length; i += 1) {
                    const r = rows[i];
                    if (r.kind === 'assistant' && r.turn === turn) {
                        rows[i] = { ...r, changesSeq: seq };
                    }
                }
            }
            continue;
        }

        if (type === 'deliverables/presented') {
            // 模型显式声明的交付文件。**回合归属认事件自带的 `turn`**，不认「当前活跃行」——
            // 声明可以来自嵌套调用，按活跃行归集会在那种情形下串到别的回合去。
            const turn = typeof d['turn'] === 'number' ? (d['turn'] as number) : undefined;
            if (turn !== undefined && currentTurn !== undefined && turn !== currentTurn) {
                continue;
            }
            const row = activeRow();
            if (row === undefined || !Array.isArray(d['files'])) {
                continue;
            }
            let changed = false;
            for (const entry of d['files'] as unknown[]) {
                const f = entry as { path?: unknown; description?: unknown } | null | undefined;
                const p = stringOf(f?.path);
                if (p === undefined || p.trim() === '') {
                    continue;
                }
                const desc = stringOf(f?.description);
                // Map 的**写入不改已有键的位置**：同路径重复声明只换内容，顺序仍是首见那次的位置
                presentedByPath.set(p, desc === undefined ? { path: p } : { path: p, description: desc });
                changed = true;
            }
            if (changed) {
                // 随事件即时落行：声明到达得比回合结束早，页面不必等 turn/end 才看得到
                replaceActive({ ...row, presentedFiles: [...presentedByPath.values()] });
            }
            continue;
        }

        if (type === 'llm/retry') {
            // 重试会重置该步累积的块，同时算一次「其它证据」（上游两处都用到它）
            processInput.entries.push({
                kind: 'retry',
                seq: typeof event.seq === 'number' ? event.seq : undefined,
                step: typeof d['step'] === 'number' ? (d['step'] as number) : undefined,
            });
            // 行：只有 `retry === 1` 能开链（窗口里缺首条 → 整链不渲染，与上游同）；其余只更新该行
            const retryId = typeof d['retryId'] === 'string' ? d['retryId'] : '';
            const retry = typeof d['retry'] === 'number' ? d['retry'] : undefined;
            if (retryId !== '' && retry !== undefined) {
                const at = retryRowAt.get(retryId);
                const failure = retryFailure(d['failure']);
                const patch = {
                    retry,
                    ...(typeof d['turn'] === 'number' ? { turn: d['turn'] as number } : {}),
                    ...(typeof d['step'] === 'number' ? { step: d['step'] as number } : {}),
                    ...(typeof d['provider'] === 'string' ? { provider: d['provider'] } : {}),
                    ...(typeof d['mode'] === 'string' ? { mode: d['mode'] } : {}),
                    ...(typeof d['maxRetries'] === 'number' ? { maxRetries: d['maxRetries'] as number } : {}),
                    ...(typeof d['delayMs'] === 'number' ? { delayMs: d['delayMs'] as number } : {}),
                    ...(failure === undefined ? {} : { failure }),
                };
                if (at === undefined) {
                    if (retry === 1) {
                        retryRowAt.set(retryId, rows.length);
                        rows.push({ kind: 'retry', key: key++, retryId, ...patch });
                    }
                } else {
                    const row = rows[at] as Extract<DshStreamRow, { kind: 'retry' }>;
                    // 新尝试排上 → 上一次的"已开始"作废（`started` 记的是**哪一次**，见下）
                    const { started: _drop, cancelled: _drop2, ...rest } = row;
                    rows[at] = { ...rest, ...patch };
                }
            }
            continue;
        }

        if (type === 'llm/retry-started') {
            // 只做状态迁移：把**该序号**的那次尝试标成"已开始"（不新增行、不新增尝试，与上游同）
            const retryId = typeof d['retryId'] === 'string' ? d['retryId'] : '';
            const at = retryId === '' ? undefined : retryRowAt.get(retryId);
            if (at !== undefined) {
                const row = rows[at] as Extract<DshStreamRow, { kind: 'retry' }>;
                const retry = typeof d['retry'] === 'number' ? (d['retry'] as number) : row.retry;
                const { cancelled: _drop, ...rest } = row;
                rows[at] = { ...rest, started: retry };
            }
            continue;
        }

        if (type === 'turn/end') {
            // 重试行的 `cancelled` 是**派生态**（上游同）：回合关闭时仍停在 `scheduled` 就是"等待中被打断"
            for (const at of retryRowAt.values()) {
                const row = rows[at] as Extract<DshStreamRow, { kind: 'retry' }>;
                if (row.started !== row.retry && row.cancelled !== true) {
                    rows[at] = { ...row, cancelled: true };
                }
            }
            /**
             * **在途提问在回合关闭时结算**。
             *
             * 上游的 `ASK_ABORTED` 是**宿主**在回合的 abort 信号上抛出来的（提问 handler 被信号取消 →
             * `tool/result` 带着那个码落盘）。插件的实时链路拿不到那条信号：用户按停止后，
             * 这一侧只会看到 `turn/end`，于是提问项**永远停在 `running`** —— 表现是回合已经「已停止」，
             * 那一行却还在掠光并写着「等待回答」。
             *
             * 判据取「回合已关闭 + 该提问仍无结果」：这时它**不可能**再被回答，按上游同语义标成
             * 已中断（琥珀，不是失败）。**只动提问工具** —— 其余工具的"运行中"由各自的卡与宿主状态表达。
             */
            const reasonEarly = d['reason'] as { kind?: string } | undefined;
            const closedByAbort = reasonEarly?.kind === 'aborted';
            for (let i = 0; i < rows.length; i += 1) {
                const row = rows[i];
                if (row.kind !== 'assistant') {
                    continue;
                }
                let touched = false;
                const chain = row.chain.map((c): DshRowItem => {
                    if (c.kind !== 'tool' || c.name !== 'ask_user_question') {
                        return c;
                    }
                    if (c.status !== 'running' && c.status !== 'preparing') {
                        return c;
                    }
                    touched = true;
                    return {
                        ...c,
                        status: 'stopped' as const,
                        // 用户主动停止 → 与上游同一码；其余终局（正常收官却仍悬着）按"回合已中断"记
                        error: closedByAbort ? 'ASK_ABORTED' : c.error,
                    };
                });
                if (touched) {
                    rows[i] = { ...row, chain };
                }
            }
            const reason = d['reason'] as { kind?: string } | undefined;
            const kind = reason?.kind;
            // 失败事实（code/message）照上游两处口径，收在 `official/turn-end.ts`：
            // AUTH 只留 code 不留 message、`aborted` + hook(signed-out) 合成 ACCOUNT_SIGNED_OUT。
            // 中文按 code 决议在页面（`webview/chat/core/turn-copy.ts`）。
            const failure = turnEndFailure(reason);
            // 终局通知（独立行）：失败（`turn-error`）或输出 token 上限（`turn-max-tokens`）——两者互斥。
            // 先占 key，等回答行收完再 push —— 顺序 = 该回合末尾。
            const noticeTone = failure !== undefined ? 'error' : kind === 'max-tokens' ? 'warning' : undefined;
            const noticeKey = noticeTone === undefined ? undefined : key++;
            let row = activeRow();
            if (row === undefined) {
                // 这一轮**没产出过内容**（请求期就失败之类）。上游对这种回合**照样有回合级控制节点**
                //（「处理失败」/「已停止」就写在那一格），所以这里补出这一轮的容器行：正文与链都空，
                // 只承回合事实，下面那段照常把它标成 `done` + `status`。
                // 不补的后果（真机截图）：只剩重试行与终局通知行，控制行那一格**什么都没有**。
                openAssistant();
                row = activeRow();
                if (row === undefined) {
                    if (noticeTone !== undefined && noticeKey !== undefined) {
                        pushTurnNotice(noticeKey, noticeTone, failure);
                    }
                    continue;
                }
            }
            // 折叠事实：口径全在 `turn-process.ts`（上游 `latestAnswer` / `processSpec` 的镜像），
            // 这里只把回合边界补进输入再取结果。
            processInput.turnEndSeq = typeof event.seq === 'number' ? event.seq : undefined;
            const processFacts = deriveTurnProcess(processInput);
            const answerStep = processFacts?.answerStep ?? undefined;
            // 统计（用量 + 用时）：**用时与用量各自独立**（上游同口径）——
            //   · **用时**只看本回合的 `turn/start`/`turn/end` 时刻，**与有没有定稿回答无关**：
            //     被停止 / 收在工具调用上的回合照样有总用时（真机实测：287 条历史行里 43 条缺用时，
            //     根因就是这里被下面的 `closingRow` 门一起吞掉了，见 `14` §10）；
            //   · **用量**要求「任一已定稿步里、最后一条带非空文本的回答」（上游 `closing`）：
            //     没有它就没有用量。两者缺一即各自不显示，不互相牵连。
            // ⚠️ **与折叠判据不是同一条**：折叠要求「最后一步 + 有回答内容 + 不含工具调用」；
            // 这里**两者都不要求**（末步含工具调用、或回答不在末步，都照样给统计）。
            const closingRow = [...turnMessages].reverse().find((m) => m.hasReply);
            const stats = buildStats(turnEvents, closingRow !== undefined);
            // 非回答步的文本进过程链：上游每步一个文本节点，而插件一回合只开一条行 ——
            // 不把它们放进链，中间步的正文就会被后来那条**整条覆盖**、整段消失（真机现象）。
            // 位置规则集中在 `appendStepText`（该步有工具时插在首个工具之前）。
            // 折叠计数的消息数（上游口径）：**无回答时用全量、不减**；有回答时只累加回答步**之前**的步。
            // 原实现「带文本步数 − 1」在无回答的回合（报错/中断/末步含工具）必然少 1。
            // 回答步未知（`step` 缺失）时按"无回答"处理 —— 与上游的减法在缺少步号时的结果一致。
            const messageCount =
                answerStep === undefined
                    ? [...replyMsgByStep.values()].reduce((a, b) => a + b, 0)
                    : [...replyMsgByStep].reduce(
                          (a, [st, c]) => (st !== undefined && st < answerStep ? a + c : a),
                          0
                      );
            // **哪一步的文本是「最终回答」**（留在正文里）：
            // 只有过程事实给出的**回答步**（上游 `latestAnswer`：末步 + 已定稿 + 有回答内容 + **不含工具调用**）
            // 才算回答。它缺失时（末步在调工具、纯工具回合、被中断的回合）**正文必须为空** ——
            // 此时上游没有正文节点，模型在步骤之间说的话全都是过程节点。
            // ⚠️ 曾经的兜底是「退到最后一条有文本的步」，那会把一段**步骤说明**当成回答、从工具行之间
            // 拽到对话区最下面（真机现象：「工具行的文字跑到下面去了 / 不显示了」），已于 2026-09-19 撤掉。
            const answerText = answerStep === undefined ? '' : (stepTexts.get(answerStep) ?? '');
            let chain = row.chain;
            const toChain: Array<[number | undefined, string]> = [];
            for (const [step, t] of stepTexts) {
                // 回答步的文本就是正文；**没有回答时（`answerStep === undefined`）所有文本都进链**
                if (t === '' || (answerStep !== undefined && step === answerStep)) {
                    continue;
                }
                // 被插话切开的前段：那条行已经显示了这段正文，不能再当过程文本重复进链（否则同一段出现两遍）
                if (closedSegmentTexts.includes(t)) {
                    continue;
                }
                // 流式期间已经把它固定到链上了（**按 key 核实**，不是查"插过没有"的标记）：不再补一次
                if (stepTextOnChain(step)) {
                    continue;
                }
                // 链上已有同文本的文本项（历史快照与实时帧混装时的兜底）：不重复插
                if (chain.some((c) => c.kind === 'text' && c.text === t)) {
                    continue;
                }
                toChain.push([step, t]);
            }
            /**
             * 若流式期间**误把最终回答**当过程文本插进了链（当时还不知道哪一步是回答），把它取回来：
             * 否则界面上同一段文字会「链里一份、正文一份」。
             *
             * ⚠️ **必须按「步号 + 文本」匹配，不能只按文本**：回答的文字常常与前面某一步一字不差
             * （模型在中间步骤说过同样的话，最后又把它当答案复述一遍）。只按文本匹配会删掉**前面那一步**
             * 的那份 —— 那正是"步骤说明"该待的位置；而回答步自己那份留在链上，于是渲染成
             * **「同一段文字：工具行下面一份 + 正文一份」**（真机事故：文字跑到工具行下面去了、还重复）。
             *
             * **同时摘掉 `appendedStepText` 里那条记录** —— 它记的是"这一步的文本还在链上"的证据，
             * 取走之后就不再成立了；留着会让后面误以为"已在链上"而跳过补插（就是「文字整段消失」那个坑）。
             */
            if (answerText !== '' && answerStep !== undefined) {
                const at = chain.findIndex((c) => c.kind === 'text' && c.step === answerStep && c.text === answerText);
                if (at !== -1) {
                    chain = chain.slice(0, at).concat(chain.slice(at + 1));
                    // `appendedStepText` 是"这一步的文本还在链上"的**证据**，取走之后就不再成立。
                    // 不留悬空的旧 key：那条 key 已经不指向任何链项，后面 `stepTextOnChain` 会判成"不在链上"
                    // 而补插一次（重复），或者反过来误判成"在链上"而漏插（整段消失）。重核一遍最稳。
                    const live = stepTextItemKey(answerStep);
                    if (live === undefined) {
                        appendedStepText.delete(answerStep);
                    } else {
                        appendedStepText.set(answerStep, live);
                    }
                }
            }
            // 正文与链一起落地：正文**无条件**设为上面判定出的回答文本（没有回答时就是空串 ——
            // 流式期间正文装的是"当前这一步"，回合结束时必须按答案判据收口）。
            if (answerText !== row.text) {
                replaceActive({ ...row, text: answerText });
            }
            if (toChain.length > 0) {
                // 同一步的文本合成一条：保持与工具/思考的交错顺序（位置规则见 `appendStepTexts`）
                const byStep = new Map<number | undefined, string[]>();
                for (const [step, t] of toChain) {
                    byStep.set(step, [...(byStep.get(step) ?? []), t]);
                }
                for (const [step, texts] of byStep) {
                    const keys = appendStepTexts(step, texts);
                    if (keys.length > 0) {
                        appendedStepText.set(step, keys[keys.length - 1]);
                    }
                }
                chain = activeRow()?.chain ?? chain;
            }
            // 链按步归位（同一步聚成一块、块内文本在前）：三条入链路径的到达次序与步的次序无关，
            // 统一在这里排一次才能保证与网页端一致的交错（理由见 `reorderChainByStep`）。
            flushSettledStepText();
            chain = reorderChainByStep(activeRow()?.chain ?? chain);
            replaceActive({
                ...row,
                text: answerText,
                chain,
                done: true,
                status: kind !== undefined && kind !== 'completed' ? kind : undefined,
                // 消息数 = 带文本的步数 **减 1**（去掉最终答复本身，答复另有正文区展示）——与既有口径一致
                counts: {
                    toolCallCount,
                    messageCount,
                    subagentCount,
                },
                ...(stats !== undefined ? { stats } : {}),
                ...(lastTimeMs !== undefined ? { timeMs: lastTimeMs } : {}),
                // 回答锚点：没有回答（报错/中断/末步在调工具）时不带，消费方据此隐藏「分叉」「反馈」
                ...(replySeq === undefined ? {} : { seq: replySeq }),
                ...(replyMessageId === undefined ? {} : { messageId: replyMessageId }),
                // 没有过程证据时不带该字段（上游此时连控制条节点都没有）——消费方据此退回不折叠
                ...(processFacts === null ? {} : { process: processFacts }),
            });
            // 终局通知行排在回答行**之后**（该回合末尾）——上游 `turn-error` 的排序键就是 `turn/end` 的 seq
            if (noticeTone !== undefined && noticeKey !== undefined) {
                pushTurnNotice(noticeKey, noticeTone, failure);
            }
            active = -1;
            liveStep = undefined;
            // 本回合在此收官：下一个 `turn/start` 处即可封存断点（见循环开头）。
            closedAtPreviousTurn = true;
            // 过程事实与折叠计数是**回合级**的（上游一份 `turn-process` 规格，所有节点同看）：本回合若被插话
            // 切成多段行，剩下的段也要拿到同一份 —— 否则那些行没有 `process`，判据链第一道门就不过，
            // 页面按回合归组时它们不跟随折叠头的展开态（真机现象：插话过的回合「折叠又没了」）。
            //
            // ⚠️ **`groups` 要按行过滤**（2026-10-02 · `14` §6.3 的 (a)）：组的步号区间是**整回合**的，
            // 而每条行只持有自己那截链 —— 直接把整份组发给短链行，那些"别的段"的组在页面侧一个项都收不到，
            // 切片因此对不上、整条退回整回合单头（实测 30 会话 199 条带 `groups` 的行里 13 条这样）。
            // 过滤后一个组都不剩时**不带这个键**，该行走既有的"整回合一条头"路径。
            if (processFacts !== null && currentTurn !== undefined) {
                const turnGroups = processFacts.groups;
                for (let i = 0; i < rows.length; i += 1) {
                    const r = rows[i];
                    if (r.kind === 'assistant' && r.turn === currentTurn && r.key !== row.key) {
                        const ownGroups = turnGroups === undefined
                            ? undefined
                            : filterGroupsForChain(turnGroups, stepsOfChain(r.chain), processFacts.answerStep);
                        const facts = ownGroups === undefined
                            ? (() => {
                                  // 不带 `groups` 键（而不是给它一个空数组）：消费方据此判定"没有分组事实"
                                  const { groups: _dropped, ...rest } = processFacts;
                                  return rest;
                              })()
                            : { ...processFacts, groups: ownGroups };
                        rows[i] = { ...r, process: facts, counts: { toolCallCount, messageCount, subagentCount } };
                    }
                }
            }
            // 诊断（`DSH_RAWLOG=full`）：一轮收尾时把**行的构成**打一行 ——
            // 「工具行看不到内容 / 只出一条」这类问题，先看这里宿主到底出了几条、链上有没有它们。
            // `last={…}` 是**动作条三项的取值现场**：反馈图标要 `msgId`、用量/用时要 `stats`，
            // 三者都不显示时看这里就知道是宿主没给、还是页面没画。
            if (process.env['DSH_RAWLOG'] === 'full') {
                const shape = rows.map((r) => r.kind === 'assistant'
                    ? `assistant[${r.chain.map((c) => (c.kind === 'tool' ? `tool:${c.name}${c.output === undefined ? '' : '(有输出)'}` : c.kind)).join('|')}]`
                    : r.kind);
                const last = [...rows].reverse().find((r): r is AssistantRow => r.kind === 'assistant');
                // `turnMsgs` 是**动作条三项的共同来源**：反馈图标要 `msgId`、分叉要 `seq`、用量/用时要 `stats`，
                // 三者都来自「本回合收到过带回答内容的 assistant/message 结算」。这一格为空，就是结算没进窗口。
                const facts = last === undefined
                    ? 'none'
                    : `done=${String(last.done)} seq=${String(last.seq)} msgId=${last.messageId ?? '(无)'} ` +
                      `stats=${last.stats === undefined ? '(无)' : Object.keys(last.stats).join('+') || '(空)'} ` +
                      `presented=${String(last.presentedFiles?.length ?? 0)}`;
                const settled = turnMessages.filter((m) => m.hasReply).length;
                console.log(
                    `[dsh-raw] turn/end rows=${shape.join(',')} toolCalls=${String(toolCallCount)} ` +
                        `turnMsgs=${String(turnMessages.length)}(hasReply=${String(settled)}) last={${facts}}`
                );
            }
        }
    }

    // 校验（按需开启，见 `BuildRowsOptions.verify`）：同时跑一次全量重折并逐字节比对。
    // **只在复用旧断点时才有意义**（没有旧断点就是全量，校验自己等于白跑一遍），
    // 且**必须晚于**本次到达的新断点计算 —— 否则会把刚封存的那份一并丢掉（曾经如此：
    // 校验一开，断点永远传不下去，增量优化静默失效）。
    // 不一致就**以全量为准、丢弃全部断点**：宁可慢一轮，也不让正文悄悄错一段。
    if (options.verify === true && usable) {
        const full = buildRows(events);
        const a = JSON.stringify(rows);
        const b = JSON.stringify(full);
        if (a !== b) {
            if (process.env['DSH_ROWS_DEBUG'] !== undefined) {
                let d = 0;
                while (d < a.length && a[d] === b[d]) {
                    d += 1;
                    console.warn(`[dsh-ckpt] 不一致 @${String(d)}：${a.slice(Math.max(0, d - 80), d + 120)}  ≠  ${b.slice(Math.max(0, d - 80), d + 120)}`);
                }
            }
            console.warn('[dsh-rows] 断点折叠与全量折叠不一致：以全量结果为准并丢弃断点');
            return { rows: full, checkpoint: undefined };
        }
    }
    return { rows, checkpoint: promoted };
}
