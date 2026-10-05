// todo_write 卡模型（对齐上游 `todo-diff-model` / `todosDetail`）——纯函数。
//
// 把「本次写入的清单」与「宿主给的基线（上一次 `todo/write` 落盘清单）」做 diff：
// 新增 / 状态变化 / 顺序调整 / 移除 / 未变化，正文渲染成紧凑详情（见 components/chain/DetailsCardBody）。
// 形状不合 / 非 todo_write / 非 ok 态一律返回 null → ToolRow 回退通用「输入/输出」卡。
// 文案为上游字典 zh 原文（本插件直写中文）。
import type { DetailsModel, DetailItem } from './details-card'

/** todo 三态 → 中文（上游 `detail.todo.*`）。 */
const TODO_STATUS_LABELS: Record<'pending' | 'in_progress' | 'completed', string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
}

/** 参数原文 → 对象（坏形返回 null，走通用卡）。 */
function parseArgs(argsRaw?: string): Record<string, unknown> | null {
  if (argsRaw === undefined || argsRaw === '') return null
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** todo 列表 → 详情项（上游 `todosDetail`）：逐条校验 content/status/去重。 */
function todosDetail(value: unknown): DetailsModel | null {
  if (!Array.isArray(value)) return null
  const items: DetailItem[] = []
  const seen = new Set<string>()
  for (const todo of value) {
    if (todo === null || typeof todo !== 'object' || Array.isArray(todo)) return null
    const rec = todo as { content?: unknown; status?: unknown }
    const content = rec.content
    const status = rec.status
    if (typeof content !== 'string' || content.trim() === '') return null
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    const title = content.trim()
    if (seen.has(title)) return null
    seen.add(title)
    items.push({ title, status: { value: status, label: TODO_STATUS_LABELS[status] }, fields: [] })
  }
  return { items, empty: '任务清单为空' }
}

/**
 * todo_write 的 diff 模型（上游 `todoDiffModel` 的纯部分）。
 *
 * @param item - 工具行（name/argsRaw/status/todoBaseline）。
 * @param hasMore - 窗口外是否还有更早历史（决定「首次记录」还是「旧清单不可用」）。
 * @returns `{ details, summary }`（summary = 增/删/改计数，或 null 表示无法 diff）；形状不合返回 null。
 */
export function todoDiffModel(
  item: { name: string; argsRaw?: string; status: string; todoBaseline?: unknown },
  hasMore: boolean,
): { details: DetailsModel; summary: string | null } | null {
  if (item.name !== 'todo_write' || item.status !== 'ok') return null
  const args = parseArgs(item.argsRaw)
  if (args === null) return null
  const current = todosDetail(args['todos'])
  if (current === null) return null

  const baseline = item.todoBaseline
  // 没有基线（宿主没给字段，或窗口里没有更早的写入）→ 无法对比。
  if (baseline === undefined || baseline === null) {
    const details: DetailsModel = {
      ...current,
      // 窗口外还有更早历史 → 旧清单可能被截掉，标注「不可用」；否则就是「首次记录」。
      caption: hasMore ? '旧清单不可用' : '首次记录',
    }
    return { details, summary: null }
  }
  // 基线存在：展开成详情项（与当前同构）。
  const previous: DetailsModel | null = Array.isArray(baseline)
    ? { items: (baseline as Array<{ content?: unknown; status?: unknown }>).map((todo) => {
        const status = todo?.status
        const value: 'pending' | 'in_progress' | 'completed' | undefined =
          status === 'pending' || status === 'in_progress' || status === 'completed' ? status : undefined
        return {
          title: typeof todo?.content === 'string' ? todo.content : '',
          status: value === undefined ? undefined : { value, label: TODO_STATUS_LABELS[value] },
          fields: [],
        } as DetailItem
      }) }
    : null

  const previousByTitle = new Map((previous?.items ?? []).map((item) => [item.title, item]))
  const currentTitles = new Set(current.items.map((item) => item.title))
  const retainedPositions = new Map(
    (previous?.items ?? []).filter((item) => currentTitles.has(item.title)).map((item, index) => [item.title, index]),
  )
  let retainedIndex = 0
  const items: DetailItem[] = []
  const unchanged: DetailItem[] = []
  let added = 0
  let updated = 0
  for (const item of current.items) {
    const before = previousByTitle.get(item.title)
    previousByTitle.delete(item.title)
    if (before === undefined) {
      added += 1
      items.push({ ...item, change: { value: 'added', label: '新增' } })
    } else {
      const moved = retainedPositions.get(item.title) !== retainedIndex
      retainedIndex += 1
      const statusChanged = before.status?.value !== item.status?.value
      if (statusChanged || moved) {
        updated += 1
        items.push({
          ...item,
          ...(statusChanged && before.status !== undefined ? { previousStatus: before.status.label } : {}),
          change: { value: 'updated', label: statusChanged ? '状态变化' : '顺序调整' },
        })
      } else {
        unchanged.push(item)
      }
    }
  }
  for (const item of previousByTitle.values()) {
    items.push({ ...item, change: { value: 'removed', label: '移除' } })
  }
  const summary = [
    added > 0 ? `新增 ${added}` : null,
    updated > 0 ? `更新 ${updated}` : null,
    previousByTitle.size > 0 ? `移除 ${previousByTitle.size}` : null,
  ].filter((part): part is string => part !== null).join(' · ')
  const details: DetailsModel = {
    items,
    caption: previous === null ? '首次记录' : '与上次清单相比',
    empty: current.items.length === 0 && previous === null ? '任务清单为空' : '清单没有变化',
    ...(unchanged.length === 0 ? {} : { unchanged: { label: `${unchanged.length} 项未变化`, items: unchanged } }),
  }
  return { details, summary: summary || '清单没有变化' }
}
