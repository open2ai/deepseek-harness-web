// 用户消息行：右侧深色气泡 + @引用贴片 + 图片。
//
// **引用贴片从正文里解析**（见 core/ref-mentions）：引用 token 本来就写在正文里（发送时注入引用行），
// 所以实时与历史同一条规则 —— 历史恢复的行也把 `@rel/path` / `@[label](dsh-session:…)` 渲染成贴片，
// 不会退化成裸文本，也不会出现「贴片 + @xxx」两份。
// 只有本地乐观帧（正文里还没有引用行、但 `refs` 快照已在）才额外走独立贴片行那条老路。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import type { ImageAttachment } from '../../core/protocol'
import { hasRefMention } from '../../core/ref-mentions'
import { refChipEl, refText } from './ref-text'
import { RowMeta } from './meta'
import { AttachmentGallery } from '../attachment/AttachmentGallery'
import { fileExt, fileSizeText } from '../../core/file-labels'

export function UserRow({ row, store, latest }: { row: Extract<ChatRow, { kind: 'user' }>; store: ChatStore; latest?: boolean }) {
  // 版式：**附件行（图片/文件）在气泡之外、且在正文之上**，
  // 然后才是正文气泡（内含 @引用贴片与文本）；引用摘要与动作在最后。
  const hasAtts = row.images.length > 0 || (row.files?.length ?? 0) > 0 || (row.imageRefs?.length ?? 0) > 0
  const mentioned = hasRefMention(row.text)
  const localRefs = row.refs
  return html`<div class="msg user${latest ? ' latest' : ''}"><div class="col">
    ${hasAtts
      ? html`<div class="user-atts">
          ${row.images.map(
            (img: ImageAttachment) =>
              html`<div class="user-img" key=${img.name}><img src=${`data:${img.mediaType};base64,${img.data}`} alt=${img.name || '图片'} title=${img.name || ''} /></div>`
          )}
          ${row.files && row.files.length > 0
            ? html`<div class="user-files">${row.files.map((f, i) => {
                const meta = [fileExt(f.name), fileSizeText(f.bytes)].filter(Boolean).join(' ')
                // 有本地路径（实时发送的）→ 可点开；历史回放的只有名字/大小 → 与上游一样只展示
                return f.path !== undefined
                  ? html`<button type="button" class="user-file-chip" key=${i} title=${f.path}
                      onClick=${() => store.openFile(f.path as string)}>
                      <span class="codicon codicon-file"></span>
                      <span class="ufname">${f.name}</span>
                      <span class="ufmeta">${meta}</span>
                    </button>`
                  : html`<span class="user-file-chip" key=${i} title=${f.name}>
                      <span class="codicon codicon-file"></span>
                      <span class="ufname">${f.name}</span>
                      <span class="ufmeta">${meta}</span>
                    </span>`
              })}</div>`
            : null}
          ${row.imageRefs && row.imageRefs.length > 0
            ? html`<div class="user-img"><${AttachmentGallery} store=${store} images=${row.imageRefs} /></div>`
            : null}
        </div>`
      : null}
    <div class="body">
      ${!mentioned && localRefs && localRefs.length > 0
        ? html`<div class="user-refs">${localRefs.map((r, i) => refChipEl({ kind: r.kind, label: r.label, token: r.token ?? '' }, i))}</div>`
        : null}
      ${row.text ? html`<div class="user-text">${refText(row.text, localRefs)}</div>` : null}
    </div>
    ${RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
    })}
  </div></div>`
}
