// 分叉子会话的标题升号（适配上游 0.1.7-rc.2）。
//
// 上游分叉会把源会话的标题事件一并复制进子会话的种子日志，所以**子会话默认与源会话同名** ——
// 列表里两者无法区分。上游客户端的做法是在分叉成功后就地给子会话改名（`increaseTitle`），
// 规则就是这里这一条纯函数（代码注释不写上游客商名，来源见 docs/design/04）。

/** 末尾的编号：半角 `(1)` 或全角 `（1）`，允许中间有空格。 */
const TRAILING_INDEX = /^(.*?)\s*[（(]\s*(\d+)\s*[)）]\s*$/;

/**
 * 升号：末尾已有编号则 +1（保留原来的括号形态），没有则补 ` (1)`。
 * @param title - 源会话的标题（调用方负责只在**确有 durable 标题**时调用）。
 * @returns 子会话应使用的标题。
 */
export function increasedForkTitle(title: string): string {
    const matched = TRAILING_INDEX.exec(title);
    if (matched === null) {
        return `${title} (1)`;
    }
    // 括号形态按原样保留：源标题用全角就不要换成半角（否则中文标题里会突然冒出半角括号）
    const fullWidth = title.includes('（');
    const open = fullWidth ? '（' : '(';
    const close = fullWidth ? '）' : ')';
    return `${matched[1]}${open}${Number(matched[2]) + 1}${close}`;
}
