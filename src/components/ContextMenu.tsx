import { useEffect, useRef, useState } from "react";
import type { Group, Project } from "../types";

interface Props {
  x: number;
  y: number;
  project: Project | null;
  favorites: string[];
  groups: Group[];
  onClose: () => void;
  onToggleFav: (key: string) => void;
  onOpenFolder: (l: Project) => void;
  onCopyPath: (l: Project) => void;
  onRemove: (l: Project) => void;
  onHealth: () => void;
  onMoveToGroup: (key: string, groupName: string | null) => void;
  /** 二级视图「新建分组」：创建分组并把该项目移入 */
  onStartCreateGroup: (key: string) => void;
}

export default function ContextMenu({
  x,
  y,
  project,
  favorites,
  groups,
  onClose,
  onToggleFav,
  onOpenFolder,
  onCopyPath,
  onRemove,
  onHealth,
  onMoveToGroup,
  onStartCreateGroup,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"main" | "groups">("main");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 防止菜单超出窗口右/下边缘；分组列表可能较长，允许菜单内滚动
  const top = Math.min(y, window.innerHeight - 260);
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 270),
    top,
    maxHeight: window.innerHeight - top - 16,
    overflowY: "auto",
  };

  if (project && view === "groups") {
    const currentNs =
      groups.find((g) => g.keys.includes(project.key))?.name ?? null;
    return (
      <div className="context-menu" ref={ref} style={style}>
        <button className="context-item context-back" onClick={() => setView("main")}>
          ‹ 返回
        </button>
        <div className="context-sep" />
        <button
          className="context-item"
          disabled={currentNs === null}
          onClick={() => {
            onMoveToGroup(project.key, null);
            onClose();
          }}
        >
          （未分组）{currentNs === null ? " ✓" : ""}
        </button>
        {groups.map((g) => (
          <button
            key={g.name}
            className="context-item"
            disabled={currentNs === g.name}
            onClick={() => {
              onMoveToGroup(project.key, g.name);
              onClose();
            }}
          >
            {g.name}
            {currentNs === g.name ? " ✓" : ""}
          </button>
        ))}
        <div className="context-sep" />
        <button
          className="context-item"
          onClick={() => {
            onStartCreateGroup(project.key);
            onClose();
          }}
        >
          ＋ 新建分组…
        </button>
      </div>
    );
  }

  return (
    <div className="context-menu" ref={ref} style={style}>
      {project && (
        <>
          <div className="context-title">
            {project.name}
            {project.healthy === false && <span className="tag tag-danger">失效</span>}
          </div>
          <div className="context-sep" />
          <button className="context-item" onClick={() => { onToggleFav(project.key); onClose(); }}>
            {favorites.includes(project.key) ? "☆ 取消收藏" : "★ 收藏（置顶）"}
          </button>
          <button className="context-item" onClick={() => setView("groups")}>
            移动到分组 ▸
          </button>
          <button className="context-item" onClick={() => { onOpenFolder(project); onClose(); }}>
            打开所在文件夹
          </button>
          <button className="context-item" onClick={() => { onCopyPath(project); onClose(); }}>
            复制路径
          </button>
          <div className="context-sep" />
          <button className="context-item context-danger" onClick={() => { onRemove(project); onClose(); }}>
            {project.healthy === false ? "✗ 移除（目录已失效）" : "从列表移除"}
          </button>
          <div className="context-sep" />
        </>
      )}
      <button className="context-item" onClick={() => { onHealth(); onClose(); }}>
        健康检查
      </button>
    </div>
  );
}
