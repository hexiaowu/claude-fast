import { useCallback, useState } from "react";
import type { DragEvent } from "react";
import type { Project, Section, SessionInfo } from "../types";

interface Props {
  sections: Section[];
  /** true = 未建任何分组：不渲染节标题行，保持旧版平铺观感 */
  plain: boolean;
  favorites: string[];
  selectedKey: string | null;
  /** 当前展开会话列表的项目 key */
  expandedKey: string | null;
  /** 当前在右侧打开的会话文件路径（用于列表高亮标记） */
  activeSessionFile: string | null;
  /** 各项目的会话缓存：undefined = 未加载；null = 加载中；数组 = 已加载 */
  sessionsByKey: Record<string, SessionInfo[] | null | undefined>;
  onSelect: (key: string) => void;
  onLaunch: (key: string) => void;
  onToggleFav: (key: string) => void;
  /** 收藏项拖拽排序：把 draggedKey 移动到 targetKey 之前/之后 */
  onReorderFavorite: (draggedKey: string, targetKey: string, before: boolean) => void;
  /** 是否启用拖拽排序（搜索过滤期间禁用） */
  dragEnabled: boolean;
  onToggleExpand: (key: string) => void;
  /** 折叠/展开分组 */
  onToggleGroup: (name: string) => void;
  /** 分组标题拖拽换位：把 dragName 移动到 targetName 之前/之后 */
  onReorderGroup: (dragName: string, targetName: string, before: boolean) => void;
  /** 重命名分组（标题行 ✎） */
  onRenameGroup: (name: string) => void;
  /** 删除分组（标题行 🗑，组内项目移到未分组） */
  onDeleteGroup: (name: string) => void;
  onRenameSession: (key: string, session: SessionInfo) => void;
  onDeleteSession: (key: string, session: SessionInfo) => void;
  onOpenSession: (key: string, session: SessionInfo) => void;
  onResumeSession: (key: string, session: SessionInfo) => void;
  onContextMenu: (x: number, y: number, key: string) => void;
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / MM-DD HH:mm */
function formatTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return "昨天";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ProjectList({
  sections,
  plain,
  favorites,
  selectedKey,
  expandedKey,
  activeSessionFile,
  sessionsByKey,
  onSelect,
  onLaunch,
  onToggleFav,
  onReorderFavorite,
  dragEnabled,
  onToggleExpand,
  onToggleGroup,
  onReorderGroup,
  onRenameGroup,
  onDeleteGroup,
  onRenameSession,
  onDeleteSession,
  onOpenSession,
  onResumeSession,
  onContextMenu,
}: Props) {
  // ---------- 收藏拖拽排序（仅临时视觉状态，顺序真源在 App 的 favorites 数组）----------

  /** 正在拖拽的收藏项 key */
  const [dragKey, setDragKey] = useState<string | null>(null);
  /** 悬停目标行 key */
  const [overKey, setOverKey] = useState<string | null>(null);
  /** 悬停在上半/下半（决定插入到目标之前/之后） */
  const [overPos, setOverPos] = useState<"above" | "below">("above");

  /** dragend 兜底清理：Esc 取消 / 窗外释放都会触发 */
  const clearDragState = useCallback(() => {
    setDragKey(null);
    setOverKey(null);
  }, []);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, key: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key); // WebKit：无 data 拖拽不会启动
    setDragKey(key);
  };

  const handleDragOver = (
    e: DragEvent<HTMLDivElement>,
    key: string,
    isFav: boolean,
  ) => {
    if (!dragKey || !isFav) return; // 不 preventDefault → 此处不可放置（浏览器显示禁用光标）
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < r.top + r.height / 2 ? "above" : "below";
    setOverKey((k) => (k === key ? k : key)); // 值不变 → React 跳过重渲染（dragover 高频触发）
    setOverPos((p) => (p === pos ? p : pos));
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>, key: string) => {
    if (overKey !== key) return;
    const rt = e.relatedTarget as Node | null;
    if (rt && e.currentTarget.contains(rt)) return; // 仍在行内（子元素间移动）
    setOverKey(null);
  };

  const handleDrop = (
    e: DragEvent<HTMLDivElement>,
    key: string,
    isFav: boolean,
  ) => {
    if (!dragKey || !isFav) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2; // 从事件重算，不依赖 state
    const dragged = dragKey;
    clearDragState();
    onReorderFavorite(dragged, key, before);
  };

  // ---------- 分组标题拖拽（与收藏行拖拽互不干扰：source/target 均为标题行）----------

  /** 正在拖拽的分组名 */
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  /** 悬停目标分组名 */
  const [overGroup, setOverGroup] = useState<string | null>(null);
  /** 悬停在上半/下半（决定插入到目标之前/之后） */
  const [overGroupPos, setOverGroupPos] = useState<"above" | "below">("above");

  const clearGroupDrag = useCallback(() => {
    setDragGroup(null);
    setOverGroup(null);
  }, []);

  const handleGroupDragStart = (e: DragEvent<HTMLDivElement>, name: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `group:${name}`); // WebKit：无 data 拖拽不会启动
    setDragGroup(name);
  };

  const handleGroupDragOver = (e: DragEvent<HTMLDivElement>, name: string) => {
    if (!dragGroup || dragGroup === name) return; // 不 preventDefault → 此处不可放置
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < r.top + r.height / 2 ? "above" : "below";
    setOverGroup((k) => (k === name ? k : name)); // 值不变 → React 跳过重渲染
    setOverGroupPos((p) => (p === pos ? p : pos));
  };

  const handleGroupDrop = (e: DragEvent<HTMLDivElement>, name: string) => {
    if (!dragGroup || dragGroup === name) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2; // 从事件重算，不依赖 state
    const dragged = dragGroup;
    clearGroupDrag();
    onReorderGroup(dragged, name, before);
  };

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  if (total === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">🗂</div>
        <div>没有找到匹配的项目</div>
        <div className="empty-sub">点击「批量添加」扫描 Claude Code 项目，或「新建」手动添加</div>
      </div>
    );
  }

  /** 单行渲染（含收藏星标、拖拽、右键、会话展开），供各分节复用 */
  const renderRow = (l: Project) => {
        const isFav = favorites.includes(l.key);
        const canDrag = dragEnabled && isFav;
        const showDrop = overKey === l.key && l.key !== dragKey;
        const isSelected = l.key === selectedKey;
        const isExpanded = l.key === expandedKey;
        const sessions = sessionsByKey[l.key];
        return (
          <div key={l.key} className={`row-wrap ${isExpanded ? "expanded" : ""}`}>
            <div
              className={`row ${isSelected ? "selected" : ""} ${
                l.healthy === false ? "broken" : ""
              } ${isFav ? "row-fav" : ""} ${l.key === dragKey ? "dragging" : ""} ${
                showDrop ? (overPos === "above" ? "drop-above" : "drop-below") : ""
              }`}
              draggable={canDrag}
              onDragStart={(e) => handleDragStart(e, l.key)}
              onDragEnd={clearDragState}
              onDragOver={(e) => handleDragOver(e, l.key, isFav)}
              onDragLeave={(e) => handleDragLeave(e, l.key)}
              onDrop={(e) => handleDrop(e, l.key, isFav)}
              onClick={() => {
                onSelect(l.key);
                onToggleExpand(l.key);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(l.key);
                onContextMenu(e.clientX, e.clientY, l.key);
              }}
            >
              <button
                className={`star ${isFav ? "star-on" : ""}`}
                title={isFav ? "取消收藏" : "收藏（置顶）"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFav(l.key);
                }}
              >
                ★
              </button>
              <div className="row-body" title="展开/收起会话列表">
                <div className="row-label">
                  {l.name}
                  {l.healthy === false && <span className="tag tag-danger">失效</span>}
                </div>
                <div className="row-path">{l.path}</div>
              </div>
              {l.healthy !== false && (
                <div className="row-actions">
                  <button
                    className="row-icon row-icon-more"
                    title="更多操作（与右键菜单相同）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(l.key);
                      onContextMenu(e.clientX, e.clientY, l.key);
                    }}
                  >
                    ⋯
                  </button>
                  <button
                    className="row-icon row-icon-add"
                    title="启动 Claude Code（新建会话）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onLaunch(l.key);
                    }}
                  >
                    +
                  </button>
                </div>
              )}
            </div>
            {isExpanded && (
              <div className="sessions">
                {sessions === null ? (
                  <div className="session-empty">会话加载中…</div>
                ) : sessions === undefined || sessions.length === 0 ? (
                  <div className="session-empty">
                    暂无会话（Claude Code 未在本项目启动过）
                  </div>
                ) : (
                  sessions.map((s) => (
                    <div
                      key={s.sessionId}
                      className={`session-row ${
                        s.file === activeSessionFile ? "active" : ""
                      }`}
                      onClick={() => onOpenSession(l.key, s)}
                      title="点击查看会话内容"
                    >
                      <div className="session-body">
                        <div className="session-title">{s.title}</div>
                        <div className="session-meta">
                          {formatTime(s.lastModified)}
                          {s.summary && ` · ${s.summary}`}
                        </div>
                      </div>
                      <button
                        className="session-rename session-resume"
                        title="继续对话（resume）"
                        onClick={(e) => {
                          e.stopPropagation();
                          onResumeSession(l.key, s);
                        }}
                      >
                        ▶
                      </button>
                      <button
                        className="session-rename session-edit"
                        title="重命名会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRenameSession(l.key, s);
                        }}
                      >
                        <span className="session-edit-icon">✏</span>
                      </button>
                      <button
                        className="session-rename session-del"
                        title="删除会话（移入回收站，可恢复）"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(l.key, s);
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
  };

  return (
    <div className="list">
      {sections.map((s) => {
        if (s.kind === "favorites" && s.items.length === 0) return null;
        const isGroup = s.kind === "group";
        return (
          <div className="group" key={s.kind === "group" ? `g:${s.name}` : s.kind}>
            {(s.kind === "group" || !plain) && (
              <div
                className={`group-head ${
                  s.kind === "favorites"
                    ? "group-head-fav"
                    : isGroup
                      ? "group-head-toggle"
                      : "group-head-static"
                } ${s.kind === "group" && s.collapsed ? "group-head-collapsed" : ""} ${
                  isGroup && s.name === dragGroup ? "group-dragging" : ""
                } ${
                  isGroup && overGroup === s.name && dragGroup !== s.name
                    ? overGroupPos === "above"
                      ? "group-drop-above"
                      : "group-drop-below"
                    : ""
                }`}
                draggable={isGroup ? dragEnabled : undefined}
                onDragStart={
                  isGroup ? (e) => handleGroupDragStart(e, s.name) : undefined
                }
                onDragEnd={isGroup ? clearGroupDrag : undefined}
                onDragOver={
                  isGroup ? (e) => handleGroupDragOver(e, s.name) : undefined
                }
                onDragLeave={
                  isGroup
                    ? (e) => {
                        if (overGroup !== s.name) return;
                        const rt = e.relatedTarget as Node | null;
                        if (rt && e.currentTarget.contains(rt)) return; // 仍在标题行内（子元素间移动）
                        setOverGroup(null);
                      }
                    : undefined
                }
                onDrop={isGroup ? (e) => handleGroupDrop(e, s.name) : undefined}
                onClick={isGroup ? () => onToggleGroup(s.name) : undefined}
                title={isGroup ? (s.collapsed ? "展开分组" : "折叠分组") : undefined}
              >
                <span className="group-caret">
                  {s.kind === "favorites" ? "★" : isGroup ? (s.collapsed ? "▸" : "▾") : ""}
                </span>
                <span className="group-name">
                  {s.kind === "favorites" ? "收藏" : s.kind === "ungrouped" ? "未分组" : s.name}
                </span>
                <span className="group-count">{s.items.length}</span>
                {isGroup && (
                  <span className="group-acts">
                    <button
                      className="group-act"
                      title="重命名分组"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRenameGroup(s.name);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="group-act"
                      title="删除分组（项目移到未分组）"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteGroup(s.name);
                      }}
                    >
                      🗑
                    </button>
                  </span>
                )}
              </div>
            )}
            {!(isGroup && s.collapsed) && s.items.map(renderRow)}
          </div>
        );
      })}
    </div>
  );
}
