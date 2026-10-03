// 终端卡纯函数模型：variant 分类、退出状态解析、提示行标签与文案（适配上游 0.1.7-rc.2）。
// 铁律：文案与结构取字典与实现原文，不自行翻译、不编造；
// 终端卡的判定与几何（适配上游 0.1.7-rc.2）。
// host 侧另有等价解析( src/dsh/official/exit-status.ts )，二者正则保持一致。

/** 工具变体（决定行图标与卡体） */
export type ToolVariant = 'bash' | 'read' | 'search' | 'write' | 'edit' | 'code' | 'others'

const TOOL_VARIANTS: Record<string, ToolVariant> = {
  bash: 'bash', pwsh: 'bash', shell: 'bash', powershell: 'bash',
  read: 'read', read_image: 'read', readTextFile: 'read', web_fetch: 'read', webFetch: 'read',
  web_search: 'search', search: 'search', grep: 'search', glob: 'search',
  write: 'write', edit: 'edit', str_replace_editor: 'edit', apply_patch: 'edit',
  run_code: 'code', code: 'code',
}

/** 参数里可打开的路径键与适用变体（哪些工具的参数里带可打开路径）。 */
const FILE_PATH_KEYS = ['path', 'file_path'] as const
const FILE_PATH_VARIANTS = new Set<ToolVariant>(['read', 'write', 'edit'])

/**
 * 工具参数里的文件路径（收起行摘要里那个可点击的路径）。
 * 只对 read/write/edit 三个变体生效（`read_image`/`web_fetch` 归入 read 变体，前者带 path、后者只有 url）；
 * 取 `path` / `file_path` 的**首行**。解析失败或没有该字段 → undefined（不猜）。
 * @param name - wire 工具名。
 * @param argsRaw - 调用参数 JSON 串。
 * @returns 原样路径（不解析、不拼绝对路径——那由宿主按会话工作区根做）。
 */
export function filePathOf(name: string, argsRaw?: string): string | undefined {
  if (!FILE_PATH_VARIANTS.has(classifyTool(name)) || !argsRaw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const rec = parsed as Record<string, unknown>
  for (const key of FILE_PATH_KEYS) {
    const value = rec[key]
    if (typeof value === 'string' && value.trim() !== '') return value.split('\n')[0]
  }
  return undefined
}

/** 工具名 → 展示变体（未知兜底 others） */
export function classifyTool(name: string): ToolVariant {
  return TOOL_VARIANTS[name] ?? 'others'
}

/** 是否为终端命令工具（bash/pwsh/shell 归组 → 渲染 Terminal 卡） */
export function isTerminalTool(name: string): boolean {
  return classifyTool(name) === 'bash'
}

// ---- 退出状态解析（Webview 侧；marker 由 shell render 追加，非独立 JSON 字段）----
const SIGNAL_RE = /\n\[killed by signal: ([^\]\n]+)\]$/
const EXIT_RE = /\n\[exit code: (\d+)\]$/

/** 解析输出末尾的退出状态 marker，并返回剥掉 marker 的干净输出。无 marker 返回 exitCode 0。 */
export function parseExitStatus(text: string): { output: string; exitCode?: number; signal?: string } {
  const signal = SIGNAL_RE.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = EXIT_RE.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

// ---- 转义序列剥离 ----
// 覆盖面分三段（不做着色、也不重放光标，
// 只要求**控制字节不被当成正文画出来**）。漏掉一类就会留下可见残渣，且因为输出体不折行
// （`white-space: pre`），残渣会把行撑宽 → 输出区出现本不该有的横向滚动条。
// Windows 上是真会发生的：pwsh 的提示符会写 OSC 133 标记（`ESC ] 133;D;<code> BEL`），
// 只剥 CSI 的话它就以 `]133;D;0` 的样子留在输出里。
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/** OSC 串（窗口标题、超链接、shell 集成标记），带或不带终止符（BEL / ST）。 */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
/** 其它转义：字符集选择、单次移位、复位等（非 CSI）。 */
const NON_CSI_ESCAPE = /\x1b(?!\[)[\x20-\x2f]*[\x30-\x7e]?/g
/**
 * 无显示含义的 C0 控制字符。**保留 `\b`(0x08)、`\t`(0x09)、`\n`(0x0a)、`\r`(0x0d)、`ESC`(0x1b)**：
 * 前三个管布局；`\r` 上游是按「光标回行首」重放后再丢的，我们不重放，丢了会把
 * 进度条那类 `10%\r50%` 输出粘成一坨，所以原样留着。
 */
const INERT_CONTROL = /[\x00-\x07\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g

/** 剥掉 ANSI/OSC 转义与无显示含义的控制字节（顺序照上游：先 OSC，再其它非 CSI 转义）。 */
export function stripAnsi(s: string): string {
  return s
    .replace(CSI_SEQUENCE, '')
    .replace(OSC_SEQUENCE, '')
    .replace(NON_CSI_ESCAPE, '')
    .replace(INERT_CONTROL, '')
}

/** 提示行 cwd 标签（精确等于 home 折叠为 ~，否则取路径末段，无值用 $） */
export function promptLabel(cwd: string | undefined, home?: string): string {
  if (cwd === undefined || cwd === '') return '$'
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (home !== undefined && trimmed === home.replace(/[/\\]+$/, '')) return '~'
  const segment = trimmed.split(/[/\\]/).pop()
  return segment === undefined || segment === '' ? cwd : segment
}

// ---------- 工作目录解析 ----------
// 为什么需要这一组：标签要指向**命令实际运行的目录**。执行器在跑之前就把 workdir 解析掉了，
// 而模型给的 workdir 可能是相对的、还带 `.` / `..`——直接取末段会把点号当目录名
// （`workdir: ".."` 配工作区 `/w/app` 实际跑在 `/w`，标签该显示 `w` 而不是 `..`）。
// 下面三个函数按上游同名实现移植（resolveWorkspacePath / normalizeSegments / collapse），不自行发明规则。

/** 是否 Windows 风格路径（盘符或 UNC 前缀）。 */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/**
 * 两段路径是否指向同一处。**Windows 风格（盘符/UNC）不分大小写、`/` 与 `\` 等价**；
 * 其余（POSIX）按字节严格比——那里大小写是真的不同路径。
 * 为什么需要它：Windows 上同一个目录会有多种写法（`C:\Users\x` / `c:/users/x`），
 * 工具给的路径与工作区根常常写法不同，严格 `startsWith` 会判不成前缀、相对化静默失效。
 */
function samePath(a: string, b: string): boolean {
  if (!isWindowsStylePath(a) && !isWindowsStylePath(b)) return a === b
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/** 剥掉工作区根前缀（仅 `root/` 或 `root\` 前缀生效），其余原样。卡片路径与收起行摘要共用。 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (root === '' || text.length <= root.length) return text
  // 按长度切、按 samePath 判——分隔符与大小写都可以不同，切出来的偏移仍正确
  const boundary = text.charAt(root.length)
  if ((boundary === '/' || boundary === '\\') && samePath(text.slice(0, root.length), root)) {
    return text.slice(root.length + 1)
  }
  return text
}

/**
 * 工作区相对路径 → 绝对路径。
 * 已是绝对路径（`/` 开头、盘符、UNC）原样返回；无工作区根时无从解析，也原样返回。
 */
function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/') || isWindowsStylePath(path)) return path
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[/\\]+$/, '')
  const relative = path.replace(/^[/\\]+/, '')
  return `${base}/${relative}`
}

/**
 * 折叠路径里的 `.` / `..` 段。
 * 逐条规则的理由：
 *   - `.` 与空段丢弃、`..` 弹掉上一段：得到的就是执行器真正会用的目录。
 *   - **有根**（`/` 开头、盘符、UNC）时越过根的 `..` 直接丢弃——文件系统翻不上去；
 *     UNC 的 server/share 属于根的一部分，`..` 不许翻出共享（Windows 上做不到）。
 *   - **无根**（纯相对）时保留开头的 `..`：它相对一个这里看不到的 cwd 仍有意义，不能凭空抹掉。
 *   - 分隔符沿用原文：整条路径只有 `\` 没有 `/` 时按 Windows 输出 `\`，否则统一 `/`。
 *     这个值只用于显示，保持作者写法即可。
 */
function normalizeSegments(path: string): string {
  // 没有 . / .. 段就原样返回：既省掉整趟拆合，也避免改写不含点的路径写法
  if (!/(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(path)) return path
  const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/.exec(path)
  if (unc !== null) {
    const [matched, server, share] = unc
    const root = `\\\\${String(server)}\\${String(share)}`
    const rest = collapse(path.slice(matched.length), true)
    return rest === '' ? root : `${root}\\${rest}`
  }
  const backslashed = path.includes('\\') && !path.includes('/')
  const separator = backslashed ? '\\' : '/'
  const rooted = /^[/\\]/.test(path)
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  const body = collapse(path.slice(drive.length), rooted || drive !== '', separator)
  const leading = rooted ? separator : ''
  return drive === '' ? `${leading}${body}` : `${drive}${rooted ? leading : separator}${body}`
}

/** normalizeSegments 的折叠主体。rooted=true 表示这段挂在根下，越过根的 `..` 丢弃而非保留。 */
function collapse(body: string, rooted: boolean, separator = '/'): string {
  const kept: string[] = []
  for (const segment of body.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop()
      else if (!rooted) kept.push(segment)
      continue
    }
    kept.push(segment)
  }
  return kept.join(separator)
}

/**
 * 终端卡该显示的工作目录（三个分支）：
 *   调用未带 workdir → 会话工作区根；
 *   无工作区根 → 退化为只折叠 workdir；
 *   两者都有 → 先拼到工作区根下，再折叠。
 */
function resolveTerminalCwd(workdir: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (workdir === undefined || workdir === '') return sessionCwd
  if (sessionCwd === undefined || sessionCwd === '') return normalizeSegments(workdir)
  return normalizeSegments(resolveWorkspacePath(sessionCwd, workdir))
}

// ---- 展示字典（zh；文案取原文，不自造同义词）----
export interface TerminalLabels {
  signal: (s: string) => string
  exitCode: (c: number) => string
  running: string
  failed: string
  done: string
  /** 被打断/中止（上游 `row.stopped`；终端卡文案集里没有这一档，为「调用被中止也要如实显示」借的行状态词） */
  stopped: string
  copy: string
  copied: string
  noOutput: string
  collapse: string
  expand: (n: number) => string
}

export function terminalLabels(): TerminalLabels {
  return {
    signal: (s) => `信号 ${s}`,
    exitCode: (c) => `退出码 ${c}`,
    running: '运行中',
    failed: '失败',
    done: '已完成',
    stopped: '已停止',
    copy: '复制',
    copied: '复制成功',
    noOutput: '无输出',
    collapse: '收起',
    expand: (n) => `… 其余 ${n} 行`,
  }
}

// ---- 终端卡模型：从 tool item 派生（bash/pwsh/shell 且含 command 才返回，否则 null → 通用路径）----

/** 卡内运行态（与工具行的 rowState 同集合，直接取宿主判好的 tool item status）。 */
export type TermState = 'running' | 'ok' | 'error' | 'stopped'

export interface TermCard {
  /** 命令原文（多行已拆成数组，逐行成提示行） */
  command: string[]
  /** 工具描述/摘要（bash 类 description；展开头行摘要源） */
  description?: string
  /** 工作目录（args.workdir/cwd；用于提示行标签；未给 → $） */
  cwd?: string
  /** 输出（已剥 exit status marker） */
  output?: string
  exitCode?: number
  signal?: string
  running: boolean
  /**
   * 卡内运行态——状态点与运行态文案的**唯一来源**，与工具行的行状态同值。
   *
   * 为什么卡不能自己按退出码判：本插件**有意为调用失败的结果也渲染终端卡**（上游遇 isError 退回通用卡，
   * 见 terminalCardModel 注释），而「调用失败」没有退出码（spawn 失败/中止/沙箱拒绝）。只按退出码判，
   * 卡内会显示「已完成 + 绿点」，与行上的红点自相矛盾——上游 TerminalBlock 的既定约定是**行与卡不得互相打架**。
   */
  state: TermState
  /** 定稿且 exitCode!=0 或 signal（非零退出/信号终止 = 失败） */
  failed: boolean
  /** 定稿且无可见输出 */
  empty: boolean
}

interface ShellArgs {
  command?: string
  description?: string
  workdir?: string
  cwd?: string
}

function parseArgs(argsRaw?: string): ShellArgs | null {
  if (!argsRaw) return null
  try {
    const o = JSON.parse(argsRaw)
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as ShellArgs) : null
  } catch {
    return null
  }
}

/**
 * 从 tool item 派生终端卡。要求：工具变体为 bash 且 arguments 含非空 command；
 * 否则返回 null（调用方回退通用「输入 / 输出」卡，见 ToolRow）。
 *
 * 已知差异（有意为之）：上游在若干情况下会退回通用卡——调用失败、description 缺失（常驻 shell）、
 * 后台调用、结果不是恰好一个 text 块。本插件一律仍用终端卡：
 * 面板形态（状态点+命令 / 分隔线 / 输出）是本插件要的呈现。
 *
 * 代价与补偿：上游把**调用失败**（isError）的调用交给通用卡，那里用错误态色渲染输出；本插件留用终端卡后，
 * 失败态必须由卡自己表达——**退出码答不了这个问题**（spawn 失败/中止/沙箱拒绝都没有退出码），
 * 所以卡内运行态取宿主判好的 `t.status`，见 {@link TermCard.state}。
 */
export function terminalCardModel(
  t: { name: string; argsRaw?: string; output?: string; exitCode?: number; signal?: string; status: TermState },
  sessionCwd?: string,
): TermCard | null {
  if (!isTerminalTool(t.name)) return null
  const args = parseArgs(t.argsRaw)
  const command = typeof args?.command === 'string' ? args.command : ''
  if (command.trim() === '') return null
  // 相对 workdir 拼到会话工作区根下再折叠 `.`/`..`；
  // 不带 workdir 时直接用工作区根（工具调用通常不带，缺了就只能显示 $）
  const rawWorkdir = typeof args?.workdir === 'string' ? args.workdir : typeof args?.cwd === 'string' ? args.cwd : undefined
  const workdir = resolveTerminalCwd(rawWorkdir, sessionCwd || undefined)
  const running = t.status === 'running'
  // 宿主已剥 marker 则直接用；否则兜底解析（同一正则，结果一致）
  const parsed = parseExitStatus(t.output ?? '')
  const output = parsed.output
  const exitCode = t.exitCode !== undefined ? t.exitCode : parsed.exitCode
  const signal = t.signal !== undefined ? t.signal : parsed.signal
  const failed = !running && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined)
  const empty = !running && output.trim() === ''
  // 运行态（卡内点与文案）：调用自身失败/被打断优先于退出码——那类结果没有退出码，
  // 只按 failed 判会显示成「已完成」。仅在调用判为 ok 时才用 failed 覆盖成 error，
  // 与上游 GenericToolCard 的 `state === 'ok' && terminalFailed(...) ? 'error' : state` 同序。
  const state: TermState =
    t.status === 'running' ? 'running' : t.status === 'ok' && failed ? 'error' : t.status
  return {
    command: command.split('\n'),
    description: typeof args?.description === 'string' ? args.description : undefined,
    cwd: workdir,
    output,
    exitCode,
    signal,
    running,
    state,
    failed,
    empty,
  }
}
