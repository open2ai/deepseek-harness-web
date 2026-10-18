// 带凭据遮挡的文本（一处渲染，三处共用：消息气泡、排队消息、发送中回显）。
//
// 形态对齐上游：被遮的值**保持原字符**（复制、读屏都拿到原文），只是画成居中的 `*`；
// 交互文本在**同一行**末尾给一颗小眼睛 —— 遮着时是"睁眼"（点了显示），显示后是"划掉的眼"（点了重新遮）。
// 图标用内联 SVG（上游同款路径），不依赖 codicon 字体、也不用任何 tooltip（`title`）—— 提示只走 `aria-label`。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { maskCredentials } from '../../core/secret-mask'
import type { RefSnap } from '../../core/store/types'
import { refText } from './ref-text'

/** 眼睛轮廓（与上游同一条路径，16×16 视口）。 */
const EYE_CONTOUR = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
/** 睁眼：轮廓 + 瞳孔。 */
const EYE_PATH = `${EYE_CONTOUR}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`
/** 划掉的眼：轮廓 + 斜杠（去掉瞳孔，小尺寸下才分得清）。 */
const EYE_OFF_PATH = `${EYE_CONTOUR}M2.5 2.5L13.5 13.5`

/**
 * 一段可能含凭据的文本。
 * @param props.text - 原文（显示时按需遮挡）
 * @param props.refs - `@` 引用贴片的本地快照（消息气泡用；排队消息没有）
 */
export function SecretText({ text, refs }: { text: string; refs?: RefSnap[] }) {
    const masked = maskCredentials(text)
    // 记**已显示的原文**而不是布尔：同一位置换成另一条凭据时自动回到遮挡态（与上游同）
    const [revealedRaw, setRevealedRaw] = useState<string | undefined>()
    const revealed = revealedRaw === text
    const shown = revealed ? text : masked
    return html`<span class="secret-text" data-secret=${masked === text ? undefined : ''}>
    ${refs === undefined ? shown : refText(shown, refs)}${masked === text
      ? null
      : html`<button type="button" class="secret-toggle" aria-pressed=${revealed}
          aria-label=${revealed ? '重新遮挡凭据原文' : '显示凭据原文'}
          onClick=${() => setRevealedRaw(revealed ? undefined : text)}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
            stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
            <path d=${revealed ? EYE_OFF_PATH : EYE_PATH}></path>
          </svg>
        </button>`}
  </span>`
}
