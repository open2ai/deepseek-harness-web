// 断点续折的**校验抽样**策略（零依赖模块）。
//
// 为什么单独一个文件：这段要被**宿主主逻辑**用（`api/dshService.ts`），也要被**守卫直接调用**
// 断言行为（`tmp/_useratts.test.mjs`）。放在 `dshService.ts` 里的话，守卫一 import 就把
// `vscode` 也拉进来（探针环境没有它）—— 判据就只能退化成"搜源码字符串"，而抽样间隔这类东西
// 恰恰最容易在重构时被悄悄改回固定值。

/**
 * **小会话**的校验间隔：每这么多次**复用旧断点**的构建，全量重折一遍做逐字节比对。
 *
 * 校验防的是「断点折叠与全量折叠不等价」—— 真出现了就**以全量为准并丢弃断点**，
 * 而不是让正文悄悄错一段。等价性本身由 `tmp/_rows.checkpoint.test.mjs` 在真机会话上
 * 逐回合钉着（那是判据），生产这层是按轮次抽样的**兜底自愈**。
 */
export const CHECKPOINT_VERIFY_EVERY = 5;

/**
 * **大会话**的校验间隔（2026-10-12 加）。
 *
 * 为什么：校验那一次是**全量重折整个窗口**，成本随会话线性涨 —— 实测 4MB 会话全量一次
 * **1074ms**、13MB（130 万事件）会话 **2644ms**（`tmp/_rows.perf.probe.mjs`）。
 * 固定"每 5 次一次"在大会话上就是**每 5 帧卡 2.6 秒**，而这期间用户只是在看流式输出。
 * 判据没变（仍是"断点与全量逐字节等价"），只是大会话里抽得更稀。
 */
export const CHECKPOINT_VERIFY_EVERY_LARGE = 50;

/** 窗口事件数超过它就按 `CHECKPOINT_VERIFY_EVERY_LARGE` 抽样（13MB 会话约 130 万条）。 */
export const CHECKPOINT_VERIFY_LARGE_EVENTS = 200_000;

/**
 * 这次构建要不要做全量校验（按窗口规模与抽样计数决定）。
 * @param events - 当前窗口事件数。
 * @param uses - 已复用断点的次数。
 * @returns 需要校验时为 true。
 */
export function shouldVerifyCheckpoint(events: number, uses: number): boolean {
    const every = events >= CHECKPOINT_VERIFY_LARGE_EVENTS ? CHECKPOINT_VERIFY_EVERY_LARGE : CHECKPOINT_VERIFY_EVERY;
    return uses % every === 0;
}
