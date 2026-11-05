// WAV 归一化：宿主录到的音频统一转成上游 `speech.transcribe` 要求的**规范形状** ——
// 16 kHz / 单声道 / 16-bit PCM WAV（见 `dsh` 的 `api-speech-to-text`：base64 PCM16 WAV，
// 服务端用 `validateWave` 校验采样率/声道/位深与时长）。
//
// 为什么要在这一层转：MCI（Windows 默认录音通道）不一定按请求的格式落盘 —— `set` 命令
// 对某些声卡会被忽略，实际得到 44.1/48 kHz 立体声。服务端只收规范 WAV，所以**以落盘文件为准**：
// 解析 fmt/data → 混单声道 → 重采样到 16 kHz → 重新封装 44 字节头。
//
// 纯函数、无 Node/浏览器 API 依赖（Buffer 只在调用方转 base64），可直接被守卫单测。
/** 解析出来的 PCM 采样：单声道 Float32（[-1, 1]）。 */
export interface DecodedWave {
    /** 采样率（原始文件） */
    sampleRate: number
    /** 单声道 Float32 采样 */
    samples: Float32Array
    /** 原始时长（秒） */
    seconds: number
}

const RIFF_HEADER_BYTES = 44;
/** 上游 `validateWave` 的采样率：只收 16 kHz。 */
const CANONICAL_SAMPLE_RATE = 16_000;

/** 读 32-bit little-endian。 */
function u32(view: DataView, at: number): number {
    return view.getUint32(at, true);
}

/** 读 16-bit little-endian。 */
function u16(view: DataView, at: number): number {
    return view.getUint16(at, true);
}

/**
 * 解析一段 WAV 的 PCM 采样（支持 8/16/24/32-bit 整数与 32/64-bit float PCM）。
 *
 * @param bytes - WAV 文件字节。
 * @returns 单声道 Float32 采样与原始采样率；形状不对（非 RIFF/WAVE、缺 fmt/data、未知编码）抛错。
 */
export function decodeWave(bytes: Uint8Array): DecodedWave {
    if (bytes.length < RIFF_HEADER_BYTES) {
        throw new Error('录音文件太短（不是有效的 WAV）');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (at: number, text: string): boolean => {
        for (let i = 0; i < text.length; i += 1) {
            if (bytes[at + i] !== text.charCodeAt(i)) return false;
        }
        return true;
    };
    if (!tag(0, 'RIFF') || !tag(8, 'WAVE')) {
        throw new Error('录音不是 WAV 文件');
    }
    let format: number | undefined;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let bitsPerSample: number | undefined;
    let blockAlign: number | undefined;
    let dataOffset: number | undefined;
    let dataLength: number | undefined;
    let at = 12;
    while (at + 8 <= bytes.length) {
        const id = String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
        const size = u32(view, at + 4);
        const body = at + 8;
        if (id === 'fmt ' && body + 16 <= bytes.length) {
            format = u16(view, body);
            channels = u16(view, body + 2);
            sampleRate = u32(view, body + 4);
            blockAlign = u16(view, body + 12);
            bitsPerSample = u16(view, body + 14);
            // WAVE_FORMAT_EXTENSIBLE：子格式 GUID 前两字节在 +24（PCM=1 / IEEE_FLOAT=3）
            if (format === 0xfffe && body + 26 <= bytes.length) {
                format = u16(view, body + 24);
            }
        } else if (id === 'data') {
            dataOffset = body;
            dataLength = size;
            break;
        }
        at = body + size + (size % 2);
    }
    if (format === undefined || channels === undefined || sampleRate === undefined
        || bitsPerSample === undefined || blockAlign === undefined || dataOffset === undefined) {
        throw new Error('录音缺少 fmt/data 块');
    }
    const length = Math.min(dataLength ?? 0, bytes.length - dataOffset);
    if (length <= 0) {
        throw new Error('录音为空');
    }
    const frames = Math.floor(length / blockAlign);
    if (frames <= 0 || channels <= 0) {
        throw new Error('录音为空');
    }
    const mono = new Float32Array(frames);
    const readSample = (base: number): number => {
        if (format === 3) {
            if (bitsPerSample === 32) return view.getFloat32(base, true);
            if (bitsPerSample === 64) return view.getFloat64(base, true);
            throw new Error(`不支持录音的浮点位深：${bitsPerSample}`);
        }
        if (format !== 1) {
            throw new Error(`不支持录音的编码：${format}（只支持 PCM / 浮点）`);
        }
        if (bitsPerSample === 8) return (view.getUint8(base) - 128) / 128;
        if (bitsPerSample === 16) return view.getInt16(base, true) / 32768;
        if (bitsPerSample === 24) {
            const v = view.getUint8(base) | (view.getUint8(base + 1) << 8) | (view.getInt8(base + 2) << 16);
            return v / 8388608;
        }
        if (bitsPerSample === 32) return view.getInt32(base, true) / 2147483648;
        throw new Error(`不支持录音的位深：${bitsPerSample}`);
    };
    const bytesPerSample = bitsPerSample / 8;
    for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch += 1) {
            sum += readSample(dataOffset + frame * blockAlign + ch * bytesPerSample);
        }
        mono[frame] = sum / channels;
    }
    return { sampleRate, samples: mono, seconds: frames / sampleRate };
}

/** 线性插值重采样（录音场景 44.1/48k → 16k 足够；不引入第三方 DSP）。 */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
    if (from === to || samples.length === 0) {
        return samples;
    }
    const ratio = from / to;
    const frames = Math.max(1, Math.floor(samples.length / ratio));
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
        const at = i * ratio;
        const left = Math.floor(at);
        const frac = at - left;
        const a = samples[left] ?? 0;
        const b = samples[Math.min(samples.length - 1, left + 1)] ?? a;
        out[i] = a + (b - a) * frac;
    }
    return out;
}

/**
 * 把任意 PCM WAV 转成上游要求的规范 WAV：16 kHz / 单声道 / 16-bit PCM。
 *
 * @param bytes - 原始 WAV 字节。
 * @returns 规范 WAV 字节与时长（秒）。
 */
export function toCanonicalWave(bytes: Uint8Array): { wav: Uint8Array; seconds: number } {
    const decoded = decodeWave(bytes);
    const samples = resample(decoded.samples, decoded.sampleRate, CANONICAL_SAMPLE_RATE);
    const seconds = samples.length / CANONICAL_SAMPLE_RATE;
    const out = new Uint8Array(RIFF_HEADER_BYTES + samples.length * 2);
    const view = new DataView(out.buffer);
    const text = (at: number, value: string): void => {
        for (let i = 0; i < value.length; i += 1) out[at + i] = value.charCodeAt(i);
    };
    text(0, 'RIFF');
    view.setUint32(4, out.length - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, CANONICAL_SAMPLE_RATE, true);
    view.setUint32(28, CANONICAL_SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
        view.setInt16(RIFF_HEADER_BYTES + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    return { wav: out, seconds };
}

/**
 * 给**裸 PCM16 字节**补一个规范 WAV 头（16 kHz / 单声道 / 16-bit）。
 *
 * macOS/Linux 的录音工具按裸 `s16le` 落盘（见宿主录音实现）：进程被停掉时已经写出的字节就是
 * 有效音频，只是没有 RIFF 头 —— 这里补头比"等工具自己收尾"可靠得多（SIGKILL 后工具不会再写头）。
 *
 * @param pcm - 裸 PCM16 little-endian 字节（长度应为偶数；奇数尾字节由调用方丢掉）。
 * @returns 完整 WAV 字节。
 */
export function wrapPcm16(pcm: Uint8Array): Uint8Array {
    const data = pcm.length - (pcm.length % 2);
    const out = new Uint8Array(RIFF_HEADER_BYTES + data);
    const view = new DataView(out.buffer);
    const text = (at: number, value: string): void => {
        for (let i = 0; i < value.length; i += 1) out[at + i] = value.charCodeAt(i);
    };
    text(0, 'RIFF');
    view.setUint32(4, out.length - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, CANONICAL_SAMPLE_RATE, true);
    view.setUint32(28, CANONICAL_SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, data, true);
    out.set(pcm.subarray(0, data), RIFF_HEADER_BYTES);
    return out;
}
