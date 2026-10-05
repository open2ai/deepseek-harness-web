// 交付物展示的纯函数（回合尾部两套词汇的**展示**部分）。
//
//   - **本轮文件改动**：**数据在宿主**（Host 内存态的改动摘要，行上的 `changesSummary`）——
//     页面侧只负责渲染（相对路径 + `+x/-y`，见 `components/message/Deliverables.ts`）。
//     早先这里有一份「从 `write`/`edit` 调用**重建**清单」的推导（`mutationPath`/`producedPaths`）：
//     它会让历史会话凭空多出一张上游没有的卡（Host 重启后摘要就没了，网页端也不显示那张卡），
//     已于 2026-10-05 删除 —— 存在性与内容都以 Host 摘要为准。
//   - **交付文件**：模型显式声明，由宿主事件带到行上（行的 `presentedFiles`），推导不出来。
//
// 本文件剩下的是两侧共用的**路径展示**小工具。

/** 路径末段（chip 上显示的名字；两种分隔符都认，Windows 路径不吃亏）。 */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** 扩展名标签：大写、最多 8 字符；无扩展名返回空串（卡片状态行的兜底文案）。 */
export function extensionLabel(p: string): string {
  const base = baseName(p)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toUpperCase().slice(0, 8)
}
