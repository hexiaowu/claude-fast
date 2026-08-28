// 文本清洗单元测试（移植自 Rust：strip_xml_blocks / clean_summary）
import { describe, expect, it } from "vitest";
import { cleanSummary, extractXmlTag, stripXmlBlocks } from "./text";

describe("stripXmlBlocks", () => {
  it("command-name / command-args 内容保留为标题（官方 /resume 列表同款语义）", () => {
    expect(stripXmlBlocks("<command-name>/flow</command-name>")).toBe("/flow ");
    expect(
      stripXmlBlocks("<command-name>/init</command-name><command-args>测试</command-args>"),
    ).toBe("/init 测试 ");
  });

  it("无闭合标签的孤立尖括号保留", () => {
    expect(stripXmlBlocks("a < b > c")).toBe("a < b > c");
  });
});

describe("cleanSummary", () => {
  it("换行/制表符折叠为空格", () => {
    expect(cleanSummary("  多行\n文本\t折叠  ")).toBe("多行 文本 折叠");
  });

  it("截断到 150 字符", () => {
    expect([...cleanSummary("x".repeat(300))].length).toBe(150);
  });
});

describe("extractXmlTag", () => {
  it("提取标签内容并 trim", () => {
    expect(extractXmlTag("前缀 <result> 结果 </result> 后缀", "result")).toBe("结果");
  });

  it("缺闭合标签或空内容返回 null", () => {
    expect(extractXmlTag("<result>没有闭合", "result")).toBeNull();
    expect(extractXmlTag("<result></result>", "result")).toBeNull();
  });
});
