// 全局偏好切片：上游「设置 → 通用设置」四项（工作步骤展示 / 性能与用量 / 代码工作工具 / 繁忙时的发送行为）。
// 与 status 的区别：这里的量**跨会话有效**，所以不参与 chat.ts 的 reset 串联——
// 换会话不该把偏好重置回默认，那是全局设置而不是会话状态。
//
// 取值归一化（四档 → 两档等）在**宿主**，纯函数有守卫）；这里只存生效值。
import { signal } from '@preact/signals'
import type { ChatStore } from './types'

/** 宿主 `chatPrefs` 帧里本切片关心的字段；**缺失 = 不改**（宿主读不到设置时一个字段都不推）。 */
export interface ChatPrefsPatch {
  transcriptView?: 'normal' | 'compact'
  performanceUsage?: 'compact' | 'detailed'
  developerTools?: boolean
  busyEnter?: 'queue' | 'steer'
  /** 上游四档策略门：已定稿思考行是否预览首行 */
  settledReasoningPreview?: boolean
  /** 上游四档策略门：进行中是否显示过程细节 */
  liveProcessDetail?: boolean
  /** 上游四档策略门：过程分组头的覆盖范围（`collapsed`/`history`/`none`） */
  stepGrouping?: 'collapsed' | 'history' | 'none'
  /** 收起时机（上游 0.2.1 新增的 `collapseTiming` 偏好）：`next-input` = 最新交互段定稿后先不收 */
  collapseTiming?: 'completion' | 'next-input'
}

export interface PrefsSlice {
  store: Pick<
    ChatStore,
    | 'transcriptView'
    | 'performanceUsage'
    | 'developerTools'
    | 'busyEnter'
    | 'settledReasoningPreview'
    | 'liveProcessDetail'
    | 'stepGrouping'
    | 'collapseTiming'
  >
  /**
   * 应用宿主推来的偏好（逐字段覆盖，未给的字段保持原值）。
   * @param prefs - 偏好字段，均可缺
   */
  apply(prefs: ChatPrefsPatch): void
}

export function createPrefs(): PrefsSlice {
  // 默认值 = **上游默认**（不是插件自有偏好）：桌面端的「工作步骤展示」默认档 = `standard`
  // → `foldCompletedTurns` 真、`stepGrouping` = `collapsed`（进行中的回合也有可展开的分组头）。
  // ⚠️ **这一份必须与宿主下发的那一份逐字一致**（`src/dsh/chat-prefs.ts` 的 `DEFAULT_CHAT_PREFS`）：
  // 两处不同（这里曾写 `history`）时，宿主偏好帧到达**之前**渲染出的那几帧会少掉分组头 ——
  // 按 `history` 判"回合关闭了没"要与同一帧里的其他列配套，两处不一致就是自相矛盾的中间态。
  const transcriptView = signal<'normal' | 'compact'>('compact')
  const performanceUsage = signal<'compact' | 'detailed'>('detailed')
  const developerTools = signal(true)
  const busyEnter = signal<'queue' | 'steer'>('queue')
  const settledReasoningPreview = signal(true)
  const liveProcessDetail = signal(true)
  const stepGrouping = signal<'collapsed' | 'history' | 'none'>('collapsed')
  // 默认 = 上游默认「完成时收起」：偏好帧到达前的那几帧按定稿即收渲染，与接入前一致。
  const collapseTiming = signal<'completion' | 'next-input'>('completion')

  function apply(prefs: ChatPrefsPatch): void {
    if (prefs.transcriptView !== undefined) transcriptView.value = prefs.transcriptView
    if (prefs.performanceUsage !== undefined) performanceUsage.value = prefs.performanceUsage
    if (prefs.developerTools !== undefined) developerTools.value = prefs.developerTools
    if (prefs.busyEnter !== undefined) busyEnter.value = prefs.busyEnter
    if (prefs.settledReasoningPreview !== undefined) settledReasoningPreview.value = prefs.settledReasoningPreview
    if (prefs.liveProcessDetail !== undefined) liveProcessDetail.value = prefs.liveProcessDetail
    if (prefs.stepGrouping !== undefined) stepGrouping.value = prefs.stepGrouping
    if (prefs.collapseTiming !== undefined) collapseTiming.value = prefs.collapseTiming
  }

  return {
    store: {
      transcriptView,
      performanceUsage,
      developerTools,
      busyEnter,
      settledReasoningPreview,
      liveProcessDetail,
      stepGrouping,
      collapseTiming,
    },
    apply,
  }
}
