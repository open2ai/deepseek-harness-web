// dsh 设置读取：「设置 → 通用设置」四项偏好（工作步骤展示 / 性能与用量 / 代码工作工具 / 繁忙时的发送行为），
// 供对话区跟随。**只读** —— 写入仍由上游设置页负责，插件不改用户设置文档。
//
// 分工：取值与归一化在 `chat-prefs.ts`（纯函数，守卫 `tmp/_chatprefs.follow.test.mjs`）；
// 本文件只做 I/O：一次 `settings/describe` 读四项 + `$events` 跟随 + 值变化通知。
// 实时跟随走 `settings/document-updated`；emit 之外仍有「read 时值一变就通知」兜底。
import { rpcCall } from './rpc';
import { dshEvents } from './events';
import { chatPrefsOf, sameChatPrefs, type DshChatPrefs, type DshSettingsNamespace } from './chat-prefs';

/** 设置文档变更的 $events emit 事件名。 */
const SETTINGS_UPDATED_EVENT = 'settings/document-updated';

/** 这四项各自所属的命名空间（emit 过滤用；认不出是哪个命名空间时保守重读）。 */
const PREF_NAMESPACES: readonly string[] = ['ui-chat', 'ui-settings', 'ui-conversation'];

/** settings/describe 应答里本模块用到的部分（其余命名空间与 schema 不解析）。 */
interface SettingsDescribeValue {
    namespaces?: DshSettingsNamespace[];
}

/** 最近一次成功读到的值；undefined = 还没成功读到过。 */
let cached: DshChatPrefs | undefined;

/** 已通知给订阅者的值（去重：同值不重复回调）。 */
let notified: DshChatPrefs | undefined;

/** 失败日志只打一次：服务未起时会被反复调用，刷屏会淹没其它日志。 */
let warnedFailure = false;

/** 在飞的那次读取：并发调用复用同一次 RPC，避免 emit 密集时打多份。 */
let inflight: Promise<DshChatPrefs | undefined> | undefined;

const subscribers = new Set<(prefs: DshChatPrefs) => void>();

/** $events 流的订阅句柄（首个订阅者建立、无人订阅时释放）。 */
let unsubscribeStream: (() => void) | undefined;

async function doRead(): Promise<DshChatPrefs | undefined> {
    let value: SettingsDescribeValue;
    try {
        value = await rpcCall<SettingsDescribeValue>('settings.describe', {});
        warnedFailure = false;
    } catch (e) {
        // 读不到时**不返回默认值**：返回默认会把「读失败」伪装成「用户选了默认档」，
        // 让已经按用户设置渲染的界面瞬间抖回默认。调用方拿到 undefined 应保留上次值。
        if (!warnedFailure) {
            warnedFailure = true;
            console.warn(`[dsh-settings] 读取设置失败：${e instanceof Error ? e.message : String(e)}`);
        }
        return undefined;
    }
    cached = chatPrefsOf(value?.namespaces ?? []);
    if (notified === undefined || !sameChatPrefs(cached, notified)) {
        notified = cached;
        for (const cb of subscribers) {
            cb(cached);
        }
    }
    return cached;
}

/** 最近一次成功读到的值（新面板回填用，省一次 RPC）。 */
export function getCachedChatPrefs(): DshChatPrefs | undefined {
    return cached;
}

/**
 * 读一次四项偏好。成功且取值有变化时，顺带通知订阅者（于是「读」即「对齐」）。
 * @returns 取值；undefined = 本次没读到（服务未起 / 上游没挂设置 provider / 调用失败）
 */
export function readChatPrefs(): Promise<DshChatPrefs | undefined> {
    if (inflight !== undefined) {
        return inflight;
    }
    inflight = doRead().finally(() => {
        inflight = undefined;
    });
    return inflight;
}

/** emit 分发：只在**确证**是别的命名空间时跳过——形状不符时保守重读，避免上游换帧形状后这里永不更新。 */
function onEmit(event: string, args: readonly unknown[]): void {
    if (event !== SETTINGS_UPDATED_EVENT) {
        return;
    }
    const ns = args[0];
    if (typeof ns === 'string' && !PREF_NAMESPACES.includes(ns)) {
        return;
    }
    void readChatPrefs();
}

/**
 * 订阅四项偏好的取值变化（仅在成功读到且与上次通知值不同时回调；读失败不回调）。
 * @param cb - 变化回调
 * @returns 退订函数（最后一个订阅者退订时释放 $events 流订阅）
 */
export function subscribeChatPrefs(cb: (prefs: DshChatPrefs) => void): () => void {
    subscribers.add(cb);
    if (unsubscribeStream === undefined) {
        unsubscribeStream = dshEvents.subscribeStream({
            onEmit,
            // 断线期间的 emit 不补发：重连后重读一次对齐
            onReady: () => {
                void readChatPrefs();
            },
        });
    }
    void readChatPrefs(); // 立即读一次，让新订阅者尽快拿到当前值
    return () => {
        subscribers.delete(cb);
        if (subscribers.size === 0 && unsubscribeStream !== undefined) {
            unsubscribeStream();
            unsubscribeStream = undefined;
        }
    };
}
