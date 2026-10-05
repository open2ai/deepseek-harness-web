// 详情卡模型（对齐上游 `details-card-model` / `control-details-model` / `detail-model-shared`）——纯函数。
//
// 把 goal / schedule / 子代理协调类工具的结果（JSON 或固定格式文本）投影成「紧凑详情」；
// 形状不符一律返回 null → ToolRow 回退通用「输入/输出」卡（与上游 `detailsCardModel` 的 null 同义）。
// 文案为上游字典 zh 的原文（本插件无 i18n，直写中文）；todo 卡复用这里的 `DetailItem`/`DetailsModel` 类型
// （见 core/todo-diff.ts）。

// ---- 共享渲染模型（Todo 卡与详情卡共用同一份，渲染体在 components/chain/DetailsCardBody.ts） ----

export type DetailTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export interface DetailBadge {
  label: string
  tone: DetailTone
}

export interface DetailField {
  label: string
  value: string
}

/** 一条已记录的实体 / 回执 / 状态项。 */
export interface DetailItem {
  title?: string
  subtitle?: string
  description?: string
  badge?: DetailBadge
  /** 三态（todo 卡与状态项共用）：completed/in_progress/pending。 */
  status?: { value: 'completed' | 'in_progress' | 'pending'; label: string }
  /** 状态变化前的文案（todo 卡「状态变化」项）。 */
  previousStatus?: string
  /** todo 卡的增/删/改标记。 */
  change?: { value: 'added' | 'removed' | 'updated'; label: string }
  fields: DetailField[]
  lines?: string[]
  /** 结果正文 / 长文本（等宽块）。 */
  code?: { text: string; language?: string }
  /** 可点击打开的文件位置（lsp 命中项）。 */
  location?: { path: string; line?: number }
  /** 命名的子分组（对象/数组字段的投影）。 */
  groups?: Array<{ label: string; items: DetailItem[] }>
}

export interface DetailsModel {
  items: DetailItem[]
  /** 收起行摘要（覆盖通用摘要）。 */
  summary?: string
  /** 展开态头部文案（回执行「状态在体里、头在条上」时用）。 */
  expandedSummary?: string
  /** 空列表文案。 */
  empty?: string
  /** 头部注记（如「与上次清单相比」/「旧清单不可用」/「首次记录」）。 */
  caption?: string
  /** 折叠起来的「未变化」项（todo 卡）。 */
  unchanged?: { label: string; items: DetailItem[] }
}

// ---- 共享判据（镜像上游 detail-model-shared） ----

function detailRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** 整段 JSON 解析（不接受部分前缀）。 */
function detailJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 参数原文 → 对象（坏形返回 null，走通用卡）。 */
function parseArgs(argsRaw?: string): Record<string, unknown> | null {
  if (argsRaw === undefined || argsRaw === '') return null
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return detailRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 参数里的字符串字段（空串按缺省）。 */
function argOf(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

const STATUS_KEYS: Record<string, string> = {
  running: '运行中', idle: '空闲', ready: '就绪',
  inactive: '未运行', provisioning: '准备中',
  failed: '失败', error: '失败',
  completed: '已完成', complete: '已完成', done: '已完成',
  pending: '待处理', in_progress: '进行中',
  deleted: '已删除', killed: '已取消',
  blocked: '受阻', accepted: '已接收', queued: '已入队',
}

/**
 * 状态 → 本地化名 + 静态语义色。未知状态原样回显（不猜）。
 * 上游 `detailBadge`：词汇表外退回原值、tone 按成功/失败/警告/进行中/中性五档。
 */
function detailBadge(status: string): DetailBadge {
  const label = Object.prototype.hasOwnProperty.call(STATUS_KEYS, status) ? STATUS_KEYS[status] as string : status
  const tone: DetailTone =
    status === 'completed' || status === 'complete' || status === 'done' || status === 'accepted' ? 'success'
      : status === 'failed' || status === 'error' ? 'error'
        : status === 'blocked' || status === 'killed' || status === 'pending' || status === 'queued' || status === 'inactive' ? 'warning'
          : status === 'running' || status === 'in_progress' || status === 'provisioning' ? 'info'
            : 'neutral'
  return { label, tone }
}

const FIELD_KEYS: Record<string, string> = {
  id: 'ID', revision: '版本', platform: '平台',
  provider: '提供方', model: '模型', role: '角色',
  context: '上下文', ownerName: '负责人', ready: '可开始',
  blockedBy: '前置任务', writeScopes: '文件范围',
  writeScopeWarnings: '提示', diagnostics: '诊断',
  methods: '方法', inputSchema: '输入 Schema', outputSchema: '输出 Schema',
  currentPackageId: '当前包', nextPackageId: '待运行的包',
  latestRun: '最近运行', packages: '版本包', registrations: '注册项',
  props: '属性', data: '数据', source: '来源',
  arguments: '输入', content: '内容', message: '消息',
  messageId: '消息 ID', status: '状态', root: '根节点',
  pid: '进程 ID', type: '类型', time: '时间',
  seq: '事件序号', turn: '轮次', step: '步骤', callId: '调用 ID',
  agentsStarted: '启动智能体数', output: '输出', result: '结果',
}

/** 已知字段名 → 本地化标签；扩展字段保留原名（上游 detailLabel 同）。 */
function detailLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(FIELD_KEYS, key) ? FIELD_KEYS[key] as string : key
}

function scalar(value: unknown): string {
  if (value === null) return '无'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const INSPECTION_KEY_ORDER = ['subject', 'title', 'name', 'pluginId', 'packageId', 'id', 'summary']
const INSPECTION_DETAIL_KEYS = ['description', 'purpose']
const MAX_INSPECTION_ITEMS = 40

/**
 * 把任意 JSON 投影成可读字段与命名的子分组（镜像上游 `inspectionItems`）。
 * 深度超限转 code 块；对象取首个可读标题键与描述键，其余标量进 fields、对象/数组进 groups。
 */
function inspectionItems(value: unknown, depth = 0): DetailItem[] {
  if (depth > 4 && value !== null && typeof value === 'object') {
    return [{ code: { text: JSON.stringify(value, null, 2), language: 'json' }, fields: [] }]
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_INSPECTION_ITEMS).flatMap((entry) => inspectionItems(entry, depth + 1))
    if (value.length > MAX_INSPECTION_ITEMS) {
      items.push({ description: `另有 ${value.length - MAX_INSPECTION_ITEMS} 项，可在「查看」中读取`, fields: [] })
    }
    return items.length === 0 ? [{ description: '暂无结果', fields: [] }] : items
  }
  if (!detailRecord(value)) return [{ description: scalar(value), fields: [] }]
  const titleKey = INSPECTION_KEY_ORDER.find((key) => nonempty(value[key]))
  const descriptionKey = INSPECTION_DETAIL_KEYS.find((key) => nonempty(value[key]))
  const title = titleKey === undefined ? undefined : String(value[titleKey])
  const fields: DetailField[] = []
  const groups: Array<{ label: string; items: DetailItem[] }> = []
  for (const [key, field] of Object.entries(value)) {
    if (key === titleKey || key === descriptionKey || (key === 'status' && typeof field === 'string')) continue
    if (key === 'inputSchema' || key === 'outputSchema') {
      groups.push({ label: detailLabel(key), items: [{ fields: [], code: { text: JSON.stringify(field, null, 2), language: 'json' } }] })
      continue
    }
    if (Array.isArray(field) && field.length === 0) continue
    if (key === 'arguments' && typeof field === 'string') {
      const args = detailJson(field)
      if (detailRecord(args)) {
        groups.push({ label: detailLabel(key), items: inspectionItems(args, depth + 1) })
        continue
      }
    }
    if (field !== null && typeof field === 'object') {
      groups.push({ label: detailLabel(key), items: inspectionItems(field, depth + 1) })
    } else {
      fields.push({ label: detailLabel(key), value: scalar(field) })
    }
  }
  return [{
    ...(title === undefined && typeof value.status !== 'string' ? {} : { title: title ?? '结果' }),
    ...(descriptionKey === undefined ? {} : { description: String(value[descriptionKey]) }),
    ...(typeof value.status === 'string' ? { badge: detailBadge(value.status) } : {}),
    fields,
    ...(groups.length === 0 ? {} : { groups }),
  }]
}

/** 给结果列表统一的历史注记与空态（镜像上游 `detailList`）。 */
function detailList(items: DetailItem[], summary: string): DetailsModel {
  return { items, summary, caption: '调用结果', empty: '暂无结果' }
}

/** 回执行：单条 title + 状态徽标（镜像上游 `receipt`）。 */
function receipt(title: string, badge: DetailBadge, fields: DetailField[] = [], description?: string): DetailsModel {
  const model = detailList([{ title, badge, fields, ...(description === undefined ? {} : { description }) }], `${title} · ${badge.label}`)
  return { ...model, expandedSummary: title }
}

// ---- goal（create_goal / get_goal / update_goal） ----

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * goal 工具结果 → 详情。结果形状（上游 `GoalToolValue`）：
 * `{ goal: null }` 或 `{ goal: {id,revision,objective,phase,roundsStarted,maxGoalRounds,blockedReason?}, activation }`。
 * 逐字段校验，任何一项不合返回 null（走通用卡）。
 */
function goalDetail(value: unknown): DetailsModel | null {
  if (!detailRecord(value)) return null
  if (value.goal === null) return { items: [], empty: '没有目标' }
  const goal = value.goal
  if (!detailRecord(goal) || !nonempty(goal.id) || !nonempty(goal.objective)
    || !count(goal.revision) || !count(goal.roundsStarted) || !count(goal.maxGoalRounds)) return null
  const phase = goal.phase
  if (phase !== 'active' && phase !== 'paused' && phase !== 'blocked' && phase !== 'complete') return null
  if (value.activation !== 'armed' && value.activation !== 'disarmed') return null
  const phaseLabel =
    phase === 'active' && value.activation === 'disarmed' ? '等待继续'
      : phase === 'active' ? '进行中'
        : phase === 'paused' ? '已暂停'
          : phase === 'blocked' ? '受阻'
            : '已完成'
  const fields: DetailField[] = [
    { label: '状态', value: phaseLabel },
    { label: '执行轮次', value: `${goal.roundsStarted} / ${goal.maxGoalRounds}` },
  ]
  if (goal.blockedReason !== undefined) {
    if (!detailRecord(goal.blockedReason) || !nonempty(goal.blockedReason.code) || !nonempty(goal.blockedReason.message)) return null
    fields.push({ label: '受阻原因', value: goal.blockedReason.message })
  }
  return { items: [{ title: goal.objective, fields }] }
}

// ---- schedule（schedule_create / list / delete / update） ----

/** ISO 周几键（周一起 1..7）。 */
const WEEKDAY_KEYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function interval(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}

/** 去掉墙钟时间的零秒（`12:30:00.000` → `12:30`）。 */
function shortTime(time: string): string {
  return time.replace(/:00\.000$/, '').replace(/\.000$/, '')
}

/** 本地化的周几列表；空集或越界返回 undefined（走通用卡）。 */
function weekdayText(days: unknown): string | undefined {
  if (!Array.isArray(days) || days.length === 0) return undefined
  const labels: string[] = []
  for (const day of days) {
    if (typeof day !== 'number' || !Number.isInteger(day)) return undefined
    const key = WEEKDAY_KEYS[day - 1]
    if (key === undefined) return undefined
    labels.push(key)
  }
  return labels.join('、')
}

/** 计划时间 → 可读本地时间（坏日期回退 ISO 原文）。 */
function formatScheduleDate(scheduledAt: string): string {
  const date = new Date(scheduledAt)
  if (!Number.isFinite(date.getTime())) return scheduledAt
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(date)
  } catch {
    return scheduledAt
  }
}

function scheduleItem(value: unknown): DetailItem | null {
  if (!detailRecord(value) || !nonempty(value.id) || !nonempty(value.prompt)
    || typeof value.scheduledAt !== 'string'
    || (value.deliveryMode !== 'host' && value.deliveryMode !== 'session-local')
    || (value.state !== 'scheduled' && value.state !== 'overdue')) return null
  const date = new Date(value.scheduledAt)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.scheduledAt) return null
  let frequency: string
  switch (value.kind) {
    case 'at': frequency = '单次'; break
    case 'after':
      if (!count(value.afterSeconds) || value.afterSeconds === 0) return null
      frequency = '单次'
      break
    case 'every':
      if (!count(value.everySeconds) || value.everySeconds === 0) return null
      frequency = `每 ${interval(value.everySeconds)}`
      break
    case 'daily':
      if (!nonempty(value.time) || !nonempty(value.timeZone)) return null
      frequency = `每天 ${shortTime(value.time)}（${value.timeZone}）`
      break
    case 'weekly': {
      const days = weekdayText(value.weekdays)
      if (!nonempty(value.time) || !nonempty(value.timeZone) || days === undefined) return null
      frequency = `每周 ${days} ${shortTime(value.time)}（${value.timeZone}）`
      break
    }
    case 'cron':
      if (!nonempty(value.expression) || !nonempty(value.timeZone)) return null
      frequency = `Cron ${value.expression}（${value.timeZone}）`
      break
    default: return null
  }
  return {
    title: nonempty(value.title) ? value.title : value.prompt,
    fields: [
      { label: '计划时间', value: formatScheduleDate(value.scheduledAt) },
      { label: '重复', value: frequency },
      { label: '状态', value: value.state === 'scheduled' ? '等待触发' : '已到期，等待会话恢复' },
    ],
  }
}

function scheduleDetails(name: string, value: unknown): DetailsModel | null {
  if (name === 'schedule_create' || name === 'schedule_update') {
    const item = scheduleItem(value)
    return item === null ? null : { items: [item] }
  }
  if (name === 'schedule_list') {
    if (!Array.isArray(value)) return null
    const items: DetailItem[] = []
    for (const entry of value) {
      const item = scheduleItem(entry)
      if (item === null) return null
      items.push(item)
    }
    return { items, summary: `${items.length} 个定时任务`, empty: '没有定时任务' }
  }
  if (name === 'schedule_delete') {
    if (!detailRecord(value) || !nonempty(value.id) || value.deleted !== true) return null
    return { items: [{ title: value.id, fields: [{ label: '状态', value: '已删除' }] }] }
  }
  return null
}

// ---- 子代理协调 / 后台任务 / lsp（镜像上游 control-details-model） ----

const OUTPUT_TRUNCATED = '\n[output truncated]'

/** list_agents：结果可以是 JSON 数组，或逐行 `id [state] parent=X depth=Y — title` 文本。 */
function agentList(text: string, json: unknown): DetailsModel | null {
  if (Array.isArray(json)) return detailList(inspectionItems(json), `${json.length} 个智能体`)
  if (text === '(no subagents)') return detailList([], '0 个智能体')
  const items: DetailItem[] = []
  for (const line of text.split('\n')) {
    const match = /^(\S+) \[([^\]]+)\](?: parent=(\S+) depth=(\d+))?(?: — (.*))?$/u.exec(line)
    if (match === null) return null
    const id = match[1]
    const state = match[2]
    const parent = match[3]
    const depth = match[4]
    const title = match[5]
    if (id === undefined || state === undefined) return null
    items.push({
      title: title ?? id,
      ...(title === undefined ? {} : { subtitle: id }),
      badge: detailBadge(state),
      fields: parent === undefined ? [] : [
        { label: '父级', value: parent },
        { label: '层级', value: depth ?? '' },
      ],
    })
  }
  return detailList(items, `${items.length} 个智能体`)
}

/** job_list：逐行 `id [kind] state — title` 文本，或空列表固定文案。 */
function jobList(text: string): DetailsModel | null {
  if (text === '(no background jobs)') return detailList([], '0 个后台任务')
  const items: DetailItem[] = []
  for (const line of text.split('\n')) {
    const match = /^(\S+) \[([^\]]+)\] (\S+) — (.*)$/u.exec(line)
    if (match === null) return null
    const id = match[1]
    const kind = match[2]
    const state = match[3]
    const title = match[4]
    if (id === undefined || kind === undefined || state === undefined || title === undefined) return null
    items.push({ title, subtitle: id, badge: detailBadge(state), fields: [{ label: '类型', value: kind }] })
  }
  return detailList(items, `${items.length} 个后台任务`)
}

/** lsp：hover 回 markdown 文本；其余按 `path:line:col` 行解析成可打开位置。 */
function lspDetails(args: Record<string, unknown>, text: string): DetailsModel | null {
  const file = argOf(args, 'file_path')
  const operation = argOf(args, 'operation')
  if (file === '' || typeof args.line !== 'number' || typeof args.character !== 'number') return null
  const source = `${file}:${args.line}:${args.character}`
  if (operation === 'hover') {
    return detailList([{ title: source, location: { path: file, line: args.line }, code: { text }, fields: [] }], source)
  }
  if (text === 'No results.') return detailList([], '0 个位置')
  const items: DetailItem[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('… ')) {
      items.push({ description: line, fields: [] })
      continue
    }
    const match = /^(.*):(\d+):(\d+)$/u.exec(line)
    if (match === null) return null
    const path = match[1]
    const row = match[2]
    const column = match[3]
    if (path === undefined || row === undefined || column === undefined) return null
    const isUri = /^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)
    items.push({
      title: path,
      subtitle: `第 ${row} 行，第 ${column} 列`,
      fields: [],
      ...(isUri ? {} : { location: { path, line: Number(row) } }),
    })
  }
  const hit = items.filter((item) => item.title !== undefined).length
  return detailList(items, `${file} · ${hit} 个位置`)
}

/**
 * 子代理协调 / 后台任务 / lsp 的实体列表与回执（镜像上游 `controlDetails`）。
 * 输出格式认不出即 null；只覆盖本插件带专属标题的那几类工具。
 */
function controlDetails(name: string, args: Record<string, unknown>, text: string, json: unknown): DetailsModel | null {
  const target = argOf(args, 'target') || argOf(args, 'agent_id') || argOf(args, 'sessionId') || argOf(args, 'job_id')
  switch (name) {
    case 'list_agents': return agentList(text, json)
    case 'job_list': return jobList(text)
    case 'lsp': return lspDetails(args, text)
    case 'spawn_teammate': {
      if (!detailRecord(json) || !detailRecord(json.member)) return null
      return detailList(inspectionItems(json.member), argOf(args, 'name'))
    }
    case 'send_message': {
      const status = detailRecord(json) ? json.status : undefined
      if (status === 'accepted' || status === 'queued') {
        return receipt(target, {
          label: status === 'queued' ? '已入队' : '消息已送达',
          tone: status === 'queued' ? 'warning' : 'success',
        }, [], argOf(args, 'message'))
      }
      return text === `message delivered to agent ${target}`
        ? receipt(target, { label: '消息已送达', tone: 'success' }, [], argOf(args, 'message'))
        : null
    }
    case 'interrupt_agent': {
      if (detailRecord(json) && typeof json.previousStatus === 'string') {
        return receipt(target, { label: '已请求中断', tone: 'warning' }, [{ label: '中断前状态', value: detailBadge(json.previousStatus).label }])
      }
      return text === `interrupt requested for agent ${target}`
        ? receipt(target, { label: '已请求中断', tone: 'warning' })
        : null
    }
    case 'wait_agent': {
      if (!detailRecord(json) || typeof json.timedOut !== 'boolean') return null
      if (detailRecord(json.noProgress) && typeof json.noProgress.message === 'string') {
        return detailList([{ title: '没有正在运行的子智能体', description: json.noProgress.message, fields: [] }], '没有正在运行的子智能体')
      }
      return receipt('子智能体状态', { label: json.timedOut ? '等待超时' : '检测到变化', tone: 'neutral' })
    }
    case 'subagent': {
      const started = /^started (background subagent job|subagent) (\S+)$/u.exec(text)
      if (started !== null) {
        const job = started[1] === 'subagent'
        return receipt(argOf(args, 'prompt'), { label: '已启动', tone: 'info' }, [{ label: job ? '智能体 ID' : '任务 ID', value: started[2] ?? '' }])
      }
      return detailList([{ title: '智能体回复', code: { text }, fields: [], groups: [{ label: '任务内容', items: [{ description: argOf(args, 'prompt'), fields: [] }] }] }], '智能体回复')
    }
    case 'job_output': {
      const match = /\n\[status: ([^,\]\n]+)(?:, ([^\]\n]+))?\]$/u.exec(text)
      if (match === null || match[1] === undefined) return null
      const output = text.slice(0, match.index)
      const truncated = output.endsWith(OUTPUT_TRUNCATED)
      const code = truncated ? output.slice(0, -OUTPUT_TRUNCATED.length) : output
      const description = [match[2], truncated ? '输出已截断' : undefined]
        .filter((value): value is string => value !== undefined).join(' · ')
      return {
        ...detailList([{ title: target, badge: detailBadge(match[1]), fields: [], ...(description === '' ? {} : { description }), code: { text: code } }], `${target} · ${detailBadge(match[1]).label}`),
        expandedSummary: target,
      }
    }
    case 'job_kill': {
      if (text === `requested cancellation of job ${target}`) return receipt(target, { label: '已请求取消', tone: 'warning' }, [], argOf(args, 'reason'))
      if (text.startsWith(`job ${target} had already finished `)) return receipt(target, { label: '任务已结束', tone: 'neutral' })
      return null
    }
    default: return null
  }
}

/** 详情卡覆盖的工具名（上游 `details-row` 注册的、本插件带专属标题的那几类）。 */
const DETAILS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'create_goal', 'get_goal', 'update_goal',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  'subagent', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent', 'spawn_teammate',
  'job_list', 'job_output', 'job_kill', 'lsp',
])

/**
 * 详情卡入口（镜像上游 `detailsCardModel`）：只在 **ok** 终态出卡；
 * 先试「实体列表/回执」、再按 JSON 试 goal / schedule。形状不符即 null（回退通用卡）。
 *
 * ⚠️ 先按工具名拦一道：详情卡在 ToolRow 里对**每个工具**求值，而 `detailJson` 要对结果文本整体
 * `JSON.parse` —— 对读文件等大输出做这一步是纯浪费（上游只对注册过的工具名跑这个模型）。
 */
export function detailsCardModel(
  item: { name: string; argsRaw?: string; output?: string; status: string },
): DetailsModel | null {
  if (item.status !== 'ok' || !DETAILS_TOOL_NAMES.has(item.name)) return null
  const name = item.name
  const args = parseArgs(item.argsRaw)
  if (args === null) return null
  const text = item.output ?? ''
  const value = detailJson(text)
  const control = controlDetails(name, args, text, value)
  if (control !== null) return control
  if (value === undefined) return null
  switch (name) {
    case 'create_goal':
    case 'get_goal':
    case 'update_goal': return goalDetail(value)
    case 'schedule_create':
    case 'schedule_update':
    case 'schedule_list':
    case 'schedule_delete': return scheduleDetails(name, value)
    default: return null
  }
}
