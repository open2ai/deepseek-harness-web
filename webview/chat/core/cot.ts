// 思考过程机器翻译（上游实验插件 `client-ui-cot-translation` 的插件内等价实现）。
//
// 只有**展开的思考块**会被翻译（与上游一致）：正文按空行切段，完整段翻译后缓存、逐段替换；
// 流式时尾段未完成不翻译，避免把半句话送出去。请求经宿主 `cotTranslation/translate` remote；
// 宿主翻译插件没启用（`limits` 不可用）时整个入口不出现，思考块保持原文。
//
// 纯逻辑（分段/缓存/并发/失败/重试）放在这里，组件只做渲染与开关 —— 这样守卫可以在
// 不依赖 DOM 的情况下把上游那套边界逐条钉住（见 `tmp/_cot.translation.test.mjs`）。
import type { ChatHost } from './host'

/** `cotTranslation/limits` 的返回（宿主 translator 服务的接收偏好与单请求上限）。 */
export interface CotLimits {
  maxTextChars: number
  preferences: { provider: string; targetLanguage: string }
  availableProviders: string[]
}

/** 翻译一个片段；`undefined` = 请求失败（组件显示原文 + 重试）。 */
export type CotTranslate = (request: { text: string; targetLanguage: string; provider?: string }) => Promise<string | undefined>

/** 宿主侧请求-应答的客户端（页面唯一通道仍是 ChatHost；这里只做 pending 配对）。 */
export interface CotClient {
  limits(): Promise<CotLimits | undefined>
  translate(request: { text: string; targetLanguage: string; provider?: string }): Promise<string | undefined>
}

interface ReplyFrame {
  type?: unknown
  requestId?: unknown
  ok?: unknown
  limits?: unknown
  text?: unknown
}

const COT_PROVIDERS = ['google', 'bing', 'deepseek-account', 'deepseek-official'] as const
function isCotProvider(value: unknown): value is string {
  return typeof value === 'string' && (COT_PROVIDERS as readonly string[]).includes(value)
}

export function cotLimitsOf(raw: unknown): CotLimits | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as { maxTextChars?: unknown; preferences?: unknown; availableProviders?: unknown }
  if (typeof value.maxTextChars !== 'number' || !Number.isFinite(value.maxTextChars) || value.maxTextChars <= 0) return undefined
  const prefs = value.preferences as { provider?: unknown; targetLanguage?: unknown } | null | undefined
  if (prefs === null || typeof prefs !== 'object') return undefined
  const provider = prefs.provider
  const targetLanguage = prefs.targetLanguage
  if (!isCotProvider(provider)) return undefined
  if (typeof targetLanguage !== 'string') return undefined
  if (!Array.isArray(value.availableProviders) || !value.availableProviders.every(isCotProvider)) return undefined
  const availableProviders = [...value.availableProviders]
  return { maxTextChars: value.maxTextChars, preferences: { provider, targetLanguage }, availableProviders }
}

/** 创建页面侧客户端：`limits()` / `translate()` 各配一个 requestId，超时按失败返回。 */
export function createCotClient(host: ChatHost): CotClient {
  let seq = 0
  let wired = false
  const pendingLimits = new Map<number, (value: CotLimits | undefined) => void>()
  const pendingText = new Map<number, (value: string | undefined) => void>()
  /** 第一次真正发请求才挂 onMessage：无 DOM 的纯 store 测试创建 store 时不应触碰 window。 */
  const wire = (): void => {
    if (wired) return
    wired = true
    host.onMessage((msg) => {
    if (msg === null || typeof msg !== 'object') return
    const frame = msg as ReplyFrame
    if (frame.type !== 'cotTranslationLimitsRep' && frame.type !== 'cotTranslationTranslateRep') return
    if (typeof frame.requestId !== 'number') return
    if (frame.type === 'cotTranslationLimitsRep') {
      const settle = pendingLimits.get(frame.requestId)
      if (settle === undefined) return
      pendingLimits.delete(frame.requestId)
      settle(frame.ok === true ? cotLimitsOf(frame.limits) : undefined)
      return
    }
    const settle = pendingText.get(frame.requestId)
    if (settle === undefined) return
    pendingText.delete(frame.requestId)
      settle(frame.ok === true && typeof frame.text === 'string' ? frame.text : undefined)
    })
  }
  const requestLimits = (): Promise<CotLimits | undefined> => new Promise((resolve) => {
    wire()
    seq += 1
    const requestId = seq
    const timer = setTimeout(() => {
      if (pendingLimits.delete(requestId)) resolve(undefined)
    }, 10_000)
    pendingLimits.set(requestId, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    host.post({ type: 'cotTranslationLimitsReq', requestId })
  })
  const requestTranslate = (request: { text: string; targetLanguage: string; provider?: string }): Promise<string | undefined> => new Promise((resolve) => {
    wire()
    seq += 1
    const requestId = seq
    const timer = setTimeout(() => {
      if (pendingText.delete(requestId)) resolve(undefined)
    }, 60_000)
    pendingText.set(requestId, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    host.post({ type: 'cotTranslationTranslateReq', requestId, ...request })
  })
  return { limits: requestLimits, translate: requestTranslate }
}

/** 一个可翻译片段：`complete=false` = 流式尾段还没写完，不发翻译。 */
export interface CotFragment {
  text: string
  suffix: string
  complete: boolean
}

/**
 * 把思考正文切成「完整段落 + 请求上限内的分片」（逐行移植上游 `reasoningFragments`）。
 * 保留原空白（suffix 归前一片）：拼回去必须与原文字节一致。
 */
export function reasoningFragments(text: string, running: boolean, maxTextChars: number): CotFragment[] {
  const result: CotFragment[] = []
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  let start = 0
  for (;;) {
    const match = separator.exec(text)
    let remaining = text.slice(start, match?.index ?? text.length)
    while (remaining.length > maxTextChars) {
      let cut = maxTextChars
      // 不把代理对切成两半（emoji / 生僻字）
      if (/[\uD800-\uDBFF]/.test(remaining.charAt(cut - 1))) cut -= 1
      const whitespace = remaining.slice(0, cut).search(/\s+\S*$/)
      if (whitespace > 0) cut = whitespace
      const source = remaining.slice(0, cut)
      remaining = remaining.slice(cut)
      const suffix = remaining.match(/^\s+/)?.[0] ?? ''
      remaining = remaining.slice(suffix.length)
      result.push({ text: source, suffix, complete: true })
    }
    result.push({ text: remaining, suffix: match?.[0] ?? '', complete: match !== null || !running })
    if (match === null) return result
    start = match.index + match[0].length
  }
}

/** 组件要渲染的翻译态（原文本片段 + 已译片段；失败时显示原文）。 */
export interface CotViewState {
  text: string
  pending: boolean
  failed: boolean
}

interface TranslationSelection {
  provider: string
  targetLanguage: string
}

/**
 * 一次展开的翻译生命周期：取消、请求顺序、过期结果排除、失败/重试（对应上游 `ReasoningTranslation`）。
 * 组件卸载或收起时 `dispose()`，之后的响应一律丢弃。
 */
export class ReasoningTranslation {
  private readonly controller = new AbortController()
  private readonly cache = new Map<string, string>()
  private fragments: CotFragment[] = []
  private pending = false
  private failed = false

  constructor(
    private readonly selection: TranslationSelection,
    private readonly maxTextChars: number,
    private readonly translate: CotTranslate,
    private readonly publish: (state: CotViewState) => void,
  ) {}

  update(text: string, running: boolean): void {
    this.fragments = reasoningFragments(text, running, this.maxTextChars)
    this.emit()
    void this.run()
  }

  retry(): void {
    this.failed = false
    void this.run()
  }

  dispose(): void {
    this.controller.abort()
  }

  private isDisposed(): boolean {
    return this.controller.signal.aborted
  }

  private emit(): void {
    if (this.isDisposed()) return
    const text = this.fragments
      .map((fragment) => (fragment.complete ? this.cache.get(fragment.text) ?? fragment.text : fragment.text) + fragment.suffix)
      .join('')
    this.publish({ text, pending: this.pending, failed: this.failed })
  }

  private async run(): Promise<void> {
    if (this.pending || this.failed || this.isDisposed()) return
    let next = this.fragments.find((fragment) => fragment.complete && fragment.text.trim() !== '' && !this.cache.has(fragment.text))
    if (next === undefined) return
    this.pending = true
    this.emit()
    try {
      while (next !== undefined) {
        const translated = await this.translate({ ...this.selection, text: next.text })
        if (this.isDisposed()) return
        if (translated === undefined) throw new Error('translation failed')
        this.cache.set(next.text, translated)
        this.emit()
        next = this.fragments.find((fragment) => fragment.complete && fragment.text.trim() !== '' && !this.cache.has(fragment.text))
      }
    } catch {
      if (!this.isDisposed()) this.failed = true
    } finally {
      this.pending = false
      this.emit()
    }
  }
}
