// "/" 斜杠命令触发器：行首 "/" 唤起，候选 = dsh host 命令目录(原序) + 客户端贡献(/model) + 会话技能。
// 数据源与上游 ui-commands/ui-skill 同名(commands/list、skills/list)；顺序对齐上游：host 原序在前、贡献殿后、空查询不排序。
import type { TriggerDef, TriggerRow } from './useTrigger'
import type { ChatStore } from '../store/chat'

export function slashTrigger(store: ChatStore): TriggerDef {
  return {
    id: 'slash',
    // 仅行首(输入框开头或换行后)的 "/" 命中
    match(text, caret) {
      const prefix = text.slice(0, caret)
      const lineStart = prefix.lastIndexOf('\n') + 1
      const line = prefix.slice(lineStart)
      if (!line.startsWith('/')) return null
      // 已在「/指令 参数…」阶段：名称已带一个完整 token + 空格 → 不再弹菜单，把参数留在输入框
      // （避免插入了 "/name " 后菜单残留/随击键再冒出来）
      if (/^\S+[\s　]/.test(line.slice(1))) return null
      // 目录不可用时按需补拉（store 内部：在飞则并入、失败后按间隔自动重试、已有快照则不动）。
      // 判据是**状态**而不是「目录空不空」：服务端明确回答「没有命令/技能」时不该无谓重拉。
      if (store.needsSlashList()) store.requestSlashList()
      return { query: line.slice(1), start: lineStart }
    },
    rows(): TriggerRow[] {
      const rows: TriggerRow[] = []
      const cat = store.slashCatalog.value
      // 分组标题同上游词典：指令(commands/list) → 技能(skills/list)。
      // 组内不排序：上游空查询在 fuzzyCandidates 早退，host 返回序即展示序
      const commands = cat?.commands ?? []
      for (const c of commands) {
        rows.push({ kind: 'command', group: 'command', groupLabel: '指令', prefix: '/', name: c.name, description: c.description, hint: c.input?.hint })
      }
      // /model 上游由客户端(非 host)贡献：追加在指令组末尾，对齐上游「host 原序 + contribution 殿后」。
      // kind 必须区别于 'command'，否则会落进 pick() 末尾「无参 command 立即执行」分支被误发到后端；
      // group 仍挂 'command'，分组头按 group 边界渲染，不会在它前面重出「指令」头
      rows.push({ kind: 'local', group: 'command', groupLabel: '指令', prefix: '/', name: 'model', description: '选择模型与推理等级' })
      const skills = cat?.skills ?? []
      for (const s of skills) {
        rows.push({ kind: 'skill', group: 'skill', groupLabel: '技能', prefix: '/', name: s.name, description: s.description })
      }
      return rows
    },
    pick(row, helpers) {
      if (row.kind === 'command' && row.name === 'permission') {
        // 权限预设是可选项而非自由文本：打开插件权限弹窗选预设，
        // 选中后由 chatSelectPermission → dsh setPermissionPreset → 刷新，权限标签/状态随之更新。
        // **不设 markSlashPick，也不产生任何对话区行**：上游 chat 显式过滤权限命令
        //（`isVisibleChatNode()`），切权限在对话区什么都不显示；反馈走 VS Code 通知。
        helpers.clear()
        store.closePopups()
        if (store.openPopup.value !== 'perm') store.togglePopup('perm')
        return
      }
      if (row.kind === 'local' && row.name === 'model') {
        // /model 是客户端贡献项：清掉 token，转交「仅模型列表」可搜索弹窗(openModelSearch)。
        // 先 clear 再 open：clear 的归焦 microtask 先入队，SearchPicker 挂载后的自动聚焦后跑才拿得到焦点。
        // 不能在这里 closePopups()——它会把下面刚设的 slashPickKind 清成 null，选中后就不回显结果行了
        helpers.clear()
        store.markSlashPick('model')
        store.openModelSearch()
        return
      }
      if (row.kind === 'command' && !row.hint) {
        // 无参 host 命令：清掉 token，立即执行（走 commands/execute，不进聊天气泡）
        helpers.clear()
        store.runSlash('/' + row.name)
        return
      }
      // 带参命令 / 技能：插入 "/name " 保留光标，继续输参后回车（命令走宿主执行、技能走正常发送）
      helpers.replace('/' + row.name + ' ')
    },
  }
}
