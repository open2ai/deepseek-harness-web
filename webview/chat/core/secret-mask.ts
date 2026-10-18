// **已发送用户文本里的凭据遮挡**（对应上游 0.2.1）。
//
// 只改**显示**：消息原文、复制出来的内容、送给模型的输入都保持原样。目的是"共享屏幕 / 截图时别被人看到"。
//
// 规则与上游逐条同口径：
//   · 固定前缀类（`sk-`、`ghp_`、`AKIA`…）：命中后**保留前 8 个字符**，其余每个字符一个 `*`；
//   · URL 里的密码（`scheme://user:password@host`）：**密码整段遮挡**；
//   · 私钥块（`-----BEGIN … PRIVATE KEY-----` 到对应 `END`）：**保留首尾两行**与所有换行，正文遮掉。
//
// 长度门槛是**判定的一部分**，不是宽松近似：`sk-` 前缀后要求至少 20 个字符（且其中含数字）——
// 太短的串，会原样显示。把它也遮掉会误伤正常文本。
//
// 识不出的格式一律不遮：`API_KEY=…` 这类命名赋值、句子里的密码、验证码、个人信息都保持原样。

/** 遮挡字符（每个被遮的码点一个）。 */
export const MASK_CHAR = '*'

/** 固定前缀类命中后保留的可读字符数。 */
const VISIBLE_PREFIX = 8

/** ASCII 字符类（与上游同名同义；只留本文件实际用到的几个）。 */
const ALNUM = '[A-Za-z0-9]'
const ALNUM_DASH = '[A-Za-z0-9-]'

/** 一条固定前缀格式：字面量 + 后续字符跑的形状。 */
interface PrefixedFormat {
  literal: string
  /** 字面量之后那一段的正则（不含 `g`），整段即凭据正文。 */
  run: RegExp
}

const runOf = (cls: string, min: number): string => `${cls}{${String(min)},}`

/**
 * 固定前缀格式表（顺序不重要：最终按起始位置取最早的候选）。
 * 每条都要求"凭据正文"足够长，短串不算 —— 与上游一致，避免把普通标识符遮成星号。
 */
const PREFIXED: readonly PrefixedFormat[] = [
  // 模型服务：`sk-` 的正文要求 ≥20 且含数字（带连字符的标识符很少同时满足这两条）
  { literal: 'sk-', run: /(?=[A-Za-z0-9_-]{0,256}\d)[A-Za-z0-9_-]{20,}/y },
  { literal: 'AIza', run: /[A-Za-z0-9_-]{35,}/y },
  // 代码托管与包仓库
  { literal: 'ghp_', run: /[A-Za-z0-9]{36,}/y },
  { literal: 'gho_', run: /[A-Za-z0-9]{36,}/y },
  { literal: 'ghu_', run: /[A-Za-z0-9]{36,}/y },
  { literal: 'ghs_', run: /[A-Za-z0-9]{36,}/y },
  { literal: 'ghr_', run: /[A-Za-z0-9]{36,}/y },
  { literal: 'github_pat_', run: /[A-Za-z0-9_]{22,}/y },
  { literal: 'glpat-', run: /[A-Za-z0-9_-]{20,}/y },
  { literal: 'npm_', run: /[A-Za-z0-9]{36,}/y },
  { literal: 'hf_', run: /[A-Za-z0-9]{30,}/y },
  // 云访问密钥 ID（定长桶）
  { literal: 'AKIA', run: /[A-Z0-9]{16}(?![A-Za-z0-9])/y },
  { literal: 'ASIA', run: /[A-Z0-9]{16}(?![A-Za-z0-9])/y },
  { literal: 'LTAI', run: /[A-Za-z0-9]{12,20}(?![A-Za-z0-9])/y },
  { literal: 'AKID', run: /[A-Za-z0-9]{28,36}(?![A-Za-z0-9])/y },
  // 协作与支付
  { literal: 'xoxa-', run: new RegExp(runOf(ALNUM_DASH, 10), 'y') },
  { literal: 'xoxb-', run: new RegExp(runOf(ALNUM_DASH, 10), 'y') },
  { literal: 'xoxp-', run: new RegExp(runOf(ALNUM_DASH, 10), 'y') },
  { literal: 'xoxr-', run: new RegExp(runOf(ALNUM_DASH, 10), 'y') },
  { literal: 'xoxs-', run: new RegExp(runOf(ALNUM_DASH, 10), 'y') },
  { literal: 'sk_live_', run: new RegExp(runOf(ALNUM, 16), 'y') },
  { literal: 'sk_test_', run: new RegExp(runOf(ALNUM, 16), 'y') },
  { literal: 'rk_live_', run: new RegExp(runOf(ALNUM, 16), 'y') },
  { literal: 'rk_test_', run: new RegExp(runOf(ALNUM, 16), 'y') },
  { literal: 'whsec_', run: new RegExp(runOf(ALNUM, 24), 'y') },
  // JWT：`eyJ` 开头、三段用 `.` 连接
  { literal: 'eyJ', run: /[A-Za-z0-9_-]{8,2048}(?:\.[A-Za-z0-9_-]{8,2048}){2}/y },
]

/** 私钥块（含 `BEGIN`/`END` 两行的完整范围）。 */
const KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu

/** URL 里带凭据的密码部分：`scheme://user:password@`。 */
const ADDRESS_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@?#]+:)([^\s/@?#]+)@/giu

/** 一次命中的范围与遮挡方式。 */
interface Hit {
    start: number
    end: number
    masked: string
}

/** 保留前 `VISIBLE_PREFIX` 个字符，其余按码点补 `MASK_CHAR`。 */
function maskPrefixed(text: string, start: number, end: number): string {
    const visible = text.slice(start, Math.min(end, start + VISIBLE_PREFIX))
    const hidden = Array.from(text.slice(start + VISIBLE_PREFIX, end)).length
    return visible + MASK_CHAR.repeat(Math.max(0, hidden))
}

/** 私钥块：保留首行与末行（`BEGIN`/`END`），正文逐字符遮挡，换行原样保留。 */
function maskKeyBlock(text: string, start: number, end: number): string {
    const block = text.slice(start, end)
    const lines = block.split('\n')
    if (lines.length <= 1) {
        // 单行私钥：整段遮掉（没有可保留的结构）
        return Array.from(block).map((ch) => (ch === '\r' ? ch : MASK_CHAR)).join('')
    }
    return lines.map((line, index) => {
        if (index === 0 || index === lines.length - 1) return line
        return Array.from(line).map((ch) => (ch === '\r' ? ch : MASK_CHAR)).join('')
    }).join('\n')
}

/** 收集所有命中（固定前缀类按起始位置去重：同一处只留最长的一个）。 */
function collect(text: string): Hit[] {
    const hits: Hit[] = []
    for (const match of text.matchAll(KEY_BLOCK)) {
        const start = match.index ?? 0
        hits.push({ start, end: start + match[0].length, masked: maskKeyBlock(text, start, start + match[0].length) })
    }
    ADDRESS_PASSWORD.lastIndex = 0
    for (const match of text.matchAll(ADDRESS_PASSWORD)) {
        const start = match.index ?? 0
        const prefix = match[1] ?? ''
        const password = match[2] ?? ''
        const passwordStart = start + prefix.length
        hits.push({
            start: passwordStart,
            end: passwordStart + password.length,
            masked: MASK_CHAR.repeat(Array.from(password).length),
        })
    }
    for (const format of PREFIXED) {
        let from = 0
        while (from <= text.length) {
            const at = text.indexOf(format.literal, from)
            if (at < 0) break
            const runStart = at + format.literal.length
            format.run.lastIndex = runStart
            const run = format.run.exec(text)
            if (run !== null) {
                const end = runStart + run[0].length
                hits.push({ start: at, end, masked: maskPrefixed(text, at, end) })
                from = end
            } else {
                from = at + 1
            }
        }
    }
    return hits
}

/**
 * 遮挡一段文本里的可识别凭据。
 *
 * 重叠候选按"起始位置更早者优先，同起点取更长者"合并（与上游一致），其余丢弃 —— 这样
 * 一个串不会被遮两次、也不会因为两套规则交叉而露出半截原文。
 * @param text - 已发送的用户文本（原文）
 * @returns 遮挡后的显示文本；没有命中时原样返回同一字符串
 */
export function maskCredentials(text: string): string {
    if (text === '') return text
    const hits = collect(text)
    if (hits.length === 0) return text
    hits.sort((a, b) => a.start - b.start || b.end - a.end)
    let out = ''
    let cursor = 0
    for (const hit of hits) {
        if (hit.start < cursor) continue
        out += text.slice(cursor, hit.start) + hit.masked
        cursor = hit.end
    }
    return out + text.slice(cursor)
}

/**
 * 这段文本里有没有可识别的凭据（要不要给"显示原文"的开关）。
 * @param text - 已发送的用户文本（原文）
 * @returns 有凭据时 true
 */
export function hasCredential(text: string): boolean {
    return text !== '' && maskCredentials(text) !== text
}
