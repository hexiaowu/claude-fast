// 平台交互：启动脚本执行 / 文件夹打开 / claude 检查 / resume / 批量扫描
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCRIPTS_DIR } from "./paths";
import { findExistingScript } from "./launchers";
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
  /** true = 数据根 scripts/ 下已有该项目的启动脚本 */
  existing: boolean;
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

/** 批量添加：扫描 Claude Code 项目目录（~/.claude/projects），把每个 mangled 目录名
 *  反向解析出真实路径；真实路径已不存在的项目标记 missing=true（不参与生成）；
 *  已有启动脚本的项目标记 existing=true（列表标记、默认不勾选）。 */
export function scanClaudeProjects(
  projectsDir: string,
  scriptsDir: string,
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
      existing: findExistingScript(scriptsDir, resolved, platform) !== null,
    });
  }
  out.sort((a, b) => {
    const la = a.path.toLowerCase();
    const lb = b.path.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return out;
}

/** 数据根 scripts/ 目录路径 */
export function scriptsDirOf(root: string): string {
  return path.join(root, SCRIPTS_DIR);
}
