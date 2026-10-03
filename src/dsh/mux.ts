// dsh /api/remote.mux WebSocket 客户端。
import * as crypto from "node:crypto";
import * as net from "node:net";
import { getEndpoint, hasAuthCookie, authCookieForPort, loginEndpoint } from "./auth";
// ---------- /api/remote.mux WebSocket（dsh 0.1.7+ 的流载体；迷你客户端，支持自定义 Header） ----------
/** 最小 WebSocket 客户端（RFC 6455：客户端掩码、文本/关闭帧、ping→pong；无外部依赖）。 */
class MiniWebSocket {
    static async open(url: string, headers: Record<string, string>, timeoutMs: number): Promise<MiniWebSocket> {
        const u = new URL(url);
        const secure = u.protocol === 'wss:';
        const port = Number(u.port) || (secure ? 443 : 80);
        const path = `${u.pathname}${u.search}`;
        const key = crypto.randomBytes(16).toString('base64');
        return new Promise<MiniWebSocket>((resolve, reject) => {
            const socket = net.connect(port, u.hostname);
            const onError = (err: Error): void => {
                cleanup();
                reject(err);
            };
            let buffer = Buffer.alloc(0);
            const ws = new MiniWebSocket();
            const timer = setTimeout(() => {
                onError(new Error('WebSocket 握手超时'));
            }, timeoutMs);
            const cleanup = (): void => {
                clearTimeout(timer);
                socket.off('error', onError);
                socket.off('data', onData);
            };
            const onData = (chunk: Buffer): void => {
                buffer = Buffer.concat([buffer, chunk]);
                if (!ws.connected) {
                    const idx = buffer.indexOf(Buffer.from('\r\n\r\n'));
                    if (idx === -1) {
                        return;
                    }
                    const head = buffer.subarray(0, idx).toString('latin1');
                    buffer = buffer.subarray(idx + 4);
                    const lines = head.split('\r\n');
                    const status = lines[0] ?? '';
                    if (!status.includes('101')) {
                        cleanup();
                        socket.destroy();
                        reject(new Error(`WebSocket 升级失败：${status}`));
                        return;
                    }
                    ws.connected = true;
                    cleanup();
                    ws.socket = socket;
                    // 握手完成后必须重新挂 data 监听（cleanup 已移除旧的），否则收不到任何帧
                    socket.on('data', (chunk2: Buffer) => ws.ingest(chunk2));
                    socket.on('error', (e) => ws.onerror?.(e));
                    socket.on('close', () => ws.onclose?.());
                    resolve(ws);
                    if (buffer.length > 0) {
                        ws.ingest(buffer);
                    }
                    return;
                }
                ws.ingest(chunk);
            };
            socket.once('connect', () => {
                const extra = Object.keys(headers)
                    .filter((k) => headers[k])
                    .map((k) => `${k}: ${headers[k]}`)
                    .join('\r\n');
                socket.write(
                    `GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra ? extra + '\r\n' : ''}\r\n`
                );
            });
            socket.on('error', onError);
            socket.on('data', onData);
        });
    }
    private connected = false;
    private socket?: net.Socket;
    private frameBuf = Buffer.alloc(0);
    private readonly messageQueue: string[] = [];
    onmessage?: (text: string) => void;
    onclose?: () => void;
    onerror?: (err: Error) => void;
    /** 补投缓冲期（open() 返回前）到达的消息，避免首帧丢失。 */
    flushMessages(): void {
        if (this.onmessage && this.messageQueue.length > 0) {
            const q = this.messageQueue.splice(0);
            for (const m of q) {
                this.onmessage(m);
            }
        }
    }
    private ingest(chunk: Buffer): void {
        this.frameBuf = Buffer.concat([this.frameBuf, chunk]);
        for (;;) {
            const buf = this.frameBuf;
            if (buf.length < 2) {
                return;
            }
            const fin = (buf[0] & 0x80) !== 0;
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (buf.length < 4) {
                    return;
                }
                len = buf.readUInt16BE(2);
                offset = 4;
            } else if (len === 127) {
                if (buf.length < 10) {
                    return;
                }
                const hi = buf.readUInt32BE(2);
                const lo = buf.readUInt32BE(6);
                if (hi > 0 || lo > 0x7fffffff) {
                    this.fail(new Error('frame too large'));
                    return;
                }
                len = lo;
                offset = 10;
            }
            const maskKey = masked ? buf.subarray(offset, offset + 4) : undefined;
            if (maskKey) {
                offset += 4;
            }
            if (buf.length < offset + len) {
                return;
            }
            let payload = buf.subarray(offset, offset + len);
            this.frameBuf = buf.subarray(offset + len);
            if (maskKey) {
                payload = Buffer.from(payload);
                for (let i = 0; i < payload.length; i++) {
                    payload[i] ^= maskKey[i % 4];
                }
            }
            if (!fin) {
                continue; // 服务端控制帧不带分片；未收尾分片忽略
            }
            if (opcode === 0x1) {
                const text = payload.toString('utf8');
                if (this.onmessage) {
                    this.onmessage(text);
                } else {
                    this.messageQueue.push(text);
                }
            } else if (opcode === 0x8) {
                try {
                    this.socket?.end();
                } catch {
                    /* noop */
                }
                this.onclose?.();
                return;
            } else if (opcode === 0x9) {
                this.sendFrame(0xa, payload);
            }
        }
    }
    private fail(err: Error): void {
        this.onerror?.(err);
        try {
            this.socket?.destroy();
        } catch {
            /* noop */
        }
    }
    private sendFrame(opcode: number, payload: Buffer | Uint8Array): void {
        if (!this.socket) {
            return;
        }
        const data = Buffer.from(payload);
        const len = data.length;
        const mask = crypto.randomBytes(4);
        let header: Buffer;
        if (len < 126) {
            header = Buffer.from([0x80 | opcode, 0x80 | len]);
        } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 127;
            header.writeUInt32BE(0, 2);
            header.writeUInt32BE(len, 6);
        }
        const masked = Buffer.from(data);
        for (let i = 0; i < masked.length; i++) {
            masked[i] ^= mask[i % 4];
        }
        try {
            this.socket.write(Buffer.concat([header, mask, masked]));
        } catch {
            /* noop */
        }
    }
    sendText(text: string): void {
        this.sendFrame(0x1, Buffer.from(text, 'utf8'));
    }
    close(): void {
        try {
            this.sendFrame(0x8, Buffer.alloc(0));
            this.socket?.end();
        } catch {
            /* noop */
        }
    }
}
function cookieOf(port: number): string | undefined {
    return authCookieForPort(port);
}
/** 打开一个 remote.mux 逻辑流（适配 dsh 0.1.7+；endpoint 如 session/follow、workspace/follow、$events）。 */
export async function openMuxStream(
    endpoint: string,
    payload: unknown,
    handlers: {
        onItem?: (value: unknown) => void;
        onError?: (error: { code: string; message: string }) => void;
        onEnd?: () => void;
        onClose?: () => void;
        onFatal?: (err: Error) => void;
    },
    timeoutMs = 10_000
): Promise<{ cancel: () => void }> {
    const currentEp = getEndpoint();
    const port = currentEp.port;
    // WS 与 HTTP 一样需要浏览器鉴权 cookie：懒登录通常已在 unary 401 时触发，这里兜底补一次
    if (!hasAuthCookie(port) && currentEp.authUrl && currentEp.port === port) {
        await loginEndpoint(currentEp);
    }
    const cookie = cookieOf(port);
    const streamId = crypto.randomUUID();
    const ws = await MiniWebSocket.open(`ws://127.0.0.1:${port}/api/remote.mux`, cookie ? { cookie } : {}, timeoutMs);
    ws.onmessage = (text) => {
        let msg: { type?: string; streamId?: string; value?: unknown; error?: { code: string; message: string } };
        try {
            msg = JSON.parse(text) as typeof msg;
        } catch {
            return;
        }
        if (!msg || msg.streamId !== streamId) {
            return;
        }
        if (msg.type === 'item') {
            handlers.onItem?.(msg.value);
        } else if (msg.type === 'error') {
            handlers.onError?.(msg.error ?? { code: 'unknown', message: text });
            try {
                ws.close();
            } catch {
                /* noop */
            }
        } else if (msg.type === 'end') {
            handlers.onEnd?.();
            try {
                ws.close();
            } catch {
                /* noop */
            }
        }
    };
    ws.onclose = () => handlers.onClose?.();
    ws.onerror = (err) => handlers.onFatal?.(err);
    ws.flushMessages();
    ws.sendText(JSON.stringify({ type: 'open', streamId, endpoint, payload }));
    return {
        cancel: () => {
            try {
                ws.sendText(JSON.stringify({ type: 'cancel', streamId }));
            } catch {
                /* noop */
            }
            setTimeout(() => {
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
            }, 50);
        },
    };
}
