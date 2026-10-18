// **折叠动效**（对应上游 0.2.1 的折叠过渡；本插件只做"能安全做的那一半"，见下）。
//
// 上游把这套东西做成了一台**帧时钟**：一个批次里所有要收起的盒子在同一帧上一起动（淡出 70ms，
// 盒子高度随后 110ms 收到 0），滚动的落点由"读者意图"决定（贴底就落到新的底部，否则留在原地），
// 批次进行中还能被"又该贴底了"改写目标。那套实现与 React 的布局时序绑得很紧，插件这边不照搬。
//
// 插件的现状与取舍：
//   · **"留在原地"这一半已经成立** —— `core/follow.ts` 的 `settle()` 在非贴底时按锚行补回差值、
//     贴底时重新钉到底部；也就是说**收起造成的布局位移已经被抵消**（这正是上游底部差额要解决的问题）。
//   · **缺的是过渡本身**：收起是一瞬间的。这里用 Web Animations API 补上"高度 + 淡出"这一段，
//     不引入帧时钟：一批节点各自结束自己的过渡（视觉上仍是一起开始的，因为它们在同一个渲染帧被触发）。
//
// 为什么不做批量改写：插件的折叠落点是**属性式隐藏**（`hidden="until-found"`，还要能被网页查找唤出），
// 没有"逐个盒子高度"这层可编排的对象；硬造一台帧时钟去驱动属性切换，复杂度远大于收益。
// 因此这里只覆盖**单次开合**：开 = 从 0 长到自然高度（淡入），合 = 从当前高度收到 0（淡出）后再隐藏。
//
// 环境不支持（无 `element.animate`，如守卫里的 DOM 桩）或读者要求减少动效时，**立即切换**，行为与改动前一致。

/** 淡出时长（毫秒）：与上游同数量级，短到不挡视线。 */
export const FOLD_FADE_MS = 70
/** 高度收起 / 展开时长（毫秒）。 */
export const FOLD_SIZE_MS = 110
/** 缓动：与上游同一条曲线。 */
export const FOLD_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'

/** 动效所需的最小元素形状（`HTMLElement` 的子集；守卫桩也能喂）。 */
interface Animatable {
    animate?: unknown
    style?: unknown
    getBoundingClientRect?: unknown
}

/**
 * 这个元素能不能跑折叠动效。
 *
 * 三条都要：① 有 `element.animate`（Web Animations）；② 有可写的行内样式；③ 有布局盒子
 * （`getBoundingClientRect` 返回正高度 —— 隐藏元素高度为 0，动起来没有意义）。
 * @param el - 待测元素（按最小形状探测，真实 DOM 也直接喂）
 * @returns 能跑时 true
 */
export function canAnimateFold(el: unknown): boolean {
    const probe = el as Animatable | null | undefined
    if (probe == null) return false
    if (typeof probe.animate !== 'function') return false
    if (probe.style == null || typeof probe.style !== 'object') return false
    if (typeof probe.getBoundingClientRect !== 'function') return false
    return true
}

/** 动效跑一次需要的最小接口（把 DOM 细节收在这里，调用方只关心"开始/结束"）。 */
export interface FoldMotionHost {
    animate?: (
        frames: readonly Record<string, string | number>[],
        options: Record<string, string | number>,
    ) => { finished?: Promise<unknown>; cancel?: () => void } | undefined
    style?: { height?: string; overflow?: string; opacity?: string }
    getBoundingClientRect?: () => { height: number }
}

/**
 * 跑一次开合过渡。
 *
 * 收起：先量当前高度 → 高度收到 0（同时淡出）→ **过渡结束后**才由调用方挂隐藏属性
 * （顺序反了就没有过渡可看：元素已经 `display:none`）。
 * 展开：调用方先去隐藏 → 这里量自然高度 → 从 0 长到自然高度。
 * @param target - 目标元素（真实 DOM；守卫里喂最小桩）
 * @param opening - true = 展开，false = 收起
 * @param done - 过渡结束（或被取消）后调用；收起时在这里挂隐藏
 * @returns 取消函数（再次开合时用来掐掉上一次）
 */
export function runFoldMotion(target: unknown, opening: boolean, done: () => void): () => void {
    if (!canAnimateFold(target)) {
        done()
        return () => {}
    }
    const el = target as FoldMotionHost
    const style = el.style as { height?: string; overflow?: string; opacity?: string }
    const previous = { height: style.height, overflow: style.overflow, opacity: style.opacity }
    const height = (el.getBoundingClientRect?.() ?? { height: 0 }).height
    const from = opening ? '0px' : `${String(height)}px`
    const to = opening ? `${String(height)}px` : '0px'
    style.overflow = 'hidden'
    if (opening) style.height = '0px'
    const animation = el.animate?.(
        [
            { height: from, opacity: opening ? 0 : 1 },
            { height: to, opacity: opening ? 1 : 0 },
        ],
        { duration: opening ? FOLD_SIZE_MS : FOLD_SIZE_MS + FOLD_FADE_MS, easing: FOLD_EASING, fill: 'none' },
    )
    let cancelled = false
    const finish = (): void => {
        if (cancelled) return
        cancelled = true
        style.height = previous.height ?? ''
        style.overflow = previous.overflow ?? ''
        style.opacity = previous.opacity ?? ''
        done()
    }
    const settled = animation?.finished
    if (settled !== undefined && typeof settled.then === 'function') {
        void settled.then(finish, finish)
    } else {
        finish()
    }
    return () => {
        if (cancelled) return
        cancelled = true
        animation?.cancel?.()
        style.height = previous.height ?? ''
        style.overflow = previous.overflow ?? ''
        style.opacity = previous.opacity ?? ''
    }
}
