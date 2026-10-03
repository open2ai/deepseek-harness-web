// 宿主下发的「行」→ 页面行模型的映射（阶段 4，见 docs/design/08 §11）。
//
// 纯函数：宿主只给**事实**（文本 / 链 / 状态 / 计数 / 附件引用），展示派生（工具标题与摘要、时钟）
// 由页面按既有函数算 —— 映射因此不引入第二份业务判断。行**形状**直接 `import type` 宿主定义
// （方向 webview → src，§7.7 允许），避免两处重复声明同一个契约。
//
// **字段搬运一律 spread**：宿主形状是页面形状的**子集**，多出来的字段自动透传。
// 逐字段列举抄漏过一次（`meta` 没搬 → 网页卡与读卡静默退回通用卡），spread 让这类遗漏在结构上不可能。
import { deriveToolSummary, formatMsgClock, toolTitle } from '../format'
import type { DshRowItem, DshStreamRow } from '../../../../src/dsh/rows/types'
import type { ChatRow, DshTurnProcessItem } from './types'

/** 宿主行 → 页面行。键沿用宿主给的值，保证同一行在两侧可配对。 */
export function toChatRows(rows: readonly DshStreamRow[]): ChatRow[] {
  return rows.map(toChatRow)
}

function toChatRow(r: DshStreamRow): ChatRow {
  if (r.kind === 'user') {
    return {
      kind: 'user',
      key: r.key,
      text: r.text,
      // 实时发送的内联图在页面本地行上（宿主只给附件引用），认领时由 applyHostRows 合并回来
      images: [],
      time: r.timeMs !== undefined ? formatMsgClock(r.timeMs) : '',
      ...(r.rpcId !== undefined ? { rpcId: r.rpcId } : {}),
      // 插话分类（宿主按收件箱 splice 史判）：只作语义标记，外观与普通提问一致
      ...(r.steering === true ? { steering: true } : {}),
      ...(r.imageRefs !== undefined ? { imageRefs: r.imageRefs } : {}),
      ...(r.files !== undefined ? { files: r.files } : {}),
    }
  }
  if (r.kind === 'sysprompt') {
    return { kind: 'sysprompt', key: r.key, text: r.text }
  }
  if (r.kind === 'turnNotice') {
    // 终局通知行：宿主只给事实（tone/message/code/turn/step），文案由页面决议
    return {
      kind: 'turnNotice',
      key: r.key,
      tone: r.tone,
      ...(r.turn === undefined ? {} : { turn: r.turn }),
      ...(r.step === undefined ? {} : { step: r.step }),
      ...(r.message === undefined ? {} : { message: r.message }),
      ...(r.code === undefined ? {} : { code: r.code }),
    }
  }
  return {
    kind: 'assistant',
    key: r.key,
    // 时钟由页面格式化（宿主只给时刻事实）
    time: r.timeMs !== undefined ? formatMsgClock(r.timeMs) : '',
    done: r.done,
    prompt: '',
    text: r.text,
    stats: '',
    chain: r.chain.map(toChainItem),
    counts: r.counts,
    bodyStarted: true,
    ...(r.turn !== undefined ? { turn: r.turn } : {}),
    ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.process !== undefined ? { process: r.process } : {}),
    // 过程分组（上游 step-group）：宿主只给分界与每片自己的事实，怎么渲染由页面决定
    ...(r.process?.groups === undefined ? {} : { groups: r.process.groups }),
    ...(r.interrupted === true ? { interrupted: true } : {}),
    ...(r.seq !== undefined ? { seq: r.seq } : {}),
    ...(r.messageId !== undefined ? { messageId: r.messageId } : {}),
    // 交付文件（模型声明）：回合尾部那一区读它，缺省即本回合没有声明
    ...(r.presentedFiles !== undefined ? { presentedFiles: r.presentedFiles } : {}),
    // 用量 / 用时：动作条的图标与弹窗读这个字段（与既有实时通路同名，组件无需感知来源变了）
    ...(r.stats !== undefined ? { usageRaw: r.stats } : {}),
  }
}

function toChainItem(c: DshRowItem): DshTurnProcessItem {
  if (c.kind === 'reasoning') {
    return { ...c }
  }
  if (c.kind === 'context') {
    return { ...c }
  }
  if (c.kind === 'text') {
    return { ...c }
  }
  return {
    ...c,
    // 标题与摘要是**展示派生**：宿主不产出，页面按既有函数算（同一份实现）
    title: toolTitle(c.name),
    summary: deriveToolSummary(c.argsRaw, c.name),
  }
}
