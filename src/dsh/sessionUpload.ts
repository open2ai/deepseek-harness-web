// dsh 文件上送（原始字节上传）。适配上游 dsh 0.1.7+ 的 `POST /api/session/uploadFileBinary`：
//   - 它不是 RPC 信封：body 是**原始字节流**，`content-type` 必须 `application/octet-stream`；
//   - query 带 `sessionId`（必填）与 `name`（可选显示名）；
//   - 通过校验后一律 **HTTP 200**：成功 `{ok:true,value:{receiptId,file}}`；
//     **业务失败也在 200**（`{ok:false,error:{code,message,details}}`）——不能只看状态码。
// 拿到 `receiptId` 后，随 prompt 的 content 发 `{type:'file',receiptId}`；上游在成功投递后即 retire 该凭据，
// 所以**发出后本地必须丢弃**（见 webview 的输入区暂存态）。
import * as fs from 'node:fs';
import * as http from 'node:http';
import { ensureEndpointAuth, authCookieForPort, getEndpoint } from './auth';

/** 上传成功后的返回（`file` 是内容寻址的只读副本引用）。 */
export interface UploadedSessionFile {
    receiptId: string;
    file: { attachmentId?: string; name?: string; bytes?: number };
}

const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * 把本地文件作为附件上传给当前会话（供 prompt 里的 `{type:'file',receiptId}` 引用）。
 *
 * 只管传输与错误整形，不碰业务：文件不存在、读失败、HTTP 非 200、`ok:false` 都抛 Error（文案含上游错误码）。
 * @param sessionId - 目标会话（凭据绑定会话，跨会话/子代理都查不到）。
 * @param filePath - 本地文件绝对路径（webview 只给路径，字节由宿主读）。
 * @param name - 显示名；缺省用文件名。
 * @returns 凭据与文件引用。
 */
export async function uploadSessionFile(sessionId: string, filePath: string, name?: string): Promise<UploadedSessionFile> {
    const ep = getEndpoint();
    // 有请求体的请求不可重放（body 只能消费一次），所以**先**确保登录态，不指望 401 重试
    await ensureEndpointAuth(ep);
    let data: Buffer;
    try {
        data = await fs.promises.readFile(filePath);
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`无法读取要上传的文件（${filePath}）：${reason}`);
    }
    const displayName = name ?? filePath.split(/[\\/]/).pop() ?? 'file';
    const query = `sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(displayName)}`;
    const cookie = authCookieForPort(ep.port);

    return new Promise<UploadedSessionFile>((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: ep.port,
                path: `/api/session/uploadFileBinary?${query}`,
                method: 'POST',
                headers: Object.assign(
                    {
                        'content-type': 'application/octet-stream',
                        'content-length': String(data.byteLength),
                        host: `127.0.0.1:${ep.port}`,
                    },
                    cookie ? { cookie } : {}
                ),
                timeout: UPLOAD_TIMEOUT_MS,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode !== 200) {
                        reject(new Error(`文件上传失败：HTTP ${res.statusCode}${text ? ' ' + text.slice(0, 200) : ''}`));
                        return;
                    }
                    let parsed: { ok?: boolean; value?: UploadedSessionFile; error?: { code?: string; message?: string } };
                    try {
                        parsed = JSON.parse(text) as typeof parsed;
                    } catch {
                        reject(new Error('文件上传失败：服务返回了非 JSON 内容'));
                        return;
                    }
                    if (parsed.ok !== true || parsed.value?.receiptId === undefined) {
                        const code = parsed.error?.code ?? 'unknown';
                        const message = parsed.error?.message ?? '上传未被接受';
                        reject(new Error(`文件上传失败（${code}）：${message}`));
                        return;
                    }
                    resolve(parsed.value);
                });
                res.on('error', (err) => reject(new Error(`文件上传连接中断：${err.message}`)));
            }
        );
        req.on('error', (err) => reject(new Error(`无法连接 DSH 服务（127.0.0.1:${ep.port}）：${err.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('文件上传请求超时'));
        });
        req.end(data);
    });
}
