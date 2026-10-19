// KaTeX 字体**只留 woff2** 的 CSS 改写（构建期用；纯函数，便于守卫直接喂真实 CSS）。
//
// 为什么需要它：`katex.min.css` 给每个字族写了三种格式（woff2 / woff / ttf），esbuild 会把
// **三种都当资源输出** —— 实测产物因此是 60 个文件、1,051KB（woff2 254KB + woff 296KB + ttf 502KB），
// 而浏览器只取 `src` 链里**第一个它支持的格式**，所以 woff / ttf **从来没被请求过**。
//
// 宿主引擎（决定“只留 woff2 够不够”）：
// ⚠️ 结尾必须同时接受 `;` 与 `}`：`katex.min.css` 里 `src:` 是**块内最后一条**声明，后面紧跟 `}`。
// 只写 `;` 会 0 处命中。
const SRC_DECL = /src:([^;{}]+)([;}])/g
const WOFF2_ENTRY = /url\([^)]*\.woff2[^)]*\)\s*format\("woff2"\)/

/**
 * 把一份 CSS 里每个 `src:` 的 fallback 链收窄成**只剩 woff2 那一项**。
 * @param css - 原始 CSS 文本（通常是 `katex.min.css`）
 * @returns 改写后的 CSS（没有 woff2 项的声明原样保留）
 */
export function woff2Only(css) {
  return css.replace(SRC_DECL, (whole, list, tail) => {
    const hit = WOFF2_ENTRY.exec(list)
    return hit === null ? whole : `src:${hit[0]}${tail}`
  })
}
