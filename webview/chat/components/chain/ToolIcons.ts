// 工具行的**上游图形**（内联 SVG，不引图标字体）—— 图标集，
// （1px 描边 + \`currentColor\`，\`viewBox 0 0 16 16\`）。
//
// 为什么内联：上游那套图标在它自己的包里，插件没有那个包；本仓既有做法就是把路径原样搬进来
// （\`ProcessIcons.ts\`、\`message/ThumbIcons.ts\` 都是先例）。
//
// **不再用 codicon 近似**：工具行的图标以前是"按语义归类挑一个 codicon"，与网页端不是同一个图形
// （用户反馈过 org-chart 那个）。现在整表来自上游：各 toolview 自己的图标 + 详情行按名字前缀的归类
// （上游 \`detailIcon\`）。
//
// 每个图形与上游同名同形；\`stroke-width\` 固定 1（上游 \`ICON_REGULAR_STROKE\`）。
import { html } from 'htm/preact'
import { isDetailsTool } from '../../core/details-card'

/** 上游 `IconSkillOutlineArtwork`（viewBox 0 0 17 17）—— `skill` 工具行专用。 */
const skill = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 17 17" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M4.57788 5.77124H10.7029" stroke="currentColor"/> <path d="M4.57788 8.89819H7.91879" stroke="currentColor"/> <path d="M12.1404 1.19446C12.9442 1.19446 13.6404 1.81999 13.6404 2.64465V8.89856H12.6404V2.64465C12.6404 2.42015 12.4411 2.19446 12.1404 2.19446H3.14038C2.83968 2.19446 2.64038 2.42015 2.64038 2.64465V13.0929C2.64082 13.3172 2.84001 13.5421 3.14038 13.5421H8.88159V14.5421H3.14038C2.33675 14.5421 1.6408 13.9172 1.64038 13.0929V2.64465C1.64038 1.81999 2.33651 1.19446 3.14038 1.19446H12.1404Z" fill="currentColor"/> <path d="M12.0051 15.1056C12.0051 13.6395 10.8166 12.451 9.35059 12.451C10.8166 12.451 12.0051 13.6395 12.0051 15.1056Z" stroke="currentColor"/> <path d="M12.0051 15.1056C12.0051 13.6395 10.8166 12.451 9.35059 12.451C10.8166 12.451 12.0051 13.6395 12.0051 15.1056Z" stroke="currentColor"/> <path d="M9.35059 12.451C10.8166 12.451 12.0051 11.2626 12.0051 9.79651C12.0051 8.33039 10.8166 7.14197 9.35059 7.14197C7.88447 7.14197 6.69606 8.33039 6.69606 9.79651C6.69606 11.2626 7.88447 12.451 9.35059 12.451Z" stroke="currentColor"/> </svg>`

const agentPreset = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M6.51867 12.3282C7.29816 12.6011 8.16475 12.6514 9.02269 12.4216C9.57879 12.2726 10.0784 12.0185 10.5087 11.6888C10.7819 12.0555 11.1606 12.3304 11.5913 12.4805C10.9688 13.029 10.2149 13.4478 9.35911 13.6771C8.13946 14.0038 6.90632 13.8971 5.82126 13.4533C6.15821 13.1562 6.4021 12.7652 6.51867 12.3282ZM9.17629 2.89409C11.1101 3.34433 12.739 4.81872 13.2889 6.87043C13.4219 7.3665 13.4811 7.8649 13.4774 8.35466C13.0924 8.13213 12.6422 8.01837 12.1741 8.05276L12.1711 8.05257C12.1539 7.77199 12.109 7.48889 12.0334 7.20684C11.6363 5.72533 10.5048 4.6372 9.13549 4.22844C9.25559 3.87667 9.29214 3.49087 9.22309 3.09892C9.2108 3.02922 9.19451 2.96108 9.17629 2.89409ZM4.7311 3.89107L4.78302 4.11879C4.87648 4.4488 5.04146 4.74263 5.25579 4.98896C3.98078 6.01355 3.35848 7.72904 3.8089 9.41059C3.81828 9.44559 3.82866 9.48025 3.83885 9.51479C3.38217 9.61268 2.98548 9.84137 2.68107 10.1556C2.63414 10.022 2.5897 9.88632 2.55244 9.74726C1.93301 7.43489 2.86717 5.07173 4.71504 3.76697L4.7311 3.89107Z" fill="currentColor" /> <path d="M7.99136 5.28105C8.87501 5.28105 9.59136 4.56471 9.59136 3.68105C9.59136 2.7974 8.87501 2.08105 7.99136 2.08105C7.1077 2.08105 6.39136 2.7974 6.39136 3.68105C6.39136 4.56471 7.1077 5.28105 7.99136 5.28105Z" stroke="currentColor" /> <path d="M3.94009 12.9417C4.82374 12.9417 5.54009 12.2254 5.54009 11.3417C5.54009 10.458 4.82374 9.7417 3.94009 9.7417C3.05643 9.7417 2.34009 10.458 2.34009 11.3417C2.34009 12.2254 3.05643 12.9417 3.94009 12.9417Z" stroke="currentColor" /> <path d="M12.0851 12.9417C12.9688 12.9417 13.6851 12.2254 13.6851 11.3417C13.6851 10.458 12.9688 9.7417 12.0851 9.7417C11.2015 9.7417 10.4851 10.458 10.4851 11.3417C10.4851 12.2254 11.2015 12.9417 12.0851 12.9417Z" stroke="currentColor" /> </svg>`

const users = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z" stroke="currentColor" /> <path d="M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5" stroke="currentColor" /> <path d="M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1" stroke="currentColor" /> <path d="M12.4 10.6C13.9 11.3 15 12.6 15 14.5" stroke="currentColor" /> </svg>`

const clock = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z" stroke="currentColor" /> <path d="M8 4.31V8.46L11 10.08" stroke="currentColor" /> </svg>`

const goal = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5" stroke="currentColor" /> <path d="M11.5 8C11.5001 8.69227 11.2948 9.36901 10.9102 9.94463C10.5257 10.5202 9.97901 10.9689 9.33944 11.2338C8.69986 11.4987 7.99609 11.5681 7.31712 11.433C6.63816 11.2979 6.01449 10.9645 5.52501 10.475C5.03548 9.98552 4.70209 9.36185 4.56702 8.68289C4.43195 8.00392 4.50127 7.30015 4.76619 6.66057C5.03112 6.021 5.47976 5.47436 6.05538 5.08978C6.631 4.70519 7.30774 4.49995 8.00001 4.5" stroke="currentColor" /> <path d="M8.00024 7.99976L11.2 4.80005" stroke="currentColor" /> <path d="M12.4719 5.62245C12.4246 5.66972 12.3569 5.69025 12.2913 5.67715L10.7814 5.37555C10.7022 5.35972 10.6402 5.29781 10.6244 5.2186L10.3228 3.70866C10.3097 3.6431 10.3302 3.57533 10.3775 3.52806L12.1826 1.723C12.2863 1.61929 12.4627 1.65879 12.5122 1.79684L12.9271 2.95225C12.9472 3.00847 12.9915 3.05272 13.0477 3.07291L14.2031 3.48774C14.3412 3.5373 14.3807 3.71368 14.277 3.81739L12.4719 5.62245Z" stroke="currentColor" /> </svg>`

const plugin = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M3.16143 6.59068L1.75205 8.00006L3.10619 9.35419L2.39908 10.0613L0.832948 8.49517C0.559581 8.2218 0.559582 7.77831 0.832948 7.50494L2.45432 5.88357L3.16143 6.59068ZM8.49511 15.1671C8.22176 15.4405 7.77826 15.4404 7.50489 15.1671L5.93461 13.5968L6.64172 12.8897L8 14.248L9.40938 12.8386L10.1165 13.5457L8.49511 15.1671ZM15.1671 7.50494C15.4403 7.7782 15.4401 8.22179 15.1671 8.49517L13.652 10.0102L12.9449 9.30309L14.248 8.00006L12.8897 6.64178L13.5968 5.93467L15.1671 7.50494ZM9.35414 3.10624L8 1.7521L6.69696 3.05514L5.98986 2.34803L7.50489 0.833003C7.77828 0.559981 8.22186 0.559752 8.49511 0.833003L10.0612 2.39913L9.35414 3.10624Z" fill="currentColor" /> <circle cx="8" cy="8" r="1.76221" stroke="currentColor" /> </svg>`

const code = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M6.27612 1.5L4.52612 14.5" stroke="currentColor" /> <path d="M11.4739 1.5L9.72388 14.5" stroke="currentColor" /> <path d="M2.39868 5.5H14.0681" stroke="currentColor" /> <path d="M1.93188 10.5H13.6013" stroke="currentColor" /> </svg>`

const search = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" stroke="currentColor" /> <path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor" /> </svg>`

const checklist = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z" stroke="currentColor" /> <path d="M7.5 4.5H13.5" stroke="currentColor" /> <path d="M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z" stroke="currentColor" /> <path d="M7.5 11.5H13.5" stroke="currentColor" /> </svg>`

const branch = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564" stroke="currentColor" /> <path d="M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944" stroke="currentColor" /> <circle cx="12.4502" cy="3.3079" r="1.56962" stroke="currentColor" /> <circle cx="12.4502" cy="12.6921" r="1.56962" stroke="currentColor" /> </svg>`

const api = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M3 4L7 8L3 12" stroke="currentColor" /> <path d="M9 12H13" stroke="currentColor" /> </svg>`

const edit = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor" /> <path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor" /> </svg>`

const question = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" /> <path d="M5.75 6.69646C5.75 6.29865 5.88196 5.90976 6.12919 5.57899C6.37643 5.24821 6.72783 4.99041 7.13896 4.83817C7.5501 4.68593 8.0025 4.6461 8.43895 4.72371C8.87541 4.80132 9.27632 4.99289 9.59099 5.27419C9.90566 5.55549 10.12 5.91388 10.2068 6.30406C10.2936 6.69423 10.249 7.09866 10.0787 7.4662C9.90843 7.83373 9.62004 8.14787 9.25003 8.36889C9.19476 8.4019 9.13803 8.43262 9.08004 8.46099C8.52566 8.73217 8 9.20817 8 9.82532" stroke="currentColor" /> <path d="M8 10.7416V11.7416" stroke="currentColor" /> </svg>`

const globe = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z" stroke="currentColor" /> <path d="M2.34619 8H13.6538" stroke="currentColor" strokeLinecap="square" /> <path d="M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138" stroke="currentColor" /> <path d="M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138" stroke="currentColor" /> </svg>`

const browse = (size = 14): unknown =>
    html`<svg width=${size} height=${size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"> <path d="M4.9375 5.90295H11.0625" stroke="currentColor" /> <path d="M4.9375 9.02991H8.27841" stroke="currentColor" /> <path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z" fill="currentColor" /> </svg>`

const GLYPHS: Record<string, (size?: number) => unknown> = {
    agentPreset,
    users,
    clock,
    goal,
    plugin,
    code,
    search,
    checklist,
    branch,
    api,
    edit,
    question,
    globe,
    browse,
    skill,
}

/** 智能体之间的协调类工具（上游 \`TEAMMATE_TOOLS\`）：统一用「双人」图形。 */
const TEAMMATE_TOOLS: ReadonlySet<string> = new Set(['spawn_teammate', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent'])

/** 工具行专属图形（上游各 toolview 各自的图标，与详情行那套无关）。 */
const DIRECT_GLYPH: Record<string, string> = {
  bash: 'api', pwsh: 'api', shell: 'api', powershell: 'api',
  edit: 'edit', write: 'edit', str_replace_editor: 'edit', apply_patch: 'edit',
  skill: 'skill',
  read: 'browse', read_image: 'browse', readTextFile: 'browse',
  grep: 'search', glob: 'search',
  web_search: 'globe', web_fetch: 'browse',
  todo_write: 'checklist',
  ask_user_question: 'question',
  subagent: 'agentPreset', list_subagent_models: 'agentPreset',
}

/** 详情行按**工具名前缀**归类图标（镜像上游 \`detailIcon\`）。 */
function detailsGlyphKey(name: string): string {
  if (TEAMMATE_TOOLS.has(name)) return 'users'
  if (name.startsWith('schedule_')) return 'clock'
  if (name.endsWith('_goal')) return 'goal'
  if (name.startsWith('cordis_')) return 'plugin'
  if (name.startsWith('terminal_')) return 'code'
  if (name.startsWith('session_') || name === 'lsp') return 'search'
  if (name.startsWith('job_') || name.startsWith('team_task_')) return 'checklist'
  if (name === 'workflow' || name === 'ralph') return 'branch'
  return 'agentPreset'
}

/**
 * 该工具行用哪张**上游图形**；\`undefined\` = 这一行没有对应图形（走 codicon 兜底的那几族：
 * 读族用文件类型图标、提问/计划类不走这张表）。
 *
 * @param name - 工具行上的原始工具名。
 */
export function toolGlyphOf(name: string): unknown | undefined {
  const direct = DIRECT_GLYPH[name]
  if (direct !== undefined) return GLYPHS[direct]?.()
  if (isDetailsTool(name)) return GLYPHS[detailsGlyphKey(name)]?.()
  return undefined
}
