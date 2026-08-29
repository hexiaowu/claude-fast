// scriptnames.ts 单元测试（去脚本化后仅存 parseCdPath / shQuote）
import { describe, expect, it } from "vitest";
import { parseCdPath, shQuote } from "./scriptnames";

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

describe("shQuote", () => {
  it("转义双引号内元字符", () => {
    expect(shQuote('a"b$c`d\\e')).toBe('a\\"b\\$c\\`d\\\\e');
    expect(shQuote("/Users/me/proj")).toBe("/Users/me/proj");
    expect(shQuote("普通 中文 路径")).toBe("普通 中文 路径");
  });
});
