// 审批卡「原因行」的文案决议（**纯函数**：无 Preact、无 DOM，便于直接喂用例）。
//
// 上游 dsh 0.1.7-rc.2 起，`approval/request` **并列**给出两份文本：
//   · `reason`（本层 `description`）—— **审计原文**（英文，会写进会话日志，语义固定）
//   · `displayReason`               —— **给人看的本地化文案** `{ en, zh, … }`，仅用于展示、不进审计
// 网页端的口径是
// `displayReason === undefined ? reason : resolveText(displayReason)` —— 这里同口径。
//
// 为什么单独一个文件：这是**用户真正看到的那一行字**，规则要能被独立断言
// （本仓习惯：`tmp/_*.test.mjs` 直接 import 纯函数喂用例，不启 webview）。
//
// 产地提醒：日常最常命中的是**沙箱提权**（提权由沙箱层产出，文案形如
// 给 `允许本次操作使用 workspace-write 权限：…`）；Auto review 拒绝转人工、以及
// `PreToolDecision.ask` 的 hook/插件也走同一字段。

/** 宿主拿不到原因时的占位文案（与归约器的兜底**同源**，避免两处各自写死而漂移）。 */
export const APPROVAL_FALLBACK_TEXT = '需要授权操作'

/**
 * 本插件界面当前的语言。审批卡的「需要批准 / 允许 / 拒绝」目前是中文硬编码，
 * 所以本地化文案也优先取 `zh`；将来做多语言时把这里接到偏好设置即可。
 */
const UI_LANGUAGE = 'zh'

/** 从开放的本地化形状里取一条：界面语言 → `en` → 声明顺序里的第一个非空串。 */
function localizedText(reason: Record<string, string> | undefined): string | undefined {
  if (reason === undefined) {
    return undefined
  }
  const preferred = reason[UI_LANGUAGE]
  if (preferred !== undefined && preferred !== '') {
    return preferred
  }
  const english = reason['en']
  if (english !== undefined && english !== '') {
    return english
  }
  // 最后一档：将来上游只给一门我们没登记的语言时，显示它仍好过显示英文审计原文。
  for (const text of Object.values(reason)) {
    if (text !== '') {
      return text
    }
  }
  return undefined
}

/**
 * 审批卡原因行的文案。
 *
 * `displayReason` 优先（本地化），缺失或为空则回退 `description`（= 上游审计 `reason`，
 * 即 v0.1.15 的旧行为）。两者都给不出可读文案时返回 `undefined` —— 调用方据此**不渲染原因行**
 * （而不是显示一个占位串）。
 */
export function approvalText(input: {
  description?: string
  displayReason?: Record<string, string>
}): string | undefined {
  const localized = localizedText(input.displayReason)
  if (localized !== undefined) {
    return localized
  }
  const description = input.description
  if (description === undefined || description === '' || description === APPROVAL_FALLBACK_TEXT) {
    return undefined
  }
  return description
}
