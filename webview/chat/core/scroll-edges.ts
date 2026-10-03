// 分组体（可滚动过程区）的**两端渐隐**判据 —— 独立纯函数文件（判据只写这一处）。
//
// 上游 `.body` 的做法：封顶 `max-height: min(400px, 50vh)` + `overflow-y: auto` + `scrollbar-gutter: stable`；
// 两端渐隐是 `mask-image` 的 24px 渐变（`fadeTop` / `fadeBottom`，两条都有时合成一条）。
// 边判定：`canScrollUp = top > 1`、`canScrollDown = top < floor - 1`，其中
// `floor = max(0, scrollHeight - clientHeight)`；那 1px 是容差（与上游滚动跟随的阈值同一量级）。
// 内容没超出视口时 floor = 0 → 两端都为假（不渐隐）；`verbose`（不分组）时不封顶、不渐隐。
//
// 这里只做**算术**：读取元素尺寸与挂监听留在组件里（判据可单测，接线由守卫钉）。

/** 判定边界的 1px 容差（上游同）。 */
export const SCROLL_EDGE_TOLERANCE = 1

export interface ScrollEdges {
  /** 上方还有内容（顶部已滚出视口） */
  up: boolean
  /** 下方还有内容（底部还没滚到） */
  down: boolean
}

/**
 * 由滚动三量算出两端是否还有内容。
 * @param top - `scrollTop`。
 * @param clientHeight - 视口高度（`clientHeight`）。
 * @param scrollHeight - 内容高度（`scrollHeight`）。
 */
export function scrollEdges(top: number, clientHeight: number, scrollHeight: number): ScrollEdges {
  const floor = Math.max(0, scrollHeight - clientHeight)
  return {
    up: top > SCROLL_EDGE_TOLERANCE,
    down: top < floor - SCROLL_EDGE_TOLERANCE,
  }
}
