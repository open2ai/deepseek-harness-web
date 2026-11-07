// 用户消息行：右侧深色气泡 + @引用贴片 + 图片。
//
// **引用贴片从正文里解析**（见 core/ref-mentions）：引用 token 本来就写在正文里（发送时注入引用行），
// 所以实时与历史同一条规则 —— 历史恢复的行也把 `@rel/path` / `@[label](dsh-session:…)` 渲染成贴片，
// 不会退化成裸文本，也不会出现「贴片 + @xxx」两份。
// 只有本地乐观帧（正文里还没有引用行、但 `refs` 快照已在）才额外走独立贴片行那条老路。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import type { ImageAttachment } from '../../core/protocol'
import { hasRefMention } from '../../core/ref-mentions'
import { refChipEl } from './ref-text'
import { RowMeta } from './meta'
import { AttachmentGallery } from '../attachment/AttachmentGallery'
import { fileExt, fileSizeText } from '../../core/file-labels'
import { SecretText } from './SecretText'

/** 用户正文里的一段：普通文字，或一段引用（blockquote）。 */
type QuotedSegment = { kind: 'text'; text: string } | { kind: 'quote'; text: string }

/**
 * 把用户消息正文切成「普通文字 / 引用段」序列（对齐上游 `QuotedUserText`）。
 *
 * **引用可以在任意位置**（不再只认开头）：发送时引用按点引用时的光标位置拼进正文
 *（见 `outbox.composeWithQuotes`），所以渲染侧要按行扫描连续 `>` 行成组，
 * 组与组之间的正文原样保留；引用段里的多行合成一段（同一组内 `>` 空行分条仍按组渲染）。
 * @param text - 行上的完整正文
 * @returns 按出现顺序的段列表
 */
function readQuotedText(text: string): QuotedSegment[] {
  const lines = text.split(/\r?\n/u)
  const segments: QuotedSegment[] = []
  let textBuf: string[] = []
  let quoteBuf: string[] = []
  const flushText = (): void => {
    if (textBuf.length === 0) return
    const joined = textBuf.join('\n')
    textBuf = []
    if (joined.trim() !== '') segments.push({ kind: 'text', text: joined })
  }
  const flushQuote = (): void => {
    if (quoteBuf.length === 0) return
    segments.push({ kind: 'quote', text: quoteBuf.join('\n') })
    quoteBuf = []
  }
  for (const line of lines) {
    if (line.startsWith('>')) {
      flushText()
      const content = line.replace(/^>\s?/u, '')
      if (content.trim() === '') flushQuote()
      else quoteBuf.push(content)
    } else {
      flushQuote()
      textBuf.push(line)
    }
  }
  flushQuote()
  flushText()
  return segments
}

export function UserRow({ row, store, latest }: { row: Extract<ChatRow, { kind: 'user' }>; store: ChatStore; latest?: boolean }) {
  // 「问题与回答」气泡的展开态（迟到补答专用；普通用户消息不用）
  const [qrOpen, setQrOpen] = useState(false)
  /**
   * 消息里被截断的引用：悬停看全文（上游 `QuotePreview` 的 clipped full-text popover）。
   * 与输入区引用贴片同一套：固定定位、视口上下翻转/左右夹取、超高纵向滚动。
   */
  const [quoteTip, setQuoteTip] = useState<
    { left: number; width: number; maxHeight: number; top?: number; bottom?: number; text: string } | null
  >(null)
  const quoteTipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelQuoteTipTimer = (): void => {
    if (quoteTipTimer.current !== undefined) {
      clearTimeout(quoteTipTimer.current)
      quoteTipTimer.current = undefined
    }
  }
  const scheduleHideQuoteTip = (): void => {
    cancelQuoteTipTimer()
    quoteTipTimer.current = setTimeout(() => {
      quoteTipTimer.current = undefined
      setQuoteTip(null)
    }, 200)
  }
  useEffect(() => cancelQuoteTipTimer, [])
  const qr = row.questionReply
  if (qr !== undefined) {
    /**
     * **迟到补答**（`source.kind === 'user-question-reply'`）：上游把它渲染成右对齐的回答气泡，
     * 标题「问题与回答」，一行摘要 + 可展开的逐题问答。它不是普通用户消息，正文 JSON 不该原样上屏。
     */
    const valuesOf = (id: string): string[] => {
      const answer = qr.answers.find((a) => a.id === id)
      const custom = answer?.custom?.trim() ?? ''
      return [...(answer?.selected ?? []), ...(custom === '' ? [] : [custom])]
    }
    const summary = qr.questions.length === 0
      ? qr.text
      : qr.questions.map((q) => valuesOf(q.id).join('、')).filter((v) => v !== '').join('；')
    const copyText = qr.questions.length === 0
      ? qr.text
      : qr.questions.map((q) => {
          const head = q.header !== undefined && q.header !== q.question ? `${q.header} — ${q.question}` : q.question
          const values = valuesOf(q.id)
          return `${head}\n回答：${values.length === 0 ? '未回答' : values.join('、')}`
        }).join('\n\n')
    return html`<div class="msg user question-reply${latest ? ' latest' : ''}"><div class="col">
      <div class="qr-bubble">
        <div class="qr-label">问题与回答</div>
        ${qrOpen && qr.questions.length > 0
          ? html`<div class="qr-detail">${qr.questions.map((q) => {
              const head = q.header !== undefined && q.header !== q.question ? `${q.header} — ${q.question}` : q.question
              const values = valuesOf(q.id)
              return html`<div class="qr-pair" key=${q.id}>
                <div class="qr-q">${head}</div>
                <div class="qr-a">${values.length === 0 ? '未回答' : values.join('、')}</div>
              </div>`
            })}</div>`
          : html`<div class="qr-summary">${summary === '' ? '已提交回答' : summary}</div>`}
        <div class="qr-actions">
          ${qr.questions.length > 0
            ? html`<button type="button" class="qr-toggle" aria-expanded=${qrOpen}
                onClick=${() => setQrOpen((v) => !v)}>${qrOpen ? '收起' : '展开'}</button>`
            : null}
          <button type="button" class="qr-copy" onClick=${() => store.copy(copyText)}>复制</button>
        </div>
      </div>
      ${RowMeta({ time: row.time, copyable: copyText !== '' })}
    </div></div>`
  }
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
  /**
   * **气泡只在有文本时渲染**：
   *
   * 引用贴片**不在气泡里**：上游把引用摘要放在气泡之外、气泡下方。
   */
  const showRefChips = !mentioned && localRefs !== undefined && localRefs.length > 0
  // 引用块（发送时由贴片拼出）：上游把它渲染成**气泡内的一行内联引用**（引用标记 + 截断文字），
  // 后面的正文紧跟着同一行流；消息里不出现字面的 `>`，也不拆成两个气泡。
  const segments = readQuotedText(row.text)
  const hasBubble = segments.length > 0
  /** 悬停被截断的引用 → 显示全文浮层（短引用不弹）。 */
  const showQuoteTip = (e: MouseEvent, text: string): void => {
    cancelQuoteTipTimer()
    const inline = e.currentTarget as unknown as HTMLElement
    const src = inline.querySelector('.qsrc') as unknown as HTMLElement | null
    // 有布局信息且确认没被截断 → 不弹（脚本级 DOM 环境拿不到布局，按"需要浮层"处理）
    if (src !== null && (src.clientWidth > 0 || src.scrollWidth > 0) && src.scrollWidth <= src.clientWidth + 1) return
    let rect: DOMRect = { left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    try {
      rect = inline.getBoundingClientRect()
    } catch {
      /* 非浏览器环境没有布局信息 */
    }
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(560, Math.max(240, vw - 24))
    const left = Math.min(Math.max(rect.left, 12), Math.max(12, vw - width - 12))
    const spaceAbove = rect.top - 12
    const spaceBelow = vh - rect.bottom - 12
    const above = spaceAbove >= 160 || spaceAbove >= spaceBelow
    const maxHeight = Math.max(96, Math.min(vh * 0.6, above ? spaceAbove : spaceBelow))
    setQuoteTip(above
      ? { left, width, maxHeight, bottom: vh - rect.top + 6, text }
      : { left, width, maxHeight, top: rect.bottom + 6, text })
  }
  /**
   * **凭据遮挡**：已发送文本里认得出的凭据只留前 8 个字符，其余变 `*`。
   *
   * 三条边界：① 只改**显示** —— 复制（`store.copy(row.text)`）与模型输入都是原文；
   * ② 认不出的格式一律不遮（命名赋值、句子里的密码、验证码都不动），短串也不算凭据；
   * ③ 眼睛图标在**同一行末尾**，遮着时是睁眼（点了显示），显示后是划掉的眼（点了重新遮）。
   */
  return html`<div class="msg user${latest ? ' latest' : ''}"><div class="col">
    ${hasAtts
      ? html`<div class="user-atts">
          ${/* 图片**只画一次**，且**优先权威那一路**：认领时 `messages.ts:454` 会把本地内联字节搬到权威行上，
               而权威行自带 `imageRefs`（内容寻址）—— 两条路都画就是同一张图出现两遍（真机 2026-10-14）。
               维护者定案：**要附件层那张、不要本地内联那张**（本地那张是 `<img src="data:…">` 套一个
               原生 `<button>`，铺满且带按钮边框）。只有还没入档（行上没有 `imageRefs`）时才退回本地字节 ——
               否则刚粘贴的那一瞬间会没有图。 */ ''}
          ${row.imageRefs && row.imageRefs.length > 0
            ? html`<div class="user-img"><${AttachmentGallery} store=${store} images=${row.imageRefs} /></div>`
            : row.images.map(
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
                    ? (): void => {
                        /**
                         * **文件块的原图不在本地对象库**（web 上传只留图片变体；`session/attachment`
                         * 又只收图片引用）—— 同一条消息若带**同名图片**，改用那张图的 id/引用打开
                         *（编辑器里至少能看到图）；否则按原逻辑只按文件 id 找本地对象。
                         */
                        const sameImage = (row.imageRefs ?? []).find((r) => r.name === f.name)
                        if (sameImage !== undefined) {
                          store.openAttachment(sameImage.attachmentId, sameImage.name ?? f.name, sameImage)
                        } else {
                          store.openAttachment(f.attachmentId as string, f.name)
                        }
                      }
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
          ${/* （附件层那条已挪到上面与本地字节同一个三元里：两条路只走一条。） */ ''}
        </div>`
      : null}
    ${/* 引用与正文在**同一个气泡**里：引用是行内的（图标 + 截断文字），后接用户正文 */ ''}
    ${hasBubble
      ? html`<div class="body">
          <div class="user-text">
            ${segments.map((segment, index) => segment.kind === 'quote'
              ? html`<span class="user-quote-inline" key=${index}
                  onMouseOver=${(e: MouseEvent) => showQuoteTip(e, segment.text)}
                  onMouseOut=${scheduleHideQuoteTip}>
                  <span class="codicon codicon-quote" aria-hidden="true"></span>
                  <span class="qsrc">${segment.text}</span>
                </span>`
              : html`<${SecretText} key=${index} text=${segment.text} refs=${localRefs} />`)}
          </div>
        </div>`
      : null}
    ${quoteTip === null
      ? null
      : html`<div class="user-quote-tip" role="tooltip"
          onMouseOver=${cancelQuoteTipTimer}
          onMouseOut=${scheduleHideQuoteTip}
          style=${`left:${String(quoteTip.left)}px;width:${String(quoteTip.width)}px;max-height:${String(quoteTip.maxHeight)}px;` +
            (quoteTip.top === undefined ? `bottom:${String(quoteTip.bottom ?? 0)}px;` : `top:${String(quoteTip.top)}px;`)}>${quoteTip.text}</div>`}
    ${/* 引用贴片在**气泡之外**：
         本地回显还没把引用 token 写进正文时，靠这一行先把贴片画出来。 */ ''}
    ${showRefChips
      ? html`<div class="user-refs">${localRefs.map((r, i) => refChipEl({ kind: r.kind, label: r.label, token: r.token ?? '' }, i))}</div>`
      : null}
    ${RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
    })}
  </div></div>`
}
