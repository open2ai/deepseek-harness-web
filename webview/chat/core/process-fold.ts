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
// 提问行按上游口径**照常计入**过程（曾有一条 `noFold` 偏离，已删，见本文件末尾那条注释）。
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
     * 用户偏好的过程分组覆盖范围：`collapsed` = 所有回合都有可折叠的分组头
     * （**含进行中的回合**）、`history` = 只有已关闭的回合有、`none` = 不分组（过程行平铺）。
     *
     * 缺省按 `history` 处理 = **读不到偏好时的保守形态**（进行中不分组、已关闭照常收）。
     * 真机上这一项恒有值：宿主把四档策略的这一列随偏好帧一起下发（`DEFAULT_CHAT_PREFS` 的
     * 缺省是 `collapsed`，= 上游桌面端默认档），本层只是"连偏好帧都没拿到"时的兜底。
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
    /**
     * ⚠️ **2026-10-12 已按 §6.3 的做法结案：那道自造的"有回答锚点"门已删除**（此前写成
     * `anchorReady = groupSeat === true ? true : process?.answerAnchorSeq !== null`，
     * 挂在下面 `windowReady` 上）。它的来历与结局：
     *
     * · **来历**：上游 `processWindowReady`里**没有**回答锚点这一项
     *     （锚点只用在"哪些节点算这一片的过程成员"上），插件当初把它写进窗口门，是为了回合级那个可点折叠
     *     找落点。后来那两条理由都作废了 —— `canCollapse` 在 **2026-10-07** 撤掉了"必须有回答锚点"
     *     （上游的可点条件是 `foldable && hasContent && !alwaysOpen`，无锚点项）；「唤出」的落点在
     * **2026-10-12** 改成**回合级当前世代**（上游 比的就是回合级 `spec.answerStep`）。
     *   · **为什么保留过一阵**：它理论上会改变"没有定稿回答的回合要不要出折叠头"的渲染，按本仓约定
     *     （先真机左右对照再动）登记在 `next/docs/10` §6.3，未就地删除。
     *   · **这次怎么结的案**（脚本 `tmp/_anchorgate.ab.probe.mjs`，可复跑）：同一批**真实事件帧**、
     *     A = 现行源码、B = **只在打包时**把那一行强制成 `true`（仓库文件不改），
     *     六个采样点（含四处"按形状正该咬到它的"回合：`c5c3c306` 回合 2/3/6、`54fdba8f` 回合 20）
     *     × 四档「工作步骤展示」× 历史/实时 = **64 种组合渲染出的 DOM 逐字节相同**
     *     （唯一差异是左下角"用时 X"走秒，已归一化）。**但那六个采样点里没有"整回合一条头"那种形状**，
     *     所以"零差异"**不能推广**。
     *   · **真正的判定来自真实会话的全量回归**：`tmp/_e2e.history.test.mjs` 原先钉着
     *     "出了折叠头的行都必须有回答锚点"这条**旧偏离**；删掉门之后它报出 **5 个回合**
     *     （#10/#13/#14/#16/#24：已关闭 + 有过程 + 零正文）从"平铺"变成"出折叠头"——
     *     而网页端在那些回合**本来就是出头的**（上面那条上游判据里没有锚点项）。
     *     也就是说：这条门确实改变渲染，**改变的方向正是上游**。守卫的旧期望随之下调为上游口径
     *     （`_e2e.history` 与 `_transcript.fourmodes` 各一条），并留一个观测量
     *     （"出头的行里没有回答锚点的行数"）。
     *   · **结论**：这不是"零像素风险的清理"，而是**一次有意的行为变更、方向对齐上游**；
     *     证据是"真实会话里 5 个回合从平铺改成出头"＋上游 `processWindowReady` 里确实没有锚点项。
     */
    const windowReady =
        process !== undefined &&
        input.compact &&
        (input.turnStarted === true || input.done)
    // 上游的 `foldable`（对回合而言）：窗口就绪 **且**（过程外置 或 回答步自带推理）
    // —— 「区间内什么都没有」时不折叠，但这不等于"没有过程"：回答步的推理同样算。
    // ⚠️ 插件曾有一条偏离 `noFold`（"链里只含提问行就不折叠"），**已删除**：提问在上游是可见节点、照常计入。
    const foldable = windowReady && (process.hasExternalProcess || process.inlineReasoning)
    // 上游 `ChatGroupSeat` 的 `grouped`（`stepGrouping` 决定分组头覆盖谁）：与「外层折叠」是**两道独立的门**。
    // 缺省 `history` = 读不到偏好时的保守形态（真机上宿主恒下发这一列，见接口注释）。
    const grouping = input.grouping ?? 'history'
    const grouped = grouping !== 'none' && (grouping === 'collapsed' || input.done)
    /**
     * **这一片有没有可收的东西**（与 `grouped` 是两道独立的门：那道管"要不要分组头"，这道管"收得起吗"）。
     *
     * ⚠️ **2026-10-16 去掉了一条 `!input.done`**（原先写成 `foldable || (grouped && !done && …)`）：
     * 一个回合会被切成多行（每片一段），只有**收尾那一段**带 `turn/end`，其余段的 `done` 恒为 false ——
     * 那条门于是把"已收口、成员上百"的片全判成没有头：真机表现是**片里一百多个步骤全铺在屏幕上、
     * 一个分组头都没有**（探针：某会话回合 1 的五条大段落 `grouped=true` 却 `folded=false`）。
     * 上游没有这条门：头出不出只看策略列 + 这一片有没有过程内容，与"回合有没有结束"无关。
     */
    const groupable = process !== undefined && (process.hasExternalProcess || process.inlineReasoning)
    // 折叠时藏的是**过程成员**（本行的链）；回答步的正文在行的正文里，不受影响（上游同）。
    // 同回合的每一行都跟随同一个展开态 —— 上游也是这么收的：折叠头一个，被收起来的是整个回合的成员。
    // `detail` 由 `groupable`（有没有可收的东西）与回合级展开态决定；没有分组头时明细永远可见（上游 `expandedBody` 同）。
    // ⚠️ **`grouped` 是这两条的门**（不是只有 `groupable`）：
    //   · `grouping === 'none'`（上游 verbose 档）→ **没有分组头、明细一律平铺**；
    //   · 没有偏好（旧宿主 / mock）→ 按 `history` 兜底，与接入前的形态一致。
    // 少了这道门，改档只会改掉 `grouped` 这个没人读的字段：头照出、明细照藏 ——
    // 真机表现就是「设置里改完，插件还要点一次收起/展开」（2026-10-09 事故）。
    return { windowReady, foldable, grouped, head: grouped && groupable && input.ownsHead, detail: !grouped || !groupable || input.open }
}


