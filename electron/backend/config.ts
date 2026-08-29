// 配置读写（对齐原 Tauri 后端 load_config / save_config：.bak 回退 + 三步原子写）
import * as fs from "node:fs";
import * as path from "node:path";

export interface Config {
  /** 收藏的项目绝对路径（置顶） */
  favorites: string[];
  /** 手动添加的项目路径清单（Claude 会话扫描之外的补充；去脚本化后主列表的一部分） */
  projects: string[];
  dark: boolean;
  /** null = 每次询问；"quit" = 直接退出；"minimize" = 最小化到托盘 */
  closeAction: string | null;
}

export function defaultConfig(): Config {
  return { favorites: [], projects: [], dark: false, closeAction: null };
}

/** 剥离 UTF-8 BOM 后解析 JSON（Windows 编辑器可能带 BOM 写入） */
function parseJsonWithBom<T>(raw: Buffer): T | null {
  const body = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? raw.subarray(3)
    : raw;
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    return null;
  }
}

function readConfigFile(p: string): Config | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(p);
  } catch {
    return null;
  }
  const c = parseJsonWithBom<Partial<Config>>(raw);
  if (!c || typeof c !== "object") return null;
  return {
    favorites: Array.isArray(c.favorites) ? c.favorites.map(String) : [],
    projects: Array.isArray(c.projects) ? c.projects.map(String) : [],
    dark: c.dark === true,
    closeAction:
      c.closeAction === "quit" || c.closeAction === "minimize" ? c.closeAction : null,
  };
}

/** 读取配置：主文件损坏时自动回退到 .bak 并恢复主文件（收藏不丢失） */
export function loadConfig(root: string): Config {
  const cfgPath = path.join(root, "config.json");
  const bakPath = path.join(root, "config.json.bak");
  const c = readConfigFile(cfgPath);
  if (c) return c;
  const bak = readConfigFile(bakPath);
  if (bak) {
    try {
      fs.copyFileSync(bakPath, cfgPath);
    } catch {
      // 恢复失败不阻塞读取
    }
    return bak;
  }
  return defaultConfig();
}

/** 保存配置：写临时文件 → 旧文件备份为 .bak → 原子替换 */
export function saveConfig(root: string, cfg: Config): void {
  const json = JSON.stringify(cfg, null, 2);
  const cfgPath = path.join(root, "config.json");
  const bakPath = path.join(root, "config.json.bak");
  const tmpPath = path.join(root, "config.json.tmp");
  fs.writeFileSync(tmpPath, json, "utf8");
  if (fs.existsSync(cfgPath)) {
    fs.copyFileSync(cfgPath, bakPath);
  }
  fs.renameSync(tmpPath, cfgPath);
}
