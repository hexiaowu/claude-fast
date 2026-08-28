import type { ClaudeFastApi } from "./electron-api";

/** Electron 后端（主进程 IPC）命令封装；函数签名与 Tauri 版保持一致，
 *  各 UI 组件无需感知后端实现。 */
export const api: ClaudeFastApi = window.claudeFast;
