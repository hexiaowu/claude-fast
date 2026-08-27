import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api } from "../lib/api";
import type {
  ContentBlock,
  SessionInfo,
  SessionMessage,
} from "../types";

interface Props {
  session: SessionInfo | null;
  /** 会话所属项目真实路径（resume 用） */
  projectPath: string | null;
  onResume: () => void;
  onToast: (msg: string) => void;
}

/** 每页消息数（与后端 MAX_SESSION_MESSAGES 一致） */
const PAGE_SIZE = 500;

/** ISO 时间戳 → HH:MM */
function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Markdown 渲染（marked + DOMPurify 消毒，cc-haha 同方案） */
function MarkdownText({ text }: { text: string }) {
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    } catch {
      return text;
    }
  }, [text]);
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 工具调用摘要（仿 cc-haha formatRecentToolUseSummary）：Bash · 命令 / Read · 文件名 */
function toolSummary(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const leaf = (p: unknown) =>
    String(p ?? "")
      .split(/[\\/]/)
      .pop() ?? "";
  switch (name) {
    case "Bash":
      return `Bash · ${String(obj.command ?? "")}`;
    case "Read":
      return `Read · ${leaf(obj.file_path)}`;
    case "Write":
      return `Write · ${leaf(obj.file_path)}`;
    case "Edit":
      return `Edit · ${leaf(obj.file_path)}`;
    case "MultiEdit":
      return `MultiEdit · ${leaf(obj.file_path)}`;
    case "Glob":
      return `Glob · ${String(obj.pattern ?? "")}`;
    case "Grep":
      return `Grep · ${String(obj.pattern ?? "")}`;
    case "Agent":
      return `Agent · ${String(obj.description ?? "")}`;
    case "TodoWrite":
      return "TodoWrite · 更新任务列表";
    default:
      return name;
  }
}

/** 将文本按行拆分，过滤末尾空行 */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// ---- 简单 LCS diff 算法（O(n*m)，会话内行数有限不会超时） ----

type DiffOp = { type: "equal" | "delete" | "insert"; text: string };

function lcsDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // 回溯生成 diff
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: "equal", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "insert", text: newLines[j - 1] });
      j--;
    } else {
      ops.unshift({ type: "delete", text: oldLines[i - 1] });
      i--;
    }
  }
  return ops;
}

// ---- 扩展 diff：给 equal 行加行号，delete/insert 行也带行号 ----

type DiffLine = {
  op: "equal" | "delete" | "insert";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

function enrichDiffOps(ops: DiffOp[]): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLn = 1;
  let newLn = 1;
  for (const op of ops) {
    switch (op.type) {
      case "equal":
        result.push({ op: "equal", text: op.text, oldLine: oldLn, newLine: newLn });
        oldLn++;
        newLn++;
        break;
      case "delete":
        result.push({ op: "delete", text: op.text, oldLine: oldLn, newLine: null });
        oldLn++;
        break;
      case "insert":
        result.push({ op: "insert", text: op.text, oldLine: null, newLine: newLn });
        newLn++;
        break;
    }
  }
  return result;
}

// ---- 渲染 ----

/** Claude Code 风格 diff 行（行号 + -/ + 前缀 + 内容） */
function DiffLineRow({ line }: { line: DiffLine }) {
  const cls = line.op === "delete" ? "diff-del" : line.op === "insert" ? "diff-add" : "";
  const prefix = line.op === "delete" ? "-" : line.op === "insert" ? "+" : " ";
  const lineNum = line.oldLine ?? line.newLine ?? null;
  return (
    <div className={`diff-line ${cls}`}>
      <span className="diff-ln">{lineNum ?? ""}</span>
      <span className="diff-prefix">{prefix}</span>
      <span className="diff-text">{line.text || " "}</span>
    </div>
  );
}

/** 编辑摘要行：Added N lines, removed M lines */
function editSummary(oldCount: number, newCount: number): string {
  const parts: string[] = [];
  if (newCount > 0) parts.push(`Added ${newCount} line${newCount > 1 ? "s" : ""}`);
  if (oldCount > 0) parts.push(`removed ${oldCount} line${oldCount > 1 ? "s" : ""}`);
  return parts.join(", ");
}

/** 代码变更卡片：Claude Code 风格 */
function CodeChangeCard({ block }: { block: ContentBlock }) {
  const name = block.name ?? "";
  const input = (block.input ?? {}) as Record<string, unknown>;
  const filePath = (input.file_path as string) ?? "";

  if (name === "Edit") {
    const oldLines = splitLines(String(input.old_string ?? ""));
    const newLines = splitLines(String(input.new_string ?? ""));
    const ops = lcsDiff(oldLines, newLines);
    const diffLines = enrichDiffOps(ops);
    return (
      <details className="diff-card" open={false}>
        <summary className="diff-summary">
          <span className="diff-icon">●</span>
          <span className="diff-title">Edit</span>
          <span className="diff-path">{filePath}</span>
        </summary>
        <div className="diff-summary-sub">
          {editSummary(oldLines.length, newLines.length)}
        </div>
        <div className="diff-body">
          {diffLines.map((dl, i) => (
            <DiffLineRow key={i} line={dl} />
          ))}
        </div>
      </details>
    );
  }

  if (name === "Write") {
    const content = splitLines(String(input.content ?? ""));
    return (
      <details className="diff-card" open={false}>
        <summary className="diff-summary">
          <span className="diff-icon">●</span>
          <span className="diff-title">Write</span>
          <span className="diff-path">{filePath}</span>
        </summary>
        <div className="diff-summary-sub">
          Added {content.length} line{content.length > 1 ? "s" : ""}
        </div>
        <div className="diff-body">
          {content.map((line, i) => (
            <DiffLineRow
              key={i}
              line={{ op: "insert", text: line, oldLine: null, newLine: i + 1 }}
            />
          ))}
        </div>
      </details>
    );
  }

  if (name === "MultiEdit") {
    const edits = (input.edits ?? []) as Array<Record<string, unknown>>;
    return (
      <details className="diff-card" open={false}>
        <summary className="diff-summary">
          <span className="diff-icon">●</span>
          <span className="diff-title">MultiEdit</span>
          <span className="diff-path">{filePath}</span>
        </summary>
        <div className="diff-summary-sub">
          {edits.length} edit{edits.length !== 1 ? "s" : ""}
        </div>
        <div className="diff-body">
          {edits.map((edit, i) => {
            const oldLines = splitLines(String(edit.old_string ?? ""));
            const newLines = splitLines(String(edit.new_string ?? ""));
            const ops = lcsDiff(oldLines, newLines);
            const diffLines = enrichDiffOps(ops);
            return (
              <div key={i} className="diff-edit-group">
                <div className="diff-edit-separator">
                  Edit #{i + 1}
                  <span className="diff-edit-sep-stat">
                    {editSummary(oldLines.length, newLines.length)}
                  </span>
                </div>
                {diffLines.map((dl, j) => (
                  <DiffLineRow key={j} line={dl} />
                ))}
              </div>
            );
          })}
          {edits.length === 0 && (
            <div className="diff-empty">No edits</div>
          )}
        </div>
      </details>
    );
  }

  return null;
}

/** 工具调用行：代码变更工具用 Claude Code diff，其他工具用摘要+JSON */
function ToolUseRow({
  block,
  hasResult,
  isError,
}: {
  block: ContentBlock;
  hasResult: boolean;
  isError: boolean;
}) {
  const name = block.name ?? "工具";
  if (name === "Edit" || name === "Write" || name === "MultiEdit") {
    return <CodeChangeCard block={block} />;
  }
  return (
    <details className="tool-row" open={false}>
      <summary className="tool-summary">
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{toolSummary(name, block.input)}</span>
        <span className={`tool-status ${isError ? "tool-error" : ""}`}>
          {isError ? "• 出错" : hasResult ? "• done" : ""}
        </span>
      </summary>
      <pre className="tool-body">
        {block.input ? JSON.stringify(block.input, null, 2).slice(0, 4000) : ""}
      </pre>
    </details>
  );
}

/** 工具结果卡 */
function ToolResultCard({
  block,
  toolName,
}: {
  block: ContentBlock;
  toolName: string | null;
}) {
  return (
    <details className="tool-result" open={false}>
      <summary className="tool-summary">
        <span className="tool-icon">{block.isError ? "⚠️" : "📄"}</span>
        <span className="tool-name">
          {block.isError ? "工具执行出错" : `${toolName ?? "工具"} 结果`}
        </span>
      </summary>
      <pre className="tool-body">{(block.text ?? "").slice(0, 4000)}</pre>
    </details>
  );
}

/** thinking 块：折叠展示 */
function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="thinking-block">
      <summary>💭 思考过程</summary>
      <div className="thinking-body">
        <MarkdownText text={text} />
      </div>
    </details>
  );
}

/** 单条消息 */
function Message({
  msg,
  resultMap,
  toolNames,
}: {
  msg: SessionMessage;
  resultMap: Map<string, boolean>;
  toolNames: Map<string, string>;
}) {
  if (msg.kind === "user") {
    const texts = msg.blocks.filter((b) => b.kind === "text");
    const results = msg.blocks.filter((b) => b.kind === "tool_result");
    if (texts.length === 0 && results.length > 0) {
      return (
        <div className="msg msg-tool-result-only">
          {results.map((b, i) => (
            <ToolResultCard
              key={i}
              block={b}
              toolName={b.toolUseId ? toolNames.get(b.toolUseId) ?? null : null}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="msg msg-user">
        <div className="msg-user-body">
          {texts.map((b, i) => (
            <MarkdownText key={i} text={b.text ?? ""} />
          ))}
          {results.map((b, i) => (
            <ToolResultCard
              key={`r${i}`}
              block={b}
              toolName={b.toolUseId ? toolNames.get(b.toolUseId) ?? null : null}
            />
          ))}
          <div className="msg-time">{formatTime(msg.timestamp)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg msg-assistant">
      <div className="msg-head">
        <span className="msg-model">{msg.model ?? "Claude"}</span>
        <span className="msg-time">{formatTime(msg.timestamp)}</span>
      </div>
      {msg.blocks.map((b, i) => {
        switch (b.kind) {
          case "text":
            return <MarkdownText key={i} text={b.text ?? ""} />;
          case "thinking":
            return <ThinkingBlock key={i} text={b.text ?? ""} />;
          case "tool_use": {
            const id = b.toolUseId ?? `${i}`;
            return (
              <ToolUseRow
                key={i}
                block={b}
                hasResult={resultMap.has(id)}
                isError={resultMap.get(id) ?? false}
              />
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

/** 右侧会话内容区：打开定位在最后一条，向上翻自动加载更早的 500 条 */
export default function SessionViewer({
  session,
  projectPath,
  onResume,
  onToast,
}: Props) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 初始加载完成后滚动到底部（焦点在最新一条） */
  const scrollToBottomRef = useRef(true);

  // 初始加载：默认取最后 500 条（session 切换或点「刷新」时重新加载）
  useEffect(() => {
    if (!session) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    scrollToBottomRef.current = true;
    setLoading(true);
    api
      .getSessionMessages(session.file)
      .then((data) => {
        if (cancelled) return;
        setMessages(data.messages);
        setOffset(data.offset);
        setHasMore(data.hasMore);
        setTotal(data.total);
      })
      .catch((e) => onToast("加载会话内容失败：" + String(e)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, reloadKey, onToast]);

  // 初始加载完成后滚动到底部
  useEffect(() => {
    if (!loading && messages.length > 0 && scrollToBottomRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      scrollToBottomRef.current = false;
    }
  }, [loading, messages]);

  // 加载更早的一页（offset - 500），插入顶部并保持滚动位置
  const loadMore = useCallback(async () => {
    if (!session || loadingMore || !hasMore) return;
    const body = bodyRef.current;
    const prevHeight = body?.scrollHeight ?? 0;
    const prevTop = body?.scrollTop ?? 0;
    setLoadingMore(true);
    try {
      const data = await api.getSessionMessages(
        session.file,
        Math.max(0, offset - PAGE_SIZE),
      );
      setMessages((prev) => [...data.messages, ...prev]);
      setOffset(data.offset);
      setHasMore(data.hasMore);
      setTotal(data.total);
      // 新增内容在顶部：滚动偏移补偿，保持当前阅读位置
      requestAnimationFrame(() => {
        if (body) body.scrollTop = prevTop + (body.scrollHeight - prevHeight);
      });
    } catch (e) {
      onToast("加载更早消息失败：" + String(e));
    }
    setLoadingMore(false);
  }, [session, loadingMore, hasMore, offset, onToast]);

  // 滚到顶部附近自动加载更早
  const onScroll = useCallback(() => {
    const body = bodyRef.current;
    if (!body || body.scrollTop > 40) return;
    void loadMore();
  }, [loadMore]);

  // tool_use / tool_result 跨消息关联
  const { resultMap, toolNames } = useMemo(() => {
    const resultMap = new Map<string, boolean>();
    const toolNames = new Map<string, string>();
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind === "tool_result" && b.toolUseId) {
          resultMap.set(b.toolUseId, !!b.isError);
        }
      }
    }
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind === "tool_use" && b.name) {
          toolNames.set(b.toolUseId ?? "", b.name);
        }
      }
    }
    return { resultMap, toolNames };
  }, [messages]);

  if (!session) {
    return (
      <div className="viewer">
        <div className="viewer-empty">
          <div className="empty-icon">💬</div>
          <div>选择左侧会话查看内容</div>
          <div className="empty-sub">点击项目行展开会话列表，再点击会话</div>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="viewer-head-body">
          <div className="viewer-title">{session.title}</div>
          <div className="viewer-meta">
            {projectPath ?? session.file}
            {total > 0 ? ` · 共 ${total} 条消息` : ""}
          </div>
        </div>
        <div className="viewer-actions">
          <button
            className="btn"
            onClick={() => setReloadKey((k) => k + 1)}
            title="重新读取会话内容"
          >
            刷新
          </button>
          <button className="btn btn-primary" onClick={onResume} title="新开窗口继续这个对话">
            ▶ 继续对话
          </button>
        </div>
      </div>
      <div className="viewer-body" ref={bodyRef} onScroll={onScroll}>
        {loading ? (
          <div className="viewer-empty">加载中…</div>
        ) : messages.length === 0 ? (
          <div className="viewer-empty">
            <div className="empty-icon">🗒</div>
            <div>这个会话没有可显示的内容</div>
          </div>
        ) : (
          <>
            {hasMore ? (
              <button
                className="viewer-load-more"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "加载中…" : `↑ 加载更早的消息（还剩 ${offset} 条）`}
              </button>
            ) : offset > 0 ? (
              <div className="viewer-truncated">已到会话开头</div>
            ) : null}
            {messages.map((m, i) => (
              <Message key={i} msg={m} resultMap={resultMap} toolNames={toolNames} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
