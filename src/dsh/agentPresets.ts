// dsh 0.1.7+ agent 模式（preset roster）：远端 agentPresets/list 读取、agentPresets/read 查看组合，
// agentPresets/select 仅可在空白会话上切换（已开始会话后端会拒绝）。
import { rpcCall } from './rpc';

/** 一个远端模式行（路径无关，只按 id 寻址）。 */
export interface DshAgentPresetRow {
    id: string;
    trust: 'system' | 'user';
    isDefault: boolean;
    name?: string;
    description?: string;
    broken?: string;
}

/** 当前部署支持的模式列表 + 是否可本地新建。 */
export interface DshAgentPresetRoster {
    presets: DshAgentPresetRow[];
    authorable: boolean;
}

// ── rc.1 → rc.2 差异登记（**判「不用改」的依据，不要照上游的删除去删本文件**）──
//
// 上游的预设清单类型在
// dsh 0.1.7-rc.2 **删掉了 `modeSelectionEnabled: boolean`** —— 这是两版之间**唯一**的破坏性
// 类型变更。本插件**不受影响**：上面这个 `DshAgentPresetRoster` 是本插件的自有契约
// （`authorable` 是插件侧字段），**从来没有读过 `modeSelectionEnabled`**（全仓仅此一处声明、零使用）。
// 上游把语义简化成「`selectedDefault ?? default` 单开关」；本插件只按 `isDefault` 高亮，
// 因此两边仍然一致。rc.2 里 `agentPresets/list` 依旧**无参**、`read` 依旧**平铺 args**（见下）。

/** 读取 dsh 支持的 agent 模式列表（远端无参 list）。 */
export async function listAgentPresets(): Promise<DshAgentPresetRoster> {
    return rpcCall<DshAgentPresetRoster>('agentPresets.list', {});
}

/** 给空白会话切换 agent 模式（远端 select(session, agentPreset)）。 */
export async function selectAgentPreset(sessionId: string, agentPreset: string): Promise<string> {
    return rpcCall<string>('agentPresets.select', { agentId: sessionId, agentPreset });
}

/** 一个模式声明的**子插件组合**（`agentPresets/read` 的返回值）。 */
export interface DshAgentPresetDocument {
    agentPreset: string;
    /** 该模式声明的子插件组合（Loader 方言 YAML，即上游 `dsh.profile.bundles` 那层的写法）。 */
    content: string;
    name?: string;
    description?: string;
}

/**
 * 读某个模式声明的子插件组合（`@Remote('read')`，dsh 0.1.7 新增；0.1.7-rc.1 实测可用，
 * rc.2 契约面复核未变 —— `readDocument(agentPreset)` 的签名与返回形状两版一致）。
 *
 * 上游注释写明「for viewing only」：这是**给人看的**组合清单，不做生效判断、也不改任何东西。
 * args 形状必须是平铺的 `{args:{agentPreset}}`：包一层 request 会被网关描述符校验拒掉
 *（`gateway/arguments-invalid: missing "agentPreset"; unexpected "request"`，已在 `auth.ts` 登记）。
 */
export async function readAgentPreset(agentPreset: string): Promise<DshAgentPresetDocument> {
    return rpcCall<DshAgentPresetDocument>('agentPresets.read', { agentPreset });
}
