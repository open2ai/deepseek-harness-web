// 上下文注入/召回行的展示字典（文案取字典原文，不自造同义词；适配上游 0.1.5-rc.2）。
// 与 terminal.ts terminalLabels() 同一套路：只放上游原文，参数插值用函数。

export interface ContextLabels {
  contextInjection: string
  contextRecall: string
  instructionsLoaded: string
  instructionsAdded: string
  instructionsUpdated: string
  instructionsRemoved: string
  catalogReplaced: string
  catalogMore: (count: number) => string
  snapshotSupersedes: string
  relayFrom: (session: string) => string
  recallCounts: (retained: number, omitted: number) => string
  recallTruncated: string
  unknownBlock: string
  jsonTruncated: (total: number) => string
  // 工具变更行（rc.2 起上游会发 `developer/message` + `tool-addition`/`tool-removal` 块）：
  // 文案逐字取自网页端字典的 `message.tool*`。
  toolAdded: (name: string) => string
  toolRemoved: (name: string) => string
  toolsUpdated: string
  toolsAdded: (names: string) => string
  toolsRemoved: (names: string) => string
  toolsAddedCount: (count: number) => string
  toolsRemovedCount: (count: number) => string
  toolsChanged: (added: number, removed: number) => string
}
export function contextLabels(): ContextLabels {
  return {
    contextInjection: '上下文注入',
    contextRecall: '跨会话召回',
    instructionsLoaded: '已载入',
    instructionsAdded: '已新增',
    instructionsUpdated: '已更新',
    instructionsRemoved: '已移除',
    catalogReplaced: '替换目录',
    catalogMore: (count: number) => '…还有 ' + count + ' 条',
    snapshotSupersedes: '取代先前的快照',
    relayFrom: (session: string) => '来自会话 ' + session,
    recallCounts: (retained: number, omitted: number) => `保留 ${retained} 条 · 省略 ${omitted} 条`,
    recallTruncated: '已截断',
    unknownBlock: '未知内容块',
    jsonTruncated: (total: number) => `… 已截断，共 ${total} 字符`,
    toolAdded: (name: string) => `已添加工具：${name}`,
    toolRemoved: (name: string) => `已移除工具：${name}`,
    toolsUpdated: '工具已更新',
    toolsAdded: (names: string) => `新增：${names}`,
    toolsRemoved: (names: string) => `移除：${names}`,
    toolsAddedCount: (count: number) => `新增 ${count} 个`,
    toolsRemovedCount: (count: number) => `移除 ${count} 个`,
    toolsChanged: (added: number, removed: number) => `新增 ${added} 个，移除 ${removed} 个`,
  }
}
