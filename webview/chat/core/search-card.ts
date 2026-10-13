// 搜索卡（上游 SearchBlock / search-card-model 复刻）纯函数模型。
//
// 数据来源：**结构化元数据 `meta`**——grep 走 `meta.shape==='matches'` + `meta.files[{path,matches[{lineNumber,line}]}]`；
// glob 走 `meta.shape==='paths'` + `meta.paths[]`；两者都要求 `meta.truncated`(boolean) 与 `meta.total`(整数)。
// 结果文本只在**被截断**时用作兜底定位符（recovery，让用户能自己再查全量）。
// 因此本卡**完全依赖 meta**；形状不符即返回 null，落回通用「输入/输出」卡。

export interface SearchMatch {
  lineNumber: number
  line: string
}

export interface SearchFileGroup {
  path: string
  matches: SearchMatch[]
}

export type SearchCard =
  | { kind: 'matches'; files: SearchFileGroup[]; truncated: boolean; total: number; recovery?: string }
  | { kind: 'paths'; paths: string[]; truncated: boolean; total: number; recovery?: string }

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
 * grep 的 `include` 形状校验：非空、不以 `!` 开头、花括号配对、顶层无逗号。
 * 形状可疑时宁可回退通用卡——拿不准的 include 会让「匹配数」的说法失真。
 */
function validInclude(include: string): boolean {
  if (include.trim() === '' || include.startsWith('!')) return false
  let braceDepth = 0
  for (const ch of include) {
    if (ch === '{') braceDepth += 1
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (ch === ',' && braceDepth === 0) return false
  }
  return true
}

/** 调用校验：只认 `grep` / `glob`（上游同；web_search 走 web 卡不在这里）。 */
function validSearchCall(name: string, args: Record<string, unknown>): 'grep' | 'glob' | null {
  if (name !== 'grep' && name !== 'glob') return null
  const pattern = args['pattern']
  if (typeof pattern !== 'string') return null
  if (name === 'grep' && pattern === '') return null
  if (name === 'glob' && pattern.trim() === '') return null
  const path = args['path']
  if (path !== undefined && (typeof path !== 'string' || path.trim() === '')) return null
  if (name === 'grep') {
    const include = args['include']
    if (include !== undefined && (typeof include !== 'string' || !validInclude(include))) return null
  }
  return name
}

function searchFiles(value: unknown): SearchFileGroup[] | null {
  if (!Array.isArray(value)) return null
  const files: SearchFileGroup[] = []
  for (const file of value) {
    const f = asRecord(file)
    if (f === null) return null
    const { path, matches } = f
    if (typeof path !== 'string' || !Array.isArray(matches)) return null
    const narrowed: SearchMatch[] = []
    for (const match of matches) {
      const m = asRecord(match)
      if (m === null) return null
      const lineNumber = m['lineNumber']
      const line = m['line']
      if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1) return null
      if (typeof line !== 'string') return null
      narrowed.push({ lineNumber, line })
    }
    files.push({ path, matches: narrowed })
  }
  return files
}

/**
 * 派生搜索卡。只在 **ok** 终态出卡（running / error / stopped 回退通用卡，与上游
 * `!('kind' in block) || isError → null` 同口径）。
 */
export function searchCardModel(item: {
  name: string
  argsRaw?: string
  output?: string
  status: string
  meta?: unknown
  parentCallId?: string
}): SearchCard | null {
  // 嵌套调用（上游）：退让到通用卡
  if (item.parentCallId !== undefined) return null
  if (item.status !== 'ok') return null
  const args = parseArgs(item.argsRaw)
  if (args === null) return null
  const tool = validSearchCall(item.name, args)
  if (tool === null) return null
  const meta = asRecord(item.meta)
  if (meta === null) return null
  const truncated = meta['truncated']
  const total = meta['total']
  if (typeof truncated !== 'boolean') return null
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null
  // 被截断时把结果文本留给卡体兜底展示（用户据此可自己再查全量）
  const recovery = truncated ? (item.output && item.output !== '' ? item.output : undefined) : undefined
  if (tool === 'grep') {
    if (meta['shape'] !== 'matches') return null
    const files = searchFiles(meta['files'])
    if (files === null) return null
    return { kind: 'matches', files, truncated, total, ...(recovery === undefined ? {} : { recovery }) }
  }
  if (meta['shape'] !== 'paths' || !Array.isArray(meta['paths'])) return null
  const paths = meta['paths']
  if (!paths.every((p): p is string => typeof p === 'string')) return null
  return { kind: 'paths', paths: [...paths], truncated, total, ...(recovery === undefined ? {} : { recovery }) }
}

/** 卡体展示的匹配总数（matches 分支用；paths 分支的行数即 paths.length）。 */
export function searchMatchCount(card: SearchCard): number {
  return card.kind === 'matches' ? card.files.reduce((n, f) => n + f.matches.length, 0) : card.paths.length
}

/** 复制内容（与卡体所见一致）：paths 每行一个路径；matches 每个文件一行路径 + 每处匹配 `行号: 文本`，文件间空行。 */
export function searchCopyText(card: SearchCard): string {
  if (card.kind === 'paths') return card.paths.join('\n')
  return card.files
    .map((f) => [f.path, ...f.matches.map((m) => `${m.lineNumber}: ${m.line}`)].join('\n'))
    .join('\n\n')
}

/** 搜索卡文案（zh 原文取自上游字典 common `copy` + `search.*`）。 */
export interface SearchLabels {
  copy: string
  noResults: string
  pathsSummary: (shown: number, total: number, truncated: boolean) => string
  matchesSummary: (shown: number, total: number, files: number, truncated: boolean) => string
}

export function searchLabels(): SearchLabels {
  return {
    copy: '复制',
    noResults: '无结果',
    pathsSummary: (shown, total, truncated) => (truncated ? `显示 ${shown} / 共 ${total} 个路径` : `${shown} 个路径`),
    matchesSummary: (shown, total, files, truncated) =>
      truncated ? `显示 ${shown} / 共 ${total} 处匹配 · ${files} 个文件` : `${shown} 处匹配 · ${files} 个文件`,
  }
}
