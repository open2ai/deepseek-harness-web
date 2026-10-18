// 「按 id 复用会话」的结果判定（纯函数，供 dshService 的两处登记路径共用）。
//
// 为什么需要判定：`session/create` 带 `sessionId` 时**不再保证**按该 id 复用 —— 宿主只在
// 「这个会话还是空白、位置相符、没有别的写者」时才复用；否则它会**新建**一条 id 由自己铸造的会话，
// 并把新建的那条返回。也就是说返回值可能**不等于**请求的 id。
//
// 这条语义变化是静默的：调用仍返回成功，只是"你以为收养了 A，其实建出了 B"。所以调用方必须
// 拿返回值与请求值对一下，再决定后续动作。判定单独放这里，便于脚本直接喂形状。

/** 一次「按 id 创建/复用」的结果。 */
export type AdoptionOutcome =
    /** 没有请求 id：宿主新铸了一条。 */
    | 'created'
    /** 宿主按请求的 id 复用了它（历史与 id 不变）。 */
    | 'reused'
    /** 请求的 id 没有被复用；宿主另建了一条（`returned` 与 `requested` 不同）。 */
    | 'replacement'

export interface AdoptionInput {
    /** 请求里带的会话 id（不带时为空） */
    readonly requested?: string;
    /** 宿主实际返回的会话 id */
    readonly returned: string;
}

/**
 * 判定一次创建/复用的结果。
 *
 * @param input - 请求的 id 与宿主返回的 id
 * @returns `created`（没请求 id）/ `reused`（同一条）/ `replacement`（另有其事）
 */
export function adoptionOf(input: AdoptionInput): AdoptionOutcome {
    if (input.requested === undefined || input.requested === '') {
        return 'created';
    }
    return input.returned === input.requested ? 'reused' : 'replacement';
}
