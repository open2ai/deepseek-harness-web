// dsh RPC 信封、commands、探测、能力与端口。
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import {
    DEFAULT_DSH_PORT,
    endpointBaseUrl,
    getEndpoint,
    authCookieForPort,
    loginEndpoint,
    wireMethodName,
    argsWrap,
    type DshEndpoint,
} from "./auth";
// ---------- RPC 传输 ----------
const RPC_TIMEOUT_MS = 15_000;
interface RpcRequest {
    type: 'client-request';
    rpcId: string;
    method: string;
    payload: unknown;
}
interface RpcResponse<T = unknown> {
    type: 'server-response';
    rpcId: string;
    result:
        | { ok: true; value: T }
        | { ok: false; error: RpcError };
}
interface RpcError {
    code?: string;
    message?: string;
    details?: unknown;
}
export class DshRpcError extends Error {
    readonly code?: string;
    readonly details?: unknown;
    constructor(method: string, err: RpcError) {
        super(`DSH 接口 ${method} 出错：${err.message ?? err.code ?? '未知错误'}`);
        this.name = 'DshRpcError';
        this.code = err.code;
        this.details = err.details;
    }
}
/** 通用 RPC：调当前端点的任意 DSH 方法并返回 result.value（别名点号自动换算 + args 包装）。 */
export async function rpcCall<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
    return rpcCallAt<T>(getEndpoint().port, method, payload);
}
/** 向 $events 流回传一次应答（rc.1 Remote Event waterfall 的结果通道）。 */
export async function sendRemoteEventResult(
    clientId: string,
    eventId: string,
    outcome: { kind: 'next' } | { kind: 'result'; value?: unknown } | { kind: 'rejected'; error: unknown }
): Promise<void> {
    await rpcCall('$events.result', { clientId, eventId, outcome });
}
function sendClientRequest(
    port: number,
    wireMethod: string,
    body: RpcRequest,
    json: string,
    cookie: string | undefined
): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            host: `127.0.0.1:${port}`,
        };
        if (cookie) {
            headers.cookie = cookie;
        }
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/api/${wireMethod}`,
                method: 'POST',
                headers,
                timeout: RPC_TIMEOUT_MS,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`DSH 接口 ${wireMethod} 失败：HTTP ${res.statusCode}`));
                        return;
                    }
                    let parsed: RpcResponse;
                    try {
                        parsed = JSON.parse(data) as RpcResponse;
                    } catch {
                        reject(new Error(`DSH 接口 ${wireMethod} 返回了非 JSON 内容`));
                        return;
                    }
                    resolve(parsed);
                });
            }
        );
        req.on('error', (err) =>
            reject(new Error(`无法连接 DSH 服务（${endpointBaseUrl({ port })}）：${err.message}。请先打开「DeepSeek Harness」面板启动服务`))
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`DSH 接口 ${wireMethod} 请求超时`));
        });
        req.end(json);
    });
}
function resolveRpcResponse<T>(parsed: RpcResponse<T>, wireMethod: string): T {
    if (parsed.result.ok) {
        return parsed.result.value;
    }
    throw new DshRpcError(wireMethod, parsed.result.error);
}
async function rpcCallAt<T = unknown>(port: number, method: string, payload: unknown = {}): Promise<T> {
    const wireMethod = wireMethodName(method);
    const body: RpcRequest = { type: 'client-request', rpcId: crypto.randomUUID(), method: wireMethod, payload: argsWrap(wireMethod, payload) };
    const json = JSON.stringify(body);
    let parsed: RpcResponse;
    try {
        parsed = await sendClientRequest(port, wireMethod, body, json, authCookieForPort(port));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const needAuth = msg.includes('HTTP 401') || msg.includes('HTTP 403');
        if (needAuth && getEndpoint().port === port && getEndpoint().authUrl) {
            const loggedIn = await loginEndpoint(getEndpoint());
            if (loggedIn) {
                parsed = await sendClientRequest(port, wireMethod, body, json, authCookieForPort(port));
            } else {
                throw e;
            }
        } else {
            throw e;
        }
    }
    return resolveRpcResponse<T>(parsed as RpcResponse<T>, wireMethod);
}
/**
 * 按给定 wire 信封发送一次 RPC 并解析 result.value（与 rpcCallAt 相同的鉴权重试逻辑，
 * 但不做 argsWrap——由调用方按各代际接口约定给出完整 payload，如 commands/execute 的
 * `{ args }` 与 skills/list 的 `{ args:{ request } }`）。
 */
async function postWire<T = unknown>(port: number, wireMethod: string, payload: unknown): Promise<T> {
    const body: RpcRequest = { type: 'client-request', rpcId: crypto.randomUUID(), method: wireMethod, payload };
    const json = JSON.stringify(body);
    let parsed: RpcResponse;
    try {
        parsed = await sendClientRequest(port, wireMethod, body, json, authCookieForPort(port));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const needAuth = msg.includes('HTTP 401') || msg.includes('HTTP 403');
        if (needAuth && getEndpoint().port === port && getEndpoint().authUrl) {
            const loggedIn = await loginEndpoint(getEndpoint());
            if (loggedIn) {
                parsed = await sendClientRequest(port, wireMethod, body, json, authCookieForPort(port));
            } else {
                throw e;
            }
        } else {
            throw e;
        }
    }
    return resolveRpcResponse<T>(parsed as RpcResponse<T>, wireMethod);
}
// ---------- 斜杠命令（commands/execute） ----------
export interface DshCommandExec {
    commandId?: string;
    result?: { kind?: 'success' | 'error'; text?: string };
}
/** 执行一条斜杠命令（适配 dsh v0.1.7-rc.2）。上游接口：`commands/execute`，
 *  args 形参为 agentId / line / **submittedAttachments**（agent 作用域的命令远程；如 /permission <preset>）。
 *  上游 0.1.5 起第三个形参由 `images: EncodedImageAttachment[]` 改为 `submittedAttachments: CommandSubmitAttachment[]`
 *  （元素形如 `{ type:'image', mediaType, data, name? }` 或 `{ type:'file', receiptId }`）；形参名不符会被网关的
 *  描述符校验直接拒掉。本插件不随命令提交附件，传空数组。 */
export async function runSessionCommand(sessionId: string, line: string): Promise<DshCommandExec | undefined> {
    const method = 'commands/execute';
    const body: RpcRequest = {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload: { args: { agentId: sessionId, line, submittedAttachments: [] } },
    };
    const json = JSON.stringify(body);
    return new Promise<DshCommandExec | undefined>((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: getEndpoint().port,
                path: `/api/${method}`,
                method: 'POST',
                headers: Object.assign(
                    { 'content-type': 'application/json', host: `127.0.0.1:${getEndpoint().port}` },
                    authCookieForPort(getEndpoint().port) ? { cookie: authCookieForPort(getEndpoint().port) as string } : {}
                ),
                timeout: RPC_TIMEOUT_MS,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`DSH 接口 ${method} 失败：HTTP ${res.statusCode}`));
                        return;
                    }
                    let parsed: RpcResponse<DshCommandExec | undefined>;
                    try {
                        parsed = JSON.parse(data) as RpcResponse<DshCommandExec | undefined>;
                    } catch {
                        reject(new Error(`DSH 接口 ${method} 返回了非 JSON 内容`));
                        return;
                    }
                    if (parsed.result.ok) {
                        resolve(parsed.result.value);
                    } else {
                        reject(new DshRpcError(method, parsed.result.error));
                    }
                });
            }
        );
        req.on('error', (err) =>
            reject(new Error(`无法连接 DSH 服务（${endpointBaseUrl()}）：${err.message}。请先打开「DeepSeek Harness」面板启动服务`))
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`DSH 接口 ${method} 请求超时`));
        });
        req.end(json);
    });
}
// ---------- 命令目录 / 技能目录（web 端「/」菜单的数据源） ----------
/** 会话级 host 命令描述（commands/list 返回值；name 不含开头 "/"）。 */
export interface DshCommandDescriptor {
    name: string;
    description: string;
    /** 带参数命令的输入提示（如 permission 的 "<preset>"）。 */
    input?: { hint: string };
}
/** 会话级用户可调用技能（skills/list 返回值）。 */
export interface DshSkillEntry {
    name: string;
    description: string;
    whenToUse?: string;
    /** 是否允许模型自行调用；false 时仅用户可调（斜杠唤起仍可由用户发送）。 */
    modelInvocable: boolean;
}
/** 拉取当前会话的斜杠命令目录：`commands/list`，payload `{ args:{ agentId } }`（斜杠代际）。 */
export async function listCommands(sessionId: string): Promise<DshCommandDescriptor[]> {
    const value = await postWire<DshCommandDescriptor[]>(getEndpoint().port, 'commands/list', { args: { agentId: sessionId } });
    return Array.isArray(value) ? value : [];
}
// ---------- 进程级权限目录（0.1.7 起） ----------
/** 一个可选权限预设（上游 `PresetOption`）。 */
export interface DshPermissionPresetOption {
    /** 稳定取值：配置表里的键、`auto`，或派生的 `custom`。 */
    value: string;
    /** 展示名。 */
    name: string;
    description?: string;
}
/** 进程级权限目录（上游 `PermissionCatalog`；`permissionPresets/catalog` 的返回值）。 */
export interface DshPermissionCatalog {
    options: DshPermissionPresetOption[];
    defaultOptions?: DshPermissionPresetOption[];
    defaultPreset?: string;
}
/**
 * 拉取**进程级**权限预设目录（上游 `permissionPresets/catalog`，无参 remote）。
 *
 * 为什么不再从投影里取：0.1.5-rc.2 的 `permissions` 投影是 `PermissionSelect{options,currentValue}`，
 * 0.1.7 把它缩成 `PermissionSelection{currentValue}`，选项目录搬到这条进程级 remote
 * （上游 `interaction/permission-presets/src/types.ts` 明确写了 "Selectable options come from
 * the process-level catalog Remote"）。照旧读投影只会拿到空列表。
 *
 * 目录随**实时贡献**变化（如 auto 预设的注册/注销），上游用 emit 事件
 * `permission-presets/catalog-changed` 通知失效 —— 调用方据此重读。
 *
 * @returns 目录；形状不符时返回 undefined（调用方保留上一次的目录，而不是清空）
 */
export async function readPermissionPresetCatalog(): Promise<DshPermissionCatalog | undefined> {
    const value = await rpcCall<{ options?: unknown }>('permissionPresets/catalog', {});
    const options = Array.isArray(value?.options) ? value.options : undefined;
    if (options === undefined) {
        return undefined;
    }
    const normalized: DshPermissionPresetOption[] = [];
    for (const entry of options) {
        if (entry === null || typeof entry !== 'object') {
            continue;
        }
        const o = entry as { value?: unknown; name?: unknown; description?: unknown };
        if (typeof o.value !== 'string') {
            continue;
        }
        normalized.push({
            value: o.value,
            name: typeof o.name === 'string' && o.name !== '' ? o.name : o.value,
            ...(typeof o.description === 'string' ? { description: o.description } : {}),
        });
    }
    return { options: normalized };
}
/** 拉取当前会话的用户可调用技能：`skills/list`（Typert namespace+method，rc.1 实测）。
 *  payload `{ args:{ request:{ sessionId } } }`：技能的 args 描述符**不接受 `agentId`**（报
 *  `unexpected "agentId"`），会话 id 只走 `request.sessionId`（勿加 agentId，勿用点号 `skill.list`）。 */
export async function listSkills(sessionId: string): Promise<DshSkillEntry[]> {
    const value = await postWire<{ skills?: DshSkillEntry[] }>(getEndpoint().port, 'skills/list', {
        args: { request: { sessionId } },
    });
    return Array.isArray(value?.skills) ? value.skills : [];
}
// ---------- "@" 引用候选（fileReferences / sessionReferenceResolver） ----------
/** 文件/目录引用候选（fileReferences/list 返回；path 为相对工作区，无前导斜杠）。 */
export interface DshFileReference {
    path: string;
    kind: 'file' | 'directory';
}
/** 会话引用候选（sessionReferenceResolver/candidates 返回；mention 即插入正文的 token）。 */
export interface DshSessionReferenceCandidate {
    sessionId: string;
    label: string;
    cwd?: string;
    sameWorkspace?: boolean;
    createdAt?: number | string;
    mention?: string;
}
/** 拉取当前工作区文件/目录引用：`fileReferences/list`，payload `{ args:{ agentId, query } }`（适配 rc.1）。 */
export async function listFileReferences(sessionId: string, query: string): Promise<DshFileReference[]> {
    const value = await postWire<DshFileReference[]>(getEndpoint().port, 'fileReferences/list', {
        args: { agentId: sessionId, query },
    });
    return Array.isArray(value) ? value : [];
}
/** 拉取可引用会话候选：`sessionReferenceResolver/candidates`，payload `{ args:{ agentId, query } }`（适配 rc.1）。 */
export async function listSessionReferenceCandidates(
    sessionId: string,
    query: string
): Promise<DshSessionReferenceCandidate[]> {
    const value = await postWire<DshSessionReferenceCandidate[]>(getEndpoint().port, 'sessionReferenceResolver/candidates', {
        args: { agentId: sessionId, query },
    });
    return Array.isArray(value) ? value : [];
}
// ---------- 握手探测 ----------
export interface DshProbeResult {
    ok: boolean;
    endpoint: DshEndpoint;
    envelopeOk?: boolean;
    authRequired?: boolean;
    reason?: string;
}
/** 探测端口上是否运行 DSH（用只读 session.list 验证信封；rc1 401 时若能登录会自动补 cookie）。 */
export async function probeDsh(port: number): Promise<DshProbeResult> {
    const endpoint: DshEndpoint = { port };
    console.warn(`[dsh-debug] probeDsh port=${port} endpointAuthUrl=${getEndpoint().authUrl ?? '(none)'} hasCookie=${!!authCookieForPort(port)}`);
    try {
        await rpcCallAt(port, 'session.list', {});
        return { ok: true, endpoint, envelopeOk: true };
    } catch (e) {
        if (e instanceof DshRpcError) {
            console.warn(`[dsh-debug] probeDsh ${port}: envelope ok(DshRpcError)`);
            return { ok: true, endpoint, envelopeOk: true };
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) {
            console.warn(`[dsh-debug] probeDsh ${port}: authRequired -> ${msg}`);
            return { ok: false, endpoint, authRequired: true, reason: `端口 ${port} 上的 DSH 需要鉴权，请在 dsh 网页面板中完成登录` };
        }
        if (msg.includes('HTTP ') || msg.includes('非 JSON')) {
            console.warn(`[dsh-debug] probeDsh ${port}: not-DSH/protocol-mismatch -> ${msg}`);
            return { ok: false, endpoint, reason: `端口 ${port} 上不是 DSH 或协议不兼容` };
        }
        console.warn(`[dsh-debug] probeDsh ${port}: unreachable -> ${msg}`);
        return { ok: false, endpoint, reason: `端口 ${port} 不可连接` };
    }
}
// ---------- 能力门控（保留接口；v0.1.5-rc.2 的流走 /api/remote.mux） ----------
export interface DshCapabilities {
    version?: string;
    mux: boolean;
    streaming: boolean;
}
let currentCapabilities: DshCapabilities = { mux: true, streaming: true };
export function setCapabilities(c: Partial<DshCapabilities>): void {
    currentCapabilities = { ...currentCapabilities, ...c };
}
export function getCapabilities(): DshCapabilities {
    return { ...currentCapabilities };
}
export async function probeCapabilities(_port: number): Promise<DshCapabilities> {
    return { mux: true, streaming: true };
}
// ---------- 端口探测 / 就绪 ----------
export function checkPort(port: number = DEFAULT_DSH_PORT, host = '127.0.0.1', timeout = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeout);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}
export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await checkPort(port, '127.0.0.1', 800)) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}
export function isRunning(): Promise<boolean> {
    return checkPort(getEndpoint().port);
}
