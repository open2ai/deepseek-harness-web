// 输入框键位判定：**纯函数**（不碰 DOM、不读 store），调用点只按结果派发。
//
// 为什么单独成模块：键位是「谁先 preventDefault、谁最终 send」的顺序问题 —— 夹在组件里只能靠真机
// 一个个按键去试，抽出来后每种组合都能脚本级断言（`tmp/_keys.test.mjs`）。
//
// 语义（投递方式那条判据**只此一处**，主钮也调它）：
//   · 发送键 = `Enter`；换行 = `Shift+Enter`（**无条件**，在仲裁之前判定）；
//   · `Enter` 与 `Ctrl/Cmd+Enter` 都只是**投递手势**（`enter` / `accelerated`），投递方式一律由
//     `resolveSubmitMode` 决定 —— **没有"换行手势"这一支**：
//         空闲或不支持插话 → `queue`（此时按哪个键都只是普通发送）；
//         在跑时 = `enter` 用手势偏好的值、`accelerated` 取它的反面。
//   · 弹层打开时 `Enter`/`Tab` 归弹层（选中候选），不发送；
//   · 已认领的命令行（`/命令 参数…`）：提交换行 = **执行命令**（加速手势也只是另一种 submit 手势）；
//     已认领的技能行与普通正文同路（它本来就是一封普通消息）；
//   · 空草稿 + 在跑 + 有排队项 + 支持插话 = **整队插话**（上游 `canSteerQueue` 的四项；不发空消息）。

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
  /**
   * 这段会话的传输**支不支持插话**：不支持时投递方式一律退成 `queue`（判据见 `resolveSubmitMode`）。
   *
   * 本插件的 composer 只作用于**当前会话**、不寻址子代理，所以它恒为真；留成输入是为了让
   * 那条判据有落点（将来真做子代理寻址时直接接上，无需再改别处）。
   */
  steeringAvailable?: boolean
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
  const steeringAvailable = ctx.steeringAvailable !== false
  const empty = ctx.text.trim() === ''
  // ④ 已认领的命令行：**提交即执行**，与手势无关 —— 上游把加速手势也只当作一种 submit 手势
  //   （`view-binding.ts` 的 `keyboard.submit(resolveSubmitMode(...))`），提交换行就是执行命令。
  //   ⚠️ 不在这里放行技能行：技能行就是一封普通消息，投递方式照下面按手势解（上游同）。
  if (ctx.claim === 'command') {
    return { action: 'run-command' }
  }
  // ⑤ 空草稿：退化为**整队插话**（上游 `canSteerQueue`：`!locked && !machineBusy && !commandMenuOpen
  //   && empty && running && steeringAvailable`；本插件对应的四项是后三条 + 真有排队项）。
  //   不满足时什么也不做 —— 避免发出空消息。
  if (empty) {
    return ctx.running && steeringAvailable && ctx.queued ? { action: 'steer-whole-queue' } : { action: 'none' }
  }
  // ⑥ 交付方式：逐条镜像上游 `resolveSubmitMode`
  return { action: 'send', mode: resolveSubmitMode(ctx, accelerated ? 'accelerated' : 'enter') }
}

/**
 * 一次提交手势的投递方式：**主钮与 `Enter` 共用这一条**（各写一遍必然走岔）。
 *
 * 规则三句：
 * ```
 * 没在跑、或这段会话不支持插话 → 'queue'（此时手势无关）
 * 手势是 enter（含发送按钮）    → 偏好值 ctx.busyEnter
 * 手势是 accelerated           → 偏好的反面
 * ```
 * @param ctx - 只用这三件事：在跑、偏好、是否支持插话
 * @param gesture - 两种提交手势：`enter`（含发送按钮）或 `accelerated`（Cmd/Ctrl+Enter）
 */
export function resolveSubmitMode(
  ctx: Pick<InputKeyContext, 'running' | 'busyEnter' | 'steeringAvailable'>,
  gesture: 'enter' | 'accelerated',
): 'queue' | 'steer' {
  const preferred: 'queue' | 'steer' = ctx.busyEnter === 'steer' ? 'steer' : 'queue'
  if (!ctx.running || ctx.steeringAvailable === false) {
    return 'queue'
  }
  if (gesture === 'enter') {
    return preferred
  }
  return preferred === 'queue' ? 'steer' : 'queue'
}
