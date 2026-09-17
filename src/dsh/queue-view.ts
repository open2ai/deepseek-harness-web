// 排队项的**展示形状**（宿主到页面的契约）：只搬运渲染要用的字段，判定与派生都留在页面。
//
// 为什么单独一层：队列项的原始形状是「消息内容块」（文本 + 附件引用），而页面对 dsh 字段零感知
// （分层铁律）。转换只做两件事 —— 取正文、取附件引用 —— 不做「是不是插话」这类判定，
// 那些由页面按 placement / 在跑与否决定。
import { fileRefsOf, imageRefsOf } from './official/result-text';
import type { DshQueueAttachmentView, DshQueueItem, DshQueueItemView } from './queue-types';

/** 内容块里的正文：文本块按顺序取，块间留空格（空格拼法见文件头）。 */
function textOf(content: unknown): string {
    if (!Array.isArray(content)) {
        return '';
    }
    const parts: string[] = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object') {
            continue;
        }
        const b = block as { type?: unknown; text?: unknown };
        if (b.type !== 'text') {
            continue;
        }
        const text = typeof b.text === 'string' ? b.text : '';
        if (text !== '') {
            parts.push(text);
        }
    }
    return parts.join(' ');
}

/**
 * 队列项到页面展示形状。
 *
 * `context` 类（注入的上下文）**不下发**：它不是用户排的队，出现在卡片里只会让人以为
 * 「我什么时候发过这条」。其余按顺序搬运。
 */
export function toQueueViews(items: readonly DshQueueItem[]): DshQueueItemView[] {
    const out: DshQueueItemView[] = [];
    for (const item of items) {
        if (item.placement === 'context') {
            continue;
        }
        const images: DshQueueAttachmentView[] = imageRefsOf(item.content).map((r) => ({
            kind: 'image' as const,
            attachmentId: r.attachmentId,
            ...(r.name === undefined ? {} : { name: r.name }),
        }));
        const files: DshQueueAttachmentView[] = fileRefsOf(item.content).map((r) => ({
            kind: 'file' as const,
            name: r.name,
            ...(r.bytes === undefined ? {} : { bytes: r.bytes }),
        }));
        const attachments = [...images, ...files];
        out.push({
            id: item.id,
            placement: item.placement,
            ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
            text: textOf(item.content),
            ...(attachments.length === 0 ? {} : { attachments }),
        });
    }
    return out;
}
