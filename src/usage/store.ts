// 消费记录的持久化：`globalStorage/usage/usage-YYYY-MM.jsonl`。
//
// 为什么不用 Memento 数组：每记一条都要读出整数组、追加、整份写回，越用越慢，只能靠截断上限。
// JSONL 只追加一行；查询只读覆盖时间范围的月文件。旧 Memento 记录在首次使用时迁移一次。
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { isUsageRecord, windowOf, type UsageRecord, type UsageSelection } from './model';

/** 旧版本存在 globalState 里的数组键（迁移来源，保留作备份） */
const LEGACY_KEY = 'dsh.usage';
/** 迁移完成标记；避免每次启动重复迁移 */
const MIGRATED_KEY = 'dsh.usage.migrated.v1';
/** 最近一条记录时间（空态提示用；不参与范围查询） */
const LATEST_KEY = 'dsh.usage.latest.v1';
const FILE_RE = /^usage-(\d{4})-(\d{2})\.jsonl$/u;

export interface UsageStorageHost {
    globalStorageUri: vscode.Uri;
    globalState: vscode.Memento;
}

export interface UsageRangeResult {
    records: UsageRecord[];
    latestRecordTime?: number;
}

let prepared: Promise<string> | undefined;
let preparedRoot = '';
let appendChain: Promise<void> = Promise.resolve();

function usageDirOf(context: UsageStorageHost): string {
    return path.join(context.globalStorageUri.fsPath, 'usage');
}

function monthFileOf(dir: string, ms: number): string {
    const d = new Date(ms);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return path.join(dir, `usage-${String(d.getFullYear())}-${month}.jsonl`);
}

function enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = appendChain.then(task, task);
    appendChain = next.catch(() => undefined);
    return next;
}

/**
 * 跨窗口写锁：globalStorage 是同一 VS Code profile 共享的，多个窗口可能同时追加。
 * 抢不到锁就短退避；崩溃留下的旧锁超过 30 秒视为过期。拿不到锁时最后仍直接写，
 * 保证不会因为异常锁文件卡死（JSONL 半行由读取端跳过）。
 */
async function withAppendLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
    const lock = path.join(dir, '.usage.lock');
    for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
            const handle = await fs.promises.open(lock, 'wx');
            try {
                return await task();
            } finally {
                await handle.close();
                await fs.promises.unlink(lock).catch(() => undefined);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            try {
                const stat = await fs.promises.stat(lock);
                if (Date.now() - stat.mtimeMs > 30_000) {
                    await fs.promises.unlink(lock).catch(() => undefined);
                }
            } catch {
                /* 锁文件刚好被释放 */
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    return task();
}

function signatureOf(record: UsageRecord): string {
    return [
        record.time,
        record.sessionId ?? '',
        record.inputTokens ?? '',
        record.outputTokens ?? '',
        record.cacheReadTokens ?? '',
        record.cacheWriteTokens ?? '',
        record.totalTokens ?? '',
    ].join('|');
}

/** 首次使用：建目录 + 迁移旧 Memento 数组（旧键保留作备份，不删除） */
async function prepare(context: UsageStorageHost): Promise<string> {
    const dir = usageDirOf(context);
    if (prepared !== undefined && preparedRoot === dir) {
        return prepared;
    }
    preparedRoot = dir;
    prepared = (async () => {
        await fs.promises.mkdir(dir, { recursive: true });
        await migrateLegacy(context, dir);
        return dir;
    })().catch((error: unknown) => {
        prepared = undefined;
        throw error;
    });
    return prepared;
}

async function migrateLegacy(context: UsageStorageHost, dir: string): Promise<void> {
    if (context.globalState.get<unknown>(MIGRATED_KEY) === true) {
        return;
    }
    const legacy = context.globalState.get<unknown>(LEGACY_KEY);
    const records = Array.isArray(legacy) ? legacy.filter(isUsageRecord) : [];
    if (records.length > 0) {
        // 先按目标月文件分组；已存在的行按签名去重，迁移中断后重跑不会重复写入。
        const byFile = new Map<string, UsageRecord[]>();
        for (const record of records) {
            const file = monthFileOf(dir, record.time);
            const list = byFile.get(file) ?? [];
            list.push(record);
            byFile.set(file, list);
        }
        for (const [file, list] of byFile) {
            await withAppendLock(dir, async () => {
                const existing = new Set<string>();
                try {
                    const text = await fs.promises.readFile(file, 'utf8');
                    for (const line of text.split('\n')) {
                        if (line.trim() === '') {
                            continue;
                        }
                        try {
                            const parsed: unknown = JSON.parse(line);
                            if (isUsageRecord(parsed)) {
                                existing.add(signatureOf(parsed));
                            }
                        } catch {
                            /* 坏行跳过 */
                        }
                    }
                } catch {
                    /* 文件不存在 = 全新迁移 */
                }
                const lines = list
                    .filter((record) => !existing.has(signatureOf(record)))
                    .map((record) => `${JSON.stringify(record)}\n`)
                    .join('');
                if (lines !== '') {
                    await fs.promises.appendFile(file, lines, 'utf8');
                }
            });
        }
        const latest = records.reduce((max, record) => (record.time > max ? record.time : max), 0);
        if (latest > 0) {
            await context.globalState.update(LATEST_KEY, latest);
        }
    }
    await context.globalState.update(MIGRATED_KEY, true);
}

/** 追加一条记录：写进对应月份的 JSONL，并更新最近记录时间 */
export async function appendUsageRecord(context: UsageStorageHost, record: UsageRecord): Promise<void> {
    const dir = await prepare(context);
    await enqueueWrite(async () => {
        await withAppendLock(dir, async () => {
            await fs.promises.appendFile(monthFileOf(dir, record.time), `${JSON.stringify(record)}\n`, 'utf8');
            const latest = context.globalState.get<number>(LATEST_KEY);
            if (typeof latest !== 'number' || record.time > latest) {
                await context.globalState.update(LATEST_KEY, record.time);
            }
        });
    });
}

/** 时间范围是否和某个 `usage-YYYY-MM.jsonl` 的月份相交 */
function fileOverlaps(file: string, fromMs: number, toMs: number): boolean {
    const match = FILE_RE.exec(path.basename(file));
    if (match === null) {
        return false;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return false;
    }
    const start = new Date(year, month - 1, 1).getTime();
    const end = new Date(year, month, 1).getTime() - 1;
    return start <= toMs && end >= fromMs;
}

async function readFileRecords(file: string, fromMs: number, toMs: number): Promise<UsageRecord[]> {
    const text = await fs.promises.readFile(file, 'utf8');
    const records: UsageRecord[] = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '') {
            continue;
        }
        try {
            const parsed: unknown = JSON.parse(line);
            if (isUsageRecord(parsed) && parsed.time >= fromMs && parsed.time <= toMs) {
                records.push(parsed);
            }
        } catch {
            /* 半行/坏行跳过，不影响其它记录 */
        }
    }
    return records;
}

/** 只读覆盖时间范围的月文件；不会读全量（全部记录范围除外） */
export async function readUsageRange(
    context: UsageStorageHost,
    selection: UsageSelection,
    now: number
): Promise<UsageRangeResult> {
    const dir = await prepare(context);
    const window = windowOf(selection, now);
    let names: string[] = [];
    try {
        names = await fs.promises.readdir(dir);
    } catch {
        names = [];
    }
    const files = names
        .filter((name) => FILE_RE.test(name))
        .map((name) => path.join(dir, name))
        .filter((file) => fileOverlaps(file, window.fromMs, window.toMs))
        .sort();
    const records: UsageRecord[] = [];
    for (const file of files) {
        records.push(...(await readFileRecords(file, window.fromMs, window.toMs)));
    }
    const latest = context.globalState.get<number>(LATEST_KEY);
    return {
        records,
        ...(typeof latest === 'number' ? { latestRecordTime: latest } : {}),
    };
}
