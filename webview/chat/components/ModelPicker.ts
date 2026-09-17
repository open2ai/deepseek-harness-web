// 模型图标入口的弹窗内容：**二级选择**（与上游 ModelSelect 同构）。
//
//   第一级（root）：两行入口 ——「模型」与「推理等级」，各带当前值与右箭头，点开才是列表；
//   第二级：`model` = 按提供方分组的模型列表；`effort` = 该模型的推理等级列表（含「Default」= 提供方默认）。
//
// 键盘：↑↓ 在**当前层内**移动真实焦点（循环）、Enter 激活（原生 button）、Esc 返回上一级（第一级再 Esc 关闭）、
// ← 也当返回（本插件附加，便于一路方向键走完两级）。打开与换层时焦点落到该层首项，所以 ↑↓ 立刻可用 ——
// 之前的实现是一页平铺且选项不可聚焦，用户按 ↑↓ 只看到按钮上多出一圈默认焦点环。
//
// 与 `/model`（SearchPicker 的平铺可搜索列表）是两条独立入口：那边搜索、这边保留分组与两级结构。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ChatStore } from '../core/store/chat'

type Pane = 'root' | 'model' | 'effort'

export function ModelPicker({ store }: { store: ChatStore }) {
  const sel = store.sel.value
  const [pane, setPane] = useState<Pane>('root')
  const rootRef = useRef<HTMLDivElement | null>(null)

  const modelOf = (
    provider: string,
    model: string
  ): { name?: string; reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string } } | undefined =>
    sel.modelGroups?.find((g) => g.id === provider)?.models.find((m) => m.id === model)
  const active = modelOf(sel.curProvider, sel.curModel)
  const efforts = active?.reasoning?.efforts ?? []
  // 对齐上游 ModelSelect：该模型没有 defaultEffort 时，等级列表首位给「Default」（= 走提供方默认，不传 effort）
  const showProviderDefault = active?.reasoning !== undefined && active.reasoning.defaultEffort === undefined
  // 当前等级显示名：curEffort → 该模型 defaultEffort → 「Default」；模型没有 reasoning 元数据时整行不出现
  const effortLabel = ((): string | undefined => {
    if (active?.reasoning === undefined) {
      return undefined
    }
    const id = sel.curEffort || active.reasoning.defaultEffort
    if (!id) {
      return 'Default'
    }
    return efforts.find((e) => e.id === id)?.name || id
  })()
  const modelLabel = active?.name || sel.curModel || '未选择'

  /** 关闭弹窗并把焦点交还输入框：弹窗卸载后焦点会掉到 body，接着打字/敲 "/" 都会失效。 */
  const close = (): void => {
    store.closePopups()
    queueMicrotask(() => document.getElementById('input')?.focus())
  }

  // 打开与换层：焦点落到**当前生效项**（没有命中才退首项）。
  // 与权限那类列表同一手感：一进去光标就在"当前值"上，那行因此有底色 —— 否则当前项只有一个 ✓，
  // 看起来像"没选中"。长列表里这也顺带把它滚进可视区。
  useEffect(() => {
    const root = rootRef.current
    const target =
      root?.querySelector<HTMLElement>('button.mp-opt[aria-selected="true"]') ??
      root?.querySelector<HTMLElement>('button.mp-opt')
    target?.focus()
  }, [pane])

  // 键盘：↑↓ 移动焦点、Esc/← 返回上一级。挂 document 上而不是弹窗容器上 ——
  // 刚打开时焦点还在 🤖 按钮上（弹窗不在其 DOM 子树里），只挂容器的话第一下 ↑↓ 收不到。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button.mp-opt') ?? [])
        if (list.length === 0) {
          return
        }
        e.preventDefault()
        const at = list.findIndex((el) => el === document.activeElement)
        const next = (Math.max(at, 0) + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length
        list[next]?.focus()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (pane !== 'root') {
          setPane('root')
        } else {
          close()
        }
        return
      }
      if (e.key === 'ArrowLeft' && pane !== 'root') {
        e.preventDefault()
        setPane('root')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pane])

  /** 第二级的小标题：带返回按钮（Esc/← 之外的点选路径）。 */
  const head = (title: string): unknown => html`<div class="mp-head">
    <button type="button" class="mp-back" title="返回" aria-label="返回" onClick=${() => setPane('root')}>
      <span class="codicon codicon-chevron-left"></span>
    </button>
    <span class="mp-head-title">${title}</span>
  </div>`

  return html`<div class="mp" ref=${rootRef}>
    ${sel.modelFailures.length > 0
      ? html`<div class="popup-fail" title=${JSON.stringify(sel.modelFailures)}><span class="codicon codicon-warning inline-ico"></span>${sel.modelFailures.length} 组模型加载失败</div>`
      : null}
    ${pane === 'root'
      ? html`<div class="mp-pane">
          <button type="button" class="mp-cell mp-opt" aria-haspopup="menu" onClick=${() => setPane('model')}>
            <span class="mp-cell-label">模型</span>
            <span class="mp-cell-value">${modelLabel}</span>
            <span class="codicon codicon-chevron-right mp-cell-chev"></span>
          </button>
          ${effortLabel === undefined
            ? null
            : html`<button type="button" class="mp-cell mp-opt" aria-haspopup="menu" onClick=${() => setPane('effort')}>
                <span class="mp-cell-label">推理等级</span>
                <span class="mp-cell-value">${effortLabel}</span>
                <span class="codicon codicon-chevron-right mp-cell-chev"></span>
              </button>`}
        </div>`
      : null}
    ${pane === 'model'
      ? html`<div class="mp-pane">
          ${head('模型')}
          <div class="mp-list">
            ${(sel.modelGroups ?? []).map(
              (g) =>
                g.models.length > 0 &&
                html`<div key=${g.id}>
                  <div class="optgroup-label">${g.name || g.id}</div>
                  ${g.models.map(
                    (m) => html`<button type="button" class="mp-opt" key=${m.id}
                      aria-selected=${g.id === sel.curProvider && m.id === sel.curModel}
                      title=${m.description || m.name || m.id}
                      onClick=${() => {
                        // 不传 effort：由 store.selectModel 按「同路由保留现等级 / 换模型用其 defaultEffort」处理（与上游同）
                        store.selectModel(g.id, m.id)
                        close()
                      }}>
                      <span class="mp-opt-name">${g.id === sel.curProvider && m.id === sel.curModel ? '✓ ' : ''}${m.name || m.id}</span>
                    </button>`
                  )}
                </div>`
            )}
          </div>
        </div>`
      : null}
    ${pane === 'effort'
      ? html`<div class="mp-pane">
          ${head('推理等级')}
          <div class="mp-list">
            ${showProviderDefault
              ? html`<button type="button" class="mp-opt" key="provider-default"
                  aria-selected=${sel.curEffort === ''}
                  onClick=${() => {
                    store.selectModel(sel.curProvider, sel.curModel, '') // '' = 显式选提供方默认
                    close()
                  }}><span class="mp-opt-name">${sel.curEffort === '' ? '✓ ' : ''}Default</span></button>`
              : null}
            ${efforts.map(
              (e) => html`<button type="button" class="mp-opt" key=${e.id}
                aria-selected=${e.id === sel.curEffort}
                onClick=${() => {
                  store.selectModel(sel.curProvider, sel.curModel, e.id)
                  close()
                }}><span class="mp-opt-name">${e.id === sel.curEffort ? '✓ ' : ''}${e.name || e.id}</span></button>`
            )}
          </div>
        </div>`
      : null}
  </div>`
}
