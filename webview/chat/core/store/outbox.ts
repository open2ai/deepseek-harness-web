// 发送切片（用户发起的动作）：发送、建议、从此处分叉，以及目录到达后对被挂起「/」行的裁决。
// 这组动作只读写既有切片的信号，不自持状态；依赖由装配层注入。
import type { ChatHost } from '../host'
import { fileLabels } from '../file-labels'
import type { ChatStore } from './types'
import type { ComposerSlice } from './composer'
import type { QuoteDraft } from './types'
import type { CatalogsSlice } from './catalogs'
import type { MessagesSlice } from './messages'

export interface OutboxDeps {
  host: ChatHost
  composer: ComposerSlice
  catalogs: CatalogsSlice
  messages: MessagesSlice
}

export interface OutboxSlice {
  store: Pick<ChatStore, 'send' | 'suggestion' | 'forkAt'>
  /** 目录到达后裁决被挂起的「/」行（由归约器在 slashCatalog 分支调用）。 */
  resolvePendingSlash(): void
}

export function createOutbox(deps: OutboxDeps): OutboxSlice {
  const { host, composer, catalogs, messages } = deps
  const { text, attachments, images, refs, quotes, setText, runSlash } = composer.store
  const { slashCatalog, requestSlashList } = catalogs.store
  const { processing } = messages.store

  /**
   * **把未发送的引用按落点拼进正文**（对齐 web 的编辑器内原子 chip）。
   *
   * 每条引用是一段 `> …` blockquote，插到它点引用时的光标偏移 `at`；同位置时按**点引用的先后**。
   * 插入时与相邻正文之间补**空行**（Markdown 引用块与段落分开），渲染侧按 blockquote 段解析。
   * 为什么倒序插：`at` 都是相对**原正文**的偏移，从后往前插不会让前面的偏移失效。
   * @param quotes - 未发送引用（`text` + `at`）
   * @param body - 输入框正文
   * @returns 拼好的消息正文（无引用时原样返回）
   */
  function composeWithQuotes(quotes: readonly QuoteDraft[], body: string): string {
    if (quotes.length === 0) return body
    const ordered = quotes.map((quote, index) => ({ ...quote, index })).sort((a, b) => a.at - b.at || a.index - b.index)
    let out = body
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const quote = ordered[i]
      if (quote === undefined) continue
      const block = quote.text.split(/\r?\n/u).map((line) => `> ${line}`).join('\n')
      const at = Math.max(0, Math.min(quote.at, out.length))
      const before = out.slice(0, at)
      const after = out.slice(at)
      const pre = before === '' || /\n\n$/u.test(before) ? before : /\n$/u.test(before) ? before + '\n' : before + '\n\n'
      const post = after === '' || /^\n\n/u.test(after) ? after : /^\n/u.test(after) ? '\n' + after : '\n\n' + after
      out = pre + block + post
    }
    return out
  }

  /**
   * 发送（用户发起的动作）。
   *
   * 两条路，按**回合是否在跑**分：
   * - 空闲：提交 + 等这一轮（现有行为），本地面板里立刻出行；
   * - 忙：只提交，消息**不进对话流** —— 它的「发送中…」行由宿主台账（`submissions.pending`）推导，
   *   页面不另登记（上游 `QueueDock.pendingQueue` 同款）。
   *   队列不属于任何回合，所以忙时既不 `addUser`、也不 `beginAssistant`、也不置 `processing`
   *   （那个「处理中」是别人的回合）。
   *
   * @param mode - 忙时的投递方式：queue = 排队（默认），steer = 插话（投到当前回合的下一步）。空闲恒 queue。
   */
  function send(mode: 'queue' | 'steer' = 'queue'): void {
    const msg = text.value.trim()
    const attach = attachments.value
    const imgs = images.value
    if (!msg && attach.length === 0 && imgs.length === 0 && refs.value.length === 0) return
    // 「/」命令路由：纯文本单行、行首 `/` 且首词命中宿主命令目录 → 执行斜杠命令而非发消息。
    // 技能行(/技能名…)不在此列，照常走 chatSend（宿主 pre-step 识别 /技能名 头）。
    const cat = slashCatalog.value
    if (attach.length === 0 && imgs.length === 0 && !msg.includes('\n') && msg.startsWith('/')) {
      const name = msg.slice(1).split(/[\s　]+/)[0].toLowerCase()
      const matched = !!(name && cat && cat.commands.some((c) => c.name.toLowerCase() === name))
      if (matched) {
        setText('')
        host.post({ type: 'slashRun', text: msg })
        return
      }
      if (!cat) {
        // 目录还没拿到(换会话后首条即发 /xxx，或上一次拉取失败)：先挂起、**按需强拉**一次，待目录到达再裁决，
        // 避免把 /compact 之类当普通文本发给 agent。强拉跳过失败后的间隔限制 —— 回车就是「现在就要」。
        catalogs.holdPendingSlash(msg)
        requestSlashList(true)
        return
      }
      // cat 已到但首词未命中(技能/未知斜杠 token)：落回普通发送(技能走 chatSend、未知 token 走消息，与上游一致)
    }
    // 文件走「文件上送」：必须全部就绪才允许发送（canSend 也挡，这里是兜底）
    const notReady = attach.find((a) => a.state !== 'ready')
    if (notReady !== undefined) {
      messages.store.showNotice(fileLabels().stillUploading)
      return
    }
    const files = attach.map((a) => ({ receiptId: a.receiptId as string, name: a.name, path: a.path, ...(a.bytes === undefined ? {} : { bytes: a.bytes }) }))
    const refTokens = refs.value.map((r) => r.token)
    // 选中文本引用（0.2.2 quote）：贴片挂在输入区上方，**发送时才**拼成 Markdown 引用块，
    // 所以输入框里始终是用户自己写的字、贴片可一键清除（上游原子 chip 的等价文本形态）。
    // **按落点拼**：每条引用插到它点引用时的光标位置（`at`），所以能夹在正文中间、后面接着写。
    const composed = composeWithQuotes(quotes.value, msg)
    const prompt = [...refTokens, composed].filter(Boolean).join('\n\n')
    const display = composed
    const refSnap = refs.value.map((r) => ({ kind: r.kind, label: r.label, token: r.token }))
    // 提交标识：由本面板 mint，一路带到 session/prompt 的 requestId；
    // 服务端回显 user/message 时会带回同一个值，据它认领本地这一行（避免出现两行）
    const rpcId = crypto.randomUUID()

    // **每次提交开始时清掉上一条错误条**（对齐上游 `prompt()` 的第一行 `this.promptError = null`：
    // 同步、在第一个 await 之前，排队与插话两条路都清）。放在这里而不是 `addUser` 里，
    // 是因为忙时排队**不走** addUser —— 那种情况下上一条错误会一直挂到下次空闲发送。
    messages.store.promptError.value = undefined

    if (processing.value) {
      // 忙时：消息**不进对话流**（队列不属于任何回合）。**「发送中…」行与插话气泡都由宿主台账
      // （`submissions.pending`）推导** —— 页面不登记第二份行状态（上游 `QueueDock` 同款）。
      // 记下这次发出去的内容：提交失败时按提交标识还原到输入区（上游"草稿留在机器里"同口径）
      composer.rememberSentDraft(rpcId, { text: display, images: imgs, attachments: attach, refs: refSnap })
      attachments.value = []
      images.value = []
      refs.value = []
      composer.clearQuote()
      setText('')
      host.post({ type: 'chatSend', text: prompt, images: imgs, ...(files.length > 0 ? { files } : {}), rpcId, mode })
      return
    }

    // 空闲：用户主动发送时即使滚动条在上面也强制滚到底看新内容（流式中自己翻上去则不受影响）
    messages.bumpScroll()
    // 同上：发出去的内容留一份快照，失败时还原（成功则不会用到）
    composer.rememberSentDraft(rpcId, { text: display, images: imgs, attachments: attach, refs: refSnap })
    messages.addUser(display, imgs, undefined, refSnap.length ? refSnap : undefined, undefined, files.length > 0 ? files : undefined, rpcId)
    attachments.value = []
    images.value = []
    refs.value = []
    composer.clearQuote()
    setText('')
    // 不再建本地占位回答行（那正是「发送后闪一下」的来源）：回答只由宿主事件到达时出现；
    // 「深度求索中」由 processing 信号 + 提交台账 + turnActive 三条腿驱动（整表替换时一并重算）。
    // 「正在发送消息」相位：消息已发出、等 Host 接受；台账出现同 rpcId 或失败即结束（默认 10 秒兜底）。
    messages.markSending(rpcId)
    processing.value = true
    host.post({ type: 'chatSend', text: prompt, images: imgs, ...(files.length > 0 ? { files } : {}), rpcId })
  }

  /** 目录到达后裁决被挂起的「/」行：命中命令→执行；未命中→按普通消息发出(仅当用户没改写输入)。 */
  function resolvePendingSlash(): void {
    const line = catalogs.takePendingSlash()
    if (!line) return
    const cat = slashCatalog.value
    if (!cat) return // 目录仍未拉到(理论上不会)：直接放弃，避免误发
    const name = line.slice(1).split(/[\s　]+/)[0].toLowerCase()
    if (name && cat.commands.some((c) => c.name.toLowerCase() === name)) {
      // 命令：直接执行（runSlash 只在输入仍等于本行时清空，避免盖掉用户新输入）
      runSlash(line)
      return
    }
    // 未命中命令：按普通消息发（技能行 / 未知斜杠 token；用户已改写输入则放弃，交给下一次发送）
    if (text.value === line) {
      setText('')
      messages.addUser(line)
      processing.value = true
      host.post({ type: 'chatSend', text: line })
    }
  }

  function suggestion(p: string): void {
    if (!p || processing.value) return
    messages.bumpScroll()
    messages.addUser(p)
    processing.value = true
    host.post({ type: 'chatSend', text: p })
  }

  /**
   * 从某条回答分叉出新会话（上游 `session/fork`）。这里只上报锚点序号 ——
   * **建子会话、升号、切过去都在宿主**（只有宿主知道当前会话与工作区）。
   */
  function forkAt(seq: number): void {
    host.post({ type: 'chatFork', atSeq: seq })
  }

  return { store: { send, suggestion, forkAt }, resolvePendingSlash }
}
