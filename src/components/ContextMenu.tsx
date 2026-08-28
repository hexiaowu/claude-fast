import { useEffect, useRef, useState } from "react";
import type { Group, Launcher } from "../types";

interface Props {
  x: number;
  y: number;
  launcher: Launcher | null;
  favorites: string[];
  groups: Group[];
  onClose: () => void;
  onToggleFav: (key: string) => void;
  onOpenFolder: (l: Launcher) => void;
  onCopyPath: (l: Launcher) => void;
  onRemove: (l: Launcher) => void;
  onHealth: () => void;
  onMoveToGroup: (key: string, groupName: string | null) => void;
}

export default function ContextMenu({
  x,
  y,
  launcher,
  favorites,
  groups,
  onClose,
  onToggleFav,
  onOpenFolder,
  onCopyPath,
  onRemove,
  onHealth,
  onMoveToGroup,
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
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 210),
    top: Math.min(y, window.innerHeight - 260),
    maxHeight: window.innerHeight - y - 16,
    overflowY: "auto",
  };

  if (launcher && view === "groups") {
    const currentNs =
      groups.find((g) => g.keys.includes(launcher.key))?.name ?? null;
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
            onMoveToGroup(launcher.key, null);
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
              onMoveToGroup(launcher.key, g.name);
              onClose();
            }}
          >
            {g.name}
            {currentNs === g.name ? " ✓" : ""}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="context-menu" ref={ref} style={style}>
      {launcher && (
        <>
          <div className="context-title">
            {launcher.label}
            {launcher.healthy === false && <span className="tag tag-danger">失效</span>}
          </div>
          <div className="context-sep" />
          <button className="context-item" onClick={() => { onToggleFav(launcher.key); onClose(); }}>
            {favorites.includes(launcher.key) ? "☆ 取消收藏" : "★ 收藏（置顶）"}
          </button>
          <button className="context-item" onClick={() => setView("groups")}>
            移动到分组 ▸
          </button>
          <button className="context-item" onClick={() => { onOpenFolder(launcher); onClose(); }}>
            打开所在文件夹
          </button>
          <button className="context-item" onClick={() => { onCopyPath(launcher); onClose(); }}>
            复制路径
          </button>
          <div className="context-sep" />
          <button className="context-item context-danger" onClick={() => { onRemove(launcher); onClose(); }}>
            {launcher.healthy === false ? "✗ 移除（目录已失效）" : "移除启动脚本"}
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
