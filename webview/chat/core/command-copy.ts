// 命令行（上游 `command` 节点）的**文案决议**（纯函数、有守卫）。
//
// 逐字取上游 zh 字典：摘要 = 结算 `text` → 否则按 kind 给「指令失败」/「已完成」；进行中「执行中…」；
// 标题 = **裸命令名**（没有名字时「指令」）。**`args` 上游从不渲染**，所以这里不接它。

/** 进行中（上游 `command.running`）。 */
export const COMMAND_RUNNING = '执行中…'

/** 失败（上游 `command.failed`）。 */
export const COMMAND_FAILED = '指令失败'

/** 已完成（上游 `command.done`）。 */
export const COMMAND_DONE = '已完成'

/** 无名命令的标题回退（上游 `command.title`）。 */
export const COMMAND_TITLE = '指令'

/** 三态（上游 `stateOf`）：未结算 = 进行中；否则按 kind。 */
export type CommandState = 'running' | 'ok' | 'error'

/**
 * 该行处在哪一态。
 * @param row - 该行事实（只看 `outcome`）。
 */
export function commandState(row: { outcome?: { kind: 'success' | 'error' } }): CommandState {
  if (row.outcome === undefined) return 'running'
  return row.outcome.kind === 'error' ? 'error' : 'ok'
}

/**
 * 标题 = **裸命令名**（上游：不带 `/`、不显示 args）；没有名字时回退「指令」。
 * @param row - 该行事实。
 */
export function commandTitle(row: { name?: string | null }): string {
  const name = row.name
  return name === undefined || name === null || name === '' ? COMMAND_TITLE : name
}

/**
 * 摘要行：**结算文案优先**，没有结算文案时按 kind 给固定文案，未结算则是「执行中…」。
 * @param row - 该行事实。
 */
export function commandSummary(row: { outcome?: { kind: 'success' | 'error'; text?: string } }): string {
  const outcome = row.outcome
  if (outcome === undefined) return COMMAND_RUNNING
  if (outcome.text !== undefined && outcome.text !== '') return outcome.text
  return outcome.kind === 'error' ? COMMAND_FAILED : COMMAND_DONE
}

/** 可展开条件（上游 `GenericCommandCard`）：**只有结算文案含换行**才可展开。 */
export function commandExpandable(row: { outcome?: { text?: string } }): boolean {
  const text = row.outcome?.text
  return text !== undefined && text.includes('\n')
}
