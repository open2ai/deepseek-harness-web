// 工作区下拉：对外仍叫 createWorkspaceDropdown（titlebar 调用不变），
// 实现已切到 Preact 组件 `WorkspacePopup.ts`。
//
// 旧命令式 DOM 实现已删除；这里只保留兼容导出，后续 titlebar 可直接 import mountWorkspacePopup。
export {
  mountWorkspacePopup as createWorkspaceDropdown,
  statusOf,
  type WorkspacePopup as WorkspaceDropdown,
  type WorkspacePopupApi,
  type WsDropdownItem,
  type WsSessionItem,
} from './WorkspacePopup'
