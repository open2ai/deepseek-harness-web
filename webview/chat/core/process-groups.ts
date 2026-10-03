// 过程**分组**（上游 step-group）的切片计划 —— 独立纯函数（判据只写这一处，渲染只按结果画）。
//
// 上游的走查次序（`conversation-nodes/process-groups.ts`）决定了两件事：
//   ① **带回答内容的步**是收口：那一刻先 `flush` 收掉当前组，该步自己成为一个**独立可见节点**；
//   ② **该步自己的工具**在收口之后才进组 → 「step k 的工具」属于**下一片**（step k 的过程成员 →
//      `(group[k-1].toStep, group[k].toStep]` 那个区间）。
//
// 于是切片有两条路，**按链上事实自动选**（同一份 `ok` / 退回契约）：
//
//   A. **按步号配对**（链上的项带步号时走这条 —— 真实会话都带）：把每一项放进「步号落在
//      `(fromStep, toStep]`」的那一片里（`null` 端按开区间处理），落不进任何一片的按**就近**归片
//      （前导项并进首片、尾巴项并进末片）—— 保证**一项不丢、每片恰好一个头**。
//      这是与宿主 `groups` **同源**的口径：宿主也是按"收口步"分组的，所以片数天然等于组数。
//
//   B. **按链上位置**（链上不带步号时走这条 —— 合成夹具 / 旧形状的兜底，也是本文件最早的形态）：
//      **每个 `text` 项都是一个边界；边界不属任何片；片 = 两个边界之间的非 text 连续段。**
//      注意它**不是**主口径：真实会话里"收口步的文本"未必落在收口那一刻（构建器的
//      `reorderChainByStep` 把同一步的文本拉到**本步过程成员之前**），于是按位置切出来的片数
//      与宿主对不上 —— 见 `tmp/版本差异记录/…/14` §6 的实测（15/57 条）。所以只在拿不到步号时用它。
//
// 两条路都遵守：**片数与宿主给的数目不符 → `ok: false`**，调用方整体退回整回合形态
//（绝不半新半旧地渲染）。

import type { DshRowGroup } from '../../../src/dsh/rows/types'

/**
 * 计划里的一个**边界文本**项：非回答步的说明文字，永远可见（上游那个独立回答节点）。
 *
 * 只有 B 路（按链上位置）会产出它；A 路把文本留在它所属的那一片里（片内文本同样永远可见，
 * 见 `components/chain/plan.ts` 的 `chainRenderPlan`：折叠只藏过程成员）。
 *
 * 显式写形状（不用 `Extract<T, …>`）：链项类型是泛型参数时 `Extract` 推不出来（真踩过）。
 */
export interface ProcessGroupTextItem {
  kind: 'text'
  key: number
  text: string
}

/** 计划里的一项：一片，或者一个边界文本（永远可见）。 */
export type ProcessGroupEntry<T extends { kind: string }> =
  | { kind: 'group'; key: string; facts: DshRowGroup['facts']; items: T[] }
  | { kind: 'text'; item: ProcessGroupTextItem }

export interface ProcessGroupPlan<T extends { kind: string }> {
    /** 按链序排好的渲染计划（A 路只有片；B 路片与边界文本交错） */
    entries: Array<ProcessGroupEntry<T>>
    /** 是否可用：`false` = 没有分组事实 / 片数与宿主给的数目不符 → 调用方退回整回合形态 */
    ok: boolean
}

/** 链项的步号（只有过程项与文本项带；缺 = `undefined`，走 B 路）。 */
function stepOf(item: { kind: string }): number | undefined {
    const step = (item as { step?: unknown }).step
    return typeof step === 'number' ? step : undefined
}

/** `null`/缺省端按开区间处理：`fromStep = null` → 起点是 −∞。 */
function asBound(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' ? value : fallback
}

/**
 * 步号 `step` 是否属于第 `index` 片 —— 片区间是 `(fromStep, toStep]`（`null` 端按开区间）。
 *
 * 为什么 `fromStep` 是**不含**的：宿主的 `fromStep` = **上一次收口那一步**，而收口之后的过程成员
 * （"该步自己的工具在收口之后才进组"）属于**下一片** —— 所以本片从 `fromStep` 的**后一步**起算。
 * `toStep` = 本次收口那一步，它自己的项（收口前的工具/思考）正属于本片，所以这一端是**含**的。
 * 实测校准：32 片里 29 片的最小步号 == `fromStep`（差别恰好就是这一步），见 `14` §6。
 */
function inRange(step: number, group: DshRowGroup): boolean {
    return (
        step > asBound(group.fromStep, Number.NEGATIVE_INFINITY) &&
        step <= asBound(group.toStep, Number.POSITIVE_INFINITY)
    )
}

/**
 * 第 `index` 片能不能收下步号 `step` 的项。
 *
 * 除区间本身，还要接住两类**区间之外的**项（它们必然存在，且不能丢）：
 *   · 比首片起点还早的（`step <= 首片.fromStep`，例如回合起点那一步）→ 只能并进**首片**；
 *   · 比末片终点还晚的（`step > 末片.toStep`，例如**回答步自己的过程成员**）→ 只能并进**末片**。
 * 夹在两片区间**缝里**的（链与 groups 不同源）→ 谁都不接，见 `nearest`。
 */
function accepts(step: number, index: number, groups: readonly DshRowGroup[], groupCount: number): boolean {
    const group = groups[index]
    if (group === undefined) {
        return false
    }
    const first = asBound(groups[0]?.fromStep, Number.NEGATIVE_INFINITY)
    if (step <= first) {
        return index === 0
    }
    const last = asBound(groups[groupCount - 1]?.toStep, Number.POSITIVE_INFINITY)
    if (step > last) {
        return index === groupCount - 1
    }
    return inRange(step, group)
}

/**
 * 步号落在**两片区间缝里**时的归宿：**区间终点最小的那一片**。
 *
 * 为什么不再"整条计划作废"：实测（`14` §6，30 个会话 199 条带 `groups` 的行）里，落在缝里的行
 * **全部**是「同回合多行」—— 宿主把整回合的 `groups` 给了每一段行，而每段只带自己那截链，
 * 于是步号天然有洞。整条作废 = 这些行全部退回整回合单头（功能在最需要它的场景里从不生效）。
 * 归给"终点最小的那一片"是**就近**且内容不丢的选择（该片的步区间正好结束在这一步之前）。
 */
function nearest(step: number, groups: readonly DshRowGroup[]): number {
    let best = 0
    let bestTo = Number.NEGATIVE_INFINITY
    for (let i = 0; i < groups.length; i += 1) {
        const to = asBound(groups[i]?.toStep, Number.POSITIVE_INFINITY)
        if (to <= step && to > bestTo) {
            bestTo = to
            best = i
        }
    }
    return best
}

/**
 * A 路：按步号把每一项放进对应的片。
 *
 * **先滤掉"与本行链不相交"的组**（同回合多行时宿主把整回合的 `groups` 给了每一段行 —— 别的段那些组
 * 的步号区间在这截链里一个项都收不到）。滤掉它们是**正确**的：本行根本不含那段过程，那些组在页面侧
 * 不该有片（留着只会变成空片 → 整条计划作废 → "按片出头"在这类回合里完全不生效）。
 * 剩下的项按 `(fromStep, toStep]` 归片，落不进区间的**就近**归片（内容不丢）。
 */
function planByStep<T extends { kind: string }>(
    chain: readonly T[],
    groups: readonly DshRowGroup[]
): ProcessGroupPlan<T> {
    // 本行链上出现过的步号（去重排序，只用于"某个组的区间里有没有本行的项"这一问）
    const steps = [...new Set(chain.map((item) => stepOf(item)).filter((s): s is number => s !== undefined))]
        .sort((a, b) => a - b)
    const scoped = groups.filter((group) => {
        const from = asBound(group.fromStep, Number.NEGATIVE_INFINITY)
        const to = asBound(group.toStep, Number.POSITIVE_INFINITY)
        // ⚠️ 这里用**闭区间**判断"相交"（与归片用的 `inRange` 的 `(from, to]` 不同）：
        // 归片是"这一步该归哪一片"，而相交是"这片的过程有没有可能在这截链里" —— 一侧端点相等的组
        // 也可能收到链上跨过来的项（见 `nearest`：缝里的项归给"终点最小的那一片"）。
        return steps.some((step) => step >= from && step <= to)
    })
    if (scoped.length === 0) {
        return { entries: [], ok: false }
    }

    const buckets: T[][] = scoped.map(() => [])
    const entries = (): Array<ProcessGroupEntry<T>> =>
        scoped.map((group, index) => ({
            kind: 'group' as const,
            key: group.key,
            facts: group.facts,
            items: buckets[index] ?? [],
        }))

    let pending: T[] = []
    const push = (index: number, item: T): void => {
        const bucket = buckets[index]
        if (bucket === undefined) {
            return
        }
        // ⚠️ 待定项要排在**本项之前**（它们出现在链上更早，只是刚知道该归哪一片）；不是 push 之后再挪。
        bucket.push(...pending, item)
        pending = []
    }

    /** 已经被选中的最靠后的片（收尾时据此跳过它之后的空片）。 */
    let cursor = 0

    for (const item of chain) {
        const step = stepOf(item)
        if (step === undefined) {
            pending.push(item)
            // 待定项**立刻**跟着"最近的已归片"走：这样同一片内多项交错时不会跨片错位
            //（只在还没归过任何片时才真的攒着，等第一片收下它们）
            if (buckets.some((bucket) => bucket.length > 0)) {
                const last = buckets.reduce((acc, bucket, index) => (bucket.length > 0 ? index : acc), 0)
                const bucket = buckets[last]
                if (bucket !== undefined) {
                    bucket.push(...pending)
                    pending = []
                }
            }
            continue
        }
        // 找"能收下这一步的片"（片区间 `(fromStep, toStep]`，见 `inRange`）—— **从头扫**（片按收口顺序下发）。
        // 落在缝里的（同回合多行时步号有洞）→ 就近归给"终点最小的那一片"（见 `nearest`）。
        let index = -1
        for (let i = 0; i < scoped.length; i += 1) {
            if (accepts(step, i, scoped, scoped.length)) {
                index = i
                break
            }
        }
        if (index === -1) {
            index = nearest(step, scoped)
        }
        push(index, item)
        // 指针滚动到"已经被选中的最靠后的片"：收尾时据此跳过它之后的片
        if (index > cursor) {
            cursor = index
        }
    }
    // 末尾还没归片的（步号缺失的尾巴）→ 并进末片
    if (pending.length > 0) {
        buckets[cursor]?.push(...pending)
    }
    /**
     * **跳过后缀空片**：同回合多行时宿主把整回合的 `groups` 给了每一段行，于是"这一段链里一个项都
     * 落不到"的组是**常态**（别的段那些组）。留着它们只会让计划整体作废（`ok:false`）→ 按片出头
     * 在这类回合里完全不生效；丢掉它们则**一个项都不丢**（空片本来就没有内容），只是头少一个。
     * 它之后（`cursor` 之后）的片一律没有项，所以整支跳过；`cursor` 之前的片若为空，说明链与 groups
     * 真的不同源 → 仍按下面的兜底退回整回合形态。
     */
    if (buckets.slice(0, cursor + 1).some((bucket) => bucket.length === 0)) {
        return { entries: [], ok: false }
    }
    return { entries: entries().slice(0, cursor + 1), ok: true }
}

/** B 路：按链上位置切（每个 `text` 项是边界、边界不属任何片）。 */
function planByPosition<T extends { kind: string }>(
    chain: readonly T[],
    groups: readonly DshRowGroup[]
): ProcessGroupPlan<T> {
    const entries: Array<ProcessGroupEntry<T>> = []
    let count = 0
    let pending: T[] = []
    const flush = (): void => {
        if (pending.length === 0) {
            return
        }
        const group = groups[count]
        count += 1
        // 片数对不上时最后整体判失败（这里缺组也要占位，保证走查形状一致）
        entries.push({
            kind: 'group',
            key: group?.key ?? `#${String(count - 1)}`,
            facts: (group?.facts ?? undefined) as DshRowGroup['facts'],
            items: pending,
        })
        pending = []
    }
    for (const item of chain) {
        if (item.kind === 'text') {
            flush()
            // 断言：`T` 被约束成 `{ kind: string }`，TS 无法把 `kind === 'text'` 收窄到"带 text 的那一支"
            //（泛型不收窄）—— 这里由**调用契约**保证（链上 `kind:'text'` 的项必有 `text`）。
            entries.push({ kind: 'text', item: item as unknown as ProcessGroupTextItem })
            continue
        }
        pending.push(item)
    }
    flush()

    if (count !== groups.length) {
        return { entries: [], ok: false }
    }
    return { entries, ok: true }
}

/**
 * 把链切成"片"（A 路）或"片 + 边界文本"（B 路）的渲染计划。
 * @param chain - 本行的链（顺序即渲染顺序）。
 * @param groups - 宿主下发的过程分组（缺省 = 旧宿主 / 单回答步回合）。
 */
export function planProcessGroups<T extends { kind: string }>(
    chain: readonly T[],
    groups: readonly DshRowGroup[] | undefined
): ProcessGroupPlan<T> {
    if (groups === undefined || groups.length === 0) {
        return { entries: [], ok: false }
    }
    // 链上有没有**步号事实**：有 → A 路（与宿主同源的"按收口步配对"）；没有 → B 路（旧口径兜底）。
    const hasSteps = chain.some((item) => stepOf(item) !== undefined)
    if (hasSteps) {
        return planByStep(chain, groups)
    }
    return planByPosition(chain, groups)
}
