// 选择器切片：权限 / 模型 / 模式的选项状态与弹窗开关。
// 纯状态：不依赖消息行、不产生对话区行 —— 上游模型/权限选择都不在对话区显示结果（见 selectModel/selectPerm）。
import { signal } from '@preact/signals'
import { orderModelProviders } from '../model-order'
import type { ChatHost } from '../host'
import type { PermissionOption, ChatModelInfo, ChatAgentPreset } from '../protocol'
import type { ChatStore, SelectorState } from './types'

export interface SelectorsSlice {
  store: Pick<
    ChatStore,
    | 'sel'
    | 'permNameOf'
    | 'openPopup'
    | 'togglePopup'
    | 'openModelSearch'
    | 'closePopups'
    | 'selectPerm'
    | 'selectModel'
    | 'selectMode'
    | 'openModeConfig'
  >
  /** chatInfo 帧：写权限选项与当前值。 */
  setPermOptions(options: PermissionOption[] | undefined, currentValue: string | undefined): void
  /** chatInfo 帧：写模型分组与当前模型/推理等级。 */
  setModels(models: ChatModelInfo | undefined): void
  /** chatInfo 帧：写 agent 模式选项与锁定态。 */
  setModes(info: { presets?: ChatAgentPreset[] } | undefined, current: string | undefined, locked: boolean | undefined): void
  /**
   * **投影帧**：只挪「当前模式」（别处切模式时的跟随；选项表仍由 `setModes` 那份管）。
   * `undefined` = 这一帧没带该键 → 保持原值。
   */
  setCurrentMode(id: string | null | undefined): void
  reset(): void
}

export function createSelectors(host: ChatHost): SelectorsSlice {
  const permNameOf = new Map<string, string>()
  const openPopup = signal<'perm' | 'model' | 'mode' | 'modelSearch' | null>(null)
  const sel = signal<SelectorState>({
    permOptions: [],
    currentPerm: '',
    modelGroups: [],
    modelFailures: [],
    curProvider: '',
    curModel: '',
    curEffort: '',
    modeOptions: [],
    currentMode: '',
    modeLocked: false,
  })

  function closePopups(): void {
    openPopup.value = null
  }
  function togglePopup(w: 'perm' | 'model' | 'mode'): void {
    openPopup.value = openPopup.value === w ? null : w
  }
  function openModelSearch(): void {
    openPopup.value = 'modelSearch'
  }
  function rememberPermName(o: { value: string; name?: string }): void {
    permNameOf.set(o.value, o.name || o.value)
  }
  function setPermOptions(options: PermissionOption[] | undefined, currentValue: string | undefined): void {
    const opts = options ?? []
    for (const o of opts) rememberPermName(o)
    sel.value = { ...sel.value, permOptions: opts, currentPerm: currentValue ?? '' }
  }
  function selectPerm(value: string): void {
    const opts = sel.value.permOptions
    const found = opts.find((o) => o.value === value)
    if (found) rememberPermName(found)
    sel.value = { ...sel.value, currentPerm: value }
    host.post({ type: 'chatSelectPermission', preset: value })
    // **这里不补任何结果行**（原 `slashPickKind === 'permission'` 那条已删）。
    // 与上游一致：切权限在对话区**完全不显示**。依据节点可见性契约
    // 的 `isVisibleChatNode()` —— 它显式排除三类节点：`system-prompt`、`context`，
    // 以及 `command` 且 `name === 'permission'`。上游仍把 `command/run`/`command/done` 写日志
    //（轨迹可见），只是渲染进 chat 时过滤掉。
    // 反馈走 VS Code 通知（宿主侧，见 `extension` 的 chatSelectPermission）。
    // （`/model` 不同：上游模型选择是客户端 RPC、不产生命令生命周期，所以它保留本地那一行。）
    closePopups()
  }
  function setModels(models: ChatModelInfo | undefined): void {
    if (!models) return
    const cur = models.current
    sel.value = {
      ...sel.value,
      modelGroups: orderModelProviders(models.groups ?? []),
      modelFailures: models.failures ?? [],
      curProvider: cur?.provider ?? '',
      curModel: cur?.model ?? '',
      curEffort: cur?.reasoningEffort ?? '',
    }
  }
  function selectModel(provider: string, model: string, effort?: string): void {
    // 对齐上游 ui-model-selection selectionOf：
    //   重新选当前同一 provider+model → 保留当前推理等级；
    //   切到别的模型 → 用该模型 reasoning.defaultEffort（模型默认等级随模型走）。
    // 显式传 effort(用户主动改等级)时始终用它。
    const s0 = sel.value
    const sameRoute = s0.curProvider === provider && s0.curModel === model
    // '' 是「Default」(提供方默认) 的哨兵：显式清掉等级、不发给宿主，由上游按提供方默认解析。
    // 不能复用 undefined —— 那是「未指定」，要按 sameRoute/defaultEffort 自动推断
    const explicitDefault = effort === ''
    let eff = effort
    if (explicitDefault) {
      eff = undefined
    } else if (eff === undefined) {
      if (sameRoute) {
        eff = s0.curEffort || undefined
      } else {
        const g = s0.modelGroups?.find((x) => x.id === provider)
        const m = g?.models.find((x) => x.id === model)
        eff = m?.reasoning?.defaultEffort || undefined
      }
    }
    sel.value = { ...sel.value, curProvider: provider, curModel: model }
    if (eff !== undefined) {
      sel.value = { ...sel.value, curEffort: eff }
    } else if (!sameRoute || explicitDefault) {
      // 切走的模型没有默认等级 / 用户显式选 Default：本地先清空，等宿主 postChatInfo 回刷真实值
      sel.value = { ...sel.value, curEffort: '' }
    }
    host.post({
      type: 'chatSelectModel',
      provider,
      model,
      reasoningEffort: eff !== undefined ? eff || undefined : undefined,
    })
    // 不产生对话区行：上游模型选择是客户端 RPC，选中后只更新模型选择器，不在聊天区回显。
  }
  function setModes(info: { presets?: ChatAgentPreset[] } | undefined, current: string | undefined, locked: boolean | undefined): void {
    if (!info?.presets) return
    const rows = info.presets.filter((r) => !r.broken).map((r) => ({ id: r.id, name: r.name, description: r.description }))
    const currentMode =
      (current && rows.some((m) => m.id === current) ? current : '') || rows[0]?.id || ''
    const lockedVal = locked === true
    sel.value = { ...sel.value, modeOptions: rows, currentMode, modeLocked: lockedVal }
    if (lockedVal) closePopups()
  }
  /**
   * **只更新「当前模式」**：别处（网页端 / 编辑区）切模式时的跟随。
   *
   * 为什么不复用 `setModes`：它开头 `if (!info?.presets) return` —— 投影帧里只有**当前值**（`agentPreset`），
   * 没有选项列表，传进去会被整段跳过（这正是"切模式不跟随"的根因之一）。选项与锁定仍以 `chatInfo`
   * 那份为准，这里只挪当前值。
   *
   * `undefined` = 这一帧没带这个键 → **保持原值**（别误清）；`null` = 服务端明说"没有模式" → 记空串，
   * 由 UI 回退到选项表里的第一个（与 `setModes` 的兜底同口径）。
   */
  function setCurrentMode(id: string | null | undefined): void {
    if (id === undefined) return
    const value = id ?? ''
    if (sel.value.currentMode === value) return
    sel.value = { ...sel.value, currentMode: value }
  }
  function selectMode(id: string): void {
    sel.value = { ...sel.value, currentMode: id }
    host.post({ type: 'chatSelectMode', agentPreset: id })
    closePopups()
  }
  /**
   * 查看某个模式的子插件组合（F9「查看配置」）。
   *
   * 纯只读：只把 id 交给宿主去拉 `agentPresets/read` 并打开一份 YAML，**不动当前模式、不产生对话行**
   *（与 `selectMode` 的区别就在这里：这是查看，不是切换）。
   */
  function openModeConfig(agentPreset: string): void {
    closePopups()
    host.post({ type: 'chatModeConfig', agentPreset })
  }

  /** 新会话清空：只清弹窗，不动 sel 与 permNameOf（权限名回退表跨会话仍有效）。 */
  function reset(): void {
    openPopup.value = null
  }

  return {
    store: { sel, permNameOf, openPopup, togglePopup, openModelSearch, closePopups, selectPerm, selectModel, selectMode, openModeConfig },
    setPermOptions,
    setModels,
    setModes,
    setCurrentMode,
    reset,
  }
}
