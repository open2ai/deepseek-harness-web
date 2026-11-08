// 输入区草稿模型：引用区间的纯函数（无编辑器/宿主依赖，可单测）。
//
// 语义与上游 dsh 网页端的 `formatQuoteText` 一致：引用序列化成 Markdown blockquote
// （每行 `> ` 前缀，行间 `\n`），发送时由 outbox 拼回正文；编辑器里用 `offset`/`length`
// 表示引用在正文中的位置（= `at` + 序列化长度）。
import type { ComposerQuote } from '../core/types'

/**
 * 把引用正文格式化成 Markdown blockquote（与消息侧渲染同一口径）。
 * @param text - 引用原文（可多行）
 * @returns 每行以 `> ` 开头的引用块
 */
export function formatQuoteText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join('\n')
}

/** 引用在草稿正文里占的长度（上游 `quote.length` 的等价物）。 */
export function quoteLength(text: string): number {
  return formatQuoteText(text).length
}

/**
 * 校验一组引用区间是否合法：`at` 非负、按位置有序、互不重叠
 * （上游 `snapshotSchema.refine` 的同类约束）。
 * @param quotes - 待校验引用
 * @param textLength - 正文长度
 * @returns 合法时 true
 */
export function quotesValid(quotes: readonly ComposerQuote[], textLength: number): boolean {
  let end = 0
  for (const quote of quotes) {
    if (!Number.isInteger(quote.at) || quote.at < end || quote.at > textLength) return false
    end = quote.at + quoteLength(quote.text)
    if (end > textLength) return false
  }
  return true
}
