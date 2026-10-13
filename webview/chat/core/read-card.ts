// 读文件卡（上游 ReadBlock / read-card-model 复刻）纯函数模型。
//
// 数据来源：**结构化元数据 `meta`**——行号/内容在 `meta.lines[{number,text}]`，
// 文件总行数在 `meta.totalLines`，路径在 `meta.path`。结果文本里的正文**不含行号**，
// 只用来校验「read 信封」格式（校验不过就回退通用卡，不猜）。
// 因此本卡**完全依赖 meta**；meta 形状不符即返回 null，落回通用「输入/输出」卡。
import { relativizeToCwd } from './terminal'

export interface ReadLine {
  number: number
  text: string
}

export interface ReadCard {
  /** 相对化后的文件路径（无 home 数据，不做 `~` 缩写） */
  label: string
  lines: ReadLine[]
  totalLines: number
  lang?: string
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

/** 调用校验：工具名必须是 `read`（上游只认它，read_image/readTextFile 不给本卡）。 */
function validReadCall(name: string, args: Record<string, unknown>): boolean {
  if (name !== 'read') return false
  const path = args['file_path']
  if (typeof path !== 'string' || path.trim() === '') return false
  const offset = args['offset']
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1)) return false
  const limit = args['limit']
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) return false
  return true
}

/**
 * 校验 `meta` 并取出结构化内容。逐项照上游：字段类型、整数性、行号**严格递增**且不超总行数。
 * 任何一项不合即 null（宁可回退通用卡，也不渲染半对的内容）。
 */
function readMeta(meta: unknown): { path: string; lines: ReadLine[]; totalLines: number; lang?: string } | null {
  const rec = asRecord(meta)
  if (rec === null) return null
  const { path, offset, lines, totalLines, lang } = rec
  if (typeof path !== 'string' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1) return null
  if (typeof totalLines !== 'number' || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines)) return null
  if (lang !== undefined && typeof lang !== 'string') return null
  const narrowed: ReadLine[] = []
  let previous = offset - 1
  for (const line of lines) {
    const l = asRecord(line)
    if (l === null) return null
    const { number, text } = l
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number <= previous) return null
    if (number > totalLines || typeof text !== 'string') return null
    previous = number
    narrowed.push({ number, text })
  }
  return { path, lines: narrowed, totalLines, ...(lang === undefined ? {} : { lang }) }
}

/**
 * 派生读文件卡。只在 **ok** 终态出卡（running / error / stopped 都回退通用卡，与上游
 * `!('kind' in block) || isError → null` 同口径）。
 */
export function readCardModel(
  item: { name: string; argsRaw?: string; output?: string; status: string; meta?: unknown; parentCallId?: string },
  sessionCwd?: string,
): ReadCard | null {
  // 嵌套调用（上游）：`parentCallId !== undefined` → 退让到通用卡
  if (item.parentCallId !== undefined) return null
  if (item.status !== 'ok') return null
  const args = parseArgs(item.argsRaw)
  if (args === null) return null
  if (!validReadCall(item.name, args)) return null
  const meta = readMeta(item.meta)
  if (meta === null) return null
  // 结果文本必须匹配「read 信封」；正文本身不进卡（行号走 meta）
  const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(item.output ?? '')?.[1]
  if (body === undefined) return null
  return {
    label: relativizeToCwd(meta.path, sessionCwd),
    lines: meta.lines,
    totalLines: meta.totalLines,
    ...(meta.lang === undefined ? {} : { lang: meta.lang }),
  }
}

/** 读文件卡文案（zh 原文取自上游字典：common `copy` + `read.window`）。 */
export interface ReadLabels {
  copy: string
  window: (shown: number, total: number) => string
}

export function readLabels(): ReadLabels {
  return {
    copy: '复制',
    window: (shown, total) => `显示 ${shown} / ${total} 行`,
  }
}
