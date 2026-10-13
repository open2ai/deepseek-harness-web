// 附件大类：图廊（字节的取用与展示）。子类卡只给「一组附件引用 + 周边文案」，
// 取件（懒取/缓存/失败重试）、加载与失败态、尺寸约束、点击看全尺寸都在这里 —— 改一处全类生效，
// 子类卡换渲染不动取件逻辑。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import type { AttachmentRef } from '../../core/protocol'

/** 单图长边上限、多图瓦片边长、显示比例上下限。 */
const SINGLE_MAX = 240
const TILE = 64
const MIN_RATIO = 0.25
const MAX_RATIO = 4

/** 图廊三态文案。 */
const labels = {
  loading: '加载中…',
  failed: '加载失败，点此重试',
}

/** 单图：长边封顶且**不放大**超原始像素；比例越界按 cover 裁切（越宽左对齐、越瘦顶对齐）。 */
function singleStyle(img: AttachmentRef): string {
  const w0 = typeof img.width === 'number' && img.width > 0 ? img.width : SINGLE_MAX
  const h0 = typeof img.height === 'number' && img.height > 0 ? img.height : SINGLE_MAX
  const scale = Math.min(1, SINGLE_MAX / Math.max(w0, h0))
  let w = w0 * scale
  let h = h0 * scale
  const ratio = w / h
  let position = 'center'
  if (ratio > MAX_RATIO) {
    w = h * MAX_RATIO
    position = 'left'
  } else if (ratio < MIN_RATIO) {
    h = w / MIN_RATIO
    position = 'top'
  }
  return `width:${Math.round(w)}px;height:${Math.round(h)}px;object-fit:cover;object-position:${position}`
}

export function AttachmentGallery({ store, images }: { store: ChatStore; images: AttachmentRef[] }) {
  const cache = store.attachmentCache.value
  const ids = images.map((i) => i.attachmentId).join(',')
  // 懒取：进到这里（卡展开）才向宿主请求字节；已就绪/在飞的不会重复发
  useEffect(() => {
    for (const img of images) {
      store.requestAttachment(img.attachmentId)
    }
    // 依赖只取 id 串：引用数组每次渲染都是新对象，用 join 后的稳定值做键
  }, [ids, store])
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null)
  useEffect(() => {
    if (zoom === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setZoom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  if (images.length === 0) return null
  const single = images.length === 1
  /**
   * 灯箱的当前图（由容器点击设置）。**图本身**那颗按钮走"在编辑区打开"，
   * 所以灯箱挂在**容器**上：点图片 → 编辑器里看原图；点容器其它处 → 本卡灯箱（上游 `ImageLightbox` 同形）。
   */
  const firstReady = (): { src: string; alt: string } | null => {
    for (const img of images) {
      const entry = cache[img.attachmentId]
      if (entry !== undefined && entry.state === 'ready') {
        return { src: `data:${entry.mediaType ?? img.mediaType};base64,${entry.data ?? ''}`, alt: img.name ?? img.attachmentId }
      }
    }
    return null
  }
  return html`<div class="att-gallery" data-count=${images.length}
    onClick=${(event: MouseEvent) => {
      // 点在图片按钮上 → 不抢它的动作（那颗按钮负责"在编辑区打开"）
      const onImage = (event.target as Element | null)?.closest?.('.att-item')
      if (onImage instanceof HTMLElement) return
      const ready = firstReady()
      if (ready !== null) setZoom(ready)
    }}>
    ${images.map((img) => {
      const entry = cache[img.attachmentId]
      if (entry === undefined || entry.state === 'loading') {
        return html`<div class="att-item is-loading" key=${img.attachmentId}><span class="att-note">${labels.loading}</span></div>`
      }
      if (entry.state === 'error') {
        return html`<button type="button" class="att-item is-error" key=${img.attachmentId} title=${entry.error ?? ''}
          onClick=${() => store.requestAttachment(img.attachmentId)}><span class="att-note">${labels.failed}</span></button>`
      }
      const src = `data:${entry.mediaType ?? img.mediaType};base64,${entry.data ?? ''}`
      const box = single ? singleStyle(img) : `width:${TILE}px;height:${TILE}px;object-fit:cover;object-position:center`
      /**
       * 两个动作都在（2026-10-11 维护者："图片上游能预览，插件最好也能打开查看，如在编辑区打开"）：
       *   · **图本身**点开 → `openAttachment`：宿主按 `attachmentId` 取字节落临时文件，
       *     交给 VS Code 的**图片预览**在编辑区打开（`vscode.open`）；
       *   · **标题**点开 → 本卡的灯箱（与上游 `MessageImage.tsx` 的 `ImageLightbox` 同形）。
       * 图本身不用来开灯箱：上游那颗 `button` 的 `title` 就是"打开"，在编辑器里打开更贴近它的意图。
       */
      return html`<button type="button" class="att-item" key=${img.attachmentId}
        onClick=${() => store.openAttachment?.(img.attachmentId, img.name)}>
        <img src=${src} alt=${img.name ?? ''} title=${img.name ?? ''} style=${box} />
      </button>`
    })}
    ${zoom !== null
      ? html`<div class="att-lightbox" role="dialog" onClick=${() => setZoom(null)}>
          <img src=${zoom.src} alt=${zoom.alt} />
        </div>`
      : null}
  </div>`
}
