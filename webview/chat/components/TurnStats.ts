// 用量 / 用时 弹窗组件：喂入 chatDone.stats 原始值(usageRaw)，有值才显示（适配上游 0.1.7-rc.2）。
// 独立成组件，后续要改字段文案/布局/触发方式只动这里。
import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { compactTokens, cacheHitPercent } from '../core/format'

// 全局单实例弹窗：任意一行打开用量/用时弹窗时，关闭其它行已打开的弹窗（最新点击胜出）
const closeOthers = new Set<() => void>()

export function TurnStats({ usage }: { usage: Record<string, unknown> }) {
  const [open, setOpen] = useState<'u' | 't' | null>(null)
  // 弹窗默认向上展开；顶部空间不足（如列表最上方消息，无法再往上滚）时翻到下方，避免被顶/标题栏截断
  const [below, setBelow] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // close 用 ref 固定身份：注册表/关闭其它时按稳定函数身份排除自身
  const closeRef = useRef<() => void>(() => {})
  closeRef.current = () => setOpen(null)
  const selfClose = useRef<() => void>(() => {})
  // 弹窗打开时让所在 .msg 的悬停动作区(m.msg-meta)常显，移出消息不闪烁/不消失；
  // 打开本行弹窗时先关掉其它行已打开的（含 meta-open 清理）
  useEffect(() => {
    const msg = wrapRef.current?.closest('.msg')
    if (open) {
      msg?.classList.add('meta-open')
      for (const fn of [...closeOthers]) {
        if (fn !== selfClose.current) fn()
      }
    } else {
      msg?.classList.remove('meta-open')
    }
  }, [open])
  useEffect(() => {
    const fn = () => closeRef.current()
    selfClose.current = fn
    closeOthers.add(fn)
    return () => {
      closeOthers.delete(fn)
    }
  }, [])
  // 弹窗打开后量一下所在消息与其滚动容器(#messages)的间距：上方放不下就翻到下方。
  // 上方空间以消息相对滚动视口顶部的距离衡量（滚动到顶=0，无法继续向上）。
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !open) {
      setBelow(false)
      return
    }
    const pop = wrap.querySelector<HTMLElement>('.tt-pop')
    const scrollHost = wrap.closest('#messages')
    if (!pop || !scrollHost) {
      setBelow(false)
      return
    }
    const a = wrap.getBoundingClientRect()
    const s = scrollHost.getBoundingClientRect()
    const needAbove = pop.offsetHeight + 8
    const roomAbove = a.top - s.top
    const roomBelow = s.bottom - a.bottom
    setBelow(roomAbove < needAbove && roomBelow >= 8)
  }, [open])
  const num = (k: string): number | undefined => {
    const v = usage[k]
    return typeof v === 'number' ? (v as number) : undefined
  }
  const inp = num('inputTokens')
  const out = num('outputTokens')
  const cache = num('cacheReadTokens')
  const reason = num('reasoningTokens')
  const cacheWrite = num('cacheWriteTokens')
  const provider = usage['provider']
  const model = usage['model']
  // 缓存命中率：1 位小数，分母 = uncached + cacheRead + cacheWrite
  const hit =
    typeof cache === 'number' ? cacheHitPercent(cache, (inp ?? 0) + cache + (cacheWrite ?? 0)) : undefined
  const total = (inp && inp > 0 ? inp : 0) + (cache && cache > 0 ? cache : 0) + (out && out > 0 ? out : 0)
  const wall = num('wallSec')
  const tps = num('tps')
  const ttft = num('ttftSec')
  const fmt = (v: number | undefined): string => (typeof v === 'number' ? v.toLocaleString('en-US') : '—')
  const row = (k: string, v: string): unknown => html`<div class="tt-row"><span class="tt-k">${k}</span><span class="tt-v">${v}</span></div>`
  // 只在实际有数值时显示对应图标（停止/无数据的回答不显示，避免空图标/全是 —）
  const hasUsage = total > 0
  const hasTime = wall !== undefined || tps !== undefined || ttft !== undefined
  if (!hasUsage && !hasTime) return null
  // 图标旁常显数值：用量=本轮总量(compact)，用时=本轮总用时(秒)
  const usageBadge = compactTokens(total)
  // 时长按上游整秒向下取整：sub-second 显示 0秒；>=1 分钟显示 X分Y秒
  const wallText = (() => {
    if (wall === undefined) return ''
    const total = Math.floor(wall)
    if (total < 60) return String(total) + '秒'
    return Math.floor(total / 60) + '分' + (total % 60) + '秒'
  })()
  // 弹窗行：有值才显示（缺失行不出现，不显示 “—”）
  const usageRows: unknown[] = []
  if (total > 0) usageRows.push(row('本轮用量', fmt(total) + ' tok'))
  if (provider || model) usageRows.push(row('提供方 / 模型', [provider, model].filter(Boolean).join('/')))
  if (hit !== undefined) usageRows.push(row('缓存命中', hit + '%'))
  if (inp !== undefined) usageRows.push(row('未缓存输入', fmt(inp) + ' tok'))
  if (cache !== undefined) usageRows.push(row('缓存读取', fmt(cache) + ' tok'))
  if (out !== undefined)
    usageRows.push(row('输出', fmt(out) + ' tok' + (reason && reason > 0 ? `（其中推理 ${fmt(reason)} tok）` : '')))
  const timeRows: unknown[] = []
  if (wall !== undefined) timeRows.push(row('本轮总用时', wallText))
  if (tps !== undefined) timeRows.push(row('输出速度（TPS）', tps + ' tok/s'))
  if (ttft !== undefined) timeRows.push(row('首 token 用时（TTFT）', ttft + '秒'))
  return html`<div class="turn-meta" ref=${wrapRef}>
    ${hasUsage
      ? html`<button class=${'tm-btn' + (open === 'u' ? ' active' : '')} title="本轮用量"
          onClick=${() => setOpen(open === 'u' ? null : 'u')}><span class="codicon codicon-graph-line"></span>${usageBadge ? html`<span class="tm-txt">${usageBadge}</span>` : null}</button>`
      : null}
    ${hasTime
      ? html`<button class=${'tm-btn' + (open === 't' ? ' active' : '')} title="本轮用时与速度"
          onClick=${() => setOpen(open === 't' ? null : 't')}><span class="codicon codicon-clock"></span>${wallText ? html`<span class="tm-txt">${wallText}</span>` : null}</button>`
      : null}
    ${open === 'u' && usageRows.length > 0 ? html`<div class=${'tt-pop' + (below ? ' tt-below' : '')}>${usageRows}</div>` : null}
    ${open === 't' && timeRows.length > 0 ? html`<div class=${'tt-pop' + (below ? ' tt-below' : '')}>${timeRows}</div>` : null}
  </div>`
}
