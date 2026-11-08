// 打包：先由 package.json 的 pnpm vsix 前置执行 pnpm run package，
// 这里直接用 @vscode/vsce 的 pack（跳过 vscode:prepublish，避免 vsce 子进程里 tsc OOM）。
// 产物名带版本号：release/deepseek-harness-web-<version>.vsix（version 取自 package.json）。
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pack } = require('@vscode/vsce/out/package');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = (pkg && pkg.version) || '0.0.0';
// 打包前硬校验：编辑器 chunk 必须真实产出（缺失时**拒绝打包**，而不是装到用户那里再静默回退）。
const chunk = 'dist/chat/lexical.js';
if (!existsSync(chunk)) {
    throw new Error('拒绝打包：缺少 ' + chunk + '（可选编辑器 chunk 未产出）');
}
const chunkSize = statSync(chunk).size;
if (chunkSize < 100_000) {
    throw new Error('拒绝打包：' + chunk + ' 仅 ' + String(chunkSize) + ' bytes（产出异常）');
}
const chatJs = readFileSync('dist/chat/chat.js', 'utf8');
if (!chatJs.includes('dsh-composer-editor')) {
    throw new Error('拒绝打包：chat.js 没有请求宿主注入编辑器 chunk URI（页面/宿主版本不匹配）');
}
console.log('OK 编辑器 chunk：' + String(chunkSize) + ' bytes');
mkdirSync('release', { recursive: true });
try {
    const result = await pack({
        cwd: process.cwd(),
        packagePath: `release/deepseek-harness-web-${version}.vsix`,
        allowMissingRepository: true,
        useYarn: false,
    });
    console.log(`DONE ${result.packagePath}`);
} catch (e) {
    console.error(e);
    process.exitCode = 1;
}
