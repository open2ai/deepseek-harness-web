// 事件流的行构建（适配上游 0.1.5-rc.2）：把事件序列归约成**行模型**。
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
import { createTurnProcessInput, deriveTurnProcess } from './turn-process';
import { createInboxClaimFold } from './inbox-claims';
import type { DshPresentedFile, DshRowItem, DshStreamEvent, DshStreamRow } from './types';

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

/** 把事件序列归约为行。语义与既有实时通路一致：正文增量累加、结算事件整条覆盖；思考同 step+index 续接。 */
export function buildRows(events: readonly DshStreamEvent[]): DshStreamRow[] {
    const rows: DshStreamRow[] = [];
    let key = 1;
    /** 当前未定稿的回答行下标；-1 = 没有在跑的回合 */
    let active = -1;
    /** 活跃 attempt 所在步：**只有 start 帧带 step**，增量帧没有 —— 不缓存则同一次推理的增量各成一段 */
    let liveStep: number | undefined;
    /** 当前 `row.text` 里装的是**哪一步**的正文（见 applyChunk：正文按步累积，跨步不接） */
    let liveTextStep: number | undefined;
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
    /** 本回合各步在链上的**首个**项下标：过程文本按步插到它之前（保持与工具/思考的交错顺序） */
    const stepFirstChainIdx = new Map<number | undefined, number>();
    /** 记下某步的首个链项位置（只记第一次）。 */
    const noteChainStep = (step: number | undefined, at: number): void => {
        if (!stepFirstChainIdx.has(step)) {
            stepFirstChainIdx.set(step, at);
        }
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
        noteChainStep(step, row.chain.length);
        replaceActive({ ...row, chain: [...row.chain, { kind: 'tool', key: key++, step, callId, name, argsRaw, status: 'running' }] });
    };

    /**
     * 增量块落行：**实时帧与历史展开事件共用这一处** —— 两者同义，只是包装不同
     * （实时是 `assistant-stream` 帧的 `frame.chunk`；历史是内部标签 `assistant/chunk` 的 `data.chunk`）。
     */
    const applyChunk = (
        chunk: { type?: string; text?: string; index?: number } | undefined,
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
        // 段标识取**块**序号（chunk 自带，同一次推理的各增量共享它）；
        // 帧顶层的 index 是**帧序号**、逐帧递增，拿它判段会让每个增量各成一段。
        const index = typeof chunk.index === 'number' ? chunk.index : undefined;
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
            // 正文按**步**累积：一步的文本就是那一步的正文。跨步直接往同一行上接，
            // 会把两步的话连成一段（真机现象：插件里连着两句、网页端只显示当前这一步那句）。
            // 步变了就从这一步从零开始 —— 上一步的文本在回合结束时进过程链，不会丢。
            const base = liveTextStep === step ? row.text : '';
            liveTextStep = step;
            replaceActive({ ...row, text: base + delta });
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
                const hit = payload.callId !== undefined ? c.callId === payload.callId : c.status === 'running';
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

    /** 组装用量 / 用时（**计算**一律交给 official/turn-stats，这里只按页面要的形状组一份）。 */
    const buildStats = (seq: readonly TurnLikeEvent[]): Record<string, unknown> | undefined => {
        const usage = deriveTurnTokenUsage(seq);
        const facts = deriveTurnFacts(seq);
        // 本轮是哪个 turn：用时那边的 runMs 只要有 turn 起止时刻就有，
        // 拿它当锚（用量不可证时它仍在）；都没有才算这一轮没有任何统计。
        const turnKey = [...facts.runMs.keys()].pop() ?? [...usage.keys()][0];
        if (turnKey === undefined) {
            return undefined;
        }
        const out: Record<string, unknown> = {};
        const u = usage.get(turnKey);
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

    for (const event of events) {
        const type = event.type ?? '';
        const d = event.data ?? {};
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
            processInput.entries.push({
                kind: type === 'step/start' ? 'step' : 'step-end',
                seq: typeof event.seq === 'number' ? event.seq : undefined,
                step: typeof d['step'] === 'number' ? (d['step'] as number) : undefined,
            });
        }

        // 收件箱 splice：只喂给「插话判定」的折叠（不产出行）。**必须排在 user/message 之前** ——
        // 它决定紧随其后的那条人类消息算不算插话（按事件顺序取「当时」的状态，不是事后整表判断）。
        if (type === 'agent/inbox/spliced') {
            inboxFold.accept(event);
            continue;
        }

        if (type === 'user/message') {
            if (isContextMessage({ type: 'user/message', data: d })) {
                // 系统提示词形态（instructions）不入链：它由 system/message 那条单独承载
                const form = contextForm(d['source']);
                if (form === 'instructions') {
                    continue;
                }
                // 上下文注入属于**过程**：入当前回答行的链（与既有通路一致，见 design/06 §2「过程折叠内」）
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
                };
                replaceActive({ ...row, chain: [...row.chain, item] });
                // 上下文注入也是一个过程节点（上游的独立节点类型里不含它 → 落在区间内即算「过程外置」）
                if (typeof event.seq === 'number') {
                    processInput.entries.push({ kind: 'context', seq: event.seq });
                }
                continue;
            }
            const source = d['source'] as { kind?: string; rpcId?: string } | undefined;
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
            turnMessages.push({
                seq,
                step: typeof d['step'] === 'number' ? (d['step'] as number) : undefined,
                ...facts,
            });
            // 过程证据交给派生模块归类（「每步首条**可见** assistant 证据」），这里只登记事件
            processInput.entries.push({
                kind: 'message',
                seq,
                step: typeof d['step'] === 'number' ? (d['step'] as number) : undefined,
                hasReply: facts.hasReply,
                hasReasoning: facts.hasReasoning,
                hasToolCall: facts.hasToolCall,
            });
            lastTimeMs = timeOf(event);
            if (text !== '') {
                // 消息数按**步**去重：同一步的多条消息算一条（与既有口径一致）
                const msgStep = typeof d['step'] === 'number' ? (d['step'] as number) : undefined;
                // 折叠计数只数**有回答内容**的消息，且只认 append 结算（replace 语义的不算）——上游同口径
                const isAppend = event.surfaceOp === undefined || event.surfaceOp === 'append';
                if (facts.hasReply && isAppend) {
                    replyMsgByStep.set(msgStep, (replyMsgByStep.get(msgStep) ?? 0) + 1);
                    // 回答锚点随之推进（只取 id 非空的那条：null id 的消息在服务端不构成反馈目标）
                    replySeq = seq;
                    const id = (d['message'] as { id?: unknown } | undefined)?.id;
                    replyMessageId = typeof id === 'string' && id !== '' ? id : undefined;
                }
                // 各步文本都留着：回合结束时回答步的那条当正文，其余进过程链（否则被整条覆盖后消失）
                stepTexts.set(msgStep, text);
                // 已被插话切开的前段行已经显示过这条文本：不再写进当前（后段）的正文，否则内容串段
                // （正常事件顺序下前段的结算先到、插话后到，这里是兜底）
                if (!closedSegmentTexts.includes(text)) {
                    replaceActive({ ...row, text });
                }
            }
            continue;
        }

        if (type === 'tool/call') {
            // `toolName` 是同义兜底字段（既有实时通路即 `name ?? toolName`）：只认一个会让这类调用整条不出现
            const name = stringOf(d['name']) ?? stringOf(d['toolName']) ?? '';
            if (name === '') {
                continue;
            }
            // subagent 委派单独计数、不进工具数（与上游同口径）
            if (name === 'subagent' || name.startsWith('subagent_')) {
                subagentCount += 1;
            } else {
                toolCallCount += 1;
            }
            // 工具调用是过程节点，也是控制锚的「其它证据」之一
            processInput.entries.push({
                kind: 'tool-call',
                seq: typeof event.seq === 'number' ? event.seq : undefined,
                step: typeof d['step'] === 'number' ? (d['step'] as number) : undefined,
            });
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
            continue;
        }

        if (type === 'turn/end') {
            const row = activeRow();
            if (row === undefined) {
                continue;
            }
            const reason = d['reason'] as { kind?: string; error?: { message?: unknown; code?: unknown } } | undefined;
            const kind = reason?.kind;
            // 错误详情照上游的规范化口径：只取 `reason.error.message`（**不回退 `reason.message`** ——
            // 它不是 error 分支的上游字段），缺 message 时退化为该对象的文本；
            // 且 **`code === 'AUTH'` 时置空** —— 原始失败可能含凭据，不进 UI。
            const errObj = reason?.error;
            const errCode = typeof errObj?.code === 'string' ? errObj.code : undefined;
            const endMsg =
                kind !== 'error' || errObj === undefined
                    ? undefined
                    : errCode === 'AUTH'
                      ? undefined
                      : (stringOf(errObj.message) ?? JSON.stringify(errObj));
            // 折叠事实：口径全在 `turn-process.ts`（上游 `latestAnswer` / `processSpec` 的镜像），
            // 这里只把回合边界补进输入再取结果。
            processInput.turnEndSeq = typeof event.seq === 'number' ? event.seq : undefined;
            const processFacts = deriveTurnProcess(processInput);
            const answerStep = processFacts?.answerStep ?? undefined;
            // 统计（用量 + 用时）的门控照上游的 `closing`：**任一已定稿步里、最后一条带非空文本的回答**
            // —— 没有它就**整个尾部动作区都不渲染**（用量与用时一起没有），不是分别判字段有没有值。
            // ⚠️ **与折叠判据不是同一条**：折叠要求「最后一步 + 有回答内容 + 不含工具调用」；
            // 这里**两者都不要求**（末步含工具调用、或回答不在末步，都照样给统计）。
            const closingRow = [...turnMessages].reverse().find((m) => m.hasReply);
            const stats = closingRow === undefined ? undefined : buildStats(turnEvents);
            // 非回答步的文本进过程链：上游每步一个文本节点，而插件一回合只开一条行 ——
            // 不把它们放进链，中间步的正文就会被后来那条**整条覆盖**、整段消失（真机现象）。
            // 按步插到该步首个链项之前，保持与思考/工具的交错顺序。
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
            const pendingTexts = new Map<number | undefined, string>();
            for (const [step, t] of stepTexts) {
                if (answerStep !== undefined && step === answerStep) {
                    continue; // 回答步的文本就是正文
                }
                // 被插话切开的前段：那条行已经显示了这段正文，不能再当过程文本重复进链（否则同一段出现两遍）
                if (t !== '' && closedSegmentTexts.includes(t)) {
                    continue;
                }
                // 回答步**判不出来**时（`answerStep` 缺失：末步含工具调用等），最后那条带文本的结算
                // 仍然充当了正文 —— 同一条文本不能再进链，否则界面上正文会出现两遍
                //（真机现象：工具行里又出现一份和正文一样的文字）。
                if (t !== '' && t === row.text) {
                    continue;
                }
                pendingTexts.set(step, t);
            }
            let chain = row.chain;
            if (pendingTexts.size > 0) {
                // 插点：该步有工具调用时落在**首个工具项之前**，否则落在该步最前。
                // **这是插件的适配、不是上游规则** —— 上游按 `anchorSeq` 排序（它持有块次序），
                // 插件按「块里 tool-call 排在 text 之后」这个实测次序近似成「插在工具之前」。
                const stepsWithTool = new Set<number | undefined>();
                for (const item of row.chain) {
                    if (item.kind === 'tool') {
                        stepsWithTool.add((item as { step?: number }).step);
                    }
                }
                const out: DshRowItem[] = [];
                for (const item of row.chain) {
                    const st = (item as { step?: number }).step;
                    const t = pendingTexts.get(st);
                    const isAnchor = item.kind === 'tool' || !stepsWithTool.has(st);
                    if (t !== undefined && isAnchor) {
                        out.push({ kind: 'text', key: key++, step: st, text: t });
                        pendingTexts.delete(st);
                    }
                    out.push(item);
                }
                for (const [step, t] of pendingTexts) {
                    out.push({ kind: 'text', key: key++, step, text: t });
                }
                chain = out;
            }
            replaceActive({
                ...row,
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
                ...(endMsg !== undefined ? { endMsg } : {}),
                // 回答锚点：没有回答（报错/中断/末步在调工具）时不带，消费方据此隐藏「分叉」「反馈」
                ...(replySeq === undefined ? {} : { seq: replySeq }),
                ...(replyMessageId === undefined ? {} : { messageId: replyMessageId }),
                // 没有过程证据时不带该字段（上游此时连控制条节点都没有）——消费方据此退回不折叠
                ...(processFacts === null ? {} : { process: processFacts }),
            });
            active = -1;
            liveStep = undefined;
            // 过程事实与折叠计数是**回合级**的（上游一份 `turn-process` 规格，所有节点同看）：本回合若被插话
            // 切成多段行，剩下的段也要拿到同一份 —— 否则那些行没有 `process`，判据链第一道门就不过，
            // 页面按回合归组时它们不跟随折叠头的展开态（真机现象：插话过的回合「折叠又没了」）。
            if (processFacts !== null && currentTurn !== undefined) {
                for (let i = 0; i < rows.length; i += 1) {
                    const r = rows[i];
                    if (r.kind === 'assistant' && r.turn === currentTurn && r.key !== row.key) {
                        rows[i] = { ...r, process: processFacts, counts: { toolCallCount, messageCount, subagentCount } };
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

    return rows;
}
