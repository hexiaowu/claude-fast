// 文本清洗工具（对齐原 Tauri 后端的标题/摘要清洗逻辑）

/** 剥离 XML 标签块（如 <command-name>/<command-args> 包裹的标题源）。
 *  command-args 块**保留块内文本**（它是标题内容本身），其余块整体剥离；
 *  无闭合标签的孤立 `<` 原样保留。对应 cc-haha cleanSessionTitleSource。 */
export function stripXmlBlocks(s: string): string {
  let out = "";
  let rest = s;
  for (;;) {
    const start = rest.indexOf("<");
    if (start === -1) {
      out += rest;
      break;
    }
    out += rest.slice(0, start);
    const gtRel = rest.slice(start).indexOf(">");
    if (gtRel !== -1) {
      const inner = rest.slice(start + 1, start + gtRel);
      // 标签名：字母数字 - _（ASCII）
      const m = inner.match(/^[A-Za-z0-9_-]+/);
      if (m) {
        const name = m[0];
        const close = `</${name}>`;
        const after = rest.slice(start + gtRel + 1);
        const end = after.indexOf(close);
        if (end !== -1) {
          if (name === "command-name" || name === "command-args") {
            // 保留块内文本（命令名/参数就是标题内容本身，
            // 如 /init 会话的标题即 "/init"）
            out += after.slice(0, end) + " ";
          } else {
            out += " ";
          }
          rest = after.slice(end + close.length);
          continue;
        }
      }
    }
    out += "<";
    rest = rest.slice(start + 1);
  }
  return out;
}

/** 摘要/标题清洗：换行/制表符折叠为空格、剥离 XML 标签块、合并空白、截断 150 字符 */
export function cleanSummary(s: string): string {
  const folded = s.replace(/[\r\n\t]/g, " ");
  const stripped = stripXmlBlocks(folded);
  const merged = stripped.split(/\s+/).filter((x) => x !== "").join(" ");
  return [...merged].slice(0, 150).join("");
}

/** 标题清洗（重命名用）：控制字符/换行折叠为空格、合并空白、限长 200 */
export function cleanTitle(s: string): string {
  const folded = s.replace(/[\r\n\t]/g, " ");
  return folded.split(/\s+/).filter((x) => x !== "").join(" ").slice(0, 200);
}

/** 提取 XML 标签内容（简单字符串匹配，不处理嵌套同名标签） */
export function extractXmlTag(s: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = s.indexOf(open);
  if (start === -1) return null;
  const rest = s.slice(start + open.length);
  const end = rest.indexOf(close);
  if (end === -1) return null;
  const t = rest.slice(0, end).trim();
  return t === "" ? null : t;
}

/** 从 content 块数组中提取文本（tool_result 的 content 可能是 string 或数组）。
 *  对齐原 block_text：字符串 trim 后为空 → null；数组取 text 块以 \n 连接。 */
export function blockText(
  content: string | Array<{ type?: string; text?: string }>,
): string | null {
  if (typeof content === "string") {
    const t = content.trim();
    return t === "" ? null : t;
  }
  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    return parts.length === 0 ? null : parts.join("\n");
  }
  return null;
}
