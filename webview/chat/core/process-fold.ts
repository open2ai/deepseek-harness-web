// 回合过程折叠的判定（适配上游 0.1.5-rc.2）：镜像上游「过程窗口就绪 → 可折叠 → 谁被藏起来」那条判据链。
//
// 上游是**逐节点**判的（每个节点各自算 `processWindowReady` / `processMember` / `foldable` / `processHidden`）；
// 插件一回合只有几条行（普通回合一条，被插话切开的回合多条），所以把同一套判据投影到「行 + 链」这一层：
//   - **回合** = 上游的过程窗口（一份 `turn-process` 规格，同回合所有行拿到的是同一份 `process` 事实）；
//   - 回合的**首行** = 上游那个 `turn-process` 控制节点 —— **只有它渲染折叠头**；
//   - 每行的链 = 该行携带的过程成员；
//   - 行的正文 = 上游的**回答步**（回答节点不随折叠隐藏）。
// 判据集中在本文件（纯函数、不碰 store 与 DOM），组件只按结果渲染 —— 与 `core/*-card.ts` 同一路子。
//
// 与上游的两处**已知差异**（都不是漏做，是有意为之，改前先看这里）：
//   1. `historyIncomplete`（快照分页是否完整）**尚未接入**：上游拿它做过程窗口的最后一道门，
//      插件链路里还没有这个字段，故暂缺（`undefined` 视为完整）。
//   2. 插件的**有意偏离**：链里只有提问行时不出折叠头（提问不参与过程折叠，见 design/06 §4）。
//
// 注：上游的 `compactAnswer`（区间内有插话时不按紧凑形态收回答）**不在这里判** —— 它只影响
// 「链与正文之间的间距」，事实由过程规格给出（`DshTurnProcess.compactAnswer`），渲染侧按其落一个属性
// （见 components/message/AssistantRow 与 styles/chain.css），不参与折叠头/明细的可见性判定。
import type { DshTurnProcess } from '../../../src/dsh/rows/types'

export interface ProcessDisclosureInput {
    /** 回合是否已关闭（上游 `turnClosed`；插件由 `turn/end` 置真的 `done`） */
    done: boolean
    /** 回合的过程事实；缺失 = 上游"根本没有控制条节点"（不折叠、也不出折叠头） */
    process: DshTurnProcess | undefined
    /** 用户偏好：紧凑才折叠（上游 `compactTranscript`） */
    compact: boolean
    /** 历史分页不完整（上游 `historyIncomplete`）；链路未接入，缺省视为完整 */
    historyIncomplete?: boolean
    /** 回合级展开态（同回合所有行共用；上游按 (turn, answerStep) 持久化） */
    open: boolean
    /** 本行是不是**折叠头的归属行**（回合首行 ＝ 上游的 `turn-process` 控制节点；只有它渲染折叠头） */
    ownsHead: boolean
    /** 本回合**没有**可折叠的东西（插件偏离：链里只含提问行） —— 整回合都不折叠 */
    noFold: boolean
}

export interface ProcessDisclosure {
    /** 过程窗口就绪：判据链的公共前置，缺一即不折叠（也便于排查「为什么没折叠」） */
    windowReady: boolean
    /** 可折叠：窗口就绪 **且**（过程外置 或 回答步自带推理） */
    foldable: boolean
    /** 折叠头是否出现（只有归属行会出） */
    head: boolean
    /** 本行的链（过程成员）是否可见 */
    detail: boolean
}

/**
 * 判定一条回答行的过程折叠形态。
 * @param input - 回合事实 + 用户偏好 + 回合级展开态 + 本行的角色
 * @returns 折叠头与明细的可见性
 */
export function processDisclosure(input: ProcessDisclosureInput): ProcessDisclosure {
    const process = input.process
    // 上游的 `processWindowReady`：事实齐全 + 紧凑 + **有回答锚点** + 回合已关闭（+ 历史分页完整）
    const windowReady =
        process !== undefined &&
        input.compact &&
        process.answerAnchorSeq !== null &&
        input.done &&
        input.historyIncomplete !== true
    // 上游的 `foldable`（对回合而言）：窗口就绪 **且**（过程外置 或 回答步自带推理）
    // —— 「区间内什么都没有」时不折叠，但这不等于"没有过程"：回答步的推理同样算。
    // `noFold` 是插件的**有意偏离**（链里只含提问行）：它在回合级生效，故同回合所有行一致。
    const foldable = windowReady && (process.hasExternalProcess || process.inlineReasoning) && !input.noFold
    // 折叠时藏的是**过程成员**（本行的链）；回答步的正文在行的正文里，不受影响（上游同）。
    // 同回合的每一行都跟随同一个展开态 —— 上游也是这么收的：折叠头一个，被收起来的是整个回合的成员。
    return { windowReady, foldable, head: foldable && input.ownsHead, detail: !foldable || input.open }
}
