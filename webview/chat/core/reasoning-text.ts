// 思考文本的**显示准备**对齐上游 `dsh-v0.2.1-rc.5`
//
// 模型返回的推理内容可能以 `<signature>…</signature>` 开头（校验元数据）。上游 rc.5 在**渲染前**
// 剥掉这一段；剥完为空就整行不渲染。插件自绘思考行，所以要把同一函数搬过来，**作用点也照上游**：
// 只在显示消费点剥（思考行的展开体与收起预览、两处实时细节），
// 事件与节点数据保持**原始文本** —— 否则 `hasReasoning` / `inlineReasoning` / 链项数据都会偏离上游。
//
// 流式语义（照搬）：
//   · 首字符不是 `<` → 原样返回（普通文本不动）；
//   · 开标签只打了一半（如 `<sig`）→ 返回空；开标签完整但闭标签还没到 → 返回空；
//   · 找到闭标签 → 返回其后文本，并跳过一个紧跟的换行（`\n` 或 `\r\n`）。
/**
 * 把完整或流式思考文本转成**显示文本**。
 *
 * @param text - 原始思考文本（可能带签名段，可能正在流式增长）。
 * @returns 显示文本；没有可显示内容时返回空串。
 */
export function reasoningText(text: string): string {
  if (text[0] !== '<') return text
  const opening = '<signature>'
  if (opening.startsWith(text)) return ''
  if (!text.startsWith(opening)) return text
  const closing = '</signature>'
  const end = text.indexOf(closing, opening.length)
  if (end === -1) return ''
  let start = end + closing.length
  while (start < text.length) {
    if (text[start] === '\n') start++
    else if (text[start] === '\r' && text[start + 1] === '\n') start += 2
    else break
  }
  return text.slice(start)
}
