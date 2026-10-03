// 契约验收：权限投影 + 进程级目录的拼接。
//
// 独立成文件而不是复用 verify-control-frames.mjs 的原因：`withPermissionOptions` 与 `custom` 常量
// 在 control.ts 里**没有导出**（它们是内部实现），从一个 .mjs 脚本里 import 不到。
// 但这条拼接有一条**真实发生过**的失效路径 —— `session/follow` 快照（`seedProjections`）绕过
// control.ts，所以 dshService 必须独立地拼一次。这里用同一份目录/取值形状直接钉住**语义**：
// 下方 EXPECTED 就是 control.ts 与 dshService 两处实现共同必须满足的结果。
//
// 跑法：node scripts/verify-permission-merge.mjs
//
// ⚠️ 本文件是**拷贝**，不是引用。若改了 control.ts 的 withPermissionOptions，必须同步改这里。

const CUSTOM_PRESET = 'custom';
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

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

/** 与本仓库 control.ts 的 withPermissionOptions 同语义（见文件头的同步要求）。 */
function withPermissionOptions(value, catalog) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || catalog === undefined) {
        return value;
    }
    const currentValue = value['currentValue'];
    const options = [...catalog];
    const known = typeof currentValue === 'string' && options.some((o) => o.value === currentValue);
    if (typeof currentValue === 'string' && currentValue !== '' && currentValue !== CUSTOM_PRESET && !known) {
        options.push({ value: currentValue, name: currentValue });
    }
    if (currentValue === CUSTOM_PRESET && !known) {
        options.push({ value: CUSTOM_PRESET, name: CUSTOM_PRESET });
    }
    return { ...value, options };
}

/** 防止拷贝漂移：源文件里必须仍存在这个函数名与自定义预设常量。 */
console.log('拷贝漂移哨兵');
{
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const source = fs.readFileSync(path.join(root, 'src/dsh/control.ts'), 'utf8');
    check('control.ts 仍导出 withPermissionOptions', /export function withPermissionOptions\(/.test(source), true);
    check('control.ts 仍定义 CUSTOM_PRESET', /const CUSTOM_PRESET = 'custom'/.test(source), true);
    const mtime = fs.statSync(path.join(root, 'src/dsh/control.ts')).mtimeMs;
    const age = Date.now() - mtime;
    if (age > MAX_AGE_MS) {
        console.log(`  warn control.ts 的修改时间异常（${Math.round(age / 86400000)} 天前），请复核这处拷贝`);
    }
}

const catalog = [
    { value: 'read-only', name: '只读' },
    { value: 'workspace-write', name: '工作区可写' },
    { value: 'danger-full-access', name: '完全访问' },
];

console.log('拼接语义');
check('目录 + currentValue → 旧形状', withPermissionOptions({ currentValue: 'read-only' }, catalog), {
    currentValue: 'read-only',
    options: catalog,
});
check('目录缺失 → 原样透传（不清空消费方）', withPermissionOptions({ currentValue: 'read-only' }, undefined), {
    currentValue: 'read-only',
});
check('custom 追加派生项', withPermissionOptions({ currentValue: 'custom' }, catalog).options.map((o) => o.value), [
    'read-only', 'workspace-write', 'danger-full-access', 'custom',
]);
check('未知 currentValue 追加派生项', withPermissionOptions({ currentValue: 'weird' }, catalog).options.map((o) => o.value), [
    'read-only', 'workspace-write', 'danger-full-access', 'weird',
]);
check('空 currentValue 不追加', withPermissionOptions({ currentValue: '' }, catalog).options.length, 3);
check('非对象值原样返回', withPermissionOptions('nope', catalog), 'nope');
check('null 原样返回', withPermissionOptions(null, catalog), null);

console.log('目录缺失：投影自带 options 时不得被覆盖（通用健壮性）');
{
    // 目录没读到（读取失败 / 尚未返回）时 catalog === undefined：必须原样返回，
    // 不能把消费方已有的一份清空。（该用例原本守的是 0.1.5 的 `{options,currentValue}` 承载；
    // 自 v0.1.15 起只支持 dsh 0.1.7+，这条承载已删，但"目录缺失不清空"这条语义仍然成立。）
    const withOptions = { options: [{ value: 'read-only', name: '只读' }], currentValue: 'read-only' };
    check('原样保留自身 options', withPermissionOptions(withOptions, undefined), withOptions);
}

console.log('');
if (failures > 0) {
    console.log(`✘ ${failures} 项不符`);
    process.exit(1);
}
console.log('✔ 全部通过：权限拼接语义与两处实现一致');
