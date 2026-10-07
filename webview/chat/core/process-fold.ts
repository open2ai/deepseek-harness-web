// 回合过程折叠的判定（适配上游 0.1.7-rc.2）：镜像上游「过程窗口就绪 → 可折叠 → 谁被藏起来」那条判据链。
//
// 上游是**逐节点**判的（每个节点各自算 `processWindowReady` / `processMember` / `foldable` / `processHidden`）；
// 插件一回合只有几条行（普通回合一条，被插话切开的回合多条），所以把同一套判据投影到「行 + 链」这一层：
//   - **回合** = 上游的过程窗口（一份 `turn-process` 规格，同回合所有行拿到的是同一份 `process` 事实）；
//   - 回合的**首行** = 上游那个 `turn-process` 控制节点 —— **只有它渲染折叠头**；
//   - 每行的链 = 该行携带的过程成员；
//   - 行的正文 = 上游的**回答步**（回答节点不随折叠隐藏）。
// 判据集中在本文件（纯函数、不碰 store 与 DOM），组件只按结果渲染 —— 与 `core/*-card.ts` 同一路子。
//
// 与上游的一处**有意偏离**（不是漏做，改前先看这里）：
//   插件的提问不参与过程折叠：链里只有提问行时不出折叠头（见 design/06 §4）。
//
// 已对齐（2026-10-01，dsh 0.2.0-rc.2 复核）：
//   1. 上游策略表的 `stepGrouping` 列（`grouped`）—— `collapsed`（compact/standard）下**进行中的回合也出
//      分组头**、`history`（detailed）只有已关闭回合有、`none`（verbose）不分组。插件的折叠头兼作上游的
//      「分组头」与「回合级折叠控制」，故 `collapsed` 档下进行中回合会多出一个（默认展开的）折叠头。
//   2. 过程窗口的最后一道门：上游在 0.2.0 里**已删掉** `historyIncomplete`（分页不完整不再禁止折叠），
//      改成**按回合**判 —— `窗口里有本回合的 turn/start` **或** `本回合已关闭`：
//      `processWindowReady = … && (turnStarted || turnClosed)`。所以「历史被分页截断」**不是**不折叠的理由，
//      「拿到了回合结尾但没拿到它的开头」照样折。本文件按这条判（见 `turnStarted`）。
//
// 注：上游的 `compactAnswer`（区间内有插话时不按紧凑形态收回答）**不在这里判** —— 它只影响
// 「链与正文之间的间距」，事实由过程规格给出（`DshTurnProcess.compactAnswer`），渲染侧按其落一个属性
// （见 components/message/AssistantRow 与 styles/chain.css），不参与折叠头/明细的可见性判定。
import type { DshTurnProcess } from '../../../src/dsh/rows/types'

export interface ProcessDisclosureInput {
    /** 回合是否已关闭（上游 `turnClosed`；插件由 `turn/end` 置真的 `done`） */
    done: boolean
    /**
     * 回合的过程事实；缺失 = 上游"根本没有控制条节点"（不折叠、也不出折叠头）。
     *
     * 只取判据真正读的字段：片的 `facts` 是回合级事实的同形子集，要求全集会把片这条调用点挡在类型外面。
     */
    process: Pick<DshTurnProcess, 'hasExternalProcess' | 'inlineReasoning' | 'answerAnchorSeq'> | undefined
    /** 用户偏好：紧凑才折叠（上游 `compactTranscript`） */
    compact: boolean
    /**
     * 用户偏好的过程分组覆盖范围（0.2.0 起）：`collapsed` = 所有回合都有可折叠的分组头
     * （**含进行中的回合**）、`history` = 只有已关闭的回合有、`none` = 不分组（过程行平铺）。
     * 缺省按 `history` 处理 = 接入前的形态（进行中不出折叠头）。
     */
    grouping?: 'collapsed' | 'history' | 'none'
    /**
     * 窗口里**有没有本回合的 `turn/start`**（上游 `turnStarted`）：窗口就绪的两条之一，
     * 与 `done` 取**或**。读不到时按「没拿到开头」处理，只剩 `done` 那一条门（与上游同形）。
     */
    turnStarted?: boolean
    /** 回合级展开态（同回合所有行共用；上游按 (turn, answerStep) 持久化） */
    open: boolean
    /** 本行是不是**折叠头的归属行**（回合首行 ＝ 上游的 `turn-process` 控制节点；只有它渲染折叠头） */
    ownsHead: boolean
    /**
     * 本次判定是**一片**（上游 `ChatGroupSeat` 的每个 seat）而不是整个回合。
     *
     * 差别只有一处：**窗口门里的"有回答锚点"那一条只属于回合级**（上游 `processWindowReady` 里没有它）。
     * 分组头开合的是这一片的明细，不需要锚点 —— 少了这个区分，"没有回答步的那一片"（例如停下来的
     * 回合只留一条思考）分组头整个不出现。
     */
    groupSeat?: boolean
}

export interface ProcessDisclosure {
    /** 过程窗口就绪：判据链的公共前置，缺一即不折叠（也便于排查「为什么没折叠」） */
    windowReady: boolean
    /** 可折叠：窗口就绪 **且**（过程外置 或 回答步自带推理） */
    foldable: boolean
    /** 上游 `grouped`：本回合有没有分组头（`stepGrouping` 覆盖到本回合） */
    grouped: boolean
    /** 折叠头是否出现（只有归属行会出） */
    head: boolean
    /** 本行的链（过程成员）是否可见 */
    detail: boolean
}

/** 链里的一项（只取这条判据要用的形状，避免把行模型整个引进来）。 */
interface ChainLike {
    kind: string
    key: number
    text?: string
}

/** 只看 `kind` 就能把「步骤文本」那一支挑出来（其余分支没有 `text`）。 */
export type StepTextLike<T> = T extends { kind: 'text'; text: string } ? T : never

/**
 * 本行里**不随折叠隐藏**的步骤文本。
 *
 * 口径来自上游：折叠藏起来的只有**过程成员**（工具/思考/上下文注入），
 * 而模型在步骤之间说的话是**回答内容**（上游每步一个独立回答节点，永远可见）。
 * 插件一回合只开一条行，非回答步的文本以 `kind:'text'` 混在链里 —— 若不单独取出来，
 * 折叠时它会陪着工具一起消失（真机现象：「工具行之间的文字跑完就看不到了」）。
 *
 * @param chain - 本行的链（顺序即渲染顺序）
 * @param detailVisible - 过程明细当前是否可见（折叠/展开）—— 文本**两种情形都要显示**，此参只用于调用点对齐语义
 * @returns 需要常显的步骤文本项（按链序）
 */
export function visibleStepTexts<T extends ChainLike>(
    chain: readonly T[],
    detailVisible: boolean
): Array<StepTextLike<T>> {
    // `detailVisible` 刻意不参与筛选：折叠与否都必须显示这些文本。保留形参是为了让调用点
    // 一眼看出「它与折叠态无关」，而不是误以为这里只处理展开态。
    void detailVisible
    return chain.filter((item): item is StepTextLike<T> => item.kind === 'text')
}

/**
 * 判定一条回答行的过程折叠形态。
 * @param input - 回合事实 + 用户偏好 + 回合级展开态 + 本行的角色
 * @returns 折叠头与明细的可见性
 */
export function processDisclosure(input: ProcessDisclosureInput): ProcessDisclosure {
    const process = input.process
    // 上游的 `processWindowReady`：事实齐全 + 紧凑 + （**窗口里有本回合的 turn/start** 或 **本回合已关闭**）。
    // 最后那条在 0.2.0 里是 per-Turn 的 `turnStarted || turnClosed` —— 历史分页截断**不再**是禁止折叠的理由
    // （旧版那道 `historyIncomplete` 已被上游删除）。
    //
    // ⚠️ **"有回答锚点"这一条只属于回合级那道门，不能拿来卡分组头**（真机 2026-10-06 截图）：
    // 上游 `processWindowReady` 里**没有**回答锚点这一项（锚点只用在"哪些节点算这一片的过程成员"上）；
    // 插件把它写进窗口门是为了**回合级那个可点折叠**（折叠动作的落点就是锚点世代，没有锚点可点，
    // 见 `Chain.ts` 的 `canCollapse`）。分组头（`groupSeat`，每片自己的 seat）不需要锚点：
    // 它开合的是**这一片**的明细。少了这个区分，「停下来的回合只留一条思考」那一片（没有回答步）
    // `windowReady` 恒假 → 分组头整个不出现 —— 网页端同一位置有「已完成分析」那个框。
    const anchorReady = input.groupSeat === true ? true : process?.answerAnchorSeq !== null
    const windowReady =
        process !== undefined &&
        input.compact &&
        anchorReady &&
        (input.turnStarted === true || input.done)
    // 上游的 `foldable`（对回合而言）：窗口就绪 **且**（过程外置 或 回答步自带推理）
    // —— 「区间内什么都没有」时不折叠，但这不等于"没有过程"：回答步的推理同样算。
    // ⚠️ 插件曾有一条偏离 `noFold`（"链里只含提问行就不折叠"），**已删除**：提问在上游是可见节点、照常计入。
    const foldable = windowReady && (process.hasExternalProcess || process.inlineReasoning)
    // 上游 `ChatGroupSeat` 的 `grouped`（`stepGrouping` 决定分组头覆盖谁）：与「外层折叠」是**两道独立的门**。
    // 缺省 `history` = 接入前的形态（只有已关闭回合有折叠头）。
    const grouping = input.grouping ?? 'history'
    const grouped = grouping !== 'none' && (grouping === 'collapsed' || input.done)
    // 进行中回合的分组头（只在 `collapsed` 档出现）：上游 compact/standard 下 running 回合也有可折叠分组头，
    // 默认展开着看过程在动；`history`（detailed）与 `none`（verbose）下进行中平铺、没有头。
    const runningHead = grouped && !input.done && process !== undefined
        && (process.hasExternalProcess || process.inlineReasoning)
    const groupable = foldable || runningHead
    // 折叠时藏的是**过程成员**（本行的链）；回答步的正文在行的正文里，不受影响（上游同）。
    // 同回合的每一行都跟随同一个展开态 —— 上游也是这么收的：折叠头一个，被收起来的是整个回合的成员。
    // `detail` 由 `groupable`（有没有可收的东西）与回合级展开态决定；没有分组头时明细永远可见（上游 `expandedBody` 同）。
    return { windowReady, foldable, grouped, head: groupable && input.ownsHead, detail: !groupable || input.open }
}


