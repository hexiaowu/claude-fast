// 平台交互：启动项目 / 文件夹打开 / claude 检查 / resume / 会话项目扫描
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCRIPTS_DIR } from "./paths";
import { unmangleCandidates } from "./mangle";
import { shQuote } from "./scriptnames";
import { validateSessionFile } from "./sessions";

export interface ClaudeProject {
  /** 真实路径的叶子目录名（用于显示） */
  name: string;
  /** 解析出的真实路径（不存在时为首选候选路径） */
  path: string;
  /** true = 真实路径已不存在（项目代码被删除） */
  missing: boolean;
}

export interface DataRootInfo {
  path: string;
  installMode: boolean;
}

function detached(child: ChildProcess): void {
  child.unref();
  child.on("error", () => {
    // spawn 失败（如 explorer/open 不存在）时静默——与 Rust 版 spawn().ok() 语义一致
  });
}

/** 用资源管理器 / Finder 打开文件夹 */
export function openFolder(p: string, platform: NodeJS.Platform = process.platform): void {
  const child =
    platform === "win32"
      ? spawn("explorer.exe", [p], { detached: true, stdio: "ignore" })
      : spawn("open", [p], { detached: true, stdio: "ignore" });
  detached(child);
}

/** claude 命令可用性检查（3 秒超时；PATH 含慢速目录时避免长时间挂起）。
 *  Windows 用 `where`、macOS/Linux 用 `command -v`。 */
export function checkClaude(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child =
        platform === "win32"
          ? spawn("where", ["claude"], {
              windowsHide: true,
              stdio: ["ignore", "ignore", "ignore"],
            })
          : spawn("/bin/sh", ["-c", "command -v claude"], {
              stdio: ["ignore", "ignore", "ignore"],
            });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(false);
    }, 3000);
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

/** 健康检查：并行检查各启动脚本指向的目录是否存在 */
export async function checkLaunchers(paths: string[]): Promise<boolean[]> {
  return Promise.all(
    paths.map(async (p) => {
      try {
        return (await fs.promises.stat(p)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
}

/** 校验 resume 的项目路径（防命令注入，两平台共用）：
 *  空路径拒绝；控制字符一律拒绝；路径必须真实存在。
 *  Windows：cmd 引号较弱，`%VAR%` `^` `& | < > ( )` 等即使双引号内仍有作用，故显式拒绝。
 *  macOS：路径经 shQuote 转义后放进 `cd "..."`，双引号内 `$ ` \ "` 之外的特殊字符
 *  均为字面量，故不再额外拒字符——避免误伤含 `(` `)` `'` `\` 等的合法 mac 路径。 */
export function validateResumePath(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const proj = projectPath.trim();
  if (proj === "") throw new Error("项目路径不能为空");
  if (platform === "win32") {
    const forbidden = ['"', "&", "|", "<", ">", "^", "%", "!", "(", ")"];
    for (const c of forbidden) {
      if (proj.includes(c)) throw new Error("项目路径包含非法字符");
    }
  }
  // 控制字符（Unicode Cc：U+0000–U+001F、U+007F–U+009F）
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(proj)) throw new Error("项目路径包含非法字符");
  try {
    if (!fs.statSync(proj).isDirectory()) throw new Error("项目路径不存在");
  } catch {
    throw new Error("项目路径不存在");
  }
  return proj;
}

/** 构造 resume 的 cmd 命令行（Windows）：
 *  `cmd /k cd /d "<项目路径>" && claude --resume <session-id>` */
export function buildResumeCmdline(
  projectPath: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const proj = validateResumePath(projectPath, platform);
  return `/k cd /d "${proj}" && claude --resume ${sessionId}`;
}

/** 构造 resume 的临时脚本内容（macOS）：
 *  `cd "/path" && exec claude --resume <id>`，写入临时文件后由 Terminal 运行。 */
export function buildResumeScript(
  projectPath: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const proj = validateResumePath(projectPath, platform);
  return `#!/bin/bash\ncd "${shQuote(proj)}" || exit 1\nexec claude --resume ${sessionId}\n`;
}

/** 继续对话：新开终端窗口，在项目目录运行 `claude --resume <session-id>`。
 *  Windows：cmd /k；macOS：临时 .sh + Terminal.app 打开。 */
export function resumeSession(
  file: string,
  projectPath: string,
  projectsDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const { sessionId } = validateSessionFile(file, projectsDir);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    if (platform === "win32") {
      let cmdline: string;
      try {
        cmdline = buildResumeCmdline(projectPath, sessionId, platform);
      } catch (e) {
        reject(e);
        return;
      }
      const proj = projectPath.trim();
      child = spawn("cmd.exe", [cmdline], {
        cwd: proj,
        detached: true,
        windowsVerbatimArguments: true,
        stdio: "ignore",
      });
    } else {
      let content: string;
      try {
        content = buildResumeScript(projectPath, sessionId, platform);
      } catch (e) {
        reject(e);
        return;
      }
      // 临时脚本放系统临时目录（内容幂等，同名覆盖无害；系统自动清理），
      // 用 `open -a Terminal` 打开——不需要 osascript 自动化权限
      const tmp = path.join(os.tmpdir(), `claude-fast-resume-${sessionId}.sh`);
      try {
        fs.writeFileSync(tmp, content, "utf8");
        fs.chmodSync(tmp, 0o755);
      } catch (e) {
        reject(new Error(`写入临时脚本失败：${String(e)}`));
        return;
      }
      child = spawn("open", ["-a", "Terminal", tmp], {
        detached: true,
        stdio: "ignore",
      });
    }
    child.on("error", (e) => reject(new Error(String(e))));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** 批量扫描：扫 Claude Code 项目目录（~/.claude/projects），把每个 mangled 目录名
 *  反向解析出真实路径；真实路径已不存在的项目标记 missing=true。 */
export function scanClaudeProjects(
  projectsDir: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeProject[] {
  const out: ClaudeProject[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const p = platform === "win32" ? path.win32 : path.posix;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const cands = unmangleCandidates(name, platform);
    const existing = cands.find((c) => {
      try {
        return fs.statSync(c).isDirectory();
      } catch {
        return false;
      }
    });
    const resolved = existing ?? cands[0] ?? "";
    if (resolved === "") continue;
    const leaf = p.basename(resolved) || name;
    out.push({
      name: leaf,
      path: resolved,
      missing: existing === undefined,
    });
  }
  out.sort((a, b) => {
    const la = a.path.toLowerCase();
    const lb = b.path.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return out;
}

/** 数据根 scripts/ 目录路径（迁移旧脚本用） */
export function scriptsDirOf(root: string): string {
  return path.join(root, SCRIPTS_DIR);
}

// ---------------- 项目清单（去脚本化） ----------------

export interface ProjectItem {
  /** 唯一键 = 项目绝对路径 */
  key: string;
  /** 叶子目录名（显示用） */
  name: string;
  path: string;
  /** true = 路径已不存在（标红，不可启动） */
  missing: boolean;
}

function statIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 构建主列表：Claude 会话扫描 ∪ 手动添加清单（config.projects），按路径去重，
 *  并剔除排除清单（用户已移除）中的项目。
 *  missing = 路径当前不存在（仍显示、标红、不可启动）。 */
export function listProjects(
  projectsDir: string,
  manualPaths: string[],
  excludedPaths: string[],
  platform: NodeJS.Platform = process.platform,
): ProjectItem[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const excluded = new Set(excludedPaths.map((x) => x.toLowerCase()));
  const out = new Map<string, ProjectItem>();
  for (const s of scanClaudeProjects(projectsDir, platform)) {
    if (excluded.has(s.path.toLowerCase())) {
      continue; // 用户已移除：即使会话扫描重新发现也不显示
    }
    out.set(s.path.toLowerCase(), { key: s.path, name: s.name, path: s.path, missing: s.missing });
  }
  for (const mp of manualPaths) {
    const key = mp.toLowerCase();
    if (out.has(key) || excluded.has(key)) continue;
    out.set(key, {
      key: mp,
      name: p.basename(mp) || mp,
      path: mp,
      missing: !statIsDirectory(mp),
    });
  }
  return [...out.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hans-CN"),
  );
}

/** 把一个项目路径加入手动清单（已在清单中则原样返回）。路径必须是存在的目录。 */
export function addProject(manualPaths: string[], dir: string): string[] {
  if (!statIsDirectory(dir)) throw new Error("路径不存在或不是文件夹");
  const next = [...manualPaths];
  if (!next.some((p) => p.toLowerCase() === dir.toLowerCase())) {
    next.push(dir);
  }
  return next;
}

/** 从手动清单移除项目路径 */
export function removeProject(manualPaths: string[], dir: string): string[] {
  return manualPaths.filter((p) => p.toLowerCase() !== dir.toLowerCase());
}

/** 启动项目（新会话）：新开终端，cd 到项目目录运行 claude。
 *  不经过任何脚本文件；Windows 不带 detached（控制台走默认终端委托，
 *  避免 claude 2.x 原生启动器的 bash 探测各自弹独立 conhost 窗口）；
 *  /k 让 claude 退出后窗口保留、便于查看输出。 */
export function launchProject(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const dir = projectPath.trim();
  if (!statIsDirectory(dir)) throw new Error("项目路径不存在");
  if (platform === "win32") {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        "cmd.exe",
        [`/k`, `cd /d "${dir}" && claude`],
        {
          cwd: dir,
          windowsVerbatimArguments: true,
          stdio: "ignore",
        },
      );
      child.on("error", (e) => reject(new Error(String(e))));
      child.once("spawn", () => resolve());
    });
  }
  // macOS：临时 sh + Terminal.app（无需 osascript 自动化权限）
  const sh = path.join(
    os.tmpdir(),
    `claude-fast-open-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sh`,
  );
  fs.writeFileSync(
    sh,
    `#!/bin/bash\ncd ${JSON.stringify(dir)} || exit 1\nexec claude\n`,
    "utf8",
  );
  fs.chmodSync(sh, 0o755);
  return new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-a", "Terminal", sh], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (e) => reject(new Error(String(e))));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** 解析数据根 scripts/ 下旧启动脚本（Tauri 版遗留），返回脚本 key → 项目路径映射。
 *  用于去脚本化的一次性迁移；脚本文件本身保留不动。 */
export function legacyScriptPaths(
  scriptsDir: string,
  platform: NodeJS.Platform = process.platform,
): Map<string, string> {
  const map = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(scriptsDir);
  } catch {
    return map;
  }
  const ext = platform === "win32" ? ".bat" : ".sh";
  for (const n of names) {
    if (!n.toLowerCase().endsWith(ext)) continue;
    const stem = n.slice(0, -ext.length);
    if (!stem.toLowerCase().startsWith("claude-")) continue;
    let content = "";
    try {
      content = fs.readFileSync(path.join(scriptsDir, n), "utf8");
    } catch {
      continue;
    }
    const cd = parseCdPathCompat(content);
    if (cd) map.set(stem, cd);
  }
  return map;
}

/** 与 scriptnames.parseCdPath 相同的逻辑（避免为迁移引入跨模块依赖） */
function parseCdPathCompat(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    const lower = t.toLowerCase();
    let rest: string;
    if (lower.startsWith("cd /d")) rest = t.slice(5);
    else if (lower.startsWith("cd ")) rest = t.slice(3);
    else continue;
    rest = rest.trim();
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end !== -1) return rest.slice(1, end);
    } else {
      const p = rest.split(/\s+/)[0] ?? "";
      if (p !== "") return p;
    }
  }
  return null;
}
