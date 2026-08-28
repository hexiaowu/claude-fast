// 数据根目录定位与 Claude Code 项目目录（对齐原 Tauri 后端 resolve_root_dir / claude_projects_dir）
import * as fs from "node:fs";
import * as path from "node:path";

/** 启动脚本专用目录（相对数据根目录） */
export const SCRIPTS_DIR = "scripts";

/** 当前平台的启动脚本扩展名：Windows 用 .bat，macOS/Linux 用 .sh */
export function scriptExt(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "bat" : "sh";
}

/** 旧版便携模式数据根标记文件名（Windows 为 claude-claude-fast.bat） */
export function legacyMarker(platform: NodeJS.Platform = process.platform): string {
  return `claude-claude-fast.${scriptExt(platform)}`;
}

function statIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function statIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 判断目录是否为数据根：新布局（config.json + scripts/ 子目录）或旧布局
 *  （根目录直接放 claude-claude-fast.<bat|sh>） */
export function isRootDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    (statIsFile(path.join(dir, "config.json")) && statIsDir(path.join(dir, SCRIPTS_DIR))) ||
    statIsFile(path.join(dir, legacyMarker(platform)))
  );
}

/** 安装模式数据根：%APPDATA%\claude-fast（Windows）/
 *  ~/Library/Application Support/claude-fast（macOS）。
 *  安装包模式下 exe 位于 Program Files（只读），用户数据统一放这里。 */
export function appDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let base: string;
  if (platform === "win32") {
    base = env.APPDATA ?? "";
  } else if (platform === "darwin") {
    base = path.join(env.HOME ?? "", "Library", "Application Support");
  } else {
    base = env.HOME ?? "";
  }
  return path.join(base, "claude-fast");
}

export interface RootResolution {
  root: string;
  /** true = 安装模式（数据根在 %APPDATA% 而非 exe 所在目录） */
  installMode: boolean;
}

/** 定位数据根目录（双模式，语义与 Rust 版一致）：
 *  1. **便携模式**：exe 所在目录向上逐级（最多 6 级）查找首个根目录标记
 *     （config.json + scripts/，或旧标记 claude-claude-fast.bat）——
 *     开发目录、整体移动的文件夹、绿色版均走此路径。
 *  2. **安装模式**：找不到便携标记时回退到应用数据目录
 *     （%APPDATA%\claude-fast），首次运行自动创建 scripts/ 子目录。 */
export function resolveRootDir(
  exePath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): RootResolution {
  const exeDir = path.dirname(path.resolve(exePath));
  let dir = exeDir;
  for (let i = 0; i < 6; i++) {
    if (isRootDir(dir, platform)) {
      return { root: dir, installMode: dir !== exeDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 安装模式：应用数据目录（幂等创建 scripts/，保证「安装后自动生效」）
  const app = appDataRoot(platform, env);
  try {
    fs.mkdirSync(path.join(app, SCRIPTS_DIR), { recursive: true });
  } catch {
    // 创建失败时仍返回该目录（后续写操作会报具体错误）
  }
  return { root: app, installMode: true };
}

/** Claude Code 项目目录（会话 jsonl 所在）：<数据根>/projects。
 *  数据根优先级：
 *  1. `CLAUDE_CONFIG_DIR` 环境变量（官方支持的自定义数据目录）；
 *  2. 平台默认——Claude Code CLI 的规范路径 `~/.claude/projects` 优先；
 *     macOS 后备：`~/Library/Application Support/Claude/projects`
 *     （Claude Desktop 内置 code 的会话目录，仅当 ~/.claude 缺失且此处存在时用）。 */
export function claudeProjectsDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const cfg = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  if (cfg) return path.join(cfg, "projects");
  const home = platform === "win32" ? (env.USERPROFILE ?? "") : (env.HOME ?? "");
  if (platform === "darwin") {
    // CLI 规范路径优先（~/.claude 若是指向 Desktop 数据目录的 symlink，两处等价）
    const cli = path.join(home, ".claude", "projects");
    if (statIsDir(cli)) return cli;
    // 后备：Claude Desktop 内置 code 的会话目录
    const desktop = path.join(home, "Library", "Application Support", "Claude", "projects");
    if (statIsDir(desktop)) return desktop;
    return cli;
  }
  return path.join(home, ".claude", "projects");
}
