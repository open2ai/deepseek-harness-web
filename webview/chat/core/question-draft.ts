// 提问弹窗的**草稿初始值**与「推荐项」解析 —— 独立纯函数文件（适配 dsh 0.2.0）。
//
// 上游口径（0.2.0）：
//   · 推荐是**写进选项文案的后缀**（`(Recommended)` / `（推荐）`）：解析时剥掉后缀用于显示，
//     但**答案值仍是原始 label**（含后缀）—— 两端必须一致，否则回传的答案对不上；
//   · 草稿初始化：**没有已存答案时把第一个推荐项预选上**；有已存答案（含「跳过」）时不预选。
//
// 插件此前只做了「显示时剥后缀 + 挂推荐角标」，**没有预选**（本轮对齐）。因为插件的提问弹窗每次
// 新提问都由父层 key 强制重挂、草稿从空开始，等价于上游「没有已存答案」那一支，故直接预选推荐项。

/** 推荐后缀：半角/全角括号 + 中英文，允许前后空白（与上游 `parseRecommendedLabel` 的正则同义）。 */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i

/** 草稿形状：与弹窗组件的局部 `Draft` 结构一致（这里只描述字段，避免组件反向依赖）。 */
export interface QuestionDraftLike {
  selected: string[]
  custom: string
  skipped: boolean
}

/**
 * 把选项文案拆成「显示文本 + 是否推荐」。
 * @param label - 原始选项文案（可能带推荐后缀）。
 * @returns 显示文本与推荐标记；**答案值仍用原始 label**。
 */
export function splitRecommended(label: string): { text: string; recommended: boolean } {
  return RECOMMENDED_SUFFIX.test(label)
    ? { text: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { text: label, recommended: false }
}

/**
 * 第一个推荐项的**原始 label**（含后缀），没有则 undefined。
 * @param options - 该题的选项（可为空/缺失）。
 */
export function recommendedFirstLabel(options: readonly { label: string }[] | undefined): string | undefined {
  for (const option of options ?? []) {
    if (splitRecommended(option.label).recommended) {
      return option.label
    }
  }
  return undefined
}

/**
 * 一题的草稿初始值：没有已存答案时**预选**推荐项（上游 0.2.0 口径）。
 * @param question - 该题（只用 `options`）。
 * @returns 初始草稿；无推荐项时 `selected` 为空。
 */
export function initialQuestionDraft(question: { options?: readonly { label: string }[] }): QuestionDraftLike {
  const recommended = recommendedFirstLabel(question.options)
  return { selected: recommended === undefined ? [] : [recommended], custom: '', skipped: false }
}
