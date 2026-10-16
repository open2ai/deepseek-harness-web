// 「同一份 ~/.dsh 上已经跑着别的 dsh 宿主」的判据与文案（**纯函数，无依赖**，便于守卫直测）。
//
// 为什么要有这道门：**归属是投影** —— 每个 dsh 宿主只认自己进程内的 live 索引
//（`rememberSessionPath` 登记、`sessionIds` getter 按它过滤）⇒
// 两个宿主共用一份 `~/.dsh` 时**各看各的**：对方挂上的会话不显示、新建的会话可能先落「未分组」。
//
// ⚠️ 写回成员表是**合并**，
// 「本进程不认识」的 id **原样保留**（`index.ts:700-703`）⇒ 归属不会被抹掉，回到原宿主仍在。
//
// 插件自起 `dsh web`（随机端口）与用户自己的 DSH Desktop 并存，就是这个地基。

/**
 * 桌面应用的命令行指纹（**三平台共用一条**）：
 *   · Windows `…\DeepSeek Harness.exe`；
 *   · macOS `…/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`；
 *   · Linux `deepseek-harness`（也见 `dsh-desktop`，单独一条）。
 * 只匹配**应用名**，不匹配它加载的插件路径 —— 命中的辅助进程由调用方按 `--type=` 剔除。
 */
const DESKTOP_APP_RE = /deepseek[ _-]?harness(\.exe)?/i;

/** 一个正在跑的进程（探测的产物）。 */
export interface DshHostProcess {
    pid: number
    /** 命令行原文（诊断用；已截断）。 */
    command: string
}

/**
 * 从进程列表原文里挑出**别的** dsh 宿主。
 *
 * 判据刻意放宽到"命令行里出现 dsh / deepseek harness，且像是 web 宿主或桌面应用"：
 * 宁可多报一条（用户点「仍然启动」即可），也不要漏报 —— 漏报的代价是**静默丢工作区归属**。
 *
 * ⚠️ **必须跨平台** ：桌面应用的命令行形状三家都不同 ——
 * Windows `…\DeepSeek Harness.exe`、macOS `…/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`、
 * Linux `deepseek-harness`。原先的候选门只认 `dsh` 子串，而 **macOS 的应用路径里没有 `dsh`**，
 * 于是那条最该防的"静默丢归属"在 mac 上完全不设防。
 *
 * 支持三种列表形态（各平台/命令的实际输出）：
 *   · `tasklist` 表格式：`映像名称  PID  会话名 …`；
 *   · `ps -eo pid=,args=`：` 1234 /path/to/node …`；
 *   · `wmic process get ProcessId,CommandLine /format:list`：`CommandLine=…` 与 `ProcessId=1234` **成对分行**。
 *
 * @param listOutput - 原始输出（认不出的行直接跳过，**绝不抛**）。
 * @param selfPid - 本扩展宿主进程 pid。
 * @param ownPids - **自己人**的 pid（插件自起的 `dsh web` 子进程、以及上一次会话落盘的那个实例）。
 *   为什么不靠 `selfPid` 一条排除：子进程的 pid 与扩展宿主**必然不同**，命令行又完全长成
 *   "`bin.js web`"，于是"自己起的那份"会被报成"另一个 DSH" —— 真机表现就是
 *   「重载窗口/开第二个窗口后弹『检测到另一个 DSH 在运行』」（2026-10-14）。
 * @returns 别的 dsh 宿主（同一 pid 只算一次）。
 */
export function otherDshHosts(listOutput: string, selfPid: number, ownPids: readonly number[] = []): DshHostProcess[] {
    const out: DshHostProcess[] = [];
    const seen = new Set<number>();
    const lines = listOutput.split(/\r?\n/);
    /** 认一条候选：命令行 + pid；判据都在这一个地方。 */
    const own = new Set<number>(ownPids.filter((n) => Number.isSafeInteger(n) && n > 0));
    const consider = (command: string, pid: number): void => {
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid || own.has(pid) || seen.has(pid)) {
            return;
        }
        const lower = command.toLowerCase();
        // 候选门：命令行里有 `dsh`，**或**是三家平台各自形态的桌面应用名
        if (!lower.includes('dsh') && !DESKTOP_APP_RE.test(command)) {
            return;
        }
        // 「dsh web」（插件自起的那种）或 DSH Desktop 宿主
        const isWebHost = lower.includes('bin.js') && /\bweb\b/.test(lower);
        const isDesktopHost =
            lower.includes('dsh-desktop-host') ||
            lower.includes('dsh_desktop') ||
            /\bdsh-desktop\b/.test(lower) ||
            DESKTOP_APP_RE.test(command);
        if (!isWebHost && !isDesktopHost) {
            return;
        }
        seen.add(pid);
        out.push({ pid, command: command.trim().slice(0, 240) });
    };
    // ① wmic 的 key=value 形态：CommandLine 与 ProcessId 分行，需要一次窗口配对
    if (listOutput.includes('CommandLine=') || listOutput.includes('ProcessId=')) {
        let pendingCommand: string | undefined;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('CommandLine=')) {
                pendingCommand = line.slice('CommandLine='.length);
                continue;
            }
            if (line.startsWith('ProcessId=')) {
                const pid = Number(line.slice('ProcessId='.length).trim());
                if (pendingCommand !== undefined) {
                    consider(pendingCommand, pid);
                }
                pendingCommand = undefined;
            }
        }
        return out;
    }
    // ② 表格式 / ps 形态
    for (const raw of lines) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        // 同 `consider` 的候选门：`dsh` 或三平台各自的桌面应用名（mac/Linux 的路径里没有 `dsh`）
        if (!line.toLowerCase().includes('dsh') && !DESKTOP_APP_RE.test(line)) {
            continue;
        }
        const m = /^(?:"?[^\s"]+"?\s+)?(\d{2,7})\b/.exec(line);
        if (m === null) {
            continue;
        }
        consider(line, Number(m[1]));
    }
    return out;
}

/**
 * 「现在该不该自起一个新宿主」的判据 + 给用户看的话。
 *
 * ⚠️ 文案**只报主进程数**：DSH Desktop 是一个 Electron 应用，光渲染/GPU/工具进程就有十来条
 * （实测同一台机器上命中 11 个 pid，其中 9 个是辅助进程）。把它们全列出来只会淹掉重点，
 * 所以要认出的其实是「**有几个独立的 DSH 应用**」：桌面主进程（`DeepSeek Harness.exe` 且不带 `--type=`）
 * 与命令行里带 `bin.js web` 的 node 宿主。
 *
 * @param others - `otherDshHosts` 的结果（可以带辅助进程）。
 * @returns `confirm` 为真时**必须让用户确认**（默认取消：把选择权留在用户手里）。
 */
export function hostConflictDecision(others: readonly DshHostProcess[]): { confirm: boolean; message: string } {
    if (others.length === 0) {
        return { confirm: false, message: '' };
    }
    const isAux = (command: string): boolean => /--type=/.test(command);
    const desktop = others.filter(
        (o) => !isAux(o.command) && (DESKTOP_APP_RE.test(o.command) || /\bdsh-desktop\b/i.test(o.command))
    );
    const webHosts = others.filter((o) => /bin\.js/i.test(o.command) && !isAux(o.command));
    const parts: string[] = [];
    if (desktop.length > 0) {
        parts.push(`DSH Desktop（主进程 ${desktop.map((o) => String(o.pid)).join('、')}）`);
    }
    if (webHosts.length > 0) {
        parts.push(`dsh web 宿主（进程 ${webHosts.map((o) => String(o.pid)).join('、')}）`);
    }
    // 认不出主进程（陌生包装器）时退回逐条报 pid —— 宁可吵一点，也别把冲突说成没发生
    const what = parts.length > 0 ? parts.join(' 与 ') : `进程 ${others.map((o) => String(o.pid)).join('、')}`;
    return {
        confirm: true,
        message:
            `检测到另一个 DSH 正在运行：${what}。` +
            `两个一起跑时各自只看得到自己的会话（新会话可能落到「未分组」）。` +
            `建议关掉它，或把 dsh.port 指向它复用。`,
    };
}
