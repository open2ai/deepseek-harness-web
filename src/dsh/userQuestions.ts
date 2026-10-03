// 迟到回答（timed 提问）的**宿主侧**形状与结果判读 —— 独立纯函数文件（适配 dsh 0.2.0）。
//
// 这是 wire 契约那一半：补答的远端签名是**多个命名形参**（agent / callId / answer），
// 所以 args **必须平铺**成 `{ agentId, callId, answer: { answers: [...] } }`；包一层 `request`
// 会被网关直接拒（本仓已两次踩过这个坑，见 auth.ts 的平铺表）。
//
// 返回值语义（逐字来自上游文档注释）：
//   · `false` = 该题**已经不是**可补答态（已被答过 / 已结算）—— **不是错误**，界面收敛即可；
//   · `REPLY_QUEUED` = 同一题已有排队中的回复 —— 也**不是失败**（用户会看到回复在队列里）；
//   · `BAD_ANSWER` = 批次没有恰好覆盖每道题一次（本地按题构造，正常不该出现）→ 真失败。
//
// 页面侧那一半（从 `userQuestions` 投影里挑出可补答的调用）在 `webview/chat/core/late-answer.ts`：
// 一个管 wire、一个管展示数据，分开才能各自被守卫直接喂用例。

/** 一条作答（与上游 `AskUserQuestionAnswerItem` 同形，也与既有提问提交体一致）。 */
export interface DshLateAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}

/** 补答 remote 的 args（**平铺**，键名与上游形参逐字对应）。 */
export interface DshLateAnswerArgs {
    agentId: string;
    callId: string;
    answer: { answers: DshLateAnswerItem[] };
}

/**
 * 组装补答的 args。
 * @param sessionId - 会话 id（上游形参名是 agent，wire 字段名是 agentId）。
 * @param callId - 该次提问的调用标识。
 * @param answers - 每条作答；上游要求**恰好覆盖该题集的每道题一次**。
 */
export function lateAnswerArgs(
    sessionId: string,
    callId: string,
    answers: readonly DshLateAnswerItem[]
): DshLateAnswerArgs {
    return {
        agentId: sessionId,
        callId,
        answer: { answers: answers.map((item) => ({ ...item, selected: [...item.selected] })) },
    };
}

/**
 * 补答结果该让界面怎么走。
 *
 * **必须同时看 `message`**：网关只对声明过的 `RemoteError` 透传业务码，
 * 而这条链路的业务错误不是 `RemoteError` —— 于是 `REPLY_QUEUED` / `BAD_ANSWER`
 * 到了客户端都变成 `code: 'gateway/internal'`，**只有 message 是原文**。
 * 所以判断顺序是：先认码（上游将来若透传就自然生效）→ 再认原文 message。
 * @param outcome - `returned` = 远端返回的布尔；`code` = 错误码；`message` = 错误原文。
 * @returns `settled` = 该题已有结论（收敛、**不提示错误**）；`queued` = 回复已排队/已受理（提示一句即可）；
 *          `failed` = 真失败（按错误码提示）。**`false` 与「已有排队回复」都不得判成 `failed`。**
 */
export function lateAnswerVerdict(outcome: {
    returned?: boolean;
    code?: string;
    message?: string;
}): 'settled' | 'queued' | 'failed' {
    if (outcome.code === 'REPLY_QUEUED') {
        return 'queued';
    }
    if (outcome.returned === false) {
        return 'settled';
    }
    if (outcome.code === 'gateway/internal' && (outcome.message ?? '').includes('already queued')) {
        return 'queued';
    }
    if (outcome.code !== undefined) {
        return 'failed';
    }
    return 'queued';
}
