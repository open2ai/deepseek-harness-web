// dsh 端点状态与浏览器鉴权 cookie。
// DSH 协议层：端点/鉴权/RPC/commands/probe/端口/mux（高层会话与流式方法见同目录 session.ts/stream.ts）。
// DSH 本地服务的 JSON-RPC 客户端 —— 适配 dsh v0.1.5-rc.2。
//
// ── 适配的 dsh 版本与上游接口映射（dsh 升级时按此表核对；勿按 0.1.1点号协议写）──
//   “wire 协议”基线 = dsh v0.1.5-rc.2（typert gateway）
//
//   1. RPC 信封：POST /api/<method>，body { type:'client-request', rpcId, method, payload }，
//      应答 { type:'server-response', rpcId, result:{ ok, value|error } }。
//   2. 方法名：namespace/method（斜杠）。本文件内点号只是“别名”，经 wireMethodName() 换算；
//      上游 @Remote 别名表（哪些方法走斜杠端点）见 docs/design/04 的方法契约表。
//   3. 载荷：payload:{ args:{ <形参名>: 请求对象 } }；形参名默认 request，例外见 ARGS_KEY_BY_METHOD。
//   4. 鉴权：/api 与 WS 都需浏览器鉴权 cookie（authUrl?token → dsh-auth-*），旧回环信任已取消。
//   5. 流式 remote（session/follow、workspace/follow、session/control、$events）只能走 WebSocket
//      /api/remote.mux：
//        上行 { type:'open', streamId, endpoint, payload } / { type:'cancel', streamId }；
//        下行 { type:'item', streamId, value? } / { type:'error', streamId, error } / { type:'end', streamId }。
//   6. 会话历史/投影：该版本已无 session.history；读取 = session/follow 快照
//      （snapshot: header/cursor/records/projections.values）+ 实时事件。见 readFollowSnapshot()/waitTurn()。
//   7. 旧端点（/api/respond、session.history、workspace.list、点号+平铺）在该版本不存在。
import * as http from 'node:http';
/** DSH 服务默认端口（dsh web 启动默认按 3080 处理；实际端口以探测 / URL 行结果为准）。 */
export const DEFAULT_DSH_PORT = 3080;
/** 动态识别出的 DSH 服务端点。 */
export interface DshEndpoint {
    port: number;
    /** `dsh web` 打印的 authenticatedUrl（含鉴权 token）；无则 undefined。 */
    authUrl?: string;
}
let currentEndpoint: DshEndpoint = { port: DEFAULT_DSH_PORT };
/**
 * 端点**端口**变化时的订阅者。
 *
 * 为什么要广播：在途的 mux 流（`session/follow`、`$events`）与本地网页代理都是**开的时候**取一次端点，
 * 之后不会再读。端口一变（dsh 重启 / 换实例），它们会继续指着旧端口重试，而界面**不会报错**、只是不再更新。
 * 所以由这里广播一次，让各持有者把在途连接重新指向。
 * 只比 `port`：`authUrl` 变了不影响已建立的流（cookie 是按端口缓存的）。
 */
const endpointListeners = new Set<(ep: DshEndpoint) => void>();

export function setEndpoint(ep: DshEndpoint): void {
    const changed = currentEndpoint.port !== ep.port;
    currentEndpoint = { port: ep.port, authUrl: ep.authUrl };
    if (changed) {
        for (const listener of [...endpointListeners]) {
            listener(getEndpoint());
        }
    }
}
/** 订阅端点变化；返回取消订阅。 */
export function onEndpointChange(listener: (ep: DshEndpoint) => void): () => void {
    endpointListeners.add(listener);
    return () => {
        endpointListeners.delete(listener);
    };
}
export function getEndpoint(): DshEndpoint {
    return { ...currentEndpoint };
}
export function endpointBaseUrl(ep: DshEndpoint = currentEndpoint): string {
    return `http://127.0.0.1:${ep.port}`;
}
export function endpointAuthUrl(ep: DshEndpoint = currentEndpoint): string {
    return ep.authUrl ?? endpointBaseUrl(ep);
}
// ---------- 鉴权 cookie（dsh 的 /api 与 WS 都需要鉴权 cookie） ----------
const authCookies = new Map<number, string>();
const loginInFlight = new Map<number, Promise<boolean>>();
const RPC_TIMEOUT_MS = 15000;
/** 从带 token 的 authenticatedUrl 登录取回 cookie（多跳 303 → / 都收集 Set-Cookie）。 */
function fetchAuthCookie(authUrl: string): Promise<string | null> {
    return new Promise((resolve) => {
        const collect = (url: string, cookies: string[], hops: number): void => {
            if (hops > 3) {
                resolve(cookies.filter(Boolean).join('; ') || null);
                return;
            }
            const req = http.get(url, (res) => {
                const sc = res.headers['set-cookie'];
                if (sc) {
                    for (const c of Array.isArray(sc) ? sc : [sc]) {
                        cookies.push(c.split(';')[0].trim());
                    }
                }
                const loc = res.headers.location;
                if (loc) {
                    res.resume();
                    collect(new URL(loc, url).toString(), cookies, hops + 1);
                    return;
                }
                res.resume();
                resolve(cookies.filter(Boolean).join('; ') || null);
            });
            req.on('error', () => resolve(cookies.filter(Boolean).join('; ') || null));
            req.setTimeout(RPC_TIMEOUT_MS, () => {
                req.destroy();
                resolve(cookies.filter(Boolean).join('; ') || null);
            });
        };
        collect(authUrl, [], 0);
    });
}
/** 用端点 authUrl 登录并缓存 cookie（幂等；返回是否拿到）。 */
async function loginForEndpoint(ep: DshEndpoint): Promise<boolean> {
    if (!ep.authUrl) {
        return false;
    }
    let pending = loginInFlight.get(ep.port);
    if (!pending) {
        pending = (async () => {
            const cookie = await fetchAuthCookie(ep.authUrl as string);
            if (cookie) {
                authCookies.set(ep.port, cookie);
            }
            console.warn(`[dsh-debug] login port=${ep.port} authUrl=${ep.authUrl} cookie=${cookie ? 'OK:' + cookie.split(';')[0] : 'NONE'}`);
            return Boolean(cookie);
        })();
        loginInFlight.set(ep.port, pending);
    }
    const ok = await pending;
    loginInFlight.delete(ep.port);
    return ok;
}
/** 确保当前/指定端点已拿到鉴权 cookie（dsh 各版）。无 authUrl 返回 false。 */
export async function ensureEndpointAuth(ep: DshEndpoint = currentEndpoint): Promise<boolean> {
    return loginForEndpoint(ep);
}
/** 读取端点已缓存的 cookie（未登录过则 undefined）。 */
export function endpointAuthCookie(ep: DshEndpoint = currentEndpoint): string | undefined {
    return authCookies.get(ep.port);
}
/** 方法别名 → wire 方法名：点号转斜杠（session.create → session/create；已含 '/' 的保持不变）。 */
export function wireMethodName(method: string): string {
    return method.includes('/') ? method : method.replace(/\./g, '/');
}
/** 请求对象 → payload：{ args:{ <形参名>: 请求对象 } }。形参名默认 request，
 *  例外见 ARGS_KEY_BY_METHOD；无参方法（session/modelCatalog）用空 args。 */
export function argsWrap(method: string, payload: unknown): unknown {
    if (NO_ARGS_METHODS.has(method)) {
        return { args: {} };
    }
    if (FLAT_ARGS_METHODS.has(method)) {
        // $events/result 的形参本身就是多个命名参数（clientId/eventId/outcome），
        // 不能再包一层 request。
        return { args: payload ?? {} };
    }
    const key = ARGS_KEY_BY_METHOD[method] ?? 'request';
    return { args: { [key]: payload ?? {} } };
}
/** 形参名与默认 request 不同的方法（键 = wire 方法名）。 */
const ARGS_KEY_BY_METHOD: Record<string, string> = {
    // session/list 的服务端签名形参名是 _request（SessionListRequest，空对象即可）
    'session/list': '_request',
};
/** 无参 remote（payload 必须为 { args: {} }）。 */
// settings/describe 与 modelCatalog 同族：远端签名无参，多包一层 request 会被网关拒
// （"Remote payload must contain exactly one plain-object args field"）。
const NO_ARGS_METHODS = new Set<string>(['session/modelCatalog', 'agentPresets/list', 'settings/describe']);
/** 平铺 args 的方法（payload 对象直接作为 args 的字段集）。
 *
 *  `goals/*` 属于这一类：它们的远端签名是**多个命名形参**
 *（`get(agentId)` / `edit(agentId, ref, request)` / `pause|resume|clear(agentId, ref)`，
 *  见 `goal/src/index.ts` 的 `@Remote` 与 `api/gateway/tests/gateway.host.spec.ts` 的
 *  `args: { agentId, request }`），**不能**再包一层 `request`
 *（网关会拒："Remote payload must contain exactly one plain-object args field"）。
 *
 * 目标条的动作与读取都经这里（宿主 `dshService.goalAction` / `goalRefOf` 的来源）。 */
const FLAT_ARGS_METHODS = new Set<string>([
    '$events/result',
    'agentPresets/select',
    'goals/get',
    'goals/edit',
    'goals/pause',
    'goals/resume',
    'goals/clear',
]);

export function hasAuthCookie(port: number): boolean {
    return authCookies.has(port);
}

export function authCookieForPort(port: number): string | undefined {
    return authCookies.get(port);
}

export async function loginEndpoint(ep: DshEndpoint): Promise<boolean> {
    return loginForEndpoint(ep);
}
