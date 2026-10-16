import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import katex from 'katex'
// 代码块工具栏的四个图标：**逐字节取自上游 artwork**（不是近似自绘；尺寸那一档是 14）。
// 图标串本身在 `./code-icons`（与上游 artwork 逐字节同形）。
import { CODE_ICON_CHECK, CODE_ICON_COPY, CODE_ICON_NOWRAP, CODE_ICON_WRAP } from './code-icons'
// 样式在**入口**引入（`chat.ts`）：这里只留 JS 依赖，Node 侧守卫打包本模块时不会牵进字体资源。
// 上游在 内联引 CSS；插件按自己的打包方式把这条挪到入口，效果同（样式仍在同一份 chat.css 里）。

// 与旧 chat.ts 一致:禁用原生 HTML、自动链接、回车即换行。
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/**
 * TeX → HTML。**三档错误链与上游 `renderTexToReact` 逐档一致**：
 *   ① `throwOnError: true`（严格渲染）；
 *   ② 失败 → `strict: 'ignore', throwOnError: false` 重试（把不可识别的命令降级成红字而不是整块失败）；
 *   ③ 仍抛（KaTeX 内部错，不是 ParseError）→ 自己出一段 `.katex-error` 原文（与上游同款结构）。
 * 插件渲染的是 HTML 字符串，所以直接取 KaTeX 的输出即可 —— 上游是把它用 DOMParser 转成 React 元素树，
 * 那一步是为了塞进 React，这里的链路本就吃 HTML，无需转。
 * @param value - TeX 源码。
 * @param displayMode - 行间（块级）还是行内。
 * @returns KaTeX 输出的 HTML 片段。
 */
function renderTex(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, { displayMode, throwOnError: true })
  } catch (error) {
    try {
      return katex.renderToString(value, { displayMode, strict: 'ignore', throwOnError: false })
    } catch {
      return `<span class="katex-error" style="color:#cc0000" title="${escapeHtml(String(error))}">${escapeHtml(value)}</span>`
    }
  }
}

/**
 * 代码块工具栏文案（逐字取上游 zh 字典：`codeBlock.title|wrap|unwrap` + `copy|copied`）。
 * 上游由 `CodeToolbar` 渲染，文案经 `primitive-labels.ts` 的 `codeToolbarLabels` 注入。
 */
export const CODE_TOOLBAR_LABELS = {
  code: '代码块',
  wrap: '自动换行',
  unwrap: '取消自动换行',
  copy: '复制',
  copied: '复制成功',
} as const

/**
 * **行内数学**：`$…$` 与 `\(…\)`。
 *
 * 定界规则照上游那套（`micromark-extension-math` 的美元语法 + `mathCompatibility.ts` 补的 TeX 反斜杠定界）：
 *   · 开定界符后**不能是空白**，闭定界符前**不能是空白**（避免把「价格 $5 与 $6」这类普通文本当公式）；
 *   · 闭定界符后**不能紧跟数字**（`$x$2` 不是公式）；
 *   · 内容不能跨空行（跨段就不是行内公式了）。
 * 不满足就**不消费**（返回 false 交回后续规则），宁可当普通文本，也不猜。
 */
function mathInline(state: any, silent: boolean): boolean {
  const start = state.pos
  const src = state.src
  const marker = src[start]
  let open = ''
  if (marker === '$') open = '$'
  else if (marker === '\\' && src[start + 1] === '(') open = '\\('
  else return false
  const close = open === '$' ? '$' : '\\)'
  const from = start + open.length
  // 开定界符后不能是空白（也不接受空内容）
  if (from >= src.length || /\s/.test(src[from] as string)) return false
  let at = from
  while (at < src.length) {
    const next = src.indexOf(close, at)
    if (next === -1) return false
    if (next === from) return false // 空公式
    const prev = src[next - 1] as string
    const after = src[next + close.length]
    const blank = src.slice(from, next).includes('\n\n')
    const ok = !/\s/.test(prev) && !(close === '$' && after !== undefined && /[0-9]/.test(after)) && !blank
    if (ok) {
      if (!silent) {
        const token = state.push('math_inline', 'math', 0)
        token.content = src.slice(from, next)
        token.markup = open
      }
      state.pos = next + close.length
      return true
    }
    at = next + 1
  }
  return false
}

/**
 * **块级数学**：整行 `$$` 包起来，或 `\[…\]` 包起来。
 * 只在**独立成块**时成立（行首可缩进 ≤3 空格），与上游把 `$$` 当块级 TeX 的口径一致。
 */
function mathBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  const begin = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  const line = state.src.slice(begin, max)
  const dollar = line.startsWith('$$')
  const bracket = line.startsWith('\\[')
  if (!dollar && !bracket) return false
  const openLen = 2
  const closeRe = dollar ? /\$\$\s*$/ : /\\\]\s*$/
  // 同一行收口：`$$x$$`
  const sameLine = line.slice(openLen)
  if (closeRe.test(sameLine) && sameLine.replace(closeRe, '').trim() !== '') {
    if (silent) return true
    const token = state.push('math_block', 'math', 0)
    token.content = sameLine.replace(closeRe, '')
    token.markup = dollar ? '$$' : '\\['
    token.map = [startLine, startLine + 1]
    state.line = startLine + 1
    return true
  }
  if (sameLine.trim() !== '' ) return false
  for (let next = startLine + 1; next < endLine; next += 1) {
    const b = state.bMarks[next] + state.tShift[next]
    const e = state.eMarks[next]
    if (closeRe.test(state.src.slice(b, e))) {
      if (silent) return true
      const token = state.push('math_block', 'math', 0)
      token.content = state.src.slice(state.eMarks[startLine], b).replace(/\n$/, '')
      token.markup = dollar ? '$$' : '\\['
      token.map = [startLine, next + 1]
      state.line = next + 1
      return true
    }
  }
  return false
}

md.inline.ruler.before('escape', 'math_inline', mathInline)
md.block.ruler.before('fence', 'math_block', mathBlock)
md.renderer.rules['math_inline'] = (tokens, idx) => renderTex(tokens[idx]?.content ?? '', false)
md.renderer.rules['math_block'] = (tokens, idx) => renderTex(tokens[idx]?.content ?? '', true)

/** HTML 转义（围栏内容自渲染后要自己转，markdown-it 的默认 fence 规则不再兜底）。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 围栏渲染：套上上游 `CodeBlock` 的横幅 —— 语言标签（没有 info 就用「代码块」）+ 换行开关 + 复制。
 *
 * 为什么自己出 HTML 而不是加个 Preact 组件：正文走 `dangerouslySetInnerHTML`（分块复用 DOM），
 * 里面挂不了组件；交互按上游的做法在容器上**事件委托**（见 `MessageBody`）。
 */
md.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx]
  const info = (token?.info ?? '').trim().split(/\s+/)[0] ?? ''
  // ` ```math ` 围栏：**只在定稿时**当显示公式（上游 的 `!context.streaming && lang === 'math'`；
  // 流式期间保持代码块字面，否则半截 TeX 每帧都报错闪红）。上游还补一个尾换行 —— 它的文本抽取带
  // 代码块的行尾换行，这里照补，保证同一段 TeX 在两端渲染结果一致。
  if (info === 'math' && (env as { streaming?: boolean } | undefined)?.streaming !== true) {
    return renderTex(`${token?.content ?? ''}\n`, true)
  }
  const lang = info === '' ? CODE_TOOLBAR_LABELS.code : info
  const code = token?.content ?? ''
  // 没有 info 就**不写** `data-lang` / `class`（有语言才写）—— 样式与验收都按这个口径。
  const dataLang = info === '' ? '' : ` data-lang="${escapeHtml(info)}"`
  const langClass = info === '' ? '' : ` class="language-${escapeHtml(info)}"`
  /*
   * **四个图标都进 DOM、由 CSS 按状态显隐**（上游是按状态二选一渲染）——
   * 工具栏走 document 级事件委托，点一下只改属性、不动 vdom，CSS 显隐天然避开"重渲染把就地改的状态冲掉"。
   * 取值逐条对齐上游：
   *   · 换行按钮：`aria-label` **固定**是 `labels.wrapLabel`（不随状态改），跟随状态的是
   *     `aria-pressed={wrapped}`（默认 `data-code-wrap="true"` ⇒ `"true"`）与 Tooltip 文案（这里用 `title`）；
   *   · 复制按钮：可访问名 `copied ? copiedLabel : copyLabel`，这里初始为 `copy`。
   */
  return `<div class="md-code" data-code-wrap="true"${dataLang}>`
  + `<div class="md-code-head">`
  + `<span class="md-code-lang">${escapeHtml(lang)}</span>`
  + `<span class="md-code-acts">`
  + `<button type="button" class="md-code-act" data-code-wrap-btn aria-pressed="true" aria-label="${CODE_TOOLBAR_LABELS.wrap}" title="${CODE_TOOLBAR_LABELS.unwrap}">`
  + `<span class="md-code-ico md-code-ico-nowrap">${CODE_ICON_NOWRAP}</span>`
  + `<span class="md-code-ico md-code-ico-wrap">${CODE_ICON_WRAP}</span>`
  + `</button>`
  + `<button type="button" class="md-code-act" data-code-copy aria-label="${CODE_TOOLBAR_LABELS.copy}" title="${CODE_TOOLBAR_LABELS.copy}">`
  + `<span class="md-code-ico md-code-ico-copy">${CODE_ICON_COPY}</span>`
  + `<span class="md-code-ico md-code-ico-check">${CODE_ICON_CHECK}</span>`
  + `</button>`
  + `</span></div>`
  + `<pre><code${langClass}>${escapeHtml(code)}</code></pre></div>`
}

/**
 * 净化配置。
 *
 * `ADD_TAGS` 只放 **KaTeX 的 MathML 臂**要用的三个：
 *   DOMPurify 把 `semantics` / `annotation` / `annotation-xml` 列在 `mathMlDisallowed` 里（默认剥掉），
 *   而 KaTeX 的每个公式都输出 `<math><semantics><mrow>…</mrow><annotation encoding="application/x-tex">…</annotation></semantics></math>`。
 *   不放行 → MathML 臂被拆散（`.katex-mathml` 里会多出裸 TeX 文本）。三个标签都是**惰性**的，
 *   属性仍走 DOMPurify 的常规校验，放宽面仅限「MathML 语义容器」。
 */
const SANITIZE_CONFIG = { ADD_TAGS: ['semantics', 'annotation', 'annotation-xml'] }

/** 净化实现：抽成可替换点（脚本级验收用恒等替换；浏览器里就是 DOMPurify）。 */
let sanitize = (html: string): string => DOMPurify.sanitize(html, SANITIZE_CONFIG)

/** 仅供脚本级验收：替换净化实现（浏览器运行时不调用）；传 undefined 恢复 DOMPurify。 */
export function setSanitizerForTest(fn: ((html: string) => string) | undefined): void {
  sanitize = fn ?? ((html: string): string => DOMPurify.sanitize(html, SANITIZE_CONFIG))
}

/** markdown → 净化后的 HTML(整段渲染)。**流式正文不要用它**（每帧整段重解 = 正文闪动），
 * 用它渲染一次性内容（网页卡答案、回答正文定稿等非流式路径），流式走 `MdStream`。
 * 思考行**不用**它：思考展开体是纯文本（对齐上游 `thinkBody`，见 components/chain/ReasoningRow）。 */
export function renderMd(text: string): string {
  return sanitize(md.render(text))
}

/** 一个顶层块：key 是它在**全文里的起始字节偏移**（跨帧稳定，供渲染层复用 DOM）。 */
export interface MdBlock {
  key: number
  html: string
}

/**
 * 尾部保留的**不稳定块数**。
 * 追加文本只可能重塑最后一个顶层块（段落变 setext 标题 / 表格、列表续行），
 * 留一块安全余量，于是「已定型块」永不重解 —— 与上游 `UNSTABLE_TAIL_BLOCKS = 2`（含尾块共 3 块在算）
 * 的取舍一致：这里 `UNSTABLE_TAIL = 1` 表示**最后两块**每帧重解。
 */
const UNSTABLE_TAIL = 1

/** 第 n 行（0 基）在文本里的字节偏移。 */
function lineOffset(text: string, line: number): number {
  let at = 0
  for (let i = 0; i < line; i += 1) {
    const next = text.indexOf('\n', at)
    if (next === -1) return text.length
    at = next + 1
  }
  return at
}

/**
 * 按**顶层 token** 把 markdown 切成块。
 *
 * 为什么用 token 的起始偏移当边界：markdown-it 的块级解析是**逐行**的，追加文本只可能改变
 * 最后一个顶层的解析结果 —— 前面的块已经定型。块的**结束**取下个块的起始（不另算），
 * 于是各块源码拼回去与原文逐字节相同。
 */
function splitTopLevel(text: string): Array<{ key: number; source: string }> {
  const tokens = md.parse(text, {})
  const starts: number[] = []
  for (const token of tokens) {
    if (token.level === 0 && token.map !== null && typeof token.map[0] === 'number') {
      const lineStart = lineOffset(text, token.map[0])
      if (!starts.includes(lineStart)) starts.push(lineStart)
    }
  }
  if (starts.length === 0) return []
  starts.sort((a, b) => a - b)
  // 首块前若有前导空白，并进首块，保证拼回去不丢字节
  if (starts[0] !== 0) starts[0] = 0
  return starts.map((start, i) => ({
    key: start,
    source: text.slice(start, i + 1 < starts.length ? (starts[i + 1] as number) : text.length),
  }))
}

/**
 * **流式正文的块级渲染器**：一个实例跟一条流式消息（见 MessageBody）。
 *
 * 每帧只重解「尾部不稳定块」：前面已定型的块直接复用上一帧的**净化后 HTML**
 * （key 是源偏移，跨帧不变）→ 渲染层按 key 复用 DOM 节点，不再整段替换 ——
 * 这是「正文一跳一跳地闪」的根因修法。
 *
 * 口径：块边界只在**追加**输入上成立。正文被整体替换（重新生成 / 切会话回放）时从头重算。
 */
export class MdStream {
  private prevText = ''
  private blocks: MdBlock[] = []
  private sources: string[] = []

  /**
   * 折叠当前累计文本，返回**全部块**（定型 + 尾部，按序）。
   * @param text - 当前累计 markdown 全文
   */
  update(text: string): readonly MdBlock[] {
    if (text === this.prevText) return this.blocks
    if (!text.startsWith(this.prevText)) {
      // 非追加：整段重算（缓存全作废）
      this.blocks = []
      this.sources = []
    }
    this.prevText = text

    const parts = splitTopLevel(text)
    const stableCount = Math.max(0, parts.length - 1 - UNSTABLE_TAIL)
    const out: MdBlock[] = []
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as { key: number; source: string }
      const cached = this.blocks[i]
      const unchanged = cached !== undefined && cached.key === part.key && this.sources[i] === part.source
      // 定型块且源没变 → 直接复用（连净化都不重跑）；尾部块每帧重解（它还在长）
      if (i < stableCount && unchanged) {
        out.push(cached as MdBlock)
        continue
      }
      // `streaming: true` = 上游的 `context.streaming`：` ```math ` 围栏在流式期间保持字面（见围栏规则）
      out.push({ key: part.key, html: sanitize(md.render(part.source, { streaming: true })) })
    }
    this.blocks = out
    this.sources = parts.map((p) => p.source)
    return out
  }
}
