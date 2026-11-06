// 消费记录报告面板（宿主侧）：
// - 记录写入（替换旧实现，记录里补 provider/model/sessionId）；
// - 面板单实例：再次打开只是 reveal + 按当前选择重查一次；
// - 打开即查、手动刷新，不做任何自动刷新；
// - 页面内容与样式由这里下发，查询/聚合在 model.ts。
import * as vscode from 'vscode';
import type { DshReplyStats } from '../dsh';
import {
    aggregateUsage,
    hasAnyUsage,
    normalizeSelection,
    usageRecordOf,
    type UsageRecord,
    type UsageSelection,
} from './model';
import { appendUsageRecord, readUsageRange, type UsageStorageHost } from './store';

const UI_PREF_KEY = 'dsh.usage.ui.v1';
type UsageChartView = 'total' | 'split';

interface UsagePanelState {
    panel: vscode.WebviewPanel;
    selection: UsageSelection;
    chartView: UsageChartView;
    ready: boolean;
    seq: number;
    resolveSessionTitles?: () => Promise<Array<{ sessionId: string; title: string; cwd?: string }>>;
    sessionTitles?: Map<string, { title: string; cwd?: string }>;
}

let usagePanel: UsagePanelState | undefined;

function readUiPrefs(context: UsageStorageHost): { selection: UsageSelection; chartView: UsageChartView } {
    const stored = context.globalState.get<unknown>(UI_PREF_KEY);
    const value = typeof stored === 'object' && stored !== null ? (stored as { selection?: unknown; chartView?: unknown }) : {};
    return {
        selection: normalizeSelection(value.selection, { range: '7d', dimension: 'day' }),
        chartView: value.chartView === 'split' ? 'split' : 'total',
    };
}

function saveUiPrefs(context: UsageStorageHost, selection: UsageSelection, chartView: UsageChartView): void {
    void Promise.resolve(context.globalState.update(UI_PREF_KEY, { selection, chartView })).catch(() => undefined);
}

/** 记一次插件发起的回合用量；没有任何 token 的空回合不写 */
export async function recordUsage(
    context: UsageStorageHost,
    sessionId: string | undefined,
    stats: DshReplyStats | undefined,
    apiTime?: number
): Promise<void> {
    if (!stats) {
        return;
    }
    const record = usageRecordOf(stats, sessionId, apiTime);
    if (!hasAnyUsage(record)) {
        return;
    }
    try {
        await appendUsageRecord(context, record);
    } catch (error) {
        console.warn('[dsh-usage] 写入消费记录失败：', error);
    }
}

function annotateSessionTitles(
    records: UsageRecord[],
    titles: Map<string, { title: string; cwd?: string }> | undefined
): UsageRecord[] {
    if (titles === undefined) {
        return records;
    }
    return records.map((record) => {
        const meta = record.sessionId === undefined ? undefined : titles.get(record.sessionId);
        if (meta === undefined) {
            return record;
        }
        return {
            ...record,
            sessionTitle: meta.title,
            ...(meta.cwd === undefined ? {} : { project: meta.cwd }),
        };
    });
}

async function postUsage(target: UsagePanelState, context: UsageStorageHost, forceTitles = false): Promise<void> {
    const seq = (target.seq += 1);
    const now = Date.now();
    try {
        const result = await readUsageRange(context, target.selection, now);
        if (target.seq !== seq) {
            return; // 期间又发起了新查询，旧结果不覆盖新结果
        }
        // 有缓存就先带标题发；没有缓存先发无标题结果，标题异步补一次，避免首屏被 session.list 拖住
        const resolver = target.resolveSessionTitles;
        const needTitles = resolver !== undefined
            && (target.sessionTitles === undefined || forceTitles);
        const firstRecords = annotateSessionTitles(result.records, target.sessionTitles);
        await target.panel.webview.postMessage({
            type: 'payload',
            payload: aggregateUsage(firstRecords, target.selection, now, result.latestRecordTime),
            view: target.chartView,
        });
        if (!needTitles || resolver === undefined) {
            return;
        }
        try {
            const titles = await resolver();
            if (target.seq !== seq) {
                return;
            }
            target.sessionTitles = new Map(titles.map((item) => [
                item.sessionId,
                { title: item.title, ...(item.cwd === undefined ? {} : { cwd: item.cwd }) },
            ]));
            const records = annotateSessionTitles(result.records, target.sessionTitles);
            await target.panel.webview.postMessage({
                type: 'payload',
                payload: aggregateUsage(records, target.selection, now, result.latestRecordTime),
                view: target.chartView,
            });
        } catch {
            // dsh 不可用：本面板后续切换不再反复请求，刷新时再试
            target.sessionTitles = new Map();
        }
    } catch (error) {
        if (target.seq !== seq) {
            return;
        }
        await target.panel.webview.postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

/** 打开（或复用）消费记录面板；打开动作本身按当前选择查询一次 */
export async function openUsageReport(
    context: UsageStorageHost,
    resolveSessionTitles?: () => Promise<Array<{ sessionId: string; title: string; cwd?: string }>>
): Promise<void> {
    if (usagePanel !== undefined) {
        if (resolveSessionTitles !== undefined) {
            usagePanel.resolveSessionTitles = resolveSessionTitles;
        }
        usagePanel.panel.reveal(usagePanel.panel.viewColumn, false);
        // 重新打开时重新解析会话名（可能刚重命名），但切换范围/维度走缓存
        usagePanel.sessionTitles = undefined;
        void postUsage(usagePanel, context);
        return;
    }
    const panel = vscode.window.createWebviewPanel(
        'dshUsage',
        '消费记录',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    const prefs = readUiPrefs(context);
    delete prefs.selection.sessionId;
    const current: UsagePanelState = {
        panel,
        selection: prefs.selection,
        chartView: prefs.chartView,
        ready: false,
        seq: 0,
        ...(resolveSessionTitles === undefined ? {} : { resolveSessionTitles }),
    };
    usagePanel = current;
    panel.webview.html = usageShell(panel.webview);
    panel.webview.onDidReceiveMessage((message: unknown) => {
        if (usagePanel !== current) {
            return;
        }
        const m = message as { type?: unknown; selection?: unknown; chartView?: unknown };
        if (m.type === 'ready') {
            current.ready = true;
            void postUsage(current, context);
            return;
        }
        if (m.type === 'query') {
            current.selection = normalizeSelection(m.selection, current.selection);
            saveUiPrefs(context, current.selection, current.chartView);
            void postUsage(current, context);
            return;
        }
        if (m.type === 'ui') {
            if (m.chartView === 'split' || m.chartView === 'total') {
                current.chartView = m.chartView;
                saveUiPrefs(context, current.selection, current.chartView);
            }
            return;
        }
        if (m.type === 'refresh') {
            current.sessionTitles = undefined;
            void postUsage(current, context, true);
        }
    });
    panel.onDidDispose(() => {
        if (usagePanel === current) {
            usagePanel = undefined;
        }
    });
}

function usageShell(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 62)).map((n) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[n]).join('');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    :root {
        --bg: var(--vscode-editor-background, #1e1e1e);
        --card: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, rgba(128, 128, 128, 0.06)));
        --border: var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.22)));
        --hairline: var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
        --fg: var(--vscode-foreground, #cccccc);
        --fg-strong: var(--vscode-editor-foreground, #f0f0f0);
        --desc: var(--vscode-descriptionForeground, #9d9d9d);
        --muted: var(--vscode-disabledForeground, #7a7a7a);
        --accent: var(--vscode-textLink-foreground, #4daafc);
        --out: var(--vscode-charts-green, #7fc8a9);
        --hover: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
        --font: var(--vscode-font-family, "Segoe UI", "Microsoft YaHei", sans-serif);
        --mono: var(--vscode-editor-font-family, "Cascadia Mono", Consolas, ui-monospace, monospace);
    }
    * { box-sizing: border-box; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 1px; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
    body { font-family: var(--font); font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    .app { max-width: 1120px; margin: 0 auto; padding: 22px 26px 32px; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .head-main { min-width: 0; }
    .head-meta { flex: none; padding-top: 2px; }
    .tz-label { font-size: 10.5px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
    h1 { margin: 0; font-size: 19px; font-weight: 600; color: var(--fg-strong); letter-spacing: 0.2px; }
    .sub { margin: 4px 0 0; font-size: 11.5px; color: var(--desc); max-width: 860px; line-height: 1.55; }
    .filters { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 0 12px; border-bottom: 1px solid var(--hairline); margin-bottom: 12px; position: relative; }
    .seg { display: inline-flex; padding: 2px; border: 1px solid var(--border); border-radius: 8px; }
    .seg button { appearance: none; border: 0; background: transparent; color: var(--desc); font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
    .seg button:hover { color: var(--fg-strong); }
    .seg button.on { color: var(--accent); background: var(--hover); font-weight: 600; }
    .filter-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .range-nav { display: flex; gap: 0; }
    .range-nav .icon-btn { border-radius: 0; }
    .range-nav .icon-btn:first-child { border-radius: 6px 0 0 6px; }
    .range-nav .icon-btn:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
    .more-pop {
        position: fixed; z-index: 40; min-width: 128px; padding: 4px;
        background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526)));
        border: 1px solid var(--vscode-editorHoverWidget-border, var(--border));
        border-radius: 7px; box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    }
    .more-pop[hidden] { display: none; }
    .more-pop button {
        display: block; width: 100%; text-align: left; appearance: none; border: 0; background: transparent;
        color: var(--fg); border-radius: 5px; padding: 5px 8px; font: inherit; font-size: 12px; cursor: pointer;
    }
    .more-pop button:hover { background: var(--hover); }
    .range-label { min-height: 26px; display: inline-flex; align-items: center; font-size: 11.5px; color: var(--desc); font-variant-numeric: tabular-nums; }
    .custom-range { display: inline-flex; align-items: center; gap: 6px; }
    .custom-range[hidden] { display: none; }
    .custom-range > button { height: 26px; }
    .custom-range input { background: var(--vscode-input-background, transparent); color: var(--fg); border: 1px solid var(--border); border-radius: 5px; font: inherit; font-size: 11px; padding: 2px 5px; }
    .custom-range .date-btn {
        min-width: 88px; text-align: left; font-variant-numeric: tabular-nums;
        background: var(--vscode-input-background, transparent); color: var(--fg);
        border: 1px solid var(--border); border-radius: 5px; padding: 3px 7px; cursor: pointer;
    }
    .custom-range .date-btn:hover { border-color: var(--accent); }
    .date-pop {
        position: fixed; z-index: 70; width: 238px; padding: 8px;
        background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526)));
        color: var(--fg); border: 1px solid var(--vscode-editorHoverWidget-border, var(--border));
        border-radius: 8px; box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
        font-size: 11px; user-select: none;
    }
    .date-pop[hidden] { display: none; }
    .date-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .date-pop-title { font-size: 12px; font-weight: 600; color: var(--fg-strong); font-variant-numeric: tabular-nums; }
    .date-pop-nav {
        appearance: none; border: 1px solid var(--border); background: transparent; color: var(--desc);
        width: 22px; height: 22px; border-radius: 5px; cursor: pointer; line-height: 1;
    }
    .date-pop-nav:hover { color: var(--fg-strong); background: var(--hover); }
    .date-pop-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
    .date-pop-week { color: var(--muted); text-align: center; font-size: 10px; line-height: 20px; }
    .date-pop-cell {
        appearance: none; border: 1px solid transparent; background: transparent; color: var(--fg);
        height: 26px; border-radius: 5px; font: inherit; font-size: 11px; cursor: pointer; font-variant-numeric: tabular-nums;
    }
    .date-pop-cell:hover { background: var(--hover); }
    .date-pop-cell.on { background: var(--accent); color: var(--vscode-button-foreground, #fff); }
    .date-pop-cell.anchor { border-color: var(--accent); }
    .date-pop-cell.in-range { background: var(--vscode-editor-selectionBackground, var(--hover)); }
    .date-pop-cell.today { border-color: var(--accent); }
    .date-pop-cell.disabled { opacity: 0.32; cursor: default; }
    .date-pop-cell.disabled:hover { background: transparent; }
    .date-pop-nav:disabled { opacity: 0.35; cursor: default; background: transparent; color: var(--desc); }
    .date-pop-hint { margin-top: 4px; text-align: center; font-size: 10.5px; color: var(--muted); }
    .date-pop-cell.blank { pointer-events: none; }
    .date-pop-foot { margin-top: 6px; display: flex; justify-content: flex-end; }
    .date-pop-foot button {
        appearance: none; border: 1px solid var(--border); background: transparent; color: var(--accent);
        border-radius: 5px; padding: 2px 8px; font: inherit; font-size: 11px; cursor: pointer;
    }
    .date-pop-foot button:hover { background: var(--hover); }
    .custom-range button { appearance: none; border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: 5px; font: inherit; font-size: 11px; padding: 3px 8px; cursor: pointer; }
    .icon-btn { appearance: none; border: 1px solid var(--border); background: transparent; color: var(--desc); width: 26px; height: 26px; border-radius: 6px; cursor: pointer; font-size: 14px; line-height: 1; }
    .icon-btn:hover { color: var(--fg-strong); background: var(--hover); }
    .icon-btn:disabled { opacity: 0.4; cursor: default; background: transparent; color: var(--desc); }
    .report-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 10px; align-items: stretch; }
    .report-kpis.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .kpi-primary, .kpi-mini {
        background: var(--card); border: 1px solid var(--hairline); border-radius: 10px;
        padding: 10px 12px; min-width: 0; min-height: 84px;
        display: flex; flex-direction: column; justify-content: space-between;
    }
    .kpi-primary .label, .kpi-mini .label { font-size: 11px; color: var(--desc); }
    .kpi-primary .value { margin-top: 2px; font-size: 24px; font-weight: 600; color: var(--fg-strong); font-variant-numeric: tabular-nums; letter-spacing: 0.2px; white-space: nowrap; }
    .kpi-primary .value small { font-size: 12px; font-weight: 500; color: var(--desc); margin-left: 3px; }
    .kpi-primary .hint, .kpi-mini .hint { margin-top: 1px; font-size: 10.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kpi-mini .value { margin-top: 2px; font-size: 18px; font-weight: 600; color: var(--fg-strong); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .kpi-mini .value small { font-size: 11px; font-weight: 500; color: var(--desc); margin-left: 2px; }
    .card { background: var(--card); border: 1px solid var(--hairline); border-radius: 10px; }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px 0; flex-wrap: wrap; }
    .card-title { font-size: 12px; font-weight: 600; color: var(--fg-strong); letter-spacing: 0.2px; }
    .legend { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--desc); }
    .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 5px; vertical-align: 1px; }
    .dot.in { background: var(--accent); }
    .dot.out { background: var(--out); }
    .chart-wrap { padding: 8px 16px 12px; }
    .chart-summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 16px 0; font-size: 11.5px; color: var(--desc); }
    .chart-summary b { color: var(--fg); font-weight: 500; font-variant-numeric: tabular-nums; }
    .chart-summary .cs-day { color: var(--fg-strong); font-weight: 600; }
    .chart-summary .cs-link { margin-left: auto; border: 0; background: none; padding: 0; cursor: pointer; color: var(--accent); font: inherit; font-size: 11px; }
    .chart-summary .cs-link:hover { text-decoration: underline; }
    .chart-tools { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .chart-view button { padding: 3px 8px; font-size: 11px; }
    .chart-view button.on { color: var(--fg-strong); background: var(--hover); }
    .chart-main { min-width: 0; overflow-x: hidden; overflow-y: hidden; padding-bottom: 2px; scrollbar-width: thin; scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4)) transparent; }
    .chart-main.scrollable { overflow-x: auto; }
    .chart-main::-webkit-scrollbar { height: 8px; }
    .chart-main::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4)); border-radius: 4px; }
    .chart-main::-webkit-scrollbar-track { background: transparent; }
    .chart-main svg { display: block; max-width: none; height: auto; }
    .chart-tip {
        position: fixed; z-index: 60; pointer-events: none; min-width: 132px;
        padding: 7px 9px; border-radius: 6px;
        color: var(--vscode-editorHoverWidget-foreground, var(--fg));
        background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526)));
        border: 1px solid var(--vscode-editorHoverWidget-border, var(--border));
        box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
        font-size: 11px; line-height: 1.6; font-variant-numeric: tabular-nums;
    }
    .chart-tip[hidden] { display: none; }
    .chart-tip .ct-day { color: var(--desc); }
    .chart-tip .ct-total { font-size: 14px; font-weight: 600; color: var(--fg-strong); margin: 1px 0 4px; }
    .chart-tip .ct-row { display: flex; justify-content: space-between; gap: 14px; color: var(--desc); }
    .chart-tip .ct-row b { font-weight: 500; color: var(--fg); }
    .cell-tip { max-width: min(380px, calc(100vw - 24px)); padding: 8px 10px; }
    .cell-tip .ct-head { font-size: 10px; color: var(--muted); letter-spacing: 0.3px; }
    .cell-tip .ct-main { margin-top: 2px; font-size: 12.5px; font-weight: 600; color: var(--fg-strong); overflow-wrap: anywhere; }
    .cell-tip .ct-sub { margin-top: 3px; font-size: 10.5px; color: var(--desc); font-family: var(--mono); overflow-wrap: anywhere; word-break: break-all; }
    .detail .ellipsis-cell { display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    .chart-empty { padding: 28px 8px; color: var(--muted); font-size: 12px; }
    .day-panel { background: var(--card); border: 1px solid var(--hairline); border-radius: 9px; padding: 10px 12px; }
    .dp-head { font-size: 10.5px; color: var(--muted); letter-spacing: 0.3px; }
    .dp-day { font-size: 12px; color: var(--fg-strong); margin-top: 2px; }
    .dp-total { font-size: 21px; font-weight: 600; color: var(--fg-strong); font-variant-numeric: tabular-nums; margin: 4px 0 7px; }
    .dp-total span { font-size: 11px; font-weight: 500; color: var(--desc); margin-left: 2px; }
    .dp-row { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--desc); padding: 3px 0; border-bottom: 1px solid var(--hairline); font-variant-numeric: tabular-nums; }
    .dp-row:last-of-type { border-bottom: 0; }
    .dp-row b { font-weight: 500; color: var(--fg); }
    .dp-link { display: inline-block; margin-top: 9px; border: none; background: none; padding: 0; cursor: pointer; color: var(--accent); font-size: 11px; }
    .dp-link:hover { text-decoration: underline; }
    .list { margin-top: 10px; }
    .list-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--hairline); flex-wrap: wrap; }
    .list-meta { font-size: 11px; color: var(--desc); }
    .dimseg button.on { color: var(--fg-strong); background: var(--hover); }
    .row { display: grid; grid-template-columns: 92px 1fr 200px 74px 18px; align-items: center; gap: 14px; padding: 11px 16px; border-bottom: 1px solid var(--hairline); cursor: pointer; }
    .row:hover { background: var(--hover); }
    .row.sel { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent); }
    .row:last-child { border-bottom: 0; }
    .row .day { font-size: 12.5px; color: var(--fg-strong); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; }
    .row .day .sub2 { display: block; font-size: 10.5px; color: var(--muted); font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
    .row .tokens { display: flex; align-items: center; gap: 14px; font-size: 11.5px; color: var(--desc); font-variant-numeric: tabular-nums; flex-wrap: wrap; }
    .row .tokens b { font-weight: 500; color: var(--fg); }
    .row .mini { display: flex; align-items: center; gap: 8px; }
    .row .bar { flex: 1; height: 5px; border-radius: 3px; background: var(--hairline); overflow: hidden; }
    .row .bar i { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
    .row .ratio { font-size: 11px; color: var(--desc); font-variant-numeric: tabular-nums; width: 36px; text-align: right; }
    .row .turns { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
    .row .chev { color: var(--muted); font-size: 11px; text-align: center; }
    .detail { padding: 2px 16px 12px 122px; border-bottom: 1px solid var(--hairline); overflow-x: auto; }
    .detail table { width: 100%; border-collapse: collapse; font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .detail th { text-align: left; font-weight: 500; color: var(--muted); padding: 5px 8px 6px; border-bottom: 1px solid var(--hairline); white-space: nowrap; }
    .detail td { padding: 6px 8px; color: var(--desc); border-bottom: 1px solid var(--hairline); white-space: nowrap; }
    .detail td.num, .detail th.num { text-align: right; color: var(--fg); }
    .detail .session-cell { max-width: 160px; }
    .more-row { padding: 6px 8px 2px; }
    .more-row button {
        appearance: none; border: 1px solid var(--border); background: transparent; color: var(--accent);
        border-radius: 5px; padding: 3px 9px; font: inherit; font-size: 11px; cursor: pointer;
    }
    .more-row button:hover { background: var(--hover); }
    .detail tr:last-child td { border-bottom: 0; }
    .badge { display: inline-block; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 4px; color: var(--desc); background: var(--hover); border: 1px solid var(--hairline); margin-right: 6px; }
    .muted { color: var(--muted); }
    .empty { padding: 28px 16px; text-align: center; color: var(--desc); }
    .empty .empty-main { font-size: 12.5px; color: var(--fg); }
    .empty .empty-sub { margin-top: 4px; font-size: 11px; color: var(--muted); }
    .empty button { margin-top: 10px; appearance: none; border: 1px solid var(--border); background: transparent; color: var(--accent); border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 11px; cursor: pointer; }
    .loading { padding: 24px 4px; color: var(--muted); font-size: 12px; }
    .error { margin: 0 0 12px; padding: 8px 10px; border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); border-radius: 6px; color: var(--vscode-errorForeground, #f48771); font-size: 11.5px; }
    .error[hidden] { display: none; }
    @media (max-width: 720px) {
        .app { padding: 14px 14px 22px; }
        .head { flex-wrap: wrap; gap: 6px; }
        .head-meta { width: 100%; padding-top: 0; }
        .tz-label { font-size: 10px; }
        h1 { font-size: 16px; }
        .sub { font-size: 10.5px; }
        .filters { gap: 8px; }
        .seg { overflow-x: auto; max-width: 100%; min-width: 0; flex: 0 1 auto; }
        .seg button { padding: 4px 6px; font-size: 11px; }
        .filter-right { width: 100%; justify-content: space-between; }
        .report-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .report-kpis.three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .kpi-primary, .kpi-mini { padding: 9px 10px; min-height: 76px; }
        .kpi-primary .value { font-size: 21px; }
        .kpi-mini .value { font-size: 17px; }
        .card-head { padding: 10px 12px 0; }
        .legend { display: none; }
        .chart-wrap { display: block; padding: 6px 10px 8px; }
        .chart-summary { padding: 6px 12px 0; gap: 8px; font-size: 11px; }
        .day-panel { display: none; }
        .list-head { padding: 10px 12px; flex-direction: column; align-items: flex-start; }
        .row { grid-template-columns: 66px 1fr 16px; gap: 8px; padding: 9px 12px; }
        .row .mini, .row .turns { display: none; }
        .row .tokens { gap: 8px; font-size: 10.5px; }
        .detail { padding: 2px 12px 10px; }
        .detail table { min-width: 320px; }
        .detail th:nth-child(3), .detail td:nth-child(3) { display: none; }
    }
</style>
</head>
<body>
<div class="app">
  <header class="head">
    <div class="head-main">
      <h1>消费记录</h1>
      <p class="sub">仅统计本插件发起的对话（侧边栏 / 右键处理）。在 dsh 网页 / 桌面里使用产生的用量不在其中，因此可能与你的总用量不一致。</p>
    </div>
    <div class="head-meta"><span class="tz-label" id="tzLabel"></span></div>
  </header>
  <div class="filters">
    <div class="seg" id="ranges">
      <button type="button" data-range="today">今天</button>
      <button type="button" data-range="yesterday">昨天</button>
      <button type="button" data-range="7d" class="on">近 7 天</button>
      <button type="button" data-range="30d">近 30 天</button>
      <button type="button" data-range="month">本月</button>
      <button type="button" data-range="custom">自定义</button>
      <button type="button" id="moreToggle">更多 ▾</button>
    </div>
    <div class="more-pop" id="morePop" hidden>
      <button type="button" data-range="all">全部记录</button>
    </div>
    <div class="filter-right">
      <div class="range-nav">
        <button type="button" class="icon-btn" id="prevRange" title="上一周期">‹</button>
        <button type="button" class="icon-btn" id="nextRange" title="下一周期">›</button>
      </div>
      <span class="range-label" id="rangeLabel">—</span>
      <span class="custom-range" id="customRange" hidden>
        <button type="button" class="date-btn" id="fromBtn" data-date-field="from"><span id="fromText">开始日期</span></button>
        <span class="muted">～</span>
        <button type="button" class="date-btn" id="toBtn" data-date-field="to"><span id="toText">结束日期</span></button>
        <button type="button" id="applyCustom">应用</button>
      </span>
      <button type="button" class="icon-btn" id="refresh" title="重新查询当前范围">⟳</button>
    </div>
  </div>
  <div class="error" id="error" hidden></div>
  <main id="content"><div class="loading">加载中…</div></main>
  <div class="chart-tip" id="chartTip" hidden></div>
  <div class="chart-tip cell-tip" id="cellTip" hidden></div>
  <div class="date-pop" id="datePop" hidden></div>
</div>
<script nonce="${nonce}">
(function () {
    'use strict';
    var vscode = acquireVsCodeApi();
    var state = { payload: null, selection: { range: '7d', dimension: 'day' }, selectedDay: null, expanded: {}, detailLimit: {}, pendingSelectedDay: null, pendingExpandDay: null, chartWidth: null, chartDays: [], chartMode: 'day', chartView: 'total', chartScroll: 0, pendingScroll: 0, scrollToList: false, customFrom: '', customTo: '', pickerField: 'from', pickerMonth: null, rangeAnchor: null, hoverDay: null };
    var RANGE_IDS = ['today', 'yesterday', '7d', '30d', 'month', 'custom', 'all'];

    function $(id) { return document.getElementById(id); }
    function esc(value) {
        return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }
    function compact(n) {
        var v = typeof n === 'number' && isFinite(n) ? n : 0;
        var abs = Math.abs(v);
        if (abs < 1000) { return String(v); }
        var text;
        if (abs >= 1e12) { text = (v / 1e12).toFixed(1) + 'T'; }
        else if (abs >= 1e9) { text = (v / 1e9).toFixed(1) + 'G'; }
        else if (abs >= 1e6) { text = (v / 1e6).toFixed(1) + 'M'; }
        else { text = (v / 1e3).toFixed(1) + 'K'; }
        return text.replace('.0' + text.charAt(text.length - 1), text.charAt(text.length - 1));
    }
    function num(v) { return typeof v === 'number' && isFinite(v) ? String(v) : '—'; }
    function pct(v) { return typeof v === 'number' && isFinite(v) ? (Math.round(v * 10) / 10) + '%' : '—'; }
    function sec(v) { return typeof v === 'number' && isFinite(v) ? v.toFixed(1) + 's' : '—'; }
    function timeOf(ms) {
        var d = new Date(ms);
        function p(n) { return n < 10 ? '0' + n : String(n); }
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function sessionLabel(record) {
        if (record.sessionTitle) { return record.sessionTitle; }
        if (!record.sessionId) { return '—'; }
        return String(record.sessionId);
    }
    function postQuery() {
        vscode.postMessage({ type: 'query', selection: state.selection });
    }
    function beginQuery() {
        // 查询期间**不清空页面**，否则内容高度塌陷、滚动位置会跳回顶部
        if (state.payload) { state.pendingScroll = window.scrollY; }
    }
    function showError(text) {
        var box = $('error');
        if (!box) { return; }
        box.textContent = text;
        box.hidden = false;
    }
    function clearError() {
        var box = $('error');
        if (box) { box.hidden = true; }
    }

    function renderActive() {
        var selection = state.selection;
        var buttons = document.querySelectorAll('[data-range]');
        for (var i = 0; i < buttons.length; i += 1) {
            buttons[i].classList.toggle('on', buttons[i].getAttribute('data-range') === selection.range);
        }
        var custom = $('customRange');
        if (custom) { custom.hidden = selection.range !== 'custom'; }
        if (selection.range === 'custom') {
            if (selection.from) { state.customFrom = selection.from; }
            if (selection.to) { state.customTo = selection.to; }
            updateDateButtons();
        }
        var dims = document.querySelectorAll('[data-dim]');
        for (var j = 0; j < dims.length; j += 1) {
            dims[j].classList.toggle('on', dims[j].getAttribute('data-dim') === selection.dimension);
        }
        var more = $('moreToggle');
        if (more) {
            more.textContent = selection.range === 'all' ? '全部记录 ▾' : '更多 ▾';
            more.classList.toggle('on', selection.range === 'all');
        }
        var p = state.payload;
        var today = toDateInput(new Date());
        if ($('prevRange')) { $('prevRange').disabled = selection.range === 'all'; }
        if ($('nextRange')) { $('nextRange').disabled = selection.range === 'all' || (p !== null && p.toDay >= today); }
    }

    function updateDateButtons() {
        if ($('fromText')) { $('fromText').textContent = state.customFrom || '开始日期'; }
        if ($('toText')) { $('toText').textContent = state.customTo || '结束日期'; }
    }

    function kpis(p) {
        var t = p.totals;
        var cacheHint = t.cacheRead === undefined ? '缓存读 —' : '缓存读 ' + compact(t.cacheRead);
        var totalHint = '输入 ' + compact(t.input) + ' · 输出 ' + compact(t.output);
        var recordHint = t.records === 0 ? '该范围内没有记录' : '本插件发起的回合';
        var secondary = [
            '<div class="kpi-mini"><div class="label">缓存命中</div><div class="value">' + pct(t.cacheHitRate) + '</div><div class="hint">' + cacheHint + '</div></div>',
            '<div class="kpi-mini"><div class="label">回合数</div><div class="value">' + String(t.records) + '</div><div class="hint">' + recordHint + '</div></div>',
        ];
        // 平均耗时/首 token 都是"统计到才显示"：没有 wallSec 就不占一格，不显示 —
        if (typeof t.avgWallSec === 'number') {
            var timeHint = typeof t.avgTtftSec === 'number' ? '<div class="hint">首 token ' + sec(t.avgTtftSec) + '</div>' : '';
            secondary.push('<div class="kpi-mini"><div class="label">平均耗时</div><div class="value">' + sec(t.avgWallSec) + '</div>' + timeHint + '</div>');
        }
        return '<div class="report-kpis' + (secondary.length === 2 ? ' three' : '') + '">' +
            '<div class="kpi-primary"><div class="label">总用量</div><div class="value">' + compact(t.total) + '<small>tok</small></div><div class="hint">' + totalHint + '</div></div>' +
            secondary.join('') +
            '</div>';
    }

    function defaultSelectedDay(days) {
        if (!days || days.length === 0) { return null; }
        for (var i = days.length - 1; i >= 0; i -= 1) {
            if (days[i].total > 0) { return days[i].key; }
        }
        return days[days.length - 1].key;
    }

    function hitOf(bucket) {
        if (typeof bucket.cacheRead !== 'number') { return undefined; }
        var denom = bucket.input + bucket.cacheRead;
        return denom > 0 ? (bucket.cacheRead / denom) * 100 : undefined;
    }

    // 趋势粒度：≤62 天按天；更长的范围（全部记录/大自定义范围）按月聚合，避免几百根细柱
    function mondayKeyOf(dayKey) {
        var d = new Date(dayKey + 'T00:00:00');
        var offset = (d.getDay() + 6) % 7;
        return toDateInput(new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset));
    }

    function shiftDayKey(dayKey, amount) {
        var d = new Date(dayKey + 'T00:00:00');
        d.setDate(d.getDate() + amount);
        return toDateInput(d);
    }

    function groupChartDays(days, keyOf, labelOf, detailOf) {
        var map = {};
        var keys = [];
        for (var i = 0; i < days.length; i += 1) {
            var day = days[i];
            var key = keyOf(day);
            var bucket = map[key];
            if (!bucket) {
                bucket = { key: key, label: labelOf(key), detail: detailOf(key), input: 0, output: 0, total: 0, records: 0 };
                map[key] = bucket;
                keys.push(key);
            }
            bucket.input += day.input;
            bucket.output += day.output;
            bucket.total += day.total;
            bucket.records += day.records;
            if (day.total > 0 || !bucket.focusDay) { bucket.focusDay = day.key; }
            if (typeof day.cacheRead === 'number') { bucket.cacheRead = (bucket.cacheRead || 0) + day.cacheRead; }
            if (typeof day.cacheWrite === 'number') { bucket.cacheWrite = (bucket.cacheWrite || 0) + day.cacheWrite; }
        }
        keys.sort();
        var out = [];
        for (var j = 0; j < keys.length; j += 1) {
            var b = map[keys[j]];
            var hit = hitOf(b);
            if (hit !== undefined) { b.cacheHitRate = hit; }
            out.push(b);
        }
        return out;
    }

    // 图表粒度：≤31 天按天、32–90 天按周、更长按月；不随“本月已过几天”跳变
    function chartDataOf(p) {
        var days = p.days || [];
        if (days.length <= 31) {
            var dayOut = [];
            for (var d = 0; d < days.length; d += 1) {
                dayOut.push({ ...days[d], focusDay: days[d].key });
            }
            return { mode: 'day', days: dayOut };
        }
        if (days.length <= 90) {
            return {
                mode: 'week',
                days: groupChartDays(
                    days,
                    function (day) { return mondayKeyOf(day.key); },
                    function (key) { return key.slice(5); },
                    function (key) { return '～' + shiftDayKey(key, 6).slice(5); }
                ),
            };
        }
        return {
            mode: 'month',
            days: groupChartDays(
                days,
                function (day) { return day.key.slice(0, 7); },
                function (key) { return key.slice(2); },
                function () { return ''; }
            ),
        };
    }

    function chartGranularityLabel(p) {
        var count = p.days ? p.days.length : 0;
        return count <= 31 ? '按天' : (count <= 90 ? '按周' : '按月');
    }

    function chartSvg(p) {
        var chart = chartDataOf(p);
        state.chartMode = chart.mode;
        state.chartDays = chart.days;
        var days = chart.days;
        if (!days || days.length === 0) {
            return '<div class="chart-empty">该时间范围内没有用量</div>';
        }
        var minPerDay = chart.mode === 'month' ? 58 : (chart.mode === 'week' ? 52 : (days.length > 14 ? 36 : 30));
        var width = Math.max(state.chartWidth || Math.max(300, (window.innerWidth || 900) - 56), days.length * minPerDay + 80);
        var x0 = 54;
        var gap = days.length === 1 ? 0 : Math.floor((width - x0 - 24) / days.length);
        var barW = Math.max(8, Math.min(28, Math.floor(gap * 0.36)));
        var labelStep = Math.ceil(days.length / 8);
        var selected = state.selectedDay || (days.length ? days[days.length - 1].key : null);
        var parts = [];
        var split = state.chartView === 'split';
        var height = split ? 300 : 186;
        parts.push('<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:' + width + 'px;max-width:none" role="img" aria-label="' + (chart.mode === 'month' ? '按月' : '按天') + (split ? '输入输出对比' : '总用量趋势') + '">');

        var panels = split
            ? [
                { key: 'input', label: '输入', color: 'var(--accent)', top: 26, base: 118 },
                { key: 'output', label: '输出', color: 'var(--out)', top: 168, base: 260 },
            ]
            : [{ key: 'total', label: '总用量', color: 'var(--accent)', top: 26, base: 160 }];

        for (var pi = 0; pi < panels.length; pi += 1) {
            var panel = panels[pi];
            var maxValue = 1;
            for (var mi = 0; mi < days.length; mi += 1) {
                var value = panel.key === 'total'
                    ? days[mi].total
                    : (panel.key === 'input' ? days[mi].input : days[mi].output);
                maxValue = Math.max(maxValue, value);
            }
            var step = (panel.base - panel.top) / maxValue;
            var gridValues = [maxValue, maxValue / 2, 0];
            for (var g = 0; g < gridValues.length; g += 1) {
                var gy = panel.base - gridValues[g] * step;
                parts.push('<line x1="48" y1="' + gy + '" x2="' + (width - 20) + '" y2="' + gy + '" stroke="rgba(128,128,128,0.18)" stroke-dasharray="2 4"></line>');
                parts.push('<text x="8" y="' + (gy + 4) + '" fill="var(--desc)" font-size="11">' + compact(gridValues[g]) + '</text>');
            }
            if (split) {
                parts.push('<text x="8" y="' + (panel.top - 8) + '" fill="var(--desc)" font-size="10.5" font-weight="600">' + panel.label + '</text>');
            }

            for (var d = 0; d < days.length; d += 1) {
                var day = days[d];
                var cx = x0 + d * gap;
                var dayValue = panel.key === 'total'
                    ? day.total
                    : (panel.key === 'input' ? day.input : day.output);
                var barH = dayValue * step;
                var y = panel.base - barH;
                var isSelected = (day.focusDay || day.key) === selected;
                var dayAttr = chart.mode === 'day' ? ' data-day="' + esc(day.key) + '"' : '';
                var focusAttr = ' data-chart-focus="' + esc(day.focusDay || day.key) + '"';
                if (!split) {
                    parts.push('<g data-chart-key="' + esc(day.key) + '"' + dayAttr + focusAttr + ' style="cursor:pointer">');
                    parts.push('<rect x="' + cx + '" y="' + y + '" width="' + barW + '" height="' + Math.max(barH, 0) + '" rx="2" fill="var(--accent)"></rect>');
                    parts.push('<rect x="' + (cx - 6) + '" y="' + (panel.top - 8) + '" width="' + (barW + 12) + '" height="' + (panel.base - panel.top + 8) + '" fill="transparent"></rect>');
                } else {
                    // 上下两张小图各自成组，悬停/点击都能命中同一日期
                    parts.push('<g data-chart-key="' + esc(day.key) + '"' + dayAttr + focusAttr + ' style="cursor:pointer">');
                    parts.push('<rect x="' + (cx - 6) + '" y="' + (panel.top - 8) + '" width="' + (barW + 12) + '" height="' + (panel.base - panel.top + 8) + '" fill="transparent"></rect>');
                    parts.push('<rect x="' + cx + '" y="' + y + '" width="' + barW + '" height="' + Math.max(barH, 0) + '" rx="2" fill="' + panel.color + '"></rect>');
                }
                if (showLabel(days, d, labelStep) && (!split || pi === panels.length - 1)) {
                    parts.push('<text x="' + (cx + barW / 2) + '" y="' + (split ? 284 : panel.base + 16) + '" text-anchor="middle" fill="' + (isSelected ? 'var(--accent)' : 'var(--desc)') + '" font-size="11">' + esc(day.label) + '</text>');
                    if (isSelected) {
                        parts.push('<rect x="' + (cx + barW / 2 - 13) + '" y="' + (split ? 289 : panel.base + 21) + '" width="26" height="2" rx="1" fill="var(--accent)"></rect>');
                    }
                }
                parts.push('</g>');
            }
        }
        parts.push('</svg>');
        return parts.join('');
    }

    function showLabel(days, index, labelStep) {
        return days.length <= 12 || index % labelStep === 0 || index === days.length - 1;
    }

    function daySummary(p) {
        var days = p.days;
        if (!days || days.length === 0) {
            return '';
        }
        var selected = state.selectedDay || days[days.length - 1].key;
        var day = null;
        for (var i = 0; i < days.length; i += 1) {
            if (days[i].key === selected) { day = days[i]; }
        }
        if (!day) { day = days[days.length - 1]; }
        return '<div class="chart-summary">' +
            '<span class="cs-day">' + esc(day.label) + ' · ' + esc(day.detail) + '</span>' +
            '<span>总量 <b>' + compact(day.total) + ' tok</b></span>' +
            '<span>输入 <b>' + compact(day.input) + '</b></span>' +
            '<span>输出 <b>' + compact(day.output) + '</b></span>' +
            '<span>缓存读 <b>' + (day.cacheRead === undefined ? '—' : compact(day.cacheRead)) + '</b></span>' +
            '<span>缓存命中 <b>' + pct(day.cacheHitRate) + '</b></span>' +
            '<button type="button" class="cs-link" data-action="view-day" title="切到按天列表并展开这一天">定位到明细 →</button>' +
            '</div>';
    }

    function recordRows(bucket, index) {
        var items = bucket.items || [];
        var rows = [];
        var limit = Math.min(items.length, state.detailLimit[bucket.key] || 100);
        for (var i = 0; i < limit; i += 1) {
            var r = items[i];
            rows.push('<tr>' +
                '<td>' + esc(timeOf(r.time)) + '</td>' +
                '<td><span class="ellipsis-cell model-cell" data-tip-kind="model" data-tip-main="' + esc(r.model || '') + '" data-tip-sub="' + esc(r.provider || '') + '" aria-label="' + esc(r.model ? (r.provider ? r.provider + ' / ' : '') + r.model : '') + '">' + (r.model ? '<span class="badge">' + esc(r.provider || '未记录服务商') + '</span>' + esc(r.model) : '<span class="muted">—</span>') + '</span></td>' +
                '<td><span class="ellipsis-cell session-cell" data-tip-kind="session" data-tip-main="' + esc(r.sessionTitle || r.sessionId || '') + '" data-tip-sub="' + esc(r.sessionTitle && r.sessionId ? r.sessionId : '') + '" aria-label="' + esc([r.sessionTitle, r.sessionId].filter(Boolean).join(' · ')) + '">' + esc(sessionLabel(r)) + '</span></td>' +
                '<td class="num">' + num(r.inputTokens) + '</td>' +
                '<td class="num">' + num(r.cacheReadTokens) + '</td>' +
                '<td class="num">' + num(r.cacheWriteTokens) + '</td>' +
                '<td class="num">' + num(r.outputTokens) + '</td>' +
                '<td class="num">' + (typeof r.wallSec === 'number' ? r.wallSec.toFixed(1) + 's' : '—') + '</td>' +
                '</tr>');
        }
        var more = '';
        if (items.length > limit) {
            more = '<div class="more-row"><button type="button" data-more-index="' + String(index) + '">显示更多（还有 ' + String(items.length - limit) + ' 条）</button></div>';
        }
        return '<table><thead><tr><th>时间</th><th>模型</th><th>会话</th><th class="num">输入</th><th class="num">缓存读</th><th class="num">缓存写</th><th class="num">输出</th><th class="num">耗时</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>' + more;
    }

    function bucketRow(bucket, index) {
        var open = state.expanded[bucket.key] === true;
        var selected = state.payload !== null && state.payload.selection.dimension === 'day' && bucket.key === state.selectedDay;
        var ratio = bucket.cacheHitRate;
        var width = typeof ratio === 'number' ? Math.max(0, Math.min(100, ratio)) : 0;
        return '<div class="row' + (selected ? ' sel' : '') + '" data-bucket="' + String(index) + '">' +
            '<div class="day">' + esc(bucket.label) + '<span class="sub2">' + esc(bucket.detail) + '</span></div>' +
            '<div class="tokens"><span>输入 <b>' + compact(bucket.input) + '</b></span><span>输出 <b>' + compact(bucket.output) + '</b></span></div>' +
            '<div class="mini"><div class="bar"><i style="width:' + width + '%"></i></div><span class="ratio">' + (typeof ratio === 'number' ? pct(ratio) : '—') + '</span></div>' +
            '<div class="turns">' + String(bucket.records) + ' 条</div>' +
            '<div class="chev">' + (open ? '▾' : '▸') + '</div>' +
            '</div>' +
            (open ? '<div class="detail">' + recordRows(bucket, index) + '</div>' : '');
    }

    function listCard(p) {
        var dims = [['day', '按天'], ['model', '按模型'], ['project', '按工作区']];
        var dimButtons = '<div class="seg dimseg">';
        for (var i = 0; i < dims.length; i += 1) {
            dimButtons += '<button type="button" data-dim="' + dims[i][0] + '"' + (p.selection.dimension === dims[i][0] ? ' class="on"' : '') + '>' + dims[i][1] + '</button>';
        }
        dimButtons += '</div>';
        var meta = '· ' + p.rangeLabel + ' · ' + String(p.totals.records) + ' 条';
        var head = '<div class="list-head"><div class="card-title">明细 <span class="list-meta">' + esc(meta) + '</span></div>' + dimButtons + '</div>';
        var body;
        if (!p.buckets || p.buckets.length === 0) {
            var latest = p.latestRecordTime ? '最新记录：' + esc(timeOf(p.latestRecordTime)) : '还没有任何记录';
            var action = p.latestRecordTime && p.selection.range !== 'all' ? '<button type="button" data-range="all">查看全部记录</button>' : '';
            body = '<div class="empty"><div class="empty-main">该时间范围内没有记录</div><div class="empty-sub">' + latest + '</div>' + action + '</div>';
        } else {
            var rows = [];
            for (var b = 0; b < p.buckets.length; b += 1) {
                rows.push(bucketRow(p.buckets[b], b));
            }
            var truncated = p.truncated ? '<div class="muted" style="padding:6px 16px">明细超过展示上限，仅显示最近 5000 条；总量仍按范围内全部记录计算。</div>' : '';
            body = rows.join('') + truncated;
        }
        return '<section class="card list">' + head + body + '</section>';
    }

    function syncChartScroll() {
        var main = document.querySelector('.chart-main');
        if (!main) { return; }
        var svg = main.querySelector('svg');
        var need = svg !== null && svg.getBoundingClientRect().width > main.clientWidth + 1;
        main.classList.toggle('scrollable', need);
    }

    function fitChart() {
        var main = document.querySelector('.chart-main');
        if (!main || !state.payload) { return; }
        syncChartScroll();
        var width = Math.max(280, main.clientWidth || 0);
        if (width === 0 || Math.abs(width - (state.chartWidth || 0)) <= 4) { return; }
        state.chartWidth = width;
        main.innerHTML = chartSvg(state.payload);
        syncChartScroll();
    }

    function rangeDays(p) {
        var from = new Date(p.fromDay + 'T00:00:00').getTime();
        var to = new Date(p.toDay + 'T00:00:00').getTime();
        return Math.max(1, Math.round((to - from) / 86400000) + 1);
    }

    function render() {
        var p = state.payload;
        if (!p) { return; }
        var previousChart = document.querySelector('.chart-main');
        if (previousChart) { state.chartScroll = previousChart.scrollLeft; }
        state.selection = { range: p.selection.range, dimension: p.selection.dimension, from: p.selection.from, to: p.selection.to, sessionId: p.selection.sessionId };
        var wantedDay = state.pendingSelectedDay || state.selectedDay;
        var dayExists = false;
        for (var di = 0; di < p.days.length; di += 1) {
            if (p.days[di].key === wantedDay) { dayExists = true; }
        }
        state.selectedDay = dayExists ? wantedDay : defaultSelectedDay(p.days);
        state.pendingSelectedDay = null;
        if (state.pendingExpandDay) {
            for (var eb = 0; eb < p.buckets.length; eb += 1) {
                if (p.buckets[eb].key === state.pendingExpandDay) {
                    state.expanded[p.buckets[eb].key] = true;
                }
            }
            state.pendingExpandDay = null;
        }
            renderActive();
        var label = p.selection.range === 'custom'
            ? '自定义 · 共 ' + String(rangeDays(p)) + ' 天'
            : p.rangeLabel + ' · ' + p.fromDay + ' ～ ' + p.toDay + ' · 共 ' + String(rangeDays(p)) + ' 天';
        if ($('rangeLabel')) { $('rangeLabel').textContent = label; }
        if ($('refresh')) { $('refresh').title = '重新查询当前范围 · 最近刷新 ' + new Date(p.refreshedAt).toLocaleTimeString(); }
        $('content').innerHTML = kpis(p) +
            '<section class="card"><div class="card-head"><div class="card-title">趋势 · ' + chartGranularityLabel(p) + '</div>' +
            '<div class="chart-tools"><div class="seg chart-view">' +
            '<button type="button" data-chart-view="total"' + (state.chartView === 'total' ? ' class="on"' : '') + '>总量</button>' +
            '<button type="button" data-chart-view="split"' + (state.chartView === 'split' ? ' class="on"' : '') + '>输入输出</button>' +
            '</div><div class="legend">' +
            (state.chartView === 'split'
                ? '<span><i class="dot in"></i>输入</span><span><i class="dot out"></i>输出</span>'
                : '<span><i class="dot in"></i>总用量</span>') +
            '</div></div></div>' +
            '<div class="chart-wrap"><div class="chart-main">' + chartSvg(p) + '</div></div>' + daySummary(p) + '</section>' +
            listCard(p);
        fitChart();
        var chartMain = document.querySelector('.chart-main');
        if (chartMain) { chartMain.scrollLeft = state.chartScroll; }
        var targetScroll = state.pendingScroll;
        state.pendingScroll = 0;
        if (state.scrollToList) {
            state.scrollToList = false;
            var selectedRow = document.querySelector('.row.sel');
            var target = selectedRow || document.querySelector('.list');
            if (target) { target.scrollIntoView({ block: 'center' }); }
        } else if (targetScroll > 0) {
            window.scrollTo(0, targetScroll);
        }
    }

    function toDateInput(date) {
        function p(n) { return n < 10 ? '0' + n : String(n); }
        return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
    }

    function closeDatePicker() {
        var pop = $('datePop');
        if (pop) { pop.hidden = true; }
    }

    function renderDatePicker() {
        var pop = $('datePop');
        if (!pop || !state.pickerMonth) { return; }
        var year = state.pickerMonth.getFullYear();
        var month = state.pickerMonth.getMonth();
        var first = new Date(year, month, 1);
        var offset = (first.getDay() + 6) % 7;
        var days = new Date(year, month + 1, 0).getDate();
        var todayIso = toDateInput(new Date());
        var rangeStart = null;
        var rangeEnd = null;
        if (state.rangeAnchor) {
            rangeStart = state.rangeAnchor;
            rangeEnd = state.hoverDay || state.rangeAnchor;
            if (rangeEnd < rangeStart) { var tmp = rangeStart; rangeStart = rangeEnd; rangeEnd = tmp; }
        } else if (state.customFrom && state.customTo) {
            rangeStart = state.customFrom < state.customTo ? state.customFrom : state.customTo;
            rangeEnd = state.customFrom < state.customTo ? state.customTo : state.customFrom;
        }
        var cells = [];
        for (var b = 0; b < offset; b += 1) {
            cells.push('<span class="date-pop-cell blank"></span>');
        }
        for (var d = 1; d <= days; d += 1) {
            var iso = toDateInput(new Date(year, month, d));
            var classes = 'date-pop-cell';
            var disabled = iso > todayIso;
            if (state.rangeAnchor) {
                var diffDays = Math.round(Math.abs(new Date(iso + 'T00:00:00').getTime() - new Date(state.rangeAnchor + 'T00:00:00').getTime()) / 86400000);
                if (diffDays > 30) { disabled = true; }
            }
            if (iso === state.customFrom || iso === state.customTo) { classes += ' on'; }
            if (iso === state.rangeAnchor) { classes += ' anchor'; }
            if (rangeStart !== null && rangeEnd !== null && iso >= rangeStart && iso <= rangeEnd && iso !== state.customFrom && iso !== state.customTo) {
                classes += ' in-range';
            }
            if (iso === todayIso) { classes += ' today'; }
            if (disabled) { classes += ' disabled'; }
            cells.push('<button type="button" class="' + classes + '" data-cal-day="' + iso + '"' + (disabled ? ' disabled' : '') + '>' + String(d) + '</button>');
        }
        var hint = state.rangeAnchor ? '选择结束日期（再点一次完成，最多 31 天）' : '选择开始日期（最多 31 天）';
        var nextMonthStart = new Date(year, month + 1, 1).getTime();
        var nextDisabled = nextMonthStart > new Date(todayIso + 'T00:00:00').getTime();
        pop.innerHTML =
            '<div class="date-pop-head">' +
            '<button type="button" class="date-pop-nav" data-cal-prev aria-label="上个月">‹</button>' +
            '<span class="date-pop-title">' + String(year) + ' 年 ' + String(month + 1) + ' 月</span>' +
            '<button type="button" class="date-pop-nav" data-cal-next aria-label="下个月"' + (nextDisabled ? ' disabled' : '') + '>›</button>' +
            '</div>' +
            '<div class="date-pop-grid">' +
            ['一', '二', '三', '四', '五', '六', '日'].map(function (w) { return '<span class="date-pop-week">' + w + '</span>'; }).join('') +
            cells.join('') +
            '</div>' +
            '<div class="date-pop-hint">' + hint + '</div>' +
            '<div class="date-pop-foot"><button type="button" data-cal-today>今天</button></div>';
    }

    function openDatePicker(field, anchor) {
        var value = field === 'from' ? (state.customFrom || state.customTo) : (state.customTo || state.customFrom);
        var base = value ? new Date(value + 'T00:00:00') : new Date();
        state.pickerField = field;
        state.rangeAnchor = field === 'to' && state.customFrom ? state.customFrom : null;
        state.hoverDay = null;
        state.pickerMonth = new Date(base.getFullYear(), base.getMonth(), 1);
        var pop = $('datePop');
        if (!pop) { return; }
        renderDatePicker();
        pop.hidden = false;
        var anchorRect = anchor.getBoundingClientRect();
        var popRect = pop.getBoundingClientRect();
        var left = Math.min(Math.max(8, anchorRect.left), Math.max(8, window.innerWidth - popRect.width - 8));
        var top = anchorRect.bottom + 6;
        if (top + popRect.height > window.innerHeight - 8) {
            top = Math.max(8, anchorRect.top - popRect.height - 6);
        }
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }

    function closeMorePop() {
        var pop = $('morePop');
        if (pop) { pop.hidden = true; }
    }

    function openMorePop(anchor) {
        var pop = $('morePop');
        if (!pop) { return; }
        pop.hidden = false;
        var anchorRect = anchor.getBoundingClientRect();
        var popRect = pop.getBoundingClientRect();
        var left = Math.min(Math.max(8, anchorRect.left), Math.max(8, window.innerWidth - popRect.width - 8));
        var top = anchorRect.bottom + 6;
        if (top + popRect.height > window.innerHeight - 8) { top = Math.max(8, anchorRect.top - popRect.height - 6); }
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }

    function shiftRange(delta) {
        var p = state.payload;
        if (!p || p.selection.range === 'all') { return; }
        var today = toDateInput(new Date());
        var from;
        var to;
        if (p.selection.range === 'month') {
            var base = new Date(p.fromDay + 'T00:00:00');
            var year = base.getFullYear();
            var month = base.getMonth() + delta;
            from = new Date(year, month, 1);
            to = new Date(year, month + 1, 0);
            if (toDateInput(to) > today) { to = new Date(today + 'T00:00:00'); }
            if (to.getTime() < from.getTime()) { return; }
        } else {
            var span = rangeDays(p);
            from = new Date(p.fromDay + 'T00:00:00');
            to = new Date(p.toDay + 'T00:00:00');
            from.setDate(from.getDate() + delta * span);
            to.setDate(to.getDate() + delta * span);
            if (delta > 0 && toDateInput(to) > today) { return; }
        }
        state.selection = {
            range: 'custom',
            dimension: state.selection.dimension,
            from: toDateInput(from),
            to: toDateInput(to),
            sessionId: state.selection.sessionId,
        };
        state.selectedDay = null;
        state.expanded = {};
        beginQuery();
        postQuery();
    }

    document.addEventListener('mouseover', function (event) {
        var cell = event.target && event.target.closest ? event.target.closest('[data-cal-day]') : null;
        if (!cell || !state.rangeAnchor) { return; }
        var iso = cell.getAttribute('data-cal-day');
        if (state.hoverDay === iso) { return; }
        state.hoverDay = iso;
        renderDatePicker();
    });

    document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) { return; }
        if (target.closest('#moreToggle')) {
            var morePop = $('morePop');
            if (morePop && morePop.hidden) { openMorePop(target.closest('#moreToggle')); } else { closeMorePop(); }
            return;
        }
        if (target.closest('#prevRange')) {
            shiftRange(-1);
            return;
        }
        if (target.closest('#nextRange')) {
            shiftRange(1);
            return;
        }
        if (!target.closest('#morePop')) { closeMorePop(); }
        var viewButton = target.closest('[data-chart-view]');
        if (viewButton) {
            state.chartView = viewButton.getAttribute('data-chart-view');
            vscode.postMessage({ type: 'ui', chartView: state.chartView });
            render();
            return;
        }
        var dateButton = target.closest('[data-date-field]');
        if (dateButton) {
            openDatePicker(dateButton.getAttribute('data-date-field'), dateButton);
            return;
        }
        if (target.closest('[data-cal-prev]')) {
            if (state.pickerMonth) { state.pickerMonth.setMonth(state.pickerMonth.getMonth() - 1); }
            renderDatePicker();
            return;
        }
        if (target.closest('[data-cal-next]')) {
            if (state.pickerMonth) { state.pickerMonth.setMonth(state.pickerMonth.getMonth() + 1); }
            renderDatePicker();
            return;
        }
        if (target.closest('[data-cal-today]')) {
            var todayIso = toDateInput(new Date());
            if (!state.rangeAnchor) {
                state.rangeAnchor = todayIso;
                state.customFrom = todayIso;
                state.customTo = '';
                updateDateButtons();
                renderDatePicker();
                return;
            }
            var todayStart = state.rangeAnchor < todayIso ? state.rangeAnchor : todayIso;
            var todayEnd = state.rangeAnchor < todayIso ? todayIso : state.rangeAnchor;
            state.customFrom = todayStart;
            state.customTo = todayEnd;
            state.rangeAnchor = null;
            state.hoverDay = null;
            updateDateButtons();
            closeDatePicker();
            return;
        }
        var calDay = target.closest('[data-cal-day]');
        if (calDay) {
            if (calDay.getAttribute('disabled') !== null) { return; }
            var iso = calDay.getAttribute('data-cal-day');
            if (!state.rangeAnchor) {
                // 第一次点击：定起点，保持日历打开，等第二次点终点
                state.rangeAnchor = iso;
                state.customFrom = iso;
                state.customTo = '';
                updateDateButtons();
                if ($('toText')) { $('toText').textContent = '选择结束日期'; }
                renderDatePicker();
                return;
            }
            var start = state.rangeAnchor < iso ? state.rangeAnchor : iso;
            var end = state.rangeAnchor < iso ? iso : state.rangeAnchor;
            var spanDays = Math.round((new Date(end + 'T00:00:00').getTime() - new Date(start + 'T00:00:00').getTime()) / 86400000) + 1;
            if (spanDays > 31) {
                showError('自定义范围最长为 31 天；更早的数据请用「全部记录」');
                return;
            }
            state.customFrom = start;
            state.customTo = end;
            state.rangeAnchor = null;
            state.hoverDay = null;
            updateDateButtons();
            closeDatePicker();
            return;
        }
        if (!target.closest('#datePop')) { closeDatePicker(); }
        var rangeButton = target.closest('[data-range]');
        if (rangeButton) {
            closeMorePop();
            var range = rangeButton.getAttribute('data-range');
            if (range === 'custom') {
                state.selection.range = 'custom';
                var now = new Date();
                var weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
                if (!state.customFrom) { state.customFrom = toDateInput(weekAgo); }
                if (!state.customTo) { state.customTo = toDateInput(now); }
                updateDateButtons();
                if ($('rangeLabel')) { $('rangeLabel').textContent = '自定义范围'; }
                renderActive();
                return;
            }
            state.selection = { range: range, dimension: state.selection.dimension, sessionId: state.selection.sessionId };
            state.selectedDay = null;
            state.expanded = {};
            beginQuery();
            postQuery();
            return;
        }
        var dimButton = target.closest('[data-dim]');
        if (dimButton) {
            state.selection.dimension = dimButton.getAttribute('data-dim');
            beginQuery();
            postQuery();
            return;
        }
        var chartPoint = target.closest('[data-chart-focus]');
        if (chartPoint) {
            var focusDay = chartPoint.getAttribute('data-chart-focus');
            state.selectedDay = focusDay;
            state.pendingSelectedDay = focusDay;
            render();
            return;
        }
        var bucketNode = target.closest('[data-bucket]');
        if (bucketNode) {
            var index = Number(bucketNode.getAttribute('data-bucket'));
            var bucket = state.payload && state.payload.buckets ? state.payload.buckets[index] : null;
            if (bucket) {
                state.expanded[bucket.key] = state.expanded[bucket.key] !== true;
            }
            render();
            return;
        }
        var moreButton = target.closest('[data-more-index]');
        if (moreButton) {
            var moreIndex = Number(moreButton.getAttribute('data-more-index'));
            var moreBucket = state.payload && state.payload.buckets ? state.payload.buckets[moreIndex] : null;
            if (moreBucket) {
                state.detailLimit[moreBucket.key] = (state.detailLimit[moreBucket.key] || 100) + 100;
            }
            render();
            return;
        }
        var action = target.closest('[data-action]');
        if (action && action.getAttribute('data-action') === 'view-day') {
            if (state.selectedDay) {
                state.pendingSelectedDay = state.selectedDay;
                state.pendingExpandDay = state.selectedDay;
            }
            state.selection.dimension = 'day';
            state.scrollToList = true;
            beginQuery();
            postQuery();
            return;
        }
        if (target.closest('#applyCustom')) {
            var from = state.customFrom;
            var to = state.customTo;
            if (!from || !to) { showError('请选择开始和结束日期'); return; }
            if (from > to) { showError('开始日期不能晚于结束日期'); return; }
            var todayIso = toDateInput(new Date());
            if (from > todayIso || to > todayIso) { showError('不能选择晚于今天的日期'); return; }
            var span = Math.round((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86400000) + 1;
            if (span > 31) {
                showError('自定义范围最长为 31 天；更早的数据请用「全部记录」');
                return;
            }
            clearError();
            state.selection = { range: 'custom', dimension: state.selection.dimension, from: from, to: to, sessionId: state.selection.sessionId };
            state.selectedDay = null;
            state.expanded = {};
            beginQuery();
            postQuery();
            return;
        }
        if (target.closest('#refresh')) {
            beginQuery();
            postQuery();
        }
    });

    window.addEventListener('message', function (event) {
        var message = event.data;
        if (!message || typeof message !== 'object') { return; }
        if (message.type === 'payload') {
            if (message.view === 'split' || message.view === 'total') { state.chartView = message.view; }
            state.payload = message.payload;
            clearError();
            render();
            return;
        }
        if (message.type === 'error') {
            showError(String(message.message || '查询失败'));
        }
    });

    // 只重排已加载的页面（窗口/面板宽度变化），不发起查询
    var resizeTimer = null;
    window.addEventListener('resize', function () {
        if (resizeTimer !== null) { clearTimeout(resizeTimer); }
        resizeTimer = setTimeout(function () {
            resizeTimer = null;
            if (state.payload) { render(); }
        }, 150);
    });

    var chartTip = $('chartTip');
    function hideChartTip() {
        if (chartTip) { chartTip.hidden = true; }
    }
    document.addEventListener('mousemove', function (event) {
        if (!chartTip) { return; }
        var node = event.target && event.target.closest ? event.target.closest('[data-chart-key]') : null;
        if (!node) { hideChartTip(); return; }
        var key = node.getAttribute('data-chart-key');
        var days = state.chartDays || [];
        var day = null;
        for (var i = 0; i < days.length; i += 1) {
            if (days[i].key === key) { day = days[i]; }
        }
        if (!day) { hideChartTip(); return; }
        var label = state.chartMode === 'month'
            ? key
            : state.chartMode === 'week'
                ? day.label + ' ' + day.detail
                : day.label + (day.detail ? ' · ' + day.detail : '');
        var html = '<div class="ct-day">' + esc(label) + '</div>' +
            '<div class="ct-total">' + compact(day.total) + ' <span>tok</span></div>' +
            '<div class="ct-row">输入 <b>' + compact(day.input) + '</b></div>' +
            '<div class="ct-row">输出 <b>' + compact(day.output) + '</b></div>' +
            '<div class="ct-row">缓存读 <b>' + (typeof day.cacheRead === 'number' ? compact(day.cacheRead) : '—') + '</b></div>' +
            '<div class="ct-row">缓存写 <b>' + (typeof day.cacheWrite === 'number' ? compact(day.cacheWrite) : '—') + '</b></div>' +
            '<div class="ct-row">缓存命中 <b>' + pct(day.cacheHitRate) + '</b></div>';
        chartTip.innerHTML = html;
        chartTip.hidden = false;
        var x = event.clientX + 14;
        var y = event.clientY + 14;
        var rect = chartTip.getBoundingClientRect();
        if (x + rect.width > window.innerWidth - 12) { x = event.clientX - rect.width - 14; }
        if (y + rect.height > window.innerHeight - 12) { y = event.clientY - rect.height - 14; }
        chartTip.style.left = Math.max(8, x) + 'px';
        chartTip.style.top = Math.max(8, y) + 'px';
    });
    document.addEventListener('mouseleave', hideChartTip);
    window.addEventListener('scroll', hideChartTip, true);

    var cellTip = $('cellTip');
    function hideCellTip() {
        if (cellTip) { cellTip.hidden = true; }
    }
    function showCellTip(node) {
        if (!cellTip) { return; }
        var kind = node.getAttribute('data-tip-kind') || '';
        var main = node.getAttribute('data-tip-main') || '';
        var sub = node.getAttribute('data-tip-sub') || '';
        if (main === '') { hideCellTip(); return; }
        cellTip.innerHTML = '<div class="ct-head">' + (kind === 'model' ? '模型' : '会话') + '</div>' +
            '<div class="ct-main">' + esc(main) + '</div>' +
            (sub === '' ? '' : '<div class="ct-sub">' + esc(sub) + '</div>');
        cellTip.hidden = false;
        var anchor = node.getBoundingClientRect();
        var tip = cellTip.getBoundingClientRect();
        var left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - tip.width - 8));
        var top = anchor.bottom + 6;
        if (top + tip.height > window.innerHeight - 8) {
            top = Math.max(8, anchor.top - tip.height - 6);
        }
        cellTip.style.left = left + 'px';
        cellTip.style.top = top + 'px';
    }
    document.addEventListener('mouseover', function (event) {
        var node = event.target && event.target.closest ? event.target.closest('[data-tip-kind]') : null;
        if (node) { showCellTip(node); } else { hideCellTip(); }
    });
    document.addEventListener('mouseleave', hideCellTip);
    window.addEventListener('scroll', hideCellTip, true);
    window.addEventListener('resize', hideCellTip);

    function timezoneText() {
        var zone = '';
        try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { zone = ''; }
        var offset = -new Date().getTimezoneOffset();
        var sign = offset >= 0 ? '+' : '-';
        var abs = Math.abs(offset);
        var hours = Math.floor(abs / 60);
        var minutes = abs % 60;
        var suffix = minutes === 0 ? String(hours) : String(hours) + ':' + (minutes < 10 ? '0' : '') + String(minutes);
        return '时区 ' + (zone || '本地') + ' · UTC' + sign + suffix;
    }

    if ($('tzLabel')) { $('tzLabel').textContent = timezoneText(); }
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
