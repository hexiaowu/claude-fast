// paths.ts 单元测试（移植自 Rust：resolve_root / is_root_dir / app_data_root / claude_projects_dir）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appDataRoot,
  claudeProjectsDir,
  isRootDir,
  legacyMarker,
  resolveRootDir,
  scriptExt,
} from "./paths";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-paths-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scriptExt / legacyMarker", () => {
  it("按平台返回 bat/sh", () => {
    expect(scriptExt("win32")).toBe("bat");
    expect(scriptExt("darwin")).toBe("sh");
    expect(scriptExt("linux")).toBe("sh");
    expect(legacyMarker("win32")).toBe("claude-claude-fast.bat");
    expect(legacyMarker("darwin")).toBe("claude-claude-fast.sh");
  });
});

describe("isRootDir", () => {
  it("识别新布局（config.json + scripts/）", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), "{}");
    fs.mkdirSync(path.join(tmp, "scripts"));
    expect(isRootDir(tmp)).toBe(true);
  });

  it("只有 config.json 没有 scripts 目录 → 不是根", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), "{}");
    expect(isRootDir(tmp)).toBe(false);
  });

  it("识别旧布局（claude-claude-fast.bat）", () => {
    fs.writeFileSync(path.join(tmp, legacyMarker("win32")), "");
    expect(isRootDir(tmp, "win32")).toBe(true);
    // sh 标记在 win32 布局下不算
    expect(isRootDir(tmp, "darwin")).toBe(false);
  });
});

describe("appDataRoot", () => {
  it("指向 claude-fast 数据目录", () => {
    const p = appDataRoot("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" });
    expect(p.toLowerCase()).toContain("claude-fast");
    const m = appDataRoot("darwin", { HOME: "/Users/me" });
    expect(m).toBe(path.join("/Users/me", "Library", "Application Support", "claude-fast"));
  });
});

describe("resolveRootDir", () => {
  it("便携模式：exe 所在目录即数据根", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), "{}");
    fs.mkdirSync(path.join(tmp, "scripts"));
    const exe = path.join(tmp, "claude-fast.exe");
    const r = resolveRootDir(exe, "win32", { APPDATA: path.join(tmp, "appdata") });
    expect(r.root).toBe(tmp);
    expect(r.installMode).toBe(false);
  });

  it("便携模式：数据根在 exe 上级目录", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), "{}");
    fs.mkdirSync(path.join(tmp, "scripts"));
    const sub = path.join(tmp, "app", "bin");
    fs.mkdirSync(sub, { recursive: true });
    const r = resolveRootDir(path.join(sub, "claude-fast.exe"), "win32", {
      APPDATA: path.join(tmp, "appdata"),
    });
    expect(r.root).toBe(tmp);
  });

  it("安装模式：找不到标记 → 回退 %APPDATA%\\claude-fast 并创建 scripts/", () => {
    const appdata = path.join(tmp, "appdata");
    const r = resolveRootDir(path.join(tmp, "bin", "claude-fast.exe"), "win32", { APPDATA: appdata });
    expect(r.root).toBe(path.join(appdata, "claude-fast"));
    expect(r.installMode).toBe(true);
    expect(fs.existsSync(path.join(r.root, "scripts"))).toBe(true);
  });
});

describe("claudeProjectsDir", () => {
  it("CLAUDE_CONFIG_DIR 优先（官方自定义数据目录）", () => {
    const fake = path.join(tmp, "cc-config-dir");
    expect(claudeProjectsDir("win32", { CLAUDE_CONFIG_DIR: fake, USERPROFILE: "C:\\u" })).toBe(
      path.join(fake, "projects"),
    );
  });

  it("Windows 默认 %USERPROFILE%\\.claude\\projects", () => {
    expect(claudeProjectsDir("win32", { USERPROFILE: "C:\\Users\\me" })).toBe(
      path.join("C:\\Users\\me", ".claude", "projects"),
    );
  });

  it("macOS：~/.claude/projects 存在则优先", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    expect(claudeProjectsDir("darwin", { HOME: home })).toBe(
      path.join(home, ".claude", "projects"),
    );
  });

  it("macOS：~/.claude 缺失时后备 Claude Desktop 目录", () => {
    const home = path.join(tmp, "home2");
    fs.mkdirSync(
      path.join(home, "Library", "Application Support", "Claude", "projects"),
      { recursive: true },
    );
    expect(claudeProjectsDir("darwin", { HOME: home })).toBe(
      path.join(home, "Library", "Application Support", "Claude", "projects"),
    );
  });

  it("macOS：两者都缺失 → 返回 CLI 规范路径", () => {
    const home = path.join(tmp, "home3");
    expect(claudeProjectsDir("darwin", { HOME: home })).toBe(
      path.join(home, ".claude", "projects"),
    );
  });
});
