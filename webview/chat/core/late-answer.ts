// 迟到回答（timed 提问）的**页面侧**判据 —— 独立纯函数文件（适配 dsh 0.2.0）。
//
// 上游把 timed 提问的状态放在**会话投影**里（键 `userQuestions`，值为 `{ active, settled }`）：
//   · `active` 一项 = `{ callId, questions, state }`，`state` ∈ `'open' | 'continued'`：
//       - `open`      = 工具调用**还能**拿到答案（走原本的阻塞问答通道，本插件早已支持）；
//       - `continued` = 超时后工作已继续，**只能**作为新一轮用户消息补答（本文件服务的场景）。
//   · `settled` 一项 = `{ callId, answers }`（已结算的调用，只用于展示最终答了什么）。
// **用阻塞式工具的会话（出厂默认）两个数组都是空的**：所以拿不到投影值时一律当「没有可补答的提问」，
// 不猜、不编造（fail-closed）。
//
// 本文件只管**展示数据**（从投影里挑出可补答的调用、校验题目形状）；wire 那一半
// （补答 args 的平铺形状、结果判读）在宿主侧 `src/dsh/userQuestions.ts`，两边各自被守卫直接喂用例。

/** 选项（与上游 `AskUserQuestionOption` 同形）。 */
export interface LateAnswerOption {
  label: string
  description?: string
}

/** 一道可补答的问题（与上游 `AskUserQuestionItem` 同形；字段与既有 `QuestionSpec` 一致）。 */
export interface LateAnswerQuestion {
  id: string
  question: string
  header?: string
  detail?: string
  options?: LateAnswerOption[]
  multiSelect?: boolean
}

/** 一次仍可补答的调用。 */
export interface LateAnswerCall {
  callId: string
  questions: LateAnswerQuestion[]
}

/**
 * 补答的作答项（与既有提问提交体一致：每条作答对应一道题，`selected` 是选项**原始 label**）。
 * 提交走 `questionLateAnswer` 帧；wire 形状（平铺 args）由宿主侧组装。
 */
export interface LateAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/** 一道题的形状校验；`id` 与 `question` 缺一不可，其余字段按存在才带上（与上游可选字段一致）。 */
function questionOf(value: unknown): LateAnswerQuestion | null {
  const raw = asRecord(value)
  if (raw === null) return null
  const id = nonEmptyString(raw['id'])
  const question = nonEmptyString(raw['question'])
  if (id === null || question === null) return null
  const options: LateAnswerOption[] = []
  if (Array.isArray(raw['options'])) {
    for (const entry of raw['options']) {
      const option = asRecord(entry)
      const label = option === null ? null : nonEmptyString(option['label'])
      if (option === null || label === null) continue
      const description = nonEmptyString(option['description'])
      options.push(description === null ? { label } : { label, description })
    }
  }
  const header = nonEmptyString(raw['header'])
  const detail = nonEmptyString(raw['detail'])
  return {
    id,
    question,
    ...(header === null ? {} : { header }),
    ...(detail === null ? {} : { detail }),
    ...(options.length === 0 ? {} : { options }),
    ...(raw['multiSelect'] === true ? { multiSelect: true } : {}),
  }
}

/**
 * 从 `userQuestions` 投影值取**仍可补答**的调用（`state === 'continued'`）。
 *
 * 形状不符 / 缺字段 / 非数组一律**跳过该项**（不是整批丢弃）：一项坏掉不该让其余可补答的提问消失。
 * @param value - 投影值（页面从 `chatInfo.projections.userQuestions` 或 `projections` 帧拿到的原始值）。
 * @returns 按投影顺序的去重调用列表；没有就是空数组。
 */
export function continuedCallsOf(value: unknown): LateAnswerCall[] {
  const raw = asRecord(value)
  const active = raw === null ? undefined : raw['active']
  if (!Array.isArray(active)) return []
  const calls: LateAnswerCall[] = []
  const seen = new Set<string>()
  for (const entry of active) {
    const item = asRecord(entry)
    if (item === null || item['state'] !== 'continued') continue
    const callId = nonEmptyString(item['callId'])
    if (callId === null || seen.has(callId)) continue
    const rawQuestions = item['questions']
    if (!Array.isArray(rawQuestions)) continue
    const questions: LateAnswerQuestion[] = []
    for (const rawQuestion of rawQuestions) {
      const question = questionOf(rawQuestion)
      if (question !== null) questions.push(question)
    }
    if (questions.length === 0) continue
    seen.add(callId)
    calls.push({ callId, questions })
  }
  return calls
}
