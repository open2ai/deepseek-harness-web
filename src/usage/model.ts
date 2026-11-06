// 消费记录的**纯数据层**：类型、时间范围、聚合。
//
// 这里不碰 `vscode`，便于守卫直接 bundle 后断言：
// 时间范围边界、按天/模型/会话聚合、缓存读写的"有值才统计"。
import type { DshReplyStats } from '../dsh';

/** 一次展示给页面的明细上限；总量仍按范围内全部记录计算 */
export const MAX_DETAIL_RECORDS = 5_000;

/** 单条消费记录：dsh 返回什么就存什么，未返回的保持 undefined（显示 —，不补 0） */
export interface UsageRecord {
    time: number;
    provider?: string;
    model?: string;
    sessionId?: string;
    /** 展示用会话标题（查询时从 dsh 实时解析，不落盘；重命名后重新打开/刷新会更新） */
    sessionTitle?: string;
    /** 展示用工作区路径（查询时按 session 的 cwd 实时解析；会话删除后可能缺失，不落盘） */
    project?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    steps?: number;
    wallSec?: number;
    tps?: number;
    ttftSec?: number;
}

export type UsageRangeId = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'all' | 'custom';
export type UsageDimension = 'day' | 'model' | 'project';

/** 页面查询条件：时间范围 + 列表维度 + 可选会话筛选；custom 才有 from/to（YYYY-MM-DD，本地时区） */
export interface UsageSelection {
    range: UsageRangeId;
    dimension: UsageDimension;
    from?: string;
    to?: string;
    sessionId?: string;
}

export const DEFAULT_SELECTION: UsageSelection = { range: '7d', dimension: 'day' };

const RANGES: ReadonlySet<string> = new Set(['today', 'yesterday', '7d', '30d', 'month', 'all', 'custom']);
const DIMENSIONS: ReadonlySet<string> = new Set(['day', 'model', 'project']);
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** 记录形状校验：读到历史脏数据时跳过，不把 NaN 写进统计 */
export function isUsageRecord(value: unknown): value is UsageRecord {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const r = value as Record<string, unknown>;
    return typeof r.time === 'number' && Number.isFinite(r.time) && r.time > 0;
}

/** 从回复统计构造记录（时间由调用方给，缺失时用当前时刻） */
export function usageRecordOf(stats: DshReplyStats, sessionId: string | undefined, apiTime?: number): UsageRecord {
    const ts = typeof apiTime === 'number' && Number.isFinite(apiTime) && apiTime > 0
        ? (apiTime > 1e12 ? apiTime : apiTime * 1000)
        : Date.now();
    const record: UsageRecord = { time: ts };
    if (sessionId !== undefined && sessionId !== '') {
        record.sessionId = sessionId;
    }
    for (const key of ['provider', 'model'] as const) {
        const value = stats[key];
        if (typeof value === 'string' && value !== '') {
            record[key] = value;
        }
    }
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'steps'] as const) {
        const value = stats[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            record[key] = value;
        }
    }
    for (const key of ['wallSec', 'tps', 'ttftSec'] as const) {
        const value = stats[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            record[key] = value;
        }
    }
    return record;
}

/** 记录里是否有任何用量：没有任何 token 的回合不写空行 */
export function hasAnyUsage(record: UsageRecord): boolean {
    return (
        record.inputTokens !== undefined ||
        record.outputTokens !== undefined ||
        record.cacheReadTokens !== undefined ||
        record.cacheWriteTokens !== undefined ||
        record.reasoningTokens !== undefined ||
        record.totalTokens !== undefined
    );
}

/** 归一化页面传来的选择；非法值退回 fallback（默认近 7 天/按天） */
export function normalizeSelection(value: unknown, fallback: UsageSelection = DEFAULT_SELECTION): UsageSelection {
    const next: UsageSelection = { ...fallback };
    if (!DIMENSIONS.has(next.dimension)) {
        next.dimension = 'day';
    }
    if (typeof value !== 'object' || value === null) {
        return next;
    }
    const input = value as Record<string, unknown>;
    if (typeof input.range === 'string' && RANGES.has(input.range)) {
        next.range = input.range as UsageRangeId;
    }
    if (typeof input.dimension === 'string' && DIMENSIONS.has(input.dimension)) {
        next.dimension = input.dimension as UsageDimension;
    }
    if (typeof input.sessionId === 'string' && input.sessionId !== '') {
        next.sessionId = input.sessionId;
    } else {
        delete next.sessionId;
    }
    if (next.range === 'custom') {
        const from = typeof input.from === 'string' && DATE_RE.test(input.from) ? input.from : undefined;
        const to = typeof input.to === 'string' && DATE_RE.test(input.to) ? input.to : undefined;
        if (from !== undefined && to !== undefined) {
            next.from = from;
            next.to = to;
        } else {
            next.range = fallback.range === 'custom' ? '7d' : fallback.range;
        }
    } else {
        delete next.from;
        delete next.to;
    }
    return next;
}

function startOfDay(ms: number): number {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parseLocalDay(text: string, endOfDay: boolean): number | undefined {
    if (!DATE_RE.test(text)) {
        return undefined;
    }
    const [y, m, d] = text.split('-').map((part) => Number(part));
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
        return undefined;
    }
    const date = new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
        return undefined; // 2026-02-31 这类不存在日期
    }
    return date.getTime();
}

function dayKey(ms: number): string {
    const d = new Date(ms);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${String(d.getFullYear())}-${mm}-${dd}`;
}

function dayLabel(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekdayLabel(ms: number): string {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(ms).getDay()] ?? '';
}

/** 时间窗口：本地自然日边界；7d/30d 含今天在内往前数 */
export interface UsageWindow {
    fromMs: number;
    toMs: number;
    label: string;
}

export function windowOf(selection: UsageSelection, now: number): UsageWindow {
    const today = startOfDay(now);
    switch (selection.range) {
        case 'today':
            return { fromMs: today, toMs: now, label: '今天' };
        case 'yesterday':
            return { fromMs: today - DAY_MS, toMs: today - 1, label: '昨天' };
        case '7d':
            return { fromMs: today - 6 * DAY_MS, toMs: now, label: '近 7 天' };
        case '30d':
            return { fromMs: today - 29 * DAY_MS, toMs: now, label: '近 30 天' };
        case 'month':
            return { fromMs: new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime(), toMs: now, label: '本月' };
        case 'all':
            return { fromMs: 0, toMs: now, label: '全部记录' };
        case 'custom': {
            const from = selection.from === undefined ? undefined : parseLocalDay(selection.from, false);
            const to = selection.to === undefined ? undefined : parseLocalDay(selection.to, true);
            if (from !== undefined && to !== undefined) {
                return {
                    fromMs: Math.min(from, to),
                    toMs: Math.max(from, to),
                    label: `${dayKey(Math.min(from, to))} ～ ${dayKey(Math.max(from, to))}`,
                };
            }
            return { fromMs: today - 6 * DAY_MS, toMs: now, label: '近 7 天' };
        }
        default:
            return { fromMs: today - 6 * DAY_MS, toMs: now, label: '近 7 天' };
    }
}

export interface UsageTotals {
    records: number;
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total: number;
    cacheHitRate?: number;
    avgWallSec?: number;
    avgTtftSec?: number;
}

export interface UsageBucket {
    key: string;
    label: string;
    detail: string;
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total: number;
    records: number;
    cacheHitRate?: number;
    items: UsageRecord[];
}

export interface UsageSessionOption {
    sessionId: string;
    title?: string;
    records: number;
    total: number;
}

export interface UsagePayload {
    selection: UsageSelection;
    rangeLabel: string;
    fromDay: string;
    toDay: string;
    refreshedAt: number;
    timezone: string;
    totals: UsageTotals;
    /** 趋势图固定用按天数据（升序） */
    days: UsageBucket[];
    /** 列表按当前维度聚合（按总量降序） */
    buckets: UsageBucket[];
    /** 当前范围里出现过的会话（会话筛选下拉用；不受 sessionId 过滤影响） */
    sessions: UsageSessionOption[];
    /** 范围内没有任何记录时，最近一条记录的时间（给空态用） */
    latestRecordTime?: number;
    /** 明细超过展示上限时截断（总量仍是全量） */
    truncated: boolean;
    /** 范围内记录数（未截断前） */
    recordsInRange: number;
}

function sumOf(records: readonly UsageRecord[], key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'): number {
    let sum = 0;
    for (const r of records) {
        const value = r[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            sum += value;
        }
    }
    return sum;
}

function optionalSum(records: readonly UsageRecord[], key: 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'): number | undefined {
    let found = false;
    let sum = 0;
    for (const r of records) {
        const value = r[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            found = true;
            sum += value;
        }
    }
    return found ? sum : undefined;
}

function totalOfRecord(record: UsageRecord): number {
    if (typeof record.totalTokens === 'number' && Number.isFinite(record.totalTokens)) {
        return record.totalTokens;
    }
    return (record.inputTokens ?? 0) + (record.outputTokens ?? 0) + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
}

function totalOf(records: readonly UsageRecord[]): number {
    let sum = 0;
    for (const r of records) {
        sum += totalOfRecord(r);
    }
    return sum;
}

function hitRateOf(records: readonly UsageRecord[]): number | undefined {
    const withCacheRead = records.filter((r) => typeof r.cacheReadTokens === 'number');
    if (withCacheRead.length === 0) {
        return undefined;
    }
    const input = sumOf(withCacheRead, 'inputTokens');
    const cacheRead = sumOf(withCacheRead, 'cacheReadTokens');
    const denom = input + cacheRead;
    return denom > 0 ? (cacheRead / denom) * 100 : undefined;
}

function average(values: readonly number[]): number | undefined {
    return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

function bucketOf(records: readonly UsageRecord[], key: string, label: string, detail: string): UsageBucket {
    const bucket: UsageBucket = {
        key,
        label,
        detail,
        input: sumOf(records, 'inputTokens'),
        output: sumOf(records, 'outputTokens'),
        total: totalOf(records),
        records: records.length,
        cacheRead: optionalSum(records, 'cacheReadTokens'),
        cacheWrite: optionalSum(records, 'cacheWriteTokens'),
        reasoning: optionalSum(records, 'reasoningTokens'),
        items: [...records].sort((a, b) => b.time - a.time),
    };
    const hit = hitRateOf(records);
    if (hit !== undefined) {
        bucket.cacheHitRate = hit;
    }
    return bucket;
}

function bucketLabel(record: UsageRecord, dimension: UsageDimension): { key: string; label: string; detail: string } {
    if (dimension === 'model') {
        const provider = record.provider ?? '未记录服务商';
        const model = record.model ?? '未记录模型';
        return { key: `${provider}/${model}`, label: model, detail: provider };
    }
    if (dimension === 'project') {
        const project = record.project;
        if (project !== undefined) {
            return { key: project, label: pathBaseName(project), detail: project };
        }
        return record.sessionId === undefined
            ? { key: 'unknown', label: '未记录工作区', detail: '' }
            : { key: 'unknown', label: '工作区不可用', detail: '会话已删除或读不到 cwd' };
    }
    const key = dayKey(record.time);
    return { key, label: dayLabel(record.time), detail: weekdayLabel(record.time) };
}

function pathBaseName(path: string): string {
    const parts = path.replace(/[/\\]+$/u, '').split(/[/\\]/u).filter((part) => part !== '');
    return parts[parts.length - 1] ?? path;
}

/**
 * 按选择聚合。
 * 边界：范围内无记录也返回空结构；明细超上限只截最新 N 条，总量仍按全部记录。
 */
export function aggregateUsage(all: readonly UsageRecord[], selection: UsageSelection, now: number, latestRecordTimeOverride?: number): UsagePayload {
    const window = windowOf(selection, now);
    const windowRecords = all
        .filter((r) => isUsageRecord(r) && r.time >= window.fromMs && r.time <= window.toMs)
        .sort((a, b) => a.time - b.time);
    const filtered = selection.sessionId === undefined
        ? windowRecords
        : windowRecords.filter((r) => r.sessionId === selection.sessionId);
    const totalsRecords = filtered;
    const detail = filtered.length > MAX_DETAIL_RECORDS ? filtered.slice(-MAX_DETAIL_RECORDS) : filtered;

    // 会话筛选选项取“范围内全量”，不受已选 sessionId 影响，否则下拉里只剩当前会话
    const sessionMap = new Map<string, UsageSessionOption>();
    for (const record of windowRecords) {
        if (record.sessionId === undefined) {
            continue;
        }
        const entry = sessionMap.get(record.sessionId) ?? {
            sessionId: record.sessionId,
            records: 0,
            total: 0,
        };
        entry.records += 1;
        entry.total += totalOfRecord(record);
        if (entry.title === undefined && record.sessionTitle !== undefined) {
            entry.title = record.sessionTitle;
        }
        sessionMap.set(record.sessionId, entry);
    }
    if (selection.sessionId !== undefined && !sessionMap.has(selection.sessionId)) {
        sessionMap.set(selection.sessionId, { sessionId: selection.sessionId, records: 0, total: 0 });
    }
    const sessions = [...sessionMap.values()].sort((a, b) => b.total - a.total);

    const totals: UsageTotals = {
        records: totalsRecords.length,
        input: sumOf(totalsRecords, 'inputTokens'),
        output: sumOf(totalsRecords, 'outputTokens'),
        total: totalOf(totalsRecords),
        cacheRead: optionalSum(totalsRecords, 'cacheReadTokens'),
        cacheWrite: optionalSum(totalsRecords, 'cacheWriteTokens'),
        reasoning: optionalSum(totalsRecords, 'reasoningTokens'),
    };
    const hit = hitRateOf(totalsRecords);
    if (hit !== undefined) {
        totals.cacheHitRate = hit;
    }
    const walls = totalsRecords.filter((r) => typeof r.wallSec === 'number').map((r) => r.wallSec as number);
    const ttfts = totalsRecords.filter((r) => typeof r.ttftSec === 'number').map((r) => r.ttftSec as number);
    const avgWall = average(walls);
    const avgTtft = average(ttfts);
    if (avgWall !== undefined) {
        totals.avgWallSec = avgWall;
    }
    if (avgTtft !== undefined) {
        totals.avgTtftSec = avgTtft;
    }

    // 趋势图：按天（升序）；没有记录的天也保留（连续时间轴），但整个范围没记录时不补空柱
    const dayMap = new Map<string, { time: number; records: UsageRecord[] }>();
    for (const record of detail) {
        const key = dayKey(record.time);
        const entry = dayMap.get(key) ?? { time: startOfDay(record.time), records: [] };
        entry.records.push(record);
        dayMap.set(key, entry);
    }
    let days = [...dayMap.entries()]
        .sort((a, b) => a[1].time - b[1].time)
        .map(([key, entry]) => bucketOf(entry.records, key, dayLabel(entry.time), weekdayLabel(entry.time)));
    if (detail.length > 0) {
        const fillStart = selection.range === 'all' ? startOfDay(detail[0].time) : startOfDay(window.fromMs);
        const fillEnd = selection.range === 'all'
            ? startOfDay(detail[detail.length - 1].time)
            : startOfDay(Math.min(window.toMs, now));
        const spanDays = Math.round((fillEnd - fillStart) / DAY_MS) + 1;
        if (spanDays > 0 && spanDays <= 62) {
            const startDate = new Date(fillStart);
            const filled: UsageBucket[] = [];
            for (let i = 0; ; i += 1) {
                const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i).getTime();
                if (cursor > fillEnd) {
                    break;
                }
                const key = dayKey(cursor);
                const entry = dayMap.get(key);
                filled.push(entry === undefined
                    ? bucketOf([], key, dayLabel(cursor), weekdayLabel(cursor))
                    : bucketOf(entry.records, key, dayLabel(cursor), weekdayLabel(cursor)));
            }
            if (filled.length > 0) {
                days = filled;
            }
        }
    }

    // 列表：按当前维度
    const groups = new Map<string, { label: string; detail: string; records: UsageRecord[] }>();
    for (const record of detail) {
        const info = bucketLabel(record, selection.dimension);
        const entry = groups.get(info.key) ?? { label: info.label, detail: info.detail, records: [] };
        entry.records.push(record);
        groups.set(info.key, entry);
    }
    const buckets = [...groups.entries()]
        .map(([key, entry]) => bucketOf(entry.records, key, entry.label, entry.detail))
        .sort((a, b) => (selection.dimension === 'day' ? b.key.localeCompare(a.key) : b.total - a.total));

    const latestRecordTime = latestRecordTimeOverride ?? all.reduce<number | undefined>((max, r) => {
        if (!isUsageRecord(r)) {
            return max;
        }
        return max === undefined || r.time > max ? r.time : max;
    }, undefined);

    return {
        selection: { ...selection },
        rangeLabel: window.label,
        fromDay: selection.range === 'all'
            ? (filtered[0] === undefined ? '—' : dayKey(filtered[0].time))
            : dayKey(window.fromMs),
        toDay: selection.range === 'all'
            ? (filtered[filtered.length - 1] === undefined ? dayKey(now) : dayKey(filtered[filtered.length - 1].time))
            : dayKey(window.toMs),
        refreshedAt: now,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '本地时区',
        totals,
        days,
        buckets,
        sessions,
        ...(latestRecordTime === undefined ? {} : { latestRecordTime }),
        truncated: filtered.length > MAX_DETAIL_RECORDS,
        recordsInRange: totalsRecords.length,
    };
}
