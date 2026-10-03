// 展示层纯函数(无状态/DOM):工具名中文化、消息统计与底部统计条文案。
// 与旧 chat.ts 逻辑一致,供组件与 store 复用。

/** turn/end 终止状态角标：直接回显上游 reason.kind 原值（completed 或无值返回空）。与 src/dsh/session.ts 一致。 */
export function turnStatusBadge(kind: string | undefined): string {
  return kind && kind !== 'completed' ? kind : ''
}

/** 零填充两位数 */
const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 消息时钟（中文模板）：
 * 同日 → HH:mm；今年更早 → M月D日 HH:mm；更早年份 → Y年M月D日 HH:mm。
 * 无值返回 ''。t 为 dsh 事件/快照自带 epoch（秒或毫秒，由上游给出）。
 */
export function formatMsgClock(t: number | undefined | null): string {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
    return ''
  }
  const ms = t > 1e12 ? t : t * 1000
  const d = new Date(ms)
  const n = new Date()
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return clock
  }
  const sameYear = d.getFullYear() === n.getFullYear()
  const date = sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  return `${date} ${clock}`
}

/** 工具名 → 友好中文 */
export function friendlyToolName(name: string): string {
  const map: Record<string, string> = {
    bash: '执行命令',
    pwsh: '执行命令',
    shell: '执行命令',
    powershell: '执行命令',
    glob: '查找文件',
    read: '读取文件',
    readTextFile: '读取文件',
    think: '思考',
    findings: '分析',
    grep: '搜索',
    search: '搜索',
    write: '写文件',
    edit: '编辑文件',
    str_replace_editor: '编辑文件',
    apply_patch: '应用补丁',
  }
  return map[name] ?? name
}

/**
 * 工具友好名 → codicon 图标类名（无 codicon- 前缀）。steps[].tools 存的是友好名，故按友好名映射；
 * bash/pwsh/shell 已被 friendlyToolName 并成"执行命令"，壳细分在下游丢失，此处接受。未知原名兜底 wrench。
 */
export function toolIcon(friendly: string): string {
  const map: Record<string, string> = {
    执行命令: 'terminal', // bash / pwsh / shell / powershell
    读取文件: 'file-text', // read / readTextFile
    写文件: 'save', // write
    编辑文件: 'edit', // edit / str_replace_editor
    应用补丁: 'diff-added', // apply_patch
    查找文件: 'files', // glob
    搜索: 'search', // grep / search
    思考: 'lightbulb', // think
    分析: 'graph-line', // findings
  }
  return map[friendly] ?? 'wrench'
}

/**
 * raw 工具名 → 展示标题（中文观感：Pwsh / 网页获取 / 搜索…）。
 * 标题是 UI 层文案，不是模型吐出。无专属标题的工具一律用通用标题「工具调用」，
 * 真实工具名改由摘要承载（见 deriveToolSummary）。
 */
const TOOL_TITLES: Record<string, string> = {
  bash: 'Bash',
  pwsh: 'Pwsh',
  powershell: 'PowerShell',
  shell: 'Shell',
  read: '读取',
  read_image: '读取图片',
  readTextFile: '读取',
  write: '写入',
  edit: '编辑',
  str_replace_editor: '编辑',
  apply_patch: '应用补丁',
  glob: '查找文件',
  grep: 'Grep',
  search: '网页搜索',
  web_search: '网页搜索',
  web_fetch: '网页获取',
  webFetch: '网页获取',
  think: '思考',
  findings: '分析',
  plan: 'plan',
  subagent: 'subagent',
  ask_user_question: '提问',
  todo_write: '更新任务清单',
  present: '交付文件',
}

/** 无专属标题的工具统一用「工具调用」。 */
const GENERIC_TOOL_TITLE = '工具调用'

/**
 * `file:` URI → 本地路径（拖拽给的 `text/uri-list` 是 URI，不是路径）。
 * 三种写法：`file:///C:/x` → `C:/x`（**去掉 URI 带出来的前导斜杠**）、`file://server/share/x` → `\\server\share\x`、
 * `file:///home/x` → `/home/x`。识别不出返回 undefined（不猜）。
 */
export function fileUriToPath(uri: string): string | undefined {
  const raw = uri.trim()
  if (!raw.startsWith('file:')) return undefined
  let rest = raw.slice('file:'.length)
  if (rest.startsWith('//')) {
    rest = rest.slice(2)
    const slash = rest.indexOf('/')
    const host = slash === -1 ? rest : rest.slice(0, slash)
    const pathPart = slash === -1 ? '' : rest.slice(slash)
    if (host !== '' && host.toLowerCase() !== 'localhost') {
      return '\\\\' + host + pathPart.replace(/\//g, '\\')
    }
    rest = pathPart
  }
  let decoded = rest
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    /* 保留原样 */
  }
  const drive = /^\/([A-Za-z]:[\\/].*)$/.exec(decoded)
  return drive === null ? decoded : drive[1]
}

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? GENERIC_TOOL_TITLE
}

/** raw 工具名 → 展示图标 codicon（无 codicon- 前缀；按上游 variant 归类，未知兜底 wrench）。 */
export function toolIconOfTool(name: string): string {
  const map: Record<string, string> = {
    bash: 'terminal',
    pwsh: 'terminal',
    shell: 'terminal',
    powershell: 'terminal',
    read: 'file-text',
    read_image: 'file-text',
    readTextFile: 'file-text',
    write: 'save',
    edit: 'edit',
    str_replace_editor: 'edit',
    apply_patch: 'diff-added',
    glob: 'files',
    grep: 'search',
    search: 'search',
    web_search: 'search',
    web_fetch: 'globe',
    webFetch: 'globe',
    think: 'lightbulb',
    findings: 'graph-line',
    plan: 'list-unordered',
    ask_user_question: 'question',
    todo_write: 'checklist',
  }
  return map[name] ?? 'wrench'
}

/** 工具调用原始参数(JSON 串) → 摘要一行（偏好键：
 *  bash 类取 description/command；read/web_fetch 类取 path/file_path/url；search 类取 query/pattern。
 *  取首个命中字符串的首行，超长截断）。无/解析失败返回 ''。 */
export function deriveToolSummary(argsRaw: string | undefined, name?: string): string {
  if (!argsRaw) return ''
  const lower = (name ?? '').toLowerCase()
  let obj: unknown
  try {
    obj = JSON.parse(argsRaw)
  } catch {
    // 参数还在流式（截断）或坏形：交付文件这一行按上游**原样显示原始串**，其余保持空摘要
    return lower === 'present' ? clipLine(firstLine(argsRaw)) : ''
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ''
  const rec = obj as Record<string, unknown>
  const isCmd = lower === 'bash' || lower === 'pwsh' || lower === 'powershell' || lower === 'shell' || lower === 'python' || lower === 'code' || lower.endsWith('exec')
  const isRead = lower === 'read' || lower === 'read_image' || lower === 'readtextfile' || lower.includes('fetch') || lower.includes('http')
  const isSearch = lower === 'web_search' || lower === 'search' || lower === 'grep' || lower === 'glob'
  // 文件写入/编辑是独立变体（摘要取路径、**不加「工具名 · 」前缀**）；漏了这行它们会被当成 others 加前缀
  const isWrite = lower === 'write' || lower === 'edit' || lower === 'str_replace_editor' || lower === 'apply_patch'
  // 任务清单：摘要不是"某个字符串字段"，而是从整表里算出的计数 + 当前项（见 todoSummary）
  if (lower === 'todo_write') {
    return todoSummary(rec)
  }
  // 交付文件（`present`）：摘要 = 声明的那几个文件路径，原样列出、用 `, ` 连接（与上游同）。
  // 状态词由交付文件行自己给（行里是「状态词 + 路径」两段，见 present-card），这里只出路径串；
  // 参数流式截断/坏形时原样显示原始串。
  if (lower === 'present') {
    return presentSummary(rec, argsRaw)
  }
  if (!isCmd && !isRead && !isSearch && !isWrite) {
    // 无专属标题的工具：无偏好键，取首个非空字符串值，再兜底原始参数首行；
    // 摘要带「工具名 · 」前缀（真实工具名由摘要承载，标题统一是「工具调用」）
    const base = firstStringLine(rec) ?? clipLine(firstLine(argsRaw))
    if (base === '') return ''
    return name ? clipLine(`${name} · ${base}`) : base
  }
  const keys = isCmd
    ? ['description', 'command', 'cmd', 'code', 'script']
    : isWrite
      ? ['path', 'file_path'] // 文件写入/编辑：摘要即文件路径
      : isSearch
        ? ['query', 'pattern', 'url'] // 搜索类偏好键
        : ['path', 'file_path', 'filepath', 'url', 'description', 'query']
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) {
      return clipLine(firstLine(v))
    }
  }
  return ''
}

/**
 * 任务清单摘要（`todo_write` 的参数是**整表**，摘要得从表里算）：
 * `已完成/总数 已完成` + 首个进行中项的内容；并行时再缀 `+N`（多于一项在进行）。
 *
 * 与上游同口径：计数与当前项**分开**取 —— 当前项缺失只损失那一截，计数照给。
 * 内容不合法（缺字段/空白串）就不点名：被拒的调用参数会原样留在行上，不该当成好事渲染。
 */
function todoSummary(args: Record<string, unknown>): string {
  const raw = args['todos']
  if (!Array.isArray(raw)) return ''
  const items = raw.filter(
    (t): t is { content?: unknown; status?: unknown } => t !== null && typeof t === 'object'
  )
  if (items.length === 0) return ''
  const done = items.filter((t) => t['status'] === 'completed').length
  const active = items.filter((t) => t['status'] === 'in_progress')
  const head = `${done}/${items.length} 已完成`
  const first = active[0]?.['content']
  if (typeof first !== 'string' || first.trim() === '') return head
  const named = `${head} · ${clipLine(firstLine(first))}`
  return active.length > 1 ? `${named} +${active.length - 1}` : named
}

/**
 * 交付文件（`present`）的**路径串**：把参数里的 `files[].path` 原样列出、用 `, ` 连接。
 *
 * 与上游同一口径：参数流式截断/坏形时**原样显示原始串**（宁可难看也不要静默空着），
 * 没有 `files` 数组同理。行上还有状态词（另给），这里只负责路径这一段。
 */
function presentSummary(args: Record<string, unknown>, argsRaw: string): string {
  const files = args['files']
  if (!Array.isArray(files)) {
    return clipLine(firstLine(argsRaw))
  }
  const paths = files
    .map((f) => {
      const rec = f as { path?: unknown } | null | undefined;
      return typeof rec?.path === 'string' ? rec.path : undefined;
    })
    .filter((p): p is string => p !== undefined);
  return paths.length > 0 ? clipLine(paths.join(', ')) : clipLine(firstLine(argsRaw))
}

/** 取文本首行并去空白。 */
function firstLine(text: string): string {
  return text.trim().split('\n')[0].trim()
}

/**
 * 结果文本首行——失败行收起摘要用（对齐上游 `ToolRow`/`bash-sample` 的 `firstLine`：
 * 切到第一个换行符为止，**不 trim**）。
 * 空串/undefined 返回 null（上游那里空结果本就被当作「无结果」，摘要位落回描述）；
 * **首行为空行时返回 `''`**（上游同样如此：此时摘要位整体不显示，而不是落回描述）。
 * @param output - 工具结果文本（宿主已剥退出 marker）。
 * @returns 首行文本、`''`，或无结果时的 null。
 */
export function resultFirstLine(output: string | undefined): string | null {
  if (output === undefined || output === '') return null
  const nl = output.indexOf('\n')
  return nl === -1 ? output : output.slice(0, nl)
}

/** 摘要单行截断（按本插件侧栏宽度设上限）。 */
function clipLine(line: string): string {
  return line.length > 140 ? line.slice(0, 140) + '…' : line
}

/** 对象里首个非空字符串值（按属性声明序）。 */
function firstStringLine(rec: Record<string, unknown>): string | undefined {
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.trim()) return clipLine(firstLine(v))
  }
  return undefined
}

/**
 * 缓存命中率：保留 1 位小数；
 * 整数去尾 `.0`（26.0→26，26.4→26.4，100→100）。
 * @param cacheReadTokens - cacheRead。
 * @param promptTokens - 输入总 tokens（totalToken − outputTokens = uncached+cacheRead+cacheWrite）；0 返回 ''。
 */
export function cacheHitPercent(cacheReadTokens: number, promptTokens: number): string {
  if (promptTokens <= 0) return ''
  const pct = (cacheReadTokens / promptTokens) * 100
  const s = pct.toFixed(1)
  return s.endsWith('.0') ? pct.toFixed(0) : s
}

/** ≥1e3 缩写为 K（如 10240 → 10.2K）；无效/≤0 返回空串 */
export function compactTokens(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return ''
  if (n >= 1000) return (Math.round((n / 1000) * 10) / 10).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

/**
 * 面板里的紧凑 token 数：`<1000` 原样、`<1e6` 用 K、否则用 M。
 * 缩放后 **≥100 取整、<100 保留一位小数**（`477K`、`21.5K`、`1.2M`），单位前无空格。
 */
export function formatCompactTokens(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return ''
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * 耗时（秒）：`<60` 保留一位小数（`45.2秒`），否则取整成 `2分42秒`。
 * 秒数非法返回空串（调用方据此不渲染那一行）。
 */
export function formatDurationCompact(sec: number | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return ''
  // 分界按**原值**判（不按舍入后的结果）：59.96 秒仍属"不足一分钟"，显示 60秒 而不是 1分0秒
  if (sec < 60) return `${String(Math.round(sec * 10) / 10)}秒`
  const total = Math.round(sec)
  return `${String(Math.floor(total / 60))}分${String(total % 60)}秒`
}

/** 输出速度：≥10 取整、<10 保留一位小数（与用时口径一致）。 */
export function formatTokensPerSecond(tps: number | undefined): string {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps < 0) return ''
  return tps < 10 ? String(Math.round(tps * 10) / 10) : String(Math.round(tps))
}

/** 单轮完成统计(chatDone.stats):只取上游字段,不自己测时/算 tok/s */
export function formatTurnStats(stats?: Record<string, unknown>): string {
  if (!stats) {
    return ''
  }
  const parts: string[] = []
  const steps = stats['steps']
  if (typeof steps === 'number' && steps > 0) {
    parts.push(`${steps} 步`)
  }
  const inp = stats['inputTokens']
  const out = stats['outputTokens']
  const cache = stats['cacheReadTokens']
  const cacheWrite = stats['cacheWriteTokens']
  const reasoning = stats['reasoningTokens']
  const inpN = typeof inp === 'number' ? inp : 0
  const cacheWN = typeof cacheWrite === 'number' ? cacheWrite : 0
  if (typeof cache === 'number' && inpN + cache + cacheWN > 0) {
    parts.push(`缓存命中 ${cacheHitPercent(cache, inpN + cache + cacheWN)}%`)
  }
  if (typeof inp === 'number') {
    parts.push(`输入 ${inp} tok`)
  }
  if (typeof out === 'number') {
    parts.push(`输出 ${out} tok`)
  }
  if (typeof cache === 'number' && cache > 0) {
    parts.push(`缓存 ${cache} tok`)
  }
  if (typeof cacheWrite === 'number' && cacheWrite > 0) {
    parts.push(`缓存写 ${cacheWrite} tok`)
  }
  if (typeof reasoning === 'number' && reasoning > 0) {
    parts.push(`推理 ${reasoning} tok`)
  }
  return parts.join(' · ')
}

/** dsh agent 模式展示名(MODE_NAMES) */
export const MODE_NAMES: Record<string, string> = {
  standard: '标准模式',
  minimal: '极简模式',
  cordis: '创造模式',
  ptc: 'PTC 模式',
}

/**
 * 危险权限预设：切换前必须过确认弹窗。
 *
 * **两个都要**（对齐上游 `ui-permission-presets`：确认条件是
 * `option.value === FULL_ACCESS_PRESET || option.value === AUTO_REVIEW_PRESET`，
 * 见其预设目录的实现）：
 *   · `danger-full-access`（FULL_ACCESS_PRESET='danger-full-access'）—— 减少确认步骤
 *   · `auto`（AUTO_REVIEW_PRESET='auto'）—— **无沙箱运行**，仅由同模型做实验性审查，
 *     可能误放行/误拒绝并消耗额外 token
 *
 * `auto` 很容易被漏掉：它由上游 `registerAuto()` **动态注册**，只有 `permissionPresets/catalog`
 * 会带上它（0.1.7 的进程级目录）。只列 `danger-full-access` 时，用户在目录里选 `auto`
 * 会**不经确认直接进入无沙箱模式** —— 这是安全缺口，不是外观问题。
 */
export const DANGEROUS_PERMS = new Set<string>(['danger-full-access', 'auto'])
