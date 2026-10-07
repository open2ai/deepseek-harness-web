// 会话级信息：**两张互相独立的卡**（会话统计 / Token 用量），渲染在**输入框外面、底部那一行**里
//（与上下文占用环同一行、排在它**前面** —— 宿主页面把统计 pill 挂在这一行的槽位上，占用环由输入条
// 在这一行末尾渲染）。
//
// 为什么不并成一行字：这两组数各看各的维度（回合与耗时 vs token 桶），并排成一句长文本后
// 既读不出重点、窄面板下还会被整体省略号吃掉。上游就是两个图标 pill，各自点开自己的明细卡。
// 数据都是**会话级**（整份日志的累计），与回答行尾部的「本轮用量/用时」不是一回事。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ChatStore, SessionStatsView, TokenUsageView } from '../core/store/chat'
import {
  cacheHitPercent,
  formatCompactTokens,
  formatDurationCompact,
  formatTokensPerSecond,
} from '../core/format'

/** 三个输入侧计费桶之和（上游 `billedInput` 口径）：既是缓存命中率的分母，也是「有没有 token 活动」的一半。 */
function billedInput(u: TokenUsageView): number {
  return (u.uncachedInputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
}

/** Token 总用量 = 三个输入桶 + 输出（四个桶互斥）。 */
function totalTokens(u: TokenUsageView): number {
  return billedInput(u) + (u.outputTokens ?? 0)
}

/** 缓存命中率：分母 = 未缓存输入 + 缓存读 + 缓存写（上游 billedInput 口径）。 */
function cacheHit(u: TokenUsageView): string {
  const billed = billedInput(u)
  return typeof u.cacheReadTokens === 'number' && billed > 0 ? cacheHitPercent(u.cacheReadTokens, billed) : ''
}

/** 输出速度：由解码时长与输出 token 相除得出（投影里没有现成的 tok/s）。 */
function tpsOf(s: SessionStatsView): string {
  const ms = s.decodeMs
  const tokens = s.decodeTokens
  if (typeof ms !== 'number' || typeof tokens !== 'number' || ms <= 0 || tokens <= 0) return ''
  return formatTokensPerSecond(tokens / (ms / 1000))
}

/** 明细卡里的一行（键右对齐数值，数值用等宽数字）。 */
const row = (k: string, v: string): unknown =>
  html`<div class="sp-row"><span class="sp-k">${k}</span><span class="sp-v">${v}</span></div>`

export function StatsCards({ store }: { store: ChatStore }) {
  const stats = store.sessionStats.value
  const usage = store.tokenUsage.value
  // 两个 pill 共用一个互斥的打开槽（上游同款：同一时刻只开一个明细卡）
  const [open, setOpen] = useState<'time' | 'usage' | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 点空白 / Esc 关闭：明细卡是常驻条上的浮层，不关会一直盖着输入框
  useEffect(() => {
    if (open === null) return
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const billed = usage === null ? 0 : billedInput(usage)
  const tokens = usage === null ? 0 : totalTokens(usage)
  const hit = usage === null ? '' : cacheHit(usage)
  const tps = stats === null ? '' : tpsOf(stats)
  const steps = stats?.steps ?? 0
  // 门控照上游两条：① **有 token 活动**（输入侧计费或输出 > 0）才出用量卡 —— 投影在、但四个桶全零
  // （新建会话）时出一张只写着卡名的空卡是错的；② 步数为 0 且没有用量 → 整条不渲染。
  const hasTokens = usage !== null && (billed > 0 || (usage.outputTokens ?? 0) > 0)

  // 【性能与用量 = 简洁】上游不是「什么都不显示」，而是**只留两枚静态药丸**：
  //   ① [仪表图标] `{tps} tok/s`（需要 `decodeMs > 0`）；
  //   ② [数据库图标] `缓存命中 {percent}%`（需要在 token 活动，且 `cacheReadTokens`/计费输入 > 0）。
  // 两项都取不到时**整条不渲染**（上游 `StatsPills` 的 compact 分支同）。
  // 注意这段必须在下面「整条不渲染」的门**之前**：否则简洁档会被 steps/tokens 的门提前吞掉（真机即"输入框下面什么都没有"）。
  if (store.performanceUsage?.value === 'compact') {
    const speed = tps === '' ? null : `${tps} tok/s`
    const hitText = hasTokens && hit !== '' ? `缓存命中 ${hit}%` : null
    if (speed === null && hitText === null) return null
    const pill = (icon: string, text: string): unknown => html`<span class="sp-wrap" key=${icon}>
      <span class="sp-pill is-static">
        <span class=${'codicon sp-ico codicon-' + icon} aria-hidden="true"></span>
        <span class="sp-text">${text}</span>
      </span>
    </span>`
    return html`<div class="stats-cards" data-compact ref=${rootRef}>
      ${speed !== null ? pill('dashboard', speed) : null}
      ${hitText !== null ? pill('database', hitText) : null}
    </div>`
  }

  if (steps === 0 && !hasTokens) return null

  const countsText = stats === null ? '' : `${String(stats.turns ?? 0)} 轮 ${String(stats.steps ?? 0)} 步`
  const timeRows: unknown[] = []
  if (stats !== null) {
    const llm = formatDurationCompact(stats.llmMs === undefined ? undefined : stats.llmMs / 1000)
    const tool = formatDurationCompact(stats.toolMs === undefined ? undefined : stats.toolMs / 1000)
    const ttft =
      typeof stats.ttftMs === 'number' && typeof stats.ttftSteps === 'number' && stats.ttftSteps > 0
        ? formatDurationCompact(stats.ttftMs / stats.ttftSteps / 1000)
        : ''
    if (llm !== '') timeRows.push(row('模型用时', llm))
    if (tool !== '') timeRows.push(row('工具调用用时', tool))
    if (ttft !== '') timeRows.push(row('首 token 平均（TTFT）', ttft))
    if (tps !== '') timeRows.push(row('输出速度（TPS）', `${tps} tok/s`))
  }
  const usageRows: unknown[] = []
  if (usage !== null) {
    // 精确计数用千分位（上游同：明细卡给的是可核对的整数，不是缩写）
    const exact = (v: number | undefined): string => (typeof v === 'number' ? v.toLocaleString('en-US') : '')
    // 缓存命中排**首行**（上游同序：命中率 → 输入三桶 → 输出）
    if (hit !== '') usageRows.push(row('缓存命中', `${hit}%`))
    if (typeof usage.uncachedInputTokens === 'number') usageRows.push(row('未缓存输入', `${exact(usage.uncachedInputTokens)} tok`))
    if (typeof usage.cacheReadTokens === 'number') usageRows.push(row('缓存读取', `${exact(usage.cacheReadTokens)} tok`))
    // 缓存写入整场为 0 时不出这一行（上游同：那一行只在非零时出现）
    if (typeof usage.cacheWriteTokens === 'number' && usage.cacheWriteTokens !== 0) usageRows.push(row('缓存写入', `${exact(usage.cacheWriteTokens)} tok`))
    if (typeof usage.outputTokens === 'number') usageRows.push(row('输出', `${exact(usage.outputTokens)} tok`))
  }
  const timeTitle = countsText !== '' ? countsText : '会话统计'
  // 门控已保证 hasTokens，故主读数一定是数字（不再回落到卡名那种"有卡没值"的形态）
  const usageTitle = `${formatCompactTokens(tokens)} tok`

  /** 一张卡：pill（图标 + 主读数 + 次读数）+ 点开后向上展开的明细。浮层挂在**自己这一格**里，左对齐自己的 pill。
   *  `popValue` 是明细卡标题右侧的精确读数（上游用量明细卡就在标题旁给可核对的整数）。 */
  const card = (
    kind: 'time' | 'usage',
    icon: string,
    title: string,
    headline: string,
    secondary: string,
    rows: unknown[],
    popValue = ''
  ): unknown => html`<span class="sp-wrap" key=${kind}>
    <button type="button" class="sp-pill" title=${title} aria-haspopup="dialog" aria-expanded=${open === kind}
      aria-label=${secondary !== '' ? `${headline} · ${secondary}` : headline}
      onClick=${() => setOpen(open === kind ? null : kind)}>
      <span class=${'codicon sp-ico codicon-' + icon} aria-hidden="true"></span>
      <span class="sp-text">${headline}</span>
      ${secondary !== ''
        ? html`<span class="sp-sep" aria-hidden="true">·</span><span class="sp-text">${secondary}</span>`
        : null}
    </button>
    ${open === kind
      ? html`<div class="sp-pop" role="dialog" aria-label=${title}>
          <div class="sp-pop-title">${title}${popValue !== ''
            ? html`<span class="sp-pop-value">${popValue}</span>`
            : null}</div>
          ${rows}
        </div>`
      : null}
  </span>`

  return html`<div class="stats-cards" ref=${rootRef}>
    ${steps > 0
      ? card('time', 'dashboard', '会话统计', timeTitle, tps !== '' ? `${tps} tok/s` : '', timeRows)
      : null}
    ${hasTokens
      ? card('usage', 'database', 'Token 用量', usageTitle, hit !== '' ? `缓存命中 ${hit}%` : '', usageRows,
          `${tokens.toLocaleString('en-US')} tok`)
      : null}
  </div>`
}
