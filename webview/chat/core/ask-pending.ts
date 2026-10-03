// 提问卡「已继续工作（迟到回答）」判据 —— 适配 dsh 0.2.0 的 timed 等待（独立文件，纯函数）。
//
// 上游行为（0.2.0 起）：
//   · 宿主在 timed 模式倒计时结束后，把 `ask_user_question` 的结果**替换**为 `{ pending: true, callId }`
//     （超时错误码被吞成 pending，不抛错），问题转入「已继续」态，只能作为新一轮用户消息回答；
//   · 客户端据此把该行状态改写为**中性**（不是失败），并显示「已继续工作，仍可回答」/「这道问题当时被跳过。」。
//
// 本插件不消费新的问题投影（需要新 remote + 宿主支持），因此**只按结果里的 `pending` 标记**做同口径呈现：
// 有标记才改判；没有标记一律维持原有判定（不猜、不编造）。
//
// 两个解析小工具也放在这里，供 `ask-card.ts` 复用（避免同一份 JSON 形状校验写两遍）。

/** 只接受「值是字符串的普通对象」；数组/null/原始值一律拒收。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 宽松 JSON 解析：非字符串或解析失败都返回 undefined（判据层不抛错）。 */
export function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export interface PendingQuestionResult {
  /** 迟到回答的定位句柄；上游结果是 `{ pending: true, callId }`，缺失时不编造。 */
  readonly callId?: string
}

/**
 * 结果文本是否为「等待已超时、工作继续」的形状。
 * @param output - 工具结果原文（可能缺失/坏形）。
 * @returns 命中返回（可能只含空对象的）标记；未命中返回 null。
 */
export function pendingQuestionOf(output: unknown): PendingQuestionResult | null {
  const rec = asRecord(parseJson(output))
  if (rec === null || rec['pending'] !== true) return null
  const callId = rec['callId']
  return typeof callId === 'string' && callId !== '' ? { callId } : {}
}
