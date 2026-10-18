// 图片卡模型：从结果内容块派生「标签 + 附件引用 + 信封文本」（适配上游 0.1.7-rc.2）。
// 只认 `read_image` 的**已结算成功**结果；任何形状不符一律返回 null（落回通用卡，不渲染半对的内容）。
// 字节不在结果里（结果只带附件引用），由附件大类按需另取 —— 本文件不碰网络。
import { relativizeToCwd } from './terminal'

/** 一张图的附件引用（只保留渲染要用的字段）。 */
export interface ImageCardRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  /** 归一化把栅格缩小过时，记录**缩小前**的尺寸（没缩过就没有这个字段）。 */
  originalDimensions?: { width: number; height: number }
  name?: string
}

export interface ImageCard {
  /** 卡标签：读取路径（相对工作区根，给人看） */
  label: string
  /** 原始路径（未相对化）——点标签时交给宿主打开编辑器用 */
  path: string
  /** 结果返回的图片，按结果顺序 */
  images: ImageCardRef[]
  /**
   * 结果里**除信封之外**的文本块（按序拼接）；没有就是空串。
   *
   * 信封文本（`<path>…</path>` 那一坨）**不进展示**：它是给模型读的，路径与尺寸另有更准的来源
   *（`meta.path` 与附件引用里的宽高字节）。把它原样铺在图片下面，正是这张卡当初要消除的现象。
   */
  extraText: string
}

/** 上游认可的四类图片 MIME；新增成员必须同步，否则那张图会静默退化成通用卡。 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** `read_image` 写的信封形状（识别门：不匹配就不是一次成形图片读） */
const IMAGE_ENVELOPE = /^<path>[^\n]*<\/path>\n<type>image<\/type>\n<content>\n[\s\S]*\n<\/content>$/u

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function parseArgs(argsRaw?: string): Record<string, unknown> | null {
  if (!argsRaw) return null
  try {
    return asRecord(JSON.parse(argsRaw))
  } catch {
    return null
  }
}

/**
 * 持久化展示路径：只要 `path` 这一个事实 —— 附件引用一律从结果内容块取，
 * 不从 meta 取（避免 post-execute 替换内容后残留过期引用）。
 */
function imageMeta(meta: unknown): { path: string } | null {
  const rec = asRecord(meta)
  if (rec === null) return null
  const path = rec['path']
  if (typeof path !== 'string' || path === '') return null
  return { path }
}

/**
 * 结果内容块里的附件引用：逐字段校验，任一项不合即整卡退让。
 * `attachmentId` 只查存在性 —— 它是不透明的内容寻址 id，不解析、不套本地格式。
 */
function imageReferences(content: unknown[]): ImageCardRef[] | null {
  const refs: ImageCardRef[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block === null || block['type'] !== 'image') continue
    const attachment = asRecord(block['attachment'])
    if (attachment === null) return null
    const { attachmentId, mediaType, bytes, width, height, name, originalDimensions } = attachment
    if (typeof attachmentId !== 'string' || attachmentId === '') return null
    if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) return null
    if (!positiveInteger(bytes) || !positiveInteger(width) || !positiveInteger(height)) return null
    if (name !== undefined && typeof name !== 'string') return null
    // 缩小前尺寸：给了就必须两维都是正整数，否则整卡退让（不猜半截）
    let original: ImageCardRef['originalDimensions']
    if (originalDimensions !== undefined) {
      const dims = asRecord(originalDimensions)
      if (dims === null || !positiveInteger(dims['width']) || !positiveInteger(dims['height'])) return null
      original = { width: dims['width'], height: dims['height'] }
    }
    refs.push({
      attachmentId, mediaType, bytes, width, height,
      ...(original === undefined ? {} : { originalDimensions: original }),
      ...(name === undefined ? {} : { name }),
    })
  }
  return refs.length > 0 ? refs : null
}

/**
 * 结果里**除信封之外**的文本块按序拼接。
 *
 * 信封块既是识别门（必须出现过，否则这张卡不认），也**不进**展示：它给模型读，
 * 而路径与尺寸在 `meta.path` 与附件引用里都有更准的一份。
 * @param content - 结果内容块
 * @returns 其余文本（可能为空串）；**从未出现信封块**时 null（退让到通用卡）
 */
function imageExtraText(content: unknown[]): string | null {
  const parts: string[] = []
  let sawEnvelope = false
  for (const part of content) {
    const block = asRecord(part)
    if (block === null || block['type'] !== 'text' || typeof block['text'] !== 'string') continue
    const text = block['text']
    if (IMAGE_ENVELOPE.test(text)) {
      sawEnvelope = true
      continue
    }
    parts.push(text)
  }
  return sawEnvelope ? parts.join('\n') : null
}

/**
 * 内容是否**全部**由本卡能渲染的块构成。
 * 出现别的块（推理、扩展类型、非对象）时退让 —— 否则那张卡会把它们静默藏起来。
 */
function fullyRendered(content: unknown[]): boolean {
  return content.every((part) => {
    const block = asRecord(part)
    if (block === null) return false
    return block['type'] === 'image' || (block['type'] === 'text' && typeof block['text'] === 'string')
  })
}

/**
 * 派生图片卡；非图片读、形状不符一律 null。
 *
 * 回退条件（任一不成立即退让到通用卡）：
 *   ① 未结算成功（运行中/失败/被打断）；② 工具名不是 `read_image`；③ 参数缺 `file_path`；
 *   ④ 没有可用的展示路径（meta.path）；⑤ 内容含本卡渲染不了的块；⑥ 附件引用不合法；⑦ 没有信封文本。
 *
 * ④ 的**有意偏离**：上游对「嵌套调用」（run_code 里派发的 read_image，不持久化 meta）回退用参数里的
 * `file_path`，本插件的结果项没有父调用标识、无法区分根调用与嵌套调用，故一律要求 meta.path ——
 * 宁可退让到通用卡，也不拿作者手输的路径当已解析的展示路径。
 * @param item - 工具项（name/status/argsRaw/meta/blocks）
 * @param cwd - 会话工作区根（标签相对化用）
 * @returns 图片卡；形状不符返回 null
 */
export function imageCardModel(
  item: { name: string; status: string; argsRaw?: string; meta?: unknown; blocks?: unknown; parentCallId?: string },
  cwd?: string
): ImageCard | null {
  if (item.status !== 'ok') return null
  if (item.name !== 'read_image') return null
  const args = parseArgs(item.argsRaw)
  const filePath = args?.['file_path']
  if (typeof filePath !== 'string' || filePath.trim() === '') return null
  // 展示路径：根调用落在持久化的 `meta.path` 上；**嵌套调用不持久化 meta**，
  // 回退用它自己的 `file_path` 参数（上游 的 `metaPath ?? (parentCallId ? filePath : null)`）。
  // 根调用 meta 坏形/缺失时**不**回退 —— 那时宁可退让到通用卡，也不拿模型手写的路径当已解析路径。
  const path = imageMeta(item.meta)?.path ?? (item.parentCallId !== undefined ? filePath : undefined)
  if (path === undefined) return null
  const content = Array.isArray(item.blocks) ? (item.blocks as unknown[]) : null
  if (content === null) return null
  if (!fullyRendered(content)) return null
  const images = imageReferences(content)
  if (images === null) return null
  const extraText = imageExtraText(content)
  if (extraText === null) return null
  return { label: relativizeToCwd(path, cwd), path, images, extraText }
}
