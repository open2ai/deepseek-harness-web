// 语音输入切片（实验版）：宿主侧录音的状态机与结果落点。
//
// 页面**不录音**（VS Code webview 拿不到麦克风）：这里只维护
// 「待命 / 准备模型 / 录音中 / 转写中」四态，并把宿主回来的文字**插到输入框光标处**
// （可撤销、不自动发送，与上游 `InputActions.insertText` 同口径）。
//
// 反馈面：
//   · **识别为空 = 什么都不显示** —— 用户没说话时不该在会话区冒一行「没有听清」；
//   · 失败（设备占用/模型没就绪等）也**不进会话区**，只在输入区下方给一行行内提示；
//   · 会话区只承载真正的对话内容，语音的中间态一律留在输入区。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { ChatStore } from './types'

/** 语音输入的四个状态（与宿主 `voiceState` 帧同字面量）：待命 / 准备模型 / 录音中 / 转写中。 */
export type VoiceState = 'idle' | 'preparing' | 'recording' | 'transcribing'

export interface VoiceSlice {
  store: Pick<
    ChatStore,
    'voiceAvailable' | 'voiceState' | 'voiceMaxDurationMs' | 'voiceHint' | 'startVoice' | 'stopVoice' | 'cancelVoice' | 'dismissVoiceHint'
  >
  /**
   * 宿主 `voiceAvailability` 帧：dsh 实例有没有挂载语音插件（`voice-input-bundle`）。
   *
   * false = **不渲染麦克风入口**（插件关着时点它只会报 typert 错误）。默认 false，
   * 等宿主探测到再显示 —— 宁可晚半拍出现，也不要出现一个点了必报错的按钮。
   */
  applyAvailability(available: boolean): void
  /** 宿主 `voiceState` 帧：状态迁移 + 录音上限（上限以服务端 `speech/catalog` 为准）。 */
  applyState(state: VoiceState, maxDurationMs?: number): void
  /** 宿主 `voiceResult` 帧：把识别文字插到输入框光标处；空文本**什么都不做**（静默）。 */
  applyResult(text: string): void
  /** 宿主 `voiceError` 帧：只在输入区下方给一行行内提示（不落会话行、不动输入框内容）。 */
  applyError(message: string): void
  reset(): void
}

/**
 * @param host - 宿主通道
 * @param insert - 把文字插到输入框光标处（装配层注入 composer 的 `insertText`）
 */
export function createVoice(host: ChatHost, insert: (text: string) => void): VoiceSlice {
  /** 语音插件是否可用（默认 false：探测到才显示入口）。 */
  const voiceAvailable = signal(false)
  const voiceState = signal<VoiceState>('idle')
  const voiceMaxDurationMs = signal(0)
  /** 语音失败的行内提示（输入区下方；空串/undefined = 不显示）。 */
  const voiceHint = signal<string | undefined>(undefined)
  /** 行内提示的自动消失定时器（新提示覆盖旧定时器；清空时一并取消）。 */
  let hintTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 设置/清空行内提示。**提示是瞬时的**：默认 6 秒后自动消失。
   *
   * 为什么必须自动消失（真机）：语音插件关着时点一下话筒，会先出
   * 「语音插件未启用，已隐藏语音入口」——若一直挂着，输入区下方永远有一条红字，
   * 而话筒已经被隐藏、用户再也没有操作能把它清掉。
   *
   * @param message - 新提示；`undefined` = 立即清空。
   */
  function showHint(message: string | undefined): void {
    if (hintTimer !== undefined) {
      clearTimeout(hintTimer)
      hintTimer = undefined
    }
    voiceHint.value = message
    if (message !== undefined) {
      hintTimer = setTimeout(() => {
        hintTimer = undefined
        voiceHint.value = undefined
      }, 6_000)
    }
  }

  function startVoice(): void {
    if (!voiceAvailable.value || voiceState.value !== 'idle') {
      return
    }
    showHint(undefined)
    host.post({ type: 'voiceStart' })
  }

  function stopVoice(): void {
    if (voiceState.value !== 'recording') {
      return
    }
    host.post({ type: 'voiceStop' })
  }

  function cancelVoice(): void {
    if (voiceState.value === 'idle') {
      return
    }
    showHint(undefined)
    host.post({ type: 'voiceCancel' })
  }

  /** 手动关掉行内提示（提示条右侧那个 ✕）。 */
  function dismissVoiceHint(): void {
    showHint(undefined)
  }

  function applyAvailability(available: boolean): void {
    voiceAvailable.value = available
    if (!available) {
      // 插件被关掉：入口隐藏，任何进行中的状态/提示一起收掉
      voiceState.value = 'idle'
      voiceMaxDurationMs.value = 0
      showHint(undefined)
    } else {
      // 插件又启用了：旧的"未启用"提示立刻作废（不用等 6 秒）
      showHint(undefined)
    }
  }

  function applyState(state: VoiceState, maxDurationMs?: number): void {
    voiceState.value = state
    if (maxDurationMs !== undefined) {
      voiceMaxDurationMs.value = maxDurationMs
    }
  }

  function applyResult(text: string): void {
    voiceState.value = 'idle'
    const trimmed = text.trim()
    // 没听清 → 静默（不插文字、不提示：用户自己知道刚才没说话）
    if (trimmed === '') {
      return
    }
    showHint(undefined)
    insert(trimmed)
  }

  function applyError(message: string): void {
    voiceState.value = 'idle'
    // 失败只在输入区下方给一行行内提示（6 秒后自动消失），**不进会话区**
    showHint(message)
  }

  function reset(): void {
    voiceState.value = 'idle'
    voiceMaxDurationMs.value = 0
    showHint(undefined)
  }

  return {
    store: {
      voiceAvailable,
      voiceState,
      voiceMaxDurationMs,
      voiceHint,
      startVoice,
      stopVoice,
      cancelVoice,
      dismissVoiceHint,
    },
    applyAvailability,
    applyState,
    applyResult,
    applyError,
    reset,
  }
}
