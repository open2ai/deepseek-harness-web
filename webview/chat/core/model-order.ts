// 提供方分组的展示顺序 —— 独立文件，纯函数（适配 dsh 0.2.0）。
//
// 上游 0.2.0 起把 `deepseek-account` 与 `deepseek-official` 两组提到最前，**其余保持目录原序**
// （稳定排序），组内模型顺序不变；上游在作曲区菜单与命令面板两个入口都这么做。
//
// 插件只有一个收敛点：`core/store/selectors.ts` 的 `setModels()` 写 `sel.modelGroups`，
// 🤖 弹窗与 `/model` 搜索列表都从那里取 —— 在那里排一次，两个入口同时生效。
//
// 稳定性：不依赖运行时是否提供 `toSorted`，用「装饰 → 排序 → 还原」手工保证稳定。

const ACCOUNT_PROVIDER = 'deepseek-account'
const OFFICIAL_PROVIDER = 'deepseek-official'

/**
 * 把 `deepseek-account` 与 `deepseek-official` 两组提到最前，其余保持原序。
 * @param groups - 目录顺序的提供方分组（只要求有 `id`）。
 * @returns 新的数组（不改入参）；组内顺序不变。
 */
export function orderModelProviders<T extends { readonly id: string }>(groups: readonly T[]): T[] {
  const rankOf = (group: T): number =>
    group.id === ACCOUNT_PROVIDER ? 0 : group.id === OFFICIAL_PROVIDER ? 1 : 2
  return groups
    .map((group, index) => ({ group, index, rank: rankOf(group) }))
    .sort((left, right) => (left.rank - right.rank) || (left.index - right.index))
    .map((entry) => entry.group)
}
