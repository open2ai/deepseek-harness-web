// 渲染期错误的**账本**（对齐上游 `onEntryError` 的监督口，见上游 scoped-slots 的 SlotErrorBoundary）。
//
// 上游的口径（本项目只取其**隔离**那一半，见下）：
//   · 每个槽位条目各有一个错误边界，**一个条目崩了不许把兄弟条目带下去**；
//   · 崩溃要**上报**到账本（`onEntryError`）；影子类槽位还会「让位」（abdicate），
//     由 outlet 改渲下一个候选，全都让位光了才长期显示崩溃面；
//   · **装配错误不隔离**（`SlotAssemblyError` 直接抛）——「装错了」属于必须炸响的故障，不该降级成兜底。
//
// 本插件没有槽位与候选列表（一个角色只有一份实现），所以**不搬让位**：崩了就在原地显示兜底行，
// 兄弟行照常渲染；装配性错误（本插件里对应「行模型形状不认识」）同样直接抛，交给外层。
//
// 为什么必须有这一层：行是**整表**下发、整表重渲的。任何一行在渲染期抛异常，preact 会把
// **整棵消息树**卸载掉 —— 表现就是「打开某个会话整片对话空白」，而日志里只有一条 undefined。
// 有了边界，坏的只是那一行（还带着可复制的错误摘要），别的行继续可用。
import { signal, type Signal } from '@preact/signals'

/** 一条渲染期错误（账本条目）。 */
export interface RenderErrorEntry {
  /** 出错的行/区域标识（行 key 或部件名），用来对上「是哪一行」。 */
  key: string
  /** 错误原文（含 message 与栈首行；栈完整放在 `stack`）。 */
  message: string
  /** 完整栈（供复制排查）。 */
  stack?: string
  /** 发生时刻（毫秒；仅用于展示顺序）。 */
  at: number
}

/** 账本保留条数：只留最近这些条（控件的列表也只看这些）。 */
const MAX_ENTRIES = 50

/** 最近若干条渲染期错误（新的在前）。组件订阅它画计数与控制台清单。 */
export const renderErrors: Signal<RenderErrorEntry[]> = signal([])

/** 上报一条渲染期错误（边界与手动兜底都走这里，保证只有一处写账本）。 */
export function reportRenderError(key: string, error: unknown): void {
  const err = error instanceof Error ? error : undefined
  const message = err?.message ?? String(error)
  const entry: RenderErrorEntry = {
    key,
    message,
    ...(err?.stack === undefined ? {} : { stack: err.stack }),
    at: Date.now(),
  }
  renderErrors.value = [entry, ...renderErrors.value].slice(0, MAX_ENTRIES)
  console.error(`[dsh-render] 行渲染失败（key=${key}）：`, error)
}

/** 清空账本（「全部重试」用）。 */
export function clearRenderErrors(): void {
  renderErrors.value = []
}
