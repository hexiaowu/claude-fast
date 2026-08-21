import { invoke } from "@tauri-apps/api/core";
import {
  isEnabled as autostartIsEnabled,
  enable as autostartEnable,
  disable as autostartDisable,
} from "@tauri-apps/plugin-autostart";
import type {
  ClaudeProject,
  Config,
  CreateResult,
  Launcher,
  SessionInfo,
  SessionMessages,
  TrashedSession,
} from "../types";

/** Tauri 后端命令封装 */
export const api = {
  listLaunchers: () => invoke<Launcher[]>("list_launchers"),
  loadConfig: () => invoke<Config>("load_config"),
  saveConfig: (favorites: string[], dark: boolean, closeAction?: string | null) =>
    invoke<void>("save_config", { favorites, dark, closeAction }),
  createLauncher: (dir: string) => invoke<CreateResult>("create_launcher", { dir }),
  deleteLauncher: (file: string) => invoke<void>("delete_launcher", { file }),
  launchClaude: (file: string) => invoke<void>("launch_claude", { file }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  checkClaude: () => invoke<boolean>("check_claude"),
  checkLaunchers: (paths: string[]) =>
    invoke<boolean[]>("check_launchers", { paths }),
  scanClaudeProjects: () => invoke<ClaudeProject[]>("scan_claude_projects"),
  getClaudeProjectsDir: () => invoke<string>("get_claude_projects_dir"),
  listSessions: (projectPath: string) =>
    invoke<SessionInfo[]>("list_sessions", { projectPath }),
  renameSession: (file: string, newTitle: string) =>
    invoke<void>("rename_session", { file, newTitle }),
  /** 删除会话 = 移入回收站，返回备份路径 */
  deleteSession: (file: string) => invoke<string>("delete_session", { file }),
  listTrashedSessions: () => invoke<TrashedSession[]>("list_trashed_sessions"),
  restoreSession: (file: string) => invoke<string>("restore_session", { file }),
  purgeSession: (file: string) => invoke<void>("purge_session", { file }),
  /** 清空回收站（彻底删除全部备份、释放磁盘，不可恢复），返回清空的会话数 */
  purgeTrash: () => invoke<number>("purge_trash"),
  /** 读取会话内容（向上分页：offset 省略时返回最后 limit 条） */
  getSessionMessages: (file: string, offset?: number) =>
    invoke<SessionMessages>("get_session_messages", { file, offset }),
  /** 新开终端窗口 resume 会话继续对话（阶段二） */
  resumeSession: (file: string, projectPath: string) =>
    invoke<void>("resume_session", { file, projectPath }),
  getDataRoot: () => invoke<{ path: string; installMode: boolean }>("get_data_root"),
  quitApp: () => invoke<void>("quit_app"),
  // ---------- 开机自启动 ----------
  /** 当前平台是否支持开机自启动（如不支持则设置项不显示） */
  isAutostartSupported: () => invoke<boolean>("autostart_supported"),
  /** 当前是否已开启开机自启动 */
  autostartEnabled: () => autostartIsEnabled(),
  /** 开启开机自启动 */
  autostartTurnOn: () => autostartEnable(),
  /** 关闭开机自启动 */
  autostartTurnOff: () => autostartDisable(),
};
