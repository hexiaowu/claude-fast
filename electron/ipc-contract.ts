// IPC 通道契约：preload 与 main 共用的 payload 类型表。
// 每个通道的 payload 是**单个对象**（ipcRenderer.invoke(channel, payload)），
// 主进程 handler 收到的第一个参数是 IpcMainInvokeEvent，经 handle() 包装剥离后
// 才是这里的 payload——两侧签名由本表在编译期对齐，防止参数错位。

export interface IpcContract {
  // ---------- 启动脚本 ----------
  list_launchers: void;
  load_config: void;
  save_config: { favorites: string[]; dark: boolean; closeAction?: string | null };
  create_launcher: { dir: string };
  delete_launcher: { file: string };
  launch_claude: { file: string };
  open_folder: { path: string };
  check_claude: void;
  check_launchers: { paths: string[] };
  // ---------- 批量添加 ----------
  scan_claude_projects: void;
  get_claude_projects_dir: void;
  // ---------- 会话管理 ----------
  list_sessions: { projectPath: string };
  rename_session: { file: string; newTitle: string };
  delete_session: { file: string };
  list_trashed_sessions: void;
  restore_session: { file: string };
  purge_session: { file: string };
  purge_trash: void;
  get_session_messages: { file: string; offset?: number };
  resume_session: { file: string; projectPath: string };
  // ---------- 其他 ----------
  get_data_root: void;
  quit_app: void;
  autostart_supported: void;
  autostart_enabled: void;
  autostart_turn_on: void;
  autostart_turn_off: void;
  // ---------- 窗口控制 ----------
  pick_folder: { title: string };
  window_hide: void;
  window_destroy: void;
}

export type IpcChannel = keyof IpcContract;
