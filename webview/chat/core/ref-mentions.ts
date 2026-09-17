// 用户消息里的 `@` 引用 token → 分段（供渲染成贴片）。
//
// 为什么按文本解析而不是靠"本地快照里的贴片"：引用 token 本来就是**写在正文里的**（发送时注入
// 引用行；上游也是把 mention 作为文本节点发出去）。只有按文本解析，**历史恢复的行**才能和
// 刚发出的那条长得一样；否则历史里会退化成光秃秃的 `@rel/path` 文本。
//
// 只认三种 token（与 core/trigger/at.ts 发出的形状一致），且必须在**行首或空白之后**才开始 ——
// 否则 `foo@bar.com` 这类邮箱会被误当成引用。
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
/** `@"含空格的路径"` */
const QUOTED_RE = /^@"([^"]+)"/
/**
 * 普通 `@rel/path`（含目录：以 `/` 结尾）。
 *
 * 排除「不可能出现在路径里、却常紧跟在引用后面」的标点（中英文句读与括号引号）—— 否则
 * `@src/a.ts，改一下` 会把中文正文整段吞进 token（中文之间通常没有空格，不排除就切不开）。
 * `.` 必须保留（`a.ts` 就靠它）。
 */
const PLAIN_RE = /^@([^\s@,;:!?()\[\]{}"'<>|*，。；：！？、）】》」』]+)/
/** 句末句读（`@src/a.ts.` 里那个句号属于正文）：剥到 token 末尾为止。 */
const TRAILING = /[,.;:!?，。；：！？、）】》」』]+$/

/** 路径末段（去掉尾部 `/` 后取最后一段，`/` 与 `\\` 都算分隔符）；空则回退原串。 */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const seg = trimmed.split(/[\\/]/).pop() ?? ''
  return seg === '' ? p : seg
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
      const quoted = QUOTED_RE.exec(rest)
      if (quoted !== null) {
        const p = quoted[1] as string
        flush()
        out.push({ mention: { token: quoted[0], label: baseName(p), kind: p.endsWith('/') ? 'directory' : 'file' } })
        i += quoted[0].length
        continue
      }
      const plain = PLAIN_RE.exec(rest)
      if (plain !== null) {
        // 去掉紧跟的句读：`@src/a.ts，` 里的逗号是正文，不该进 token（进了就与快照对不上、短名也变脏）
        const p = plain[1] as string
        const path = p.replace(TRAILING, '')
        if (path !== '') {
          const token = `@${path}`
          flush()
          out.push({ mention: { token, label: baseName(path), kind: path.endsWith('/') ? 'directory' : 'file' } })
          i += token.length
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
