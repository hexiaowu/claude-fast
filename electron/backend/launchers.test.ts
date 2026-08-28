// 启动脚本列表/创建单元测试（移植自 Rust 测试：list/create 语义）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLauncher, findExistingScript, listLaunchers } from "./launchers";

let tmp: string;
let scripts: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-launchers-"));
  scripts = path.join(tmp, "scripts");
  fs.mkdirSync(scripts);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("listLaunchers", () => {
  it("只列 claude-*.bat，解析 cd 路径与 label", () => {
    fs.writeFileSync(
      path.join(scripts, "claude-tdc.bat"),
      '@echo off\r\nchcp 65001 >nul\r\ncd /d "D:\\proj\\tdc"',
    );
    fs.writeFileSync(path.join(scripts, "other.bat"), "@echo off\r\ncd /d C:\\x");
    fs.writeFileSync(path.join(scripts, "claude-noext.txt"), "not a script");
    const list = listLaunchers(scripts, "win32");
    expect(list.length).toBe(1);
    expect(list[0].key).toBe("claude-tdc");
    expect(list[0].label).toBe("tdc");
    expect(list[0].path).toBe("D:\\proj\\tdc");
  });

  it("cd 解析失败的脚本 path 为 null 但仍列出", () => {
    fs.writeFileSync(path.join(scripts, "claude-weird.bat"), "@echo off\r\nrem nothing");
    const list = listLaunchers(scripts, "win32");
    expect(list.length).toBe(1);
    expect(list[0].path).toBeNull();
  });

  it("目录不存在返回空数组", () => {
    expect(listLaunchers(path.join(tmp, "nope"), "win32")).toEqual([]);
  });
});

describe("findExistingScript / createLauncher", () => {
  // 真实存在的目标目录（Windows 上 statSync 校验需要真实路径）
  let tdcA: string;
  let tdcB: string;

  beforeEach(() => {
    tdcA = path.join(tmp, "w1", "tdc");
    tdcB = path.join(tmp, "w2", "tdc");
    fs.mkdirSync(tdcA, { recursive: true });
    fs.mkdirSync(tdcB, { recursive: true });
  });

  it("创建 → 再创建同路径复用（existed=true）", () => {
    const root = tmp;
    const r1 = createLauncher(root, tdcA, "win32");
    expect(r1.existed).toBe(false);
    expect(path.basename(r1.file)).toBe("claude-tdc.bat");
    const found = findExistingScript(scripts, tdcA.toUpperCase(), "win32"); // 大小写不敏感
    expect(found).toBe(r1.file);
    const r2 = createLauncher(root, tdcA, "win32");
    expect(r2.existed).toBe(true);
    expect(r2.file).toBe(r1.file);
  });

  it("同名叶子不同路径 → 自动加序号，绝不覆盖", () => {
    const r1 = createLauncher(tmp, tdcA, "win32");
    const r2 = createLauncher(tmp, tdcB, "win32");
    expect(path.basename(r1.file)).toBe("claude-tdc.bat");
    expect(path.basename(r2.file)).toBe("claude-tdc-2.bat");
  });

  it("路径不存在或不是文件夹 → 报错", () => {
    const nope = path.join(tmp, "no-such-dir");
    expect(() => createLauncher(tmp, nope, "win32")).toThrow("路径不存在或不是文件夹");
    const aFile = path.join(tmp, "afile.txt");
    fs.writeFileSync(aFile, "x");
    expect(() => createLauncher(tmp, aFile, "win32")).toThrow("路径不存在或不是文件夹");
  });

  it.runIf(process.platform !== "win32")(
    "macOS 风格：脚本生成 .sh 并 chmod 755",
    () => {
      const root = tmp;
      const dir = path.join(tmp, "projdir");
      fs.mkdirSync(dir);
      const r = createLauncher(root, dir, "darwin");
      expect(path.basename(r.file)).toBe("claude-projdir.sh");
      const content = fs.readFileSync(r.file, "utf8");
      expect(content).toContain(`cd "${dir}" || fail`);
      expect(fs.statSync(r.file).mode & 0o777).toBe(0o755);
    },
  );

  it("创建的脚本内容可被 list_launchers 解析回原路径", () => {
    const r = createLauncher(tmp, tdcA, "win32");
    const list = listLaunchers(scripts, "win32");
    expect(list.length).toBe(1);
    expect(list[0].file).toBe(r.file);
    expect(list[0].path).toBe(tdcA);
  });
});
