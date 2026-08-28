// 启动脚本的列表 / 创建 / 删除 / 查重（对齐原 Tauri 后端 list_launchers / create_launcher 等）
import * as fs from "node:fs";
import * as path from "node:path";
import { SCRIPTS_DIR, scriptExt } from "./paths";
import { genScript, parseCdPath, pickUniqueScriptPath } from "./scriptnames";

export interface Launcher {
  label: string;
  /** 脚本 cd 行解析出的目录（解析失败为 null） */
  path: string | null;
  file: string;
  key: string;
}

export interface CreateResult {
  file: string;
  existed: boolean;
}

/** 路径字符串 ASCII 不区分大小写比较（对齐 Rust eq_ignore_ascii_case） */
function eqIgnoreCaseAscii(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    const la = ca >= 65 && ca <= 90 ? ca + 32 : ca;
    const lb = cb >= 65 && cb <= 90 ? cb + 32 : cb;
    if (la !== lb) return false;
  }
  return true;
}

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1);
}

function fileStem(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? name : name.slice(0, i);
}

function readTextFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** 列出启动脚本目录下的全部脚本（*.bat / *.sh，stem 以 claude- 开头），按路径排序 */
export function listLaunchers(
  scriptsDir: string,
  platform: NodeJS.Platform = process.platform,
): Launcher[] {
  const ext = scriptExt(platform);
  let names: string[];
  try {
    names = fs.readdirSync(scriptsDir);
  } catch {
    return [];
  }
  const files = names
    .filter(
      (n) =>
        statIsFile(path.join(scriptsDir, n)) &&
        fileExt(n).toLowerCase() === ext.toLowerCase() &&
        fileStem(n).toLowerCase().startsWith("claude-"),
    )
    .map((n) => path.join(scriptsDir, n))
    .sort();
  return files.map((f) => {
    const stem = fileStem(path.basename(f));
    const label = stem.startsWith("claude-") ? stem.slice("claude-".length) : stem;
    const content = readTextFile(f);
    return { label, path: parseCdPath(content), file: f, key: stem };
  });
}

function statIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 在数据根 scripts/ 下查找指向该路径的启动脚本文件（按脚本内 cd 路径比对，忽略大小写）。
 *  返回已有文件的路径——查重与「创建时复用」共用此逻辑，保证两处判定一致。 */
export function findExistingScript(
  scriptsDir: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const ext = scriptExt(platform);
  let names: string[];
  try {
    names = fs.readdirSync(scriptsDir);
  } catch {
    return null;
  }
  for (const n of names) {
    const p = path.join(scriptsDir, n);
    if (statIsFile(p) && fileExt(n).toLowerCase() === ext.toLowerCase()) {
      const cd = parseCdPath(readTextFile(p));
      if (cd !== null && eqIgnoreCaseAscii(cd, targetPath)) return p;
    }
  }
  return null;
}

/** 判断数据根 scripts/ 下是否已有指向该路径的启动脚本 */
export function scriptsHasProject(
  scriptsDir: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return findExistingScript(scriptsDir, targetPath, platform) !== null;
}

/** 创建启动脚本：已存在指向该路径的脚本时复用其文件（保持文件名，只更新内容）；
 *  否则新建，同名叶子被其他路径占用时自动加序号（claude-<leaf>-2.bat），
 *  绝不覆盖别的项目脚本。 */
export function createLauncher(
  root: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): CreateResult {
  try {
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error("路径不存在或不是文件夹");
    }
  } catch {
    throw new Error("路径不存在或不是文件夹");
  }
  const scripts = path.join(root, SCRIPTS_DIR);
  fs.mkdirSync(scripts, { recursive: true });
  const existing = findExistingScript(scripts, dir, platform);
  const scriptPath = existing ?? pickUniqueScriptPath(scripts, dir, scriptExt(platform), platform);
  const leaf = pathStyle(platform).basename(dir);
  fs.writeFileSync(scriptPath, genScript(dir, leaf, platform), "utf8");
  if (platform !== "win32") {
    // macOS/Linux：脚本需可执行权限（Terminal 打开 .sh 直接运行）
    fs.chmodSync(scriptPath, 0o755);
  }
  return { file: scriptPath, existed: existing !== null };
}

function pathStyle(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/** 删除启动脚本文件（不存在时静默成功，与 Rust 版一致） */
export function deleteLauncher(file: string): void {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}
