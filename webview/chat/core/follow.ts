// 消息列表的**滚动跟随**：粘底跟随 / 读者接管 / 内容长在上方时钉住阅读位置。
//
// 为什么单独成模块：这三条判据是纯状态机（贴底？读者动过？高度变了多少？），
// 但它们必须**在 DOM 更新之后**跑 —— 所以写成可注入布局的模块，脚本级就能覆盖各种时序。
//
// 跟随由两件事保证（缺一就会「滚动条不动」）：
//   ① **事件源**：ResizeObserver 的高度变化（图片加载、工具卡展开这类不引发重渲的变化也能跟）
//      —— 浏览器没有 ResizeObserver 时退化为「每次渲染后由调用方 `settle()`」；
//      ⚠️ **观察对象必须是内容列，不是滚动视口**：视口（`#messages`）的高度由布局定死，
//      内容再长它自己的盒也不变，观察它收不到任何回调（调用方见 `MessageList.followTargets`）；
//   ② **落点**：写 `scrollTop` 要**夹到当前可滚区间**，并在下一帧**复核一次**
//      —— 流式期间一帧里可能连续长高好几次，而写进去的值要等布局完成才生效，
//      单次写会落在旧高度上（表现就是「内容在长、滚动条却停在原处」）。
//
// 弹层列表的「滚进可视区」是另一件事，见同目录 `scroll.ts`。

/**
 * 「读者是否移动了滚动」—— 浏览器把 `scrollTop` 收缩钳制、以及程序性写入，都**不转移滚动归属**：
 * 只有实际位置与「记录位置被钳制后」的值差超过 0.5px 才算读者移动。
 * 少了这一条，内容被整表替换时浏览器夹小 `scrollTop` 会被误判成「用户向上拖」而解除跟随。
 */
export function readerMovedScroll(top: number, floor: number, observedTop: number): boolean {
  return Math.abs(top - Math.min(observedTop, floor)) > 0.5
}

/** 「还算是贴在底部」的容差（px）：超过它就认为读者接管了滚动位置。 */
export const STICK_PX = 12

/** 跟随所需的最小接口：脚本里用假容器整体替换（见 tmp 的跟随用例）。 */
export interface FollowHost {
  /** 已滚到的高度（可写）。 */
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  /**
   * **滚动视口**自身的视口矩形（`rectOf(scroller)`）。
   * 单独给一个入口是因为行不再直接挂在滚动容器下（中间隔着一层内容列），
   * 拿第一行的 `parentElement` 当视口会把「内容列」误当成视口，视口上沿算错、锚行就选错。
   */
  box: () => { top: number; bottom: number }
  /** 行节点（顺序即行序）：只有带 `msg` 类的才是行，其余（「生成中」/pending/「加载更早」）跳过。 */
  rows: () => HTMLElement[]
  /** 任意节点的视口矩形（`box` 与锚行判定都用它）。 */
  rectOf: (node: HTMLElement) => { top: number; bottom: number }
  /** 下一帧（缺省用 rAF；没有 rAF 的环境同步执行）—— 「复核一次」要用它。 */
  nextFrame?: (fn: () => void) => void
}

/**
 * 滚动跟随状态机：`onScroll`（读者/程序性滚动）、`settle`（内容高度变化后）、`toBottom`（显式到底）。
 * 所有写入都记进「观测台账」，因此不会被 `onScroll` 误判成读者移动；写入一律夹到可滚区间。
 */
export class ScrollFollow {
  /** 是否粘在底部：只由**读者手势**与显式的「到底」请求改变。 */
  private stick = true
  /** 最后一次**写入或观测到**的位置：判断「读者是否移动」的基准。 */
  private observedTop = 0
  /** 上一次的内容高度：跟随与「钉住读者位置」都只在它变化时发生。 */
  private lastHeight = 0
  /**
   * 上一次的**视口**高度（`clientHeight`）。
   * 单独记它是因为 `scrollHeight` 会把「内容变多」和「视口变矮」混在一起 ——
   * 两者对滚动位置的影响方向相反（前者要补差值、后者浏览器自己会钳），必须分开判。
   */
  private lastViewport = 0
  /** 非贴底时的**锚**：视口内第一行 + 它当时的视口 top。 */
  private anchor: HTMLElement | null = null
  private anchorTop = 0

  constructor(private readonly host: FollowHost) {
    this.lastHeight = host.scrollHeight
    this.lastViewport = host.clientHeight
  }

  /**
   * 容器刚挂上时的对齐：按**当前**「是否贴底」处理，不无条件到底。
   * （新建的列表容器 `scrollTop` 从 0 开始，此时"贴底"由 `atBottom()` 传入的事实决定。）
   * @param atBottom - 调用方判断的"读者原本就停在底部"（新会话首屏 / 面板重开时通常为真）
   */
  attach(atBottom: boolean): void {
    this.stick = atBottom
    this.lastHeight = this.host.scrollHeight
    this.lastViewport = this.host.clientHeight
    if (atBottom) {
      this.write(this.maxTop())
    } else {
      this.observedTop = this.host.scrollTop
    }
  }

  /** 显式到底（发送、重新生成、恢复会话）：唯一该**强制**滚到底的入口。 */
  toBottom(): void {
    this.write(this.maxTop())
    this.lastHeight = this.host.scrollHeight
    this.lastViewport = this.host.clientHeight
    this.stick = true
    this.anchor = null
  }

  /** 内容高度变化后调用（ResizeObserver 的时机；没有 RO 时由渲染后调用）。 */
  settle(): void {
    const height = this.host.scrollHeight
    const viewport = this.host.clientHeight
    const grew = height - this.lastHeight
    const viewShrank = viewport < this.lastViewport
    this.lastHeight = height
    this.lastViewport = viewport
    if (grew === 0 && !viewShrank) return
    if (this.stick) {
      // 贴底：内容长高、视口变矮**都**要把位置重新钉到新的上限（浏览器自己会钳，钳等于"往上弹"）
      const top = this.maxTop()
      this.write(top)
      // 写进去的值要等布局完成才生效：下一帧复核一次，仍不在底部就再写一次。
      // 流式期间一帧内可能长高多次，只写一次会落在旧高度上（「滚动条不动」就是这个形状）。
      this.host.nextFrame?.(() => {
        if (!this.stick) return
        const target = this.maxTop()
        if (Math.abs(this.host.scrollTop - target) > 1) this.write(target)
      })
      return
    }
    // 非贴底：只有**内容长高**会把视野推走，按锚行补回差值。
    // **视口变矮不算长高**：`scrollHeight` 在「输入区变高（卡片出现）」与「流式内容变多」两种情况下
    // 都会变，只有后者需要补差值；视口变矮时浏览器自己会把 scrollTop 钳住阅读位置，这里什么都不做。
    const anchor = this.anchor
    if (grew > 0 && anchor !== null && anchor.isConnected) {
      const delta = this.host.rectOf(anchor).top - this.anchorTop
      if (Math.abs(delta) > 0.5) this.write(this.host.scrollTop + delta)
    }
  }

  /** 滚动事件：只有**读者真动了**才转移跟随归属；程序性写入与钳制不动归属。 */
  onScroll(): void {
    const floor = this.maxTop()
    if (!readerMovedScroll(this.host.scrollTop, floor, this.observedTop)) {
      // 台账对齐真实位置（浏览器钳制 / 延迟投递），归属不变
      this.observedTop = this.host.scrollTop
      return
    }
    const atBottom = floor - this.host.scrollTop <= STICK_PX
    this.stick = atBottom
    this.observedTop = this.host.scrollTop
    const anchor = atBottom ? null : anchorRowOf(this.host)
    this.anchor = anchor?.node ?? null
    this.anchorTop = anchor?.top ?? 0
  }

  /** 程序性写入：**夹到可滚区间**并记进「观测台账」—— 它不会被当成读者移动。 */
  private write(top: number): void {
    this.host.scrollTop = Math.max(0, Math.min(top, this.maxTop()))
    this.observedTop = this.host.scrollTop
  }

  /** 当前可滚到的最大值（`scrollHeight - clientHeight`，下限 0）。 */
  private maxTop(): number {
    return Math.max(0, this.host.scrollHeight - this.host.clientHeight)
  }

  /** 诊断用：当前是否粘底。 */
  get following(): boolean {
    return this.stick
  }

  /** 诊断用：一次快照（真机排查「为什么没跟随」时打这一行）。 */
  debug(): { stick: boolean; top: number; maxTop: number; height: number; observed: number } {
    return {
      stick: this.stick,
      top: this.host.scrollTop,
      maxTop: this.maxTop(),
      height: this.host.scrollHeight,
      observed: this.observedTop,
    }
  }
}

/**
 * 视口内**顶部那一行**（第一行完整可见的行）：读者位置不稳时把它钉住。
 *
 * 只认带 `msg` 类的行节点（列表里还夹着「生成中」/pending 插话/顶端「加载更早」等非行节点）；
 * 而且**必须取完整可见的行** —— 取一个「顶部已在视口上方」的行，它的 top 会随内容增长越来越负，
 * 补差值就变成了把内容一路往下推（反而制造位移）。
 */
function anchorRowOf(host: FollowHost): { node: HTMLElement; top: number } | null {
  const box = host.box()
  for (const node of host.rows()) {
    if (!node.classList.contains('msg')) continue
    const rect = host.rectOf(node)
    if (rect.bottom <= box.top) continue
    return { node, top: rect.top }
  }
  return null
}
