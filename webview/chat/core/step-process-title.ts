// 折叠头（过程分组标题）的**文案与呈现** —— 独立纯函数文件：标题、实时细节、活动图标都在这里。
//
// 标题口径：**按类别、不带计数**。取该区间前三类活动的本地化名称；两类走「A并B」（两类共享前缀
// 「已」时第二项去掉该前缀）、三类以上用「，」连接、超过三类末尾加「等」、一类直接用它、
// **没有工具调用** → 「已完成分析」。排序 = 类别**去重调用数降序**、同数按首次出现。
// 类别归属见 `activityOfToolName()`（14 类，认不出的落 `tools`）。
//
// 进行中另有两条：标题换成进行时文案（「正在读取文件」等，没有运行中的工具 → 「正在分析请求」），
// 以及可选的「 · 实时细节」（`liveProcessDetailOf`）；左侧图标按类别换（`activityIcon`/`headActivity`）。
//
// 易错点：`liveProcessDetail`（实时细节的门）与**思考行预览**不是一回事 —— 后者的门是
// `running || settledReasoningPreview`，写在 `Chain.ts` 里。两处曾接反过一次。
import { deriveToolSummary } from './format'

/** 上游 `ProcessActivity` 的全部取值（tools 是兜底类）。 */
export type ProcessActivity =
  | 'thinking'
  | 'read'
  | 'readImage'
  | 'search'
  | 'write'
  | 'edit'
  | 'commands'
  | 'code'
  | 'webSearch'
  | 'webFetch'
  | 'subagents'
  | 'plan'
  | 'questions'
  | 'tools'

/**
 * 工具名 → 活动类别（逐条镜像上游 `activity(name)`）。
 * @param name - 工具名（`tool/call` 的 name）。
 */
export function activityOfToolName(name: string): ProcessActivity {
  if (name === 'read') return 'read'
  if (name === 'read_image') return 'readImage'
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) return 'commands'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || name.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  return 'tools'
}

/** 折叠头只关心「工具项」这两件事（避免把整个行模型引进来）。 */
export interface ActivityItemLike {
  kind: string
  key?: number
  callId?: string
  name?: string
  status?: string
  /** 工具参数原文（**实时细节**要从这里取，见 `liveProcessDetailOf`） */
  argsRaw?: string
  /** 思考正文（没有运行中的工具时，实时细节取它最后一段） */
  text?: string
}

const DONE_LABELS: Readonly<Record<ProcessActivity, string>> = {
  thinking: '已完成分析',
  read: '已读取文件',
  readImage: '已读取图片',
  write: '已写入文件',
  search: '已搜索代码',
  edit: '修改了文件',
  commands: '执行了命令',
  code: '运行了代码',
  webSearch: '已搜索网页',
  webFetch: '已访问网页',
  subagents: '已协调子智能体',
  plan: '更新了计划',
  questions: '向用户提出了问题',
  tools: '已调用工具',
}

const LIVE_LABELS: Readonly<Record<ProcessActivity, string>> = {
  thinking: '正在分析请求',
  read: '正在读取文件',
  readImage: '正在读取图片',
  write: '正在写入文件',
  search: '正在搜索代码',
  edit: '正在编辑文件',
  commands: '正在运行命令',
  code: '正在运行代码',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  subagents: '正在协调子智能体',
  plan: '正在更新计划',
  questions: '等待你的操作',
  tools: '正在调用工具',
}

/**
 * 按类别去重计数并排序（上游 `processActivity` 的 `counts`）。
 * @param chain - 过程链（只统计 `kind === 'tool'` 的项；重复 `callId`/`key` 只算一次）。
 * @returns 排名后的类别数组（调用数降序、同数按首次出现）。
 */
export function rankActivities(chain: readonly ActivityItemLike[]): ProcessActivity[] {
  const seen = new Set<string>()
  const counts = new Map<ProcessActivity, number>()
  for (const [index, item] of chain.entries()) {
    if (item.kind !== 'tool' || typeof item.name !== 'string') continue
    const identity = item.callId ?? (item.key === undefined ? `#${String(index)}` : `#${String(item.key)}`)
    if (seen.has(identity)) continue
    seen.add(identity)
    const kind = activityOfToolName(item.name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([kind, count], index) => ({ kind, count, index }))
    .sort((left, right) => (right.count - left.count) || (left.index - right.index))
    .map((entry) => entry.kind)
}

/** 上游 `continuation()`：英文类文案去前缀后小写首字母；中文无变化（保留以求逐字同构）。 */
function continuation(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1)
}

/**
 * 已关闭回合的分组标题（上游 `processTitle()`）。
 * @param chain - 过程链。
 * @returns 形如 `已读取文件并读取图片` / `已读取文件，修改了文件，执行了命令` / `已完成分析`。
 */
export function closedProcessTitle(chain: readonly ActivityItemLike[]): string {
  const ranked = rankActivities(chain)
  const labels = ranked.slice(0, 3).map((kind) => DONE_LABELS[kind])
  const first = labels[0]
  if (first === undefined) return DONE_LABELS.thinking
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    // 上游 `message.stepProcess.sharedPrefix`（zh = 「已」，en = 空串）；这里保留「可能为空」的判据以求逐字同构。
    const prefix: string = '已'
    const shared = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix)
    return `${first}并${continuation(shared ? second.slice(prefix.length) : second)}`
  }
  const title = [first, ...labels.slice(1).map(continuation)].join('，')
  return ranked.length > 3 ? `${title}等` : title
}

/**
 * **准备中**的进行时文案（上游 `message.stepProcess.prepare.<activity>`）。
 *
 * `thinking` 没有对应文案：上游把 `thinking` **重映射成 `tools`**（准备中的兜底类是「准备调用工具」）。
 */
const PREPARE_LABELS: Readonly<Record<Exclude<ProcessActivity, 'thinking'>, string>> = {
  read: '准备读取文件',
  readImage: '准备读取图片',
  write: '准备写入文件',
  search: '准备搜索代码',
  edit: '准备编辑文件',
  commands: '准备运行命令',
  code: '准备运行代码',
  webSearch: '准备搜索网页',
  webFetch: '准备访问网页',
  subagents: '准备协调子智能体',
  plan: '准备更新计划',
  questions: '准备提问',
  tools: '准备调用工具',
}

/**
 * 准备中的进行时文案（`thinking` 按上游重映射成 `tools`）。
 * @param activity - 活动类别。
 */
export function prepareLabel(activity: ProcessActivity): string {
  return PREPARE_LABELS[activity === 'thinking' ? 'tools' : activity]
}

/** 最新一个**进行中或准备中**的工具调用（上游按 `time` 取最新的那个运行中调用）。 */
function lastLiveTool(
  chain: readonly ActivityItemLike[]
): { name: string; status: string; argsRaw?: string } | undefined {
  let found: { name: string; status: string; argsRaw?: string } | undefined
  for (const item of chain) {
    const status = item.status
    if (
      item.kind === 'tool' &&
      typeof item.name === 'string' &&
      (status === 'running' || status === 'preparing')
    ) {
      found = { name: item.name, status, argsRaw: item.argsRaw }
    }
  }
  return found
}

/**
 * 运行中回合的分组标题（上游 `ProcessGroupHeader` 未关闭分支的 `message.stepProcess.*`）。
 *
 * **准备中**走 `prepare.*` 那套（上游 `live.preparing` 分支）；没有运行中的工具 → 「正在分析请求」。
 * @param chain - 过程链。
 */
export function liveProcessTitle(chain: readonly ActivityItemLike[]): string {
  const live = lastLiveTool(chain)
  if (live === undefined) {
    return LIVE_LABELS.thinking
  }
  const activity = activityOfToolName(live.name)
  return live.status === 'preparing' ? prepareLabel(activity) : LIVE_LABELS[activity]
}

/** 上游对实时细节的长度上限（按字素计；这里按码元近似，够用且不会撑爆一行）。 */
const LIVE_DETAIL_MAX_CHARS = 160

/** 折成单行 + 截断（上游 `normalizeLiveToolDetail` 同口径：空白折叠、超长补省略号）。 */
function normalizeLiveDetail(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= LIVE_DETAIL_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, LIVE_DETAIL_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * 运行中分组头里那截**实时细节**（上游 `live.detail`，仅在 `liveProcessDetail` 为真时显示）。
 *
 * 上游的取法：**最新一个运行中的工具**的参数细节（按固定键序取第一个有值的：
 * title/description/objective/task/…/command/url/file_path/…），没有运行中的工具时退回
 * **运行中那一步的思考**的最后一段（`**` 剥掉）。两者都折成单行、上限 160 字。
 *
 * 插件复用既有的展示派生（`deriveToolSummary` —— 与工具行摘要同一份实现）而不再来一套键序；
 * 摘要取不到时退回工具名（上游同样会退回 `name`）。
 * @param chain - 过程链。
 * @returns 单行细节；没有可说的返回空串。
 */
export function liveProcessDetailOf(chain: readonly ActivityItemLike[]): string {
  const live = lastLiveTool(chain)
  if (live !== undefined) {
    // **准备中**：上游只在兜底类（`tools`）才把工具名当细节，其余类别留空（参数还没到，没什么可说的）
    if (live.status === 'preparing') {
      return activityOfToolName(live.name) === 'tools' ? normalizeLiveDetail(live.name) : ''
    }
    const summary = normalizeLiveDetail(deriveToolSummary(live.argsRaw, live.name))
    return summary !== '' ? summary : normalizeLiveDetail(live.name)
  }
  // 没有运行中的工具 → 取最后一条思考的**最后一段**（上游 `liveReasoningDetail` 同口径）
  for (let i = chain.length - 1; i >= 0; i--) {
    const item = chain[i]
    if (item?.kind !== 'reasoning' || typeof item.text !== 'string') continue
    const paragraphs = item.text.split(/\r?\n[\t ]*\r?\n/)
    for (let p = paragraphs.length - 1; p >= 0; p--) {
      const detail = normalizeLiveDetail(String(paragraphs[p] ?? '').replaceAll('**', ''))
      if (detail !== '') return detail
    }
  }
  return ''
}

/** 上游 `PROCESS_TITLE_MINIMUM_MS`：一条进行中的标题**至少显示**这么久，才允许换成下一条。 */
export const PROCESS_TITLE_MINIMUM_MS = 150

/**
 * 进行中标题的**稳定延迟**判据（上游 `useStableLiveProcessTitle` 的纯部分）。
 *
 * 上游：新标题与当前显示的不同时，若当前这条显示还不足 150ms，就**等满**再换（工具频繁切换时标题不闪）；
 * 已经显示够了就立刻换。未关闭（进行中）才稳定；已关闭直接跟随最新值（不等待）。
 * @param shownAtMs - 当前显示的这条是**什么时候**提交的（毫秒时间戳）。
 * @param nowMs - 现在（毫秒时间戳）。
 * @param changed - 期望值与当前显示的是否不同。
 * @returns 还需等待的毫秒数；`0` = 立即提交。
 */
export function titleHoldMs(shownAtMs: number, nowMs: number, changed: boolean): number {
  if (!changed) return 0
  return Math.max(0, PROCESS_TITLE_MINIMUM_MS - (nowMs - shownAtMs))
}

/**
 * 分组头该用哪枚图标：进行中取「正在跑的那个工具」的类别；已关闭取**排名第一**的类别
 * （上游 `data.closed ? summary.counts[0]?.kind ?? 'thinking' : live.activity`）。
 * 图形本身（内联 SVG）在 `components/chain/ProcessIcons.ts`，本文件只管**选哪一类**。
 * @param chain - 过程链。
 * @param done - 该回合是否已定稿。
 */
export function headActivity(chain: readonly ActivityItemLike[], done: boolean): ProcessActivity {
  if (!done) {
    const live = lastLiveTool(chain)
    return live === undefined ? 'thinking' : activityOfToolName(live.name)
  }
  return rankActivities(chain)[0] ?? 'thinking'
}
