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
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { woff2Only } from './katex-css-woff2.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const chatDir = path.join(root, 'webview', 'chat')
const outDir = path.join(root, 'dist', 'chat')

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

// 清空旧产物再重建（`dist/chat` 是**整目录替换**：删掉上一次的 `chat.js`/`chat.css`/`assets/`）。
// ⚠️ 这一步只在**进程启动时**做一次：`--watch` 下每次重建只覆盖文件、不再清目录 ——
// 所以 watch 期间换了输出文件名（如改了 `assetNames`）时，旧文件会残留到下次重启。
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/** 静态件（HTML/CSS）也一并拷 —— watch 时每次重建都拷，保证页面侧三件套同版本。 */
function copyStatics() {
  cpSync(path.join(chatDir, 'index.html'), path.join(outDir, 'index.html'))
  cpSync(path.join(chatDir, 'codicon.css'), path.join(outDir, 'codicon.css'))
}

/**
 * **KaTeX 字体只发 woff2**。
 * 这里只在 `onLoad` 时把每个 `@font-face` 的 `src` 收窄到 woff2 那一项
 */
const katexWoff2Only = {
  name: 'dsh-katex-woff2-only',
  setup(b) {
    b.onLoad({ filter: /katex[\\/]dist[\\/]katex(\.min)?\.css$/ }, (args) => {
      const raw = readFileSync(args.path, 'utf8')
      // 每个 `src:` 声明只留 woff2 那一段（含它的 `format("woff2")`）；取不到就原样保留。
      // 改写逻辑在 `katex-css-woff2.mjs`（纯函数，守卫 `tmp/_fonts.woff2.test.mjs` 直接喂真实 CSS 断言）。
      const css = woff2Only(raw)
      return { contents: css, loader: 'css', resolveDir: path.dirname(args.path) }
    })
  },
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
  // KaTeX 的 CSS 里用 `url(fonts/KaTeX_*.woff2)` 引字体：按**文件**输出到 `dist/chat/assets/`，
  // CSS 里的相对地址由 esbuild 自动改写成 `./assets/…` —— webview 从扩展目录加载 chat.css，相对路径可直接取到。
  // 不做 dataurl：那会把 ~1MB 字体塞进 CSS，首屏多解析一大坨 base64。
  // **只发 woff2**（见上面 `katexWoff2Only`）：woff/ttf 从不被请求，删掉省 797KB 落盘。
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  // 落点由下面这行 `assetNames` 决定（实测：去掉它就退回 `dist/chat/` 根、URL 变成 `./KaTeX_….woff2`；
  // 见 `tmp/_assetnames.check.mjs`）。它同时约束以后 import 进来的图片等资源。
  assetNames: 'assets/[name]-[hash]',
  plugins: [katexWoff2Only],
}

if (watch) {
  const ctx = await context({
    ...options,
    // ⚠️ 这里要**追加**，不能覆盖 `options.plugins`（覆盖掉就等于 watch 下又发出 60 个字体文件）
    plugins: [...options.plugins, {
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
