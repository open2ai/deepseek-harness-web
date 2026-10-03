// 排队项的**形状**（只类型、零运行时代码）。
//
// 独立成文件是为了让页面侧能 `import type` 取用而不把宿主实现拖进类型图：
// 页面自己的类型工程里没有 node 类型，若经 control.ts（它 import 了带 node:crypto/node:http 的 mux）
// 绕一圈取类型，会把整条宿主依赖链一起拉进来。与行模型拆出 `rows/types.ts` 同一个理由。

/**
 * 队列里的一条（只取本插件用得到的字段；形状随上游，不透明字段一律不解析）。
 *
 * **这是本插件自己的契约，不是上游形状**：上游 0.1.7 删掉了队列条目类型与 `placement` 字段，
 * 改由 inbox 投影（两条数组：`next-turn` / `next-step`）承载。`placement` 与 `rpcId` 现由
 * `control.ts` 从数组名与 `source` 推出来，**对外接口保持不变**，故页面与 `queue-view` 零感知。
 */
export interface DshQueueItem {
    /** 条目标识（上游 inbox 里的 `message.id`）：队列的增删改都以它为键。 */
    id: string;
    /** queued = 排到下一轮；steering = 插话（投到下一步）；context = 注入的上下文，不是用户消息。 */
    placement: 'queued' | 'steering' | 'context';
    /** 提交标识：本面板提交的条目带它（与 user/message 回显同一个值，用于认领本地乐观条目）。 */
    rpcId?: string;
    /** 原始内容块（文本 + 附件引用）；正文由消费方从里面取，本层不解析。 */
    content: unknown[];
}

/** 一条排队消息里的附件（排队阶段只有引用与名字/大小，没有本地路径）。 */
export interface DshQueueAttachmentView {
    kind: 'image' | 'file';
    name?: string;
    attachmentId?: string;
    bytes?: number;
}

/** 一条排队消息（队列卡的数据源）。**不是行**：队列不属于任何回合，也不进对话流。 */
export interface DshQueueItemView {
    /** 条目标识：编辑 / 删除 / 转插话都以它为键。 */
    id: string;
    placement: 'queued' | 'steering';
    /** 提交标识：本面板提交的条目带它，页面据此把本地那条「发送中」认领掉。 */
    rpcId?: string;
    /** 正文预览（多个文本块之间留一个空格，避免「图前图后两段」被粘成一个词）。 */
    text: string;
    /** 缺省 = 没有附件（不是空数组，页面少一个分支）。 */
    attachments?: DshQueueAttachmentView[];
}
