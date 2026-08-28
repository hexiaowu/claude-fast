// Electron 主进程：窗口 / 托盘 / 单实例 / 关闭拦截 / 全部 IPC 命令
// （对齐原 Tauri 后端 lib.rs 的 run() + 22 个 commands）
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from "electron";
import * as path from "node:path";
import { loadConfig, saveConfig, type Config } from "./backend/config";
import { createLauncher, deleteLauncher, listLaunchers } from "./backend/launchers";
import {
  checkClaude,
  checkLaunchers,
  launchClaude,
  openFolder,
  resumeSession,
  scanClaudeProjects,
  scriptsDirOf,
} from "./backend/platform";
import {
  claudeProjectsDir,
  resolveRootDir,
  type RootResolution,
} from "./backend/paths";
import {
  getSessionMessages,
  listSessions,
  renameSession,
  validateSessionFile,
} from "./backend/sessions";
import {
  deleteSessionFile,
  listTrashedSessionsIn,
  purgeSessionBackup,
  purgeTrashIn,
  restoreTrashedFile,
  validateTrashFile,
} from "./backend/trash";
import type { IpcContract } from "./ipc-contract";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** true 时 close 事件不再拦截（quit_app / window_destroy / before-quit 已置位） */
let quitting = false;

// ---------------- 数据根（进程内缓存；exe 位置运行期不变） ----------------

let cachedRoot: RootResolution | null = null;

function rootInfo(): RootResolution {
  if (!cachedRoot) cachedRoot = resolveRootDir(process.execPath);
  return cachedRoot;
}

function rootDir(): string {
  return rootInfo().root;
}

function projectsDir(): string {
  return claudeProjectsDir();
}

function trashRootDir(): string {
  return path.join(rootDir(), "trash", "sessions");
}

// ---------------- IPC 包装：后端抛错统一转为字符串（对齐 Tauri Err(String)） ----------------

function wrap<A extends unknown[]>(fn: (...args: A) => unknown) {
  return async (...args: A): Promise<unknown> => {
    try {
      return await fn(...args);
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  };
}

// 注意：ipcMain.handle 的 handler 首参是 IpcMainInvokeEvent，必须剥离后再把
// contract payload 交给业务函数（曾因把 event 当 payload 用，批量添加的
// create_launcher 收到 "[object Object]" 而全部报「路径不存在」）
function handle<K extends keyof IpcContract>(
  channel: K,
  fn: (payload: IpcContract[K]) => unknown,
): void {
  ipcMain.handle(channel, (_event, payload: IpcContract[K]) => wrap(fn)(payload));
}

function toInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  return undefined;
}

// ---------------- 窗口与托盘 ----------------

function appIcon(): { app: string; tray: string } {
  // nativeImage 不能从 asar 内读图——打包后图标放 extraResources（resources/），
  // 开发模式直接读 build/；icon.ico 仍由 electron-builder 嵌入 exe 与安装包
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "build");
  return {
    app: path.join(base, "icon128.png"),
    tray: path.join(base, "icon.png"),
  };
}

/** 把主窗口显示到最前台（托盘「显示窗口」/ 托盘左键 / 单实例回调共用）。
 *  Windows 前台锁定：先强制置顶再取消，确保窗口真正浮到最前（对齐 Rust 版）。 */
function showMainWindow(): void {
  const w = mainWindow;
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  w.setAlwaysOnTop(true);
  w.setAlwaysOnTop(false);
}

function quitApp(): void {
  quitting = true;
  app.exit(0);
}

function createTray(): void {
  const { tray: trayIconPath } = appIcon();
  const image = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(image);
  tray.setToolTip("Claude助手");
  const menu = Menu.buildFromTemplate([
    { label: "显示窗口", click: () => showMainWindow() },
    { label: "退出程序", click: () => quitApp() },
  ]);
  // 左键点击显示窗口、右键弹菜单。
  // 不用 setContextMenu：Windows 上设置了之后左键单击也会弹菜单，
  // 会顶掉「左键显示窗口」行为（对齐 Tauri 版 show_menu_on_left_click(false)）。
  tray.on("click", () => showMainWindow());
  tray.on("right-click", () => {
    tray?.popUpContextMenu(menu);
  });
}

function createWindow(): void {
  const { app: appIconPath } = appIcon();
  mainWindow = new BrowserWindow({
    title: "Claude助手",
    width: 920,
    height: 660,
    minWidth: 680,
    minHeight: 500,
    center: true,
    resizable: true,
    icon: appIconPath,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // 关闭拦截：交给前端按 close_action 决定（隐藏到托盘 / 询问 / 退出）
  mainWindow.on("close", (e) => {
    if (quitting || !mainWindow) return;
    e.preventDefault();
    mainWindow.webContents.send("window:close-requested");
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 防拖拽文件/链接导致页面导航（保持 HTML5 拖拽排序可用），并禁止弹新窗口
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    void mainWindow.loadURL(DEV_SERVER_URL);
  }
}

// ---------------- IPC 注册 ----------------

function registerIpc(): void {
  // ---------- 启动脚本 ----------
  handle("list_launchers", () => listLaunchers(scriptsDirOf(rootDir())));
  handle("load_config", () => loadConfig(rootDir()));
  handle("save_config", (p) => {
    const cfg: Config = {
      favorites: Array.isArray(p.favorites) ? p.favorites.map(String) : [],
      dark: p.dark === true,
      closeAction:
        p.closeAction === "quit" || p.closeAction === "minimize" ? p.closeAction : null,
    };
    saveConfig(rootDir(), cfg);
  });
  handle("create_launcher", (p) => createLauncher(rootDir(), String(p.dir)));
  handle("delete_launcher", (p) => deleteLauncher(String(p.file)));
  handle("launch_claude", (p) => launchClaude(String(p.file), rootDir()));
  handle("open_folder", (p) => openFolder(String(p.path)));
  handle("check_claude", () => checkClaude());
  handle("check_launchers", (p) =>
    checkLaunchers(Array.isArray(p.paths) ? p.paths.map(String) : []));

  // ---------- 批量添加 ----------
  handle("scan_claude_projects", () =>
    scanClaudeProjects(projectsDir(), scriptsDirOf(rootDir())));
  handle("get_claude_projects_dir", () => projectsDir());

  // ---------- 会话管理 ----------
  handle("list_sessions", (p) => listSessions(projectsDir(), String(p.projectPath)));
  handle("rename_session", (p) =>
    renameSession(String(p.file), String(p.newTitle), projectsDir()));
  handle("delete_session", (p) => {
    // 校验（限 projects 目录下 uuid.jsonl）后移入回收站（先备份再删除）
    const { path: fp } = validateSessionFile(String(p.file), projectsDir());
    return deleteSessionFile(fp, trashRootDir());
  });
  handle("list_trashed_sessions", () => listTrashedSessionsIn(trashRootDir()));
  handle("restore_session", (p) => {
    const { path: fp } = validateTrashFile(String(p.file), rootDir());
    return restoreTrashedFile(fp, projectsDir());
  });
  handle("purge_session", (p) => purgeSessionBackup(String(p.file), rootDir()));
  handle("purge_trash", () => purgeTrashIn(trashRootDir()));
  handle("get_session_messages", (p) =>
    getSessionMessages(String(p.file), projectsDir(), toInt(p.offset)));
  handle("resume_session", (p) =>
    resumeSession(String(p.file), String(p.projectPath), projectsDir()));

  // ---------- 其他 ----------
  handle("get_data_root", () => {
    const info = rootInfo();
    return { path: info.root, installMode: info.installMode };
  });
  handle("quit_app", () => quitApp());

  // ---------- 开机自启动（Windows 注册表 Run 项 / macOS 登录项，官方 API） ----------
  handle("autostart_supported", () => true);
  handle("autostart_enabled", () => {
    try {
      return app.getLoginItemSettings().openAtLogin === true;
    } catch {
      return false;
    }
  });
  handle("autostart_turn_on", () => {
    app.setLoginItemSettings({ openAtLogin: true });
  });
  handle("autostart_turn_off", () => {
    app.setLoginItemSettings({ openAtLogin: false });
  });

  // ---------- 窗口控制（替代 @tauri-apps/api/window 与 plugin-dialog） ----------
  handle("pick_folder", async (p) => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: typeof p.title === "string" && p.title !== "" ? p.title : "选择项目文件夹",
      properties: ["openDirectory", "dontAddToRecent"],
      buttonLabel: "选择此文件夹",
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  handle("window_hide", () => {
    mainWindow?.hide();
  });
  handle("window_destroy", () => {
    quitting = true;
    mainWindow?.destroy();
  });
}

// ---------------- 单实例 ----------------

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.whenReady().then(() => {
    app.setAppUserModelId("com.claudefast.launcher");
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    createTray();

    app.on("activate", () => {
      // macOS：dock 图标点击时显示窗口（窗口可能已隐藏到托盘）
      showMainWindow();
    });
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("window-all-closed", () => {
    // 关闭行为由前端拦截决定，走到这里即窗口真正销毁——退出
    app.quit();
  });
}
