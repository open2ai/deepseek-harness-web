// 行模型的形状（适配上游 0.1.7-rc.2）——**只类型、零运行时代码**。
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
        /**
         * `preparing` = **已声明、参数还没到**（上游 `RunningToolCall.phase === 'preparing'`）：
         * 只有一条「带名字的工具增量」到达时才会出现，`tool/call` 一到就**原地升级**成 `running`。
         * 它算一次调用、不解析参数、渲染成**一条不可展开的行**；历史通路直接从 `tool/call` 开始。
         */
        status: 'preparing' | 'running' | 'ok' | 'error' | 'stopped';
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
        /**
         * 落在哪一步（可缺省）。**必须尽量填**：链按步归位时「没有步号」的项恒定排在所有已知步之后
         * —— 缺了它，注入就会跑到链尾（真机现象「工具行上下文注入跑到下面去了」）。
         */
        step?: number;
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
    /**
     * 载入的窗口里**有没有本回合的 `turn/start`**（上游 `ChatTurnProcessPresentation.turnStarted`）。
     *
     * 用处：过程窗口是否就绪由 `turnStarted || turnClosed` 决定（0.2.0 起的 per-Turn 判据）——
     * 「拿到了回合结尾但没拿到它的开头」照样可以折叠；而**历史被分页截断本身不是禁止折叠的理由**
     * （旧版上游那道 `historyIncomplete` 已被删除）。
     */
    turnStarted: boolean;
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
    /**
     * **过程分组**（上游的 step-group）：在「带回答内容的步」处收口，一片一段。
     *
     * 用途：对齐上游「每个过程段一条折叠头」的呈现 —— 页面按片出头、按片判折叠、
     * 按片存展开态；没有它时插件只能整回合一条头（`docs/design/12` §1.1 的结构性差异）。
     *
     * 缺省 = 没有分组信息（旧宿主 / 单步回合）：消费方退回「整回合一条头」的既有形态。
     */
    groups?: DshRowGroup[];
}

/** 一片（上游 step-group）的过程事实：与回合级**同一套判据**，只是区间不同。 */
export interface DshRowGroupFacts {
    /** 该片的回答锚点 = 收口那一步的定稿（或首条可见）证据序号 */
    answerAnchorSeq: number | null;
    /** 收口那一步的步号 */
    answerStep: number | null;
    /** 该片的收口步自身是否含可见推理 */
    inlineReasoning: boolean;
    /** 与回合级同（窗口里有本回合的 `turn/start`） */
    turnStarted: boolean;
    /** 该片的控制锚（片区间内最早的可见证据） */
    controlAnchorSeq: number;
    /** 该片的过程区间起点 */
    processStartSeq: number;
    /** 片区间内除收口步外是否还有别的过程成员 */
    hasExternalProcess: boolean;
    /** 片区间内是否有人插话（上游 `compactAnswer` 的片级形态） */
    compactAnswer: boolean;
}

/** 一片过程：稳定身份 + 它覆盖的步区间 + 它自己的过程事实。 */
export interface DshRowGroup {
    /** 稳定身份（上游按 `['process', 首成员 key, groupPart]`）：这里用 `步区间 + 回答锚点` 派生 */
    key: string;
    /** 该片覆盖的步区间（含端点）；`null` = 该端无步号 */
    fromStep: number | null;
    toStep: number | null;
    facts: DshRowGroupFacts;
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
    /**
     * 回合**终局通知**行（**独立行**，镜像上游两个节点：`turn-error` 与 `turn-max-tokens`）。
     *
     * 两者上游都是独立节点、都在 `conversation-nodes/process-groups.ts:13` 的 `INDEPENDENT` 集合里
     * （结束前面的过程组、作为独立根保留、**不被折进过程组**），渲染也共用同一套布局
     * （两个独立终局节点）→ 插件用一个行 + `tone` 表达：
     * · `error`（`turn-error`）：由 `turn/start` + `turn/end` 建，**与本回合有没有内容无关**；带 `message`/`code`；
     * · `warning`（`turn-max-tokens`）：`turn/end` 的 `reason.kind === 'max-tokens'`；文案固定，无 `message`/`code`。
     * 位置 = 该回合末尾（回答行之后）。文案由页面决议（`webview/chat/core/turn-copy.ts`）。
     */
    | {
        kind: 'turnNotice';
        key: number;
        tone: 'error' | 'warning';
        /** 通知所属回合 */
        turn?: number;
        /** 该回合的最后一步（上游两个节点的 `lastStep`，同口径） */
        step?: number;
        /** 失败原文（**仅 `tone==='error'` 有**；`AUTH` 下不带 —— 可能回显被掩码的凭据） */
        message?: string;
        /** 失败标识（上游 `turn/end.reason` 的 code）：页面据此取上游固定中文 */
        code?: string;
      }
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
        /** **消息级**「这条回答被中断」（上游 `assistant/message.data.interrupted`，见 `conversation-nodes/assistant.ts:207`）：
         *  正文末尾据此出「已停止」（与上游同位）。 */
        interrupted?: true;
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
