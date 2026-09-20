// 历史分页的纯函数（宿主与页面各用一个，脚本可逐形状断言）。
//
// 为什么抽出来：
//   · 前插锚定（`anchoredTopAfterPrepend`）——前插会把内容往下推，读者眼前的东西被挤走，
//     补回多少是可以算准的（旧高度差），不该靠试；
//   · `TrimEnd` 只是**类型口径**（裁剪方向），当前实现里窗口**不裁剪**（见
//     `history-window.ts` 的类注释），保留它是为了让"方向"这个概念与调用方形状稳定。
// 两处都是"算错就看着像坏了"的地方，故与副作用分开、各自可测。

/**
 * 裁剪方向：`oldest` = 丢掉最老的一段（保留最近的一段）；`newest` = 丢掉最新的一段（把可见范围往过去推）。
 *
 * **当前没有任何调用方**：窗口不按条数裁剪（与上游一致，见 `history-window.ts`）。
 */
export type TrimEnd = 'oldest' | 'newest'

/**
 * 前插之后，读者原本的滚动位置应当补到哪儿。
 *
 * @param before - 前插**之前**记下的 `{ height: scrollHeight, top: scrollTop }`
 * @param afterHeight - 前插之后的新 `scrollHeight`
 * @param maxTop - 新的可滚上界（`scrollHeight - clientHeight`）
 * @returns 新的 `scrollTop`（已夹到 `[0, maxTop]`）
 *
 * 为什么是「旧 top + 高度差」：内容在前插处插入了 `Δ = afterHeight - before.height` 像素，
 * 浏览器保持 `scrollTop` 不变 → 读者看到的那一行被下推了 `Δ`。把 `scrollTop` 也加 `Δ`，
 * 读者就停在原来那一行上。
 */
export function anchoredTopAfterPrepend(
    before: { height: number; top: number },
    afterHeight: number,
    maxTop: number
): number {
    const grew = afterHeight - before.height;
    if (grew <= 0) {
        return Math.max(0, Math.min(before.top, maxTop));
    }
    return Math.max(0, Math.min(before.top + grew, maxTop));
}
