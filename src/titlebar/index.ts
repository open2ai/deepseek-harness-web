// 标题栏两种实现的唯一接缝(TS 常量,不是 contributes.configuration 设置项)。
//   nativeTitle = VS Code 原生 `view/title`(按钮渲染在 webview 视图头,依赖宿主渲染原生头)
//                 —— 宿主侧实现收在 ./native/,webview 页无代码;
//   selfDrawn   = 页内自绘 #titlebar(sidex 等不渲染原生 webview 视图头的宿主唯一可用形态)
//                 —— 宿主侧实现收在 ./selfDrawn/,webview 侧在聊天库 components/titlebar。
// 改 TITLEBAR_MODE 一个常量即可整套切换(默认 'nativeTitle')。extension.ts 只 import 本接缝文件,
// 具体实现各自独立、可整删,见下方删删清单。
//
// ==== 删原生标题栏(只留自绘)====
//   1. 删 src/titlebar/native/(setContext + TITLEBAR_NATIVE_CTX)
//   2. 删 package.json `menus.view/title` 数组(已标注 native 专属)
//   3. extension.ts activate:删 applyNativeTitlebarContext(...) 调用(dshPanel.ts 的
//      dshPanelOpen/dshViewMode setContext 删原生后成无害死值,可留可清)
//   4. 共享 dsh.* 命令保留(selfDrawn titleAction 仍 executeCommand 同一批命令)
// ==== 删自绘标题栏(只留原生)====
//   1. 删 src/titlebar/selfDrawn/(宿主侧自绘消息处理 + ctx)
//   2. webview 侧自绘(聊天库 components/titlebar 自绘组件 + 静态 #titlebar CSS/DOM)
//   3. 本文件:installChatTitlebar / makeTitlebarPanelBroadcaster 的自绘分支去掉
//   4. extension.ts 不需改(只认本接缝)
import * as vscode from 'vscode';
import {
    applyNativeTitlebarContext,
    TITLEBAR_NATIVE_CTX,
} from './native/index';
import {
    createPanelStateBroadcaster,
    installSelfDrawnTitlebarMessages,
    type SelfDrawnTitlebarCtx,
} from './selfDrawn/index';

export { TITLEBAR_NATIVE_CTX, applyNativeTitlebarContext };

/** 标题栏实现类型:原生标题栏 vs 页内自绘标题栏 */
export type TitlebarMode = 'nativeTitle' | 'selfDrawn';

/**
 * 全仓库唯一开关,不猜宿主:'nativeTitle' 走原生,'selfDrawn' 走页内自绘(当前默认 'nativeTitle')。
 * 调用方按用途决定把哪个模式注入 <body data-titlebar-mode>:
 *   - 侧边栏视图(dsh.launcher,原生 view/title 可渲染)= 直接用本常量;
 *   - 编辑器区面板(moveToEditor,createWebviewPanel 渲染不到 view/title)= 恒传
 *     'nativeTitle' 作"纯聊天、无标题栏"标记(见 extension.ts setupChatWebview 调用处)。
 */
export const TITLEBAR_MODE: TitlebarMode = 'nativeTitle';

/** loadChatHtml 注入 <body> 的属性;webview 侧模块(聊天库)同步读取。 */
export const TITLEBAR_MODE_ATTR = 'data-titlebar-mode';

/** 自绘标题栏需要的宿主能力(extension.ts 组装共享 workspace/面板 helper 后注入) */
export type TitlebarChatHost = SelfDrawnTitlebarCtx;

/**
 * DshPanel 面板开/关或 viewMode 变化 → 广播 panelState(自绘标题栏 webview 消费)。
 * 原生标题栏模式不需要该广播(走 setContext 喂 package.json when),返回空。
 */
export function makeTitlebarPanelBroadcaster(
    broadcast: (msg: unknown) => void
): ((state: { panelOpen: boolean; viewMode: 'internal' | 'browser' }) => void) | undefined {
    if (TITLEBAR_MODE === 'selfDrawn') {
        return createPanelStateBroadcaster(broadcast);
    }
    return undefined;
}

/**
 * 给单个 chat webview 装配标题栏(每 webview 调用一次,见 setupChatWebview)。
 * - selfDrawn:挂自绘标题栏的 webview→扩展 消息处理(titleAction/wsDropdown/selfInfoReq)。
 * - nativeTitle:原生 view/title 按钮由宿主渲染,webview 侧无需扩展消息处理。
 */
export function installChatTitlebar(
    webview: vscode.Webview,
    mode: TitlebarMode,
    host: TitlebarChatHost
): void {
    if (mode === 'selfDrawn') {
        void installSelfDrawnTitlebarMessages(webview, host);
    }
    // nativeTitle：原生头由宿主渲染，webview 内不挂消息处理
}
