// 代码块工具栏（复制 / 换行开关）的**全局事件委托**。
//
// 为什么是全局而不是"每个渲染点各挂一份"：
// `core/markdown.ts` 的围栏规则输出的是一段 HTML（含 `.md-code` 与两个按钮），而 `renderMd()`
// 有 **5 个调用点** —— 回答正文（`message/MessageBody`）、链内程序块（`chain/ToolRow`）、
// 细节卡正文（`chain/DetailsCardBody`）、plan 正文（`chain/plan`）、联网卡答案（`chain/WebCard`）。
// 历史实现只在正文那一处挂了委托，于是**另外 4 处渲染出来的代码块，两个按钮点了都没反应**
//（维护者 2026-10-13 真机："换行点击没反应""点击复制按钮，没法复制"）。
//
// 挂成 document 级一次，任何位置、任何时候渲染出的 `.md-code` 都自动可用；
// 判据是 `.md-code-act` + 两个 `data-` 属性，很特异，不会误伤别的按钮。
export const CODE_COPY_LABELS = {
  copy: '复制',
  copied: '复制成功',
  wrap: '自动换行',
  unwrap: '取消自动换行',
} as const

/** 复制后的确认窗口（图标换成对勾的时长）；上游 `copied` 状态同量级。 */
const COPIED_MS = 1500

/**
 * 处理一次代码块工具栏的点击。
 * @param event - 冒泡到委托容器的点击事件。
 * @param copy - 写剪贴板的回调（页面侧 `store.copy`）。
 * @returns 命中并处理了按钮时为 true。
 */
export function handleCodeToolbarClick(event: Event, copy: (text: string) => void): boolean {
  const target = event.target as Element | null
  const button = target?.closest?.('.md-code-act')
  if (!(button instanceof HTMLElement)) return false
  const block = button.closest('.md-code')
  if (!(block instanceof HTMLElement)) return false

  if (button.hasAttribute('data-code-copy')) {
    const code = block.querySelector('pre')?.textContent ?? ''
    copy(code)
    /**
     * 确认窗口：**打上 `data-copied` + 换 `aria-label`，到点还原**。
     *
     * 图标不在这里换：对勾/复制两个图标都渲染进了 DOM，由 CSS 按 `data-copied` 二选一显隐
     *（上游是按 `copied` 状态二选一渲染，插件用 CSS 达到同一视觉，理由见 `core/code-icons.ts`）。
     * 可访问名**跟随状态**（复制中读作"复制成功"，与上游同口径）。
     *
     * ⚠️ **不碰 `title`**（2026-10-11 维护者："按钮不要提示'复制成功'，上游都没有"）：
     * 上游的提示是自绘 `Tooltip`，它的 `onClick` 分支会**把气泡撤掉**
     *（`cancelShow` 后 `withdraw`）—— 所以上游点完根本看不到"已复制"气泡，反馈只有按钮上的对勾。
     * 插件的 `title` 是**浏览器原生提示**，原生提示**不随点击消失** → 把 `title` 改成"复制成功"
     * 就会一直挂在那儿。原来 `title` 里的"复制"保持不变：它是**悬停**时的提示，与上游悬停看到的一致。
     */
    button.setAttribute('data-copied', 'true')
    button.setAttribute('aria-label', CODE_COPY_LABELS.copied)
    window.setTimeout(() => {
      button.removeAttribute('data-copied')
      button.setAttribute('aria-label', CODE_COPY_LABELS.copy)
    }, COPIED_MS)
    return true
  }

  if (button.hasAttribute('data-code-wrap-btn')) {
    /*
     * **照上游的可访问名口径**：`aria-pressed` 跟随 `wrapped`，而 `aria-label` **固定**是
     * 「自动换行」——**不随状态**改成"取消自动换行"；变的是 `title`（上游那里是悬停气泡的文案，
     * 它按 `wrapped` 二选一）。
     *
     * 图标不在这里换：四个图标都渲染进了 DOM，由 CSS 按卡片上的 `data-code-wrap` 显隐
     *（上游是按状态二选一渲染，插件用 CSS 达到同一视觉，理由见 `core/code-icons.ts`）。
     */
    const wrapped = block.getAttribute('data-code-wrap') !== 'false'
    const next = !wrapped
    block.setAttribute('data-code-wrap', next ? 'true' : 'false')
    button.setAttribute('aria-pressed', next ? 'true' : 'false')
    button.setAttribute('aria-label', CODE_COPY_LABELS.wrap)
    // `title` 跟随状态（上游是 Tooltip 的文案，按 `wrapped` 二选一）
    button.setAttribute('title', next ? CODE_COPY_LABELS.unwrap : CODE_COPY_LABELS.wrap)
    return true
  }
  return false
}

/**
 * 在容器上安装委托（document 级即可覆盖全部渲染点）。
 * @param container - 委托容器（页面里传 `document`）。
 * @param copy - 写剪贴板的回调。
 * @returns 卸载函数。
 */
export function installCodeToolbarDelegation(container: Document | HTMLElement, copy: (text: string) => void): () => void {
  const onClick = (event: Event): void => {
    handleCodeToolbarClick(event, copy)
  }
  container.addEventListener('click', onClick)
  return () => container.removeEventListener('click', onClick)
}
