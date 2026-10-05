// 工具结果读取与展平：从 tool/result 事件载荷取出展示内容与配对 id，再拼成可展示文本。
// 展平规则：text 块原样，其余块序列化为 pretty JSON
// （内容块类型可被插件扩展，非 text 块没有通用渲染法，只能原样呈现结构），
// 内容为空且带结构化错误时兜底 "name: code" 一行。
// 宿主层共用（stream.ts 实时、session.ts 历史）；调用方负责随后的 exit marker 解析与截断。

/** tool/result 载荷里与展示、配对、终态判定有关的字段。 */
export interface ToolResultPayload {
    /** 展示用内容块数组（text 块原样，其余序列化）；无内容时为空数组。 */
    blocks: unknown
    /** 与 tool/call 配对的调用 id；取不到为 undefined。 */
    callId: string | undefined
    /**
     * 调用是否失败（包装块的 isError）。**终态判定用它，不要用「有没有 error.code」**——
     * code 是开放集合，其中若干并不表示失败（interrupted / ASK_CANCELLED / ASK_ABORTED），
     * 详见 `tool-status.ts`。
     */
    isError: boolean
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 按上游 schema 解包 tool/result 事件载荷。
 *
 * 现行格式把结果包了一层：`message.content[0]` 是 `tool-result` 块，真正的展示内容在它的
 * `content` 里；配对 id 在 `message.source.callId`（顶层没有 callId）。
 * 迁移前的旧格式是顶层 `callId` + 扁平 `content`。两种都兼容。
 *
 * @param data - `tool/result` 事件的 data。
 * @returns 展示内容块、配对 id 与失败标记。
 */
export function readToolResult(data: Record<string, unknown>): ToolResultPayload {
    const message = data['message'] as { content?: unknown; source?: unknown; isError?: unknown } | undefined;
    const source = message?.source as { callId?: unknown } | undefined;
    const first = Array.isArray(message?.content) ? (message.content as unknown[])[0] : undefined;
    const wrapper = first as { type?: unknown; content?: unknown; isError?: unknown } | undefined;
    // 包装块：内容在下一层；包装块自身没有 content 时按空内容处理（交给 error 兜底）
    const blocks = wrapper?.['type'] === 'tool-result'
        ? (Array.isArray(wrapper['content']) ? wrapper['content'] : [])
        : (message?.content ?? data['content']);
    return {
        blocks,
        callId: asString(source?.callId) ?? asString(data['callId']),
        // 失败标记的**主来源是一等消息上的 `message.isError`**（上游客户端取的就是这一层），
        // 另兼容包装块自身的 `isError` 与迁移前顶层的 `isError`。
        // ⚠️ 真实载荷里的失败**不一定**带顶层 `isError`：`error:{name,code}` + 内容首行 `Error: …` 就是全部，
        // 漏掉消息那一层会把失败行判成 ok —— 没有红点、摘要停在参数（真机：网页端红字报错、插件什么都没有）。
        isError: message?.['isError'] === true || wrapper?.['isError'] === true || data['isError'] === true,
    };
}

/** 附件引用（搬运用：只取渲染层要用的字段）。 */
export interface ImageRef {
    attachmentId: string;
    mediaType: string;
    name?: string;
    /** 固有像素宽（图廊按它定尺寸） */
    width?: number;
    /** 固有像素高 */
    height?: number;
}

/**
 * 从内容块里取出图片附件引用（用户消息与工具结果共用）。
 * **只搬运、不判定**：缺 `attachmentId`/`mediaType` 的块直接跳过 —— 形状校验与渲染都在渲染侧。
 * @param content - 事件的 content 块数组（`user/message` 的 `data.content` 或 `tool/result` 的 `message.content[0].content`）。
 * @returns 按顺序的附件引用。
 */
export function imageRefsOf(content: unknown): ImageRef[] {
    const refs: ImageRef[] = [];
    if (!Array.isArray(content)) { return refs; }
    for (const block of content) {
        const b = block as { type?: unknown; attachment?: unknown } | null | undefined;
        if (b === null || b === undefined || b['type'] !== 'image') { continue; }
        const a = b['attachment'] as Record<string, unknown> | undefined;
        if (a === null || typeof a !== 'object') { continue; }
        const id = a['attachmentId'];
        const media = a['mediaType'];
        if (typeof id !== 'string' || id === '' || typeof media !== 'string' || media === '') { continue; }
        const name = typeof a['name'] === 'string' ? a['name'] : undefined;
        const width = typeof a['width'] === 'number' ? a['width'] : undefined;
        const height = typeof a['height'] === 'number' ? a['height'] : undefined;
        refs.push({
            attachmentId: id,
            mediaType: media,
            ...(name === undefined ? {} : { name }),
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
        });
    }
    return refs;
}

/** 文件附件的展示信息（历史回放用：只有名字与字节数，没有本地路径）。 */
export interface FileRef {
    name: string;
    bytes?: number;
}

/**
 * 从内容块里取出**文件**附件（`user/message` 的 `data.content` 里 `{type:'file',attachment}`）。
 * 只搬运不判定：缺名字的块跳过。字节与本地路径都不在事件里（事件里只有内容寻址引用），
 * 所以历史回放只能显示名字/大小 —— 这与上游消息里的文件卡一致（不可点开）。
 * @param content - 事件的 content 块数组。
 * @returns 按顺序的文件展示信息。
 */
export function fileRefsOf(content: unknown): FileRef[] {
    const refs: FileRef[] = [];
    if (!Array.isArray(content)) { return refs; }
    for (const block of content) {
        const b = block as { type?: unknown; attachment?: unknown } | null | undefined;
        if (b === null || b === undefined || b['type'] !== 'file') { continue; }
        const a = b['attachment'] as Record<string, unknown> | undefined;
        if (a === null || typeof a !== 'object') { continue; }
        const name = typeof a['name'] === 'string' && a['name'] !== '' ? a['name'] : undefined;
        if (name === undefined) { continue; }
        const bytes = typeof a['bytes'] === 'number' ? a['bytes'] : undefined;
        refs.push({ name, ...(bytes === undefined ? {} : { bytes }) });
    }
    return refs;
}

/**
 * 结果内容块里是否含图片块。
 *
 * 用途是**搬运决策**，不是卡判定：含图片时宿主改发「原始内容块 + 只含 text 的干净文本」，
 * 让渲染层自己按上游口径校验与展示（附件引用是给渲染层用的数据，不是给人读的文本）。
 * 卡的判定（工具名、信封形状、引用合法性等）一律留在渲染侧，改渲染不动宿主。
 * @param content - tool/result 的 message.content。
 * @returns 是否至少有一个 `type === 'image'` 的块。
 */
export function hasImageBlock(content: unknown): boolean {
    if (!Array.isArray(content)) {
        return false;
    }
    return content.some((block) => (block as { type?: unknown } | undefined)?.['type'] === 'image');
}

/**
 * 只拼 text 块（其余块不参与）。
 *
 * 与 `resultText()` 的区别：后者把非 text 块序列化成 pretty JSON —— 对图片块而言那是把
 * 附件引用对象整段倒进「输出」区（既不可读、也不是它的用途）。
 * @param content - tool/result 的 message.content。
 * @returns 各 text 块按序拼接的文本（可能为空串）。
 */
export function textOnly(content: unknown): string {
    const parts: string[] = [];
    if (Array.isArray(content)) {
        for (const block of content) {
            const b = block as { type?: unknown; text?: unknown };
            if (b['type'] === 'text' && typeof b['text'] === 'string') {
                parts.push(b['text']);
            }
        }
    } else if (typeof content === 'string') {
        parts.push(content);
    }
    return parts.join('\n');
}

/**
 * 展平工具结果的内容块为展示文本。
 * @param content - tool/result 的 message.content（块数组；非数组时按字符串兜底）
 * @param error - tool/result 的结构化错误（name/code），仅在无内容时兜底
 * @returns 展平后的结果文本（可能为空串）
 */
export function resultText(content: unknown, error?: { name?: unknown; code?: unknown }): string {
    const parts: string[] = [];
    if (Array.isArray(content)) {
        for (const block of content) {
            const b = block as { type?: unknown; text?: unknown };
            if (b['type'] === 'text' && typeof b['text'] === 'string') {
                parts.push(b['text']);
            } else {
                parts.push(JSON.stringify(block, null, 2) ?? String(block));
            }
        }
    } else if (typeof content === 'string') {
        parts.push(content);
    }
    if (parts.length === 0 && error !== undefined) {
        const line = [error.name, error.code]
            .filter((v): v is string => typeof v === 'string' && v !== '')
            .join(': ');
        if (line !== '') {
            parts.push(line);
        }
    }
    return parts.join('\n');
}
