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

/** 工具调用行：一行摘要，点击展开输入 JSON */
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
