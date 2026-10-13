// 候选排序（**逐字搬上游** `ui-primitives/src/rank-by-name.ts`，含算法与权重，别自行"优化"）。
//
// 上游口径（该文件抬头注释的原文）：查询必须是候选名（或它的展示 label）的**大小写无关有序子序列**；
// 排序依次是 —— **前缀命中优先 → 对齐分高者优先 → 源序**。空查询原样返回。
// 上游的决策记录：`.agents/notes/archived/feature/2026-08-04-web-slash-command-fuzzy-discovery.md`。
//
// 上游用在四处：斜杠命令菜单（`ui-commands/popup.ts` / `service.ts`）、模型菜单（
// 按**提供方分组内**排序）、技能来源、快捷键参考（`ui-shortcuts/Reference.tsx`）。
// 插件对应三处：`components/ModelPicker.ts`（分组内）、`components/SearchPicker.ts`（平铺）、
// `core/trigger/useTrigger.ts`（斜杠 / @ 菜单）。

/** 一条命中及其稳定的源位置。 */
interface Ranked<T> {
  readonly item: T
  readonly index: number
  readonly prefix: boolean
  readonly score: number
}

/** 名字开头与分隔符边界额外加权。 */
function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0
}

/**
 * 求最强的**有序子序列**对齐分，O(name × query)。
 * 边界与相邻命中加权；跳过的字符与前导字符扣权。查询不是子序列时返回 undefined。
 */
function alignmentScore(name: string, query: string): number | undefined {
  if (query.length > name.length) return undefined
  const noMatch = Number.NEGATIVE_INFINITY
  let previous = Array<number>(name.length).fill(noMatch)
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) previous[index] = 1 + boundaryBonus(name, index) - index
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array<number>(name.length).fill(noMatch)
    // 上一行只扫一遍：`left` 是它左边一格（相邻续接），`leftLeft` 是左边两格（最早的带间隙那条）。
    let left = noMatch
    let leftLeft = noMatch
    let bestGapped = noMatch
    for (const [index, prior] of previous.entries()) {
      if (leftLeft !== noMatch) bestGapped = Math.max(bestGapped, leftLeft + index - 2)
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index)
        let score = noMatch
        if (left !== noMatch) score = left + bonus + 4
        if (bestGapped !== noMatch) score = Math.max(score, bestGapped + bonus + 1 - index)
        current[index] = score
      }
      leftLeft = left
      left = prior
    }
    previous = current
  }
  let best = noMatch
  for (const score of previous) best = Math.max(best, score)
  return best === noMatch ? undefined : best
}

/**
 * 按菜单查询串给具名候选排序。
 * @param items - 源序候选（宿主目录在前、客户端贡献在后）；可选 `label` 是名字之外的第二个搜索键。
 * @param rawQuery - 触发符之后输入的文本，大小写无关匹配。
 * @returns 命中的候选：前缀优先 → 对齐分 → 源序；空查询原样返回入参列表。
 */
export function rankByName<T extends { readonly name: string; readonly label?: string }>(
  items: readonly T[],
  rawQuery: string,
): readonly T[] {
  const query = rawQuery.toLowerCase()
  if (query === '') return items
  const ranked: Ranked<T>[] = []
  items.forEach((item, index) => {
    const keys = item.label === undefined ? [item.name] : [item.name, item.label]
    let prefix = false
    let score: number | undefined
    for (const key of keys) {
      const lower = key.toLowerCase()
      const keyScore = alignmentScore(lower, query)
      if (keyScore === undefined) continue
      prefix ||= lower.startsWith(query)
      score = score === undefined ? keyScore : Math.max(score, keyScore)
    }
    if (score !== undefined) ranked.push({ item, index, prefix, score })
  })
  ranked.sort((left, right) =>
    Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.index - right.index)
  return ranked.map((match) => match.item)
}
