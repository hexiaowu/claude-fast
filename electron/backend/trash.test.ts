// 回收站单元测试（移植自 Rust：utc_timestamp / delete/list/restore/purge）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deleteSessionFile,
  listTrashedSessionsIn,
  purgeTrashIn,
  restoreTrashedFile,
  utcTimestamp,
  validateTrashFile,
} from "./trash";

const UUID = "5426d6d0-c08f-43bd-94df-4d6d99e5c699";

let tmp: string;
let projects: string;
let trash: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-trash-"));
  projects = path.join(tmp, "projects");
  trash = path.join(tmp, "trash", "sessions");
  fs.mkdirSync(projects);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sampleHead(): string {
  return [
    '{"type":"mode","mode":"normal","sessionId":"' + UUID + '"}',
    '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"修复登录页面的 bug"},"timestamp":"2026-08-12T06:47:46.519Z"}',
    '{"type":"ai-title","aiTitle":"修复登录页面","sessionId":"' + UUID + '"}',
    "",
  ].join("\n");
}

describe("utcTimestamp", () => {
  it("格式 YYYYMMDD_HHMMSS（UTC）", () => {
    expect(utcTimestamp(new Date(Date.UTC(2026, 7, 12, 6, 47, 46)))).toBe("20260812_064746");
    const ts = utcTimestamp();
    expect(ts.length).toBe(15);
    expect(/^\d{8}_\d{6}$/.test(ts)).toBe(true);
  });
});

describe("deleteSessionFile", () => {
  it("移入回收站并保留原项目目录名", () => {
    const mangled = "D--MyWorkspaces-myProject-claude-fast";
    const projDir = path.join(projects, mangled);
    fs.mkdirSync(projDir, { recursive: true });
    const file = path.join(projDir, UUID + ".jsonl");
    fs.writeFileSync(file, sampleHead());
    const contentBefore = fs.readFileSync(file, "utf8");

    const backup = deleteSessionFile(file, trash);
    expect(fs.existsSync(file)).toBe(false);
    expect(backup.startsWith(trash)).toBe(true);
    expect(backup.endsWith(`${mangled}/${UUID}.jsonl`.replaceAll("/", path.sep))).toBe(true);
    expect(fs.readFileSync(backup, "utf8")).toBe(contentBefore);
  });
});

describe("listTrashedSessionsIn", () => {
  it("解析标题并按删除时间倒序", () => {
    const older = path.join(trash, "20260811_100000", "D--baitai");
    const newer = path.join(
      trash,
      "20260812_090000",
      "D--MyWorkspaces-myProject-claude-fast",
    );
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(
      path.join(older, "11111111-1111-4111-8111-111111111111.jsonl"),
      sampleHead(),
    );
    fs.writeFileSync(
      path.join(newer, "22222222-2222-4222-8222-222222222222.jsonl"),
      sampleHead(),
    );

    const list = listTrashedSessionsIn(trash);
    expect(list.length).toBe(2);
    expect(list[0].deletedAt).toBe("20260812_090000");
    expect(list[1].deletedAt).toBe("20260811_100000");
    expect(list[0].title).toBe("修复登录页面");
    expect(list[0].sessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(list[0].projectDir).toBe("D--MyWorkspaces-myProject-claude-fast");
  });
});

describe("restoreTrashedFile", () => {
  it("删除 → 恢复 roundtrip；重复恢复报错", () => {
    const mangled = "D--MyWorkspaces-myProject-claude-fast";
    const projDir = path.join(projects, mangled);
    fs.mkdirSync(projDir, { recursive: true });
    const file = path.join(projDir, UUID + ".jsonl");
    fs.writeFileSync(file, sampleHead());
    const contentBefore = fs.readFileSync(file, "utf8");

    const backup = deleteSessionFile(file, trash);
    expect(fs.existsSync(file)).toBe(false);

    const restored = restoreTrashedFile(backup, projects);
    expect(restored).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe(contentBefore);
    expect(fs.existsSync(backup)).toBe(false);

    expect(() => restoreTrashedFile(backup, projects)).toThrow("已存在");
  });

  it("目标已存在同名会话 → 拒绝且备份不破坏", () => {
    const mangled = "D--baitai";
    const projDir = path.join(projects, mangled);
    fs.mkdirSync(projDir, { recursive: true });
    const existing = path.join(projDir, UUID + ".jsonl");
    fs.writeFileSync(existing, "existing");
    const backupDir = path.join(trash, "20260812_090000", mangled);
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, UUID + ".jsonl");
    fs.writeFileSync(backup, "backup");

    expect(() => restoreTrashedFile(backup, projects)).toThrow("已存在");
    expect(fs.existsSync(backup)).toBe(true);
  });
});

describe("validateTrashFile", () => {
  it("trash 目录内 uuid.jsonl 通过；越界拒绝", () => {
    const root = tmp;
    const backup = path.join(root, "trash", "sessions", "20260812_090000", "D--baitai", UUID + ".jsonl");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, "x");
    const v = validateTrashFile(backup, root);
    expect(v.sessionId).toBe(UUID);
    expect(v.mangled).toBe("D--baitai");
    expect(() => validateTrashFile(path.join(root, "elsewhere", UUID + ".jsonl"), root)).toThrow();
  });
});

describe("purgeTrashIn", () => {
  it("彻底删除全部备份、保留 sessions/ 根，返回数量；空回收站清空返回 0", () => {
    const batch1 = path.join(trash, "20260811_100000", "D--baitai");
    const batch2 = path.join(
      trash,
      "20260812_090000",
      "D--MyWorkspaces-myProject-claude-fast",
    );
    fs.mkdirSync(batch1, { recursive: true });
    fs.mkdirSync(batch2, { recursive: true });
    fs.writeFileSync(path.join(batch1, "11111111-1111-4111-8111-111111111111.jsonl"), sampleHead());
    fs.writeFileSync(path.join(batch2, "22222222-2222-4222-8222-222222222222.jsonl"), sampleHead());
    fs.writeFileSync(path.join(batch2, "33333333-3333-4333-8333-333333333333.jsonl"), sampleHead());

    expect(purgeTrashIn(trash)).toBe(3);
    expect(fs.existsSync(trash)).toBe(true);
    expect(listTrashedSessionsIn(trash)).toEqual([]);
    // 磁盘上没有任何残留备份（trash/ 下只剩空的 sessions/）
    expect(fs.readdirSync(path.join(tmp, "trash")).length).toBe(1);
    expect(purgeTrashIn(trash)).toBe(0);
  });
});
