// "@" 引用触发器：与 "/" 指令同套 trigger 框架的另一个 source（适配上游 0.1.7-rc.2）。
// 行首或空白(含换行)后输入 @（或 @"…"）唤起「文件与文件夹 / 对话」候选，数据源与上游同名：
//   fileReferences/list（返回 {path,kind}）、sessionReferenceResolver/candidates（返回含 mention）。
// 选中后在光标处插入上游 mention 文本（发送时只是正文文本，dsh 宿主 pre-step 会解析会话/文件引用）：
//   文件/目录 @rel/path（含空白用引号；**目录补尾 / 且引号保持打开** `@"dir/`，文件才闭合 `@"file.txt"`），
//   会话 @[label](dsh-session:<b64url(id)>)
// 命中即向宿主请求候选（store.requestAtList，最新查询 wins）。
import type { TriggerCrumb, TriggerDef, TriggerRow } from './useTrigger'
import type { ChatStore } from '../store/chat'

/**
 * 文件/目录 mention（对齐上游 `formatFileMention`）：含空白/全角空格、或用户本来就是 `@"` 引号态时用引号；
 * **目录的引号保持打开**（`@"dir/`）—— 打开着才是「活的」token，才能继续下钻；文件才闭合（`@"file.txt"`）。
 * 目录先去重尾分隔符再补 '/'。
 */
function fileMention(path: string, kind: 'file' | 'directory', preserveQuote = false): string {
  let p = path
  if (kind === 'directory') {
    p = p.replace(/[\\/]+$/, '') + '/'
  }
  if (!preserveQuote && !/[\s　]/.test(p)) return '@' + p
  return kind === 'directory' ? `@"${p}` : `@"${p}"`
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
      return { query, start, quoted }
    },
    rows({ quoted }): TriggerRow[] {
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
            value: fileMention(f.path, 'directory', quoted),
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
            value: fileMention(f.path, 'file', quoted),
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
    pending({ query }) {
      // 手头那份 `atCatalog` 的查询串还停在别处 = 这个查询/这一层的候选还在路上：换层那一拍别把弹窗关掉
      // （上游 stale-while-revalidate：旧候选继续留在屏上，新帧到了才换）。帧一到就不再 pending —— 那时空结果照旧关菜单。
      return (store.atCatalog.value?.query ?? '').trim() !== query
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
    header(query, quoted) {
      // 下钻进目录时给弹窗顶部的面包屑：`工作区 › 目录 › …`（对齐上游 —— 折行显示，**每段可点回那一层**）。
      // 只有「以 / 结尾」的浏览目录态才有；每一段的 value 与目录行同一个口径（`fileMention` 出来的 `@dir/`），
      // 于是「点某一段回去」与「进某一层」在 pick 路径上是同一个动作。根层沿用当前 token 的引号形态（`@` / `@"`）。
      if (!query || !/[\\/]$/.test(query)) return null
      const segs = query.slice(0, -1).split(/[\\/]/).filter(Boolean)
      if (!segs.length) return null
      const root: TriggerCrumb = { label: '工作区', value: quoted ? '@"' : '@' }
      return [
        root,
        ...segs.map((label, i): TriggerCrumb => ({
          label,
          value: fileMention(segs.slice(0, i + 1).join('/'), 'directory'),
          ...(i === segs.length - 1 ? { current: true } : {}),
        })),
      ]
    },
  }
}
