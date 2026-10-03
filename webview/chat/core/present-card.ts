// 交付文件（`present`）**专属行**的模型（适配上游 0.1.7-rc.2）。
//
// 为什么单独一条行、而不是并进通用「输入 / 输出」卡：上游这一行有自己的口径 ——
//   1) 行首标记按**四态**给（进行中 / 完成 / 中断 / 失败），不显工具图标；
//   2) 状态词**可见**（在收起行里、路径前面），不是只给读屏；
//   3) 展开体**只有结果正文**：没有结果时用「错误名: 错误码」兜底，两者都没有**不可展开**
//      （没有结果就没有可展开的内容，也不该把调用参数摊出来）。
import { deriveToolSummary } from './format'
import type { DshTurnProcessItem } from './store/types'

type Tool = Extract<DshTurnProcessItem, { kind: 'tool' }>

/** 行首标记四态（与上游状态点同名：进行中 / 完成 / 中断 / 失败）。 */
export type PresentMark = 'ongoing' | 'done' | 'warning' | 'error'

export interface PresentCardModel {
  /** 行首标记态：完成才是「完成」，中断不是失败 */
  mark: PresentMark
  /** 可见状态词（zh 原文取自上游字典 `row.running` / `row.ok` / `row.error` / `row.stopped`） */
  label: string
  /** 声明的文件路径串（原样列出、`, ` 连接；参数坏形时是原始参数串） */
  paths: string
  /** 展开体正文；**空串表示不可展开** */
  details: string
}

/** 四个状态词（行状态 → 文案）。准备中（参数还没到）按运行中显示。 */
const LABELS: Record<Tool['status'], string> = {
  preparing: '正在交付',
  running: '正在交付',
  ok: '已交付',
  error: '交付失败',
  stopped: '已中断',
}

/** 行状态 → 行首标记态。 */
const MARKS: Record<Tool['status'], PresentMark> = {
  preparing: 'ongoing',
  running: 'ongoing',
  ok: 'done',
  error: 'error',
  stopped: 'warning',
}

/**
 * 交付文件行的展示派生。
 *
 * 收起行摘要里的文件路径复用 `deriveToolSummary` 的 present 分支（同一份实现，见 format）：
 * 参数流式截断/坏形时**原样显示原始串**，宁可难看也不静默空着。
 */
export function presentCardModel(item: Tool): PresentCardModel {
  const running = item.status === 'running'
  return {
    mark: MARKS[item.status],
    label: LABELS[item.status],
    paths: deriveToolSummary(item.argsRaw, 'present'),
    details: running ? '' : ((item.output ?? '') || errorDetail(item)),
  }
}

/** 无结果时的兜底正文：`错误名: 错误码`（只有其一就只写其一）。 */
function errorDetail(item: Tool): string {
  const name = item.errorName ?? ''
  const code = item.error ?? ''
  if (name !== '' && code !== '') {
    return `${name}: ${code}`
  }
  return name !== '' ? name : code
}
