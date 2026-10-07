// 上下文占用环（**输入框下面**那一格，上游叫 composer dock）：一个环 + 百分比 + 点开自己的明细弹窗。
//
// 数据两条投影：`contextPressure`（最近一次请求的 prompt 大小 + 上下文窗口）与 `contextBreakdown`
// （下一次请求的启发式构成：系统提示词 / 工具 / 其余对话）。
//
// **位置与两条显示规则都照上游**（出处与行号见 `details/upgrade/10` §8）：
//   · **什么时候显示**：分子（已用 token）与容量（上下文窗口）**都拿到**才渲染 —— 上游的占用率函数
//     两者缺一即返回 null、组件直接不渲染（它的文件头也写着"两个数都拿到之前什么都不画"）。
//     取 `projectedTokens ?? pressureTokens`（前者会跟着本轮增删与压缩实时变，后者只反映最近一次请求）。
//     上游另有一道门：**某个活动控件展开时让位**（语音输入那个插件注入的输入区活动位）——
//     插件没有这个控件，故不搬。
//   · **显示什么**：环 **+ 百分比文字**（上游触发器里就是环与读数并排）；点开是明细：
//     `上下文已用 45%` + `~已用 / 窗口` + 三段占用条 + 三行构成。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ChatStore } from '../core/store/chat'
import type { ContextBreakdown, ContextPressure } from '../core/protocol'
import { formatCompactTokens } from '../core/format'

/** 环的几何（14px 视框、2px 描边）：改半径要连着弧长公式一起改。 */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** 弹窗里的三行（与分段一一对应）。 */
const ROWS: Array<{ key: keyof ContextBreakdown; kind: 'system' | 'tools' | 'messages'; label: string }> = [
  { key: 'systemTokens', kind: 'system', label: '系统提示词' },
  { key: 'toolsTokens', kind: 'tools', label: '工具' },
  { key: 'messageTokens', kind: 'messages', label: '对话' },
]

interface Occupancy {
  /** 占用率（上游同式：`Math.min(100, Math.round(已用 / 窗口 * 100))`） */
  percent: number
  used: number
  contextWindow: number
}

/**
 * 占用率（上游那个占用率函数的同口径）。
 *
 * **两个数都要有**：已用（`projectedTokens ?? pressureTokens`）与上下文窗口，缺一返回 null —— 组件据此
 * 整个不渲染（上游如此；插件此前"窗口未知也画环、写『窗口未知』"，2026-10-06 按用户要求对齐上游）。
 * 唯一的加固是 `contextWindow > 0`：0 会让上游算出 `Infinity → 100%`（真机不会出现这种投影，
 * 但不值得把一个假读数画出来）。
 */
function occupancyOf(pressure: ContextPressure | undefined): Occupancy | null {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextWindow = pressure?.contextWindow
  if (typeof used !== 'number' || typeof contextWindow !== 'number' || contextWindow <= 0) {
    return null
  }
  return { percent: Math.min(100, Math.round((used / contextWindow) * 100)), used, contextWindow }
}

/** 分段：有构成就按占比切三段，没有就整条一色；宽度之和 = 占用率。 */
function segmentsOf(
  percent: number,
  breakdown: ContextBreakdown | undefined
): Array<{ key: string; kind: 'system' | 'tools' | 'messages' | 'total'; width: number }> {
  const total =
    breakdown === undefined ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  if (breakdown === undefined || total <= 0) {
    return percent > 0 ? [{ key: 'total', kind: 'total', width: percent }] : []
  }
  return [
    { key: 'system', kind: 'system' as const, width: (percent * breakdown.systemTokens) / total },
    { key: 'tools', kind: 'tools' as const, width: (percent * breakdown.toolsTokens) / total },
    { key: 'messages', kind: 'messages' as const, width: (percent * breakdown.messageTokens) / total },
  ].filter((s) => s.width > 0)
}

export function ContextMeter({ store }: { store: ChatStore }) {
  const facts = store.contextFacts.value
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const context = occupancyOf(facts?.pressure)
  const available = context !== null

  // 能力消失（切到没有该投影的会话/服务）→ 收起弹窗，别留一个空壳
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])
  // 点空白 / Esc 关闭：浮层挂在输入区里，不关会一直盖着
  useEffect(() => {
    if (!open || !available) return
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, available])

  if (context === null) return null
  const percent = context.percent
  const breakdown = facts?.breakdown
  // 弧长：0% 时留一小段**可见标记** —— 否则环只剩一条淡轨道，看起来就像没显示
  const arcPercent = Math.max(percent, 2)
  const label = `上下文已用 ${String(percent)}%`

  return html`<span class="ctx-meter" ref=${rootRef}>
    <button type="button" class="ctx-trigger" title=${label} aria-label=${label} aria-haspopup="dialog" aria-expanded=${open}
      onClick=${() => setOpen((v) => !v)}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <circle class="ctx-track" cx="7" cy="7" r=${RADIUS}></circle>
        <circle class="ctx-fill" cx="7" cy="7" r=${RADIUS}
          stroke-dasharray=${`${String((CIRCUMFERENCE * arcPercent) / 100)} ${String(CIRCUMFERENCE)}`}
          transform="rotate(-90 7 7)"></circle>
      </svg>
      <span class="ctx-reading">${`${String(percent)}%`}</span>
    </button>
    ${open
      ? html`<div class="ctx-pop" role="dialog" aria-label="上下文已用">
          <div class="ctx-pop-head">
            <span class="ctx-headline">上下文已用</span>
            <span class="ctx-percent">${`${String(percent)}%`}</span>
            <span class="ctx-figures">${`~${formatCompactTokens(context.used)} / ${formatCompactTokens(context.contextWindow)}`}</span>
          </div>
          <div class="ctx-bar">
            ${segmentsOf(percent, breakdown).map(
              (s) => html`<span class=${'ctx-seg is-' + s.kind} key=${s.key} style=${{ width: `${String(s.width)}%` }}></span>`
            )}
          </div>
          ${breakdown === undefined
            ? null
            : html`<dl class="ctx-rows">
                ${ROWS.map(
                  (r) => html`<div class="ctx-row" key=${r.key}>
                    <dt><span class=${'ctx-swatch is-' + r.kind} aria-hidden="true"></span>${r.label}</dt>
                    <dd>${`~${formatCompactTokens(breakdown[r.key])}`}</dd>
                  </div>`
                )}
              </dl>`}
        </div>`
      : null}
  </span>`
}
