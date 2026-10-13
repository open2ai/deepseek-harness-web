/**
 * 代码块工具栏的四个图标 —— **逐字节取自上游 artwork**（不是近似自绘）。
 *
 * 出处：`packages/client/ui-primitives/src/icons/index.tsx` 的 `IconWrapFillArtwork` /
 * `IconNowrapFillArtwork` / `IconCopyOutlineArtwork` / `IconCheckOutlineArtwork`；
 * 用法出处：同包的 `CodeToolbar.tsx:49-58` —— 上游在那里用 `size={14}`，
 * 且**换行按钮按 `wrapped` 在 Wrap/Nowrap 之间二选一、复制按钮按 `copied` 在 Copy/Check 之间二选一**。
 *
 * 插件为什么把四个都放进 DOM、用 CSS 显隐切换（而不是像上游那样按状态二选一渲染）：
 * 工具栏是**靠事件委托**工作的（`core/code-toolbar.ts`，见那里的理由），点一下只改
 * `.md-code` 上的 `data-code-wrap`，**不动 vdom** —— 用 CSS 显隐就不必在点击时拼 SVG 字符串，
 * 也天然避免了"重渲染把就地改的状态冲掉"。
 *
 * `width/height` 已按上游的 `size={14}` 定死；`stroke-width` 按上游 Regular 档的 1。
 * 守卫 `tmp/_codecard.render.test.mjs` 会拿这四个串与上游文件逐字节比对。
 */

/** 自动换行图标（换行**关闭**时显示，点它开启换行）（上游 `IconWrapFillArtwork`）。 */
export const CODE_ICON_WRAP =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10.9999 8C10.9999 6.89543 10.1046 6 9 6H4.5V5H9C10.6568 5 11.9999 6.34315 11.9999 8C11.9999 9.65685 10.6568 11 9 11H6.20703L6.85351 11.6465L6.14648 12.3535L4.64652 10.8536C4.45126 10.6583 4.45126 10.3417 4.64652 10.1464L6.14648 8.64648L6.85351 9.35352L6.20703 10H9C10.1046 10 10.9999 9.10457 10.9999 8Z" fill="currentColor" /><path d="M2 15H1V1H2V15Z" fill="currentColor" /><path d="M15 15H14V1H15V15Z" fill="currentColor" /></svg>'

/** 取消自动换行图标（换行**开启**时显示，点它关闭换行）（上游 `IconNowrapFillArtwork`）。 */
export const CODE_ICON_NOWRAP =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 15H1V1H2V15Z" fill="currentColor" /><path d="M12.3535 7.64645C12.5487 7.84171 12.5487 8.15829 12.3535 8.35355L9.85352 10.8535L9.14648 10.1465L10.793 8.5H3.5V7.5H10.793L9.14648 5.85352L9.85352 5.14648L12.3535 7.64645Z" fill="currentColor" /><path d="M15 15H14V1H15V15Z" fill="currentColor" /></svg>'

/** 复制图标（上游 `IconCopyOutlineArtwork`）。 */
export const CODE_ICON_COPY =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"><rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor" /><path d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z" fill="currentColor" /></svg>'

/** 复制成功图标（1 秒后复位）（上游 `IconCheckOutlineArtwork`）。 */
export const CODE_ICON_CHECK =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"><path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" /></svg>'
