// 消息反馈（👍/👎）：每条 assistant 消息的正/负评价（适配上游 0.1.7-rc.2）。
//
// 上游把它做成独立的远程命名空间 `messageFeedback`（list / put / delete），**不在 session 命名空间下**，
// 且评价只进会话日志、**永不进模型上下文**。
//
// ⚠️ 结果是**两层信封**：外层是本插件 rpcCall 已经验过的 carrier（`result.ok`），
// 内层才是业务成败（`value.ok`）。所以 `rpcCall` **不会**因业务失败抛错 —— 它把 `{ok:false,error}` 作为**值**返回，
// 由调用方按 code 决定文案（version-conflict / note-too-large 都要给用户不同的提示）。
import { rpcCall } from './rpc';

/** 评价：正/负。取值即上游 wire 字面量，不做本地映射。 */
export type FeedbackRating = 'positive' | 'negative';

/** 反馈分类（上游固定分类表，id 即可直接用作字典键：`category.<id>`）。 */
export const FEEDBACK_CATEGORIES = [
    'task-result',
    'instruction-following',
    'product-interaction',
    'service-stability',
    'resource-cost',
    'security-privacy-permission',
    'other',
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** 一条反馈的当前值。`version` 是等值比较用的令牌（每次实质改动都换新），CAS 靠它。 */
export interface MessageFeedbackItem {
    messageId: string;
    rating: FeedbackRating;
    note?: string;
    category?: FeedbackCategory;
    version: string;
    createdAt: number;
    updatedAt: number;
}

/** 业务失败：`code` 之外的字段按上游原样带（`current` 是权威现值，冲突时用它对齐）。 */
export interface FeedbackError {
    code?: string;
    current?: MessageFeedbackItem | null;
    [key: string]: unknown;
}

/** 业务成败。`ok:false` **不是**传输错误。 */
export type FeedbackOutcome<T> = { ok: true; value: T } | { ok: false; error: FeedbackError };

/** 读某会话的全部反馈（首次交互时才读，见 UI 侧的懒加载）。 */
export async function listMessageFeedback(sessionId: string): Promise<MessageFeedbackItem[]> {
    const result = await rpcCall<FeedbackOutcome<{ items: MessageFeedbackItem[] }>>('messageFeedback.list', { sessionId });
    if (!result.ok) {
        throw new Error(`读取反馈失败（${result.error.code ?? '未知错误'}）`);
    }
    return result.value.items ?? [];
}

/**
 * 写入或替换一条反馈。
 * @param ifVersion - 观察到的现值版本；`null` = 要求当前**没有**这条反馈（首次评价）。
 *   用观察到的版本做 CAS：别处改过就会拿到 `version-conflict`，而不是把别人的改动覆盖掉。
 */
export async function putMessageFeedback(request: {
    sessionId: string;
    messageId: string;
    rating: FeedbackRating;
    note?: string;
    category?: FeedbackCategory;
    ifVersion: string | null;
}): Promise<FeedbackOutcome<MessageFeedbackItem>> {
    return await rpcCall<FeedbackOutcome<MessageFeedbackItem>>('messageFeedback.put', request);
}

/** 撤回一条反馈（同版本 CAS；本来就已不存在时服务端直接成功）。 */
export async function deleteMessageFeedback(request: {
    sessionId: string;
    messageId: string;
    ifVersion: string;
}): Promise<FeedbackOutcome<{ absent: true }>> {
    return await rpcCall<FeedbackOutcome<{ absent: true }>>('messageFeedback.delete', request);
}
