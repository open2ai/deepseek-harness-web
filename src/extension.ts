// 扩展装配层：注册命令、拼装各层。
//   服务层：src/api/dshService.ts（dsh 进程/会话/对话编排）
//   dsh 层：src/dsh/（api / events / webProxy，门面 src/dsh/index.ts）
//   UI 层：侧边栏对话视图（本文件内）+ DSH 网页面板（src/dshPanel.ts）
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { DshService, DshNoWorkspaceError } from './api/dshService';
import { ChatInputService } from './chatInputService';
import { type DshContentPart, type DshReplyStats, FEEDBACK_CATEGORIES, type FeedbackCategory, type DshPromptMode, type DshQueueAction, DshRpcError, lateAnswerVerdict, subscribeAccountNotices, toQueueViews } from './dsh';
import { DshPanel } from './dshPanel';
import { traceTool } from './dsh/trace';
import {
    applyNativeTitlebarContext,
    TITLEBAR_MODE,
    TITLEBAR_MODE_ATTR,
    installChatTitlebar,
    makeTitlebarPanelBroadcaster,
    type TitlebarChatHost,
    type TitlebarMode,
} from './titlebar/index';

const dsh = new DshService();

/**
 * 事件窗口的诊断输出通道（「历史看不全 / 看不到『加载更早』」这一类问题的**唯一可查处**）。
 *
 * 为什么必须有一个：分页事实全在宿主侧（`hasMore`、快照多少条、进来多少条），
 * 页面上只看得到「列表有没有变」。此前这些只走 `console.log`（要开开发者工具才看得见），
 * 用户问「为什么没有『加载更早』」时无从自查。写进 Output 面板后，打开会话就能看到那一行。
 */
let rowsLog: vscode.OutputChannel | undefined;
function logRows(line: string): void {
    rowsLog?.appendLine(`${new Date().toLocaleTimeString()}  ${line}`);
}

// 渲染源的唯一通路：宿主把**行**下发给页面，页面据此渲染（旧指令通路已退役，见 docs/design/08 §13）。
dsh.onRows = (rows, turnActive) => {
    // 带上会话标识：页面靠它判断「本地的乐观行是不是这个会话的」——
    // 不带的话切会话时上一个会话的乐观行会被当成未认领而留下，processing 恒真（一直「深度求索中」）。
    // 带上 turnActive：**是否在跑是本轮的显式事实**，页面从「行」推导不出来（见 dshService.turnActive）。
    // 窗口分页事实（hasMore/loading/events）与行同帧：列表顶端的「加载更早」按钮只读它，不自己猜。
    postToChats({
        type: 'rows',
        rows,
        sessionId: dsh.getSessionId(),
        turnActive,
        historyHasMore: dsh.historyHasMore(),
        historyLoading: dsh.historyLoading(),
        historyEvents: dsh.windowEventCount(),
    });
};
// 任务清单（输入框上方的常驻条）：与行同源、同一处派生，页面按整表替换；`null` = 没有清单。
dsh.onTodos = (todos) => {
    postToChats({ type: 'todos', todos });
};
// 排队消息（输入框上方的队列卡）：与行**不同源** —— 队列只活在服务端 agent 的收件箱里、不进日志，
// 来自队列流的投影（见 dshService.ensureControl）。与行一样是整表语义：页面收到即替换。
dsh.onQueue = (sessionId, items) => {
    postToChats({ type: 'queue', sessionId, items: toQueueViews(items) });
};
// 上下文占用（发送按钮左侧的环）：单独一条轻帧 —— 投影值很小，不重推整串 chatInfo
dsh.onContext = (sessionId, value) => {
    postToChats({ type: 'context', sessionId, pressure: value.pressure, breakdown: value.breakdown });
};
// 会话投影整表（会话统计 / token 用量 / plan / goal / 权限…）：来自 `session/control`，
// 投影一变就推一份当前值 —— 输入框下方那两张卡据此**跟着流式实时变**（见 dshService.onProjections）。
dsh.onProjections = (sessionId, values) => {
    postToChats({ type: 'projections', sessionId, values });
};
// 审批/提问：宿主侧常驻（见 dshService.ensureAskSubscription）。缓存最后一帧，新 webview ready 时重放。
dsh.onApproval = (a) => {
    const frame = {
        type: 'chatApproval',
        approvalId: a.approvalId,
        description: a.description,
        // 上游 request.displayReason（dsh 0.1.7-rc.2 新增）：本地化展示文案，原样转给页面；
        // 用哪门语言由页面决议（webview/chat/core/approval-text.ts）
        ...(a.displayReason === undefined ? {} : { displayReason: a.displayReason }),
        toolName: a.toolName,
    };
    pendingAsk = frame;
    postToChats(frame);
};
dsh.onQuestion = (q) => {
    // `callId` 只在**限时提问**（dsh 0.2.0）上出现：它是投影里那条 `continued` 记录的同一个键，
    // 页面据此在超时后关掉过期弹窗、改由提问卡提供补答入口。
    const frame = {
        type: 'chatQuestion',
        rpcId: q.rpcId,
        sessionId: q.sessionId,
        questions: q.questions,
        ...(q.callId === undefined ? {} : { callId: q.callId }),
    };
    pendingAsk = frame;
    pendingAskRpcId = q.rpcId;
    postToChats(frame);
};
dsh.onQuestionClosed = (rpcId) => {
    pendingAsk = undefined;
    pendingAskRpcId = undefined;
    postToChats({ type: 'questionClosed', rpcId });
};
// 账号类提示（dsh 0.1.7-rc.2 的 emit：登录失效 / 模型需登录）：转成对话区一行。
// **懒建立**：`$events` 流不该在 dsh 起来之前就连上 —— 连不上会每 1.5s 重试并打一条 warn
// （见 events.ts 的 run()），而那时候用户还没打开任何面板。首个聊天 webview 就绪时建立
// （与 ensureSettingsFollow 同一处、同一理由）。
// 不做「面板就绪时重放」—— 它是**当前账号态**的提示，用户重开面板后由下一次模型请求或目录错误再暴露。
let disposeAccountNotices: (() => void) | undefined;
function ensureAccountNotices(): void {
    if (disposeAccountNotices !== undefined) {
        return;
    }
    disposeAccountNotices = subscribeAccountNotices((notice) => {
        postToChats({ type: 'notice', text: notice.text, tone: notice.tone });
    });
}
// 输入框功能宿主侧服务：承载 "/" 斜杠命令/技能，后续输入触发类功能都挂这里（复用 dsh 的会话/就绪）
const chatInput = new ChatInputService(dsh);
const panel = new DshPanel({
    ensureRunning: () => dsh.ensureRunning(),
    // DSH 网页面板开关/查看模式变化 → 广播 panelState（自绘标题栏 webview 消费）。
    // 原生标题栏模式下本函数返回 undefined（走 setContext 喂 package.json when）→ 自动 no-op。
    onPanelStateChange: makeTitlebarPanelBroadcaster((msg) => postToChats(msg)),
});

// 侧边栏对话视图引用（右键 @ 代码进输入框用）
let launcherView: vscode.WebviewView | undefined;
let pendingDraft: string | undefined;

// ---------- 对话视图（UI 层：消息区 + 输入框） ----------

/**
 * 对话视图的**降级页**：只在 `dist/chat/index.html` 读不出来时用（构建产物缺失/损坏）。
 *
 * 这里**不再放一个能打字却没有任何回显的假输入框** —— 渲染源切到「宿主下发行」之后，宿主不再发
 * 增量/完成指令，旧的那套监听（chatChunk/chatDone）一头也接不上；留着只会让人以为「能发、只是没回复」。
 * 现在它只说明实情并给出修复动作。
 */
function getChatContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline';">
    <style>
        html, body { margin: 0; padding: 0; height: 100%; font-family: var(--vscode-font-family); }
        body { display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
        .fallback { max-width: 420px; font-size: 12px; line-height: 1.7; color: var(--vscode-foreground, #ddd); }
        .fallback h2 { font-size: 13px; margin: 0 0 8px; }
        .fallback code { font-family: var(--vscode-editor-font-family, monospace); }
    </style>
</head>
<body>
    <div class="fallback">
        <h2>对话界面没有加载出来</h2>
        <p>找不到构建产物 <code>dist/chat/index.html</code>，或它已损坏。</p>
        <p>在扩展仓库里重新构建后重载窗口即可：<br><code>pnpm run compile</code></p>
    </div>
</body>
</html>`;
}

/** 单条消费记录：字段按 dsh 返回原样存（未返回则为空，不补 0） */
interface UsageRecord {
    time: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
}

/** 记录一次对话的消费到持久化存储（time 取 dsh 对该回答的自带时间戳，缺省才用本地时刻） */
async function recordUsage(state: vscode.Memento, stats: DshReplyStats | undefined, apiTime?: number): Promise<void> {
    if (!stats) {
        return;
    }
    const key = 'dsh.usage';
    // epoch 秒/毫秒自适应，统一存毫秒；无 API 时刻才回退本地 Date.now()
    const ts =
        typeof apiTime === 'number' && Number.isFinite(apiTime) && apiTime > 0
            ? (apiTime > 1e12 ? apiTime : apiTime * 1000)
            : Date.now();
    const record: UsageRecord = {
        time: ts,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        reasoningTokens: stats.reasoningTokens,
        totalTokens: stats.totalTokens,
    };
    if (
        record.inputTokens === undefined &&
        record.outputTokens === undefined &&
        record.cacheReadTokens === undefined &&
        record.cacheWriteTokens === undefined &&
        record.reasoningTokens === undefined &&
        record.totalTokens === undefined
    ) {
        return; // 无任何已消耗用量（如停在首个 token 前），不写空行
    }
    const existing = state.get<UsageRecord[]>(key) ?? [];
    const next = [...existing, record].slice(-500);
    await state.update(key, next);
}

/** 打开消费记录报告面板：按自然周/月分组、可折叠（原样展示 dsh 字段，未返回显示 —） */
async function openUsageReport(state: vscode.Memento): Promise<void> {
    const records = state.get<UsageRecord[]>('dsh.usage') ?? [];
    const panel = vscode.window.createWebviewPanel(
        'dshUsage',
        '消费记录',
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );

    // ---- 本地自然日/周/月分组 ----
    const now = new Date();
    const DAY = 86_400_000;
    const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const mondayStart = (d: Date): number => {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
        return x.getTime();
    };
    const todayStart = dayStart(now);
    const curWeekStart = mondayStart(now);
    const prevWeekStart = curWeekStart - 7 * DAY;
    const curMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    const bucketOf = (t: number): string => {
        if (t >= todayStart) {
            return '今天';
        }
        if (t >= todayStart - DAY) {
            return '昨天';
        }
        if (t >= curWeekStart) {
            return '本周';
        }
        if (t >= prevWeekStart) {
            return '上周';
        }
        if (t >= prevMonthStart && t < curMonthStart) {
            return '上个月';
        }
        return '更早';
    };
    const groups = new Map<string, UsageRecord[]>();
    for (const r of records) {
        const lb = bucketOf(r.time);
        const arr = groups.get(lb) ?? [];
        arr.push(r);
        groups.set(lb, arr);
    }
    const ORDER = ['今天', '昨天', '本周', '上周', '上个月', '更早'];

    const fmt = (v: number | undefined): string => (typeof v === 'number' ? String(v) : '—');
    // 大数缩写（仅用于汇总行）：≥1e3 → 1.0K、≥1e6 → 1.2M，更大 → G/T；<1000 显示原值
    const compact = (n: number): string => {
        const abs = Math.abs(n);
        if (abs < 1000) {
            return String(n);
        }
        const table: Array<[number, string]> = [
            [1e12, 'T'],
            [1e9, 'G'],
            [1e6, 'M'],
            [1e3, 'K'],
        ];
        for (const [base, unit] of table) {
            if (abs >= base) {
                return (n / base).toFixed(1) + unit;
            }
        }
        return String(n);
    };
    const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'totalTokens'): number =>
        records.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
    const anyOf = (k: 'cacheWriteTokens' | 'totalTokens'): boolean => records.some((r) => typeof r[k] === 'number');
    const hasCacheWrite = anyOf('cacheWriteTokens');
    const hasTotal = anyOf('totalTokens');
    const summary = [
        `<strong>${records.length} 条对话</strong>`,
        `总输入 ${compact(sum('inputTokens'))}`,
        `总输出 ${compact(sum('outputTokens'))}`,
        `缓存读 ${compact(sum('cacheReadTokens'))}`,
        hasCacheWrite ? `缓存写 ${compact(sum('cacheWriteTokens'))}` : '',
        `推理 ${compact(sum('reasoningTokens'))}`,
        hasTotal ? `合计(totalTokens) ${compact(sum('totalTokens'))}` : '',
    ]
        .filter(Boolean)
        .join(' · ');

    const rowHtml = (r: UsageRecord): string =>
        `<tr><td>${new Date(r.time).toLocaleString()}</td><td>${fmt(r.inputTokens)}</td><td>${fmt(r.outputTokens)}</td>` +
        `<td>${fmt(r.cacheReadTokens)}</td><td>${hasCacheWrite ? fmt(r.cacheWriteTokens) : '—'}</td>` +
        `<td>${fmt(r.reasoningTokens)}</td><td>${hasTotal ? fmt(r.totalTokens) : '—'}</td></tr>`;
    const thead =
        '<tr><th>时间</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>推理</th><th>合计(totalTokens)</th></tr>';

    // 每组内的汇总（只统计该组里真实返回过的数字字段）
    const grpSumOf = (items: UsageRecord[], k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'totalTokens'): number =>
        items.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
    const grpStats = (items: UsageRecord[]): string => {
        const hasCW = items.some((r) => typeof r.cacheWriteTokens === 'number');
        const hasTT = items.some((r) => typeof r.totalTokens === 'number');
        return [
            `总输入 ${compact(grpSumOf(items, 'inputTokens'))}`,
            `总输出 ${compact(grpSumOf(items, 'outputTokens'))}`,
            `缓存读 ${compact(grpSumOf(items, 'cacheReadTokens'))}`,
            hasCW ? `缓存写 ${compact(grpSumOf(items, 'cacheWriteTokens'))}` : '',
            `推理 ${compact(grpSumOf(items, 'reasoningTokens'))}`,
            hasTT ? `合计(totalTokens) ${compact(grpSumOf(items, 'totalTokens'))}` : '',
        ]
            .filter(Boolean)
            .join(' · ');
    };

    const sections = records.length === 0
        ? '<div class="empty">暂无记录</div>'
        : ORDER
              .filter((lb) => groups.has(lb))
              .map((lb, idx) => {
                  const items = (groups.get(lb) ?? []).slice().reverse();
                  return (
                      `<details class="grp" ${idx === 0 ? 'open' : ''}>` +
                      `<summary>${lb} · ${items.length} 条` +
                      `<span class="grp-stat">${grpStats(items)} tok</span></summary>` +
                      `<table>${thead}${items.map(rowHtml).join('')}</table>` +
                      `</details>`
                  );
              })
              .join('');

    panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 12px; color: var(--vscode-foreground, #ddd); font-size: 13px; }
    h1 { font-size: 15px; margin: 0 0 4px; }
    .note { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin: 0 0 8px; }
    .summary { margin: 8px 0; }
    .empty { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
    .grp { border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.12)); border-radius: 8px; margin: 6px 0; overflow: hidden; }
    .grp summary { cursor: pointer; padding: 6px 10px; font-weight: 600; user-select: none; background: rgba(255,255,255,0.04); }
    .grp summary:hover { background: rgba(255,255,255,0.08); }
    .grp-stat { font-weight: normal; font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-left: 12px; }
    .grp table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-top: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; text-align: right; }
    th:first-child, td:first-child { text-align: left; }
    th { background: rgba(255,255,255,0.05); }
</style>
</head>
<body>
<h1>消费记录</h1>
<div class="note">仅统计本插件发起的对话（侧边栏 / 右键处理）。在 dsh 网页 / 桌面里使用产生的用量不在其中，因此可能与你的总用量不一致。</div>
<div class="summary">${summary} tok</div>
${sections}
</body>
</html>`;
}

/** Activity Bar 对话视图：点图标自动打开 DSH 面板；内容区为对话 */
/** 当前活动的聊天 webview（侧边栏视图或编辑器面板），供右键 @代码 / 新会话 投递 */
let chatTarget: vscode.Webview | undefined;
/** 编辑器区的聊天面板（移动到编辑器后创建），供"回到侧边栏"关闭 */
let chatPanel: vscode.WebviewPanel | undefined;
/** 已收到 webview `ready` 的聊天视图（保证 postMessage 到达已挂好监听的页面） */
const readyChats = new WeakSet<vscode.Webview>();

/**
 * 待答的交互帧（`chatApproval` / `chatQuestion`）：只发给发起该回合的 webview，且不进日志，
 * 故缓存最后一帧供新 webview（如「在编辑区打开」）ready 时重放。
 */
let pendingAsk: unknown = undefined;

/** 待答提问的 rpcId（回合作废时广播 `questionClosed` 用；审批帧没有该字段）。 */
let pendingAskRpcId: string | undefined;

/** 待答交互作废：清缓存并让各 webview 收起弹窗。 */
function clearPendingAsk(): void {
    const rpcId = pendingAskRpcId;
    pendingAsk = undefined;
    pendingAskRpcId = undefined;
    if (rpcId !== undefined) {
        postToChats({ type: 'questionClosed', rpcId });
    }
}

/** 全部存活聊天 webview：侧栏视图 launcherView + 当前 chatTarget + 编辑器面板 chatPanel（去重） */
function allChatWebviews(): vscode.Webview[] {
    const set = new Set<vscode.Webview>();
    if (launcherView?.webview) {
        set.add(launcherView.webview);
    }
    if (chatTarget) {
        set.add(chatTarget);
    }
    if (chatPanel?.webview) {
        set.add(chatPanel.webview);
    }
    return [...set];
}

/** 向当前所有存活聊天 webview（侧栏视图 + 编辑器面板）投递消息，避免目标被重建后内容丢失 */
function postToChats(message: unknown): void {
    for (const w of allChatWebviews()) {
        try {
            void w.postMessage(message);
        } catch {
            // 视图重建期间的旧引用：忽略，下次 resolve 会换新目标
        }
    }
}

/** 确保至少有一个聊天 webview 可用；没有则唤起侧栏并等待 resolve */
async function ensureChatWebview(): Promise<vscode.Webview | undefined> {
    if (chatTarget || chatPanel) {
        return chatTarget ?? chatPanel?.webview;
    }
    try {
        await vscode.commands.executeCommand('workbench.view.extension.dsh');
    } catch {
        return undefined;
    }
    const deadline = Date.now() + 2500;
    while (!chatTarget && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return chatTarget;
}

/** 等待指定聊天 webview 发过 `ready`，避免消息发到尚未挂好监听的页面 */
async function waitChatReady(webview: vscode.Webview): Promise<boolean> {
    if (readyChats.has(webview)) {
        return true;
    }
    const deadline = Date.now() + 3000;
    while (!readyChats.has(webview) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readyChats.has(webview);
}

/**
 * 加载聊天 HTML 到 webview（重写资源 + CSP；缺失回退自绘）。
 * titlebarMode：本页标题栏实现（A 原生 / B 页内自绘），静态注入 <body data-titlebar-mode>
 * 供 chat.ts 首帧同步读取（避免 ready 后消息导致“先画自绘再隐藏”的闪烁/竞态）。
 */
async function loadChatHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    titlebarMode: TitlebarMode
): Promise<void> {
    const chatRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'chat');
    try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(chatRoot, 'index.html'));
        let html = new TextDecoder('utf-8').decode(content);
        html = html.replace(/\s+crossorigin/g, '');
        html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_match, attr: string, p: string) => {
            const asset = vscode.Uri.joinPath(chatRoot, p);
            return `${attr}="${webview.asWebviewUri(asset)}"`;
        });
        // 原生/自绘 标题栏通道：原生标题栏模式时 index.html 的 CSS 让 #titlebar 首帧即 display:none
        html = html.replace('<body>', `<body ${TITLEBAR_MODE_ATTR}="${titlebarMode}">`);
        const csp =
            `default-src 'none'; ` +
            `script-src ${webview.cspSource} 'wasm-unsafe-eval'; ` +
            `style-src ${webview.cspSource} 'unsafe-inline'; ` +
            `font-src ${webview.cspSource} data:; ` +
            `img-src ${webview.cspSource} data: https:; ` +
            `connect-src ${webview.cspSource} https: http:;`;
        html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
        webview.html = html;
    } catch {
        webview.html = getChatContent();
    }
}

/** 拉取会话上游投影（统计/权限）+ 模型列表，推给 webview */
async function postChatInfo(webview: vscode.Webview): Promise<void> {
    try {
        // 先列模型（内部会经 getSession() 确保当前会话存在），再读投影，
        // 否则第一次推送时会话尚未建立、permissions/统计会为空
        let models: { current?: unknown; groups?: unknown[] } = {};
        try {
            models = await dsh.listModels();
        } catch {
            // 模型列表失败不阻塞投影
        }
        const projections = await dsh.getProjections();
        // 投影整表也在这份里：顺手喂给服务层 —— 上下文环（那条轻帧）与输入框下方的
        // 「会话统计 / Token 用量」都读它，免得再跑一次 RPC
        dsh.seedProjections(projections);
        let agentPresets:
            | { presets: Array<{ id: string; name?: string; description?: string; isDefault: boolean; broken?: string }> }
            | undefined;
        try {
            agentPresets = await dsh.listAgentPresets();
        } catch {
            // 模式列表失败只隐藏模式选择，不影响聊天
        }
        const projectionAgentPreset = projections?.['agentPreset'];
        const agentPreset =
            typeof projectionAgentPreset === 'string'
                ? projectionAgentPreset
                : agentPresets?.presets.find((p) => p.isDefault)?.id;
        const sessionMeta = projections?.['sessionListMetadata'] as { blank?: boolean } | undefined;
        const agentPresetLocked = sessionMeta?.blank === false;
        // 会话工作区根路径：终端卡 cwd 标签在工具调用未带 workdir 时用它兜底（上游同口径）
        const cwd = await dsh.currentWorkspacePath();
        void webview.postMessage({
            type: 'chatInfo',
            projections,
            cwd,
            models,
            agentPresets,
            agentPreset,
            agentPresetLocked,
        });
        // 设置偏好兜底对齐：emit 万一收不到，会话/工作区切换时也重读一次（值变了才广播）
        void dsh.readChatPrefs();
    } catch {
        // 服务未就绪时静默
    }
}

/** 推偏好（全局，与会话无关）：上游「设置 → 通用设置」的四项
 *  （工作步骤展示 / 性能与用量 / 代码工作工具 / 繁忙时的发送行为）。
 *  整体读到才推：读不到就一个字段都不推，webview 侧维持默认（= 四项的上游默认值）。 */
async function postChatPrefs(): Promise<void> {
    const prefs = (await dsh.readChatPrefs()) ?? dsh.getCachedChatPrefs();
    if (prefs === undefined) {
        return;
    }
    // 诊断留痕（真机排查「设置改了但界面没跟随」时看这一行）：输出通道 `DSH 事件窗口`
    logRows(
        `偏好 → 工作步骤展示=${prefs.transcriptView}（分组头=${prefs.stepGrouping}） · 性能与用量=${prefs.performanceUsage}` +
            ` · 代码工作工具=${prefs.developerTools ? '开' : '关'} · 繁忙时的发送行为=${prefs.busyEnter}`
    );
    postToChats({
        type: 'chatPrefs',
        transcriptView: prefs.transcriptView,
        performanceUsage: prefs.performanceUsage,
        developerTools: prefs.developerTools,
        busyEnter: prefs.busyEnter,
        settledReasoningPreview: prefs.settledReasoningPreview,
        liveProcessDetail: prefs.liveProcessDetail,
        stepGrouping: prefs.stepGrouping,
    });
}

/**
 * 偏好变更跟随：进程内只订阅一次，广播给所有存活聊天页。
 * 来源是上游设置（`settings/document-updated` 经 `subscribeChatPrefs`；命名空间过滤在 `dsh/settings.ts`）。
 */
let settingsFollowed = false;
function ensureSettingsFollow(): void {
    if (settingsFollowed) {
        return;
    }
    settingsFollowed = true;
    // 诊断出口：分页/窗口的事实全在宿主侧，页面上只看得到「列表变没变」——
    // 排查「历史看不全 / 看不到『加载更早』」时这里是唯一可查处。
    rowsLog = vscode.window.createOutputChannel('DSH 事件窗口');
    dsh.onWindowLog = (line) => {
        logRows(line);
    };
    rowsLog.appendLine(
        [
            '──── DSH 历史窗口自查 ────',
            '事件窗口**不按条数裁剪**（与 dsh 网页端一致）：会话有多少历史就能看多少。',
            '顶端「加载更早」只在**服务端分页截断**时出现 —— 它的门是 `hasMore`，不是本插件配出来的。',
            '────────────────────────',
        ].join('\n')
    );
    dsh.subscribeChatPrefs(() => {
        void postChatPrefs();
    });
}


/**
 * 状态类斜杠命令(/plan /goal…)执行后的投影刷新。dsh 把 plan/goal 选择按会话事件 fold 成投影：
 * 空闲时立即落定(committed)，有 open turn 时排到下一个 accepted pre-step 边界才写(queued)。
 * 单次延时(旧 300ms)刷新会读在事件落定前后 → chip 停在旧值。这里先做一次保底刷新，再对被跟踪键
 * 轮询少量次数：值一旦变化(如 queued 在回合边界落定)即再推一次 chatInfo，让 chip 正确收敛/消失。
 */
async function refreshChatInfoAfterSlash(webview: vscode.Webview, commandName: string): Promise<void> {
    const trackedKey = commandName === 'plan' ? 'plan' : commandName === 'goal' ? 'goal' : null;
    const snap = async (): Promise<string | undefined> => {
        try {
            const proj = await dsh.getProjections();
            const v = proj[trackedKey as string];
            return v === undefined ? '<undef>' : JSON.stringify(v ?? null);
        } catch {
            return undefined; // 服务瞬时不可读：当未变化处理
        }
    };
    const before = trackedKey ? await snap() : undefined;
    await new Promise((r) => setTimeout(r, 300));
    await postChatInfo(webview); // 保底刷新（等同旧行为，先让 UI 拿到 command/run 的 pending/committed 状态）
    if (!trackedKey) {
        return;
    }
    for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const now = await snap();
        if (now !== before) {
            // queued 选择已在回合边界落定（或中途事件使投影再变）→ 再推一次收敛 UI
            await postChatInfo(webview);
            break;
        }
    }
}

/**
 * 页面来的队列动作 → 服务端形状。
 *
 * 形状不合、或编辑内容为空（服务端同样会拒）→ `undefined`：这一层直接拒掉，不发无效请求。
 * 编辑只发**纯文本块**：含图/文件的条目在页面上就被禁用，这里是第二道。
 */
function toQueueAction(action: { kind?: 'edit' | 'remove' | 'steer'; text?: string } | undefined): DshQueueAction | undefined {
    if (action === undefined) {
        return undefined;
    }
    if (action.kind === 'remove') {
        return { kind: 'remove' };
    }
    if (action.kind === 'steer') {
        return { kind: 'steer' };
    }
    if (action.kind === 'edit') {
        const text = action.text ?? '';
        if (text.trim() === '') {
            return undefined;
        }
        return { kind: 'edit', content: [{ type: 'text', text }] };
    }
    return undefined;
}

/**
 * 聊天 webview 统一接线：加载 UI + 处理消息（聊天/停止/文件/复制/工作区）。侧边栏和编辑器面板共用。
 * titlebarMode：模式字符串（侧边栏恒 = TITLEBAR_MODE；编辑器面板恒 'nativeTitle' 作"纯聊天无标题栏"标记）。
 */
function setupChatWebview(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    globalState: vscode.Memento,
    titlebarMode: TitlebarMode,
    isSidebar: boolean
): void {
    webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'chat')],
    };
    chatTarget = webview;
    void loadChatHtml(webview, extensionUri, titlebarMode);
    // 打开视图即确保 DSH 运行 + 当前工作区；chatInfo（权限/模型/统计）推送
    // 改由 webview 的 ready 触发，避免页面 JS 未就绪时 postMessage 丢失
    void (async () => {
        try {
            await dsh.ensureRunning();
            // 与 dsh 一致：当前工作区取 dsh 持久化数据里 updatedAt 最新的（不覆盖手动切换、不另存）
            await dsh.ensureCurrentWorkspace();
        } catch {
            // 服务不可用：后续命令会再触发
        }
    })();
    // 右键 @代码 草稿补投：只在侧栏实例创建时补（draft 只投侧栏对话），且等 ready 再发
    if (pendingDraft && isSidebar) {
        const draft = pendingDraft;
        pendingDraft = undefined;
        void (async () => {
            try {
                if (await waitChatReady(webview)) {
                    void webview.postMessage({ type: 'draft', text: draft });
                }
            } catch {
                // 实例销毁：忽略
            }
        })();
    }

    const gen = { n: 0 };
    const post = (msg: unknown) => {
        void webview.postMessage(msg);
    };

    /**
     * 本插件提交的回合结算：用量记账与统计刷新的**唯一时机**。
     *
     * 空闲发送与忙时排队/插话都走这里 —— 忙时提交没有返回值可挂（它不等本轮结束），
     * 两条路径各记一次迟早会变成两套口径（先前的记账挂在 askStreaming 返回之后）。
     */
    dsh.onTurnSettled = (info) => {
        // 回合已结算：待答交互（若有）随本轮作废
        clearPendingAsk();
        void recordUsage(globalState, info.stats, info.timeMs);
        for (const w of allChatWebviews()) {
            void postChatInfo(w);
        }
    };

    /** 整轮停止：使进行中的 askStreaming 失效，并请 dsh 取消当前会话回合，随后复位聊天 UI。 */
    const stopTurn = (): void => {
        clearPendingAsk();
        gen.n++; // 使进行中的流失效
        void (async () => {
            const sid = await dsh.getSession().catch(() => undefined);
            if (sid === undefined) {
                logRows('停止：拿不到当前会话 id，取消未发出');
                return;
            }
            try {
                await dsh.call('session.cancel', { sessionId: sid });
                logRows(`停止：已请求取消 session=${sid}`);
                // 取消被接受 = 这一轮不再跑。立刻把「在跑」这个事实推下去，
                // 不必等服务端补发 `turn/end`（那段时间里页面看不出变化）。
                dsh.markTurnStopped();
            } catch (e) {
                const code = e instanceof DshRpcError ? e.code : undefined;
                const msg = e instanceof Error ? e.message : String(e);
                // 取消失败必须说出来：否则界面上只表现为「点了没反应」，原因无从查起。
                logRows(`停止：取消失败 ${code ?? '(无码)'} ${msg}`);
                if (code === 'session/agent-busy') {
                    // 子会话的取消不走 `session.cancel`（服务端要求走子代理投递路径）：给出可行动的话术。
                    void vscode.window.showWarningMessage(
                        '这个会话是分叉出来的子会话，不能单独停止。请在它的源会话里停止，或等它自己结束。'
                    );
                } else {
                    void vscode.window.showWarningMessage(`未能停止本轮：${msg}${code === undefined ? '' : `（${code}）`}`);
                }
            }
        })();
        // 停止后的界面复位仍以服务端补发的 `turn/end` 为准（行构建据此定稿并带终止原因）。
        // 但那一步不经过正常的投影刷新，而服务端已经把这轮算进去了 —— 不补这几次读，
        // 左下角统计（轮次/用量）会停在停止前的值。取消是异步结算的，所以延时读，再补一次兜住更慢的结算。
        for (const delay of [400, 1200]) {
            setTimeout(() => {
                void postChatInfo(webview);
            }, delay);
        }
    };

    // 握手：页面脚本每次就绪都推一次 chatInfo（页面是**重建**的，宿主持有的是它的全部状态）。
    // **不要**用「只推一次」的标志（无论局部变量还是 readyChats）：页面 reload 时 provider 不重跑，
    // 标志还停在已推过 → `ready` 再来被挡住 → chatInfo / chatPrefs 一次都不推，
    // 表现为**面板重开后设置（紧凑/标准）不对齐**。重复推送是幂等的，代价远小于漏推。


    // 标题栏装配：按本 webview 的模式(mode)挂对应实现的消息处理（自绘标题栏 才有 webview→扩展 消息）。
    // 原生标题栏模式由宿主渲染按钮，webview 侧不需要扩展消息处理。删自绘标题栏时本行保持不变。
    const chatTitlebarHost: TitlebarChatHost = {
        post,
        listWorkspaces: () => listAllWorkspaces(),
        displayName: (w) => wsDisplayName(w),
        listWorkspaceSessions: (id) => listWorkspaceSessionsOf(id),
        wsSwitchNew: (id) => wsSwitchNew(id),
        // 未分组的伪标识在这里收口：`undefined` = 不设当前工作区、不补登记
        wsRestore: (id, sid, blank) => wsRestore(id === UNGROUPED_ID ? undefined : id, sid, blank),
        wsCreateNew: () => wsCreateNew(),
        getPanelState: () => ({ panelOpen: panel.hasPanel(), viewMode: panel.viewMode }),
        ensureReadyForList: async () => {
            await dsh.ensureRunning();
            await dsh.ensureCurrentWorkspace();
        },
        getCurrentWorkspaceId: () => dsh.getCurrentWorkspaceId(),
        ungroupedRow: async () => {
            const sessions = await listWorkspaceSessionsOf(UNGROUPED_ID);
            if (sessions.length === 0) {
                return undefined;
            }
            return {
                workspaceId: UNGROUPED_ID,
                name: UNGROUPED_NAME,
                current: dsh.getCurrentWorkspaceId() === undefined,
                newable: false,
            };
        },
    };
    installChatTitlebar(webview, titlebarMode, chatTitlebarHost);

    webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'ready') {
            readyChats.add(webview);
            void (async () => {
                try {
                    await dsh.ensureRunning();
                    await dsh.ensureCurrentWorkspace();
                } catch {
                    // 服务不可用：后续操作再触发
                }
                await postChatInfo(webview);
                await postChatPrefs();
                // 诊断留痕：输入框下方那两块读数（会话统计 / 模型用量）**全部来自投影**。
                // 真机排查「统计/用量不显示」先看这一行：键不在 → 宿主没拿到（服务端组合/时序）；
                // 键在但界面空 → 页面的显示门（`steps===0 && !hasTokens` 或简洁档两枚药丸都算不出）。
                logRows(`投影键 = ${dsh.projectionKeys().join(',') || '(空)'}`);
                ensureSettingsFollow();
                ensureAccountNotices();
                // 待答交互（审批/提问）不在日志里、也只发给发起那一轮的 webview：新建的面板补原帧
                if (pendingAsk !== undefined) {
                    post(pendingAsk);
                }
                // 页面是**重建**的，而行的唯一来源是宿主（开关打开时旧的历史指令被忽略）：
                // 就绪后补发当前会话的行，否则重开面板/切换视图时对话区空白。
                dsh.pushCurrentRows();
            })();
            return;
        }
        if (msg.type === 'goalAction') {
            // 目标条的动作：**直接打上游 goal RPC**（不等下一轮），回执原样回带 `key`。
            // 失败把 `message (code)` 交给页面内联显示（上游 GoalBar 同口径）。
            const m = msg as { key?: unknown; action?: unknown; objective?: unknown };
            const action = m.action;
            const key = typeof m.key === 'string' ? m.key : '';
            if (action === 'edit' || action === 'pause' || action === 'resume' || action === 'clear') {
                void (async () => {
                    const result = await dsh.goalAction(
                        action,
                        typeof m.objective === 'string' ? m.objective : undefined
                    );
                    post({
                        type: 'goalActionResult',
                        key,
                        action,
                        ...(result.error === undefined ? {} : { error: result.error }),
                    });
                    // 成功：投影随之变化，刷新一次 chatInfo 让目标条立刻换成新状态（不必等下一次轮询/事件）
                    if (result.error === undefined) {
                        await postChatInfo(webview);
                    }
                })();
            }
            return;
        }
        if (msg.type === 'chatSend') {
            const g = gen.n;
            void (async () => {
                try {
                    // 组装内容块：文本 + 图片（base64）
                    const parts: DshContentPart[] = [];
                    if (msg.text) {
                        parts.push({ type: 'text', text: msg.text });
                    }
                    for (const img of (msg.images ?? []) as Array<{ mediaType: string; data: string; name?: string }>) {
                        parts.push({
                            type: 'image',
                            mediaType: img.mediaType,
                            data: img.data,
                            name: img.name,
                        } as DshContentPart);
                    }
                    for (const f of (msg.files ?? []) as Array<{ receiptId: string }>) {
                        parts.push({ type: 'file', receiptId: f.receiptId } as DshContentPart);
                    }
                    if (parts.length === 0) {
                        return;
                    }
                    // 提交标识（页面 mint）：一路带到 session/prompt 的 requestId，
                    // 服务端回显 user/message 会带回同一值，页面据此认领本地已出的行（见 docs/design/08 §11）
                    const submitId = typeof msg.rpcId === 'string' ? msg.rpcId : undefined;
                    // 投递方式：页面按「忙时键位」选好（空闲恒 queue）
                    const mode: DshPromptMode = msg.mode === 'steer' ? 'steer' : 'queue';
                    // 诊断：与 buildRows 的 `user/message … rpcId=…` 对照，能直接断定标识配不配得上
                    console.warn(`[dsh-send] rpcId=${submitId ?? '(页面未给)'} mode=${mode}`);
                    // 忙时提交：**只提交、不等这一轮** —— 正在跑的那一轮由常驻订阅渲染，
                    // 这条消息的去向由队列流的投影呈现（页面本地只留一条「发送中」，等权威帧按 rpcId 认领）。
                    // 不走下面的 askStreaming：它是「提交 + 等本轮结束」，忙时用会把这次提交绑到**别人的回合**上。
                    if (dsh.isTurnActive()) {
                        try {
                            await dsh.submitQueued(parts, { requestId: submitId, mode });
                        } catch (e) {
                            // 失败只标掉队列卡里那条本地条目：**不走**下面那条对话区失败路径 ——
                            // 它会把正在跑的回答行定稿成错误（那一轮不是这次提交的）
                            post({
                                type: 'chatError',
                                scope: 'queue',
                                rpcId: submitId,
                                message: e instanceof Error ? e.message : String(e),
                            });
                        }
                        return;
                    }
                    // 提交这一刻就把「进行中」立起来：不等 turn/start 到达，
                    // 否则「用户消息回显」到「turn/start」之间按钮会中途变回「发送」（见 dshService.turnRunning）
                    dsh.beginTurn();
                    // 审批/提问不再从这里接：它们由宿主侧**常驻**订阅广播（见 dsh.onApproval/onQuestion）。
                    // 挂在回合上的话，面板没开时到达的 waterfall 帧会被直接丢弃。
                    await dsh.askStreaming(parts, { requestId: submitId });
                    // 回合的渲染结果（正文/统计/计数）由宿主下发的「行」承载。
                    // 用量记账与统计刷新**不在这里**：它们收在回合结算回调里（见上面的 dsh.onTurnSettled）——
                    // 忙时提交没有返回值可挂，两条提交路径只能共用一个时机。
                } catch (e) {
                    // 提交失败也要解除「进行中」：它只在收到 turn/end 时才会被清，
                    // 而失败的提交根本不会有 turn/end（否则会一直显示「终止」）。
                    dsh.endTurn();
                    if (g !== gen.n) {
                        return;
                    }
                    if (isNoWorkspace(e)) {
                        // 没有工作区：收尾本轮（error note）+ 引导选工作区，绝不静默建“未分组”会话
                        post({ type: 'chatError', message: '请先选择工作区，再开始对话', rpcId: typeof msg.rpcId === 'string' ? msg.rpcId : undefined });
                        void promptWorkspaceFirst('当前没有工作区，请先选择工作区再发送消息');
                        return;
                    }
                    // 不再把 '⚠ …' 塞进正文；回合内的失败与 token 上限由**独立终局行**承载（镜像上游 `turn-error` / `turn-max-tokens`，见 `TurnNoticeRow.ts`），
                    // 而这里走 `chatError` 的是**服务端还没有回合**的失败（没有 turn/end → 也没有失败行可挂）。
                    // 不用 `chatDone`：旧通路退役后继续发会被页面静默丢弃（既没有错误提示，输入区还卡在处理中）。
                    const message = e instanceof Error ? e.message : String(e);
                    post({ type: 'chatError', message, rpcId: typeof msg.rpcId === 'string' ? msg.rpcId : undefined });
                }
            })();
        } else if (msg.type === 'queueUpdate') {
            // 排队项的变更（编辑 / 删除 / 转插话）：动作**非乐观** —— 结果以服务端的队列帧为准。
            // 这里只处理「这次调用本身」的失败，以及两种竞态：条目已被取走、回合已不在跑。
            const kind = msg.action?.kind;
            const op: 'edit' | 'remove' | 'steer' = kind === 'remove' || kind === 'steer' ? kind : 'edit';
            void (async () => {
                try {
                    const action = toQueueAction(msg.action);
                    if (action === undefined) {
                        return; // 形状不合（或编辑内容为空）：本地拒，不发服务端
                    }
                    await dsh.updateQueue(msg.itemId, action);
                } catch (e) {
                    const code = e instanceof DshRpcError ? e.code : undefined;
                    // 两种竞态都表示「这条已经不在队列里了」：刷新即可，不是错误
                    if (code !== 'session/steer-unavailable' && code !== 'session/queue-item-not-found') {
                        post({ type: 'queueActionFailed', op, code });
                    }
                } finally {
                    // 成败都补一帧权威整表：成功时界面立刻反映（不等队列增量），竞态下这正是「刷新」那一步
                    dsh.pushQueue();
                }
            })();
        } else if (msg.type === 'cancel') {
            stopTurn();
        } else if (msg.type === 'chatFork') {
            // 从某条回答分叉（上游 session/fork）：建子会话 → 升号 → 切过去。
            // **不禁用输入区**（busy:loading 会连「终止」一起挡）——分叉是后台动作，失败只提示。
            void (async () => {
                const source = dsh.getSessionId();
                const atSeq = typeof msg.atSeq === 'number' ? msg.atSeq : undefined;
                console.warn(`[dsh-fork] 收到分支请求 source=${source ?? '(无会话)'} atSeq=${String(atSeq)}`);
                if (!source) {
                    vscode.window.showWarningMessage('还没有会话可分支');
                    return;
                }
                try {
                    const child = await dsh.forkSession(source, atSeq);
                    postToChats({ type: 'busy', kind: 'loading' });
                    // 失败也要解除 loading（同上：本链没有 catch，会让界面卡在「深度求索中」）
                    await dsh.restoreSession(child.sessionId).catch((e: unknown) => {
                        postToChats({ type: 'busy', kind: null });
                        throw e;
                    });
                    for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
                        void postChatInfo(w);
                    }
                    postToChats({ type: 'busy', kind: null });
                    // **必须给可见反馈**：子会话继承到切点为止的完整历史，所以对话区看起来**一模一样** ——
                    // 不给提示的话，用户只会以为"点了没反应"。（上游不需要它是因为它的会话列表里会多出一行。）
                    // 提示就一句「已在新对话中分支：<标题>」：标题本身已经说明成功了；
                    // 「为什么看起来一样」是解释性内容，写在提示里太长（真机反馈），不再带。
                    vscode.window.showInformationMessage(
                        `已在新对话中分支${child.title === undefined ? '' : `：${child.title}`}`
                    );
                } catch (e) {
                    // 上游两条入口都**静默吞掉**分叉失败；这里至少给一次提示（否则用户点了没反应）
                    vscode.window.showErrorMessage(`分支失败：${(e as Error).message}`);
                }
            })();
        } else if (msg.type === 'fileUploadReq') {
            // 文件上送：字节由宿主读并上传（webview 拿不到任意路径的字节）；成功/失败都回帧
            void (async () => {
                try {
                    const up = await chatInput.uploadFile(msg.path);
                    post({ type: 'fileUploaded', key: msg.key, receiptId: up.receiptId, name: up.name, ...(up.bytes === undefined ? {} : { bytes: up.bytes }) });
                } catch (e) {
                    post({ type: 'fileUploaded', key: msg.key, error: e instanceof Error ? e.message : String(e) });
                }
            })();
        } else if (msg.type === 'pickFile') {
            void (async () => {
                const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: '添加到 dsh 对话' });
                if (picked) {
                    for (const uri of picked) {
                        post({ type: 'filePicked', path: uri.fsPath });
                    }
                }
            })();
        } else if (msg.type === 'copy') {
            void vscode.env.clipboard.writeText(msg.text ?? '');
            vscode.window.showInformationMessage('已复制');
        } else if (msg.type === 'feedback') {
            // 消息反馈（👍/👎）：只做 RPC 桥接。业务失败（冲突/超长）**不抛**，按 code 原样回给页面选文案。
            void (async () => {
                const sid = dsh.getSessionId();
                if (!sid) {
                    post({ type: 'feedbackState', errorCode: 'no-session' });
                    return;
                }
                try {
                    if (msg.op === 'list') {
                        const items = await dsh.listFeedback(sid);
                        post({ type: 'feedbackState', sessionId: sid, items, categories: [...FEEDBACK_CATEGORIES] });
                        return;
                    }
                    const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
                    const outcome = msg.op === 'rate'
                        ? await dsh.putFeedback(
                              sid,
                              messageId,
                              msg.rating === 'negative' ? 'negative' : 'positive',
                              typeof msg.note === 'string' ? msg.note : undefined,
                              typeof msg.category === 'string' ? (msg.category as FeedbackCategory) : undefined,
                              typeof msg.ifVersion === 'string' ? msg.ifVersion : null
                          )
                        : await dsh.deleteFeedback(
                              sid,
                              messageId,
                              typeof msg.ifVersion === 'string' ? msg.ifVersion : ''
                          );
                    // 不论成败都重读一次全表：冲突时页面拿到的就是**权威现值**（上游同：用回帧里的 current 对齐，
                    // 不整表重取；这里表很小，重读一次比在页面维护版本更不容易出错）
                    const items = await dsh.listFeedback(sid).catch(() => []);
                    post({
                        type: 'feedbackState',
                        sessionId: sid,
                        items,
                        ...(outcome.ok ? {} : { errorCode: outcome.error.code ?? 'unknown' }),
                        ...(outcome.ok && msg.op === 'rate' ? { recorded: true } : {}),
                    });
                } catch (e) {
                    post({ type: 'feedbackState', sessionId: sid, errorCode: 'transport' });
                    console.warn(`[dsh-feedback] ${msg.op} 失败：${(e as Error).message}`);
                }
            })();
        } else if (msg.type === 'approvalResponse') {
            void (async () => {
                try {
                    await dsh.approvalResponse(msg.approvalId, !!msg.allow);
                    pendingAsk = undefined;
                    pendingAskRpcId = undefined;
                } catch (e) {
                    // 本地应答失败（如缺少 rpcId / 服务端拒绝）：提示用户去网页面板处理
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'questionResponse') {
            void (async () => {
                try {
                    await dsh.answerQuestion(msg.rpcId, msg.sessionId, msg.answers);
                    // 成功才算答完：清缓存并广播关帧。放成功分支里 —— 回答失败时卡片必须还在
                    //（发起侧本地已收起，两边都清就无从重试）。
                    clearPendingAsk();
                } catch (e) {
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'questionCancel') {
            void (async () => {
                // 关掉弹窗是**无论如何**都要做的第一步：它是本地 UI，不依赖这次取消是否送到服务端
                clearPendingAsk();
                try {
                    // dsh 接受"只取消该提问"：卡片移除，本轮 agent 继续。
                    // 返回 false = 该提问已不在挂起表里（已被处理 / 断流清过 / 网页端答过）——
                    // **那不是错误**：提问已经有结论了，本地关掉即可，**不要**因此停掉整轮
                    // （真机现象：先停止本轮 → 提问已被服务端 resolve → 再点关闭 → 误报「未找到」并把整轮又停一次）。
                    await dsh.cancelQuestion(msg.rpcId, msg.sessionId);
                } catch (e) {
                    // 只有**发送取消结果本身失败**（网关/网络）才需要回退：那时提问既没被取消、本轮还挂着，
                    // 停掉整轮避免 UI 卡死。
                    vscode.window.showWarningMessage(
                        `未能单独取消提问（${(e as Error).message}），已改为停止本轮对话`
                    );
                    stopTurn();
                }
            })();
        } else if (msg.type === 'questionLateAnswer') {
            // **补答**一道限时提问（走了另一条远端调用，不是上面的 $events 瀑布）：
            //   · 该题已不是可补答态（false）= 已有结论 → **静默收敛**，与「取消提问」同口径，不是错误；
            //   · 已在队列里（REPLY_QUEUED）→ 也不是失败，提示一句即可；
            //   · 其余错误码才按错误提示。
            void (async () => {
                try {
                    const stillContinued = await dsh.answerLateQuestion(
                        String(msg.callId ?? ''),
                        Array.isArray(msg.answers) ? msg.answers : [],
                        typeof msg.sessionId === 'string' ? msg.sessionId : undefined
                    );
                    const verdict = lateAnswerVerdict(
                        stillContinued === undefined ? {} : { returned: stillContinued }
                    );
                    if (verdict === 'queued') {
                        vscode.window.showInformationMessage('补答已提交，会作为新一轮消息继续这项工作');
                    }
                } catch (e) {
                    const code = e instanceof DshRpcError ? e.code : undefined;
                    if (lateAnswerVerdict(code === undefined ? {} : { code }) === 'failed') {
                        vscode.window.showErrorMessage((e as Error).message);
                    } else {
                        vscode.window.showInformationMessage('这道提问已经有回复在队列里了');
                    }
                }
            })();
        } else if (msg.type === 'openFile') {
            void openFileInEditor(msg.path, msg.line, msg.cwd);
        } else if (msg.type === 'attachmentReq') {
            // 附件大类：webview 按 attachmentId 懒取字节；失败也回帧（渲染侧显示失败态并可重试）
            void (async () => {
                try {
                    const img = await dsh.readImageAttachment(msg.attachmentId);
                    post({ type: 'attachmentBytes', attachmentId: msg.attachmentId, mediaType: img.mediaType, data: img.data });
                } catch (e) {
                    post({ type: 'attachmentBytes', attachmentId: msg.attachmentId, error: e instanceof Error ? e.message : String(e) });
                }
            })();
        } else if (msg.type === 'chatSelectModel') {
            void (async () => {
                try {
                    await dsh.selectModel(msg.provider, msg.model, msg.reasoningEffort || undefined);
                    await postChatInfo(webview);
                    vscode.window.showInformationMessage('已切换模型');
                } catch (e) {
                    if (isNoWorkspace(e)) {
                        void promptWorkspaceFirst('请先选择工作区，再切换模型');
                        return;
                    }
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'chatSelectMode') {
            void (async () => {
                try {
                    const applied = await dsh.switchAgentPreset(msg.agentPreset);
                    await postChatInfo(webview);
                    vscode.window.showInformationMessage(`已切换到模式：${applied}`);
                } catch (e) {
                    if (isNoWorkspace(e)) {
                        void promptWorkspaceFirst('请先选择工作区，再切换模式');
                        return;
                    }
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'chatModeConfig') {
            // F9「查看配置」：读该模式声明的子插件组合，用只读 YAML 打开【v0.1.15 · dsh 0.1.7】
            void (async () => {
                try {
                    const doc = await dsh.readAgentPreset(msg.agentPreset);
                    const header =
                        `# dsh agent preset: ${doc.agentPreset}${doc.name === undefined ? '' : ` (${doc.name})`}\n` +
                        '# 来源：dsh agentPresets/read（上游标注 for viewing only）\n' +
                        '# 仅供查看：编辑不会生效，改动模式声明请去 dsh 侧。\n\n';
                    const text = await vscode.workspace.openTextDocument({ content: header + doc.content, language: 'yaml' });
                    await vscode.window.showTextDocument(text, { preview: true });
                } catch (e) {
                    vscode.window.showErrorMessage(`读取模式配置失败：${(e as Error).message}`);
                }
            })();
        } else if (msg.type === 'chatSelectPermission') {
            void (async () => {
                try {
                    // 危险权限（如 danger-full-access）的确认已由聊天 UI 自绘弹窗完成
                    await dsh.setPermissionPreset(msg.preset);
                    // 等权限投影落定后再刷新（commands.execute 返回后事件已入账，稍等一拍更稳）
                    await new Promise((r) => setTimeout(r, 300));
                    await postChatInfo(webview);
                    // **切权限在对话区不显示任何行** —— 与上游一致。
                    // 依据（dsh 0.1.7-alpha.2 的节点可见性契约）：
                    //   isVisibleChatNode() 显式排除三条：system-prompt、context，
                    //   以及 `node.kind === 'command' && node.data.name === 'permission'`。
                    // 上游仍然把 `command/run` + `command/done` 写进会话日志（轨迹/检查能看到），
                    // 只是**渲染进 chat 时过滤掉权限命令** —— 所以对话区没有任何回显。
                    // 插件不走本地上游 transcript，因此这里**不下发**结果行（下发就成了多余的第三处）。
                    // 反馈由下方 VS Code 通知承担（面板切走时也可见）。
                    vscode.window.showInformationMessage(`切换至: ${msg.preset}`);
                } catch (e) {
                    if (isNoWorkspace(e)) {
                        void promptWorkspaceFirst('请先选择工作区，再切换权限');
                        return;
                    }
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'loadOlder') {
            // 往前翻一页历史（对齐上游 `ISession.loadOlder()`）：读更早的一页 prepend 进窗口，
            // 完成后由 `onRows` 自然下发（带 `historyHasMore`/`historyLoading`），页面按钮据此复位。
            // 失败**不上抛**：窗口没变、按钮复位即可，读不到更早的历史不是错误操作。
            void (async () => {
                try {
                    await dsh.loadOlderPage();
                } catch (e) {
                    console.warn('[dsh-rows] 加载更早的历史失败：', e);
                } finally {
                    dsh.flushRowsNow();
                }
            })();
        } else if (msg.type === 'slashListReq') {
            void (async () => {
                // 两侧**各自**可能拉不到（`undefined`）：只把拉到的那侧下发，缺的那侧让页面保留原值。
                // 都拉不到时下发一个两侧皆缺的帧 = 「整次失败」，页面保留现有菜单并稍后重试；
                // 若在这里把失败拼成空数组，一次失败就会把「/」菜单清成只剩客户端贡献的 /model。
                const [commands, skills] = await Promise.all([chatInput.listCommands(), chatInput.listSkills()]);
                if (commands === undefined && skills === undefined) {
                    console.warn('[dsh-slash] 命令与技能目录都没拉到：本次不下发目录（页面保留现有菜单，稍后重试）');
                }
                post({
                    type: 'slashCatalog',
                    ...(commands === undefined ? {} : { commands }),
                    ...(skills === undefined ? {} : { skills }),
                });
            })();
        } else if (msg.type === 'atListReq') {
            void (async () => {
                const refs = await chatInput.listAtRefs(msg.query ?? '');
                post({ type: 'atCatalog', query: msg.query ?? '', files: refs.files, sessions: refs.sessions });
            })();
        } else if (msg.type === 'slashRun') {
            const line = (msg.text ?? '').trim();
            const commandName = line.replace(/^\/+/, '').split(/[\s　]+/)[0] || '';
            void (async () => {
                // /export（无参）：上游 web 命令本体只回一句提示，真实下载是 GET /api/session.export 的 ZIP。
                // 插件在这里直接拉该路由 → 用户选保存路径写文件，得到真实「下载面」；服务不支持该路由则回退命令文本回显。
                if (commandName === 'export' && /^\/export\s*$/.test(line)) {
                    const dl = await chatInput.fetchSessionLogZip();
                    if (dl.ok) {
                        const uri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', dl.zip.filename)),
                            filters: { 'ZIP 归档': ['zip'] },
                            saveLabel: '导出会话日志',
                        });
                        if (!uri) {
                            post({ type: 'slashResult', ok: true, command: 'export', message: '已取消导出' });
                            return;
                        }
                        try {
                            await vscode.workspace.fs.writeFile(uri, dl.zip.data);
                            post({ type: 'slashResult', ok: true, command: 'export', message: `已导出会话日志：${uri.fsPath}` });
                        } catch (e) {
                            post({
                                type: 'slashResult',
                                ok: false,
                                command: 'export',
                                message: `保存会话日志失败：${e instanceof Error ? e.message : String(e)}`,
                            });
                        }
                        return;
                    }
                    if (!dl.unsupported) {
                        post({ type: 'slashResult', ok: false, command: 'export', message: dl.text });
                        return;
                    }
                    // 本服务没有下载路由：与上游一致，仅把 /export 命令返回的提示文本显示到对话区
                    const fallback = await chatInput.runCommand('/export');
                    post({ type: 'slashResult', ok: fallback.ok, command: 'export', message: fallback.text });
                    return;
                }
                // 其它命令（含带参 /export foo，上游返回错误）：走 commands/execute 文本回显
                const res = await chatInput.runCommand(line);
                post({ type: 'slashResult', ok: res.ok, command: commandName, message: res.text });
                // 成功/失败结果均已随 slashResult 回给 webview，由 store 显示在对话区(不走 VSCode 通知)；
                // 状态类命令(/plan /goal)由 refreshChatInfoAfterSlash 轮询投影，让 chip 收敛/消失
                await refreshChatInfoAfterSlash(webview, commandName);
            })();
        }
    });
}

/** 聊天从编辑器面板回到侧边栏：关面板 + 打开侧边栏 + 聚焦聊天视图 */
async function moveChatBackToSidebar(): Promise<void> {
    chatPanel?.dispose();
    chatPanel = undefined;
    await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
    await vscode.commands.executeCommand('workbench.view.extension.dsh');
}

/** Activity Bar 对话视图（侧边栏） */
class DshLauncherProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly globalState: vscode.Memento
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        launcherView = view;
        // 侧边栏/面板是「视图」，原生 view/title 能渲染到 → 直接按 TITLEBAR_MODE 走；isSidebar=true
        setupChatWebview(view.webview, this.extensionUri, this.globalState, TITLEBAR_MODE, true);
        view.onDidDispose(() => {
            if (launcherView === view) {
                launcherView = undefined;
            }
        });
    }
}

// ---------- 选中代码处理（右键） ----------

/** 读取当前编辑器选中内容；无选中返回 undefined 并提示 */
async function requireSelection(): Promise<{ editor: vscode.TextEditor; selection: vscode.Selection; text: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('请先打开一个文件并选中代码');
        return;
    }
    const text = editor.document.getText(editor.selection).trim();
    if (!text) {
        vscode.window.showWarningMessage('请先选中要处理的代码');
        return;
    }
    return { editor, selection: editor.selection, text };
}

interface SelectionContext {
    editor: vscode.TextEditor;
    selection: vscode.Selection;
    text: string;
}

/** 组装发送给 DSH 的提示词：指令 + 代码文件信息 + 选中代码 */
function buildPrompt(ctx: SelectionContext, instruction: string, noWriteHint: boolean): string {
    const lines = [
        instruction,
        '',
        `代码文件：${path.basename(ctx.editor.document.uri.fsPath)}（语言 ${ctx.editor.document.languageId}）`,
        '',
        '```' + ctx.editor.document.languageId,
        ctx.text,
        '```',
    ];
    if (noWriteHint) {
        lines.push('', '请直接给出文本结果，不要修改磁盘上的任何文件。');
    }
    return lines.join('\n');
}

/** 拿到 AI 回复后，让用户选择如何应用（原生 QuickPick） */
async function showApplyOptions(reply: string, ctx: SelectionContext, allowReplace: boolean): Promise<void> {
    const items: Array<{ label: string; description: string; action: 'replace' | 'insert' | 'copy' | 'open' }> = [
        ...(allowReplace
            ? [{ label: '$(symbol-event) 替换选中的代码', description: '用 AI 结果覆盖选中区域', action: 'replace' as const }]
            : []),
        { label: '$(insert) 插入到光标处', description: '把结果插到光标位置', action: 'insert' as const },
        { label: '$(copy) 复制到剪贴板', description: '复制 AI 回复全文', action: 'copy' as const },
        { label: '$(new-file) 在新编辑器标签打开', description: '不修改当前文件', action: 'open' as const },
    ];
    // items 先填再 show：sideX 等宿主对「show() 之后再写 items」的 QuickPick 可能不重绘列表
    //（现象：只剩搜索框、下面无选项），导致无法选择替换/插入。故用 createQuickPick 手动装配。
    const pick = vscode.window.createQuickPick<{ label: string; description: string; action: 'replace' | 'insert' | 'copy' | 'open' }>();
    pick.placeholder = allowReplace ? 'AI 处理完成，选择如何应用结果' : 'AI 回答完成，选择如何处理';
    pick.items = items;
    pick.show();

    let closed = false;
    const close = (): void => {
        if (!closed) {
            closed = true;
            pick.dispose();
        }
    };
    const runAction = (chosen: { action: 'replace' | 'insert' | 'copy' | 'open' }): void => {
        void (async () => {
            switch (chosen.action) {
                case 'replace':
                    await ctx.editor.edit((b) => b.replace(ctx.selection, reply));
                    break;
                case 'insert':
                    await ctx.editor.edit((b) => b.insert(ctx.selection.active, reply));
                    break;
                case 'copy':
                    await vscode.env.clipboard.writeText(reply);
                    vscode.window.showInformationMessage('已复制到剪贴板');
                    break;
                case 'open': {
                    const doc = await vscode.workspace.openTextDocument({
                        content: reply,
                        language: ctx.editor.document.languageId,
                    });
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    break;
                }
            }
        })();
    };
    pick.onDidChangeSelection((selection) => {
        const chosen = selection[0];
        if (!chosen || closed) {
            return;
        }
        close();
        runAction(chosen);
    });
    pick.onDidHide(close);
}

/** 把提示词发给本地 DSH，拿到 AI 回复后提供应用选项 */
async function runDshTask(prompt: string, ctx: SelectionContext, mode: 'apply' | 'ask'): Promise<void> {
    if (!(await dsh.ensureRunning())) {
        return;
    }
    let reply: string;
    try {
        reply = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: mode === 'apply' ? 'DSH 正在处理选中的代码…' : 'DSH 正在回答…',
                cancellable: true,
            },
            (_, token) => dsh.ask(prompt, { isCancelled: () => token.isCancellationRequested })
        );
    } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
        return;
    }
    if (!reply) {
        return;
    }
    await showApplyOptions(reply, ctx, mode === 'apply');
}

// ---------- 标题栏"工作区"面板 ----------

type WsPick = vscode.QuickPickItem & {
    action?: 'info' | 'ws' | 'wsnew' | 'session' | 'session-ungrouped' | 'wssessions-more' | 'new';
    workspaceId?: string;
    sessionId?: string;
    blank?: boolean;
};

/** 会话行（webview dropdown 展开用） */
interface WsSessionRow {
    sessionId: string;
    title: string;
    running: boolean;
    blank: boolean;
    /** 是否为当前正在使用的会话（用于 QuickPick / dropdown 标“当前”） */
    current?: boolean;
}

/** UI 展示用工作区名：title 优先，缺省用路径末级 */
function wsDisplayName(w: { path: string; title: string }): string {
    return w.title || path.basename(w.path);
}

/** 列出全部工作区（供 QuickPick / webview dropdown 共用） */
async function listAllWorkspaces(): Promise<Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>> {
    return ((await dsh.listWorkspaces()).items ?? []) as Array<{
        workspaceId: string;
        path: string;
        title: string;
        sessionIds: string[];
    }>;
}

/**
 * 在**编辑器区**打开一个文件（相对路径按会话工作区根 cwd 解析），可选跳到指定行。
 *
 * 两条通道，按文件类型分流（**图片不能当文本读**——`openTextDocument` 遇二进制会直接抛错）：
 *   - 文本：`openTextDocument` + `showTextDocument({selection})`，这样才支持跳到 `line`；
 *   - 图片等二进制：`vscode.open`，由 VS Code 内置的图片预览打开（png/jpg/gif/webp/bmp/ico）。
 *
 * 有意偏离上游：上游把行摘要里的路径交给**宿主默认程序**打开；本插件的聊天区就在 VS Code 里，
 * 交给编辑器打开才顺手（`preview: true`：复用预览标签，不刷一堆标签页）。
 * @param p - 路径（绝对或相对）。
 * @param line - 1 起的行号（仅文本文件用；图片忽略）。
 * @param cwd - 会话工作区根（相对路径的基准）；缺省用当前 VS Code 文件夹。
 */
async function openFileInEditor(p: string, line?: number, cwd?: string): Promise<void> {
    const base = cwd && cwd !== '' ? cwd : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
    const abs = path.isAbsolute(p) ? p : path.resolve(base, p);
    const uri = vscode.Uri.file(abs);
    if (!IMAGE_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const selection = line !== undefined && line > 0 ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
            await vscode.window.showTextDocument(doc, { preview: true, selection });
            return;
        } catch {
            /* 落到下面：二进制 / 未支持的编码 → 交给 vscode.open */
        }
    }
    try {
        await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
    } catch {
        vscode.window.showWarningMessage(`无法打开文件：${abs}`);
    }
}

/** VS Code 内置图片预览支持的扩展名（这些必须走 `vscode.open`，不能被读成文本）。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);

/**
 * 「未分组」这一组的伪工作区标识（会话不属于任何工作区时归到这里）。
 *
 * 为什么需要：网页端本来就有这一组；侧栏若没有，那些会话在侧栏里**彻底够不着**（只能去网页端找）。
 * 它没有工作区实体，所以从它打开会话时**不设当前工作区、也不做补登记**（就是"不属于任何工作区"）。
 */
const UNGROUPED_ID = '__ungrouped__';
const UNGROUPED_NAME = '未分组';

/** 拉取某工作区的会话（供 QuickPick / webview dropdown 共用）；未分组走另一条判据 */
async function listWorkspaceSessionsOf(wsId: string): Promise<WsSessionRow[]> {
    if (wsId === UNGROUPED_ID) {
        return dsh.listUngroupedSessions() as Promise<WsSessionRow[]>;
    }
    return dsh.listWorkspaceSessions(wsId) as Promise<WsSessionRow[]>;
}

/**
 * 切到工作区并开新会话（供 QuickPick / webview dropdown 共用；调用方负责关 UI）。
 *
 * **自己兜错、返回成败**（不往外抛）：新建会话这一步失败时宿主可能已经**建好了会话但没挂上工作区**
 * （`session/workspace-attach-failed`）—— 那种会话会以「未分组」留在列表里，必须让用户看见这条错误，
 * 而不是"点了没反应"。报错只在这里做一次，调用方按返回值决定要不要关 UI / 报失败，避免重复弹。
 * @returns 真的建好并切过去了才 true
 */
async function wsSwitchNew(wsId: string): Promise<boolean> {
    try {
        if (!(await ensureChatWebview())) {
            throw new Error('聊天视图未就绪，请先打开侧边栏 DSH 面板');
        }
        dsh.setCurrentWorkspace(wsId);
        await dsh.newSession(wsId);
        postToChats({ type: 'clear' });
        for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
            void postChatInfo(w);
        }
        vscode.window.showInformationMessage('已切换工作区');
        return true;
    } catch (e) {
        // 失败可能已经留下一条"建好但没归属"的会话，把原始错误一起写进控制台便于对账
        console.warn(`[dsh-ws] 新建会话失败 ws=${wsId}：${e instanceof Error ? e.message : String(e)}`);
        vscode.window.showErrorMessage(`新建会话失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

/** 把会话恢复到当前聊天（供 QuickPick / webview dropdown 共用；调用方负责关 UI）。
 *  `wsId` 传 `undefined` = 这一组是「未分组」：**不设当前工作区、也不补登记**（它本来就不属于任何工作区）。 */
async function wsRestore(wsId: string | undefined, sessionId: string, blank: boolean): Promise<void> {
    const target = await ensureChatWebview();
    if (!target) {
        throw new Error('聊天视图未就绪，请先打开侧边栏 DSH 面板');
    }
    if (!(await waitChatReady(target))) {
        throw new Error('聊天页面尚未就绪，请稍后重试');
    }
    if (wsId === undefined) {
        dsh.setCurrentWorkspace(undefined);
    } else {
        dsh.setCurrentWorkspace(wsId);
        // 侧栏里这个会话是「工作区成员 或 cwd 与该工作区一致」才出现的；后一种并没有登记进成员表，
        // 网页端就仍显示「未分组」。用户既然从这个工作区点开了它，就把它补登记进该工作区，两边从此一致。
        void dsh
            .bindSessionToWorkspace(wsId, sessionId)
            .then((bound) => {
                if (bound) {
                    console.log(`[dsh-ws] 会话已补登记进工作区 session=${sessionId} ws=${wsId}`);
                }
            })
            .catch((e: unknown) => {
                console.warn(`[dsh-ws] 会话补登记失败 session=${sessionId} ws=${wsId} error=${e instanceof Error ? e.message : String(e)}`);
            });
    }
    postToChats({ type: 'busy', kind: 'loading' }); // 恢复历史期间：composer 禁用 + 轻量占位
    // 抛错也要解除 loading：本函数**没有** catch，直接抛出去会让界面永远停在「深度求索中」
    const messages = await dsh.restoreSession(sessionId).catch((e: unknown) => {
        postToChats({ type: 'busy', kind: null });
        throw e;
    });
    console.warn(`[dsh-restore] session=${sessionId} messages=${messages.length}`);
    if (process.env['DSH_RAWLOG']) {
        // 历史用量/计时一致性诊断：打印每条 assistant 消息当前拿到的上游字段
        for (const m of messages) {
            if (m.role !== 'assistant') {
                continue;
            }
            console.log(
                `[dsh-raw] history-assistant len=${m.text.length} provider=${m.provider ?? '-'} model=${m.model ?? '-'} ` +
                    `in=${m.inputTokens ?? '-'} out=${m.outputTokens ?? '-'} cache=${m.cacheReadTokens ?? '-'} ` +
                    `wall=${m.wallSec ?? '-'} ttft=${m.ttftSec ?? '-'} tps=${m.tps ?? '-'}`
            );
        }
    }
    // 历史**不再走页面重建**：行由宿主下发（上面的 restoreSession 已触发），页面整表替换即可。
    for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
        void postChatInfo(w);
    }
    postToChats({ type: 'busy', kind: null });
}

/** 新建工作区（弹目录选择；供 QuickPick / webview dropdown 共用） */
async function wsCreateNew(): Promise<boolean> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        openLabel: '作为 dsh 工作区',
    });
    if (!picked || picked.length === 0) {
        return false;
    }
    const dir = picked[0].fsPath;
    const created = await dsh.createWorkspace(dir);
    dsh.setCurrentWorkspace(created.workspace.workspaceId);
    await dsh.newSession(created.workspace.workspaceId);
    postToChats({ type: 'clear' });
    for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
        void postChatInfo(w);
    }
    vscode.window.showInformationMessage(`已新建并切换到工作区：${created.workspace.title || path.basename(dir)}`);
    return true;
}

/**
 * 标题栏"工作区"面板：可展开/折叠的树。
 * 每个工作区一行，前面带折叠图标（▶ 折叠 / ▼ 展开）；展开后在其下方列出
 * 该工作区的会话（点会话=切到该工作区并恢复），并提供"在此工作区新开会话"。
 * 顶部显示当前工作区；底部可新建工作区。Esc / 失焦关闭。
 */
async function showWorkspacePicker(): Promise<void> {
    if (!(await dsh.ensureRunning())) {
        return;
    }
    try {
        // 与 dsh 一致：取 dsh 持久化里 updatedAt 最新的工作区，不再强制绑回当前文件夹
        await dsh.ensureCurrentWorkspace();
    } catch {
        // 忽略：仍可展示已列出的工作区
    }

    let workspaces: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }> = [];
    try {
        workspaces = await listAllWorkspaces();
    } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
        return;
    }

    const expanded = new Set<string>();
    const sessionCache = new Map<string, WsSessionRow[]>();
    const pick = vscode.window.createQuickPick<WsPick>();
    pick.placeholder = '展开工作区查看会话；点会话恢复历史';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;

    let disposed = false;
    const close = (): void => {
        if (!disposed) {
            disposed = true;
            pick.dispose();
        }
    };
    pick.onDidHide(close);

    const currentId = (): string | undefined => dsh.getCurrentWorkspaceId();

    /**
     * 每个分组的会话显示上限与网页端一致（普通会话最多 5 条；空白会话不占额）：
     * 超出的部分折成一行「展开其余 N 个会话」，展开态按分组记在本地。
     */
    const COLLAPSED_SESSION_LIMIT = 5;
    const sessionsExpanded = new Set<string>();
    /** 折叠视图：普通会话最多 5 条（空白会话不占额）。**与展开态无关** —— 溢出控件的条数由它算。 */
    function collapsedPickSessions(sessions: WsSessionRow[]): WsSessionRow[] {
        let ordinary = 0;
        return sessions.filter((s) => {
            if (s.blank) {
                return true;
            }
            if (ordinary >= COLLAPSED_SESSION_LIMIT) {
                return false;
            }
            ordinary += 1;
            return true;
        });
    }
    /** 实际列出的会话：展开态全列，否则折叠视图。 */
    function shownPickSessions(id: string, sessions: WsSessionRow[]): WsSessionRow[] {
        return sessionsExpanded.has(id) ? sessions : collapsedPickSessions(sessions);
    }
    /**
     * 折叠时会被折起来的条数 —— 决定要不要出「展开其余 N 个会话 / 收起」这一行。
     * **展开态也照算**：否则点开之后这一行就消失了，用户没有"收起"可点。
     */
    function pickSessionsHidden(sessions: WsSessionRow[]): number {
        return sessions.length - collapsedPickSessions(sessions).length;
    }
    /** 溢出控件行（展开时显示「收起」，否则「展开其余 N 个会话」）。 */
    function pickMoreRow(workspaceId: string, sessions: WsSessionRow[]): WsPick | undefined {
        const hidden = pickSessionsHidden(sessions);
        if (hidden === 0) {
            return undefined;
        }
        return {
            label: `    $(ellipsis) ${sessionsExpanded.has(workspaceId) ? '收起' : `展开其余 ${hidden} 个会话`}`,
            action: 'wssessions-more',
            workspaceId,
            alwaysShow: true,
        };
    }

    function buildRows(): WsPick[] {
        const curId = currentId();
        const curWs = workspaces.find((w) => w.workspaceId === curId);
        const rows: WsPick[] = [
            {
                label: `$(folder-opened) 工作区：${curWs ? wsDisplayName(curWs) : '未分组'}`,
                description: curId ? '当前' : '未选择',
                action: 'info',
                alwaysShow: true,
            },
        ];
        // sideX 等宿主未必导出 QuickPickItemKind（缺省时取 .Separator 会抛 "reading 'Separator'"）：
        // 仅当其可用时才插入分组分隔行。
        if (vscode.QuickPickItemKind) {
            rows.push({ label: '工作区', kind: vscode.QuickPickItemKind.Separator });
        }
        for (const w of workspaces) {
            const isCurrent = w.workspaceId === curId;
            const open = expanded.has(w.workspaceId);
            rows.push({
                label: `${open ? '$(chevron-down)' : '$(chevron-right)'} ${isCurrent ? '$(check) ' : ''}${wsDisplayName(w)}`,
                description: isCurrent ? '当前' : undefined,
                action: 'ws',
                workspaceId: w.workspaceId,
                alwaysShow: true,
            });
            if (!open) {
                continue;
            }
            rows.push({
                label: '    $(add) 在此工作区新开会话',
                description: isCurrent ? '' : '切换到此工作区',
                action: 'wsnew',
                workspaceId: w.workspaceId,
                alwaysShow: true,
            });
            const sessions = sessionCache.get(w.workspaceId);
            if (sessions) {
                for (const s of shownPickSessions(w.workspaceId, sessions)) {
                    rows.push({
                        // 当前会话标选中 + 描述「当前」，与自绘 dropdown 一致
                        label: `        ${s.current ? '$(check) ' : s.running ? '$(sync~spin) ' : '$(history) '}${s.title}`,
                        description: s.current ? '当前' : s.running ? '运行中' : '恢复',
                        action: 'session',
                        workspaceId: w.workspaceId,
                        sessionId: s.sessionId,
                        blank: s.blank,
                        alwaysShow: true,
                    });
                }
                const more = pickMoreRow(w.workspaceId, sessions);
                if (more) {
                    rows.push(more);
                }
            }
        }
        // 「未分组」：不属于任何工作区的会话（与网页端同一组）。**与其他工作区同一种组样式**
        // （同一个展开交互、同一个会话上限与溢出控件），位置在"新建工作区"之上。没有会话时不显示。
        const ungrouped = sessionCache.get(UNGROUPED_ID);
        if (ungrouped !== undefined && ungrouped.length > 0) {
            const ungroupedOpen = expanded.has(UNGROUPED_ID);
            rows.push({
                label: `${ungroupedOpen ? '$(chevron-down)' : '$(chevron-right)'} ${
                    curId === undefined ? '$(check) ' : ''
                }${UNGROUPED_NAME}`,
                description: curId === undefined ? '当前' : undefined,
                action: 'ws',
                workspaceId: UNGROUPED_ID,
                alwaysShow: true,
            });
            if (ungroupedOpen) {
                for (const s of shownPickSessions(UNGROUPED_ID, ungrouped)) {
                    rows.push({
                        label: `        ${s.current ? '$(check) ' : s.running ? '$(sync~spin) ' : '$(history) '}${s.title}`,
                        description: s.current ? '当前' : s.running ? '运行中' : '恢复',
                        action: 'session-ungrouped',
                        sessionId: s.sessionId,
                        blank: s.blank,
                        alwaysShow: true,
                    });
                }
                const more = pickMoreRow(UNGROUPED_ID, ungrouped);
                if (more) {
                    rows.push(more);
                }
            }
        }
        rows.push({ label: '$(new-folder) ＋ 新建工作区…', action: 'new', alwaysShow: true });
        return rows;
    }

    /** 仅在本 QuickPick 仍展示时才更新 items。先 show 再填、且已 dispose 不再改行，
     *  可避免对“未挂到 DOM / 已关闭”的列表设行触发 VS Code 内部
     *  “Measuring item node that is not in DOM … ListView”量高报错。 */
    const refresh = (): void => {
        if (disposed) {
            return;
        }
        pick.items = buildRows();
    };

    const loadSessions = async (id: string): Promise<void> => {
        if (sessionCache.has(id) || disposed) {
            return;
        }
        pick.busy = true;
        try {
            const sessions = await listWorkspaceSessionsOf(id);
            console.warn(`[dsh-ws] load workspace=${id} sessions=${sessions.length}`);
            sessionCache.set(id, sessions);
        } catch (e) {
            console.warn(`[dsh-ws] load failed workspace=${id} error=${e instanceof Error ? e.message : String(e)}`);
            sessionCache.set(id, []);
        } finally {
            if (!disposed) {
                pick.busy = false;
            }
        }
    };

    // 「未分组」这一组**不做折叠**（它没有"新开会话"这种动作），所以打开选择器就先拉一次并重画
    void (async () => {
        await loadSessions(UNGROUPED_ID);
        refresh();
    })();

    pick.onDidChangeSelection(async (selection) => {
        const row = selection[0];
        if (!row?.action) {
            return;
        }
        try {
            if (row.action === 'ws' && row.workspaceId) {
                const id = row.workspaceId;
                if (expanded.has(id)) {
                    expanded.delete(id);
                } else {
                    expanded.add(id);
                    refresh();
                    await loadSessions(id);
                }
                refresh();
            } else if (row.action === 'wsnew' && row.workspaceId) {
                // 成败由 wsSwitchNew 自己报（含"会话已建但没挂上工作区"那种失败）→ 成功才关面板
                if (await wsSwitchNew(row.workspaceId)) {
                    close();
                }
            } else if (row.action === 'session' && row.workspaceId && row.sessionId) {
                await wsRestore(row.workspaceId, row.sessionId, row.blank === true);
                close();
            } else if (row.action === 'wssessions-more' && row.workspaceId) {
                // 「展开其余 N 个会话 / 收起」：只切本地展开态，不重拉数据
                if (sessionsExpanded.has(row.workspaceId)) {
                    sessionsExpanded.delete(row.workspaceId);
                } else {
                    sessionsExpanded.add(row.workspaceId);
                }
                refresh();
            } else if (row.action === 'session-ungrouped' && row.sessionId) {
                // 未分组：不设当前工作区、不补登记（它本来就不属于任何工作区）
                await wsRestore(undefined, row.sessionId, row.blank === true);
                close();
            } else if (row.action === 'new') {
                if (await wsCreateNew()) {
                    close();
                }
            }
        } catch (e) {
            vscode.window.showErrorMessage((e as Error).message);
        }
    });

    // items 先填再 show：sideX 等宿主对「show() 之后再写 items」的 QuickPick 可能不重绘列表
    //（现象：只剩搜索框、下面无行）。上游 createQuickPick 用法即“先 items 后 show”。
    // show() 之后的动态填行只发生在展开/懒加载路径（refresh），那时列表已挂到 DOM，安全。
    pick.items = buildRows();
    pick.show();
}

// ---------- 缺工作区引导（建会话必须有工作区，杜绝“未分组”） ----------

/** 是否“需要工作区但取不到默认”的错误（见 dshService.DshNoWorkspaceError）。 */
function isNoWorkspace(e: unknown): boolean {
    return e instanceof DshNoWorkspaceError || ((e as { code?: string } | undefined)?.code === 'NO_WORKSPACE');
}

/** 无工作区时的统一引导：提示 + 打开工作区面板（选已有 / 新建）。调用方负责不再继续建会话。 */
async function promptWorkspaceFirst(message: string): Promise<void> {
    vscode.window.showWarningMessage(message);
    await showWorkspacePicker();
}

// ---------- 激活入口（薄装配） ----------

export function activate(context: vscode.ExtensionContext) {
    // 让服务层能记住自起实例的端口/pid（随机端口下次才找得回来）
    dsh.attachGlobalState(context.globalState);
    // 端点端口变化 → 在途连接已由 DshService 重新指向；这里再把**本地网页代理**换到新端口并刷新内嵌面板。
    // 只重绑插件这一侧的通道，不动服务端进程：侧栏 / 本地面板 / 外部浏览器共用同一个实例。
    dsh.onEndpointChanged = () => {
        void panel.rebindEndpoint();
    };

    // 命令：打开 DSH 网页面板
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.open', async () => {
            if (await dsh.ensureRunning()) {
                await panel.openPanel();
            }
        })
    );

    // 命令：用 DSH 处理选中代码（可替换/插入）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.applySelected', async () => {
            const ctx = await requireSelection();
            if (!ctx) {
                return;
            }
            const instruction = await vscode.window.showInputBox({
                prompt: '要让 DSH 对选中的代码做什么？',
                placeHolder: '例如：重构这段代码 / 解释这段代码 / 写单元测试 / 修复 bug',
                value: '重构这段代码',
            });
            if (instruction === undefined) {
                return;
            }
            await runDshTask(buildPrompt(ctx, `请对下面的选中代码执行：${instruction}`, true), ctx, 'apply');
        })
    );

    // 命令：关于选中代码提问（只回答，不改码）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.askSelected', async () => {
            const ctx = await requireSelection();
            if (!ctx) {
                return;
            }
            const question = await vscode.window.showInputBox({
                prompt: '针对选中的代码提问：',
                placeHolder: '例如：这段代码有什么问题？这段逻辑是做什么的？',
            });
            if (question === undefined) {
                return;
            }
            await runDshTask(buildPrompt(ctx, `针对下面的选中代码回答问题：${question}`, false), ctx, 'ask');
        })
    );

    // 命令：把选中代码 @ 进左侧栏聊天输入框（只投侧栏 dsh.launcher；不投编辑器面板）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.sendToDsh', async () => {
            const ctx = await requireSelection();
            if (!ctx) {
                return;
            }
            const code = '```' + ctx.editor.document.languageId + '\n' + ctx.text + '\n```';
            await vscode.commands.executeCommand('workbench.view.extension.dsh');
            // 确保侧栏视图已 resolve（launcherView 就绪）；没就绪记 pendingDraft 由侧栏创建时补投
            if (!launcherView?.webview) {
                pendingDraft = code;
                return;
            }
            const w = launcherView.webview;
            // 等该侧栏实例 ready 再投，避免 webview 未挂好 draft 监听就 postMessage 丢内容
            void (async () => {
                try {
                    if (await waitChatReady(w)) {
                        w.postMessage({ type: 'draft', text: code });
                    }
                } catch {
                    // 实例已销毁：忽略
                }
            })();
        })
    );

    // 命令：标题栏"工作区"面板（选/建工作区 + 恢复会话）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.workspace', () => showWorkspacePicker())
    );

    // 命令：开启新会话（需先选工作区）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.newSession', async () => {
            try {
                if (!(await dsh.ensureRunning())) {
                    return;
                }
                // 先尝试取默认工作区（dsh 最新 / 当前文件夹）；取不到才提示选工作区（绝不建“未分组”会话）
                await dsh.ensureCurrentWorkspace();
                if (!dsh.getCurrentWorkspaceId()) {
                    await promptWorkspaceFirst('请先选择工作区，再开启新会话');
                    return;
                }
                await dsh.newSession();
                // 广播到全部存活聊天实例（侧栏 + 编辑器面板），确保点按钮的那个一定被清成新会话
                postToChats({ type: 'clear' });
                for (const w of allChatWebviews()) {
                    void postChatInfo(w);
                }
                vscode.window.showInformationMessage('已开启新会话');
            } catch (e) {
                // 兜住失败：新建这一步出错时**不会**有 `clear`/`chatInfo`/成功提示，
                // 而且宿主可能已经建好了会话却没挂上工作区（`session/workspace-attach-failed`）——
                // 那条会话会以「未分组」留在列表里，所以必须让用户看见原因（原先这里没有 catch，静默失败）。
                if (isNoWorkspace(e)) {
                    await promptWorkspaceFirst('请先选择工作区，再开启新会话');
                    return;
                }
                console.warn(`[dsh-ws] 开启新会话失败：${e instanceof Error ? e.message : String(e)}`);
                vscode.window.showErrorMessage(`开启新会话失败：${e instanceof Error ? e.message : String(e)}`);
            }
        })
    );

    // 命令：在浏览器中打开 DSH
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.openInBrowser', () => panel.openInBrowser())
    );

    // 命令：在本地打开 DSH
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.openInEditor', () => panel.openInEditor())
    );

    // 命令：刷新所有 DSH 面板
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.reload', () => panel.reloadPanels())
    );

    // 命令：关闭侧边栏（标题栏 👁）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.closeSidebar', () => {
            vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
        })
    );

    // 命令：把聊天对话移动到编辑器区（大面板，可全屏；纯聊天，不自绘标题栏）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.moveToEditor', async () => {
            // 与侧栏/DSH 网页面板一致：后台保活上下文，避免切走再切回内容变空白
            const retainPanel = vscode.workspace.getConfiguration('dsh').get<boolean>('retainContextWhenHidden', true);
            const panel = vscode.window.createWebviewPanel(
                'dshChatPanel',
                'DeepSeek Harness',
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: retainPanel }
            );
            chatPanel = panel;
            panel.onDidDispose(() => {
                if (chatPanel === panel) {
                    chatPanel = undefined;
                }
            });
            // 编辑器区 = createWebviewPanel：既渲染不到原生 view/title，也不需要页内自绘标题栏
            //（保持纯聊天）→ 注入 data-titlebar-mode="nativeTitle"，index.html 用 CSS 隐藏 #titlebar、
            // 自绘模块读到非 selfDrawn 直接 return。
            setupChatWebview(panel.webview, context.extensionUri, context.globalState, 'nativeTitle', false);
            panel.reveal(vscode.ViewColumn.One, true);
            // 隐藏侧边栏，看起来"挪过去"了
            vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
            // 把侧边栏正在看的当前会话搬到编辑器：等新面板 ready 后重新 restore 并广播历史
            void (async () => {
                const sessionId = dsh.getSessionId();
                const target = panel.webview;
                if (!sessionId || !(await waitChatReady(target))) {
                    return;
                }
                try {
                    postToChats({ type: 'busy', kind: 'loading' });
                    // 同 wsRestore：出错路径若不清 loading，界面会卡在「深度求索中」
                    const messages = await dsh.restoreSession(sessionId).catch((e: unknown) => {
                        postToChats({ type: 'busy', kind: null });
                        throw e;
                    });
                    console.warn(`[dsh-move] session=${sessionId} messages=${messages.length}`);
                    // 同 wsRestore：行由宿主下发，页面整表替换
                    for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
                        void postChatInfo(w);
                    }
                    postToChats({ type: 'busy', kind: null });
                } catch (e) {
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        })
    );

    // 命令：聊天回到侧边栏
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.moveToSidebar', () => {
            void moveChatBackToSidebar();
        })
    );

    // 初始化上下文（视图标题栏按钮显隐依据）
    vscode.commands.executeCommand('setContext', 'dshViewMode', panel.viewMode);
    vscode.commands.executeCommand('setContext', 'dshPanelOpen', false);
    // 原生/自绘 标题栏开关（不猜宿主）：selfDrawn → false 屏蔽 package.json 全部 view/title
    // 原生按钮；nativeTitle → true，原生按钮出现并受上面两个上下文继续控制显隐。
    // 实现收在 src/titlebar/native/（删原生标题栏时删本调用即可）。
    applyNativeTitlebarContext(TITLEBAR_MODE === 'nativeTitle');

    // 命令：查看消费记录（弹窗报告面板）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.usage', () => openUsageReport(context.globalState))
    );

    // Activity Bar 对话视图
    const retainChat = vscode.workspace.getConfiguration('dsh').get<boolean>('retainContextWhenHidden', true);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'dsh.launcher',
            new DshLauncherProvider(context.extensionUri, context.globalState),
            { webviewOptions: { retainContextWhenHidden: retainChat } }
        )
    );
}

// 扩展停用/被卸载前收尾：先关掉自己开的 Webview（避免宿主在卸载时解析已移除扩展的
// extensionId 报错），再回收后台进程
export function deactivate() {
    disposeAccountNotices?.();
    chatPanel?.dispose();
    chatPanel = undefined;
    panel.dispose();
    dsh.dispose();
}
