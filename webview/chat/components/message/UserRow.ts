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
  //
  // ⚠️ **附件一律可点开、且在编辑区打开**（维护者 2026-10-12：「发送了文件、图片……
  // 点击能在编辑区打开预览；上游图片是弹出预览，插件改成在编辑区打开预览就行了，
  // 同样文件能在编辑区打开就行了」）。三条来路各有各的"字节从哪来"：
  //   · **实时发的图片**（本地乐观行）：只有粘贴/拖进来的 base64 → `openAttachmentBytes`（宿主落盘再打开）；
  //   · **实时发的文件**：有本地绝对路径 → `openFile`（直接在编辑器打开原文件，最省事也最准确）；
  //   · **历史回放**（进了日志之后）：图与文件都只有**内容寻址 id** → `openAttachment`（宿主 `session/attachment`
  //     取字节 → 落 `~/.dsh/attachments-view/` → 编辑器打开）。**路径不显示在界面上**（与上游一致：
  //     界面只有文件名/图，路径放 `title` 里，悬停可见）。
  const hasAtts = row.images.length > 0 || (row.files?.length ?? 0) > 0 || (row.imageRefs?.length ?? 0) > 0
  const mentioned = hasRefMention(row.text)
  const localRefs = row.refs
  return html`<div class="msg user${latest ? ' latest' : ''}"><div class="col">
    ${hasAtts
      ? html`<div class="user-atts">
          ${row.images.map(
            (img: ImageAttachment) =>
              html`<div class="user-img" key=${img.name}><button type="button" class="user-att-btn"
                title=${img.name || '在编辑区打开'}
                onClick=${() => store.openAttachmentBytes(img.data, img.mediaType, img.name)}>
                <img src=${`data:${img.mediaType};base64,${img.data}`} alt=${img.name || '图片'} />
              </button></div>`
          )}
          ${row.files && row.files.length > 0
            ? html`<div class="user-files">${row.files.map((f, i) => {
                const meta = [fileExt(f.name), fileSizeText(f.bytes)].filter(Boolean).join(' ')
                // 三条来路的优先级：本地路径（实时发的文件）→ 附件 id（历史）→ 都没有就只展示（不可点）
                const open = f.path !== undefined
                  ? (): void => store.openFile(f.path as string)
                  : f.attachmentId !== undefined
                    ? (): void => store.openAttachment(f.attachmentId as string, f.name)
                    : undefined
                const inner = html`<span class="codicon codicon-file"></span>
                  <span class="ufname">${f.name}</span>
                  <span class="ufmeta">${meta}</span>`
                return open === undefined
                  ? html`<span class="user-file-chip" key=${i} title=${f.name}>${inner}</span>`
                  : html`<button type="button" class="user-file-chip" key=${i}
                      title=${(f.path ?? f.name) + '（在编辑区打开）'}
                      onClick=${open}>${inner}</button>`
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
