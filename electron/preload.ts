// preload：contextBridge 暴露受控 API（渲染进程无 Node 权限，全部经 IPC 白名单通道）
import { contextBridge, ipcRenderer } from "electron";

const api = {
  // ---------- 启动脚本 ----------
  listLaunchers: () => ipcRenderer.invoke("list_launchers"),
  loadConfig: () => ipcRenderer.invoke("load_config"),
  saveConfig: (favorites: string[], dark: boolean, closeAction?: string | null) =>
    ipcRenderer.invoke("save_config", { favorites, dark, closeAction }),
  createLauncher: (dir: string) => ipcRenderer.invoke("create_launcher", { dir }),
  deleteLauncher: (file: string) => ipcRenderer.invoke("delete_launcher", { file }),
  launchClaude: (file: string) => ipcRenderer.invoke("launch_claude", { file }),
  openFolder: (path: string) => ipcRenderer.invoke("open_folder", { path }),
  checkClaude: () => ipcRenderer.invoke("check_claude"),
  checkLaunchers: (paths: string[]) => ipcRenderer.invoke("check_launchers", { paths }),
  // ---------- 批量添加 ----------
  scanClaudeProjects: () => ipcRenderer.invoke("scan_claude_projects"),
  getClaudeProjectsDir: () => ipcRenderer.invoke("get_claude_projects_dir"),
  // ---------- 会话管理 ----------
  listSessions: (projectPath: string) =>
    ipcRenderer.invoke("list_sessions", { projectPath }),
  renameSession: (file: string, newTitle: string) =>
    ipcRenderer.invoke("rename_session", { file, newTitle }),
  /** 删除会话 = 移入回收站，返回备份路径 */
  deleteSession: (file: string) => ipcRenderer.invoke("delete_session", { file }),
  listTrashedSessions: () => ipcRenderer.invoke("list_trashed_sessions"),
  restoreSession: (file: string) => ipcRenderer.invoke("restore_session", { file }),
  purgeSession: (file: string) => ipcRenderer.invoke("purge_session", { file }),
  /** 清空回收站（彻底删除全部备份、释放磁盘，不可恢复），返回清空的会话数 */
  purgeTrash: () => ipcRenderer.invoke("purge_trash"),
  /** 读取会话内容（向上分页：offset 省略时返回最后 limit 条） */
  getSessionMessages: (file: string, offset?: number) =>
    ipcRenderer.invoke("get_session_messages", { file, offset }),
  /** 新开终端窗口 resume 会话继续对话 */
  resumeSession: (file: string, projectPath: string) =>
    ipcRenderer.invoke("resume_session", { file, projectPath }),
  getDataRoot: () =>
    ipcRenderer.invoke("get_data_root") as Promise<{ path: string; installMode: boolean }>,
  quitApp: () => ipcRenderer.invoke("quit_app"),
  // ---------- 开机自启动 ----------
  /** 当前平台是否支持开机自启动（如不支持则设置项不显示） */
  isAutostartSupported: () => ipcRenderer.invoke("autostart_supported"),
  /** 当前是否已开启开机自启动 */
  autostartEnabled: () => ipcRenderer.invoke("autostart_enabled"),
  /** 开启开机自启动 */
  autostartTurnOn: () => ipcRenderer.invoke("autostart_turn_on"),
  /** 关闭开机自启动 */
  autostartTurnOff: () => ipcRenderer.invoke("autostart_turn_off"),
  // ---------- 窗口控制（替代 @tauri-apps/api/window） ----------
  /** 选择项目文件夹（替代 @tauri-apps/plugin-dialog 的 open），取消返回 null */
  pickFolder: (title: string) =>
    ipcRenderer.invoke("pick_folder", { title }) as Promise<string | null>,
  /** 隐藏窗口（最小化到托盘） */
  hideWindow: () => ipcRenderer.invoke("window_hide"),
  /** 强制销毁窗口（close_action = quit 时绕过关闭拦截） */
  destroyWindow: () => ipcRenderer.invoke("window_destroy"),
  /** 订阅窗口关闭请求（主进程拦截 close 后转发）；返回取消订阅函数 */
  onCloseRequested: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("window:close-requested", handler);
    return () => {
      ipcRenderer.removeListener("window:close-requested", handler);
    };
  },
};

export type ClaudeFastApi = typeof api;

contextBridge.exposeInMainWorld("claudeFast", api);
