// 正文块级渲染：把 markdown 切成顶层块，每块一个稳定 key 的容器。
//
// 为什么要分块：流式正文每帧都在长，若整段 `dangerouslySetInnerHTML`，整棵子树被重建 ——
// 已渲染的代码块 / 图片 / 长段落跟着重建，观感就是「正文一跳一跳地闪」。分块后只有
// **尾部还在长的那一两块**换内容，前面的块 HTML 逐字相同 → 渲染层按 key 复用 DOM，只写变化那块。
//
// 只服务回答正文（`AssistantRow`）。思考行**不**走这里 —— 思考展开体是纯文本（对齐上游
// `thinkBody`），见 `components/chain/ReasoningRow`；旧「compact 变体」曾为思考行服务，随思考
// 改纯文本一并移除（`variant` 参数与 `.md-compact` 类已无生产者）。
import { html } from 'htm/preact'
import { useMemo, useRef } from 'preact/hooks'
import { MdStream, renderMd } from '../../core/markdown'

/**
 * markdown 渲染体。
 * @param text - markdown 原文
 * @param streaming - 是否还在流式（走块级增量；定稿走整段一次，可自愈跨块的参考式链接/脚注）
 */
export function MessageBody({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const streamRef = useRef<MdStream | null>(null)
  const streamed = useMemo(() => {
    if (!streaming) return null
    if (streamRef.current === null) streamRef.current = new MdStream()
    return streamRef.current.update(text)
  }, [text, streaming])
  // 定稿：整段渲染一次（幂等，只在 text 变时重算）
  const settled = useMemo(() => (streaming ? null : renderMd(text)), [text, streaming])
  if (settled !== null) {
    return html`<div class="md"><div dangerouslySetInnerHTML=${{ __html: settled }}></div></div>`
  }
  return html`<div class="md">
    ${(streamed ?? []).map((b) => html`<div key=${b.key} dangerouslySetInnerHTML=${{ __html: b.html }}></div>`)}
  </div>`
}
