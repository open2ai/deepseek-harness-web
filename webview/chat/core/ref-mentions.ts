// 用户消息里的 `@` 引用 token → 分段（供渲染成贴片）。
//
// 为什么按文本解析而不是靠"本地快照里的贴片"：引用 token 本来就是**写在正文里的**（发送时注入
// 引用行；上游也是把 mention 作为文本节点发出去）。只有按文本解析，**历史恢复的行**才能和
// 刚发出的那条长得一样；否则历史里会退化成光秃秃的 `@rel/path` 文本。
//
// 只认三种 token（与 core/trigger/at.ts 发出的形状一致：文件 `@rel/path` / `@"my file.txt"`，
// **目录 `@dir/` / `@"my dir/`（引号保持打开）**，会话 `@[label](dsh-session:…)`），
// 且必须在**行首或空白之后**才开始 —— 否则 `foo@bar.com` 这类邮箱会被误当成引用。
import type { RefChip } from './store/types'

export interface RefMention {
  /** 原文 token（含前导 @；会话形式是整段 `@[label](dsh-session:…)`） */
  token: string
  /** 贴片上显示的短名（路径取末段，会话取方括号里的 label） */
  label: string
  kind: RefChip['kind']
}

export type RefSegment = { text: string } | { mention: RefMention }

/** `@[label](dsh-session:<b64url>)`：会话引用（label 可能为空）。 */
const SESSION_RE = /^@\[([^\]]*)\]\(dsh-session:([A-Za-z0-9_-]+)\)/
/** `@"含空格的路径"`（**闭合**：文件；用户手打的闭合串也走这条） */
const QUOTED_RE = /^@"([^"\n]+?)"/
/**
 * `@"含空格的目录/`（**引号保持打开**）：上游 `formatFileMention` 对目录就是这种形状
 * （开着才能继续下钻），`core/trigger/at.ts` 用的是同一种形状，于是注入 prompt 的目录 token 也是它。
 * 边界取「到行尾」：发送时每条引用 token 自占一段（`core/store/outbox.ts` 用空行拼接），
 * 且这里**只认以 `/` 结尾**的那一支 —— 手打的那种没闭合、又不指向目录的 `@"…` 仍按普通文本对待。
 */
const QUOTED_OPEN_DIR_RE = /^@"([^"\n]*\/)(?=\n|$)/
/**
 * 普通 `@rel/path`（含目录：以 `/` 结尾；**也含绝对路径**，Windows 盘符 `e:/…` 与 `/…` 都算）。
 *
 * 排除「不可能出现在路径里、却常紧跟在引用后面」的标点（中英文句读与括号引号）—— 否则
 * `@src/a.ts，改一下` 会把中文正文整段吞进 token（中文之间通常没有空格，不排除就切不开）。
 * `.` 必须保留（`a.ts` 就靠它）。
 *
 * ⚠️ **`:` 必须放行**：上游的 `@`-token 边界是
 * **空白**（`activeAtToken` 取 `[^\s]*`），盘符里的冒号是**路径正文**；插件为了处理中文标点改成
 * "排除若干标点"，早期把 `:` 也列了进去 → 绝对路径 `@E:\…\xxx.md` 被切成 `@E`，贴片短名成了 `E`。
 * 句末的 `:`/`;` 由 `TRAILING` 剥掉，所以放行不会把句读粘进 token。
 */
const PLAIN_RE = /^@([^\s@,;!?()\[\]{}"'<>|*，。；！？、）】》」』]+)/
/** 句末句读（`@src/a.ts.` 里那个句号属于正文）：剥到 token 末尾为止（`:`/`;` 也在此列，见 `PLAIN_RE`）。 */
const TRAILING = /[,.;:!?，。；：！？、）】》」』]+$/

/** 路径末段（去掉尾部 `/` 后取最后一段，`/` 与 `\\` 都算分隔符）；空则回退原串。 */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const seg = trimmed.split(/[\\/]/).pop() ?? ''
  return seg === '' ? p : seg
}

/**
 * 两种引号态 + 普通路径**共用**的收尾：剥掉句末句读再取短名。
 *
 * 引号态也要剥：`@"a b.txt"，然后` 里那个中文逗号在引号**之外**、不会进 `QUOTED_RE`，
 * 但 `@"a b.txt"` 后面紧跟 `:` 这种"引号内是路径、句读在引号外"的形状会由正则边界兜住；
 * 这里统一走一遍是为了让**短名与 token 用的是同一份清洗后的路径**，不出现"token 带句读、短名不带"。
 */
function mentionOf(raw: string): { token: string; label: string; kind: RefMention['kind'] } {
  const path = raw.replace(TRAILING, '')
  return { token: `@${path}`, label: baseName(path), kind: path.endsWith('/') ? 'directory' : 'file' }
}

/**
 * 把一段文本切成「文本片段」与「引用片段」。
 *
 * 保守原则：一段 `@…` 只在**行首或空白之后**才算引用；认不出的形状（如 `@` 后跟标点）当普通文本。
 */
export function splitRefMentions(text: string): RefSegment[] {
  const out: RefSegment[] = []
  let buf = ''
  let i = 0
  const flush = (): void => {
    if (buf !== '') {
      out.push({ text: buf })
      buf = ''
    }
  }
  while (i < text.length) {
    const atBoundary = i === 0 || /\s/.test(text[i - 1] as string)
    if (text[i] === '@' && atBoundary) {
      const rest = text.slice(i)
      const session = SESSION_RE.exec(rest)
      if (session !== null) {
        flush()
        out.push({ mention: { token: session[0], label: session[1] || '会话', kind: 'session' } })
        i += session[0].length
        continue
      }
      const quoted = QUOTED_RE.exec(rest) ?? QUOTED_OPEN_DIR_RE.exec(rest)
      if (quoted !== null) {
        flush()
        const m = mentionOf(quoted[1] as string)
        out.push({ mention: { ...m, token: quoted[0] } })
        i += quoted[0].length
        continue
      }
      const plain = PLAIN_RE.exec(rest)
      if (plain !== null) {
        // 去掉紧跟的句读：`@src/a.ts，` 里的逗号是正文，不该进 token（进了就与快照对不上、短名也变脏）
        const m = mentionOf(plain[1] as string)
        if (m.label !== '') {
          flush()
          out.push({ mention: m })
          i += m.token.length
          continue
        }
      }
    }
    buf += text[i]
    i += 1
  }
  flush()
  return out
}

/** 该段文本里有没有引用 token（渲染侧据此决定是否还需要"独立贴片行"）。 */
export function hasRefMention(text: string): boolean {
  return splitRefMentions(text).some((s) => 'mention' in s)
}
