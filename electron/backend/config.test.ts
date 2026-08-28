// 配置读写单元测试（移植自 Rust：strip_bom / load_config 回退 / save_config 原子写）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "./config";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fast-test-config-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("读取正常配置", () => {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({ favorites: ["a", "b"], dark: true, closeAction: "quit" }),
    );
    const c = loadConfig(tmp);
    expect(c.favorites).toEqual(["a", "b"]);
    expect(c.dark).toBe(true);
    expect(c.closeAction).toBe("quit");
  });

  it("BOM 文件可读", () => {
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"a":1}', "utf8"),
    ]);
    fs.writeFileSync(path.join(tmp, "config.json"), raw);
    // 字段缺失时回退默认值（不抛错）
    expect(loadConfig(tmp)).toEqual(defaultConfig());
  });

  it("主文件损坏 → 回退 .bak 并恢复主文件", () => {
    fs.writeFileSync(path.join(tmp, "config.json.bak"), '{"favorites":["x"],"dark":true}');
    fs.writeFileSync(path.join(tmp, "config.json"), "{broken");
    const c = loadConfig(tmp);
    expect(c.favorites).toEqual(["x"]);
    expect(c.dark).toBe(true);
    // 主文件已从 .bak 恢复
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8")).favorites).toEqual([
      "x",
    ]);
  });

  it("都缺失 → 默认配置", () => {
    expect(loadConfig(tmp)).toEqual(defaultConfig());
  });
});

describe("saveConfig", () => {
  it("三步保护：临时文件 → .bak 备份 → 原子替换", () => {
    // 第一次保存
    saveConfig(tmp, { favorites: ["a"], dark: false, closeAction: null });
    expect(loadConfig(tmp).favorites).toEqual(["a"]);
    // 第二次保存后旧内容应进 .bak
    saveConfig(tmp, { favorites: ["a", "b"], dark: true, closeAction: "minimize" });
    const bak = JSON.parse(fs.readFileSync(path.join(tmp, "config.json.bak"), "utf8"));
    expect(bak.favorites).toEqual(["a"]);
    const main = loadConfig(tmp);
    expect(main.favorites).toEqual(["a", "b"]);
    expect(main.dark).toBe(true);
    expect(main.closeAction).toBe("minimize");
    // 无临时文件残留
    expect(fs.existsSync(path.join(tmp, "config.json.tmp"))).toBe(false);
  });
});
