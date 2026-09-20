import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

// 与旧 chat.ts 一致:禁用原生 HTML、自动链接、回车即换行。
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/** 净化实现：抽成可替换点（脚本级验收用恒等替换；浏览器里就是 DOMPurify）。 */
let sanitize = (html: string): string => DOMPurify.sanitize(html)

/** 仅供脚本级验收：替换净化实现（浏览器运行时不调用）；传 undefined 恢复 DOMPurify。 */
export function setSanitizerForTest(fn: ((html: string) => string) | undefined): void {
  sanitize = fn ?? ((html: string): string => DOMPurify.sanitize(html))
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
      out.push({ key: part.key, html: sanitize(md.render(part.source)) })
    }
    this.blocks = out
    this.sources = parts.map((p) => p.source)
    return out
  }
}
