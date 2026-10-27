// **正文图片增强器**：把 markdown 渲染出的图片占位升级成真正的图片，并负责灯箱与失败回退（适配上游 0.2.1-rc.2）。
//
// 为什么在 DOM 层做而不是渲染时直接出 `<img>`：
//   · markdown 正文走 `dangerouslySetInnerHTML`（定稿整段 / 流式按块复用 DOM），里面挂不了组件；
//   · 本地路径图要取字节（宿主读盘 → base64），这一步是异步的，只能在元素挂载后替换。
// 口径逐条对齐上游 `MarkdownImage`：
//   · 远程 http(s) 图：直接出图；
//   · 本地绝对路径 / 相对路径（相对按会话 cwd 拼绝对）：成功出图、可点开灯箱；
//   · 取不到 / 读失败：退成惰性 alt 文本（`图片无法预览 · alt/路径`），**不产生破图**；
//   · 不可取回的（`file:`/UNC/其它协议）：渲染规则已经直接出 alt 文本，这里不参与。
import { effect } from '@preact/signals'
import type { ChatHost } from './host'
import { mdImageTarget, resolveMdImagePath } from './markdown'

/**
 * 灯箱文案（逐字取上游 chat 命名空间的 `image.*`：`open/dialog/close/failed`）。
 * 页面侧其它文案同样按上游 zh 原文硬编码（见 `core/format.ts` 的既有做法）。
 */
export const MD_IMAGE_LABELS = {
  open: '查看大图',
  dialog: '图片预览',
  close: '关闭图片预览',
  failed: '图片无法预览',
} as const

/** 一张本地图在页面侧的状态（按**绝对路径**缓存：同一张图在一段对话里可能被引用多次）。 */
type ImageEntry =
  | { state: 'pending' }
  | { state: 'ready'; mediaType: string; data: string }
  | { state: 'error'; message: string }

export interface MarkdownImageOptions {
  host: ChatHost
  /** 会话工作区根路径（`''` = 未知：相对路径此时保持惰性 alt，与上游"cwd 未知不出图"同口径）。 */
  cwd: () => string
  /** 观察与查询的根（页面里用默认的 `document`）。 */
  root?: Document | HTMLElement
}

/** 当前打开的灯箱（同一时刻只允许一个）与它的键盘监听。 */
let activeLightbox: HTMLElement | undefined
let activeLightboxKey: ((event: KeyboardEvent) => void) | undefined
let restoreFocus: Element | null = null

/** 打开灯箱（Esc / 点遮罩 / 关闭按钮都收起，焦点回到触发元素）。 */
function openLightbox(src: string, alt: string): void {
  closeLightbox()
  restoreFocus = document.activeElement
  const overlay = document.createElement('div')
  overlay.className = 'md-lightbox'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', MD_IMAGE_LABELS.dialog)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'md-lightbox-close'
  close.setAttribute('aria-label', MD_IMAGE_LABELS.close)
  close.textContent = '✕'
  const img = document.createElement('img')
  img.className = 'md-lightbox-img'
  img.src = src
  img.alt = alt
  overlay.append(img, close)
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeLightbox()
    }
  }
  const onOverlayClick = (event: Event): void => {
    if (event.target === overlay) {
      closeLightbox()
    }
  }
  close.addEventListener('click', () => {
    closeLightbox()
  })
  overlay.addEventListener('click', onOverlayClick)
  document.addEventListener('keydown', onKey, true)
  activeLightboxKey = onKey
  activeLightbox = overlay
  document.body.appendChild(overlay)
  close.focus()
}

/** 收起当前灯箱（没有就什么都不做）。 */
function closeLightbox(): void {
  const overlay = activeLightbox
  if (overlay === undefined) {
    return
  }
  activeLightbox = undefined
  if (activeLightboxKey !== undefined) {
    document.removeEventListener('keydown', activeLightboxKey, true)
    activeLightboxKey = undefined
  }
  overlay.remove()
  if (restoreFocus !== null && typeof (restoreFocus as HTMLElement).focus === 'function') {
    ;(restoreFocus as HTMLElement).focus()
  }
  restoreFocus = null
}

/**
 * 安装正文图片增强器。
 * @param options - 宿主通道、cwd 读取器与根节点。
 * @returns 卸载函数（移观察器 / 移除监听）。
 */
export function installMarkdownImageEnhancer(options: MarkdownImageOptions): () => void {
  const { host, cwd } = options
  const root: Document | HTMLElement = options.root ?? document
  const cache = new Map<string, ImageEntry>()
  /** 正在等回帧的占位元素（按绝对路径分组；元素被重渲替换后自然失效）。 */
  const waiting = new Map<string, Set<HTMLElement>>()

  /** 把元素换成终态（失败/成功都只换一次）。 */
  const replace = (from: Element, to: Element): void => {
    if (from.parentNode !== null) {
      from.parentNode.replaceChild(to, from)
    }
  }

  const failedNode = (alt: string, destination: string): HTMLElement => {
    const span = document.createElement('span')
    span.className = 'md-image-alt'
    span.textContent = `${MD_IMAGE_LABELS.failed} · ${alt || destination}`
    return span
  }

  /**
   * 出图节点：`<img>` 外再包一个按钮（点击开灯箱）。
   * **图片在链接里时不包按钮**（上游同口径：纯图片链接只保留导航目标，不叠灯箱）。
   * 加载失败退成惰性 alt 文本（含失败文案），与上游 `onError` 那一支同口径。
   */
  const imageNode = (placeholder: Element, src: string, alt: string, destination: string): HTMLElement => {
    const img = document.createElement('img')
    img.className = 'md-image-el'
    img.src = src
    img.alt = alt
    img.loading = 'lazy'
    img.decoding = 'async'
    img.referrerPolicy = 'no-referrer'
    const inLink = placeholder.closest('a') !== null
    const wrap = (): HTMLElement => {
      if (inLink) {
        return img
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'md-image-btn'
      button.title = MD_IMAGE_LABELS.open
      button.setAttribute('aria-label', alt ? `${MD_IMAGE_LABELS.open}: ${alt}` : MD_IMAGE_LABELS.open)
      button.appendChild(img)
      button.addEventListener('click', () => {
        openLightbox(img.src, alt)
      })
      return button
    }
    const node = wrap()
    img.addEventListener('error', () => {
      replace(node, failedNode(alt, destination))
    })
    return node
  }

  /** 一个占位元素 → 终态（远程直接出图；本地按缓存/请求推进；cwd 未知就继续等）。 */
  const upgrade = (element: HTMLElement): void => {
    if (element.getAttribute('data-md-state') !== null) {
      return
    }
    const kind = element.getAttribute('data-md-image')
    const src = element.getAttribute('data-md-src') ?? ''
    const alt = element.getAttribute('data-md-alt') ?? ''
    if (kind === 'remote') {
      replace(element, imageNode(element, src, alt, src))
      return
    }
    if (kind !== 'local') {
      return
    }
    const target = mdImageTarget(src)
    if (target.kind !== 'local') {
      replace(element, failedNode(alt, src))
      return
    }
    const path = resolveMdImagePath(cwd(), target.src)
    // cwd 未知且是相对路径：上游此时也只出 alt 文本；这里留待 cwd 到达后重扫
    if (path === undefined) {
      return
    }
    const entry = cache.get(path)
    if (entry === undefined) {
      cache.set(path, { state: 'pending' })
      addWaiting(path, element)
      element.setAttribute('data-md-state', 'pending')
      host.post({ type: 'localImageReq', path })
      return
    }
    if (entry.state === 'pending') {
      addWaiting(path, element)
      element.setAttribute('data-md-state', 'pending')
      return
    }
    if (entry.state === 'error') {
      replace(element, failedNode(alt, path))
      return
    }
    replace(element, imageNode(element, `data:${entry.mediaType};base64,${entry.data}`, alt, path))
  }

  const addWaiting = (path: string, element: HTMLElement): void => {
    const set = waiting.get(path) ?? new Set<HTMLElement>()
    set.add(element)
    waiting.set(path, set)
  }

  /** 扫描根下所有尚未升级的占位。 */
  const scan = (): void => {
    const scope = root as ParentNode
    const elements = scope.querySelectorAll<HTMLElement>('[data-md-image]')
    for (const element of elements) {
      if (element.getAttribute('data-md-state') === null) {
        upgrade(element)
      }
    }
  }

  let scheduled = false
  const schedule = (): void => {
    if (scheduled) {
      return
    }
    scheduled = true
    // 一帧一次：流式期间 DOM 频繁变化，逐条升级会造成同一帧里反复布局
    const raf: (cb: () => void) => unknown = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0)
    raf(() => {
      scheduled = false
      scan()
    })
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.addedNodes.length > 0) {
        schedule()
        return
      }
    }
  })
  observer.observe(root as Node, { childList: true, subtree: true })

  // cwd 是会话级信号：它到账/变化时重扫一次（相对路径在 cwd 到达前保持惰性 alt）
  const stopCwdEffect = effect(() => {
    void cwd()
    schedule()
  })

  const offMessage = host.onMessage((msg) => {
    if (msg === null || typeof msg !== 'object') {
      return
    }
    const m = msg as { type?: unknown; path?: unknown; mediaType?: unknown; data?: unknown; error?: unknown }
    if (m.type !== 'localImageBytes' || typeof m.path !== 'string') {
      return
    }
    const path = m.path
    if (typeof m.error === 'string') {
      cache.set(path, { state: 'error', message: m.error })
    } else if (typeof m.data === 'string') {
      cache.set(path, {
        state: 'ready',
        mediaType: typeof m.mediaType === 'string' ? m.mediaType : 'image/png',
        data: m.data,
      })
    } else {
      cache.set(path, { state: 'error', message: '宿主没有返回图片字节' })
    }
    const elements = waiting.get(path)
    waiting.delete(path)
    for (const element of elements ?? []) {
      if (element.parentNode !== null) {
        element.removeAttribute('data-md-state')
        upgrade(element)
      }
    }
  })

  // 首屏：安装时可能已有正文（面板重建 / 历史恢复），立即扫一次
  scan()

  return () => {
    observer.disconnect()
    stopCwdEffect()
    offMessage()
    closeLightbox()
  }
}
