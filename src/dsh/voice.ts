// 宿主侧录音（语音输入）：**在 VS Code webview 里拿不到麦克风**（Electron 权限处理器与
// iframe 的 Permissions Policy 都不给 webview `media`/`microphone`，见 design/12 的登记），
// 所以录音放在宿主进程，按平台走系统自带/常见工具：
//   · Windows：winmm MCI（系统自带，零第三方依赖）录 WAV；
//   · macOS：ffmpeg + avfoundation（`brew install ffmpeg`）录裸 PCM；
//   · Linux：优先 arecord（alsa-utils，发行版常见），否则 ffmpeg + pulse 录裸 PCM。
// 裸 PCM（s16le / 16 kHz / 单声道）"截断也有效"——进程停掉时已写出的字节就是有效音频，
// 由 `wrapPcm16` 补一个 44 字节 WAV 头；比"等录音工具自己收尾写头"稳。
//
// 生命周期：`start` → `stop`（返回录音）/ `cancel`（丢弃）；都会清掉临时目录。
// 时长上限由服务端 `speech/catalog.maxDurationSeconds` 换算（到点自停），宿主另有超时 kill。
import { execFileSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { toCanonicalWave, wrapPcm16 } from "./wav";

/** 一次录音的产物（base64 不带 data URL 前缀；与上游 `TranscriptionRequest.audioBase64` 同形）。 */
export interface VoiceCapture {
    audioBase64: string;
    audioSeconds: number;
}

/** 录音实现：Windows 走 MCI（工具写 WAV），其它平台走进程录裸 PCM（宿主补头）。 */
type CaptureKind = "mci" | "raw";

/** Windows 录音脚本：用 winmm MCI 开默认录音设备，落到 WAV；`READY` 一行表示已经开始录。 */
const RECORD_SCRIPT = String.raw`
param(
    [Parameter(Mandatory=$true)][string]$Out,
    [Parameter(Mandatory=$true)][string]$Stop,
    [int]$MaxMs = 120000
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshMci {
    [DllImport("winmm.dll", CharSet = CharSet.Auto)]
    public static extern int mciSendString(string command, StringBuilder buffer, int bufferSize, IntPtr hwndCallback);
}
"@
function Invoke-Mci([string]$Command, [switch]$Tolerate) {
    $buffer = New-Object System.Text.StringBuilder 1024
    $result = [DshMci]::mciSendString($Command, $buffer, 1024, [IntPtr]::Zero)
    if ($result -ne 0) {
        if ($Tolerate) { return $false }
        throw "mci error $result for '$Command'"
    }
    return $true
}
$opened = $false
try {
    Invoke-Mci 'open new type waveaudio alias dshrec' | Out-Null
    $opened = $true
    # 设备可能不接受指定格式：容忍失败，宿主侧会按落盘文件归一化
    Invoke-Mci 'set dshrec time format ms bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2' -Tolerate | Out-Null
    Invoke-Mci 'record dshrec' | Out-Null
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    $started = Get-Date
    while (-not (Test-Path -LiteralPath $Stop)) {
        Start-Sleep -Milliseconds 60
        if (((Get-Date) - $started).TotalMilliseconds -ge $MaxMs) { break }
    }
    Invoke-Mci 'stop dshrec' | Out-Null
    Invoke-Mci ('save dshrec "' + $Out + '"') | Out-Null
    Invoke-Mci 'close dshrec' | Out-Null
    $opened = $false
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($opened) { try { Invoke-Mci 'close dshrec' -Tolerate | Out-Null } catch { } }
    exit 1
}
`;

/** 本机是否有这个命令（`which` / `where`）。 */
function hasCommand(command: string): boolean {
    try {
        execFileSync(process.platform === "win32" ? "where" : "which", [command], {
            stdio: "ignore",
            windowsHide: true,
        });
        return true;
    } catch {
        return false;
    }
}

/** 等子进程退出；超时则 kill（返回时进程一般已退出）。 */
async function settle(child: ChildProcess, timeoutMs: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            try {
                child.kill(signal);
            } catch {
                // 已经退出
            }
            resolve();
        }, timeoutMs);
        child.once("exit", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/** 等裸 PCM 文件出现非空内容（工具起麦是异步的；没有数据/进程先退 = 启动失败）。 */
async function waitRawData(child: ChildProcess, rawPath: string, stderrOf: () => string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
            if (fs.statSync(rawPath).size > 0) {
                return;
            }
        } catch {
            // 还没建文件
        }
        if (child.exitCode !== null || child.signalCode !== null) {
            const stderr = stderrOf().trim();
            throw new Error(stderr !== "" ? `录音启动失败：${stderr}` : "录音启动失败（没有可用的麦克风或设备被占用）");
        }
        if (Date.now() > deadline) {
            throw new Error("录音启动超时（没有采集到音频数据）");
        }
    }
}

/**
 * 一个录音会话（同一时刻只有一个）。
 *
 * 平台策略见文件头；对方平台缺工具时给出**可执行**的提示（brew/apt 安装），而不是一句"暂不支持"。
 */
export class VoiceRecorder {
    private child: ChildProcess | undefined;
    private kind: CaptureKind | undefined;
    private dir: string | undefined;
    private audioPath: string | undefined;
    private stopPath: string | undefined;
    private stderr = "";
    /** 记录中（`start` 成功后到 `stop`/`cancel` 前）。 */
    private active = false;
    private stopping = false;

    /** 是否正在录音。 */
    isActive(): boolean {
        return this.active;
    }

    /**
     * 开始一次录音。
     *
     * @param maxDurationMs - 最长录音时长（由服务端 `speech/catalog.maxDurationSeconds` 换算；到点自停）
     */
    async start(maxDurationMs: number): Promise<void> {
        if (this.active) {
            await this.cancel();
        }
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-voice-"));
        this.dir = dir;
        this.stderr = "";
        const maxMs = Math.max(1000, Math.round(maxDurationMs));
        if (process.platform === "win32") {
            await this.startMci(dir, maxMs);
        } else {
            await this.startRaw(dir, maxMs);
        }
    }

    /**
     * 结束录音并返回规范 WAV（16 kHz / 单声道 / 16-bit PCM，base64）。
     *
     * @returns base64（无 data URL 前缀）与音频时长（秒）
     */
    async stop(): Promise<VoiceCapture> {
        if (!this.active || this.child === undefined || this.audioPath === undefined || this.dir === undefined) {
            throw new Error("当前没有在录音");
        }
        if (this.stopping) {
            throw new Error("正在结束上一次录音");
        }
        this.stopping = true;
        try {
            return this.kind === "mci" ? await this.stopMci() : await this.stopRaw();
        } finally {
            this.active = false;
            this.stopping = false;
            const child = this.child;
            if (child !== undefined) {
                child.kill();
            }
            await this.cleanup();
        }
    }

    /** 取消录音并清掉临时文件（不返回音频）。 */
    async cancel(): Promise<void> {
        const child = this.child;
        const stopPath = this.stopPath;
        try {
            if (child !== undefined) {
                if (stopPath !== undefined) {
                    await fs.promises.writeFile(stopPath, "").catch(() => undefined);
                }
                await settle(child, 3000);
                child.kill();
            }
        } finally {
            this.active = false;
            await this.cleanup();
        }
    }

    /** Windows：PowerShell + MCI 录 WAV；`READY` 一行表示 record 已发出。 */
    private async startMci(dir: string, maxMs: number): Promise<void> {
        this.kind = "mci";
        this.audioPath = path.join(dir, "recording.wav");
        this.stopPath = path.join(dir, "stop.flag");
        const scriptPath = path.join(dir, "record.ps1");
        await fs.promises.writeFile(scriptPath, RECORD_SCRIPT, "utf8");
        const args = [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-Out",
            this.audioPath,
            "-Stop",
            this.stopPath,
            "-MaxMs",
            String(maxMs),
        ];
        const child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        this.child = child;
        child.stderr?.on("data", (chunk: Buffer) => {
            this.stderr += chunk.toString("utf8");
        });
        const ready = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 4000);
            let buffer = "";
            child.stdout?.on("data", (chunk: Buffer) => {
                buffer += chunk.toString("utf8");
                if (buffer.includes("READY")) {
                    clearTimeout(timer);
                    resolve(true);
                }
            });
            child.once("exit", () => {
                clearTimeout(timer);
                resolve(false);
            });
        });
        if (!ready) {
            await settle(child, 2000);
            const stderr = this.stderr.trim();
            await this.cleanup();
            throw new Error(stderr !== "" ? `录音启动失败：${stderr}` : "录音启动失败（没有可用的麦克风或设备被占用）");
        }
        this.active = true;
    }

    /** Windows：写 stop 标记 → 脚本收尾保存 → 读 WAV → 归一化。 */
    private async stopMci(): Promise<VoiceCapture> {
        const child = this.child as ChildProcess;
        const wavPath = this.audioPath as string;
        await fs.promises.writeFile(this.stopPath ?? "", "");
        await settle(child, 12_000);
        const raw = await fs.promises.readFile(wavPath);
        if (raw.length <= 44) {
            throw new Error("录音为空（没有采集到声音）");
        }
        const canonical = toCanonicalWave(new Uint8Array(raw));
        return { audioBase64: Buffer.from(canonical.wav).toString("base64"), audioSeconds: canonical.seconds };
    }

    /** macOS / Linux：ffmpeg 或 arecord 录裸 s16le PCM（16 kHz 单声道）。 */
    private async startRaw(dir: string, maxMs: number): Promise<void> {
        this.kind = "raw";
        this.audioPath = path.join(dir, "recording.pcm");
        const rawPath = this.audioPath;
        const seconds = String(Math.max(1, Math.ceil(maxMs / 1000)));
        let cmd: string;
        let args: string[];
        if (process.platform === "darwin") {
            if (!hasCommand("ffmpeg")) {
                await this.cleanup();
                throw new Error("macOS 录音需要 ffmpeg：请先运行 `brew install ffmpeg` 再试");
            }
            cmd = "ffmpeg";
            args = [
                "-hide_banner", "-loglevel", "error",
                "-f", "avfoundation", "-i", ":0",
                "-ar", "16000", "-ac", "1",
                "-f", "s16le", "-t", seconds, "-y", rawPath,
            ];
        } else if (hasCommand("arecord")) {
            cmd = "arecord";
            args = ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-d", seconds, rawPath];
        } else if (hasCommand("ffmpeg")) {
            cmd = "ffmpeg";
            args = [
                "-hide_banner", "-loglevel", "error",
                "-f", "pulse", "-i", "default",
                "-ar", "16000", "-ac", "1",
                "-f", "s16le", "-t", seconds, "-y", rawPath,
            ];
        } else {
            await this.cleanup();
            throw new Error("Linux 录音需要 arecord（alsa-utils）或 ffmpeg：请先安装其中一个再试");
        }
        const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        this.child = child;
        child.stderr?.on("data", (chunk: Buffer) => {
            this.stderr += chunk.toString("utf8");
        });
        try {
            await waitRawData(child, rawPath, () => this.stderr);
        } catch (e) {
            await settle(child, 2000);
            await this.cleanup();
            throw e;
        }
        this.active = true;
    }

    /** macOS / Linux：停掉进程 → 读已写出的裸 PCM → 补 WAV 头。 */
    private async stopRaw(): Promise<VoiceCapture> {
        const child = this.child as ChildProcess;
        const rawPath = this.audioPath as string;
        // SIGINT 让 ffmpeg/arecord 尽量收尾；等不到就 SIGKILL。裸 PCM 截断不影响有效性。
        try {
            child.kill("SIGINT");
        } catch {
            // 已经退出
        }
        await settle(child, 4000);
        const raw = await fs.promises.readFile(rawPath).catch(() => Buffer.alloc(0));
        // 16-bit 单声道：奇数尾字节丢掉
        const even = raw.subarray(0, raw.length - (raw.length % 2));
        if (even.length < 3200) {
            throw new Error("录音为空（没有采集到声音）");
        }
        const wav = wrapPcm16(new Uint8Array(even));
        return { audioBase64: Buffer.from(wav).toString("base64"), audioSeconds: even.length / 2 / 16000 };
    }

    /** 释放临时目录与子进程引用。 */
    private async cleanup(): Promise<void> {
        const dir = this.dir;
        this.child = undefined;
        this.kind = undefined;
        this.dir = undefined;
        this.audioPath = undefined;
        this.stopPath = undefined;
        this.stderr = "";
        if (dir !== undefined) {
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
