// 诊断日志用的安全序列化（`jsonPreview`）。
//
// 这个文件先前还有一个"把活动追加到临时文件"的 `traceTool`：它已经没有调用方了（全库无人引用），
// 所以连同落盘那套（`fs`/`os`/`path` 与文件变量）一起删掉 —— 需要那种追踪时再带着用途重新加，
// 不留"看着像有诊断、其实一次都不会写"的空壳。

/**
 * 日志用的安全序列化：**永不抛出**。
 *
 * 必须走这里的原因：`JSON.stringify(undefined)` 返回的不是字符串而是 `undefined`，
 * 再 `.slice()` 就抛 TypeError；日志一旦抛出就会打断它所在的数据分支。
 *
 * @param value - 任意值（`undefined` 按 `null` 处理）。
 * @param max - 截断长度。
 * @returns 预览字符串；无法序列化时给占位文案。
 */
export function jsonPreview(value: unknown, max: number): string {
    try {
        const text = JSON.stringify(value ?? null);
        return text === undefined ? String(value) : text.slice(0, max);
    } catch {
        return '(无法序列化)';
    }
}
