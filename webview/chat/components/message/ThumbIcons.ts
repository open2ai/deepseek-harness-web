// 动作条三个图标：**好的回答 / 有问题的回答 / 分叉**（版本与行号对照见 `details/upgrade/10` §8）。
//
// 三者共用的形状：`viewBox 0 0 16 16`、svg 上 `fill="none"`、`stroke-width=1`、路径用 `currentColor` 描边。
// 拇指**未评只有描边、已评同一条路径再加 `fill`**（实心）；分叉是两条路径 + 两个圆，全部描边、无填充。
// 尺寸由 CSS 给（`.msg-actions button svg` / `.fb-btn svg`，见 `styles/chat.css`）；颜色取 `currentColor`。
import { html } from 'htm/preact'

/** 「好的回答」轮廓（未评 / 已评共用同一条路径，已评再加填充）。 */
const LIKE_PATH = 'M13.537 8.12098L12.3983 12.8455C12.1818 13.7438 11.378 14.3769 10.454 14.3769L9.35595 14.3769H7.43799H5.16577C3.50892 14.3769 2.16577 13.0337 2.16577 11.3769V7.88668C2.16577 7.33439 2.61349 6.88668 3.16577 6.88668H4.02665C5.84943 6.88668 7.38083 3.28711 7.67689 2.54578C7.71259 2.45639 7.73501 2.36373 7.77922 2.27824C7.86506 2.11221 8.08228 1.87578 8.59039 2.07775C10.3291 2.76886 9.23144 6.04071 8.96955 6.75058C8.94502 6.81707 8.99495 6.88668 9.06581 6.88668H12.5648C13.2119 6.88668 13.6886 7.49192 13.537 8.12098Z'

/** 「有问题的回答」轮廓（未评 / 已评共用同一条路径，已评再加填充）。 */
const DISLIKE_PATH = 'M2.46302 8.06749L3.60171 3.34299C3.81822 2.44467 4.62196 1.81162 5.546 1.8116L6.64406 1.81158L8.56202 1.81158L10.8342 1.81158C12.4911 1.81158 13.8342 3.15473 13.8342 4.81158L13.8342 8.3018C13.8342 8.85408 13.3865 9.3018 12.8342 9.3018L11.9734 9.3018C10.1506 9.3018 8.61918 12.9014 8.32311 13.6427C8.28741 13.7321 8.26499 13.8247 8.22078 13.9102C8.13494 14.0763 7.91772 14.3127 7.40961 14.1107C5.67089 13.4196 6.76856 10.1478 7.03045 9.43789C7.05498 9.37141 7.00505 9.3018 6.93419 9.3018L3.43519 9.3018C2.78811 9.3018 2.31141 8.69656 2.46302 8.06749Z'

/** 分叉：两条主干（分叉线）+ 两个端点圆，全部描边。 */
const BRANCH_UPPER = 'M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564'
const BRANCH_LOWER = 'M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944'
/** 端点圆（右上 / 右下）：半径与圆心是定值（见下面的常量）。 */
const BRANCH_NODE_R = 1.56962
const BRANCH_NODE_X = 12.4502
const BRANCH_NODE_TOP_Y = 3.3079
const BRANCH_NODE_BOTTOM_Y = 12.6921

/** 分叉（在新对话中分支）：线稿、无填充。 */
export function BranchIcon() {
  return html`<svg viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true">
    <path d=${BRANCH_UPPER} stroke="currentColor" />
    <path d=${BRANCH_LOWER} stroke="currentColor" />
    <circle cx=${BRANCH_NODE_X} cy=${BRANCH_NODE_TOP_Y} r=${BRANCH_NODE_R} stroke="currentColor" />
    <circle cx=${BRANCH_NODE_X} cy=${BRANCH_NODE_BOTTOM_Y} r=${BRANCH_NODE_R} stroke="currentColor" />
  </svg>`
}

/** 好的回答：未评线稿 / 已评实心（同一条路径）。 */
export function ThumbUpIcon({ filled }: { filled: boolean }) {
  return html`<svg viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true">
    ${filled
      ? html`<path d=${LIKE_PATH} fill="currentColor" stroke="currentColor" />`
      : html`<path d=${LIKE_PATH} stroke="currentColor" />`}
  </svg>`
}

/** 有问题的回答：未评线稿 / 已评实心（同一条路径）。 */
export function ThumbDownIcon({ filled }: { filled: boolean }) {
  return html`<svg viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true">
    ${filled
      ? html`<path d=${DISLIKE_PATH} fill="currentColor" stroke="currentColor" />`
      : html`<path d=${DISLIKE_PATH} stroke="currentColor" />`}
  </svg>`
}
