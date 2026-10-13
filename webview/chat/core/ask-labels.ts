// 提问卡展示字典（文案取字典原文，不自造同义词）。
export interface AskLabels {
  rowTitle: string
  waiting: string
  cancelled: string
  cancelledDetail: string
  interrupted: string
  interruptedDetail: string
  /** 等待超时、工作已继续（上游 `ask.pending`）。 */
  continued: string
  /** 超时后**仍可补答**时的结论行（上游 `ask.pendingDetail`）。 */
  pendingDetail: string
  /** 超时后**已不可补答**时的摘要（上游 `ask.closed`）。 */
  closed: string
  /** 已不可补答时的结论行（上游 `ask.closedDetail`）。 */
  closedDetail: string
  /**
   * 提问卡上的**补答入口**文案（上游 `ask.reopen` 原文）。
   * 只在「该条仍在投影的可补答清单里」时出现 —— 超时后卡片是唯一的作答入口。
   */
  reopen: string
  answered: (answered: number, total: number) => string
  skipped: string
}
export function askLabels(): AskLabels {
  return {
    rowTitle: '提问',
    waiting: '等待回答',
    cancelled: '已取消',
    cancelledDetail: '本轮已取消，未提交回答',
    interrupted: '已中断',
    interruptedDetail: '本轮已中断，未提交回答',
    continued: '已继续工作，仍可回答',
    pendingDetail: '等待中的问题仍可在输入框中回答',
    closed: '已结束',
    closedDetail: '该问题已结束，结果见下方对话',
    reopen: '回答',
    answered: (answered: number, total: number) => `${answered}/${total} 已回答`,
    skipped: '未回答',
  }
}
