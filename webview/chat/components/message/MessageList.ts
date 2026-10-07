// 消息列表（按行类型分发）：用户/assistant/审批/提问/notice。智能跟随滚动（判据见 core/follow）。
// 每条行各包一层**行级错误边界**（见 components/RowBoundary）：一行崩了只坏那一行，其余照常。
// 顶端是「加载更早」（历史分页）：只有宿主说「还有更早的」时才出现，加载前钉住阅读位置。
// **聊天区可见性**（对齐上游 0.1.7-alpha.1 起的口径）：系统提示词行与普通上下文注入行不进列表，
// 只有含工具增删块的注入行保留 —— 判据在 `core/chat-visibility.ts`，**在构造渲染列表那一层**过滤。
import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { ScrollFollow, type FollowHost } from '../../core/follow'
import { clearRenderErrors, renderErrors } from '../../core/errors'
import { isVisibleChatRow } from '../../core/chat-visibility'
import { controlRowTargetIndex } from '../../core/control-row-place'
import { anchoredTopAfterPrepend } from '../../../../src/dsh/rows/paging'
import { RowBoundary } from '../RowBoundary'
import { UserRow } from './UserRow'
import { AssistantRow } from './AssistantRow'
import { ApprovalRow } from './ApprovalRow'
import { QuestionRow } from './QuestionRow'
import { NoticeRow } from './NoticeRow'
import { CommandRow } from './CommandRow'
import { CompactionRow } from './CompactionRow'
import { RetryRow } from './RetryRow'
import { TurnNoticeRow } from './TurnNoticeRow'
import { attachTailNotices } from '../../core/tail-notice'
import { ContextInjectionRow } from './ContextInjectionRow'
import { TurnStatus } from './TurnStatus'
import { PendingSteeringList } from './PendingSteeringRow'

/**
 * 跟随要盯住的元素（顺序：内容列在前，滚动视口在后）。
 *
 * **为什么必须盯内容列**：`#messages` 是滚动视口，高度由 flex 布局定死，内容再长它自己的盒也不变
 * —— `ResizeObserver` 只报**被观察元素自己的盒**变化，所以观察它收不到「内容长高」，
 * 流式回答时 `settle()` 一次都不会被调用，滚动条自然停住（这正是「回答时滚动条不跟随」的成因）。
 * 内容列 `.msg-col` 的高度 = 内容高度，观察它才能拿到真正的增长。
 * 视口本身也要看：窄面板/输入区长高会把视口改矮，那时 `maxTop` 跟着变。
 * 上游同款：观察 `.column`（内容列）与 composer 座位，**不观察**滚动容器。
 */
export function followTargets(content: HTMLElement | null, scroller: HTMLElement): HTMLElement[] {
  return content === null ? [scroller] : [content, scroller]
}

/** 把真实的滚动容器接成 `FollowHost`（判据全在 `core/follow`，这里只是取数与写入的适配）。 */
function hostOf(el: HTMLElement, col: HTMLElement | null): FollowHost {
  const rectOf = (node: HTMLElement): { top: number; bottom: number } => {
    const r = node.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom }
  }
  return {
    get scrollTop(): number {
      return el.scrollTop
    },
    set scrollTop(top: number) {
      el.scrollTop = top
    },
    get scrollHeight(): number {
      return el.scrollHeight
    },
    get clientHeight(): number {
      return el.clientHeight
    },
    // 视口 = 滚动容器本身（**不是**行节点的父节点：那一层现在是内容列 `.msg-col`）
    box: () => rectOf(el),
    // 行在内容列里；取不到内容列（理论上不会发生）时退回视口，避免判据整条失效
    // 行节点 = 内容列里的 `.msg`（**不是直接子节点**：每条行外面还有一层 `.turn-anchor`，
    // 它只是 `data-turn` 的载体，见下面渲染处）
    rows: () => Array.from((col ?? el).querySelectorAll<HTMLElement>('.msg')),
    rectOf,
    nextFrame: (fn) => {
      if (typeof requestAnimationFrame === 'undefined') fn()
      else requestAnimationFrame(fn)
    },
  }
}

export function MessageList({ store }: { store: ChatStore }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // 内容列（`#messages` 里那一层）：跟随的观察对象，见 `followTargets`
  const colRef = useRef<HTMLDivElement | null>(null)
  // 跟随状态机：与容器的生命周期一致（判据全在 core/follow，这里只接 DOM 事件）
  const followRef = useRef<ScrollFollow | null>(null)
  // 容器**存在与否**（欢迎页 / 会话被清空时不渲染）决定接线时机。
  // 必须进依赖：空会话时 `#messages` 整体不渲染（下面 `view !== 'chat'` 那条），
  // 若只在挂载时接线一次，第一条消息到达后就再也接不上 —— 跟随与 ResizeObserver 双双永久失效。
  const visible = store.view.value === 'chat'
  // 容器**上一次卸载前**是否停在底部：重挂时按它恢复（新容器 scrollTop 从 0 开始，
  // 无条件到底会让「切会话后原本读历史的位置」被打回底部；无条件保留又会丢掉"一直跟着看"的手感）。
  const wasAtBottom = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const host = hostOf(el, colRef.current)
    const follow = new ScrollFollow(host)
    followRef.current = follow
    follow.attach(wasAtBottom.current)
    // 首帧就把标记打上（否则要等第一次滚动才禁掉自动锚定；`attach` 的语义见 core/follow）
    if (wasAtBottom.current) el.setAttribute('data-dsh-following-tail', '')
    const onScroll = (): void => {
      follow.onScroll()
      wasAtBottom.current = follow.following
      // 上游同款：**跟随尾部时**在滚动体上标出来，CSS 据此 `overflow-anchor: none`
      // —— 否则浏览器自己的滚动锚定会与"重钉到底"互踢，流式期间观感就是滚动条来回抖。
      if (follow.following) el.setAttribute('data-dsh-following-tail', '')
      else el.removeAttribute('data-dsh-following-tail')
      if (typeof window !== 'undefined' && window.__dshFollowDebug) {
        const d = follow.debug()
        console.log(
          `[follow] scroll stick=${String(d.stick)} top=${String(Math.round(d.top))}/${String(Math.round(d.maxTop))} h=${String(Math.round(d.height))}`
        )
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 跟随由**内容高度变化**驱动（而不是「某次渲染」）：流式长高、图片加载、工具卡展开这类
    // 不引发重渲的变化也要能跟。观察对象见 `followTargets`（**内容列是必须的**：视口自己的盒不变）。
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => follow.settle())
    for (const target of followTargets(colRef.current, el)) observer?.observe(target)
    if (typeof window !== 'undefined') {
      window.__dshFollow = follow
      // 排查用：把接线好的 host 也露出来（「观察了谁」「视口取的是谁」都能在控制台直接问）
      window.__dshFollowHost = host
    }
    return () => {
      const d = follow.debug()
      wasAtBottom.current = d.stick
      el.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      followRef.current = null
      if (typeof window !== 'undefined') {
        if (window.__dshFollow === follow) delete window.__dshFollow
        if (window.__dshFollowHost === host) delete window.__dshFollowHost
      }
    }
  }, [visible])

  // 显式的「到底」请求（发送时）：唯一该**强制**滚到底的入口
  useEffect(() => {
    if (ref.current === null || store.scrollPend.value === 0) return
    followRef.current?.toBottom()
    wasAtBottom.current = true
    store.scrollPend.value = 0
  }, [store.scrollPend.value, visible])

  /**
   * 「加载更早」的**位置锚定**（对齐上游 `loadOlderAnchored` 的语义）。
   *
   * 前插会让整个内容往下推，浏览器会保持 `scrollTop`，于是**读者眼前的内容被推走了**。
   * 这里在每次行表重渲前记下「旧高度 − 顶部」，渲染后把同一段距离补回去 —— 读者停在原处。
   */
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const held = anchorRef.current
    anchorRef.current = null
    if (el === null || held === null) return
    // 补回前插的高度差（算准，不试；见 src/dsh/rows/paging.ts）：这一步是「把读者按回原处」，
    // 不改变跟随归属；写完让跟随状态机复核一次真实位置（程序性写入不会被当成读者移动，见 core/follow）。
    const next = anchoredTopAfterPrepend(held, el.scrollHeight, Math.max(0, el.scrollHeight - el.clientHeight))
    if (next === held.top) return
    el.scrollTop = next
    followRef.current?.settle()
  }, [store.messages.value])

  if (!visible) return null
  const rows = store.messages.value
  const hasMore = store.historyHasMore.value
  const loadingOlder = store.historyLoading.value
  const errorCount = renderErrors.value.length
  const loadOlder = (): void => {
    // 进行中就不要再发一次（`disabled` 只挡真实点击：脚本/辅助技术仍可能派发事件，双保险）
    if (loadingOlder) return
    const el = ref.current
    if (el !== null) {
      anchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    }
    store.loadOlder()
  }
  // 终局通知的排序锚点（上游 `turn-max-tokens` 的 `noticeAnchor`）：`warning` 通知归并到回答行内、动作条之前
  const laid = attachTailNotices(rows)
  // **可见性过滤放在这一层**（不是逐行 `return null`）：`latest`（最后一条）与滚动锚点都按
  // **真正显示出来的**行算 —— 否则末尾一条被隐藏的注入行会把 `latest` 顶掉，
  // 动作条的分叉可用性、时间/复制常显判据就全部跟着错（上游也是先过滤可见节点再算这些）。
  const shown = laid.filter(({ row }) => isVisibleChatRow(row))
  // 过程折叠是**回合级**的（见 core/process-fold）：同一回合可能有多条回答行（插话切成「前段 / 后段」），
  // 只有**首行**出折叠头，其余行跟随同一个展开态。这里按回合归组算好，再逐行下发。
  // 没有回合号的（本地乐观行）自成一组：它没有过程事实，本来也不会折叠。
  //
  // ⚠️ **归属（`turnHeadRow`）与行数（`turnRowCount`）都必须按上面**过滤后**的可见行算**
  // —— 上游就是这个次序：`orderedVisibleChatNodes()` 先 `filter(isVisibleChatNode)`，控制节点的
  // presentation 只由**可见**节点派生（`chat-snapshot-builder.ts:496-509`、
  // `turn-process-presentation.ts:52-67`），控制行的落点 = 该回合**最早可见过程锚**
  // （`presentationPosition()`，同文件 :477-484）。若按未过滤的行算：一条「只有不可见注入」的行
  // 会抢走整个回合的控制行归属 —— 真机现象就是那块「已完成 / 已完成分析」的空块。
  const turnHeadRow = new Map<number, Extract<ChatRow, { kind: 'assistant' }>>()
  // 每回合的**回答行数**：`> 1` = 这个回合被插话/中断切成了多段行。
  // 用途是**外层折叠**（⑧）：上游一个回合是一个 seat，外层折叠折的是"整座"；插件把回合切成多条行，
  // 跨行折会藏掉用户当下正在看的那一段 —— 所以行数 > 1 时整支关闭（见 components/chain/plan.ts 的
  // `outerFold` 与 `14` §7）。同样只数**可见**行，原因同上。
  const turnRowCount = new Map<number, number>()
  for (const { row } of shown) {
    if (row.kind !== 'assistant' || row.turn === undefined) continue
    turnRowCount.set(row.turn, (turnRowCount.get(row.turn) ?? 0) + 1)
    if (!turnHeadRow.has(row.turn)) turnHeadRow.set(row.turn, row)
  }
  // ⚠️ **回合级控制行对每个关闭的回合都存在**（哪怕这一轮没产出任何内容 —— 请求期就失败的那种：
  // 宿主只补出一条空容器行，正文与链都空）。可见行里找不到该回合的 assistant 行时，
  // 让该回合**第一条**容器行来承这一格，否则「处理失败」/「已停止」这类文案就没有落点。
  // 有可见行的回合不受影响（上面那轮已经认了首条**可见**行 —— 上游控制节点的位置就是它）。
  for (const { row } of laid) {
    if (row.kind !== 'assistant' || row.turn === undefined) continue
    if (!turnHeadRow.has(row.turn)) turnHeadRow.set(row.turn, row)
  }
  /** 真正要渲染的行：可见行 + 那些"承了本回合控制块"的容器行（其余仍被可见性挡在外面）。 */
  const rendered = laid.filter(({ row }) => isVisibleChatRow(row)
    || (row.kind === 'assistant' && row.turn !== undefined && turnHeadRow.get(row.turn)?.key === row.key))
  /**
   * **控制行的展示位置**：上游是按 `(anchor, rank)` 排的 —— 控制节点贴着该回合的开局人类输入
   *（有输入时 rank 1、没有时贴着最早的过程证据 rank -1），所以网页端「处理失败」排在重试行**之上**。
   * 插件里"只有回合事实"的容器行是补在末尾的，这里按同一规则把它挪过去（**只挪这一条**，别的行顺序不动）。
   */
  const placed = [...rendered]
  for (const entry of rendered) {
    const row = entry.row
    if (row.kind !== 'assistant' || row.turn === undefined || isVisibleChatRow(row)) continue
    if (turnHeadRow.get(row.turn)?.key !== row.key) continue
    const from = placed.indexOf(entry)
    if (from < 0) continue
    const to = controlRowTargetIndex(placed.map((item) => item.row), from, row.turn)
    if (to < from) {
      placed.splice(from, 1)
      placed.splice(to, 0, entry)
    }
  }
  /**
   * **本回合的内容收尾行**（上游 `lastContent(snapshot, turn, true)` 的等价物）：分叉只允许从这里出发。
   *
   * ⚠️ 与 `latest`（**整表**最后一条可见行）**不是一回事**：一条回合**之后**的行（`/plan` 等命令行、
   * 压缩标记）会把整表的 `latest` 顶掉，于是"正常完成的回合"也点不动分叉（真机现象）。
   * 上游的 `hasLaterChatNode` 用 `snapshot.locations.getTurn(turn)` **只在该回合内**找，并跳过
   * `turn-tail` / `turn-process` / `turn-max-tokens` —— 这里照同一口径：按回合分组、跳过终局通知行，
   * 组内**最后一条内容行**（assistant 或 user）才是收尾行；用户后来又说话时收尾落在 user 行上，
   * 那一回合的回答自然不再是收尾（上游同）。
   */
  const turnTailKeys = new Set<number>()
  {
    const lastOfTurn = new Map<number, number>()
    for (const { row } of shown) {
      // 上游 `skipWarning` 跳过 `turn-max-tokens`（插件的等价物是终局通知行）
      if (row.kind === 'turnNotice') continue
      if (row.kind !== 'assistant' && row.kind !== 'user') continue
      const turn = (row as { turn?: unknown }).turn
      if (typeof turn !== 'number') continue
      lastOfTurn.set(turn, row.key)
    }
    for (const key of lastOfTurn.values()) turnTailKeys.add(key)
  }
  // **打开历史失败**（上游 `ChatView` 的 `openState === 'error' && openError` 那条）：排版与
  // 「加载更早」同一处（列表顶端），文案逐字取上游 `chat.loadError`。
  // ⚠️ 可缺省读取：部分守卫/旧桩的 store 里没有这个切片（它较新），缺了就按"没有失败"渲染
  const openError = store.sessionOpenError?.value
  return html`<div id="messages" ref=${ref}>
    <div class="msg-col" ref=${colRef}>
      ${openError === undefined
        ? null
        : html`<div class="open-error" role="alert">
            历史加载失败：${openError.message}${openError.code === undefined ? '' : `（${openError.code}）`}
          </div>`}
      ${hasMore
        ? html`<button class="load-older" type="button" disabled=${loadingOlder} onClick=${loadOlder}>
            ${loadingOlder ? '正在加载更早的历史…' : '加载更早'}
          </button>`
        : null}
      ${placed.map(({ row, tailNotices }, i) => {
        const latest = i === placed.length - 1
        // 每条行各包一层错误边界：`key` 放在边界上（边界自己也是行级 vnode），
        // 内部再按行 key 分层，保证「换行」与「重试换子树」两件事互不干扰。
        const body = (() => {
          switch (row.kind) {
            case 'user':
              return html`<${UserRow} key=${row.key} row=${row} store=${store} latest=${latest} />`
            case 'context':
              // 已被上面的可见性过滤挡掉（到这里只剩含工具增删块的注入行）；类型上仍可能出现，故保留分支
              return html`<${ContextInjectionRow} key=${row.key} row=${row} />`
            case 'sysprompt':
              // **聊天区不显示系统提示词**（上游 0.1.7-alpha.1 起 `isVisibleChatNode` 排除该 kind）。
              // 数据仍在会话日志里、宿主照旧下发，只是不再渲染 —— 这里返回 null 只作防御。
              return null
            case 'assistant': {
              const head = row.turn === undefined ? undefined : turnHeadRow.get(row.turn)
              return html`<${AssistantRow} key=${row.key} row=${row} store=${store} latest=${latest}
                turnTail=${turnTailKeys.has(row.key)}
                ownsHead=${head === undefined || head.key === row.key}
                soleRow=${row.turn === undefined || (turnRowCount.get(row.turn) ?? 1) <= 1}
                tailNotices=${tailNotices} />`
            }
            case 'approval':
              return html`<${ApprovalRow} key=${row.key} row=${row} store=${store} />`
            case 'question':
              return html`<${QuestionRow} key=${row.key} row=${row} store=${store} />`
            case 'notice':
              return html`<${NoticeRow} key=${row.key} row=${row} />`
            case 'turnNotice':
              // 回合终局通知行（上游 `turn-error` / `turn-max-tokens`）：独立行，永远可见（不参与过程折叠）
              return html`<${TurnNoticeRow} key=${row.key} row=${row} />`
            case 'retry':
              // 模型重试链（上游 `model-retry`）：一行一条链，首条 `llm/retry` 的 seq 就是它的位置
              return html`<${RetryRow} key=${row.key} row=${row} />`
            case 'compaction':
              // 自动压缩标记（上游 `compaction`）：只有检查点落地才有这一行，摘要可展开
              return html`<${CompactionRow} key=${row.key} row=${row} />`
            case 'command':
              // 手动命令行（上游 `command`）：`permission` 已在可见性过滤里剔除
              return html`<${CommandRow} key=${row.key} row=${row} />`
          }
        })()
        // `data-turn` 是右侧导轨的跳转锚（上游用 Conversation Context key，效果同）
        const turnAttr = typeof (row as { turn?: unknown }).turn === 'number' ? String((row as { turn: number }).turn) : undefined
        return html`<${RowBoundary} key=${row.key} slot=${`row:${String(row.key)}:${row.kind}`}>
          <div class="turn-anchor" data-turn=${turnAttr}>${body}</div>
        </${RowBoundary}>`
      })}
      ${/* pending 插话气泡：排在**所有行之后、「生成中」状态行之前** —— 上游的次序就是先整张行表、
           再 pending 行、最后才是运行指示，故气泡在状态行之上。反过来放（气泡在状态行下面）会让
           「刚发出去那条」跑到「深度求索中…」底下，与上游位置相反。
           它们还没进日志，没有锚点序号，所以只能落在这里，不能塞进 `messages`。 */ ''}
      <${PendingSteeringList} items=${store.pendingSteering.value} />
      ${store.processing.value ? html`<${TurnStatus} store=${store} />` : null}
      ${errorCount > 0
        ? html`<div class="render-error-bar">
            <span class="codicon codicon-warning" aria-hidden="true"></span>
            <span>有 ${String(errorCount)} 处内容渲染失败（其余照常显示）</span>
            <button class="render-error-retry" type="button" onClick=${() => clearRenderErrors()}>知道了</button>
          </div>`
        : null}
    </div>

  </div>`
}
