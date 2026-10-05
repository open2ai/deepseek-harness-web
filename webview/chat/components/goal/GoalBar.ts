// 目标条（GoalBar）：停靠在输入框上方的常驻卡片，与网页端同名组件一致（基线 dsh-v0.1.5-rc.2）。
//
// **宽高按插件自己的刻度**，其余行为对齐上游：
//   · 有目标且 `phase !== 'complete'` 才渲染（加载中/无目标/已完成一律不渲染）；
//   · 结构 = 目标字形 + **阶段文字** + 目标原文（超长省略）+ 图标动作；
//   · 动作：暂停（仅 active）、恢复（paused）、**编辑**（行内表单）、清除；
//   · 编辑表单：输入框 + 保存/取消，Enter 保存 / Esc 取消，**空值禁用保存**；
//   · 动作在飞时按钮禁用（防同一个 CAS 提交两次）；失败把 `message (code)` 内联显示。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import type { GoalView } from '../../core/store/types'

/** 阶段 → 条上文字（与上游 locales 同字面量）。complete 不进这张表：它压根不渲染。 */
const PHASE_LABEL: Record<string, string> = {
  active: '进行中的目标',
  paused: '已暂停的目标',
  blocked: '受阻的目标',
}

/** `active` 的**未运行**那一档（上游 `phase.active.disarmed`）—— process-local activation 说了算。 */
const ACTIVE_DISARMED_LABEL = '未运行的目标'

export function GoalBar({ store }: { store: ChatStore }) {
  const goal: GoalView | null = store.goalState.value
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 已清除的目标 id：等到投影跟上再卸载（上游 `clearedGoalId`，避免点了 🗑 还挂着）。 */
  const [clearedId, setClearedId] = useState<string | null>(null)
  /** 同一次渲染内的双击护栏：React 的 `pending` 要下一帧才生效（上游用 ref 补这个窗口）。 */
  const pendingRef = useRef(false)
  const goalId = goal?.id

  // 目标身份变了（被清除/替换/外部改了）→ 本地编辑态失效：否则残留草稿的回车会写到**新目标**上
  useEffect(() => {
    setEditing(false)
    setActionError(null)
    setClearedId(null)
  }, [goalId])

  if (goal === null || goal.phase === 'complete' || goal.id === clearedId) return null

  const run = async (
    action: 'edit' | 'pause' | 'resume' | 'clear',
    objective?: string
  ): Promise<boolean> => {
    if (pendingRef.current) return false
    pendingRef.current = true
    setPending(true)
    setActionError(null)
    const result = await store.goalAction(action, objective)
    pendingRef.current = false
    setPending(false)
    if (result.error !== undefined) {
      setActionError(result.error)
      return false
    }
    return true
  }

  const save = async (): Promise<void> => {
    const trimmed = draft.trim()
    if (trimmed === '') return
    if (await run('edit', trimmed)) setEditing(false)
  }

  if (editing) {
    return html`<div class="goal-bar" data-goal-bar>
      <div class="goal-bar-row">
        <input class="goal-input" type="text" aria-label="目标内容" value=${draft} autoFocus
          onInput=${(e: Event) => { setDraft((e.target as HTMLInputElement).value) }}
          onKeyDown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); void save() }
            if (e.key === 'Escape') setEditing(false)
          }} />
        ${actionError !== null ? html`<span class="goal-error" role="alert">${actionError}</span>` : null}
        <div class="goal-acts">
          <button type="button" class="goal-act" title="保存目标" aria-label="保存目标"
            disabled=${pending || draft.trim() === ''} onClick=${() => { void save() }}>
            <span class="codicon codicon-check"></span>
          </button>
          <button type="button" class="goal-act" title="取消编辑" aria-label="取消编辑"
            disabled=${pending} onClick=${() => setEditing(false)}>
            <span class="codicon codicon-close"></span>
          </button>
        </div>
      </div>
    </div>`
  }

  /**
   * process-local activation，**按 `(id, revision)` 与投影对账** —— 与投影是两条来路，
   * 晚到的那一份可能已经过期（上游读这一档时也是这么对账的：
   * `next.id === goalId && next.revision === revision ? next.activation : undefined`）。
   * 对不上 = "还不知道"，与上游同形。
   */
  const activationRaw = store.goalActivation.value
  const activation = activationRaw.id === goal.id && activationRaw.revision === goal.revision
    ? activationRaw.activation
    : undefined
  /**
   * 阶段文字：`active` 时由 activation 决定是哪一档（上游 `activeLabel`）——
   * `disarmed` = 「未运行的目标」（本进程不会自动续跑它），否则「进行中的目标」。
   */
  const label = goal.phase === 'active' && activation === 'disarmed'
    ? ACTIVE_DISARMED_LABEL
    : PHASE_LABEL[goal.phase] ?? goal.phase
  /** 恢复：上游 `showResume = phase === 'paused' || (phase === 'active' && activation === 'disarmed')` */
  const showResume = goal.phase === 'paused' || (goal.phase === 'active' && activation === 'disarmed')
  /** 暂停：上游只在 **`active` + `armed`** 时给（激活还不知道时两边都不给，不是"默认给暂停"） */
  const showPause = goal.phase === 'active' && activation === 'armed'
  return html`<div class="goal-bar" data-goal-bar>
    <div class="goal-bar-row" title=${goal.phase === 'blocked' ? goal.blockedReason : undefined}>
      <span class="goal-glyph" aria-hidden="true"><span class="codicon codicon-target"></span></span>
      <span class="goal-label">${label}</span>
      <span class="goal-objective">${goal.objective}</span>
      ${actionError !== null ? html`<span class="goal-error" role="alert">${actionError}</span>` : null}
      <div class="goal-acts">
        ${showPause
          ? html`<button type="button" class="goal-act" title="暂停目标" aria-label="暂停目标"
              disabled=${pending} onClick=${() => { void run('pause') }}>
              <span class="codicon codicon-debug-pause"></span>
            </button>`
          : null}
        ${showResume
          ? html`<button type="button" class="goal-act" title="恢复目标" aria-label="恢复目标"
              disabled=${pending} onClick=${() => { void run('resume') }}>
              <span class="codicon codicon-play"></span>
            </button>`
          : null}
        <button type="button" class="goal-act" title="编辑目标" aria-label="编辑目标"
          disabled=${pending} onClick=${() => { setDraft(goal.objective); setEditing(true) }}>
          <span class="codicon codicon-edit"></span>
        </button>
        <button type="button" class="goal-act" title="清除目标" aria-label="清除目标"
          disabled=${pending} onClick=${() => {
            const id = goal.id
            void run('clear').then((ok) => { if (ok && id !== undefined) setClearedId(id) })
          }}>
          <span class="codicon codicon-trash"></span>
        </button>
      </div>
    </div>
  </div>`
}
