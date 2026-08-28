// Claude Code 项目目录名 mangle / unmangle（对齐原 Tauri 后端同名函数）
import * as fs from "node:fs";

/** Claude Code 项目目录名的正向 mangle：`:`、`\`、`/`、`_`、`.` 均替换为 `-`
 *  （与 Claude Code 官方规则一致，Windows 与 macOS 通用）：
 *    D:\MyWorkspaces\jikehongbao → D--MyWorkspaces-jikehongbao
 *    /Users/me/proj              → -Users-me-proj */
export function mangleProjectPath(pathStr: string): string {
  let out = "";
  for (const c of pathStr) {
    out += c === ":" || c === "\\" || c === "/" || c === "_" || c === "." ? "-" : c;
  }
  return out;
}

/** UUID v4 格式校验（会话文件名主体） */
export function isValidUuid(s: string): boolean {
  if (s.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (s[i] !== "-") return false;
    } else if (!/^[0-9a-fA-F]$/.test(s[i])) {
      return false;
    }
  }
  return true;
}

/** n 选 k 的下标组合（升序） */
export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, cur: number[]) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i < n; i++) {
      cur.push(i);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

/** 通用反向解析：把 segments 按分隔符候选集枚举出全部路径。
 *  seps[0] 是主分隔符（Windows `\` / macOS `/`），seps[1..] 是可能的
 *  合并字符（`-` `_` `.`）；「层级最多（全用主分隔符）」的候选排最前，
 *  调用方用 exists 验证取真实存在者。段过多（>5）时降级避免组合爆炸。 */
export function enumSegmentPaths(
  segments: string[],
  seps: string[],
  build: (sepsUsed: string[]) => string,
): string[] {
  const gaps = segments.length - 1; // 间隙数：每个间隙可能是主分隔符或合并字符
  if (gaps === 0) return [build([])];
  if (gaps > 5) {
    // 段过多：仅生成「全主分隔符」+「单个间隙合并」候选，避免组合爆炸
    const out = [build(Array<string>(gaps).fill(seps[0]))];
    for (let i = 0; i < gaps; i++) {
      for (const c of seps.slice(1)) {
        const s = Array<string>(gaps).fill(seps[0]);
        s[i] = c;
        out.push(build(s));
      }
    }
    return out;
  }
  // 按合并间隙数 m 从少到多枚举（m 少 = 主分隔符多 = 层级多，优先）；
  // 选中间隙再遍历合并字符（- _ .），其余间隙当主分隔符
  const out: string[] = [];
  for (let m = 0; m <= gaps; m++) {
    for (const combo of combinations(gaps, m)) {
      // 对选中的 m 个间隙做合并字符笛卡尔积
      let cart: string[][] = [[]];
      for (let k = 0; k < m; k++) {
        const next: string[][] = [];
        for (const pq of cart) {
          for (const c of seps.slice(1)) {
            next.push([...pq, c]);
          }
        }
        cart = next;
      }
      for (const chars of cart) {
        const sepsUsed = Array<string>(gaps).fill(seps[0]);
        combo.forEach((pos, idx) => {
          sepsUsed[pos] = chars[idx];
        });
        out.push(build(sepsUsed));
      }
    }
  }
  return out;
}

function pathExistsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function pathExistsAny(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Claude Code 项目目录名的反向解析（Windows 风格）。mangled 规则（实测）：
 *  `:`、`\`、`_`、`.` 均替换为 `-`，`-` 保留，例如：
 *    D:\MyWorkspaces\jikehongbao     → D--MyWorkspaces-jikehongbao
 *    D:\WeChatProjects\tms_app       → D--WeChatProjects-tms-app
 *  反向存在歧义（每个 `-` 可能是 `\`/`_`/`.`/`-`），因此返回**按优先级排序的候选
 *  路径列表**：层级最多（`-` 尽量当分隔符）的解释优先。 */
export function unmangleCandidatesWin(name: string): string[] {
  // 格式：盘符字母 + "--"（':' 与根目录 '\' 各占一个 '-'）
  if (
    name.length < 3 ||
    !/^[A-Za-z]/.test(name[0]) ||
    name[1] !== "-" ||
    name[2] !== "-"
  ) {
    return [];
  }
  const drive = name[0];
  const segments = name.slice(3).split("-").filter((s) => s !== "");
  if (segments.length === 0) return [];
  const build = (sepsUsed: string[]): string => {
    let s = `${drive}:\\${segments[0]}`;
    sepsUsed.forEach((sep, i) => {
      s += sep + segments[i + 1];
    });
    return s;
  };
  return enumSegmentPaths(segments, ["\\", "-", "_", "."], build);
}

/** Claude Code 项目目录名的反向解析（macOS 风格）。macOS 上路径
 *  `/Users/foo/bar` 被 mangle 成 `-Users-foo-bar`（根 `/` 占开头一个 `-`）。 */
export function unmangleCandidatesPosix(name: string): string[] {
  if (!name.startsWith("-")) return [];
  const segments = name.slice(1).split("-").filter((s) => s !== "");
  if (segments.length === 0) return [];
  const build = (sepsUsed: string[]): string => {
    let s = `/${segments[0]}`;
    sepsUsed.forEach((sep, i) => {
      s += sep + segments[i + 1];
    });
    return s;
  };
  return enumSegmentPaths(segments, ["/", "-", "_", "."], build);
}

/** 按当前平台选择反向解析（与 Rust 版 #[cfg] 分发一致） */
export function unmangleCandidates(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "win32" ? unmangleCandidatesWin(name) : unmangleCandidatesPosix(name);
}

/** 反向解析出候选中第一个真实存在的路径（找不到返回 null） */
export function unmangleExisting(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return (
    unmangleCandidates(name, platform).find((c) => pathExistsDir(c)) ??
    null
  );
}

/** 反向解析出候选中第一个真实存在（文件或目录均可）的路径 */
export function unmangleExistingAny(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return unmangleCandidates(name, platform).find((c) => pathExistsAny(c)) ?? null;
}
