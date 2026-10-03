// 契约验收：`session/control` 的帧形状能被正确归约（**只覆盖 0.1.7+**；旧代承载改为"明确报告"）。
//
// 为什么单独一个脚本而不是单测：这一层的失效方式是**静默**的（上游换形状 → 队列卡变空，不报错），
// 所以必须能直接喂帧、直接断言。跑法：node scripts/verify-control-frames.mjs
//
// 覆盖上游 0.1.7 的真实帧形状（取自 `session-controller/src/types.ts`）；
// 0.1.5-rc.x 的 `queues`/`queue` 帧自 v0.1.15 起不再读，但必须走 `onLegacyHost` 报告（见文末用例）。
import { build } from 'esbuild';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const result = await build({
    entryPoints: [path.join(root, 'src/dsh/control.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['es2023'],
    write: false,
    external: ['vscode'],
    logLevel: 'silent',
});
const code = result.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const { reduceControlFrame } = mod;

const SID = 'sess-1';
let failures = 0;
const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ok   ${name}`);
        return;
    }
    failures += 1;
    console.log(`  FAIL ${name}\n       期望 ${e}\n       实际 ${a}`);
};

/** 收集回调的测试壳。 */
function harness() {
    const queues = [];
    const projections = [];
    const baselines = [];
    const legacyHost = [];
    return {
        queues,
        projections,
        baselines,
        legacyHost,
        handlers: {
            onQueue: (sessionId, items) => queues.push({ sessionId, items }),
            onProjection: (sessionId, key, value) => projections.push({ sessionId, key, value }),
            onProjectionBaseline: (bySession) => baselines.push(bySession),
            onLegacyHost: (detail) => legacyHost.push(detail),
        },
        lastQueue: () => (queues.length === 0 ? undefined : queues[queues.length - 1].items),
    };
}

/** 上游 0.1.7 的一条 inbox 消息（UserMessage）。 */
const userMessage = (id, text, rpcId) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', ...(rpcId === undefined ? {} : { rpcId }) },
});
const contextMessage = (id) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text: 'recalled context' }],
    source: { kind: 'recall', references: [] },
});
const inbox = (nextTurn, nextStep) => ({ 'next-turn': nextTurn, 'next-step': nextStep });

console.log('0.1.7-alpha.2：baseline 里的 inbox 投影');
{
    const h = harness();
    const seq = new Map();
    reduceControlFrame(
        {
            type: 'baseline',
            value: {
                // 注意：0.1.7 的 baseline **没有** queues 字段（上游已删）
                projections: {
                    [SID]: {
                        asOfSeq: 42,
                        values: {
                            inbox: inbox([userMessage('m1', '排队的', 'req-1')], [userMessage('m2', '插话的'), contextMessage('m3')]),
                            todos: null,
                        },
                    },
                },
            },
        },
        h.handlers,
        seq
    );
    check('队列条数与顺序', h.lastQueue().map((i) => [i.id, i.placement]), [
        ['m1', 'queued'],
        ['m2', 'steering'],
        ['m3', 'context'],
    ]);
    check('rpcId 从 source 取出', h.lastQueue()[0].rpcId, 'req-1');
    check('插话项无 rpcId', 'rpcId' in h.lastQueue()[1], false);
    check('正文块原样保留', h.lastQueue()[0].content, [{ type: 'text', text: '排队的' }]);
    check('非 inbox 的键照旧转发', h.projections.map((p) => p.key), ['todos']);
    check('inbox 不进投影通道（上下文原文不下发页面）', h.baselines[0].get(SID)['inbox'], undefined);
    check('基线整表下发', h.baselines.length, 1);
}

console.log('0.1.7-alpha.2：inbox 的 projection 帧');
{
    const h = harness();
    const seq = new Map();
    reduceControlFrame({ type: 'projection', sessionId: SID, key: 'inbox', value: inbox([userMessage('m1', '排队')], []), seq: 10 }, h.handlers, seq);
    check('整值替换', h.lastQueue().map((i) => i.placement), ['queued']);
    reduceControlFrame({ type: 'projection', sessionId: SID, key: 'inbox', value: inbox([], []), seq: 11 }, h.handlers, seq);
    check('清空可见', h.lastQueue(), []);
    reduceControlFrame({ type: 'projection', sessionId: SID, key: 'inbox', value: inbox([userMessage('m1', '排队')], []), seq: 10 }, h.handlers, seq);
    check('旧 seq 的帧被丢弃（不复活已取走的条目）', h.lastQueue(), []);
    check('水位推进到最大 seq', seq.get(SID), 11);
}

console.log('0.1.7-alpha.2：交错到达的水位');
{
    const h = harness();
    const seq = new Map();
    // 新帧先到
    reduceControlFrame({ type: 'projection', sessionId: SID, key: 'inbox', value: inbox([userMessage('new', '新')], []), seq: 20 }, h.handlers, seq);
    // 旧基线后到：不能把新值冲回旧值
    reduceControlFrame(
        { type: 'baseline', value: { projections: { [SID]: { asOfSeq: 5, values: { inbox: inbox([userMessage('old', '旧')], []) } } } } },
        h.handlers,
        seq
    );
    check('旧基线不改队列', h.queues.map((q) => q.items.map((i) => i.id)), [['new']]);
}

console.log('旧代（0.1.5-rc.x）承载：不再读，但必须报告');
{
    const h = harness();
    const seq = new Map();
    reduceControlFrame(
        {
            type: 'baseline',
            value: {
                queues: {
                    [SID]: [
                        { id: 'l1', placement: 'queued', rpcId: 'req-9', message: { id: 'l1', content: [{ type: 'text', text: '旧版排队' }] } },
                        { id: 'l2', placement: 'context', message: { id: 'l2', content: [] } },
                    ],
                },
                projections: { [SID]: { asOfSeq: 3, values: { todos: [] } } },
            },
        },
        h.handlers,
        seq
    );
    check('旧代 baseline 不产生队列条目（不再双形状嗅探）', h.lastQueue(), undefined);
    check('旧代 baseline 被明确报告', h.legacyHost.length, 1);
    check('同批的非队列投影照旧转发', h.projections.map((p) => p.key), ['todos']);
    reduceControlFrame({ type: 'queue', sessionId: SID, items: [{ id: 'l3', placement: 'steering', message: { content: [{ type: 'text', text: '插话' }] } }] }, h.handlers, seq);
    check('旧代 queue 帧不产生条目', h.lastQueue(), undefined);
    check('旧代 queue 帧也被报告', h.legacyHost.length, 2);
    // 这行只进日志（console.warn）：给用户的通知是 dshService 里写死的固定文案
    check('detail 指向旧承载', h.legacyHost[0].includes('queues'), true);
    // 版本标识要写全：带 dsh 前缀与预发布号（`0.1.7` 这种分不清 alpha / rc / 正式版）
    check('detail 里的版本标识写全', h.legacyHost[0].includes('dsh-0.1.7-rc.1'), true);
    // 对端版本推不出来：不得把承载归因到某个旧版本（旧代沿革在文件头与归档里）
    check('detail 不把承载归因到旧版本', /dsh-0\.1\.[0-6]/.test(h.legacyHost[0]), false);
}

console.log('0.1.7-alpha.2：权限目录与投影拼接');
{
    // 上游 0.1.7 的 permissions 投影只剩 currentValue；选项目录在进程级 remote。
    const catalog = [
        { value: 'read-only', name: '只读' },
        { value: 'workspace-write', name: '工作区可写' },
        { value: 'danger-full-access', name: '完全访问' },
    ];
    const h = harness();
    const seq = new Map();
    const permissionValues = new Map();
    const onPerm = (sessionId, value) => permissionValues.set(sessionId, value);
    reduceControlFrame({ type: 'projection', sessionId: SID, key: 'permissions', value: { currentValue: 'read-only' }, seq: 5 }, h.handlers, seq, catalog, onPerm);
    const perms = () => h.projections.filter((p) => p.key === 'permissions').at(-1).value;
    check('拼回旧形状的 options', perms().options.map((o) => o.value), ['read-only', 'workspace-write', 'danger-full-access']);
    check('currentValue 透传', perms().currentValue, 'read-only');
    check('记录的是原始值（不含 options）', permissionValues.get(SID), { currentValue: 'read-only' });

    // 目录未到（读取失败 / 0.1.5）：原样透传，不能清空消费方已有的一份
    const h2 = harness();
    const seq2 = new Map();
    reduceControlFrame({ type: 'projection', sessionId: SID, key: 'permissions', value: { currentValue: 'x' }, seq: 5 }, h2.handlers, seq2, undefined, () => {});
    check('目录缺失时不塞 options 键', Object.hasOwn(h2.projections[0].value, 'options'), false);

    // 派生 custom：当前值不在目录里，上游会派生一条
    const h3 = harness();
    const seq3 = new Map();
    reduceControlFrame({ type: 'projection', sessionId: SID, key: 'permissions', value: { currentValue: 'custom' }, seq: 6 }, h3.handlers, seq3, catalog, () => {});
    check('custom 派生项被追加', h3.projections[0].value.options.map((o) => o.value), ['read-only', 'workspace-write', 'danger-full-access', 'custom']);

    // 基线里的 permissions 同样要拼
    const h4 = harness();
    const seq4 = new Map();
    reduceControlFrame(
        { type: 'baseline', value: { projections: { [SID]: { asOfSeq: 9, values: { permissions: { currentValue: 'read-only' } } } } } },
        h4.handlers,
        seq4,
        catalog,
        () => {}
    );
    check('基线里的 permissions 也拼目录', h4.projections[0].value.options.length, 3);
    check('基线整表里 permissions 保持上游原样', h4.baselines[0].get(SID)['permissions'], { currentValue: 'read-only' });
}

console.log('坏形状：静默忽略，绝不抛');
{
    const h = harness();
    const seq = new Map();
    for (const bad of [
        undefined,
        null,
        42,
        'x',
        {},
        { type: 'jobs', sessionId: SID, jobs: [] },
        { type: 'projection', sessionId: SID, key: 'inbox', value: null, seq: 1 },
        { type: 'projection', sessionId: SID, key: 'inbox', value: { 'next-turn': 'not-an-array' }, seq: 2 },
        { type: 'projection', sessionId: SID, key: 'inbox', value: inbox([{ noId: true }], []), seq: 3 },
        { type: 'baseline', value: { queues: 'nope', projections: 7 } },
    ]) {
        try {
            reduceControlFrame(bad, h.handlers, seq);
        } catch (error) {
            failures += 1;
            console.log(`  FAIL 抛异常：${String(error)} <- ${JSON.stringify(bad)}`);
        }
    }
    check('坏形状不产生条目', h.queues.every((q) => q.items.length === 0), true);
    console.log('  ok   坏形状全部静默');
}

console.log('');
if (failures > 0) {
    console.log(`✘ ${failures} 项不符`);
    process.exit(1);
}
console.log('✔ 全部通过：0.1.7+ 帧形状正确归约，旧代承载明确报告');
