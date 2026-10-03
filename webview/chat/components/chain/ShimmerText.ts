// 文字微光（运行中文案用）：**真实文字始终可见**，掠光只是叠在上面的一层装饰。
//
// 这是本插件唯一实现微光的地方（运行状态行与折叠头都走它），因为踩过一次：
// 早先的写法把文字本身设成 `color: transparent` 再拿渐变当"字色"，一旦渐变没铺满
// （`background-repeat: no-repeat` + 位移扫动），字就**整段看不见**了 —— 真机反馈
// 「文字闪但是会消失，上游的始终看得到」。
//
// 现在的结构（与网页端同技术）：
//   · `.shimmer-base`       = 真实文字，继承语义色，任何时刻都在；
//   · `.shimmer-decoration` = 覆盖层，`aria-hidden`、不可选中、不接收指针；
//   · `.shimmer-sweep`      = 带遮罩的扫光带，用 `data-shimmer-text` + `::after` 复制同一句文字。
// 于是装饰层出任何问题都只表现为「没有掠光」，**不会**表现为「没有文字」。
// 回退（减少动效 / 高对比 / 无遮罩）见 `styles/shimmer.css`：一律只隐藏装饰层。
import { html } from 'htm/preact'

/**
 * 一句带（可选）掠光的文字。
 * @param text - 要显示的文字。
 * @param className - 外层类名（调用方的排版类）。
 * @param active - 是否加掠光；false 时只渲染普通文字（不多一层 DOM）。
 */
export function ShimmerText({ text, className, active }: { text: string; className?: string; active: boolean }) {
  const base = className ?? ''
  if (!active) return html`<span class=${base}>${text}</span>`
  return html`<span class=${base === '' ? 'shimmer-text' : base + ' shimmer-text'}>
    <span class="shimmer-base">${text}</span>
    <span class="shimmer-decoration" aria-hidden="true">
      <span class="shimmer-sweep" data-shimmer-text=${text}></span>
    </span>
  </span>`
}
