// "@" 引用触发器：与 "/" 指令同套 trigger 框架的另一个 source（适配上游 0.1.7-rc.2）。
// 行首或空白(含换行)后输入 @（或 @"…"）唤起「文件与文件夹 / 对话」候选，数据源与上游同名：
//   fileReferences/list（返回 {path,kind}）、sessionReferenceResolver/candidates（返回含 mention）。
// 选中后在光标处插入上游 mention 文本（发送时只是正文文本，dsh 宿主 pre-step 会解析会话/文件引用）：
//   文件/目录 @rel/path（含空白用 @"…"；目录补尾 /），会话 @[label](dsh-session:<b64url(id)>)
// 命中即向宿主请求候选（store.requestAtList，最新查询 wins）。
import type { TriggerDef, TriggerRow } from './useTrigger'
import type { ChatStore } from '../store/chat'

/** 文件/目录 mention：含空白/全角空格则用 @"…" 引号包裹；目录去重尾分隔符再补 '/'。 */
function fileMention(path: string, kind: 'file' | 'directory'): string {
  let p = path
  if (kind === 'directory') {
    p = p.replace(/[\\/]+$/, '') + '/'
  }
  return /[\s　]/.test(p) ? `@"${p}"` : '@' + p
}

/** 只显示末段名字（文件/夹名），避免一长串路径 */
function tailName(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function atTrigger(store: ChatStore): TriggerDef {
  return {
    id: 'at',
    // 上游触发语法：行首/空白后的 @ 或 @"（含换行）；光标位于 token 末尾
    match(text, caret) {
      const prefix = text.slice(0, caret)
      const m = /(^|[\s　])(@(?:"([^"\n]*)|([^\s　]*)))$/.exec(prefix)
      if (!m) return null
      // token 之后还有非空白 → 光标仍停在 token 内，不替换以免破坏词
      const rest = text.slice(caret)
      if (rest && !/^[\s　]/.test(rest)) return null
      const quoted = m[3] !== undefined
      const query = quoted ? (m[3] ?? '') : (m[4] ?? '')
      const start = m.index + m[1].length
      store.requestAtList(query)
      return { query, start }
    },
    rows(): TriggerRow[] {
      const cat = store.atCatalog.value
      const rows: TriggerRow[] = []
      if (!cat) return rows
      // 只列“当前一层”：query 空=顶层；以 / 结尾=该目录直接子级；否则(模糊搜文件名)才放行深层。
      // 按类型分组展示：文件夹 → 文件 → 会话。
      const level = cat.query
      const isDirectChild = (p: string): boolean => {
        if (level.endsWith('/')) {
          const rest = p.startsWith(level) ? p.slice(level.length) : p
          return rest.length > 0 && rest.indexOf('/') < 0
        }
        if (level === '') {
          return p.indexOf('/') < 0
        }
        return true
      }
      for (const f of cat.files) {
        if (!isDirectChild(f.path)) continue
        if (f.kind === 'directory') {
          rows.push({
            kind: 'directory',
            group: 'files',
            groupLabel: '文件与文件夹',
            prefix: '',
            icon: 'folder-opened',
            name: tailName(f.path),
            searchText: f.path,
            description: '',
            hasDrill: true, // 右侧 › / Tab 进入下一层；行身点击仍=选中该文件夹
            value: fileMention(f.path, 'directory'),
          })
        } else {
          rows.push({
            kind: 'file',
            group: 'files',
            groupLabel: '文件与文件夹',
            prefix: '',
            icon: 'file',
            name: tailName(f.path),
            searchText: f.path,
            description: '',
            value: fileMention(f.path, 'file'),
          })
        }
      }
      for (const s of cat.sessions) {
        rows.push({
          kind: 'session',
          group: 'session',
          groupLabel: '对话',
          prefix: '',
          icon: 'comment-discussion',
          name: s.label,
          searchText: `${s.label} ${s.sessionId}`,
          description: s.sameWorkspace === false ? '其他工作区' : '',
          value: s.mention,
        })
      }
      return rows
    },
    pick(row, helpers) {
      // 引用不进正文：清掉刚输入的 @ token，改成输入框内一条蓝色引用贴片；
      // 发送时由 store 把各贴片 token 转成 @path / @[label](dsh-session:…) 引用行注入 prompt。
      helpers.clear()
      const kind = row.kind === 'session' ? 'session' : row.kind === 'directory' ? 'directory' : 'file'
      const label = row.name
      store.addRef(kind, label, row.value ?? '@' + label)
    },
    drill(row, helpers) {
      // 目录钻取（上游）：保留 '@dir/'，让菜单继续列其下一层；不关菜单
      if (row.kind !== 'directory') return false
      helpers.replace(row.value ?? '@')
      return true
    },
    header(query) {
      // 下钻进目录时显示 工作区 › 目录…；仅当以 / 结尾(浏览目录态)才显示
      if (!query || !/[\\/]$/.test(query)) return null
      const segs = query.slice(0, -1).split(/[\\/]/).filter(Boolean)
      return segs.length ? '工作区 › ' + segs.join(' › ') : null
    },
  }
}
