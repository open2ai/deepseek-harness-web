// 全局偏好切片：上游「设置 → 通用设置」四项（工作步骤展示 / 性能与用量 / 代码工作工具 / 繁忙时的发送行为）。
// 与 status 的区别：这里的量**跨会话有效**，所以不参与 chat.ts 的 reset 串联——
// 换会话不该把偏好重置回默认，那是全局设置而不是会话状态。
//
// 取值归一化（四档 → 两档等）在**宿主**（`src/dsh/chat-prefs.ts`，纯函数有守卫）；这里只存生效值。
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
  >
  /**
   * 应用宿主推来的偏好（逐字段覆盖，未给的字段保持原值）。
   * @param prefs - 偏好字段，均可缺
   */
  apply(prefs: ChatPrefsPatch): void
}

export function createPrefs(): PrefsSlice {
  // 默认值 = **上游默认**（不是插件自有偏好）：
  // 工作步骤展示缺省 → 0.2.0 起按客户端默认 `detailed` 口径（`transcriptView` 仍折、`stepGrouping` = `history`）；
  // 性能与用量 `detailed`；代码工作工具**默认开**；繁忙时 `queue`；三个策略门取 `detailed`/`standard` 共用值。
  // 所以「读不到设置」与「用户没改过」表现相同（也等于接入前插件的形态：进行中无分组头、定稿收起）。
  const transcriptView = signal<'normal' | 'compact'>('compact')
  const performanceUsage = signal<'compact' | 'detailed'>('detailed')
  const developerTools = signal(true)
  const busyEnter = signal<'queue' | 'steer'>('queue')
  const settledReasoningPreview = signal(true)
  const liveProcessDetail = signal(true)
  const stepGrouping = signal<'collapsed' | 'history' | 'none'>('history')

  function apply(prefs: ChatPrefsPatch): void {
    if (prefs.transcriptView !== undefined) transcriptView.value = prefs.transcriptView
    if (prefs.performanceUsage !== undefined) performanceUsage.value = prefs.performanceUsage
    if (prefs.developerTools !== undefined) developerTools.value = prefs.developerTools
    if (prefs.busyEnter !== undefined) busyEnter.value = prefs.busyEnter
    if (prefs.settledReasoningPreview !== undefined) settledReasoningPreview.value = prefs.settledReasoningPreview
    if (prefs.liveProcessDetail !== undefined) liveProcessDetail.value = prefs.liveProcessDetail
    if (prefs.stepGrouping !== undefined) stepGrouping.value = prefs.stepGrouping
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
    },
    apply,
  }
}
