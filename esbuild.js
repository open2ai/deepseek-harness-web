// 扩展宿主（Node 侧）构建：esbuild 打包 `src/extension.ts` → `dist/extension.js`（CJS）。
//
// 跑法：
//   node esbuild.js              一次性构建（`pnpm compile` 用它；非生产档带 sourcemap）
//   node esbuild.js --watch      监听 src/** 重建（`pnpm watch:esbuild`，`pnpm watch` 里的一路）
//   node esbuild.js --production 压缩 + 不带 sourcemap（`pnpm package` 用它，再由 vsix 打包）
//
// 与页面侧的分工：这里只管宿主；`webview/chat/**` 由 `scripts/build-chat.mjs` 单独打包成
// `dist/chat/{chat.js,chat.css}` —— **两边互不触发**，所以只跑 `--watch` 时改了页面代码不会重建
//（这一点是当年"改了没效果"的成因之一，见那个脚本头部）。
//
// `dist/extension.js` 就是 `package.json` 的 `main`，且没有外部依赖进包（`node_modules` 被
// `.vscodeignore` 排除）：所以 `external: ['vscode']` 之外的**一切都必须打进这个文件**。
//
// 已知小坑：esbuild 只写不删 —— 先跑非生产档（生成了 `extension.js.map`）再跑 `--production` 时，
// 那个 `.map` 会**留在 `dist/` 里**（产物本身没问题；`.vscodeignore` 有 `**/*.map`，不会进包）。
const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * 构建起止与报错的日志插件。
 *
 * 为什么要它：`logLevel: 'silent'`（下面那行）会连"开始/结束"一起吞掉 —— watch 时看不出
 * 到底有没有在重建、也看不出编译失败（静默失败会让人以为"改了没效果"）。它把起止补回来，
 * 并把错误按 `文件:行:列` 打出来；`.vscode/tasks.json` 里 `npm: watch:esbuild` 那条任务用
 * `beginsPattern` = 这里的 `[watch] build started`、`endsPattern` = `[watch] build finished`
 * 判断"后台任务已就绪"，并把 `✘ [ERROR]` 行收进 Problems 面板 —— **这两条日志串是任务契约，改文案要同步改那边**。
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		target: ['es2023'],
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* 日志插件放最后（它只挂钩子，顺序不影响产出） */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
