// 思考行（Disclosure 形态），与网页端的同一个组件逐项对齐：
//   收起 = 一行摘要 —— 定稿/历史取**首行**，流式(live)取**最新"已完成"段落的首行**（右对齐跟随思考尾部，
//          `data-follow-end`；不是"最新一行"，逐行照搬上游 `latestCompletedParagraphFirstLine`）；
//   展开 = **纯文本**全文（`white-space: pre-wrap`，`**加粗**` 这类标记原样显示、不解析成 markdown）
//          —— 上游 `thinkBody` 就是 `<div>{text}</div>` + pre-wrap，本插件此前误走 markdown 渲染；
//   running 态 = 行首套 `data-state='running'` 触发掠光带（`.chain-row-head[data-state='running']::after`，
//          已在 chain.css 里、与工具行共用），上游是 `data-state={running ? 'running' : 'ok'}`。
//   **思考过程机器翻译**（0.2.2 实验插件 `client-ui-cot-translation` 的等价形态）：展开时若宿主翻译
//          服务可用，正文默认显示译文、工具条给「查看原文 / 查看译文」；流式只翻完整段、按段缓存，
//          失败显示原文 + 重试。入口不可用（宿主插件没启用）时完全隐藏。
// 收起态只渲染标题行，行高由标题行决定；全文只在展开时进 DOM（与上游"展开即渲染"同）。
import { html } from 'htm/preact'
import { memo } from 'preact/compat'
import { useEffect, useRef, useState } from 'preact/hooks'
import { reasoningText } from '../../core/reasoning-text'
import { ReasoningTranslation, type CotLimits, type CotViewState } from '../../core/cot'
import type { ChatStore, DshTurnProcessItem } from '../../core/store/chat'

type Reasoning = Extract<DshTurnProcessItem, { kind: 'reasoning' }>

/** 上游 auto 跟随 UI 语言：优先用宿主注入的 <html lang>，而不是 sidex/webview 的 navigator.language。 */
function uiLanguage(store?: ChatStore): string {
  const preferred = store?.locale.value
  if (typeof preferred === 'string' && preferred.trim() !== '') {
    const value = preferred.trim()
    return value.toLowerCase().startsWith('zh') ? 'zh-CN' : value
  }
  const raw =
    (typeof document === 'undefined' ? '' : document.documentElement.lang) ||
    (typeof navigator === 'undefined' ? '' : navigator.language) ||
    'zh-CN'
  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : raw
}

/** 收起预览（定稿/历史）= **首行**（上游 `firstLine`：不 trim、不跳过空行）。 */
const firstLine = (text: string): string => {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * 收起预览（流式 live）= **最新"已完成"段落的首行**（逐行移植上游 `latestCompletedParagraphFirstLine`）。
 *
 * 段落按空行切；"已完成" = 该段已经出现过换行（尾段还在长、连第一行都没写完时不抢镜）。
 * 与旧的"最新一行"不同：同一段里不会跟着尾巴滚，显示的是该段首行（真机对照网页端）。
 */
const latestCompletedParagraphFirstLine = (text: string): string => {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  for (;;) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

interface ReasoningProps {
  item: Reasoning
  store: ChatStore
  live?: boolean
  /**
   * 是否在标题旁预览首行（上游四档策略门：`settledReasoningPreview` / `liveProcessDetail`）。
   * 缺省 true = 显示（读不到偏好时维持接入前形态）。
   */
  showPreview?: boolean
}

function ReasoningRowView({ item, store, live, showPreview = true }: ReasoningProps) {
  const [open, setOpen] = useState(false) // 默认收起(一行摘要)；点开看全文
  /** 翻译服务可用性：undefined = 还没问；null = 宿主没装/启用（不显示入口）；对象 = 可用。 */
  const [cotLimits, setCotLimits] = useState<CotLimits | null | undefined>(undefined)
  const [translation, setTranslation] = useState<CotViewState | null>(null)
  /** true = 正在看原文（默认与上游一致：展开即看译文；失败时强制原文）。 */
  const [showOriginal, setShowOriginal] = useState(false)
  const controller = useRef<ReasoningTranslation | undefined>(undefined)
  const cotRequested = useRef(false)
  // 显示文本：剥掉模型返回的签名段（逐条对齐上游 rc.5 `ReasoningRow`）。
  // **数据层 `item.text` 保持原始**，与上游"rawText 留在数据里"同构 —— 这样
  // `hasReasoning`/`inlineReasoning`/链项数据的判据都不变，只有显示被剥。
  const text = reasoningText(item.text)
  // 上游同一条件：只有"剥过且剥完为空"才隐藏（原本就空的文本不归这条管）。
  const hidden = text !== item.text && text.trim() === ''
  // 收起摘要剥掉 markdown 加粗符号 `**`（如 `**重点**`→`重点`）；**展开全文不动**（上游同：summary 才剥）
  const preview = (live ? latestCompletedParagraphFirstLine(text) : firstLine(text)).replaceAll('**', '')

  /**
   * 展开时才创建翻译控制器（上游同样是"展开的思考内容才翻译"）：收起即取消在飞请求，
   * 再次展开重新取 limits（宿主翻译插件可能刚被开关）。
   */
  useEffect(() => {
    if (!open) {
      controller.current?.dispose()
      controller.current = undefined
      setTranslation(null)
      return
    }
    if (cotRequested.current) return
    cotRequested.current = true
    void store.cot.limits().then((value) => {
      setCotLimits(value ?? null)
      // 取不到也允许下次展开重试（插件可能刚启用）；取得到就不再重复问
      if (value === undefined) cotRequested.current = false
    })
  }, [open, store])

  useEffect(() => {
    if (!open || cotLimits === undefined || cotLimits === null) return
    const selection = cotLimits.preferences
    const targetLanguage = selection.targetLanguage === 'auto' ? uiLanguage(store) : selection.targetLanguage
    const instance = new ReasoningTranslation(
      { provider: selection.provider, targetLanguage },
      cotLimits.maxTextChars,
      (request) => store.cot.translate(request),
      (state) => setTranslation(state),
    )
    controller.current = instance
    instance.update(text, live === true)
    return () => {
      instance.dispose()
      if (controller.current === instance) controller.current = undefined
    }
  }, [open, cotLimits, store])

  // 流式正文继续增长 / 定稿：只更新源文本，不重建控制器（缓存与并发都留在同一个生命周期里）
  useEffect(() => {
    controller.current?.update(text, live === true)
  }, [text, live])

  if (hidden) return null
  const failed = translation?.failed === true
  const original = showOriginal || failed
  return html`<div class="chain-disclosure">
    <button class="chain-row-head" data-state=${live ? 'running' : 'ok'} onClick=${() => setOpen((o) => !o)} aria-expanded=${open} title=${preview || ''}>
      <span class=${'codicon chain-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
      <span class="codicon codicon-lightbulb chain-kind-ico"></span>
      <span class="chain-row-title">思考</span>
      ${open || !showPreview || !preview ? null : html`<span class="chain-sep" aria-hidden></span>
        <span class="chain-row-preview" data-follow-end=${live ? '' : undefined}><span class="chain-row-preview-text">${preview}</span></span>`}
    </button>
    ${open
      ? html`<div class="chain-reason is-open">
          ${cotLimits === undefined || cotLimits === null
            ? null
            : html`<div class="chain-cot-toolbar" data-cot-translation data-translation-view=${original ? 'original' : 'translated'}
                data-translation-state=${failed ? 'failed' : translation?.pending === true ? 'pending' : 'ready'}>
                <button type="button" class="chain-cot-toggle" disabled=${failed}
                  onClick=${() => setShowOriginal(!original)}>${original ? '查看译文' : '查看原文'}</button>
                ${translation?.pending === true
                  ? html`<span class="chain-cot-spin codicon codicon-loading codicon-modifier-spin" role="status" aria-label="正在翻译思考内容"></span>`
                  : null}
                ${failed
                  ? html`<span class="chain-cot-fail" role="status">翻译暂不可用，已显示原文</span>
                      <button type="button" class="chain-cot-retry" onClick=${() => controller.current?.retry()}>重试</button>`
                  : null}
              </div>`}
          <div class="chain-cot-text">${original ? text : (translation?.text ?? text)}</div>
        </div>`
      : null}
  </div>`
}

/**
 * 组件层跳渲：流式期间每一帧都会重建链上的 vnode，不加这层的话所有思考行都跟着重渲一遍
 * （`live` 每帧都可能变、`item.text` 也在长）。只比两项：只有真正在涨的那行会重渲。
 * 比 `item.text` 而不比 `item`：链项在每次整表构建时都会**重建对象**（宿主侧 `buildRows` 重跑），
 * 按引用比等于永远不等、这层就白加了。
 */
export const ReasoningRow = memo(
  ReasoningRowView,
  (a: ReasoningProps, b: ReasoningProps) => a.item.text === b.item.text && a.live === b.live
)
