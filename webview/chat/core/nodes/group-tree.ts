// **分组树位置**（上游 0.2.1 的 `groupTree`）：节点在"回合 / 过程 / 输入 / 交互段"这棵树上站哪一层。
//
// 为什么要它：在这之前，插件用三张 kind 白名单表达同样三件事 ——
//   · 分组在哪里断（`user`/`steering`/`turn-trigger`/`model-retry`/`turn-*`）；
//   · 谁不参与回合级过程呈现（前一张去掉 `model-retry`、加上 `turn-process`）；
//   · 谁不被折进过程区（再宽一点）。
// 三张表的内容几乎相同、含义却各说一套，于是每加一种节点就要同时改三处，而且**改漏不会报错**
// （只是分组/折叠的位置悄悄变了）。改成"位置"以后只有一处赋值：造节点时按 kind 定一次位，
// 判据统一读位置。
//
// 位置由外到内，**站得越外，具备的"外"效果越多**：
//   exchange  该回合开启一个交互段（人开的回合；段一直到下一个这样的回合）
//   input     该回合的输入（过程之前的开场输入、过程之后的插话都算）
//   turn      留在回合内、但不在过程折叠里（控条、终局通知、尾卡）
//   process   留在过程折叠里、但不在 step run 里（模型重试）
//   缺省       并入周围的 step run（回答步、工具、上下文、命令行、压缩标记…）

/** 分组树位置（由外到内）。 */
export type GroupTree = 'exchange' | 'input' | 'turn' | 'process'

/** 位置的深度：外墙 0、最内 3。判"在某个位置或更外层"就是比这个数。 */
const DEPTH: Readonly<Record<GroupTree, number>> = { exchange: 0, input: 1, turn: 2, process: 3 }

/** 判据只需要的形状（`ChatNode` 的子集；夹具手搭节点也能喂）。 */
export interface Positioned {
    kind: string
    groupTree?: GroupTree
}

/**
 * 按 kind 推出位置 —— **只在节点没带位置时兜底**。
 *
 * 真机上位置是造节点时按 kind 写好的（见 `chat-nodes.ts` 的 `positionOfKind`）；
 * 这条兜底服务两类读者：旧宿主/旧夹具手搭的节点，以及守卫里只用 kind 造节点的用例。
 * 内容必须与赋值那一份**逐条一致**，否则同一 kind 会出现两种位置。
 * @param kind - 节点种类
 * @returns 位置；并入 step run 的种类返回 undefined
 */
export function positionOfKind(kind: string): GroupTree | undefined {
    switch (kind) {
        // 人开的回合：普通提问（插话是另一个 kind，落在 input）
        case 'user':
            return 'exchange'
        // 该回合的输入：插话、以及唤醒本轮的触发卡
        case 'steering':
        case 'turn-trigger':
            return 'input'
        // 回合内、过程折叠之外
        case 'turn-process':
        case 'turn-error':
        case 'turn-max-tokens':
        case 'turn-tail':
            return 'turn'
        // 过程折叠内、step run 之外
        case 'model-retry':
            return 'process'
        default:
            return undefined
    }
}

/**
 * 取一个节点的位置（优先读节点自带的那份，缺失时按 kind 兜底）。
 * @param node - 节点（或任何带 kind 的形状）
 * @returns 位置；并入 step run 时 undefined
 */
export function groupTreeOf(node: Positioned | undefined): GroupTree | undefined {
    if (node === undefined) return undefined
    return node.groupTree ?? positionOfKind(node.kind)
}

/**
 * 该节点是否**站**在某个位置或更外层。
 *
 * 上游判据的三处读法（本插件同）：
 *   · 分组在哪里断 = `isAtOrOutside(node, 'process')`（凡有位置的都断）；
 *   · 谁不参与回合级过程呈现 = `isAtOrOutside(node, 'turn')`（过程成员不在此列）；
 *   · 谁是这一回合的输入 = `isAtOrOutside(node, 'input')`（exchange 也算）。
 * @param node - 节点；没有位置（并入 step run）恒 false
 * @param position - 比较用的位置
 * @returns 站在该位置或更外层时 true
 */
export function isAtOrOutside(node: Positioned | undefined, position: GroupTree): boolean {
    const own = groupTreeOf(node)
    return own !== undefined && DEPTH[own] <= DEPTH[position]
}
