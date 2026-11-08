// 公共输入区组件：**特性插件模型**。
//
// 目标：引用、@ 提及、斜杠命令、附件、语音、快捷键这些能力都是插件，
// 宿主按需装；组件核心（草稿/编辑器/控制器）不知道它们的存在。
import type { ComposerHost } from './host'
import type { ComposerController, ComposerDraft } from './types'

/** 组件选项（宿主创建组件时传入）。 */
export interface ComposerOptions {
  /** 占位文案（已本地化）；缺省用宿主 `t` 取。 */
  placeholder?: string
  /** Enter 发送 / Shift+Enter 换行；缺省 true。 */
  submitOnEnter?: boolean
  /** 是否禁用（忙碌/父离线等）；缺省 false。 */
  disabled?: boolean
  /** 内容高度上限（px）。 */
  maxHeight?: number
  /** 主题；`auto` 跟随宿主（CSS 变量由宿主映射）。 */
  theme?: 'auto' | 'light' | 'dark'
  /** 启用的特性插件 id；缺省由接入方显式装配。 */
  features?: readonly string[]
}

/** 组件对外事件。 */
export interface ComposerEventMap {
  submit: { draft: ComposerDraft }
  draftChange: { draft: ComposerDraft }
  focus: Record<string, never>
  blur: Record<string, never>
  error: { error: unknown }
}

export type ComposerEventName = keyof ComposerEventMap

/** 槽位名（组件/特性可以往里挂 UI，例如工具条左侧、发送键左侧）。 */
export type ComposerSlotName = 'toolbar.start' | 'toolbar.end' | 'send.before' | 'above.editor'

/**
 * 特性插件拿到的上下文：只通过控制器与宿主交互，不直接操作编辑器 DOM。
 */
export interface ComposerPluginContext {
  readonly host: ComposerHost
  readonly controller: ComposerController
  readonly options: ComposerOptions
  /** 往组件槽位挂渲染函数；返回移除函数。 */
  registerSlot(name: ComposerSlotName, render: () => unknown): () => void
  /** 订阅组件事件；返回取消订阅函数。 */
  on<K extends ComposerEventName>(name: K, fn: (payload: ComposerEventMap[K]) => void): () => void
  /** 广播事件（插件之间解耦通信）。 */
  emit<K extends ComposerEventName>(name: K, payload: ComposerEventMap[K]): void
}

/** 一个输入区特性插件。 */
export interface ComposerPlugin {
  id: string
  /** 安装：返回的函数在卸载时调用。 */
  install(context: ComposerPluginContext): void | (() => void)
}
