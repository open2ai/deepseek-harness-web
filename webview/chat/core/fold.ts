// 卡体长内容折叠：首尾各留一半 + 中间换成「… 其余 n 行」按钮（上游 head-tail-cap 的聊天面口径）。
//
// 为什么设上限：对话框是**摘要面**，同一轮可能有多次工具调用，全量铺开会把消息流冲垮；
// 详情面（上游是独立 details 面板）才看全量。差异/读文件/搜索三类卡都用这个上限；
// **终端卡不走这里**——它的输出改成自适应宽高（终端卡自己处理折叠）。

/**
 * 三张卡各自的折叠上限（逐条取上游常量，**别合并成一个数**）：
 * `diff-card-model.ts` 的 `CHAT_DIFF_MAX_LINES = 9`、`read-card-model.ts` 的 `CHAT_READ_MAX_LINES = 8`、
 * `search-card-model.ts` 的 `CHAT_SEARCH_MAX_LINES = 8`。差异卡是 9 —— 曾按「三者同为 8」写成 8，差一行。
 */
export const CHAT_DIFF_MAX_LINES = 9
export const CHAT_READ_MAX_LINES = 8
export const CHAT_SEARCH_MAX_LINES = 8

/** 默认上限（读文件/搜索用；差异卡显式传 {@link CHAT_DIFF_MAX_LINES}）。 */
export const CHAT_BLOCK_MAX_LINES = CHAT_READ_MAX_LINES

export interface HeadTail<T> {
  head: T[]
  tail: T[]
  /** 被折叠掉的行数；0 表示未超限，调用方据此决定是否渲染展开按钮 */
  hidden: number
  /** 是否超限（= hidden > 0） */
  capped: boolean
}

/**
 * 把行序列按上限切成首/尾两段。未超限时 head 即全部、tail 为空、hidden 为 0。
 * @param rows - 已扁平化的行。
 * @param maxLines - 保留上限，缺省 {@link CHAT_BLOCK_MAX_LINES}。
 * @param expanded - 已展开时不做折叠（head 为全部）。
 */
export function headTail<T>(rows: readonly T[], maxLines = CHAT_BLOCK_MAX_LINES, expanded = false): HeadTail<T> {
  const hidden = rows.length - maxLines
  if (hidden <= 0 || expanded) {
    return { head: [...rows], tail: [], hidden: Math.max(0, hidden), capped: hidden > 0 }
  }
  // 首段取上限的一半向上取整（上限为奇数时首段多一行）
  const headCount = Math.ceil(maxLines / 2)
  return {
    head: rows.slice(0, headCount),
    tail: rows.slice(rows.length - (maxLines - headCount)),
    hidden,
    capped: true,
  }
}

/** 折叠按钮文案（zh 原文取自上游字典：common `collapse` + `*.expandRest`，三类卡同字面）。 */
export interface FoldLabels {
  collapse: string
  expandRest: (hidden: number) => string
}

export function foldLabels(): FoldLabels {
  return {
    collapse: '收起',
    expandRest: (hidden) => `… 其余 ${hidden} 行`,
  }
}

/**
 * 折叠控件的**无障碍名**（逐字取上游 zh 字典：`diff|read|search.collapseAria` / `*.expandAria`）。
 *
 * 上游把它挂在 DiffBlock/ReadBlock/SearchBlock 原语的折叠按钮上；插件的对应按钮此前只有
 * `aria-expanded`、**没有可读名字**（读屏只会念「按钮」）—— 这是无障碍缺口，不是外观问题。
 * 三类的措辞确实不同（差异 / 内容 / 结果），别合并成一句。
 */
export const FOLD_ARIA = {
  diff: { collapse: '收起差异', expand: (hidden: number): string => `展开其余 ${hidden} 行差异` },
  read: { collapse: '收起内容', expand: (hidden: number): string => `展开其余 ${hidden} 行` },
  search: { collapse: '收起结果', expand: (hidden: number): string => `展开其余 ${hidden} 行结果` },
} as const
