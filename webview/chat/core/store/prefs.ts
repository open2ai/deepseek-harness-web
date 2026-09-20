// 全局偏好切片：显示形态（过程折叠）。
// 与 status 的区别：这里的量**跨会话有效**，所以不参与 chat.ts 的 reset 串联——
// 换会话不该把偏好重置回默认，那是全局设置而不是会话状态。
//
// 输入框键位**不在**这里：固定与宿主页面同口径（Enter 发送 / Shift+Enter 换行 /
// Ctrl/Cmd+Enter 加速），没有可配项。
import { signal } from '@preact/signals'
import type { ChatStore } from './types'

export interface PrefsSlice {
  store: Pick<ChatStore, 'transcriptView'>
  /**
   * 宿主推来的取值；`undefined` = 不改（宿主读不到时不下发该字段）。
   * @param transcriptView - 过程折叠形态（上游「设置 → 对话显示」）
   */
  apply(transcriptView: 'normal' | 'compact' | undefined): void
}

export function createPrefs(): PrefsSlice {
  // 默认 compact：既是上游默认，也是接入前插件固有的形态——读不到设置时维持原样最不意外
  const transcriptView = signal<'normal' | 'compact'>('compact')

  function apply(nextTranscriptView: 'normal' | 'compact' | undefined): void {
    if (nextTranscriptView !== undefined) transcriptView.value = nextTranscriptView
  }

  return { store: { transcriptView }, apply }
}
