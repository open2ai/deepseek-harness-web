// 对话相关的**类型契约**（适配上游 0.1.7-rc.2）。
//
// ⚠️ 这里曾经还有一整套「本轮等待」实现（`waitTurn` / `askInSessionStreaming`）：它**每轮自己再开一条**
// `session/follow`，从那条流里取增量、用法与终止原因。宿主改成常驻订阅（`follow.ts`）+ 单一构建器
// （`rows/build.ts`）之后，那套东西全是重复的：增量、用量、终止原因、正文都已经由常驻订阅驱动、由行承载。
// 留着的代价不是"多几行"，而是**每个会话同时挂两条 follow**——临时流一断就被当成回合失败
// （真机事故 `DSH 会话流关闭`），并且多出来的订阅者扰动会话生命周期。故整段删除。
//
// 现在「等这一轮结束」由 `DshService.watchTurnEnd()` 骑在**已有那条**订阅上，用量/时刻从构建出的行里取。
export interface DshReplyStats {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    steps?: number;
    /** 该回答所用模型（assistant/message.source），UI 用量弹窗展示 */
    provider?: string;
    model?: string;
    /** 服务端事件时间算出的指标：本轮总用时(秒) / 输出速度(tok/s) / 首 token 用时(秒) */
    wallSec?: number;
    tps?: number;
    ttftSec?: number;
}
/** 过程折叠计数（三个计数：toolCallCount=非 subagent 工具调用数；
 *  messageCount=最终答复前带文本的中间 assistant 消息数；subagentCount=名字识别为 subagent 委派的调用数。
 *  三者全 0 时折叠头文案兜底「已思考」） */
export interface DshTurnCounts {
    toolCallCount: number;
    messageCount: number;
    subagentCount: number;
}
export interface DshApproval {
    approvalId?: string;
    /** 上游 `request.reason`：**审计原文**（英文、会写进会话日志），语义不变 */
    description?: string;
    /**
     * 上游 `request.displayReason`（dsh 0.1.7-rc.2 新增）：给人看的本地化文案 `{ en, zh, … }`。
     * 与 `description` 并行、互不覆盖；由 webview 决议用哪门语言（见 `core/approval-text.ts`）。
     */
    displayReason?: Record<string, string>;
    rpcId?: string;
    sessionId?: string;
    /** 待批准的真实工具名（上游 request.toolName），UI 直显 */
    toolName?: string;
}
export interface DshQuestionOption {
    label: string;
    description?: string;
}
export interface DshQuestion {
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: DshQuestionOption[];
    multiSelect?: boolean;
}
export interface DshQuestionRequest {
    rpcId?: string;
    sessionId?: string;
    questions?: DshQuestion[];
    /** 限时提问（dsh 0.2.0）的调用标识：超时后投影里就是同一个 `callId`（用于关掉过期弹窗）。 */
    callId?: string;
}
