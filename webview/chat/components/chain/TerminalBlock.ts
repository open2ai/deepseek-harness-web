// 终端卡 —— 独立组件，与 Web/Ask/Context 各占一个文件，改一种不影响其它。
// 形态是一块面板：命令横幅（状态点 + 命令，固定高度内滚）→ 一条分隔线 → 输出体。
// 输出体**上限 224px + 纵向内滚**；**不折行**（`white-space: pre`，超宽交给输出体横滚）。**不做行折叠**——上游另有 16 行折中段，本插件不跟。
// 收起/展开头由上级 ToolRow 控制。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'
import { terminalLabels, promptLabel, stripAnsi, type TermCard, type TermState } from '../../core/terminal'

/**
 * 状态点：**只看卡内运行态**（= 行状态），不再只看退出码——
 * 调用失败（spawn 失败/中止/沙箱拒绝）没有退出码，只看退出码会给出绿点。
 */
function dotState(state: TermState): 'ongoing' | 'done' | 'error' | 'warning' {
  if (state === 'running') return 'ongoing'
  if (state === 'error') return 'error'
  if (state === 'stopped') return 'warning'
  return 'done'
}

/** 卡内运行态文案（与状态点同源；ok→已完成，error→失败，stopped→已停止）。 */
function runLabel(state: TermState, labels: ReturnType<typeof terminalLabels>): string {
  if (state === 'running') return labels.running
  if (state === 'error') return labels.failed
  if (state === 'stopped') return labels.stopped
  return labels.done
}

/** settled 时的状态 Pill 文案（干净退出无 Pill；signal 优先于 exitCode）。 */
function statusPill(card: TermCard, labels: ReturnType<typeof terminalLabels>): string | null {
  if (card.running) return null
  if (card.signal !== undefined) return labels.signal(card.signal)
  if (card.exitCode !== undefined && card.exitCode !== 0) return labels.exitCode(card.exitCode)
  return null
}

export function TerminalBlock({ card, store }: { card: TermCard; store: ChatStore }) {
  const labels = terminalLabels()
  const pill = statusPill(card, labels)
  const outputLines = (card.output ?? '').split('\n').map((l) => stripAnsi(l))

  const dot = html`<span class="term-dot" data-state=${dotState(card.state)}></span>`
  // 命令行首行前：状态点 done绿/ongoing蓝/error红/stopped琥珀（本插件为「与行状态一致」补 stopped）
  const promptRows = card.command.map((line, i) => html`
    <div class="term-prompt-line" key=${i}>
      ${i === 0 ? dot : null}
      <span class="term-cwd">${i === 0 ? promptLabel(card.cwd) : '$'}</span>
      <span class="term-cmd">${line}</span>
    </div>`)
  // 复制原始脱轨输出文本（剥 marker），非渲染树
  const copyRaw = (text: string | undefined): void => {
    if (text) store.copy(text)
  }

  return html`<div class="term" data-running=${card.running ? '' : undefined}>
    <div class="term-head">
      <div class="term-prompt">
        <span class="term-state">${runLabel(card.state, labels)}</span>
        ${promptRows}
      </div>
      ${pill ? html`<span class="term-status">${pill}</span>` : null}
      ${!card.running && !card.empty
        ? html`<button type="button" class="term-copy" onClick=${() => copyRaw(card.output)}>${labels.copy}</button>`
        : null}
    </div>
    ${card.empty
      ? html`<div class="term-empty">${labels.noOutput}</div>`
      : html`<div class="term-output">
          ${outputLines.map((line, i) => html`<div class="term-line" key=${i}>${line || ' '}</div>`)}
        </div>`}
  </div>`
}
