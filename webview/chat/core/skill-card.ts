// `skill` 工具行（上游 `ui-skill/SkillRow.tsx`）：**加载技能**那张卡。
//
// 上游那张卡的模型叫 `skillRowModel`，只从「持久调用切片」取值、**不查实时技能目录**：
//   · `name`  = 参数里的 `name`（解析不出就退回参数原文的首行；参数为空用 callId）；
//   · `state` = 运行中 / 被中断(stopped) / 失败 / 正常；
//   · `output`= 结果文本（上游 `resultText` 的同款展平，这里直接用工具项已展平好的 `output`）；
//   · `errorSummary` = 失败时结果的首行。
// 折叠头那行的摘要：失败 → 结果首行；中止 → 「skill 加载已中止」；否则 → 技能名。
//
// 卡体：展开显示「说明」卡（`<pre>` 放结果文本）。上游那卡还带一个「查看」按钮打开调用检查器 ——
// 插件的调用检查器不在本卡范围内，故不出该按钮。

/** 卡片状态（与上游 `SkillRowState` 同名同义）。 */
export type SkillState = 'running' | 'ok' | 'error' | 'stopped'

export interface SkillCard {
  /** 折叠头摘要：技能名（失败时是结果首行、中止时是「skill 加载已中止」）。 */
  readonly summary: string
  /** 结果文本；没有可展开内容时为 null（此时整行不可展开）。 */
  readonly output: string | null
  readonly state: SkillState
}

/** 首行（折叠头摘要与坏形参数兜底都用它）。 */
function firstLine(text: string): string {
  const at = text.indexOf('\n')
  return at === -1 ? text : text.slice(0, at)
}

/** 技能名 = 参数的 `name`；解析不出退回参数原文首行，参数为空退回 callId（上游同口径，不编造）。 */
function skillName(argsRaw: string | undefined, callId: string | undefined): string {
  if (argsRaw !== undefined && argsRaw !== '') {
    try {
      const parsed: unknown = JSON.parse(argsRaw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const name = (parsed as Record<string, unknown>)['name']
        if (typeof name === 'string' && name !== '') return firstLine(name)
      }
    } catch {
      // 参数还在流式（截断 JSON）：首行仍比整串有用
    }
    return firstLine(argsRaw)
  }
  return callId ?? ''
}

/**
 * 派生技能行；非 `skill` 工具一律 null（落到后续卡）。
 * @param item - 工具项（name/argsRaw/output/status/callId/error）。
 */
export function skillCardModel(item: {
  name: string
  argsRaw?: string
  output?: string
  status: string
  callId?: string
  error?: string
}): SkillCard | null {
  if (item.name !== 'skill') return null
  const state: SkillState = item.status === 'running'
    ? 'running'
    : item.error === 'interrupted' ? 'stopped' : item.status === 'error' ? 'error' : 'ok'
  const text = item.output !== undefined && item.output !== '' ? item.output : null
  const errorSummary = state === 'error' && text !== null ? firstLine(text) : null
  const summary = state === 'stopped' ? SKILL_LABELS.stopped : errorSummary ?? skillName(item.argsRaw, item.callId)
  return { summary, output: text, state }
}

/**
 * 文案逐字取上游 `ui-skill/locales.ts` 的 zh 字典（`row.*`），不自造同义词。
 * `running` / `failed` 是**给读屏的隐藏态**（上游 `stateStatus` 只在运行/失败时输出）。
 */
export const SKILL_LABELS = {
  title: '加载技能',
  running: '正在加载 skill',
  preparing: '准备加载技能',
  failed: 'skill 加载失败',
  stopped: 'skill 加载已中止',
  instructions: '说明',
} as const
