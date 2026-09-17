// 行模型的形状（适配上游 0.1.5-rc.2）——**只类型、零运行时代码**。
//
// 独立成文件是为了让页面侧能 `import type` 取用而不把实现打进包（见 docs/design/08 §9）。
import type { FileRef, ImageRef } from '../official/result-text';

/** 过程链上的一项（只放渲染所需的事实；标题/摘要这类**展示派生**由页面按需算）。 */
export type DshRowItem =
    | { kind: 'reasoning'; key: number; step?: number; index?: number; text: string }
    | {
        kind: 'tool';
        key: number;
        step?: number;
        /** 配对标识（工具结果据此配对；顶层没有，在 `message.source` 里） */
        callId?: string;
        name: string;
        argsRaw?: string;
        status: 'running' | 'ok' | 'error' | 'stopped';
        error?: string;
        /** 错误名（`tool/result.data.error.name`）；交付文件行拿它和错误码拼兜底正文 */
        errorName?: string;
        output?: string;
        exitCode?: number;
        signal?: string;
        /** 结果自带的卡数据源（`tool/result.data.meta` 原文；web 卡的 statusCode/sources、读族的 offset 等） */
        meta?: unknown;
        /** 结果原始内容块（仅当结果含图片块时带） */
        blocks?: unknown;
    }
    | {
        kind: 'context';
        key: number;
        content: unknown[];
        source: unknown;
        provenance: { role: 'inject' | 'recall'; label: string | null };
        form: string | null;
    }
    /** **非回答步**的文本（过程文本）：上游每步一个回答节点，插件一回合只开一条行 ——
     *  不把它放进链里，中间步的正文就会被后来那条整条覆盖、整段消失。 */
    | { kind: 'text'; key: number; step?: number; text: string };

/**
 * 一回合的「过程 / 回答」事实（见 docs/design/08 §12）——折叠判定的输入，与上游同构。
 * 锚点多数是源事件的 `seq`；上游的**合成锚点**用小数偏移（中断回答 −0.9 等），本插件只复制
 * **中断回答**那一项（见 `turn-process.ts`），其余以「区间 + 布尔事实」表达。
 *
 * 派生在 `turn-process.ts`（纯函数）：**没有过程证据时整个事实不存在**（返回 `null`）——
 * 对应上游"根本没有控制条节点"（此时连呈现都没有），消费方据此退回不折叠。
 */
export interface DshTurnProcess {
    /** 回答锚点 = 最后一步定稿回答的 seq；**null = 本回合没有「回答」**（含工具调用的末步不算） */
    answerAnchorSeq: number | null;
    /** 回答所在步 */
    answerStep: number | null;
    /** 过程控制锚（本回合最早的过程证据：每步首条可见 assistant 证据 / 工具调用 / 工具结果(append) / 重试） */
    controlAnchorSeq: number;
    /** 过程区间起点 */
    processStartSeq: number;
    /** 回答步自身是否含可见推理 */
    inlineReasoning: boolean;
    /** 过程区间内除回答步外是否还有别的过程成员 */
    hasExternalProcess: boolean;
    /**
     * 最终回答是否按**紧凑形态**收（上游 `compactAnswer`）。
     *
     * 判据：过程区间内、开场人类锚点之后、回答锚点之前**是否有新的人类消息**（插话或追加提问）。
     * 有 → false：回答与过程之间要留出常规间距，不被当成"紧贴折叠头的那一段"。
     * 与上游同：这里 user 与 steering 一视同仁（分类只影响行的种类，不影响这条判据）。
     */
    compactAnswer: boolean;
}

/**
 * 模型**声明**的交付文件（`deliverables/presented` 事件 = `present` 工具的落账）。
 *
 * 与「本轮改动」不是一回事：那个从写盘工具调用**推导**得出（成功结算 + 参数过关即可），
 * 不需要模型配合；这个只有模型显式声明才有，推导不出来。
 */
export interface DshPresentedFile {
    path: string;
    /** 模型给该文件的说明（可缺） */
    description?: string;
}

/**
 * 任务清单的一条（`todo/write` 事件里的条目）。
 *
 * 只有人类可读的一行内容与三态状态：清单每次都是**整表替换**，条目无需稳定身份，
 * 因此没有 id、优先级或"进行中动词"。**没有失败/取消态** —— 调用被拒就不落事件，清单保持上一份。
 */
export interface DshTodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}

/** 一行（宿主侧构建，供页面渲染）。上下文注入不是行，它是回答行**链上的一项**（见 design/06 §2）。 */
export type DshStreamRow =
    | {
        kind: 'user';
        key: number;
        text: string;
        /** 提交标识（页面据此认领本地已出的乐观行，见 design/08 §11） */
        rpcId?: string;
        /**
         * **插话**：这条消息是被当前回合的下一步取用的（走 next-step 收件箱），不是自己单独一轮的提问。
         *
         * 只由收件箱的 splice 史判定（见 `rows/inbox-claims.ts`）—— 事件形状上两者无法区分。
         * 用途：与普通提问在语义上分开（上游的 `steering` 节点），并参与过程区间内的人类锚点判定。
         */
        steering?: true;
        /** 事件自带时刻（epoch 毫秒；时钟格式化在页面） */
        timeMs?: number;
        /** 图片附件**引用**（字节由附件层按需取）。实时发送的内联图在页面本地行上，认领时合并进来 */
        imageRefs?: ImageRef[];
        /** 随该消息发出的文件（只有名字/字节，无本地路径）——历史回放与实时共用同一读法 */
        files?: FileRef[];
      }
    /** 系统提示词行：位置在该回合用户提问**之前**（构建时即按序插入，页面不再自己找位）。 */
    | { kind: 'sysprompt'; key: number; text: string }
    | {
        kind: 'assistant';
        key: number;
        text: string;
        done: boolean;
        /**
         * 所属回合号。**同一个回合可能有多条回答行**（插话把它切成「前段 / 后段」两段）。
         *
         * 用途：过程折叠是**回合级**的（上游只有 `turn-process` 那一个控制节点出折叠头，被它收起来的是
         * 整个回合过程区间里的节点）—— 页面按它把同回合的行归成一组，只让首行出折叠头。
         */
        turn?: number;
        /** 终止原因（上游取值原样；正常完成不带） */
        status?: string;
        chain: DshRowItem[];
        /** 过程折叠计数（上游口径）：折叠头文案直接用；**页面不自行重算**，避免两份口径 */
        counts: { toolCallCount: number; messageCount: number; subagentCount: number };
        /** 该回答的事件时刻（epoch 毫秒；时钟格式化在页面） */
        timeMs?: number;
        /** 折叠判定的事实（回合关闭时写入；进行中的回合没有它 → 与控制条「回合已关」门控一致） */
        process?: DshTurnProcess;
        /** 终止原因为 error 时的**原始错误消息**（服务端原文，不翻译） */
        endMsg?: string;
        /** 回答锚点的事件序号（本回合最后一条**带文本**的 append 结算消息）：
         *  作「从此处分叉」传给 `session/fork` 的 `atSeq`。没有回答的回合不带。 */
        seq?: number;
        /** 回答锚点的**消息标识**（上游 `assistant/message` 的 `message.id`）：
         *  消息反馈（👍/👎）的 `messageId`。服务端只认 append 语义的 assistant 消息，故缺失即不提供反馈。 */
        messageId?: string;
        /** 用量 / 用时原始统计（与既有实时通路同源；页面据此渲染图标与弹窗） */
        stats?: Record<string, unknown>;
        /** 本回合模型声明的交付文件（渲染在回答正文之后、动作条之前；没有声明就不带这个字段） */
        presentedFiles?: DshPresentedFile[];
        /**
         * 这一回合是**从历史读回来的**（不是本订阅期间实时产生的）。
         *
         * 用途：回合尾部的「本轮文件改动 / 交付文件」只在**实时**回合显示 —— 打开历史会话时，
         * 网页端也不显示那两块（它只在实时收到事件时把交付物挂到回合上）。数据本身在行里一直都在，
         * 所以由渲染侧按这个标识决定显不显示；判定见 `buildRows` 的历史水位。
         */
        fromHistory?: boolean;
    };

/** 一条上游事件（保结构：序号、回合/步、类型与载荷）。 */
export interface DshStreamEvent {
    type?: string;
    seq?: number;
    /** 事件自带时刻（epoch 毫秒；统计与时钟用） */
    time?: number;
    data?: Record<string, unknown>;
    /** 实时增量帧（`assistant-stream`）的载荷：`{ type, step, index, chunk }` */
    frame?: Record<string, unknown>;
    /** 表层操作（`'append'` / `{ op:'replace' }`）：结算类判据只认 append */
    surfaceOp?: unknown;
}
