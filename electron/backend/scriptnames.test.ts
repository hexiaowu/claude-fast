// 启动脚本命名/模板/解析单元测试（移植自 Rust 测试：parse_cd_* / bat_name_* / gen_* / sh_quote）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildScriptName,
  genBat,
  genSh,
  parseCdPath,
  pickUniqueScriptPath,
  shQuote,
} from "./scriptnames";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-names-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("parseCdPath", () => {
  it("bat 带引号", () => {
    expect(
      parseCdPath('@echo off\r\nchcp 65001 >nul\r\ncd /d "D:\\MyWorkspaces\\yaotu\\tdc"'),
    ).toBe("D:\\MyWorkspaces\\yaotu\\tdc");
  });

  it("bat 不带引号", () => {
    expect(parseCdPath("cd /d C:\\proj")).toBe("C:\\proj");
  });

  it("无 cd 行返回 null", () => {
    expect(parseCdPath("@echo off\r\necho hi")).toBeNull();
  });

  it("大小写不敏感", () => {
    expect(parseCdPath('CD /D "X:\\y z"')).toBe("X:\\y z");
  });

  it("sh 带引号（含 || exit 1 后缀）", () => {
    expect(
      parseCdPath('#!/bin/bash\ncd "/Users/me/My Workspaces/proj" || exit 1\nexec claude'),
    ).toBe("/Users/me/My Workspaces/proj");
  });

  it("sh 不带引号", () => {
    expect(parseCdPath("cd /Users/me/proj")).toBe("/Users/me/proj");
  });
});

describe("buildScriptName", () => {
  it("统一叶子目录名（无工作区概念）", () => {
    expect(buildScriptName("D:\\MyWorkspaces\\yaotu\\tdc", "bat", "win32")).toBe("claude-tdc.bat");
    expect(buildScriptName("D:\\MyWorkspaces\\proj a\\sub", "bat", "win32")).toBe("claude-sub.bat");
    expect(buildScriptName("D:\\WeChatProjects\\tms_app", "bat", "win32")).toBe(
      "claude-tms_app.bat",
    );
    expect(buildScriptName("C:\\Users\\me\\stuff\\myproj", "bat", "win32")).toBe(
      "claude-myproj.bat",
    );
    expect(buildScriptName("D:\\baitai", "bat", "win32")).toBe("claude-baitai.bat");
  });

  it("特殊字符清洗与根目录兜底", () => {
    expect(buildScriptName("D:\\MyWorkspaces\\a:b\\c<d", "bat", "win32")).toBe("claude-c-d.bat");
    // 尾部斜杠：叶子取 MyWorkspaces（basename 忽略尾部分隔符）
    expect(buildScriptName("D:\\MyWorkspaces\\", "bat", "win32")).toBe("claude-MyWorkspaces.bat");
    // 根目录无叶子 → project 兜底
    expect(buildScriptName("D:\\", "bat", "win32")).toBe("claude-project.bat");
  });

  it("macOS 风格", () => {
    expect(buildScriptName("/Users/me/proj", "sh", "darwin")).toBe("claude-proj.sh");
    expect(buildScriptName("/Users/me/My Workspaces/my_app", "sh", "darwin")).toBe(
      "claude-my_app.sh",
    );
  });
});

describe("pickUniqueScriptPath", () => {
  it("同名冲突自动加序号，绝不覆盖", () => {
    const scripts = path.join(tmp, "scripts");
    fs.mkdirSync(scripts);
    const target = "D:\\MyWorkspaces\\yaotu\\tdc";
    // 无占用 → 基础名
    expect(pickUniqueScriptPath(scripts, target, "bat", "win32")).toBe(
      path.join(scripts, "claude-tdc.bat"),
    );
    // 基础名被其他路径占用 → 加序号 2
    fs.writeFileSync(path.join(scripts, "claude-tdc.bat"), '@echo off\r\ncd /d "C:\\other"');
    expect(pickUniqueScriptPath(scripts, target, "bat", "win32")).toBe(
      path.join(scripts, "claude-tdc-2.bat"),
    );
    // 2 也被占用 → 3
    fs.writeFileSync(path.join(scripts, "claude-tdc-2.bat"), '@echo off\r\ncd /d "C:\\other2"');
    expect(pickUniqueScriptPath(scripts, target, "bat", "win32")).toBe(
      path.join(scripts, "claude-tdc-3.bat"),
    );
  });
});

describe("脚本模板", () => {
  it("gen_bat 模板与旧版 PowerShell 一致", () => {
    const bat = genBat("D:\\MyWorkspaces\\tdc", "tdc");
    expect(bat.startsWith("@echo off\r\n")).toBe(true);
    expect(bat).toContain("chcp 65001");
    expect(bat).toContain('cd /d "D:\\MyWorkspaces\\tdc"');
    expect(bat).toContain("call claude");
    expect(bat).toContain(":err");
  });

  it("gen_sh 模板：目录失效走 fail()（不闪退）", () => {
    const sh = genSh("/Users/me/My Workspaces/proj", "proj");
    expect(sh.startsWith("#!/bin/bash\n")).toBe(true);
    expect(sh).toContain("fail() {");
    expect(sh).toContain('cd "/Users/me/My Workspaces/proj" || fail');
    expect(sh).toContain("command -v claude");
    expect(sh).toContain("exec claude");
  });

  it("shQuote 转义双引号内元字符", () => {
    expect(shQuote('a"b$c`d\\e')).toBe('a\\"b\\$c\\`d\\\\e');
    expect(shQuote("/Users/me/proj")).toBe("/Users/me/proj");
    expect(shQuote("普通 中文 路径")).toBe("普通 中文 路径");
  });
});
