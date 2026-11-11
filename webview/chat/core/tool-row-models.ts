// **Office 行与 apply_patch 文件行的纯模型**（页面侧，零运行时依赖）。
//
// 为什么要单独一层：这两类行的「摘要取什么、哪个路径可点」都不走通用摘要键，
// 而是各自有上游口径（Office 取输入路径 + 目标格式；补丁按文件头列文件、移动写 `源 → 目标`）。
// 抽成纯函数便于直接用边界输入核对，也避免摘要与路径各算一遍导致两处漂开。

/** Office 工具名（三种原生 Office 工具）。 */
export const OFFICE_TOOL_NAMES: ReadonlySet<string> = new Set(['office_render', 'office_convert', 'office_recalculate'])

/** 是否 Office 原生工具。 */
export function isOfficeTool(name: string): boolean {
    return OFFICE_TOOL_NAMES.has(name)
}

/** Office 行的摘要与可打开路径。 */
export interface OfficeRowModel {
    /** 输入路径（相对工作区），转换/重算类在已知目标格式时缀 `→ 格式`。 */
    summary: string
    /** 可打开的输入路径：结果里记录了绝对路径就用它，否则用绝对形态的参数输入。 */
    filePath: string | undefined
}

interface ParsedArgs {
    [key: string]: unknown
}

function parseArgsObject(argsRaw: string | undefined): ParsedArgs | null {
    if (argsRaw === undefined || argsRaw === '') return null
    try {
        const parsed: unknown = JSON.parse(argsRaw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ParsedArgs) : null
    } catch {
        return null
    }
}

/**
 * 推导 Office 行。
 *
 * 与上游同一口径：
 * - 摘要 = 输入路径（相对工作区）；`office_render` 不带格式，其余在参数给了 `format` 时缀 `→ 格式`；
 * - 可打开路径 = 结果记录的绝对路径，否则参数输入本身是绝对路径时用它（相对路径在运行中打不开，
 *   要等结果把目标点明）。
 * @param name - 工具名（三个 Office 工具之一）。
 * @param argsRaw - 原始参数串。
 * @param cwd - 会话工作区根，用于把输入路径缩成相对路径。
 * @param recordedPath - 结果元数据记录的绝对输入路径（可缺）。
 * @returns 摘要与可打开路径。
 */
export function officeRowModelOf(name: string, argsRaw: string | undefined, cwd: string | undefined, recordedPath?: string): OfficeRowModel {
    const args = parseArgsObject(argsRaw)
    const input = args === null ? undefined : typeof args['input'] === 'string' && args['input'] !== '' ? args['input'] : undefined
    const format = args === null ? undefined : typeof args['format'] === 'string' && args['format'] !== '' ? args['format'] : undefined
    const short = (path: string): string => relativize(path, cwd)
    const withFormat = name !== 'office_render' && format !== undefined
    const summary = input === undefined ? '' : withFormat ? `${short(input)} → ${format}` : short(input)
    const filePath = recordedPath ?? (input !== undefined && isAbsolutePath(input) ? input : undefined)
    return { summary, filePath }
}

/** apply_patch 行里一个文件的展示与打开目标。 */
export interface PatchTarget {
    /** 展示路径；移动的文件展示目标路径。 */
    readonly label: string
    /** 移动类文件的源路径（展示为 `源 → 目标`）。 */
    readonly from?: string
    /** 可打开路径；删除类没有可打开目标。 */
    readonly filePath?: string
}

/**
 * 从补丁文本的文件头解析文件清单。
 *
 * 只认文件头（`*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:`），
 * 不解析 hunk —— 行摘要只需要文件清单。补丁不完整/坏形时返回空数组（摘要留空，不猜）。
 * @param input - 补丁原文（参数 `input`）。
 * @returns 按文件头顺序排列的清单。
 */
export function parsePatchTargets(input: string | undefined): readonly PatchTarget[] {
    if (input === undefined || input === '') return []
    const targets: PatchTarget[] = []
    let pending: string | null = null
    for (const rawLine of input.split(/\r?\n/)) {
        const line = rawLine.trimEnd()
        const add = /^\*\*\* Add File: (.+)$/.exec(line)
        if (add !== null) {
            const path = add[1].trim()
            targets.push({ label: path, filePath: path })
            pending = null
            continue
        }
        const update = /^\*\*\* Update File: (.+)$/.exec(line)
        if (update !== null) {
            const path = update[1].trim()
            targets.push({ label: path, filePath: path })
            pending = path
            continue
        }
        const remove = /^\*\*\* Delete File: (.+)$/.exec(line)
        if (remove !== null) {
            targets.push({ label: remove[1].trim() })
            pending = null
            continue
        }
        const move = /^\*\*\* Move to: (.+)$/.exec(line)
        if (move !== null && pending !== null) {
            const destination = move[1].trim()
            const last = targets[targets.length - 1]
            if (last !== undefined && last.filePath === pending) {
                targets[targets.length - 1] = { label: destination, from: pending, filePath: destination }
            }
            pending = null
        }
    }
    return targets
}

/** 取参数里的补丁原文（`input`）；缺/坏形返回 undefined。 */
export function patchInputOf(argsRaw: string | undefined): string | undefined {
    const args = parseArgsObject(argsRaw)
    const input = args === null ? undefined : args['input']
    return typeof input === 'string' && input !== '' ? input : undefined
}

/** 文件清单的一行摘要：多项用 `, ` 连接，移动写 `源 → 目标`。 */
export function patchSummaryOf(targets: readonly PatchTarget[], cwd?: string): string {
    return targets
        .map((target) => {
            const label = relativize(target.label, cwd)
            return target.from === undefined ? label : `${relativize(target.from, cwd)} → ${label}`
        })
        .join(', ')
}

/** 单文件补丁的可打开路径；多文件/删除/移动不设单一目标（与上游 `filePath` 口径同）。 */
export function singlePatchPathOf(targets: readonly PatchTarget[]): string | undefined {
    return targets.length === 1 ? targets[0].filePath : undefined
}

/** 工作区相对化：绝对路径落在工作区内时去前缀，其余原样（与工具行摘要的路径展示同口径）。 */
function relativize(path: string, cwd: string | undefined): string {
    if (cwd === undefined || cwd === '') return path
    const root = cwd.replace(/[/\\]+$/u, '')
    if (root === '' || path.length <= root.length) return path
    const boundary = path.charAt(root.length)
    if (boundary !== '/' && boundary !== '\\') return path
    const head = path.slice(0, root.length)
    return head.toLowerCase() === root.toLowerCase() ? path.slice(root.length + 1) : path
}

/** 是否绝对路径（POSIX 根、盘符或 UNC）。 */
function isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
}
