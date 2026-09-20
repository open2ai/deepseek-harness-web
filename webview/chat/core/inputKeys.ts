// 输入框键位判定：**纯函数**（不碰 DOM、不读 store），调用点只按结果派发。
//
// 为什么单独成模块：键位是「谁先 preventDefault、谁最终 send」的顺序问题 —— 夹在组件里只能靠真机
// 一个个按键去试，抽出来后每种组合都能脚本级断言（`tmp/_keys.test.mjs`）。
//
// 语义（**固定与宿主页面同口径**，没有插件自己的"发送键"配置）：
//   · 发送键 = `Enter`；换行 = `Shift+Enter`（**无条件**，在仲裁之前判定）；
//   · `Ctrl/Cmd+Enter` = "加速"手势：空闲时**换行**、回合在跑时**插话**（不排队）；
//   · 弹层打开时 `Enter`/`Tab` 归弹层（选中候选），不发送；
//   · 已认领的命令行（`/命令 参数…`）：Enter 执行命令；已认领的技能行：Enter 按普通消息发出；
//   · 空草稿 + 有排队项时按发送键/加速手势 = **整队插话**（不发空消息）。

/** 判定用的按键事实（只取用得到的字段，便于脚本造事件）。 */
export interface InputKeyEvent {
  key: string
  ctrlKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
}

/** 当前输入状态：是否在跑、草稿、弹层、已认领行、队列。 */
export interface InputKeyContext {
  /** 草稿原文（判定空输入与已认领行都要它）。 */
  text: string
  /** 触发弹层（`/`、`@`）是否开着。 */
  menuOpen: boolean
  /** 已认领行：命令（`/命令 参数…`）或技能行；null = 普通正文。 */
  claim: 'command' | 'skill' | null
  /** 宿主的权威「一轮在跑」。 */
  running: boolean
  /** 队列里有排队项（空输入下的整队插话手势要用）。 */
  queued: boolean
}

/** 判定结果：调用点按 `action` 派发，`preventDefault` 由调用点统一执行。 */
export type InputKeyDecision =
  | { action: 'none' }
  | { action: 'newline' }
  | { action: 'menu-pick' }
  | { action: 'run-command' }
  | { action: 'send'; mode: 'queue' | 'steer' }
  | { action: 'steer-whole-queue' }

/** 输入法合成中的 Enter：既不发送也不换行，交给输入法自己收尾。 */
const IME: InputKeyDecision = { action: 'none' }

/**
 * 判定一次 keydown。
 * @param e - 键盘事件（只读 key/修饰键/合成态）
 * @param ctx - 当前输入状态
 * @returns 该动作；调用点据此 preventDefault 并派发
 */
export function decideInputKey(e: InputKeyEvent, ctx: InputKeyContext): InputKeyDecision {
  // ① 合成中优先于一切：中文/日文选词那一下 Enter 不能当发送（否则选词即误发）
  if (e.isComposing === true) {
    return IME
  }
  // ② Shift+Enter：无条件换行（在弹层仲裁之前）
  if (e.key === 'Enter' && e.shiftKey === true) {
    return { action: 'newline' }
  }
  // ③ 弹层打开：Enter/Tab 归弹层（选中候选、目录下钻）
  if (ctx.menuOpen && (e.key === 'Enter' || e.key === 'Tab')) {
    return { action: 'menu-pick' }
  }
  if (e.key !== 'Enter') {
    return { action: 'none' }
  }

  const accelerated = e.ctrlKey === true || e.metaKey === true
  const empty = ctx.text.trim() === ''
  // ④ 已认领行优先于加速手势：命令要执行、技能要照常发出（加速手势则按插话发）
  if (!accelerated) {
    if (ctx.claim === 'command') {
      return { action: 'run-command' }
    }
    if (ctx.claim === 'skill') {
      return submit()
    }
  }
  // ⑤ "加速"手势（`Ctrl/Cmd+Enter`）：空闲时**换行**、回合在跑时**插话**（投到当前回合的下一步）
  //    —— 这正是它作为"加速"手势的意义：忙时给你一个不排队的投递方式。
  //    （上游没有"换行"这一支：它的 `resolveSubmitMode` 非忙时也返回 queue。这条是**有意偏离**，
  //      登记在 `12` §5；空草稿时仍与上游同构 —— 转成整队插话。）
  if (accelerated) {
    if (ctx.running) {
      if (empty) {
        return ctx.queued ? { action: 'steer-whole-queue' } : { action: 'none' }
      }
      return { action: 'send', mode: 'steer' }
    }
    return { action: 'newline' }
  }
  // ⑥ 发送键（`Enter`）：空草稿时退化为整队插话（仅当队列里真有排队项；否则什么也不做，避免发空消息）
  if (empty) {
    return ctx.running && ctx.queued ? { action: 'steer-whole-queue' } : { action: 'none' }
  }
  return submit()
}

/**
 * 投递方式：**发送手势**一律走"排队" —— 空闲时它就是普通发送，回合在跑时保持
 * 「发送但不打断当前生成」的语义（插话由加速手势给，见上一步分流）。
 */
function submit(): InputKeyDecision {
  return { action: 'send', mode: 'queue' }
}
