// 输入框键位判定：**纯函数**（不碰 DOM、不读 store），调用点只按结果派发。
//
// 为什么单独成模块：键位是「谁先 preventDefault、谁最终 send」的顺序问题 —— 夹在组件里只能靠真机
// 一个个按键去试，抽出来后每种组合都能脚本级断言（`tmp/_keys.test.mjs`）。
//
// 语义（跟随「设置 → 通用设置 → 繁忙时的发送行为」）：
//   · 发送键 = `Enter`；换行 = `Shift+Enter`（**无条件**，在仲裁之前判定）；
//   · `Enter` 的投递方式 = `ctx.busyEnter`（上游默认 `queue` = 发送但不打断当前生成）；
//   · `Ctrl/Cmd+Enter` = "加速"手势：**取相反值**（偏好 queue 时插话、偏好 steer 时排队）——
//     与上游 `resolveSubmitMode` 同口径（`gesture !== 'enter'` 返回偏好的反面）；空闲时**换行**（这条是插件有意偏离，见 `12` §5）；
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
  /** 上游「繁忙时的发送行为」：`Enter` 的投递方式（缺省 = 上游默认 `queue`）。 */
  busyEnter?: 'queue' | 'steer'
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
  // ④ 已认领行优先于加速手势：命令要执行、技能要照常发出（加速手势则按相反投递方式发）
  if (!accelerated) {
    if (ctx.claim === 'command') {
      return { action: 'run-command' }
    }
    if (ctx.claim === 'skill') {
      return submit(ctx)
    }
  }
  // ⑤ "加速"手势（`Ctrl/Cmd+Enter`）：空闲时**换行**、回合在跑时按**偏好的反面**投递
  //    —— 与上游 `resolveSubmitMode` 同口径（`enter` 用偏好本身，其它手势取反面）。
  //    （上游没有"换行"这一支：它非忙时也返回 queue。这条是**有意偏离**，登记在 `12` §5；
  //      空草稿时仍与上游同构 —— 转成整队插话。）
  if (accelerated) {
    if (ctx.running) {
      if (empty) {
        return ctx.queued ? { action: 'steer-whole-queue' } : { action: 'none' }
      }
      return { action: 'send', mode: opposite(ctx) }
    }
    return { action: 'newline' }
  }
  // ⑥ 发送键（`Enter`）：空草稿时退化为整队插话（仅当队列里真有排队项；否则什么也不做，避免发空消息）
  if (empty) {
    return ctx.running && ctx.queued ? { action: 'steer-whole-queue' } : { action: 'none' }
  }
  return submit(ctx)
}

/** 偏好（缺省 = 上游默认 `queue`）。 */
function preferred(ctx: InputKeyContext): 'queue' | 'steer' {
  return ctx.busyEnter === 'steer' ? 'steer' : 'queue'
}

/** 加速手势的投递方式 = 偏好的反面（上游 `resolveSubmitMode`：非 `enter` 手势取反面）。 */
function opposite(ctx: InputKeyContext): 'queue' | 'steer' {
  return preferred(ctx) === 'queue' ? 'steer' : 'queue'
}

/**
 * 发送手势（`Enter` / 技能行）的投递方式 = 上游「繁忙时的发送行为」的偏好值。
 * 偏好 `queue`（上游默认）时：空闲即普通发送、繁忙时保持「发送但不打断当前生成」。
 */
function submit(ctx: InputKeyContext): InputKeyDecision {
  return { action: 'send', mode: preferred(ctx) }
}
