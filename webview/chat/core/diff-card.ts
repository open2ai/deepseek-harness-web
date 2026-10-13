// 差异卡（上游 DiffBlock / diff-card-model 复刻）纯函数模型。
//
// 数据来源两条路，**优先第二条**：
//   1. 参数推导：write(file_path+content) / edit(file_path+old_string+new_string) /
//      str_replace_editor(command=create|str_replace)
//   2. 结果元数据：`meta.diffs`（结构化落盘差异）
// 定稿时 meta.diffs 可用就用它；不可用（缺失/空数组）时 **write 回退到参数推导的整文件差异**
// （与「新建」「原样覆盖」的呈现一致），edit 则回退通用卡（不猜）。
// 因此：**write 不依赖 meta，必然出卡**；edit 依赖 meta.diffs。
//
// ⚠️ 卡体行**不是**"老文本全删 + 新文本全增"：必须先 `structuredPatch`（context=3）求真 hunk，
// 未变行是 **context 行**（两侧都算、卡体里居中显示）。这条错了会出现"一屏都是未变行的删除行"
// （真机 2026-10-11 撞到：只改一行的表格被铺成十几行 `-`）。出处：上游。
import { structuredPatch } from 'diff'

export interface DiffHunk {
  path: string
  oldText: string | null
  newText: string
}

export interface DiffCard {
  diffs: DiffHunk[]
}

/**
 * 扁平化后的一行：path 文件头 / ⋯ 同文件间隔 / - 删除行 / + 新增行 / 上下文行。
 *
 * ⚠️ **`context` 这一档不能少**：真 hunk 的未变行不是"删除行"（插件曾把它整段按全删全增铺开，
 * 真机上表现为卡体里出现一堆 `- | 时间 | 温度 |…` 的未变行）。
 */
export interface DiffRow {
  kind: 'path' | 'gap' | 'del' | 'add' | 'context'
  text: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseArgs(argsRaw?: string): Record<string, unknown> | null {
  if (!argsRaw) return null
  try {
    return asRecord(JSON.parse(argsRaw))
  } catch {
    return null
  }
}

/**
 * 校验可选的提权字段对（sandbox_permissions / justification）：两者要么都不给，
 * 要么给成合法的一对。args 形状不对时不硬渲染差异，直接回退。
 */
function validEscalationFields(args: Record<string, unknown>): boolean {
  const permission = args['sandbox_permissions']
  const justification = args['justification']
  if (permission === undefined && justification === undefined) return true
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') return false
  return typeof justification === 'string' && justification.trim() !== ''
}

type IntendedDiff = { tool: 'write' | 'edit' | 'str_replace_editor'; diff: DiffHunk }

/** 从参数推导差异（不依赖结果）。形状不合即 null。 */
function intendedDiff(name: string, args: Record<string, unknown>): IntendedDiff | null {
  if (name === 'str_replace_editor') {
    const path = args['path']
    const fileText = args['file_text']
    const oldText = args['old_str']
    const newText = args['new_str']
    if (typeof path !== 'string' || path.trim() === '') return null
    if (args['command'] === 'create') {
      if (fileText !== undefined && typeof fileText !== 'string') return null
      return { tool: 'str_replace_editor', diff: { path, oldText: null, newText: typeof fileText === 'string' ? fileText : '' } }
    }
    if (args['command'] === 'str_replace') {
      if (oldText !== undefined && typeof oldText !== 'string') return null
      if (newText !== undefined && typeof newText !== 'string') return null
      return {
        tool: 'str_replace_editor',
        diff: { path, oldText: typeof oldText === 'string' ? oldText : null, newText: typeof newText === 'string' ? newText : '' },
      }
    }
    return null
  }
  const path = args['file_path']
  if (typeof path !== 'string' || path.trim() === '') return null
  if (!validEscalationFields(args)) return null
  if (name === 'write') {
    const content = args['content']
    return typeof content === 'string' ? { tool: 'write', diff: { path, oldText: null, newText: content } } : null
  }
  if (name !== 'edit') return null
  const oldText = args['old_string']
  const newText = args['new_string']
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null
  if (args['replace_all'] !== undefined && typeof args['replace_all'] !== 'boolean') return null
  // 空 old_string 视作「无删除侧」（上游同：oldText || null）
  return { tool: 'edit', diff: { path, oldText: oldText || null, newText } }
}

/** 校验 meta.diffs：空数组 → 'empty'（让 write 走推导兜底）；形状不合 → null。 */
function appliedDiffs(meta: unknown): DiffHunk[] | 'empty' | null {
  const rec = asRecord(meta)
  if (rec === null) return null
  const diffs = rec['diffs']
  if (!Array.isArray(diffs)) return null
  if (diffs.length === 0) return 'empty'
  const out: DiffHunk[] = []
  for (const hunk of diffs) {
    const h = asRecord(hunk)
    if (h === null) return null
    const { path, oldText, newText } = h
    if (typeof path !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    out.push({ path, oldText, newText })
  }
  return out
}

/**
 * 派生差异卡。只在 running / ok 两种终态出卡（error / stopped 回退通用卡，
 * 与上游 `isError → null` 同口径）。
 * `str_replace_editor` 定稿后没有结果视图，返回 null（上游同）。
 */
export function diffCardModel(item: {
  name: string
  argsRaw?: string
  status: string
  meta?: unknown
  parentCallId?: string
}): DiffCard | null {
  // 嵌套调用（上游）：退让到通用卡
  if (item.parentCallId !== undefined) return null
  if (item.status !== 'running' && item.status !== 'ok') return null
  const args = parseArgs(item.argsRaw)
  if (args === null) return null
  const intended = intendedDiff(item.name, args)
  if (intended === null) return null
  if (item.status === 'running') return { diffs: [intended.diff] }
  if (intended.tool === 'str_replace_editor') return null
  const applied = appliedDiffs(item.meta)
  if (applied === null || applied === 'empty') {
    return intended.tool === 'write' ? { diffs: [intended.diff] } : null
  }
  return { diffs: applied }
}

/**
 * 把一侧文本拆成内容行。空文本是 0 行；**末尾单个换行是行终止符**而非多出的空行
 * （内部 `\n\n` 的真空行保留）。与终端卡对命令输出的处理同一条终止符规则。
 */
export function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * 编辑图搜索的上界（一次替换消耗两次编辑）。**超限就退回"整段替换"**。
 *
 * 数值与上游一致：`DiffBlock.tsx` 的 `MAX_DIFF_EDIT_LENGTH = 256`。
 */
const MAX_DIFF_EDIT_LENGTH = 256

/**
 * 求这一处的**精确局部 hunk**：`structuredPatch`（context=3）的真 hunk；
 * 编辑距离超限（返回 undefined）时退回"老文本全删 + 新文本全增"。
 *
 * ⚠️ 三条必须与上游逐字一致，否则行数与 `+/-` 统计都会偏：
 *   ① 两侧文本先按 `contentLines` 断行、再逐行补 `\n` 规范化（`normalize`）；
 *   ② `context: 3`、`maxEditLength: 256`；
 *   ③ 超限回退时**不**走 hunk，直接整段替换（老全 `-`、新全 `+`）。
 *
 * 出处：上游。
 */
export function localHunks(diff: DiffHunk): Array<{ lines: string[] }> {
  const oldLines = contentLines(diff.oldText ?? '')
  const newLines = contentLines(diff.newText)
  const normalize = (lines: string[]): string => lines.map((line) => `${line}\n`).join('')
  return structuredPatch('', '', normalize(oldLines), normalize(newLines), undefined, undefined, {
    context: 3,
    maxEditLength: MAX_DIFF_EDIT_LENGTH,
  })?.hunks ?? [{ lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)] }]
}

/**
 * 新增/删除行数合计（工具行摘要里的 `+n -m` 与卡体折叠共用同一组数）。
 *
 * ⚠️ **只数增删行**：上下文行（hunk 里的未变行）不计入 —— 上游
 * 就是这么数的（逐行看首字符）。插件此前按"老文本行数 + 新文本行数"
 * 统计，一个只改一行的表格会被算成十几行，与网页端的 `+1 -0` 对不上。
 */
export function diffTotals(diffs: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const d of diffs) {
    for (const hunk of localHunks(d)) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added += 1
        if (line.startsWith('-')) removed += 1
      }
    }
  }
  return { added, removed }
}

/**
 * 扁平化成卡体行。
 *
 * 规则逐条对齐上游 ：
 *   · 换文件 → 先压一行 `path`（文本**原样**，绝对/相对都不动，它是模型面对的那条路径）；
 *   · **同一个文件又来一处** → 压 `gap`（`⋯`），不是重复 path 头；
 *   · 同一处里有多个 hunk（相距较远的两段）→ hunk 之间再压一个 `gap`；
 *   · hunk 的每一行按首字符定 kind（`-`/`+`/其余=context），**并剥掉那个首字符**。
 *
 * `files` 是 distinct 路径数（同一文件两处修改算 1 个文件）。
 */
export function diffRows(diffs: DiffHunk[]): { rows: DiffRow[]; added: number; removed: number; files: number } {
  const rows: DiffRow[] = []
  const paths = new Set<string>()
  let prevPath: string | undefined
  for (const d of diffs) {
    paths.add(d.path)
    rows.push(d.path !== prevPath ? { kind: 'path', text: d.path } : { kind: 'gap', text: '⋯' })
    prevPath = d.path
    for (const [index, hunk] of localHunks(d).entries()) {
      if (index > 0) rows.push({ kind: 'gap', text: '⋯' })
      for (const line of hunk.lines) {
        const kind = line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : 'context'
        rows.push({ kind, text: line.slice(1) })
      }
    }
  }
  return { rows, ...diffTotals(diffs), files: paths.size }
}

/**
 * 复制内容：逐行带各自前缀（path 头原样、间隔 `⋯` 原样、删除 `- `、新增 `+ `、**上下文两个空格**）。
 * 与卡体所见一致（上游）。
 */
export function diffCopyText(rows: DiffRow[]): string {
  return rows
    .map((r) => (r.kind === 'del' ? '- ' + r.text : r.kind === 'add' ? '+ ' + r.text : r.kind === 'context' ? '  ' + r.text : r.text))
    .join('\n')
}

/**
 * 卡体顶部那条横幅要显示的语言标签（上游 `CodeToolbar` 的 `CodeCard.language` 位置）。
 *
 * 上游走 `languageForPath(path)`（扩展名 → 规范语言 id，如 `.md` → `markdown`）；
 * 插件不引入那张大表（它服务于语法高亮，插件没有），只认**常见扩展名**，
 * 认不出时按上游口径显示「代码块」（`t('codeBlock.title')`）。
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: 'markdown', markdown: 'markdown',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', jsonl: 'json',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', php: 'php',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'fish',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', conf: 'ini', cfg: 'ini',
  xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', lua: 'lua', r: 'r', jl: 'julia', dart: 'dart', scala: 'scala',
  clj: 'clojure', erl: 'erlang', ex: 'elixir', hs: 'haskell', fs: 'fsharp', vb: 'vb', pl: 'perl',
  vue: 'vue', svelte: 'svelte', tf: 'hcl', hcl: 'hcl', nix: 'nix', gradle: 'groovy', groovy: 'groovy',
  csv: 'csv', log: 'log', diff: 'diff', patch: 'diff',
}

/** 路径 → 横幅语言标签（认不出 → `undefined`，调用方显示「代码块」）。 */
export function languageForPath(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  if (dot < 0) return undefined
  const extension = base.slice(dot + 1).toLowerCase()
  return LANGUAGE_BY_EXTENSION[extension]
}

/** 差异卡文案（zh 原文取自上游字典 common `copy` + `diff.files.*` + `codeBlock.title`）。 */
export interface DiffLabels {
  copy: string
  files: (n: number) => string
  /** 扩展名认不出时横幅上的字（上游 `t('codeBlock.title')` = 「代码块」）。 */
  codeLabel: string
}

export function diffLabels(): DiffLabels {
  return {
    copy: '复制',
    files: (n) => `${n} 个文件`,
    codeLabel: '代码块',
  }
}
