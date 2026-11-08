// 计划审阅（上游 `planReviewOf`，包 `@deepseek-ai/dsh-client-ui-user-questions`）：
// plan-mode 的 ask 请求仍然是一道「问题」，但 `intent.kind === 'plan-review'` 且
// `question.detail` 携带计划正文、选项里有一个具名 approve —— 这组形状走**计划审阅卡**，
// 不进入通用的一题一屏提问流程。
import type { QuestionSpec } from './protocol'

/** 计划审阅选项（上游 `{ label, description? }`）。 */
export interface PlanReviewOption {
  label: string
  description?: string
}

/** 收窄后的计划审阅事实。 */
export interface PlanReview {
  id: string
  question: string
  /** 计划正文（Markdown，来自 `question.detail`）。 */
  plan: string
  /** 上游 approve 选项（按钮提交 `selected: [approve.label]`）。 */
  approve: PlanReviewOption
  /** 至多一个替代项（用于回填/诊断；「要求修改」本身不选它，而是 dismiss）。 */
  decline?: PlanReviewOption
  callId?: string
}

/**
 * 把一组问题收窄成可渲染的计划审阅；不满足时返回 undefined，交回通用提问流程。
 * 条件与上游逐条一致：单题、`intent.kind === 'plan-review'`、有 `detail`、非多选、≤2 选项、能找到 approve。
 * @param questions - 请求里的整组问题
 * @returns 计划审阅事实，或 undefined
 */
export function planReviewOf(questions: readonly QuestionSpec[]): PlanReview | undefined {
  if (questions.length !== 1) return undefined
  const question = questions[0] as QuestionSpec
  const intent = question.intent
  if (intent?.kind !== 'plan-review' || question.detail === undefined) return undefined
  if (question.multiSelect === true) return undefined
  const options = question.options ?? []
  if (options.length > 2) return undefined
  const approve = options.find((option) => option.label === intent.approve)
  if (approve === undefined) return undefined
  const decline = options.find((option) => option.label !== intent.approve)
  return {
    id: question.id,
    question: question.question,
    plan: question.detail,
    approve: { label: approve.label, ...(approve.description === undefined ? {} : { description: approve.description }) },
    ...(decline === undefined ? {} : { decline: { label: decline.label, ...(decline.description === undefined ? {} : { description: decline.description }) } }),
    ...(intent.callId === undefined ? {} : { callId: intent.callId }),
  }
}

/** 去掉行内 markdown 标记，取纯文本（上游 `extractMarkdownPlainText` 的等价物）。 */
function plainInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/~~([^~]*)~~/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/`+/gu, '')
    .replace(/<[^>]+>/gu, '')
    .trim()
}

/**
 * 计划标题：第一行非空文本（剥掉标题/列表/引用/序号前缀）。
 * 上游用 `extractMarkdownPlainText(plan, { mode: 'first-line' })`。
 * @param plan - 计划 Markdown
 * @returns 标题纯文本
 */
export function planTitleOf(plan: string): string {
  for (const raw of plan.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('```')) continue
    const stripped = line
      .replace(/^#{1,6}\s+/u, '')
      .replace(/^>\s?/u, '')
      .replace(/^[-*+]\s+/u, '')
      .replace(/^\d+[.)]\s+/u, '')
    const title = plainInline(stripped)
    if (title !== '') return title
  }
  return ''
}

/**
 * 计划摘要：第一段（连续非空行拼成一行），与标题相同则返回空串。
 * 上游用 `extractMarkdownPlainText(plan, { mode: 'first-paragraph' })`。
 * @param plan - 计划 Markdown
 * @returns 摘要纯文本
 */
export function planDescriptionOf(plan: string): string {
  const lines = plan.split(/\r?\n/u)
  const paragraph: string[] = []
  let started = false
  /** 计划通常以标题开头：第一段摘要要跳过**开头的标题行**（上游 first-paragraph 同义）。 */
  let skippedTitle = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('```')) {
      if (started) break
      continue
    }
    if (!skippedTitle && !started && /^#{1,6}\s+/u.test(line)) {
      skippedTitle = true
      continue
    }
    const stripped = line
      .replace(/^#{1,6}\s+/u, '')
      .replace(/^>\s?/u, '')
      .replace(/^[-*+]\s+/u, '')
      .replace(/^\d+[.)]\s+/u, '')
    paragraph.push(plainInline(stripped))
    started = true
  }
  return paragraph.join(' ')
}
