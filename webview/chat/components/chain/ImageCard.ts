// 图片卡（子类卡）：读类工具返回图片时的展开体 —— 图廊 + **完整记录路径** + 每张图的尺寸与字节数。
//
// 形态对齐上游 0.2.1：信封文本（`<path>…</path>` 那一坨给模型读的东西）**不再铺在下面**，
// 换成两段更准的事实 —— 路径取持久化的展示路径（未相对化，整段），尺寸取附件引用里的
// 宽高字节（缩过的还带上缩小前的原尺寸）。只负责「摆什么」；取件/加载态/失败重试/看全尺寸
// 都在附件大类（components/attachment）里。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'
import type { ImageCard as ImageCardData, ImageCardRef } from '../../core/image-card'
import { AttachmentGallery } from '../attachment/AttachmentGallery'

/**
 * 一张图的尺寸文案（逐字对齐上游两条 locale 文案）：`宽x高px，字节 字节`；缩过时补"（由 原宽x原高px 缩小）"。
 * @param image - 附件引用
 * @returns 一行尺寸文案
 */
export function imageSizeText(image: ImageCardRef): string {
  const size = `${String(image.width)}x${String(image.height)}px`
  const bytes = `${String(image.bytes)} 字节`
  if (image.originalDimensions === undefined) {
    return `${size}，${bytes}`
  }
  const original = `${String(image.originalDimensions.width)}x${String(image.originalDimensions.height)}px`
  return `${size}（由 ${original} 缩小），${bytes}`
}

export function ImageCard({ card, store }: { card: ImageCardData; store: ChatStore }) {
  return html`<div class="img-card">
    <${AttachmentGallery} store=${store} images=${card.images} />
    <div class="img-meta">
      <div class="img-path"><button type="button" class="chain-file-link" title=${card.path}
        onClick=${() => store.openFile(card.path)}>${card.path}</button></div>
      ${card.images.map((image, index) => html`<div class="img-size" data-image-size=${String(index)}>${imageSizeText(image)}</div>`)}
    </div>
    ${card.extraText !== '' ? html`<div class="img-extra">${card.extraText}</div>` : null}
  </div>`
}
