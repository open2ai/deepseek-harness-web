// dsh 0.1.7+ 会话域：follow 事件模型/快照、session/model 操作、workspace 枚举（自 v0.1.15 起只支持 0.1.7+）。
import * as crypto from "node:crypto";
import { openMuxStream, rpcCall } from "./api";
import { deriveTurnTokenUsage, deriveTurnFacts, type TurnLikeEvent } from "./official/turn-stats";
import { expandAssistantStream } from "./official/assistant-stream";
import { parseExitStatus } from "./official/exit-status";
import { fileRefsOf, hasImageBlock, imageRefsOf, readToolResult, resultText, textOnly, type FileRef, type ImageRef } from "./official/result-text";
import { toolStatusOf } from "./official/tool-status";
import { contextForm, contextProvenance, isContextMessage } from "./official/context-projection";
import { readSystemPrompt } from "./official/system-prompt";
import { isEmptyProjections, projectionValuesOf } from "./projections";
// ---------- 会话事件模型（dsh v0.1.5-rc.2 follow 载荷形状） ----------
export type DshContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }
    // 文件附件：只带**上传凭据**（字节早已由上传通道交给 dsh）
    | { type: 'file'; receiptId: string };
/** 一条原始会话事件（v0.1.5-rc.2 的 follow/snapshot 载荷轻量表示）。 */
export interface RawEvent {
    type: string;
    seq: number;
    time?: number;
    data?: Record<string, unknown>;
    surfaceOp?: unknown;
    sourceEventSeqs?: number[];
}
/** 从 follow item / 快照 record 里取出原始事件（record 可能是 { type:'event', event } 包装）。 */
export function toRawEvent(x: unknown): RawEvent | undefined {
    if (x === null || typeof x !== 'object') {
        return undefined;
    }
    const rec = x as { type?: unknown; event?: unknown };
    const raw = rec.type === 'event' && rec.event !== undefined ? rec.event : x;
    const r = raw as RawEvent;
    if (typeof r === 'object' && r !== null && typeof r.type === 'string' && typeof r.seq === 'number') {
        return r;
    }
    return undefined;
}
function textOfBlocks(content: unknown): string {
    const blocks = Array.isArray(content) ? content : [];
    let out = '';
    for (const part of blocks) {
        const p = part as { type?: string; text?: string };
        if (p && p.type === 'text' && typeof p.text === 'string') {
            out += p.text;
        }
    }
    return out;
}
export function usageOf(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const usage = data?.['usage'];
    return usage !== null && typeof usage === 'object' ? (usage as Record<string, unknown>) : undefined;
}
/** 事件自带文本（assistant/message 等）：取 message.content 或 content 的 text part 拼出。 */
export function eventText(event: RawEvent): string {
    const d = event.data ?? {};
    return textOfBlocks((d['message'] as { content?: unknown } | undefined)?.content ?? d['content']);
}
/**
 * 是否为“表层人类消息”（user/message 且 source.kind === 'user'；系统注入的 plugin 消息不算）。
 * 0.2.0 新增的 `'user-question-reply'`（timed 等待的迟到回答）同样不算人类消息：它当前**不可达**
 * （`tool-ask-user` 的 `mode` 默认 `legacy`），收口条件见 `rows/build.ts` 同处注释。
 */
function eventIsSurfaceHuman(event: RawEvent): boolean {
    if (event.type !== 'user/message') {
        return false;
    }
    const source = event.data?.['source'] as { kind?: string } | undefined;
    return source?.kind === 'user';
}
// ---------- follow 快照（历史 / 投影读取） ----------
interface FollowSnapshot {
    events: RawEvent[];
    projections: Record<string, unknown>;
    cursor: number;
    hasMore: boolean;
}
let legacyPackingReported = false;
/**
 * 旧代的历史 packing 行只报一次。
 *
 * 本插件自 v0.1.15 起只支持 dsh 0.1.7+：`{type:'chunks'}` 打包行是 0.1.5-rc.x 之前的上游存储形状
 * （上游 0.1.5 起就改内嵌 `data.stream`，本版连同展开器一并删除）。报告而不是静默跳过，
 * 是因为这条路的失效方式是「历史里少几行文本」——不说出来就查不到。
 */
function reportLegacyPackingRow(): void {
    if (legacyPackingReported) {
        return;
    }
    legacyPackingReported = true;
    console.warn(
        "[dsh-session] 收到 0.1.5 之前的历史 packing 行（`{type:'chunks'}`）：本插件自 v0.1.15 起只支持 dsh 0.1.7+，该行已跳过"
    );
}

/**
 * 快照记录 → 事件（按 `seq` 排序）。
 *
 * 跟随流的**首帧快照**与单独读快照共用这一份规整：两个入口各写一遍的话，
 * 「内嵌增量要不要展开」这类规则迟早只落在一半路径上（后果是那条路上的会话永远没有 TTFT/TPS）。
 */
export function snapshotRecordsToEvents(records: readonly unknown[]): RawEvent[] {
    const events: RawEvent[] = [];
    for (const r of records) {
        const rr = r as { type?: unknown } | undefined;
        if (rr && rr.type === 'chunks') {
            // 旧代（0.1.5-rc.x 之前）的 storage packing 行：上游 0.1.5 起已移除（增量改内嵌
            // `data.stream`，见下）。本插件自 v0.1.15 起只支持 0.1.7+，不再展开，只报告。
            reportLegacyPackingRow();
            continue;
        }
        const e = toRawEvent(r);
        if (!e) {continue;}
        // 上游 0.1.5 起，增量内嵌在结算事件的 data.stream（0.1.5-rc.2 的独立 assistant/chunk
        // 与 chunkrow packing 均已消失）。这里还原成内部标签 assistant/chunk，下游的文本累加
        // 与计时统计便无需区分两种编码。seq 借用结算事件的、并把合成事件排在它之前：
        // 增量本无持久 seq，而 Array.sort 自 ES2019 起保证稳定，借此保住既有次序
        // （先逐块累加，再由 assistant/message 分支用整条文本覆盖）。
        // assistant/attempt 是未提交可见消息的失败/取消尝试，其 stream 正是半截回答的来源。
        if (e.type === 'assistant/message' || e.type === 'assistant/attempt') {
            const turn = e.data?.['turn'];
            const step = e.data?.['step'];
            // 每个增量块必须有**自己的**序号：与父消息共用 `e.seq` 的话，入列那道「按 seq 去重」
            // 会把同一个 seq 的第 2 条起全部丢掉 —— 包括**父消息自己**（真机数据：288 条结算消息
            // 全被丢，于是正文为空、没有回答锚点与用量，链上的过程文本也一起消失）。
            // 序号取 `seq - 1/(k+1)`：落在 (seq-1, seq) 区间、随块序递增、永不等于任何整数 seq，
            // 与实时帧的合成序号同一手法（见 official/live-chunk-seq），排序后仍排在父消息之前。
            let k = 0;
            for (const tsc of expandAssistantStream(e.data?.['stream'])) {
                k += 1;
                events.push({
                    type: 'assistant/chunk',
                    seq: e.seq - 1 / (k + 1),
                    time: tsc.time,
                    data: { turn, step, chunk: tsc.chunk },
                });
            }
        }
        events.push(e);
    }
    events.sort((a, b) => a.seq - b.seq);
    return events;
}

/**
 * 打开一次 session/follow 并读到 snapshot 后即取消（适配上游 0.1.7-rc.2）。
 * 上游：session-controller 的流式远程 `session/follow`，首帧 snapshot 形如
 *   { header, cursor, records: SessionHistoryRecord[], hasMore, projections:{ asOfSeq, values } }，
 *   之后是实时事件帧。请求必须带 assistantStream: true：该开关是 0.1.5 新增的 opt-in，
 *   不开则服务端既不下发实时增量帧、snapshot 也不带 assistantStream 基线（实时侧同理，见 stream.ts）。
 *   records 现在清一色是 { type:'event', event } 包装：0.1.5-rc.2 的 { type:'chunks' } packing 行
 *   与独立 assistant/chunk 事件都已被上游移除，增量改为内嵌进结算事件的 data.stream（下面展开）。
 * @param maxMessages snapshot 里返回的“消息对齐”记录上限（与上游客户端同一页大小；见 `HISTORY_PAGE`）。
 */
/**
 * 历史分页的**一页**（与上游客户端同一套参数）：`maxMessages` 上限 500、至少 50 条计入预算的消息、
 * 至少跨过两个 `turn/start`，在同时满足两个下限的轮次开头停下。
 *
 * 为什么必须有 `turnWindow`：只给 `maxMessages` 时服务端会一路数满上限才切 —— 超长会话因此
 * 一次拿到几百条消息（实测 1.33M 事件 / 56 回合 → 全量重建 3.4 秒、载荷 20.5MB），打开就是白屏几秒。
 */
export const HISTORY_PAGE = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } } as const;
/** 「一路翻到某个回合」那一路的消息下限（上游同：跳转不复用普通分页的 50 条下限）。 */
export const JUMP_PAGE_MIN_MESSAGES = 200;

export async function readFollowSnapshot(sessionId: string, maxMessages: number = HISTORY_PAGE.maxMessages, timeoutMs = 10_000): Promise<FollowSnapshot> {
    return new Promise<FollowSnapshot>((resolve, reject) => {
        let done = false;
        let ctl: { cancel: () => void } | undefined;
        const finish = (snap: FollowSnapshot | undefined, err?: Error): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            try {
                ctl?.cancel();
            } catch {
                /* noop */
            }
            if (err || snap === undefined) {
                reject(err ?? new Error('DSH 读取会话快照失败'));
            } else {
                resolve(snap);
            }
        };
        const timer = setTimeout(() => finish(undefined, new Error('DSH 读取会话快照超时')), timeoutMs);
        void openMuxStream(
            'session/follow',
            {
                args: {
                    request: {
                        address: { kind: 'session', sessionId },
                        maxMessages,
                        // 同一套"至少两条轮次边界"的下限：没有它，服务端会一路数满 maxMessages 才切。
                        turnWindow: HISTORY_PAGE.turnWindow,
                        assistantStream: true,
                    },
                },
            },
            {
                onItem: (value) => {
                    const v = value as Record<string, unknown> | undefined;
                    if (!v || v['type'] !== 'snapshot') {
                        return;
                    }
                    const events = snapshotRecordsToEvents(Array.isArray(v['records']) ? v['records'] : []);
                    const proj = (v['projections'] as { values?: Record<string, unknown> } | undefined)?.values ?? {};
                    const cursor = typeof v['cursor'] === 'number' ? v['cursor'] : -1;
                    // 快照日志（回合前后差分实证用）：env DSH_RAWLOG=1/full，含累计投影数值
                    const snapLog = process.env['DSH_RAWLOG'];
                    if (snapLog) {
                        if (snapLog === 'full') {
                            console.log(
                                '[dsh-raw] snapshot-read ' +
                                    JSON.stringify({ cursor, hasMore: v['hasMore'] === true, projections: proj, eventSummaries: events.map((e) => `${e.seq}:${e.type}`) }).slice(0, 200_000)
                            );
                        } else {
                            console.log(
                                `[dsh-raw] snapshot-read cursor=${cursor} projKeys=${Object.keys(proj).join(',') || '(none)'} events=${events.length}`
                            );
                        }
                    }
                    finish({
                        events,
                        projections: proj,
                        cursor,
                        hasMore: v['hasMore'] === true,
                    });                },
                onError: (err) => finish(undefined, new Error(`DSH 会话快照失败：${err.message}`)),
                onEnd: () => finish(undefined, new Error('DSH 会话流意外结束')),
                onClose: () => finish(undefined, new Error('DSH 会话流关闭')),
            },
            timeoutMs
        )
            .then((c) => {
                ctl = c;
                if (done) {
                    c.cancel();
                }
            })
            .catch((e) => finish(undefined, e));
    });
}
/**
 * 恢复用消息历史（适配 dsh v0.1.7-rc.2）。
 * 上游：该版本无 `session.history` RPC；本方法经 `session/follow` 快照的 records 提取
 * “消息对齐”事件（SessionHistoryRecord），仅保留表层 human user/message 与 assistant/message，
 * 供恢复会话 UI 渲染（不含系统 plugin 注入消息与增量帧）。
 * 每条消息附带该事件自带的原始时间戳 `time`（epoch 秒/毫秒，由上游给出），页面据此显示真实时刻；
 * assistant 消息再附上该消息自带的 usage 与 provider/model（用量/用时图标据此显示，与实时同源）。
 */
/** 恢复会话里 assistant 回复的“过程动作”（思考/工具），供 UI 折叠展开（与实时 chatActivity 链同语义） */
export type DshHistoryTurnProcessItem =
    | { kind: 'reasoning'; text: string }
    | {
        kind: 'context';
        content: unknown[];
        source: unknown;
        provenance: { role: 'inject' | 'recall'; label: string | null };
        form: string | null;
    }
    | { kind: 'tool'; name: string; callId?: string; argsRaw?: string; status: 'running' | 'ok' | 'error' | 'stopped'; error?: string; output?: string; exitCode?: number; signal?: string; meta?: unknown;
        /** 结果原始内容块（**仅当结果含图片块时**带） */
        blocks?: unknown };
/** 过程折叠计数（上游口径，见 stream.ts DshTurnCounts 注释） */
export type HistoryCounts = { toolCallCount: number; messageCount: number; subagentCount: number };
export type SessionMessageItem =
    | {
        role: 'user';
        text: string;
        time?: number;
        /** 该回合实际发给模型的 system（上游 `system-prompt` 节点的数据源）；仅该回合第一条 user 行带 */
        systemPrompt?: string;
        /** 该用户消息带的图片附件引用（字节不在事件里，渲染时由附件层按需取） */
        images?: ImageRef[];
        /** 该用户消息带的上传文件（只有名字/大小；引用不含本地路径，历史里只展示不可点开） */
        files?: FileRef[];
    }
    | {
        role: 'assistant';
        text: string;
        time?: number;
        provider?: string;
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
        /** 由快照事件时间算出的该消息指标（与实时同口径：turn/end−turn/start、step/start→首 token、解码 span） */
        wallSec?: number;
        ttftSec?: number;
        tps?: number;
        /** 该回合的终止原因（上游 reason.kind 原值，如 aborted/interrupted），仅非正常终止的最后一条 assistant 有 */
        status?: string;
        /** 过程链：思考/工具（上游 content blocks 重建）；仅供 assistant 消息 */
        chain?: DshHistoryTurnProcessItem[];
        counts?: HistoryCounts;
    };
export async function getSessionMessages(sessionId: string): Promise<SessionMessageItem[]> {
    const snap = await readFollowSnapshot(sessionId);
    const out: SessionMessageItem[] = [];
    const round10 = (n: number): number => Math.round(n * 10) / 10;
    // 核心 per-turn 统计委托 src/dsh/official/turn-stats.ts；本函数只做“拆消息 + 附加结果”，保持薄
    const lastAsst = new Map<number, number>(); // turn -> out 中最后一条 assistant 下标
    const endStatus = new Map<number, string>(); // 非 completed 的 turn -> 状态(回显 kind)
    const turnContextItems = new Map<number, DshHistoryTurnProcessItem[]>(); // turn -> 该回合上下文注入项(并入链首)
    let openTurn: number | undefined; // 当前打开的 turn(seq 游标；context 事件无 turn，按区间归属)
    // 系统提示词(request/header)：**必须先单独扫一遍**再挂。
    // 原因：该事件在 turn 内、且**晚于**该回合的 user/message —— 上游正是因此才把锚点回退到 turn.start
    // （`request-prompt.ts` 的 requestPromptAnchor）。边扫边挂会赶不上那条 user 行，导致一条都挂不上。
    // 归属用 seq 游标（事件自身无 turn 字段）；若先于 turn/start 到达则暂存给下一个 turn。
    const promptByTurn = new Map<number, string>();
    {
        let cursor: number | undefined;
        let pending: string | undefined;
        // 系统提示词的跨事件状态：同一个 (turn, step) 只挂一次（见 stream.ts 同名字段）
        let lastSystem: { turn?: number; step?: number } | undefined;
        for (const e of snap.events) {
            const d = e.data ?? {};
            const t = typeof d['turn'] === 'number' ? (d['turn'] as number) : undefined;
            if (e.type === 'turn/start' && t !== undefined) {
                cursor = t;
                if (pending !== undefined) { promptByTurn.set(t, pending); pending = undefined; }
            } else if (e.type === 'turn/end' && t !== undefined) {
                cursor = undefined;
            } else if (e.type === 'system/message') {
                // 上游 0.1.5 起 system 的载体是这条独立事件（旧版在 request/header 的 header.system）。
                // 读法与去重共用 official/system-prompt.ts（与实时侧同一逻辑只写一份）
                const sp = readSystemPrompt(d);
                if (sp.text !== '' && (lastSystem?.turn !== sp.turn || lastSystem?.step !== sp.step)) {
                    lastSystem = { turn: sp.turn, step: sp.step };
                    if (cursor !== undefined) { promptByTurn.set(cursor, sp.text); }
                    else { pending = sp.text; }
                }
            }
        }
    }
    const partialText = new Map<number, string>();
    const finalTextTurns = new Set<number>();
    /** 出现过工具结果的回合：判断「没有结算消息的回合要不要合成回答行」用（纯过程回合）。 */
    const turnsWithToolResult = new Set<number>();
    const chunkPiece = (e: RawEvent): string => {
        const ch = e.data?.['chunk'] as { type?: string; text?: string; block?: { type?: string; text?: string } } | undefined;
        if (!ch) {return '';}
        if (ch.type === 'text-delta') {return typeof ch.text === 'string' ? ch.text : '';}
        if (ch.type === 'block-end' && ch.block?.type === 'text') {return typeof ch.block.text === 'string' ? ch.block.text : '';}
        return '';
    };
    for (const e of snap.events) {
        const d = e.data ?? {};
        const turn = typeof d['turn'] === 'number' ? (d['turn'] as number) : undefined;
        // seq 游标：上下文注入事件无 turn，落进当前打开的 turn(区间 [turn/start, turn/end])
        if (e.type === 'turn/start' && turn !== undefined) { openTurn = turn; }
        if (e.type === 'turn/end' && turn !== undefined) { openTurn = undefined; }
        if (turn !== undefined && e.type === 'tool/result') {
            turnsWithToolResult.add(turn);
        }
        // 累计该回合流式文本(半截终止但无最终 message 时用来合成回答行)
        if (turn !== undefined && e.type === 'assistant/chunk') {
            const piece = chunkPiece(e);
            if (piece) {
                partialText.set(turn, (partialText.get(turn) ?? '') + piece);
            }
        }
        if (eventIsSurfaceHuman(e)) {
            const content = e.data?.['content'];
            const text = textOfBlocks(content);
            const images = imageRefsOf(content);
            const files = fileRefsOf(content);
            // **只有附件没有文字也要出行**：否则「发一张图/一个文件」在历史里整条消失（实时路径有行、恢复后没有）
            if (text || images.length > 0 || files.length > 0) {
                // 系统提示词挂该回合第一条 user 行上（渲染时插在它之前）；带过即删，后续 user 行不重复
                const sysPrompt = openTurn !== undefined ? promptByTurn.get(openTurn) : undefined;
                if (sysPrompt !== undefined && openTurn !== undefined) { promptByTurn.delete(openTurn); }
                out.push({ role: 'user', text, time: e.time, systemPrompt: sysPrompt, ...(images.length > 0 ? { images } : {}), ...(files.length > 0 ? { files } : {}) });
            }
            continue;
        }
        // 上下文注入（source.kind !== 'user' 的 user/message）：并入该回合的 assistant 链(链首)，
        // 不单独作为时间线行。归属 turn = 事件自带 turn，否则落到当前打开的 turn(seq 游标)。
        // 系统提示词(agent-instructions, form==='instructions')走左上角常驻入口，不入链（否则只含它的链展开为空）。
        if (isContextMessage(e)) {
            const source = e.data?.['source'];
            if (contextForm(source) === 'instructions') { continue; }
            const ctxTurn = typeof d['turn'] === 'number' ? d['turn'] as number : openTurn;
            if (ctxTurn !== undefined) {
                const arr = turnContextItems.get(ctxTurn) ?? [];
                arr.push({
                    kind: 'context',
                    content: (Array.isArray(e.data?.['content']) ? e.data?.['content'] : []) as unknown[],
                    source,
                    provenance: contextProvenance(source),
                    form: contextForm(source),
                });
                turnContextItems.set(ctxTurn, arr);
            }
            continue;
        }
        if (e.type === 'assistant/message') {
            const text = eventText(e);
            if (text) {
                out.push({ role: 'assistant', text, time: e.time });
                if (turn !== undefined) {
                    lastAsst.set(turn, out.length - 1);
                    finalTextTurns.add(turn);
                    partialText.delete(turn);
                }
            }
            continue;
        }
        if (e.type === 'turn/end') {
            const kind = (d['reason'] as { kind?: string } | undefined)?.kind;
            if (kind && kind !== 'completed' && turn !== undefined) {
                endStatus.set(turn, kind); // 先回显核心 kind，不翻译
            }
            // 被打断/中止且无最终 assistant/message → 合成回答行，承担该回合的半截文本与过程链。
            // 条件必须放宽到「有半截文本 **或** 该回合出现过工具结果」：只认文本时，**纯过程回合**
            // （还没出正文就被停）会连 assistant 消息都不产出，而工具/思考行是挂在它上面的 → 整块一起丢。
            if (turn !== undefined && !finalTextTurns.has(turn)) {
                const partial = (partialText.get(turn) ?? '').trim();
                if (partial || turnsWithToolResult.has(turn)) {
                    out.push({ role: 'assistant', text: partial, time: e.time });
                    lastAsst.set(turn, out.length - 1);
                    partialText.delete(turn);
                }
            }
        }
    }
    // 核心 per-turn：用量 / TTFT/TPS / runMs 全部由模块算
    const usage = deriveTurnTokenUsage(snap.events as unknown as TurnLikeEvent[]);
    const facts = deriveTurnFacts(snap.events as unknown as TurnLikeEvent[]);
    for (const [turn, idx] of lastAsst) {
        const item = out[idx];
        if (!item || item.role !== 'assistant') {
            continue;
        }
        const st = endStatus.get(turn);
        if (st) {
            item.status = st;
        }
        // 用量 pill 与 用时 pill 各自独立：
        //  用量 只在可证 usage(deriveTurnTokenUsage 推得出)时填；推不出不显示用量
        //  用时(总用时/TTFT/TPS) 与 usage 无关，凡 runMs/metrics 有就填
        const u = usage.get(turn);
        if (u) {
            item.inputTokens = u.uncachedInputTokens;
            item.outputTokens = u.outputTokens;
            if (u.cacheReadTokens !== undefined) {item.cacheReadTokens = u.cacheReadTokens;}
            if (u.cacheWriteTokens !== undefined) {item.cacheWriteTokens = u.cacheWriteTokens;}
            if (u.reasoningTokens !== undefined) {item.reasoningTokens = u.reasoningTokens;}
            if (u.routes !== undefined && u.routes.length === 1) {
                item.provider = u.routes[0].provider;
                item.model = u.routes[0].model;
            }
        }
        const m = facts.metrics.get(turn);
        if (m) {
            if (m.ttftMs !== undefined) {item.ttftSec = round10(m.ttftMs / 1000);}
            if (m.tokensPerSecond !== undefined) {item.tps = Math.round(m.tokensPerSecond);}
        }
        const rm = facts.runMs.get(turn);
        // 不预舍入：保留精确 ms→s，展示端按上游整秒向下取整
        if (rm !== undefined) {item.wallSec = rm / 1000;}
    }
    // 调试：每回合计时诊断（env DSH_RAWLOG=full 才打）
    if (process.env['DSH_RAWLOG'] === 'full') {
        interface Cnt { step: number; td: number; rd: number; be: number; msg: number; ts: number; te: number;
            ss?: number; ftd?: number; frd?: number; msgT?: number; }
        const cnt = new Map<number, Cnt>();
        for (const e of snap.events) {
            const d = e.data ?? {};
            const turn = typeof d['turn'] === 'number' ? (d['turn'] as number) : undefined;
            if (turn === undefined) {continue;}
            const c = cnt.get(turn) ?? { step: 0, td: 0, rd: 0, be: 0, msg: 0, ts: 0, te: 0 };
            if (e.type === 'step/start') {c.step += 1; if (c.ss === undefined) {c.ss = e.time;}}
            else if (e.type === 'turn/start') {c.ts += 1;}
            else if (e.type === 'turn/end') {c.te += 1;}
            else if (e.type === 'assistant/chunk') {
                const ch = d['chunk'] as { type?: string } | undefined;
                if (ch?.type === 'text-delta') {c.td += 1; if (c.ftd === undefined) {c.ftd = e.time;}}
                else if (ch?.type === 'reasoning-delta') {c.rd += 1; if (c.frd === undefined) {c.frd = e.time;}}
                else if (ch?.type === 'block-end') {c.be += 1;}
            } else if (e.type === 'assistant/message') {c.msg += 1; if (c.msgT === undefined) {c.msgT = e.time;}}
            cnt.set(turn, c);
        }
        for (const [turn, idx] of lastAsst) {
            const item = out[idx];
            if (!item || item.role !== 'assistant') {continue;}
            const c = cnt.get(turn);
            const u = usage.get(turn);
            const m = facts.metrics.get(turn);
            const rm = facts.runMs.get(turn);
            console.log(
                `[dsh-raw] history-metrics turn=${turn} ` +
                    `ev=${c ? `ts:${c.ts} te:${c.te} step:${c.step} msg:${c.msg} td:${c.td} rd:${c.rd} be:${c.be}` : '?'} ` +
                    (c && c.ss !== undefined ? `ss=${c.ss} ` : 'ss=- ') +
                    (c && c.ftd !== undefined ? `ftd=${c.ftd} ` : 'ftd=- ') +
                    (c && c.frd !== undefined ? `frd=${c.frd} ` : 'frd=- ') +
                    (c && c.msgT !== undefined ? `msgT=${c.msgT} ` : 'msgT=- ') +
                    `out=${u ? u.outputTokens : '-'} run=${rm ?? '-'}ms ` +
                    `ttft=${m && m.ttftMs !== undefined ? m.ttftMs : '-'}ms tps=${m && m.tokensPerSecond !== undefined ? Math.round(m.tokensPerSecond) : '-'}`
            );
        }
    }
    // ---------- 过程链(思考/工具)重建（历史恢复可折叠展示） ----------
    // durable assistant/message 自带 content blocks(reasoning / tool-call{id,name,arguments})，
    // 按消息顺序重放成链；tool/result 依 callId 回填 ok/error。
    const contentBlocksOf = (e: RawEvent): Array<Record<string, unknown>> | undefined => {
        const msg = (e.data?.['message'] as { content?: unknown } | undefined)?.content;
        return Array.isArray(msg) ? (msg as Array<Record<string, unknown>>) : undefined;
    };
    const turnChain = new Map<number, DshHistoryTurnProcessItem[]>();
    const turnToolsByCall = new Map<number, Map<string, DshHistoryTurnProcessItem>>();
    const turnReplyTexts = new Map<number, number>(); // 该回合 content 含文本块(回复正文)的 assistant/message 数
    const finishTool = (turn: number, callId: string | undefined, status: 'ok' | 'error' | 'stopped', error?: string, output?: string, exitCode?: number, signal?: string, meta?: unknown, blocks?: unknown): void => {
        const byCall = turnToolsByCall.get(turn);
        let item: DshHistoryTurnProcessItem | undefined = callId ? byCall?.get(callId) : undefined;
        if (!item) {
            const arr = turnChain.get(turn) ?? [];
            for (let i = arr.length - 1; i >= 0; i--) {
                const it = arr[i];
                if (it.kind === 'tool' && it.status === 'running') { item = it; break; }
            }
        }
        if (item && item.kind === 'tool') {
            item.status = status;
            if (error) { item.error = error; }
            if (output) { item.output = output; }
            if (exitCode !== undefined) { item.exitCode = exitCode; }
            if (signal !== undefined) { item.signal = signal; }
            if (meta !== undefined) { item.meta = meta; }
            if (blocks !== undefined) { item.blocks = blocks; }
        }
    };
    for (const e of snap.events) {
        const d = e.data ?? {};
        const turn = typeof d['turn'] === 'number' ? (d['turn'] as number) : undefined;
        if (turn === undefined) { continue; }
        const blocks = e.type === 'assistant/message' ? contentBlocksOf(e) : undefined;
        if (blocks) {
            let hasText = false;
            for (const b of blocks) {
                const bt = b['type'];
                if (bt === 'reasoning') {
                    const text = typeof b['text'] === 'string' ? b['text'] : '';
                    if (text.trim()) {
                        let arr = turnChain.get(turn);
                        if (!arr) { arr = []; turnChain.set(turn, arr); }
                        arr.push({ kind: 'reasoning', text });
                    }
                } else if (bt === 'text') {
                    if (typeof b['text'] === 'string' && (b['text'] as string).trim()) { hasText = true; }
                } else if (bt === 'tool-call') {
                    const name = typeof b['name'] === 'string' ? b['name'] : '';
                    if (name) {
                        const argsRaw = typeof b['arguments'] === 'string' ? b['arguments'] : undefined;
                        const callId = b['id'] !== undefined ? String(b['id']) : undefined;
                        let arr = turnChain.get(turn);
                        if (!arr) { arr = []; turnChain.set(turn, arr); }
                        const item: DshHistoryTurnProcessItem = { kind: 'tool', name, argsRaw, callId, status: 'running' };
                        arr.push(item);
                        if (callId) {
                            let byCall = turnToolsByCall.get(turn);
                            if (!byCall) { byCall = new Map(); turnToolsByCall.set(turn, byCall); }
                            byCall.set(callId, item);
                        }
                    }
                }
            }
            if (hasText) { turnReplyTexts.set(turn, (turnReplyTexts.get(turn) ?? 0) + 1); }
        } else if (e.type === 'tool/result') {
            // 按上游 schema 解包：内容在 message.content[0].content，配对 id 在 message.source.callId
            const payload = readToolResult(d);
            const errCode = (d['error'] as { code?: string } | undefined)?.code;
            // 结果文本（供 Terminal 卡展示输出）：块数组展平，非 text 块序列化为 pretty JSON
            // 含图片块的结果：发原始内容块（只有附件引用）+ 只含 text 的干净文本，渲染侧自己校验与展示
            const hasImage = hasImageBlock(payload.blocks);
            const output = hasImage
                ? textOnly(payload.blocks)
                : resultText(payload.blocks, d['error'] as { name?: unknown; code?: unknown } | undefined);
            // 退出状态：从输出末尾 marker 解析（Terminal 卡 Pill 展示），并从展示输出剥掉 marker
            const status = parseExitStatus(output);
            finishTool(turn, payload.callId, toolStatusOf(errCode, payload.isError), errCode, status.output || undefined, status.exitCode, status.signal, d['meta'], hasImage ? payload.blocks : undefined);
        }
    }
    // 兜底状态(running→ok/stopped) + 计数 + 挂到该回合最后一条 assistant
    for (const [turn, items] of turnChain) {
        let toolCallCount = 0;
        let subagentCount = 0;
        for (const it of items) {
            if (it.kind !== 'tool') { continue; }
            // 与实时同口径：subagent 委派单独计数，不进 toolCallCount
            if (it.name === 'subagent' || it.name.startsWith('subagent_')) { subagentCount += 1; }
            else { toolCallCount += 1; }
            // 所在回合已关闭而该调用仍没有结果 → 视为「被中断」（与回合结束原因无关）
            if (it.status === 'running') {
                it.status = 'stopped';
                it.error = 'interrupted';
            }
        }
        const idx = lastAsst.get(turn);
        const counts: HistoryCounts = {
            toolCallCount,
            messageCount: Math.max(0, (turnReplyTexts.get(turn) ?? 0) - (finalTextTurns.has(turn) ? 1 : 0)),
            subagentCount,
        };
        if (idx !== undefined) {
            const item = out[idx];
            if (item && item.role === 'assistant') {
                // 链首并入该回合的上下文注入项(系统提示词等)，再排 reasoning/tool
                const ctxItems = turnContextItems.get(turn) ?? [];
                const chain = ctxItems.length > 0 ? [...ctxItems, ...items] : items;
                if (chain.length > 0) { item.chain = chain; }
                item.counts = counts;
            }
        }
    }
    return out;
}

/**
 * 会话核心投影（适配 dsh v0.1.7-rc.2）。
 *
 * **两个来路，缺一不可**：
 *   ① `session/follow` 快照里的 `projections.values` —— 快，但**不保证带**（旧会话、控制流还没基线时就是缺的）；
 *   ② 专用 remote `session/projections` → `{ asOfSeq, values } | null` —— 任何时刻都是权威整表，
 *      上游客户端也单独调它（`remote.session.projections({ sessionId })`）。
 * 先问 ①，**表是空的就问 ②**：只认 ① 会让"输入框下方那两块读数"在旧会话上永远不出现
 *（调用方 `refreshProjections` 拿到空表会直接返回，等于什么都没做）。
 *
 * 实测键：title / goal / sessionStats / tokenUsage / permissions / modelSelection /
 * sessionListMetadata / todos / plan / contextPressure 等（web 组合注册的投影）。
 * 权限 / 统计 / 用量 / 标题等 UI 数据均来自这里。
 */
export async function getSessionProjections(sessionId: string): Promise<Record<string, unknown>> {
    const snap = await readFollowSnapshot(sessionId);
    if (!isEmptyProjections(snap.projections)) {
        return snap.projections;
    }
    // 快照没带（或带了个空表）→ 换专用 remote 再读一次；再失败就返回空表（调用方保留已有缓存）
    try {
        return (await readSessionProjections(sessionId)) ?? snap.projections;
    } catch {
        return snap.projections;
    }
}

/**
 * 读**会话投影基线**（专用 remote；会话不存在时服务端返回 null）。
 * @param sessionId - 会话 id。
 * @returns 投影整表；形状不符 / 服务端返回 null 时 undefined。
 */
export async function readSessionProjections(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const value = await rpcCall<unknown>('session.projections', { sessionId });
    return projectionValuesOf(value);
}
// ---------- 会话操作（适配 dsh 0.1.7+；对应 session-controller 远程方法，载荷统一
//   args{ request: Session*Request }，契约见 docs/design/04） ----------
/**
 * 新建 / **收养**会话（上游 `session/create`；`workspaceId` 与 `cwd` 二选一）→ sessionId。
 *
 * `sessionId` 非空 = **幂等收养**：宿主按该 id 找回**已有**会话（历史与 id 都不变），
 * 用 `checkPersistedIdentity=true` 校验它的持久身份（cwd 必须与给定位置一致，否则抛
 * `session/cwd-conflict`），然后把它登记进目标工作区 —— 这是**唯一**能把已有会话挂进工作区的路
 * （工作区控制器只有 `workspace/insertSessionBefore`，那是排序 API，对未登记的会话会抛
 * `workspace/move-invalid`）。代价：收养会 resume 该会话（等于打开它一次）。
 */
export async function createSession(opts: { workspaceId?: string; cwd?: string; sessionId?: string } = {}): Promise<string> {
    const value = await rpcCall<{ sessionId: string }>('session.create', {
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });
    return value.sessionId;
}
// ---------- 附件（图片）字节 ----------
/** 一次图片附件读取的返回：媒体类型 + base64 字节（无 `data:` 前缀）。 */
export interface DshImageAttachment {
    mediaType: string;
    data: string;
}

/**
 * 往前翻**一页**历史（适配上游 0.1.7-rc.2 的 `session.page`，见 `SessionPageRequest`）。
 *
 * 上游客户端 `ISession.loadOlder()` 走的就是这条路：`events.prepend({ beforeSeq, maxMessages })`
 * —— 以**当前窗口的第一条事件序号**为 `beforeSeq`，取它之前的一页；返回的 `hasMore` 说明再往前还有没有。
 * 本插件同口径：`beforeSeq` 传窗口最老的那条 `seq`，返回的这一页由调用方**前插**进窗口。
 *
 * **`throughSeq` 必须是"流游标"（窗口里最新那条的 seq），不能省、也不能传 `-1`** —— 服务端切页是
 * `end = min(throughSeq + 1, beforeSeq)`：传 `-1` 会切出空页且 `hasMore` 恒假（真机"加载更早只出现一次"）。
 * @param sessionId - 目标会话
 * @param beforeSeq - 窗口里最老事件的序号（**非负安全整数**；服务端会校验）
 * @param maxMessages - 这一页最多取多少条"消息对齐"记录（与首屏同一页大小）
 * @returns 这一页的事件（已展开内嵌增量、按 `seq` 升序）与「再往前还有没有」
 */
export async function pageSessionEvents(
    sessionId: string,
    beforeSeq: number,
    maxMessages: number = HISTORY_PAGE.maxMessages,
    /** 目标序号（含）：`-1` = 不设下界（只按 `beforeSeq` 取一页）。导轨"翻到某个回合"用它。 */
    throughSeq = -1
): Promise<{ events: RawEvent[]; hasMore: boolean }> {
    const value = await rpcCall<{ records?: unknown[]; hasMore?: boolean }>('session.page', {
        address: { kind: 'session', sessionId },
        throughSeq: Math.floor(throughSeq),
        beforeSeq: Math.floor(beforeSeq),
        maxMessages,
        // 普通翻页用 50 条下限；"翻到某个回合"用 200（上游同：跳转那一页要求更多内容）。
        turnWindow: {
            minMessages: throughSeq === -1 ? HISTORY_PAGE.turnWindow.minMessages : JUMP_PAGE_MIN_MESSAGES,
            minTurns: HISTORY_PAGE.turnWindow.minTurns,
        },
    });
    return {
        events: snapshotRecordsToEvents(Array.isArray(value?.records) ? value.records : []),
        hasMore: value?.hasMore === true,
    };
}

/**
 * 读取会话里**被引用过**的图片附件字节（上游 `session.attachment`，请求 `{sessionId, attachmentId}`）。
 *
 * 上游会遍历会话事件校验该附件确被本会话引用，未被引用/找不到时返回 `session/attachment-invalid`
 * （附带 `reason`）——错误原样上抛，不吞、不猜。
 * @param sessionId - 会话 id。
 * @param attachmentId - 结果 image 块里 `attachment.attachmentId` 的原值（不透明，不要解析）。
 * @returns 媒体类型与 base64 字节。
 */
export async function readSessionAttachment(sessionId: string, attachmentId: string): Promise<DshImageAttachment> {
    const value = await rpcCall<{ attachment?: { mediaType?: unknown }; data?: unknown }>('session.attachment', {
        sessionId,
        attachmentId,
    });
    const mediaType = typeof value?.attachment?.mediaType === 'string' ? value.attachment.mediaType : '';
    const data = typeof value?.data === 'string' ? value.data : '';
    if (mediaType === '' || data === '') {
        throw new Error('DSH 返回的图片附件形状不符（缺 mediaType 或 data）');
    }
    return { mediaType, data };
}

/** 一次提交的投递方式：queue = 排到下一轮；steer = 插话，投到当前回合的下一步。 */
export type DshPromptMode = 'queue' | 'steer';

/**
 * 向会话发送消息（上游 `session/prompt`，SessionPromptRequest）。
 * v0.1.5-rc.2 起 request 必须带客户端 mint 的 requestId（uuid，user/message 事件会回显）；
 * mode 决定服务端把它排到**下一轮**（queue）还是**当前回合的下一步**（steer）。
 * content 支持文本 + 图片（data URL base64）块。
 */
export async function sendPrompt(
    sessionId: string,
    content: DshContentPart[],
    requestId?: string,
    mode: DshPromptMode = 'queue'
): Promise<void> {
    await rpcCall<{ accepted: boolean }>('session.prompt', {
        // 调用方给了标识就用它（页面 mint → 回显按同一标识认领）；没给则本地生成
        requestId: requestId ?? crypto.randomUUID(),
        sessionId,
        mode,
        content,
    });
}

/** 对一条还挂着的排队项做变更（上游 `session/updateQueue`，SessionUpdateQueueRequest）。 */
export type DshQueueAction =
    | { kind: 'edit'; content: Array<{ type: 'text'; text: string }> }
    | { kind: 'remove' }
    | { kind: 'steer' };

/**
 * 变更一条**还没被取用**的排队项：编辑 / 删除 / 转插话。
 *
 * 服务端的拒绝是有意义的业务事实，原样上抛由调用方判：
 * 条目已被取走或会话不在 → `session/queue-item-not-found`；
 * 转插话时目标不是下一轮、或回合已经不在跑 → `session/steer-unavailable`。
 * 编辑只接受纯文本块（含图/文件的条目会被服务端拒）。
 */
export async function updateQueue(sessionId: string, itemId: string, action: DshQueueAction): Promise<void> {
    await rpcCall<{ accepted: boolean }>('session.updateQueue', { sessionId, itemId, action });
}
/**
 * 从一段**已完成回合**分叉出新会话（上游 `session/fork`，SessionForkRequest { sessionId, atSeq?, increaseTitle? }）。
 *
 * `atSeq` 是事件序号，服务端取**第一条 `seq >= atSeq` 的 `turn/end`** 作为切点（含该回合），
 * 再把切点推到下一个 `turn/start` 之前；**省略或不传** = 从最后一条已完成的回合分叉。
 * 因此锚点落在「正在跑、还没 turn/end」的回合里会被服务端拒（`session/fork-unavailable`）。
 * 序号可能带小数（中断回合的冻结节点），服务端只接受非负整数，故这里先取整。
 * @returns 子会话标识。
 */
export async function forkSession(sessionId: string, atSeq?: number): Promise<string> {
    const result = await rpcCall<{ sessionId: string }>('session.fork', {
        sessionId,
        ...(atSeq === undefined ? {} : { atSeq: Math.floor(atSeq) }),
        // 子会话标题**由宿主升号**（与上游客户端同：它也只传这一个开关，不自己算名字）。
        // 插件先前自己 `durableTitleFor` + 算号 + `rename` —— 那是把一个宿主能力在客户端重做一遍，
        // 结果同一个源分叉两次都得到 `(1)`（本地只拿源标题推号，看不到已有的兄弟会话）。
        increaseTitle: true,
    });
    return result.sessionId;
}
/** 取消当前回合（上游 `session/cancel`，SessionCancelRequest { sessionId }）→ { accepted }。 */
export async function cancelSession(sessionId: string): Promise<void> {
    await rpcCall<{ accepted: boolean }>('session.cancel', { sessionId });
}
/** 切换模型 / 推理等级（上游 `session/selectModel`，SessionSelectModelRequest = ModelSelection + sessionId）。 */
export async function selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<void> {
    await rpcCall<{ selected: unknown }>('session.selectModel', {
        sessionId,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
    });
}
/**
 * 模型目录（适配 dsh v0.1.7-rc.2）。
 * 上游接口：session-controller 远程方法 `session/modelCatalog`（无参，payload { args:{} }），
 * 返回 ModelCatalog { default, routableProviders, groups[{ id,name,models[{id,name,description,
 * reasoning:{efforts[]}}] }], failures }（契约见 docs/design/04）。
 * ⚠️ 口径变化（rc.2）：`routableProviders` 由「**已注册**的 provider」（含空目录）
 * 改为「**至少有一个可用模型**的 provider」——所以它不再能用来判断「某 provider 是否已配置」。
 * 本插件未消费该字段（只透传），这里只是留痕，避免以后按旧语义拿它做门控。
 * 另：rc.2 起 base 组合把 DeepSeek 拆成 `deepseek-official`(API key) 与 `deepseek-account`(账号)
 * 两条 provider，故 `groups` 可能比 rc.1 多一组 —— UI 按 `groups[]` 动态渲染，无需硬编码。
 * “当前会话选择的模型”不在这里：由 modelSelection 投影给出（见 dshService.listModels）。
 */
export async function modelCatalog(): Promise<{
    default?: { provider?: string; model?: string };
    groups?: Array<{
        id: string;
        name: string;
        models: Array<{
            id: string;
            name: string;
            description?: string;
            reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string };
        }>;
    }>;
    /** 上游对加载失败 provider/组的提示，形状以 0.1.5-rc.2 返回为准（仅透传、UI 只显示组数） */
    failures?: unknown[];
}> {
    return rpcCall('session.modelCatalog', {});
}
// ---------- 工作区 ----------
/** 一个工作区（字段取上游 workspace 读法的投影）。 */
export interface WorkspaceItem {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
    createdAt?: string;
    updatedAt?: string;
}
/**
 * 工作区列表（适配 dsh v0.1.7-rc.2）。
 * 该版本的 workspace-controller 不再提供独立的 `workspace.list` 远程方法；
 * 枚举改由流式 remote `workspace/follow`（斜杠端点，走 /api/remote.mux）提供：
 * 打开流后服务端首帧 value 形如
 *   { type:'baseline', value:{ items: WorkspaceView[], archivedSessionIds: string[] } }
 * （随后的 ordered 'changed' 增量帧本方法不需要，取到 baseline 即取消）。
 * 返回 items 与 archivedSessionIds。
 */
export async function workspaceList(): Promise<{ items: WorkspaceItem[]; archivedSessionIds: string[] }> {
    return new Promise((resolve, reject) => {
        let done = false;
        let ctl: { cancel: () => void } | undefined;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                reject(new Error('DSH 工作区读取超时'));
            }
        }, 8000);
        const settle = (fn: () => void): void => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                try {
                    ctl?.cancel();
                } catch {
                    /* noop */
                }
                fn();
            }
        };
        void openMuxStream(
            'workspace/follow',
            { args: {} },
            {
                onItem: (value) => {
                    const v = value as Record<string, unknown> | undefined;
                    const inner = (v?.['value'] as Record<string, unknown> | undefined) ?? v;
                    if (inner && Array.isArray(inner['items'])) {
                        settle(() =>
                            resolve({
                                items: inner['items'] as WorkspaceItem[],
                                archivedSessionIds: Array.isArray(inner['archivedSessionIds']) ? (inner['archivedSessionIds'] as string[]) : [],
                            })
                        );
                    }
                },
                onError: (err) => settle(() => reject(new Error(`DSH 工作区读取失败：${err.message}`))),
                onEnd: () => settle(() => reject(new Error('DSH 工作区流意外结束'))),
                onClose: () => settle(() => reject(new Error('DSH 工作区流关闭'))),
            },
            8000
        )
            .then((c) => {
                ctl = c;
                if (done) {
                    c.cancel();
                }
            })
            .catch((e) => settle(() => reject(e)));
    });
}
