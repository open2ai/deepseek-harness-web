// 聊天 webview 构建：esbuild 打包 chat.ts → dist/chat/chat.js，并拷贝 index.html
//
// 跑法：
//   node scripts/build-chat.mjs              一次性构建（`pnpm build:chat` / `pnpm compile` 用它）
//   node scripts/build-chat.mjs --watch      监听 webview/chat 重建（`pnpm watch:chat`）
//   node scripts/build-chat.mjs --production 压缩产出（`pnpm package` 用）
//
// ⚠️ **为什么要 `--watch`**（2026-10-12 真机教训）：`pnpm watch` 只跑宿主侧那半边
//（`watch:esbuild` = `node esbuild.js --watch`，只盯 `src/`），页面侧**没有任何监听** ——
// 改了 `webview/chat/**` 而只跑 `tsc` 的话，`dist/chat/chat.js` 还是旧的，
// 于是"改了没效果"（当天为此白折腾几轮：产物里 grep 不到刚加的判据）。
import { build, context } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const chatDir = path.join(root, 'webview', 'chat')
const outDir = path.join(root, 'dist', 'chat')

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

// 清空旧产物（避免残留 TinyRobot 的旧 bundle）
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/** 静态件（HTML/CSS）也一并拷 —— watch 时每次重建都拷，保证页面侧三件套同版本。 */
function copyStatics() {
  cpSync(path.join(chatDir, 'index.html'), path.join(outDir, 'index.html'))
  cpSync(path.join(chatDir, 'codicon.css'), path.join(outDir, 'codicon.css'))
}

const options = {
  entryPoints: [path.join(chatDir, 'chat.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  outfile: path.join(outDir, 'chat.js'),
  minify: production,
  logLevel: watch ? 'info' : 'silent',
  // KaTeX 的 CSS 里用 `url(fonts/KaTeX_*.woff2)` 引字体：按**文件**输出到 dist/chat/assets，
  // CSS 里的相对地址由 esbuild 自动改写 —— webview 从扩展目录加载 chat.css，相对路径可直接取到。
  // 不做 dataurl：那会把 ~1MB 字体塞进 CSS，首屏多解析一大坨 base64。
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  assetNames: 'assets/[name]-[hash]',
}

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{
      name: 'dsh-copy-statics',
      setup(b) {
        b.onEnd((result) => {
          if (result.errors.length > 0) {
            console.error('[chat] 构建失败（产物未更新）')
            return
          }
          copyStatics()
          console.log('[chat] rebuilt → dist/chat')
        })
      },
    }],
  })
  await ctx.watch()
  console.log('[chat] watching webview/chat/** …')
} else {
  await build(options)
  copyStatics()
  console.log('[chat] built → dist/chat')
}
