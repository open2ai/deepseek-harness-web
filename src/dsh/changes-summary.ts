// 回合**改动摘要**（Host 内存态）的取回：`GET /api/changes.summary?sessionId=<id>&seq=<宣告序号>`。
//
// 为什么要问 Host 而不是从日志重建：这张卡的数据上游也只从这条路由取，**而它只在 Host
// 还记得那个回合时才有** —— 会话被释放、或这个 Host 从来没记过那个回合，摘要就是 undefined。
// Host 重启、或该回合不是在本进程里实时跑出来的，摘要就没了 —— 网页端**也就不显示那张卡**。
//
// 于是插件的正确口径是：**问一次，拿到就用、拿不到就没这张卡**（不自己从 `write`/`edit` 调用重建，
// 否则历史会话会凭空多出一张上游没有的卡 —— 2026-10-04 维护者真机截图的现象）。
//
// 与 `sessionExport.ts` 同一套传输：Node `http` + 鉴权 cookie；非 200 / 坏形状一律 null。
import * as http from 'http';
import { getEndpoint, authCookieForPort, ensureEndpointAuth } from './auth';
// 形状定义在 `rows/types.ts`（行模型的形状之家，只含类型）：`changesSummary` 是行的一部分，
// 页面侧要 `import type` 取它 —— 不能让宿主侧的 `node:http`/`vscode` 依赖链进 webview 的类型工程。
// 形状从行模型那边取（**不再重复导出**：`dsh/index.ts` 的 `export *` 会与 `./rows` 撞名）。
import type { DshChangedFile, DshChangesSummary } from './rows/types';

const REQUEST_TIMEOUT_MS = 8000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

/** 校验单条改动文件（镜像上游 `isChangedFile`：逐字段、`binary/oversized` 只认 true）。 */
function isChangedFile(value: unknown): value is DshChangedFile {
    if (!isRecord(value)) {
        return false;
    }
    const { path, display, added, deleted, binary, oversized } = value;
    return typeof path === 'string' && path.length > 0
        && typeof display === 'string' && display.length > 0
        && isSafeInt(added) && isSafeInt(deleted)
        && (binary === undefined || binary === true)
        && (oversized === undefined || oversized === true);
}

/** 校验整份摘要（镜像上游 `isChangesSummary`）。 */
export function isChangesSummary(value: unknown): value is DshChangesSummary {
    if (!isRecord(value)) {
        return false;
    }
    const { turn, files, total, added, deleted } = value;
    return isSafeInt(turn) && turn >= 1
        && isSafeInt(total) && isSafeInt(added) && isSafeInt(deleted)
        && Array.isArray(files) && files.every(isChangedFile);
}

/**
 * 取一个回合的改动摘要。
 *
 * @param sessionId - 会话标识（该回合所属会话）
 * @param seq - 该回合 `workspace/changes` 宣告事件的序号（行上的 `changesSeq`）
 * @returns 摘要；**Host 已经没有它**（404/空体/坏形状）或任何传输失败都给 `null`（调用方据此不渲染那张卡）
 */
export async function fetchChangesSummary(sessionId: string, seq: number): Promise<DshChangesSummary | null> {
    const ep = getEndpoint();
    try {
        await ensureEndpointAuth(ep);
    } catch {
        return null;
    }
    const cookie = authCookieForPort(ep.port);
    const query = `sessionId=${encodeURIComponent(sessionId)}&seq=${String(seq)}`;

    return new Promise<DshChangesSummary | null>((resolve) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: ep.port,
                path: `/api/changes.summary?${query}`,
                method: 'GET',
                headers: Object.assign(
                    { accept: 'application/json', host: `127.0.0.1:${ep.port}` },
                    cookie ? { cookie } : {},
                ),
                timeout: REQUEST_TIMEOUT_MS,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    // 404/405/501 = 该版本没有这条路由；其余非 200 = 服务端拒绝。
                    // 两者与「Host 已经没有这份摘要」在本插件里是同一件事：**不渲染那张卡**。
                    if (res.statusCode !== 200) {
                        resolve(null);
                        return;
                    }
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch {
                        resolve(null);
                        return;
                    }
                    resolve(isChangesSummary(parsed) ? parsed : null);
                });
                res.on('error', () => resolve(null));
            },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}
