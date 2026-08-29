// 旧启动脚本解析与 shell 转义工具（去脚本化后仅存解析与转义：
// parseCdPath 用于迁移旧脚本，shQuote 用于 macOS 命令行拼装）

/** shell 双引号内转义（macOS 命令行拼装用：路径可能含 `"`、`$`、反引号、`\`，
 *  转义后放入 `cd "..."` 不会被展开/截断）。 */
export function shQuote(s: string): string {
  let out = "";
  for (const c of s) {
    if (c === "\\" || c === '"' || c === "$" || c === "`") out += "\\";
    out += c;
  }
  return out;
}

/** 从旧启动脚本内容解析 `cd` 行中的目录路径（迁移用）。兼容 bat 的
 *  `cd /d "..."` 与 sh 的 `cd "/path"` / `cd /path`（带引号/不带引号均可）。 */
export function parseCdPath(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    const lower = t.toLowerCase();
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
