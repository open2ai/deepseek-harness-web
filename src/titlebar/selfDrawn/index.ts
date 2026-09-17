// ===== 自绘标题栏（页内 #titlebar）· 宿主侧独立模块 =====
// 承载自绘标题栏专属的 webview→扩展 消息(titleAction / wsDropdown / selfInfoReq)与
// panelState 广播接线。不 import extension.ts 与 titlebar/index.ts(避免循环依赖),依赖经 ctx 注入。
//
// 与原生标题栏(VS Code view/title)的关系:
//   - 原生标题栏宿主侧本体 = package.json menus.view/title + native/(setContext),原生按钮走 dsh.* 命令,
//     不经本模块。
//   - 本模块只服务自绘标题栏:sidex(不渲染原生头) 与 moveToEditor(编辑器区) 都靠它。
//
// ==== 删自绘标题栏(只留原生)====
//   1. 删本目录(src/titlebar/selfDrawn/)
//   2. webview 侧自绘(库 components/titlebar 自绘组件 + 静态 #titlebar CSS/DOM)
//   3. src/titlebar/index.ts:installChatTitlebar / makeTitlebarPanelBroadcaster 的自绘分支去掉
//   4. extension.ts 不需改(只认 titlebar/index 接缝)
import * as vscode from 'vscode';

/** 自绘标题栏白名单命令(页内 data-cmd → dsh.* 命令) */
const TITLE_COMMANDS = new Set([
    'newSession',
    'openInBrowser',
    'openInEditor',
    'reload',
    'closeSidebar',
    'moveToEditor',
    'usage',
]);

/** 会话行(webview wsDropdownSessions 用;结构须与扩展共享 helper 返回一致) */
export interface SelfSessionRow {
    sessionId: string;
    title: string;
    running: boolean;
    blank: boolean;
    /** 是否为当前正在使用的会话(用于 dropdown 标"当前/选中") */
    current?: boolean;
}

/** 工作区行(webview wsDropdownList 用) */
interface SelfWorkspaceRow {
    workspaceId: string;
    name: string;
    current: boolean;
    /** 该行能否"在此新开会话"（「未分组」不行：它没有工作区实体，见 SelfDrawnTitlebarCtx.ungroupedRow） */
    newable?: boolean;
}

/** 自绘标题栏模块需要的宿主能力(由 extension.ts 组装实现,全注入、不 import 内部) */
export interface SelfDrawnTitlebarCtx {
    /** 应答单条 webview(与共享监听器同源 post) */
    post(msg: unknown): void;
    /** 拉工作区列表(共享 helper listAllWorkspaces 的薄封装) */
    listWorkspaces(): Promise<Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>>;
    /** 展示用工作区名(共享 helper wsDisplayName) */
    displayName(w: { path: string; title: string }): string;
    /** 拉某工作区会话(共享 helper listWorkspaceSessionsOf) */
    listWorkspaceSessions(wsId: string): Promise<SelfSessionRow[]>;
    /** 切工作区并开新会话(共享 helper wsSwitchNew)；**自己兜错并回报成败**，不往外抛 */
    wsSwitchNew(wsId: string): Promise<boolean>;
    /** 恢复会话(共享 helper wsRestore) */
    wsRestore(wsId: string, sessionId: string, blank: boolean): Promise<void>;
    /** 新建工作区(共享 helper wsCreateNew) */
    wsCreateNew(): Promise<boolean>;
    /** 取 DSH 网页面板开关/查看模式(供 selfInfo:浏览器/本地/刷新按钮显隐) */
    getPanelState(): { panelOpen: boolean; viewMode: 'internal' | 'browser' };
    /** 确保 dsh 运行 + 解析当前工作区(共享层) */
    ensureReadyForList(): Promise<void>;
    /** 取当前工作区 id(共享层) */
    getCurrentWorkspaceId(): string | undefined;
    /**
     * 「未分组」那一行；没有这类会话时返回 undefined。
     * 它的 `workspaceId` 是**伪标识**：`sessions` 与 `session` 两个 op 都会走到"不设工作区"的分支。
     */
    ungroupedRow(): Promise<SelfWorkspaceRow | undefined>;
}

/** panelState 广播构造器:DshPanel 面板开/关或 viewMode 变化 → 通知自绘标题栏 webview 显隐按钮 */
export function createPanelStateBroadcaster(
    broadcast: (msg: unknown) => void
): (state: { panelOpen: boolean; viewMode: 'internal' | 'browser' }) => void {
    return (state) => {
        broadcast({ type: 'panelState', ...state });
    };
}

/**
 * 给单个 chat webview 安装自绘标题栏专属消息处理(独立 onDidReceiveMessage,与共享监听器并存)。
 * 处理:titleAction(转 dsh.* 命令)、wsDropdown(list/sessions/wsnew/session/new)、
 * selfInfoReq(应答 selfInfo)。返回 Disposable 供视图销毁时清理。
 */
export function installSelfDrawnTitlebarMessages(
    webview: vscode.Webview,
    ctx: SelfDrawnTitlebarCtx
): vscode.Disposable {
    return webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'titleAction') {
            const cmd = String(msg.cmd ?? '');
            if (TITLE_COMMANDS.has(cmd)) {
                void vscode.commands.executeCommand(`dsh.${cmd}`);
            }
            return;
        }
        if (msg.type === 'wsDropdown') {
            const op = String(msg.op ?? '');
            void (async () => {
                try {
                    if (op === 'list') {
                        await ctx.ensureReadyForList();
                        const workspaces = await ctx.listWorkspaces();
                        const currentId = ctx.getCurrentWorkspaceId();
                        const rows: SelfWorkspaceRow[] = workspaces.map((w) => ({
                            workspaceId: w.workspaceId,
                            name: ctx.displayName(w),
                            current: w.workspaceId === currentId,
                        }));
                        // 「未分组」排在最后（与网页端的分组顺序一致）：没有这一类会话时不占位
                        const ungrouped = await ctx.ungroupedRow();
                        if (ungrouped !== undefined) {
                            rows.push(ungrouped);
                        }
                        ctx.post({ type: 'wsDropdownList', currentId, workspaces: rows });
                    } else if (op === 'sessions' && msg.workspaceId) {
                        const sessions = await ctx.listWorkspaceSessions(String(msg.workspaceId));
                        ctx.post({ type: 'wsDropdownSessions', workspaceId: msg.workspaceId, sessions });
                    } else if (op === 'wsnew' && msg.workspaceId) {
                        // wsSwitchNew 自己已报错：这里只回报成败，别让它再抛一次被下面兜住（会重复弹一条）
                        const ok = await ctx.wsSwitchNew(String(msg.workspaceId));
                        ctx.post({ type: 'wsActionDone', ok });
                    } else if (op === 'session' && msg.workspaceId && msg.sessionId) {
                        await ctx.wsRestore(String(msg.workspaceId), String(msg.sessionId), msg.blank === true);
                        ctx.post({ type: 'wsActionDone', ok: true });
                    } else if (op === 'new') {
                        const created = await ctx.wsCreateNew();
                        ctx.post({ type: 'wsActionDone', ok: created });
                    }
                } catch (e) {
                    ctx.post({ type: 'wsActionDone', ok: false, message: e instanceof Error ? e.message : String(e) });
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
            return;
        }
        if (msg.type === 'selfInfoReq') {
            void (async () => {
                try {
                    // 从 ctx 原语解析自绘标题栏信息:当前工作区名 + DSH 网页面板态
                    await ctx.ensureReadyForList();
                    const id = ctx.getCurrentWorkspaceId();
                    let workspaceName: string | undefined;
                    if (id) {
                        const workspaces = await ctx.listWorkspaces();
                        const cur = workspaces.find((w) => w.workspaceId === id);
                        if (cur) {
                            workspaceName = ctx.displayName(cur);
                        }
                    }
                    ctx.post({ type: 'selfInfo', workspaceName, ...ctx.getPanelState() });
                } catch {
                    // 服务未就绪:保持 webview 当前显示即可
                }
            })();
            return;
        }
    });
}
