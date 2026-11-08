// 工作区模块（宿主侧）公共出口。
//
// 职责边界：
//   - 只放**工作区领域**的纯逻辑/编排：成员表 → 会话行映射、顺序、显示名、
//     切换/恢复/新建会话的宿主流程；
//   - 不 import `extension.ts` / `titlebar/*` / webview，避免循环依赖；
//   - 传输层仍留在 `api/dshService.ts`（RPC/状态），本模块只消费它的结果或注入的窄接口。
//
// 页面侧对应模块：`webview/chat/workspace/`（下拉组件、状态模型、协议常量）。
export * from './sessions'
export * from './service'
