// 计划产物（上游 ui-plan 的 `submittedPlan` / `submitted-plan` 节点）：
//
// `exit_plan_mode` 的调用参数里带完整计划 Markdown（`args.plan`），标题取计划正文的
// 第一个 `# ` 一级标题。该节点在上游是 **visibility: hidden**：本身不占对话行，
// 只作为回合尾部（`conversation.chat.turnTail`）「计划卡」的数据源。
//
// 原生工具调用（`tool/call`）与 PTC 子调用（`tool/ptc-dispatch-start` / `tool/ptc-dispatch`）
// 同一份计划只出一张卡；PTC 的 callId 是 `subCallId`。
import type { SessionEvent } from './nodes/types'

/** 一张已提交的计划（上游 `submittedPlan` 的返回形状）。 */
export interface SubmittedPlan {
  callId: string
  markdown: string
  title: string
}

/** 只判断事件形状所需的最小字段（守卫可喂手搭事件）。 */
export interface PlanCandidateEvent {
  type: string
  data: Record<string, unknown>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从事件里读出「已提交的计划」。
 * @param event - `tool/call` / `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 事件
 * @returns 计划（callId + Markdown + 一级标题）；无关或形状不完整时 undefined
 */
export function submittedPlanOf(event: PlanCandidateEvent | SessionEvent): SubmittedPlan | undefined {
  if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') return undefined
  const data = event.data
  if (!record(data) || data['name'] !== 'exit_plan_mode') return undefined
  const callId = event.type === 'tool/call' ? data['callId'] : data['subCallId']
  if (typeof callId !== 'string' || callId === '') return undefined
  let args: unknown = data['arguments']
  if (event.type === 'tool/call') {
    if (typeof args !== 'string') return undefined
    try {
      args = JSON.parse(args)
    } catch {
      return undefined
    }
  }
  if (!record(args) || typeof args['plan'] !== 'string') return undefined
  const markdown = args['plan']
  const title = /^#\s+(\S[^\r\n]*)/u.exec(markdown.trim())?.[1]
  return title === undefined ? undefined : { callId, markdown, title }
}
