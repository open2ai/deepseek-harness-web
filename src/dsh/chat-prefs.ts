// 上游「设置 → 通用设置」四项偏好的**取值与归一化**（纯函数、无 I/O）。
//
// 为什么单独一层：这些是**跟随上游设置**的判据，写错一个字符串就是「用户改了设置而插件没反应」。
// 纯函数才能被守卫直接钉住（`tmp/_chatprefs.follow.test.mjs`）；RPC/订阅留在 `settings.ts`。
//
// 上游出处（dsh 0.2.0-rc.2 复核；四项 schema 自 0.1.7-rc.1 起逐字未变）：
//   · 工作步骤展示 `transcriptView`：四档 + 两个旧值；**0.2.0 起**该字段
//     **无 schema 默认**、可为 `null`，缺失值由客户端决定（非桌面 Web = `detailed`、桌面端 = `standard`），
//     旧值 `normal` 与 `expanded` 都**读作 `detailed`**。本插件把 `standard` 与 `detailed` 归一到同一档
//     （见下 `policyOf`），因此上游这次改默认与旧值读法**不改本插件的落点值**。
//   · 性能与用量 `performanceUsage`（同一命名空间）：`['compact','detailed']`，默认 `detailed`。
//   · 代码工作工具 `enabled`（命名空间 `ui-settings`）：**偏好解析后默认开启**，只有显式关掉才是关。
//   · 繁忙时的发送行为 `busyEnter`：`['queue','steer']`，默认 `queue`。

/** 过程折叠形态：插件只有两档（`compact`=已完成回合收成折叠头 / `normal`=过程行平铺）。 */
export type DshTranscriptView = 'normal' | 'compact';

/**
 * 上游策略表的 `stepGrouping` 列（0.2.0 起）：过程分组头的覆盖范围（「compact」所有回合 /
 * 「history」仅已关闭回合 / 「none」不分组）。上游唯一的消费点是分组头的显示判据。
 */
export type DshStepGrouping = 'collapsed' | 'history' | 'none';

/** 性能与用量详略：`compact` 时不显示会话统计与每轮用量。 */
export type DshPerformanceUsage = 'compact' | 'detailed';

/** 繁忙时按回车（或发送键）的投递方式。 */
export type DshBusyEnter = 'queue' | 'steer';

/** 四项偏好的生效值（读不到时各自取上游默认）。 */
export interface DshChatPrefs {
    /** 工作步骤展示 → 插件两档（见 `transcriptViewOf` 的映射理由） */
    readonly transcriptView: DshTranscriptView;
    readonly performanceUsage: DshPerformanceUsage;
    /** 代码工作工具（关掉时上游隐藏预设选择器与交付卡片） */
    readonly developerTools: boolean;
    readonly busyEnter: DshBusyEnter;
    /**
     * 上游四档策略里的三个门（`presentation-policy.ts` 的 `ChatPresentationPolicy`）：
     * · `settledReasoningPreview` —— 已定稿的思考行**在标题旁预览首行**（`compact` 关，其余三档开）；
     * · `liveProcessDetail` —— 进行中显示过程细节（`compact`/`verbose` 关，`standard`/`detailed` 开）；
     * · `stepGrouping` —— 过程分组头的覆盖范围（`compact`/`standard` = 所有回合、`detailed` = 仅已关闭回合、
     *   `verbose` = 不分组）。插件已按它实现「进行中回合要不要出分组头」（见 `webview/chat/core/process-fold.ts`）。
     */
    readonly settledReasoningPreview: boolean;
    readonly liveProcessDetail: boolean;
    readonly stepGrouping: DshStepGrouping;
}

/** 读不到设置时的生效值 = 上游默认（0.2.0：非 Desktop Web 的客户端默认 = `detailed`）。 */
export const DEFAULT_CHAT_PREFS: DshChatPrefs = {
    transcriptView: 'compact',
    performanceUsage: 'detailed',
    developerTools: true,
    busyEnter: 'queue',
    settledReasoningPreview: true,
    liveProcessDetail: true,
    stepGrouping: 'history',
};

/** `settings/describe` 里一个命名空间（只取本模块关心的两段）。 */
export interface DshSettingsNamespace {
    readonly ns?: string;
    /** 合成后的生效值（含 schema 默认与 base） */
    readonly value?: Record<string, unknown>;
    /** 用户段 */
    readonly user?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * 工作步骤展示 → 插件两档。
 *
 * 映射理由（网页端说明原文）：
 * **简洁、标准、详细三档都会「收起符合条件的已完成轮次」**，只有**完全展开（`verbose`）**不收起、
 * 过程行直接显示 —— 也就是说 `verbose` 才对应插件的「平铺」，其余（含默认 `standard`、
 * 旧值 `normal`/`expanded`、缺失或非法值）都对应「折叠」。
 */
export function transcriptViewOf(raw: unknown): DshTranscriptView {
    return raw === 'verbose' ? 'normal' : 'compact';
}

/**
 * 工作步骤展示 → 上游策略表的 `stepGrouping` 列（过程分组头的覆盖范围）。
 *
 * 与 `transcriptViewOf` / `policyOf` 同源同表，逐档对应 `presentation-policy.ts` 的 `POLICIES`：
 *   `compact` / `standard` → `collapsed`（所有回合都有可折叠的分组头，含进行中的回合）
 *   `detailed`             → `history`（只有**已关闭**的回合有；进行中平铺、无分组头）
 *   `verbose`              → `none`（根本不分组，过程行平铺）
 *   旧值 `normal`/`expanded`、缺失、非法 → `detailed` 口径（0.2.0 起上游把三者都读作 `detailed`，
 *   非 Desktop Web 的客户端默认也是 `detailed`）→ `history`。
 *
 * 注意：`standard` 与 `detailed` 在**前两个门**上相同，只在这一列上不同 —— 这正是插件此前
 * 「两档看不出区别」的原因（缺的就是这一列）。
 * @param raw - 该字段的用户段原值
 * @returns 分组覆盖范围
 */
export function stepGroupingOf(raw: unknown): DshStepGrouping {
    if (raw === 'compact' || raw === 'standard') {
        return 'collapsed';
    }
    if (raw === 'verbose') {
        return 'none';
    }
    return 'history';
}

/** 性能与用量：只有精确 `compact` 才是简洁，其余（缺失/非法）一律上游默认 `detailed`。 */
export function performanceUsageOf(raw: unknown): DshPerformanceUsage {
    return raw === 'compact' ? 'compact' : 'detailed';
}

/**
 * 代码工作工具：**默认开启**，只有显式 `false` 才算关。
 * 注意不能读 schema 默认（那是 `false`）—— 上游在偏好解析后把它翻转成默认开启。
 */
export function developerToolsOf(raw: unknown): boolean {
    return raw !== false;
}

/** 繁忙时发送行为：只有精确 `steer` 才是插话，其余（缺失/非法）一律上游默认 `queue`。 */
export function busyEnterOf(raw: unknown): DshBusyEnter {
    return raw === 'steer' ? 'steer' : 'queue';
}

function userOf(namespaces: readonly DshSettingsNamespace[], ns: string): Record<string, unknown> | null {
    const found = namespaces.find((item) => item?.ns === ns);
    return found === undefined ? null : asRecord(found.user);
}

/**
 * 上游四档的**策略表**（逐字，0.2.0 起）：
 *
 * | 档 | foldCompletedTurns | stepGrouping | liveProcessDetail | settledReasoningPreview |
 * |---|---|---|---|---|
 * | compact  | true  | collapsed | false | false |
 * | standard | true  | collapsed | true  | true  |
 * | detailed | true  | history   | true  | true  |
 * | verbose  | false | none      | false | true  |
 *
 * 插件已对齐 `foldCompletedTurns`（→ `transcriptView`）、后两列（→ 思考行预览/进行中细节）与
 * `stepGrouping`（→ 分组头覆盖范围，见 `stepGroupingOf` 与 `webview/chat/core/process-fold.ts`）；
 * 四档因此各有可辨别的行为，`standard` 与 `detailed` 的差别在**进行中回合**是否出分组头。
 */
function policyOf(raw: unknown): { settledReasoningPreview: boolean; liveProcessDetail: boolean } {
    const mode = raw === 'compact' || raw === 'standard' || raw === 'detailed' || raw === 'verbose'
        ? raw
        // 旧值 / 非法值按上游读法归一到当前档：0.2.0 起 `normal` 与 `expanded` 都读作 `detailed`，
        // 缺失/`null` 由客户端默认决定（非 Desktop Web = detailed）。本插件 `standard` ≡ `detailed`
        // （见下 switch：两档的策略列逐字相同），故统一归到 `standard` 与上游等价。
        : raw === 'normal' || raw === 'expanded'
            ? 'standard'
            : 'standard';
    switch (mode) {
        case 'compact':
            return { settledReasoningPreview: false, liveProcessDetail: false };
        case 'detailed':
        case 'standard':
            return { settledReasoningPreview: true, liveProcessDetail: true };
        case 'verbose':
            return { settledReasoningPreview: true, liveProcessDetail: false };
    }
}

/**
 * 把 `settings/describe` 的命名空间表归一化成四项偏好。
 *
 * 读**用户段**（`user`）而不是合成值（`value`）：这四个都是「用户选了什么」，
 * `value` 还叠着 schema 默认（0.2.0 起 `transcriptView` **已无** schema 默认，`performanceUsage` 仍有），会把"没选过"和"选了默认档"混为一谈。
 * @param namespaces - `settings.describe` 应答里的 namespaces。
 * @returns 四项生效值 + 三个策略门；缺失/非法字段各自回落到上游默认。
 */
export function chatPrefsOf(namespaces: readonly DshSettingsNamespace[]): DshChatPrefs {
    const chat = userOf(namespaces, 'ui-chat');
    const general = userOf(namespaces, 'ui-settings');
    const conversation = userOf(namespaces, 'ui-conversation');
    const transcriptRaw = chat === null ? undefined : chat['transcriptView'];
    return {
        transcriptView: transcriptViewOf(transcriptRaw),
        performanceUsage: performanceUsageOf(chat === null ? undefined : chat['performanceUsage']),
        developerTools: developerToolsOf(general === null ? undefined : general['enabled']),
        busyEnter: busyEnterOf(conversation === null ? undefined : conversation['busyEnter']),
        ...policyOf(transcriptRaw),
        stepGrouping: stepGroupingOf(transcriptRaw),
    };
}

/** 两项偏好是否等价（订阅去重用；只比字段值，不比顺序）。 */
export function sameChatPrefs(a: DshChatPrefs, b: DshChatPrefs): boolean {
    return a.transcriptView === b.transcriptView
        && a.performanceUsage === b.performanceUsage
        && a.developerTools === b.developerTools
        && a.busyEnter === b.busyEnter
        && a.settledReasoningPreview === b.settledReasoningPreview
        && a.liveProcessDetail === b.liveProcessDetail
        && a.stepGrouping === b.stepGrouping;
}
