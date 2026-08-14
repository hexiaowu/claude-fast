import type { Launcher, SessionInfo } from "../types";

interface Props {
  items: Launcher[];
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
  onToggleExpand: (key: string) => void;
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
  items,
  favorites,
  selectedKey,
  expandedKey,
  activeSessionFile,
  sessionsByKey,
  onSelect,
  onLaunch,
  onToggleFav,
  onToggleExpand,
  onRenameSession,
  onDeleteSession,
  onOpenSession,
  onResumeSession,
  onContextMenu,
}: Props) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">🗂</div>
        <div>没有找到匹配的项目</div>
        <div className="empty-sub">点击「批量添加」扫描 Claude Code 项目，或「新建」手动添加</div>
      </div>
    );
  }

  return (
    <div className="list">
      {items.map((l) => {
        const isFav = favorites.includes(l.key);
        const isSelected = l.key === selectedKey;
        const isExpanded = l.key === expandedKey;
        const sessions = sessionsByKey[l.key];
        return (
          <div key={l.key} className={`row-wrap ${isExpanded ? "expanded" : ""}`}>
            <div
              className={`row ${isSelected ? "selected" : ""} ${l.healthy === false ? "broken" : ""}`}
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
                  {l.label}
                  {l.healthy === false && <span className="tag tag-danger">失效</span>}
                </div>
                <div className="row-path">{l.path ?? "（未解析到路径）"}</div>
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
      })}
    </div>
  );
}
