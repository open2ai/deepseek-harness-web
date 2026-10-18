// 终端命令退出状态解析：从 tool/result 输出文本末尾的 marker 提取退出码/终止信号。
// marker 由 shell render 追加在输出末尾，不是独立的 JSON 字段。
// 宿主/线程层用（stream.ts、session.ts 在截断输出前调用）；webview 侧另有一份等价实现（core/terminal.ts）。
const SIGNAL_RE = /\n\[killed by signal: ([^\]\n]+)\]$/;
// `null` = 有结果但没有可用退出码（进程被外部回收等）。它**不是 0**。
const EXIT_RE = /\n\[exit code: (\d+|null)\]$/;

/**
 * 解析输出末尾的退出状态 marker，并返回剥掉 marker 的干净输出。
 * 无 marker（持续 shell/后台任务/正常无需标记）返回 exitCode 0。
 */
export function parseExitStatus(text: string): { output: string; exitCode?: number | null; signal?: string } {
    const signal = SIGNAL_RE.exec(text);
    if (signal?.[1] !== undefined) {
        return { output: text.slice(0, signal.index), signal: signal[1] };
    }
    const exit = EXIT_RE.exec(text);
    if (exit?.[1] !== undefined) {
        return { output: text.slice(0, exit.index), exitCode: exit[1] === 'null' ? null : Number(exit[1]) };
    }
    return { output: text, exitCode: 0 };
}
