// mangle / unmangle 单元测试（移植自 Rust 测试；Node 版双平台用例全部覆盖）
import { describe, expect, it } from "vitest";
import {
  combinations,
  enumSegmentPaths,
  isValidUuid,
  mangleProjectPath,
  unmangleCandidatesPosix,
  unmangleCandidatesWin,
} from "./mangle";

describe("mangleProjectPath", () => {
  it("Windows 路径", () => {
    expect(mangleProjectPath("D:\\MyWorkspaces\\jikehongbao")).toBe("D--MyWorkspaces-jikehongbao");
    expect(mangleProjectPath("D:\\WeChatProjects\\tms_app")).toBe("D--WeChatProjects-tms-app");
    expect(mangleProjectPath("D:\\MyWorkspaces\\cms\\DoraCMS-3.1")).toBe(
      "D--MyWorkspaces-cms-DoraCMS-3-1",
    );
    // 冒号与根斜杠各占一个 `-`
    expect(mangleProjectPath("D:\\baitai")).toBe("D--baitai");
  });

  it("macOS 路径：/ 也替换为 -，根 / 占开头一个 -", () => {
    expect(mangleProjectPath("/Users/me/proj")).toBe("-Users-me-proj");
    expect(mangleProjectPath("/Users/me/My Workspaces/my_app")).toBe(
      "-Users-me-My Workspaces-my-app",
    );
  });
});

describe("isValidUuid", () => {
  it("校验 uuid v4 格式", () => {
    expect(isValidUuid("5426d6d0-c08f-43bd-94df-4d6d99e5c699")).toBe(true);
    expect(isValidUuid("5426d6d0-c08f-43bd-94df")).toBe(false);
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid("5426d6d0c08f43bd94df4d6d99e5c699")).toBe(false);
  });
});

describe("unmangleCandidatesWin", () => {
  it("盘符根目录", () => {
    expect(unmangleCandidatesWin("D--baitai")).toEqual(["D:\\baitai"]);
  });

  it("普通路径（含歧义候选）", () => {
    const c = unmangleCandidatesWin("D--MyWorkspaces-jikehongbao");
    expect(c[0]).toBe("D:\\MyWorkspaces\\jikehongbao");
    // 歧义候选也保留（'-' 可能是 _ . - 或 \ 分隔）
    expect(c.length).toBe(4);
  });

  it("下划线与连字符歧义", () => {
    const c = unmangleCandidatesWin("D--WeChatProjects-tms-app");
    // 优先级：全分隔 > 单间隙合并 > 双间隙合并（- _ . 顺序）
    expect(c[0]).toBe("D:\\WeChatProjects\\tms\\app");
    expect(c).toContain("D:\\WeChatProjects\\tms_app");
    expect(c).toContain("D:\\WeChatProjects\\tms-app");
    expect(c).toContain("D:\\WeChatProjects-tms_app");
  });

  it("点号与连字符歧义", () => {
    const c = unmangleCandidatesWin("D--MyWorkspaces-cms-DoraCMS-3-1");
    expect(c[0]).toBe("D:\\MyWorkspaces\\cms\\DoraCMS\\3\\1");
    // 实测：DoraCMS-3.1 被 mangle 成 DoraCMS-3-1（'.' → '-'）
    expect(c).toContain("D:\\MyWorkspaces\\cms\\DoraCMS-3.1");
    expect(c).toContain("D:\\MyWorkspaces\\cms\\DoraCMS-3-1");
  });

  it("拒绝非法名字", () => {
    expect(unmangleCandidatesWin("")).toEqual([]);
    expect(unmangleCandidatesWin("no-dashes")).toEqual([]);
    expect(unmangleCandidatesWin("-X--abc")).toEqual([]);
  });

  it("段过多时降级为有限候选（不爆炸）", () => {
    const c = unmangleCandidatesWin("D--a-b-c-d-e-f-g-h");
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThanOrEqual(1 + 7 * 3);
    expect(c[0]).toBe("D:\\a\\b\\c\\d\\e\\f\\g\\h");
  });
});

describe("unmangleCandidatesPosix", () => {
  it("根路径候选（层级最多优先）", () => {
    const c = unmangleCandidatesPosix("-Users-foo-bar");
    expect(c[0]).toBe("/Users/foo/bar");
    expect(c).toContain("/Users-foo/bar"); // 间隙合并候选之一
  });

  it("下划线与连字符歧义", () => {
    const c = unmangleCandidatesPosix("-Users-me-tms-app");
    expect(c[0]).toBe("/Users/me/tms/app");
    expect(c).toContain("/Users/me/tms_app");
    expect(c).toContain("/Users/me/tms-app");
  });

  it("拒绝非法名字（必以 '-' 开头）", () => {
    expect(unmangleCandidatesPosix("")).toEqual([]);
    expect(unmangleCandidatesPosix("no-leading-dash")).toEqual([]);
    expect(unmangleCandidatesPosix("D--baitai")).toEqual([]); // Windows 格式，mac 不认
  });

  it("段过多时降级为有限候选", () => {
    const c = unmangleCandidatesPosix("-a-b-c-d-e-f-g-h");
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThanOrEqual(1 + 7 * 3);
    expect(c[0]).toBe("/a/b/c/d/e/f/g/h");
  });
});

describe("enumSegmentPaths / combinations", () => {
  it("macOS 风格枚举：层级最多候选排最前，歧义候选也在", () => {
    const segments = "Users-me-proj".split("-");
    const build = (sepsUsed: string[]): string => {
      let s = `/${segments[0]}`;
      sepsUsed.forEach((sep, i) => {
        s += sep + segments[i + 1];
      });
      return s;
    };
    const c = enumSegmentPaths(segments, ["/", "-", "_", "."], build);
    expect(c[0]).toBe("/Users/me/proj");
    expect(c).toContain("/Users/me-proj");
    expect(c).toContain("/Users_me/proj");
    expect(c).toContain("/Users-me/proj");

    // 单段：无歧义
    const c1 = enumSegmentPaths(["baitai"], ["/", "-", "_", "."], () => "/baitai");
    expect(c1).toEqual(["/baitai"]);
  });

  it("combinations 生成升序下标组合", () => {
    expect(combinations(3, 0)).toEqual([[]]);
    expect(combinations(3, 1)).toEqual([[0], [1], [2]]);
    expect(combinations(3, 2)).toEqual([[0, 1], [0, 2], [1, 2]]);
  });
});
