// 用户正文里的 `@` 引用 → 行内贴片。**发送侧只有这一份渲染**（提问行与 pending 插话气泡共用）。
//
// 贴片来源是**正文里的 token**（`core/ref-mentions`），不是"本地快照里存了贴片就画"：
// 引用 token 本来就写在正文里（发送时作引用行注入 prompt），所以历史恢复的行也照同一条规则解析，
// 不会退化成裸 `@rel/path`；也就不会出现"贴片 + @xxx"两份。
//
// 快照（`refs`）只做**覆盖**：命中同一 token 时用它的短名与图标 —— 与用户挑选时看到的一致
// （例如目录在候选里显示短名，正文里却是相对路径）。
import { html } from 'htm/preact'
import type { RefChip, RefSnap } from '../../core/store/types'
import { splitRefMentions } from '../../core/ref-mentions'

const ICON: Record<RefChip['kind'], string> = {
  directory: 'folder-opened',
  session: 'comment-discussion',
  file: 'file',
}

/** 单个贴片（图标按 kind + 短名；`title` 给全量 token）。 */
export function refChipEl(snap: { kind: RefChip['kind']; label: string; token: string }, key: string | number): unknown {
  return html`<span class="msg-ref-chip" key=${key} title=${snap.token}>
    <span class=${'ficon codicon codicon-' + ICON[snap.kind]}></span>
    <span class="msg-ref-label">${snap.label}</span></span>`
}

/**
 * 把一段用户正文渲染成「文本 + 引用贴片」的行内序列。
 *
 * @param text 正文（可能含引用 token）
 * @param refs 本地贴片快照（只有本面板刚发出的那条/那条插话才有）
 */
export function refText(text: string, refs?: readonly RefSnap[]): unknown {
  return splitRefMentions(text).map((seg, i) => {
    if (!('mention' in seg)) {
      return seg.text
    }
    const m = seg.mention
    const hit = refs?.find((r) => r.token === m.token)
    return refChipEl({ token: m.token, label: hit?.label ?? m.label, kind: hit?.kind ?? m.kind }, i)
  })
}
