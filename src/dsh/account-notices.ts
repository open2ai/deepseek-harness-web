// 账号类提示（dsh 0.1.7-rc.2 新增的 `$events` 转发事件）。
//
// 上游在**默认** Web 组合里就启用 `ui-settings-account`（`bundle/web-app/cordis.patch.yml`），
// 收到这两个 emit 会显示提示条；插件此前对未知 emit 一律忽略 → 用户只能自己去网页端看
// 「为什么停了 / 要登录」。文案逐字取自上游 `ui-settings-account/src/client/locales.ts`（zh）。
//
// 与额度（`QUOTA`/`ACCOUNT_QUOTA`）的分工：额度是**回合失败**，走 `turn/end` 的失败文案
// （`webview/chat/core/turn-copy.ts`）；这里管的是**没有回合**的账号态通知。
import { dshEvents } from './events';

/** 一条账号提示。 */
export interface DshAccountNotice {
    /** 展示文案（上游 locale 原文，不自行改写） */
    readonly text: string;
    readonly tone: 'error' | 'ok';
}

/** emit 事件名 → 提示。 */
const NOTICES: Record<string, DshAccountNotice> = {
    'deepseek-account/session-expired': { text: '登录信息已失效，请重新登录', tone: 'error' },
    'deepseek-account/model-sign-in-required': { text: '当前模型暂不可用，请登录后再试', tone: 'error' },
};

/**
 * 某个 `$events` emit 对应的提示（认不出返回 undefined）。
 *
 * 事件名必须与转发白名单一致 ——
 * **写错一个字符就是永久的静默无操作**，所以这里单独成纯函数、可被探针钉住。
 * @param event - emit 事件名。
 * @returns 提示，或 undefined。
 */
export function accountNoticeFor(event: string): DshAccountNotice | undefined {
    return NOTICES[event];
}

const subscribers = new Set<(notice: DshAccountNotice) => void>();

/**
 * 每个事件只提示一次（进程生命周期内）。
 * 为什么不去重到"可关闭"：插件的提示是**对话区里的一行**，没有关闭动作，
 * 而这两个 emit 在上游是「状态仍成立就持续显示」的常驻提示 → 不去重会刷屏。
 * 断线重连（`onReady`）也不重置：重连很频繁，重置等于每次重连都补一行。
 */
const notified = new Set<string>();

let unsubscribeStream: (() => void) | undefined;

function onEmit(event: string, _args: readonly unknown[]): void {
    const notice = accountNoticeFor(event);
    if (notice === undefined || notified.has(event) || subscribers.size === 0) {
        return;
    }
    // 只在**真的有人收**时才记账：否则「无订阅者时到的提示」被消费掉，之后再也不会显示。
    notified.add(event);
    for (const cb of subscribers) {
        cb(notice);
    }
}

/**
 * 订阅账号提示（首个订阅者建立 `$events` 流订阅，无人订阅时释放）。
 * @param cb - 提示回调（每个事件至多一次）
 * @returns 退订函数
 */
export function subscribeAccountNotices(cb: (notice: DshAccountNotice) => void): () => void {
    subscribers.add(cb);
    if (unsubscribeStream === undefined) {
        unsubscribeStream = dshEvents.subscribeStream({ onEmit });
    }
    return () => {
        subscribers.delete(cb);
        if (subscribers.size === 0 && unsubscribeStream !== undefined) {
            unsubscribeStream();
            unsubscribeStream = undefined;
        }
    };
}
