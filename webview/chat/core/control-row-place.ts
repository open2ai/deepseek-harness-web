// 「只有回合事实、一条内容都没有」的容器行（它承的是「处理失败」/「已停止」那一格），
// 该渲染在回合里的**哪个位置**。
//
// 上游不是按"建节点的先后"排的，而是**按展示位置排**：控制节点贴着该回合的**开局人类输入**
//（排在同锚点的 rank 1），没有人类输入时贴在该回合**最早的过程证据之前**（rank -1）。
// 所以网页端「处理失败」排在重试行**之上**；插件的行按时序建（请求期就失败的那种回合，
// 容器行是补在末尾的），这里按同一条规则算出它的目标下标。
//
// 判据（与上游那两档一一对应）：
//   · 该回合有可见的人类输入行 → 插在**最后一条**人类输入之后（上游取的是它）；
//   · 没有 → 插在该回合**第一条**行之前（贴着最早的过程证据）；
//   · 两者都没有（这一回合只有它自己）→ 原地不动。

/** 渲染列表里一条行的判定用形状（只读这两件事）。 */
export interface PlacedRowLike {
  kind: string
  turn?: number
}

/**
 * 容器行的目标下标。
 * @param entries - 当前渲染列表（顺序即渲染顺序）
 * @param ownerIndex - 该容器行此刻的下标
 * @param turn - 它所属的回合号
 * @returns 目标下标；与 `ownerIndex` 相同 = 不用挪
 */
export function controlRowTargetIndex(
  entries: readonly PlacedRowLike[],
  ownerIndex: number,
  turn: number,
): number {
  let first = ownerIndex
  let opening = -1
  let seenOwnTurnRow = false
  // 先找该回合最早的一条（往后扫，停在别的回合）
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry === undefined) continue
    if (entry.turn !== undefined && entry.turn !== turn && i < ownerIndex) {
      // 上一个回合的行：它之后的才是本回合（`first` 会在下面被本回合的第一条覆盖）
      first = ownerIndex
      continue
    }
    if (entry.turn === turn) {
      first = i
      seenOwnTurnRow = true
      break
    }
  }
  // 开局人类输入 = 该容器行**往前最近的一条 user 行**，且中间不能跨过别的回合。
  //（`user` 行不带回合号，所以只能这样往前找；跨回合就停 —— 上一回合的用户消息不是本回合的开局输入。）
  for (let i = ownerIndex - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry === undefined) continue
    if (entry.turn !== undefined && entry.turn !== turn) break
    if (entry.kind === 'user') {
      opening = i
      break
    }
  }
  if (opening >= 0) return opening + 1
  if (first === ownerIndex && !seenOwnTurnRow) return ownerIndex
  return first < ownerIndex ? first : ownerIndex
}
