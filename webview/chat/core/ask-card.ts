// 提问卡纯函数模型：从工具项派生问答记录与状态裁决（适配上游 0.1.7-rc.2）。
// 从 tool item（name/argsRaw/output/status/error）派生 AskQuestionCard 需要的卡数据：
//   待答(运行中) → 等待回答；已回答(ok) → {answered}/{total} 已回答 + 问题→答案记录；
//   ASK_CANCELLED → 已取消 + 未答问题；ASK_ABORTED → 已中断 + 未答问题。
// 记录取不到时 transcript 为 null、摘要为空串，由 ToolRow 落回通用「输入/输出」区 + 通用摘要。
// 校验从严：形状不符即退让；含 best-effort 计数兜底，不猜、不编造。

import { askLabels, type AskLabels } from './ask-labels'
import { asRecord, parseJson, pendingQuestionOf } from './ask-pending'

export interface QuestionEntry {
  id: string
  question: string
}

export interface AnsweredQuestion {
  id: string
  question: string
  answers: string[]
}

export interface AskTranscript {
  mode: 'answered' | 'unanswered'
  questions: Array<{ id: string; question: string; answers?: string[] }>
  /** unanswered 的结论（已取消/已中断详情）；answered 无 */
  verdict?: string
}

export interface AskCard {
  /**
   * 收起行状态摘要（等待回答 / n/N 已回答 / 已取消 / 已中断）。
   * 算不出时为空串 —— 调用方（ToolRow）此时回落到通用摘要（上游取 `model.summary`），不留空。
   */
  summary: string
  /**
   * 问答记录；null = **没有可展示的记录**（进行中 / 问题与答案配不上对 / 结果文本坏形）。
   * 此时不渲染提问卡体，由 ToolRow 落回通用「输入/输出」区（与上游 `transcript === null` 同口径）。
   */
  transcript: AskTranscript | null
  /**
   * 行状态覆盖（上游 `AskQuestionRow` 对两个 code 显式改写 state，此处同口径）：
   * `ASK_CANCELLED` → `'ok'`（用户自己取消，**不是失败**，不显示任何错误标记）；
   * `ASK_ABORTED` → `'stopped'`（回合被打断，与其它被打断的调用同为琥珀语义）。
   * 其余情况为 undefined，用宿主给的 `item.status`。
   */
  state?: 'ok' | 'stopped'
  /**
   * 可补答的调用标识（只在**限时提问超时**那一态上有）。
   *
   * 带上它，提问卡才能在「这条仍在投影的可补答清单里」时给出「回答」入口 —— 那条提问
   * 已经不能从弹窗回答了（超时后只有补答通道接受作答），卡片是唯一的入口。
   */
  lateCallId?: string
}

function questionEntries(argsRaw: unknown): QuestionEntry[] | null {
  const rec = asRecord(parseJson(argsRaw))
  if (rec === null || !Array.isArray(rec['questions']) || rec['questions'].length === 0) return null
  const questions: QuestionEntry[] = []
  const ids = new Set<string>()
  for (const q of rec['questions'] as unknown[]) {
    const record = asRecord(q)
    if (record === null || typeof record['id'] !== 'string' || typeof record['question'] !== 'string') return null
    const id = record['id']
    if (ids.has(id)) return null
    ids.add(id)
    questions.push({ id, question: record['question'] })
  }
  return questions
}

interface AnswerEntry {
  id: string
  selected: string[]
  custom?: string
}

function answerEntries(text: unknown): AnswerEntry[] | null {
  const rec = asRecord(parseJson(text))
  if (rec === null) return null
  const answers = rec['answers']
  if (!Array.isArray(answers)) return null
  const entries: AnswerEntry[] = []
  for (const answer of answers) {
    const record = asRecord(answer)
    if (record === null) return null
    if (
      typeof record['id'] !== 'string' ||
      !Array.isArray(record['selected']) ||
      !(record['selected'] as unknown[]).every((s) => typeof s === 'string') ||
      (record['custom'] !== undefined && typeof record['custom'] !== 'string')
    ) return null
    entries.push({
      id: record['id'],
      selected: record['selected'] as string[],
      ...(record['custom'] === undefined ? {} : { custom: record['custom'] }),
    })
  }
  return entries
}

function pairAnswers(argsRaw: unknown, answers: AnswerEntry[]): AnsweredQuestion[] | null {
  const questions = questionEntries(argsRaw)
  if (questions === null || questions.length !== answers.length) return null
  const byId = new Map<string, AnswerEntry>()
  for (const answer of answers) {
    if (byId.has(answer.id)) return null
    byId.set(answer.id, answer)
  }
  const paired: AnsweredQuestion[] = []
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) return null
    paired.push({
      ...question,
      answers: [
        ...answer.selected,
        ...(answer.custom === undefined || answer.custom === '' ? [] : [answer.custom]),
      ],
    })
  }
  return paired
}

function answeredSummary(text: unknown): string | null {
  const rec = asRecord(parseJson(text))
  if (rec === null) return null
  const answers = rec['answers'] as unknown[] | undefined
  if (!Array.isArray(answers)) return null
  let answered = 0
  for (const a of answers) {
    const record = asRecord(a)
    if (record === null) continue
    if (Array.isArray(record['selected']) && record['selected'].length > 0) answered += 1
    else if (typeof record['custom'] === 'string' && record['custom'] !== '') answered += 1
  }
  return askLabels().answered(answered, answers.length)
}

/**
 * 从 tool item 派生提问卡模型；仅 ask_user_question 非 null。
 * @param item - tool item（name/argsRaw/output/status/error）。
 */
export function askCardModel(item: {
  name: string
  argsRaw?: string
  output?: string
  status: string
  error?: string
}): AskCard | null {
  if (item.name !== 'ask_user_question') return null
  const labels: AskLabels = askLabels()
  if (item.status === 'running') {
    return { summary: labels.waiting, transcript: null }
  }
  if (item.error === 'ASK_CANCELLED') {
    const questions = questionEntries(item.argsRaw)
    return {
      summary: labels.cancelled,
      state: 'ok', // 用户自己取消：不是失败（上游同）
      transcript: questions === null
        ? null
        : { mode: 'unanswered', questions: questions.map((q) => ({ id: q.id, question: q.question })), verdict: labels.cancelledDetail },
    }
  }
  if (item.error === 'ASK_ABORTED') {
    const questions = questionEntries(item.argsRaw)
    return {
      summary: labels.interrupted,
      state: 'stopped', // 回合被打断：琥珀「已中断」，不是失败（上游同）
      transcript: questions === null
        ? null
        : { mode: 'unanswered', questions: questions.map((q) => ({ id: q.id, question: q.question })), verdict: labels.interruptedDetail },
    }
  }
  // 上游 0.2.0（timed 等待）：倒计时结束后结果被替换为 `{ pending: true, callId }`，
  // 问题转入「已继续」态，行状态改写为**中性**（不是失败），文案取「已继续工作，仍可回答」/
  // 「这道问题当时被跳过。」。此处只认结果里的 pending 标记（判据见 ask-pending.ts）。
  const pending = pendingQuestionOf(item.output)
  if (pending !== null) {
    const questions = questionEntries(item.argsRaw)
    return {
      summary: labels.continued,
      state: 'ok', // 工作已继续，不是失败；上游同口径
      ...(pending.callId === undefined ? {} : { lateCallId: pending.callId }),
      transcript: questions === null
        ? null
        : { mode: 'unanswered', questions: questions.map((q) => ({ id: q.id, question: q.question })), verdict: labels.continuedDetail },
    }
  }
  if (item.status === 'ok') {
    const answers = answerEntries(item.output)
    if (answers !== null) {
      const paired = pairAnswers(item.argsRaw, answers)
      const answered = answers.filter((a) => a.selected.length > 0 || (a.custom ?? '') !== '').length
      if (paired !== null) {
        return {
          summary: labels.answered(answered, answers.length),
              transcript: { mode: 'answered', questions: paired.map((q) => ({ id: q.id, question: q.question, answers: q.answers })) },
        }
      }
      // 严格配对失败 → best-effort 计数兜底
      const summary = answeredSummary(item.output)
      return { summary: summary ?? '', transcript: null }
    }
  }
  // 结果文本取不到（answers 都解析不出）时，参数里的**问题清单仍是可信的** → 用它渲染可读的问题列表。
  // 上游此处落回通用「输入/输出」区的原始 JSON；本插件按真机反馈改成可读（偏离，理由记 docs/design/06）。
  // 连问题都读不出（参数坏形/缺失）才交回 ToolRow，落通用区保留原始数据。
  const questions = questionEntries(item.argsRaw)
  if (questions === null) {
    return { summary: '', transcript: null }
  }
  return {
    summary: labels.unread,
    transcript: {
      mode: 'unanswered',
      questions: questions.map((q) => ({ id: q.id, question: q.question })),
      verdict: labels.unreadDetail,
    },
  }
}
