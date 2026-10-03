// 交付物纯函数模型（适配上游 0.1.7-rc.2）：回合尾部的两套词汇。
//
//   - **本轮文件改动**：从写盘工具调用**推导** —— 不需要模型配合，成功结算 + 参数过关即可；
//   - **交付文件**：模型显式声明，由宿主事件带到行上（行的 `presentedFiles`），推导不出来。
//
// 推导侧只认三个写盘工具，且参数**逐字段**把关：形状不合就不算改动（宁缺勿错——把读文件、
// 删除、失败调用算成"产出"会让清单整天说谎话）。
import type { DshTurnProcessItem } from './store/types'

/** 非空对象取值（数组与非对象一律不算）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 非空字符串取值（空白串按缺省处理）。 */
function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 写盘调用参数里的目标路径；不是写盘调用、或参数形状不合 → null。
 *
 * 字段门槛（与上游同一份判据）：
 *   - `write`：`file_path` + `content` 是字符串；
 *   - `edit`：`file_path` + `old_string` 非空串 + `new_string` 字符串 + 两者**不相等**，
 *     `replace_all` 给了就必须是布尔；
 *   - `str_replace_editor`：`path` + `command` 恰为 `create`（需字符串 `file_text`）/
 *     `str_replace`（需非空 `old_str`）/ `insert`（需 `insert_line` 为 ≥0 的整数 + 字符串 `new_str`）。
 *
 * 路径**原样返回**：不归一化、不拼绝对路径（相对路径按会话工作区根解析是打开侧的事）。
 */
export function mutationPath(name: string, argsRaw?: string): string | null {
  if (!argsRaw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return null
  }
  const args = asRecord(parsed)
  if (args === null) return null

  if (name === 'str_replace_editor') {
    const path = nonBlank(args['path'])
    if (path === null) return null
    const command = args['command']
    if (command === 'create') return typeof args['file_text'] === 'string' ? path : null
    if (command === 'str_replace') return nonBlank(args['old_str']) === null ? null : path
    if (command === 'insert') {
      const line = args['insert_line']
      const okLine = typeof line === 'number' && Number.isInteger(line) && line >= 0
      return okLine && typeof args['new_str'] === 'string' ? path : null
    }
    return null
  }

  const path = nonBlank(args['file_path'])
  if (path === null) return null
  if (name === 'write') return typeof args['content'] === 'string' ? path : null
  if (name !== 'edit') return null
  const oldText = nonBlank(args['old_string'])
  const newText = args['new_string']
  if (oldText === null || typeof newText !== 'string' || oldText === newText) return null
  if (args['replace_all'] !== undefined && typeof args['replace_all'] !== 'boolean') return null
  return path
}

/**
 * 本回合**写盘成功**的产出路径（按首见顺序去重）。
 *
 * 取「链上已成功的写盘工具」而不是「全部工具」：结果没回来、失败、被中断的调用都不算改动。
 * 回合边界由行本身给出（这条链就是该回合的过程内容），故不再按事件序号另做一次过滤。
 */
export function producedPaths(chain: readonly DshTurnProcessItem[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of chain) {
    if (item.kind !== 'tool' || item.status !== 'ok') continue
    const path = mutationPath(item.name, item.argsRaw)
    if (path === null || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** 路径末段（chip 上显示的名字；两种分隔符都认，Windows 路径不吃亏）。 */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** 扩展名标签：大写、最多 8 字符；无扩展名返回空串（卡片状态行的兜底文案）。 */
export function extensionLabel(p: string): string {
  const base = baseName(p)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toUpperCase().slice(0, 8)
}
