// 目录切片：「/」命令与技能目录、「@」文件与会话候选的拉取与到达。
// 三个飞行/挂起私有用方法封装，不向聚合层暴露裸变量。
// 注意：目录到达后对挂起「/」行的裁决（resolvePendingSlash）跨 composer 与消息域，留在聚合层。
//
// 「/」目录按**状态机**管（镜像上游 `CommandDirectory` 的 cold/pending/ready/failed）：
//   cold   还没有过任何快照；
//   pending 一次拉取在飞（后来的请求**并入**它，不再另发）；
//   ready  有一份可用快照（**失败的重拉不会把它降级**——旧目录继续照用）；
//   failed 最近一次没拉到（目录保持 null 或沿用旧值），**下次需要时再拉**（按需强拉，见 requestSlashList 的 force）。
// 为什么要有 failed：拉取失败 ≠ 这个会话没有命令。两者混在一起（都表现为空目录）会让「/」菜单只剩客户端
// 贡献项，而且一旦判成「空」，代码里「只在没有目录时才请求」的条件就再也不成立了 —— 一次失败永久废掉菜单。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { SlashCommandInfo, SlashSkillInfo, AtFileRef, AtSessionRef } from '../protocol'
import type { ChatStore } from './types'

/** 「/」目录的状态（上游 `CommandDirectory` 的四个状态）。 */
export type SlashDirectoryState = 'cold' | 'pending' | 'ready' | 'failed'

/** 失败后**自动**重试的最小间隔（按需强拉不受它限制）：菜单会一直空着，允许再试，但别每次击键都打 RPC。 */
const SLASH_RETRY_MS = 3000

export interface CatalogsSlice {
  store: Pick<ChatStore, 'slashCatalog' | 'atCatalog' | 'requestSlashList' | 'requestAtList' | 'needsSlashList'>
  /** slashCatalog 帧到达：落库并解除飞行标记（裁决由聚合层随后调用）。 */
  receiveSlashCatalog(commands: SlashCommandInfo[] | undefined, skills: SlashSkillInfo[] | undefined): void
  /** atCatalog 帧到达：落库；期间查询串前进则丢弃本份并用最新串补发。 */
  receiveAtCatalog(query: string, files: AtFileRef[] | undefined, sessions: AtSessionRef[] | undefined): void
  /** 目录状态（排查用；不对外提示）。 */
  slashState(): SlashDirectoryState
  /** 会话建立/切换后是否需要预取「/」目录。 */
  needsSlashList(): boolean
  /** 目录未到时用户已回车：先挂起该「/」行。 */
  holdPendingSlash(line: string): void
  /** 取出并清空挂起的「/」行。 */
  takePendingSlash(): string | null
  reset(): void
}

export function createCatalogs(host: ChatHost): CatalogsSlice {
  const slashCatalog = signal<{ commands: SlashCommandInfo[]; skills: SlashSkillInfo[] } | null>(null)
  const atCatalog = signal<{ query: string; files: AtFileRef[]; sessions: AtSessionRef[] } | null>(null)
  let slashState: SlashDirectoryState = 'cold'
  /** 上次**发起**「/」目录拉取的时刻：失败后的自动重试节流基准（避免每次击键都打一次 RPC）。 */
  let slashListAt = 0
  // 「@」候选拉取：单飞行 + 最新查询 wins（输入中不断打 @ 只保留最后查询）
  let atInflight = false
  let atPendingQuery: string | null = null
  /** 目录未到时用户已按 Enter 的「/」行：先存下，待 slashCatalog 到达再裁决(命令→执行/其余→普通消息) */
  let pendingSlash: string | null = null

  /**
   * 行首 `/` 菜单需要目录时调用；宿主异步回 slashCatalog。
   *
   * @param force - true = **按需强拉**（上游 `require`/`warm`）：跳过失败后的间隔限制。
   *   用户回车要裁决 `/xxx` 时用它，别让一次失败把这条命令卡到下个节流窗口。
   */
  function requestSlashList(force = false): void {
    if (slashState === 'pending') return // 在飞：并入它（上游 pending 合流）
    if (!force) {
      if (slashState === 'ready') return // 已有可用快照：不重复拉（软失效由 reset/换会话触发）
      if (Date.now() - slashListAt < SLASH_RETRY_MS) return
    }
    slashListAt = Date.now()
    slashState = 'pending'
    host.post({ type: 'slashListReq' })
  }
  /** 「@」按查询串请求候选；最新查询 wins（输入过程只保留最后串，落后响应到达后自动补发）。 */
  function requestAtList(query: string): void {
    atPendingQuery = query
    if (atInflight) return
    // 已持有同一查询的候选且无待发请求 → 跳过（光标/输入抖动去重）
    if (atCatalog.value && atCatalog.value.query === query) return
    atInflight = true
    host.post({ type: 'atListReq', query })
  }

  /**
   * slashCatalog 帧到达。
   *
   * 两侧都缺 = 本次拉取**失败**：状态记 `failed`（于是下次需要时还会再拉），**目录保留原值** ——
   * 这里与上游有意不同：上游失败会把 `commands` 清空（它的会话一直活着，几乎不会失败），
   * 而我们逐 RPC resume，失败是常态；把上一份好目录清掉只会让菜单凭空变空。因此：旧目录继续照用，
   * 只把状态标成 `failed`，等下次需要（输入 `/`、或回车强拉）再刷新。
   * 只有一侧缺时，缺的那侧沿用原值（另一侧正常更新）。
   */
  function receiveSlashCatalog(commands: SlashCommandInfo[] | undefined, skills: SlashSkillInfo[] | undefined): void {
    if (commands === undefined && skills === undefined) {
      slashState = 'failed'
      return
    }
    const prev = slashCatalog.value
    slashCatalog.value = {
      commands: commands ?? prev?.commands ?? [],
      skills: skills ?? prev?.skills ?? [],
    }
    slashState = 'ready'
  }

  function receiveAtCatalog(query: string, files: AtFileRef[] | undefined, sessions: AtSessionRef[] | undefined): void {
    atInflight = false
    if (atPendingQuery !== null) {
      const q = atPendingQuery
      if (q === query) {
        // 响应匹配最新查询：落库
        atCatalog.value = { query, files: files ?? [], sessions: sessions ?? [] }
        atPendingQuery = null
      } else {
        // 期间查询串又前进：用最新串继续拉(丢弃这份落后响应)
        atPendingQuery = null
        requestAtList(q)
      }
    }
  }

  /**
   * 是否需要拉「/」目录：**手头没有可用快照且没有在飞的**（cold/failed）。
   *
   * 注意「ready + 空」不算需要：那是服务端明确回答「这个会话没有命令/技能」，再拉也没用（与上游 ready 之后的行为同）。
   */
  function needsSlashList(): boolean {
    return slashState === 'cold' || slashState === 'failed'
  }

  function holdPendingSlash(line: string): void {
    pendingSlash = line
  }
  function takePendingSlash(): string | null {
    const line = pendingSlash
    pendingSlash = null
    return line
  }

  function reset(): void {
    // 新会话后 slash 目录需重新拉取(会话内命令/技能可能不同)
    slashCatalog.value = null
    atCatalog.value = null
    slashState = 'cold'
    // 节流基准一起归零：换会话后的预取不该被上一个会话的失败节流挡住
    slashListAt = 0
    atInflight = false
    atPendingQuery = null
    pendingSlash = null
  }

  return {
    store: { slashCatalog, atCatalog, requestSlashList, requestAtList, needsSlashList },
    receiveSlashCatalog,
    receiveAtCatalog,
    slashState: () => slashState,
    needsSlashList,
    holdPendingSlash,
    takePendingSlash,
    reset,
  }
}
