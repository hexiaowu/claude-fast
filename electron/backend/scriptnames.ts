// 启动脚本命名 / 模板生成（对齐原 Tauri 后端 build_script_name / gen_bat / gen_sh）
import * as fs from "node:fs";
import * as path from "node:path";

/** 平台风格选择器：Windows 用 win32 路径语义，其余用 posix */
function pathStyle(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}
/** 生成启动脚本文件名：统一用**叶子目录名**（无工作区概念，跨平台一致）：
 *    D:\MyWorkspaces\yaotu\tdc      → claude-tdc.bat
 *    D:\WeChatProjects\tms_app      → claude-tms_app.bat
 *    /Users/me/proj                 → claude-proj.sh
 *  同名叶子目录由 pickUniqueScriptPath 加序号区分（claude-myproj-2.bat），
 *  绝不覆盖其他项目的脚本。 */
export function buildScriptName(
  dir: string,
  ext: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathStyle(platform);
  // 叶子目录名（basename 忽略尾部斜杠，如 D:\MyWorkspaces\ → MyWorkspaces）
  const leaf = p.basename(dir);
  let safe = "";
  for (const c of leaf) {
    safe += "\\/:*?\"<>|".includes(c) ? "-" : c;
  }
  safe = safe.replace(/^-+|-+$/g, "");
  if (safe === "") safe = "project";
  return `claude-${safe}.${ext}`;
}

/** 在 scripts 目录下为 dir 挑选不冲突的脚本文件名：
 *  基础名 claude-<leaf>.<ext> 已被占用时依次加序号（claude-<leaf>-2.bat、-3.bat…）。
 *  指向 dir 的已有脚本会由 findExistingScript 复用，不会走到这里。 */
export function pickUniqueScriptPath(
  scriptsDir: string,
  dir: string,
  ext: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = buildScriptName(dir, ext, platform);
  const stem = base.slice(0, base.length - ext.length - 1);
  let p = path.join(scriptsDir, base);
  let n = 2;
  while (fs.existsSync(p)) {
    p = path.join(scriptsDir, `${stem}-${n}.${ext}`);
    n++;
  }
  return p;
}

/** shell 双引号内转义（macOS 脚本模板用：路径可能含 `"`、`$`、反引号、`\`，
 *  转义后放入 `cd "..."` 不会被展开/截断）。 */
export function shQuote(s: string): string {
  let out = "";
  for (const c of s) {
    if (c === "\\" || c === '"' || c === "$" || c === "`") out += "\\";
    out += c;
  }
  return out;
}

/** 与旧版 PowerShell 完全一致的 bat 模板（Windows） */
export function genBat(dir: string, leaf: string): string {
  return (
    "@echo off\r\n" +
    "chcp 65001 >nul\r\n" +
    `title Claude Code - ${leaf}\r\n` +
    `cd /d "${dir}" || goto :err\r\n` +
    "where claude >nul 2>nul || goto :err\r\n" +
    "call claude\r\n" +
    "if errorlevel 1 goto :err\r\n" +
    "exit /b 0\r\n" +
    ":err\r\n" +
    "echo [错误] 启动失败：目录不存在或 claude 命令未找到。\r\n" +
    "pause\r\n"
  );
}

/** macOS 启动脚本模板：Terminal 打开后 cd 到项目目录并启动 claude；
 *  claude 不存在或目录失效时提示并等待回车（窗口保留，不闪退）。 */
export function genSh(dir: string, leaf: string): string {
  return (
    "#!/bin/bash\n" +
    `# Claude Code - ${leaf}\n` +
    'fail() { echo "[错误] 启动失败：目录不存在或 claude 命令未找到。"; read -r -p "按回车键关闭窗口..." _; exit 1; }\n' +
    `cd "${shQuote(dir)}" || fail\n` +
    "command -v claude >/dev/null 2>&1 || fail\n" +
    "exec claude\n"
  );
}

/** 当前平台生成启动脚本内容（Windows: .bat；macOS/Linux: .sh） */
export function genScript(
  dir: string,
  leaf: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? genBat(dir, leaf) : genSh(dir, leaf);
}

/** 从启动脚本内容解析 `cd` 行中的目录路径。兼容 bat 的 `cd /d "..."` 与
 *  sh 的 `cd "/path"` / `cd /path`（带引号/不带引号均可）。 */
export function parseCdPath(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    const lower = t.toLowerCase();
    // bat: `cd /d "path"`；sh: `cd "/path"` / `cd /path`（前缀长度固定）
    let rest: string;
    if (lower.startsWith("cd /d")) {
      rest = t.slice(5);
    } else if (lower.startsWith("cd ")) {
      rest = t.slice(3);
    } else {
      continue;
    }
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
