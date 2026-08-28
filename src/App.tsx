import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./lib/api";
import type {
  CloseAction,
  Config,
  Group,
  Launcher,
  Section,
  SessionInfo,
} from "./types";
import Header from "./components/Header";
import Toolbar from "./components/Toolbar";
import ProjectList from "./components/ProjectList";
import StatusBar from "./components/StatusBar";
import ContextMenu from "./components/ContextMenu";
import GroupNameDialog from "./components/GroupNameDialog";
import NewLauncherDialog from "./components/NewLauncherDialog";
import BatchAddDialog from "./components/BatchAddDialog";
import HealthDialog from "./components/HealthDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import SettingsDialog from "./components/SettingsDialog";
import CloseChoiceDialog from "./components/CloseChoiceDialog";
import RenameDialog from "./components/RenameDialog";
import TrashDialog from "./components/TrashDialog";
import SessionViewer from "./components/SessionViewer";

export type DialogKind = "new" | "batch" | "health" | null;

interface ConfirmState {
  title: string;
  message: string;
  okText?: string;
  danger?: boolean;
  onOk: () => void | Promise<void>;
}

export default function App() {
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [dark, setDark] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [claudeOk, setClaudeOk] = useState<boolean | null>(null);
  const [closeAction, setCloseAction] = useState<CloseAction>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // 批量删除场景（HealthDialog 循环 await）下闭包 state 会过期，用 ref 镜像最新值
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeChoiceOpen, setCloseChoiceOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  // ---------- 会话管理（v2.0.0 阶段一） ----------
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [sessionsByKey, setSessionsByKey] = useState<
    Record<string, SessionInfo[] | null | undefined>
  >({});
  const [renameTarget, setRenameTarget] = useState<{
    session: SessionInfo;
    key: string;
  } | null>(null);
  // ---------- 分组对话框（新建/重命名） ----------
  const [groupDialog, setGroupDialog] = useState<
    | { mode: "create"; launcherKey: string | null }
    | { mode: "rename"; group: string }
    | null
  >(null);
  // ---------- 会话内容（v2.0.0 阶段二） ----------
  const [activeSession, setActiveSession] = useState<{
    session: SessionInfo;
    key: string;
    projectPath: string | null;
  } | null>(null);
  const closeActionRef = useRef<CloseAction>(null);
  closeActionRef.current = closeAction;

  // ---------- Toast ----------

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  // ---------- 配置保存（patch 模式：未提供的字段沿用当前 state） ----------

  const persistConfig = useCallback(
    async (patch: Partial<Config>) => {
      const cfg: Config = {
        favorites: patch.favorites ?? favorites,
        dark: patch.dark ?? dark,
        closeAction:
          patch.closeAction !== undefined ? patch.closeAction : closeAction,
        groups: patch.groups ?? groups,
        collapsed: patch.collapsed ?? collapsed,
      };
      try {
        await api.saveConfig(cfg);
      } catch (e) {
        showToast("保存配置失败：" + String(e));
      }
    },
    [showToast, favorites, dark, closeAction, groups, collapsed],
  );

  // ---------- 关闭窗口行为 ----------

  // 拦截关闭：minimize → 隐藏到托盘；null（未设置）→ 弹窗询问；quit → 直接退出
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const action = closeActionRef.current;
        if (action === "quit") {
          // 显式销毁窗口（不触发 CloseRequested，避免事件循环；否则窗口不关闭）
          await getCurrentWindow().destroy();
          return;
        }
        event.preventDefault();
        if (action === "minimize") {
          await getCurrentWindow().hide();
        } else {
          setCloseChoiceOpen(true);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleCloseChoice = useCallback(
    async (action: "quit" | "minimize", remember: boolean) => {
      setCloseChoiceOpen(false);
      if (remember) {
        setCloseAction(action);
        await persistConfig({ closeAction: action });
      }
      if (action === "minimize") {
        await getCurrentWindow().hide();
      } else {
        await api.quitApp();
      }
    },
    [persistConfig],
  );

  // ---------- 数据加载 ----------

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([api.listLaunchers(), api.loadConfig()]);
      setLaunchers(list);
      setFavorites(cfg.favorites ?? []);
      setDark(cfg.dark ?? false);
      setCloseAction(cfg.closeAction ?? null);
      setGroups(cfg.groups ?? []);
      setCollapsed(cfg.collapsed ?? []);
      // 选中项可能已被删除，清理
      setSelectedKey((k) => (k && list.some((l) => l.key === k) ? k : null));
      // 健康检查在后台异步执行（不阻塞列表渲染）；
      // 被移除项目的目录检查较慢/超时，结果回来后自动标记失效。
      api
        .checkLaunchers(list.map((l) => l.path ?? ""))
        .then((results) => {
          setLaunchers((prev) =>
            prev.map((l, i) => ({ ...l, healthy: results[i] ?? false })),
          );
        })
        .catch(() => {});
    } catch (e) {
      showToast("加载失败：" + String(e));
    }
  }, []);

  useEffect(() => {
    load();
    api.checkClaude().then(setClaudeOk).catch(() => setClaudeOk(false));
    // 安装模式首次启动：提示数据目录位置（scripts/config 实际存储处）
    api
      .getDataRoot()
      .then((info) => {
        if (info.installMode && !localStorage.getItem("cf-data-tip")) {
          localStorage.setItem("cf-data-tip", "1");
          setToast(`数据目录：${info.path}（启动脚本 scripts/ 与收藏保存在此）`);
          window.setTimeout(() => setToast(null), 5000);
        }
      })
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  // ---------- 收藏 / 主题 ----------

  const toggleFav = useCallback(
    async (key: string) => {
      const next = favorites.includes(key)
        ? favorites.filter((f) => f !== key)
        : [...favorites, key];
      setFavorites(next);
      await persistConfig({ favorites: next });
    },
    [favorites, persistConfig],
  );

  /** 收藏拖拽排序：按 key 重排（非索引），对过滤/失效 key 天然安全 */
  const reorderFavorites = useCallback(
    async (draggedKey: string, targetKey: string, before: boolean) => {
      if (draggedKey === targetKey) return;
      if (!favorites.includes(draggedKey) || !favorites.includes(targetKey))
        return;
      const next = favorites.filter((k) => k !== draggedKey);
      const to = next.indexOf(targetKey);
      next.splice(before ? to : to + 1, 0, draggedKey);
      if (next.every((k, i) => k === favorites[i])) return; // 位置未变，免写盘
      setFavorites(next);
      await persistConfig({ favorites: next });
    },
    [favorites, persistConfig],
  );

  const toggleTheme = useCallback(async () => {
    const next = !dark;
    setDark(next);
    await persistConfig({ dark: next });
  }, [dark, persistConfig]);

  // ---------- 列表派生数据 ----------

  const sections = useMemo((): Section[] => {
    const q = search.trim().toLowerCase();
    const filtering = q !== "";
    const filtered = launchers.filter(
      (l) =>
        !q ||
        l.label.toLowerCase().includes(q) ||
        (l.path ?? "").toLowerCase().includes(q),
    );
    const byKey = new Map(filtered.map((l) => [l.key, l]));
    const favKeys = new Set(favorites);
    const fav = favorites.map((k) => byKey.get(k)).filter((l): l is Launcher => !!l);

    // 未建任何分组：保持旧版平铺观感（收藏在前 + 其余按名称排序），不显示任何节标题
    if (groups.length === 0) {
      const rest = filtered
        .filter((l) => !favKeys.has(l.key))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
      return [
        { kind: "favorites", items: fav },
        { kind: "ungrouped", items: rest },
      ];
    }

    const groupedKeys = new Set(groups.flatMap((g) => g.keys));
    const out: Section[] = [];
    for (const g of groups) {
      // 收藏与分组正交：已收藏行只出现在收藏区
      const items = g.keys
        .map((k) => byKey.get(k))
        .filter((l): l is Launcher => !!l && !favKeys.has(l.key))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
      if (filtering && items.length === 0) continue; // 搜索时空组隐藏
      out.push({
        kind: "group",
        name: g.name,
        items,
        collapsed: !filtering && collapsed.includes(g.name),
      });
    }
    const rest = filtered
      .filter((l) => !favKeys.has(l.key) && !groupedKeys.has(l.key))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
    if (!(filtering && rest.length === 0)) {
      out.push({ kind: "ungrouped", items: rest });
    }
    return [{ kind: "favorites", items: fav }, ...out];
  }, [launchers, favorites, groups, collapsed, search]);

  /** 折叠/展开分组（按分组名持久化到 collapsed） */
  const toggleGroupCollapsed = useCallback(
    (name: string) => {
      if (search.trim() !== "") return; // 搜索中折叠被忽略，禁止静默改状态
      const next = collapsed.includes(name)
        ? collapsed.filter((c) => c !== name)
        : [...collapsed, name];
      setCollapsed(next);
      void persistConfig({ collapsed: next });
    },
    [collapsed, persistConfig, search],
  );

  /** 分组拖拽换位：groups 数组顺序即显示顺序，失效名自然忽略 */
  const reorderGroups = useCallback(
    (dragName: string, targetName: string, before: boolean) => {
      if (dragName === targetName) return;
      const dragged = groups.filter((g) => g.name === dragName);
      if (dragged.length === 0) return;
      const next = groups.filter((g) => g.name !== dragName);
      const to = next.findIndex((g) => g.name === targetName);
      if (to < 0) return;
      next.splice(before ? to : to + 1, 0, ...dragged);
      if (next.every((g, i) => g.name === groups[i]?.name)) return; // 位置未变，免写盘
      setGroups(next);
      void persistConfig({ groups: next });
    },
    [groups, persistConfig],
  );

  /** 移动项目到指定分组（null = 移到未分组）：先从旧组移除，再入新组 */
  const moveToGroup = useCallback(
    (key: string, groupName: string | null) => {
      let next = groups.map((g) => ({ ...g, keys: g.keys.filter((k) => k !== key) }));
      if (groupName !== null) {
        const target = next.find((g) => g.name === groupName);
        if (target) target.keys = [...target.keys, key];
      }
      setGroups(next);
      void persistConfig({ groups: next });
      showToast(groupName === null ? "已移到未分组" : `已移动到 ${groupName}`);
    },
    [groups, persistConfig, showToast],
  );

  /** 新建分组（launcherKey 非空时把该项目一并移入） */
  const createGroupAndAssign = useCallback(
    (name: string, launcherKey: string | null) => {
      // 先从旧组移除（与 moveToGroup 同语义），避免同一项目出现在多个分组
      const cleaned = groups.map((g) => ({
        ...g,
        keys: g.keys.filter((k) => k !== launcherKey),
      }));
      const g: Group = { name, keys: launcherKey ? [launcherKey] : [] };
      const next = [...cleaned, g];
      setGroups(next);
      void persistConfig({ groups: next });
      setGroupDialog(null);
      showToast(launcherKey ? `已创建分组「${name}」并移入` : `已创建分组「${name}」`);
    },
    [groups, persistConfig, showToast],
  );

  /** 重命名分组：collapsed 按名匹配，同步替换 */
  const renameGroup = useCallback(
    (oldName: string, newName: string) => {
      if (oldName === newName) {
        setGroupDialog(null);
        return;
      }
      const next = groups.map((g) => (g.name === oldName ? { ...g, name: newName } : g));
      const nextCollapsed = collapsed.map((c) => (c === oldName ? newName : c));
      setGroups(next);
      setCollapsed(nextCollapsed);
      void persistConfig({ groups: next, collapsed: nextCollapsed });
      setGroupDialog(null);
      showToast("分组已重命名");
    },
    [groups, collapsed, persistConfig, showToast],
  );

  const deleteGroup = useCallback(
    (name: string) => {
      const next = groups.filter((g) => g.name !== name);
      const nextCollapsed = collapsed.filter((c) => c !== name);
      setGroups(next);
      setCollapsed(nextCollapsed);
      void persistConfig({ groups: next, collapsed: nextCollapsed });
      showToast(`已删除分组「${name}」`);
    },
    [groups, collapsed, persistConfig, showToast],
  );

  const confirmDeleteGroup = useCallback(
    (name: string) => {
      const count = groups.find((g) => g.name === name)?.keys.length ?? 0;
      setConfirm({
        title: "删除分组",
        message: `将删除分组「${name}」，组内 ${count} 个项目将移到未分组（项目本身不受影响）。\n\n继续？`,
        okText: "删除",
        danger: true,
        onOk: () => deleteGroup(name),
      });
    },
    [groups, deleteGroup],
  );

  const missing = launchers.filter((l) => l.healthy === false);

  // ---------- 操作 ----------

  const launch = useCallback(
    async (key: string) => {
      const l = launchers.find((x) => x.key === key);
      if (!l) return;
      if (l.healthy === false) {
        showToast(`目录不存在，无法启动：${l.path}`);
        return;
      }
      try {
        await api.launchClaude(l.file);
      } catch (e) {
        showToast("启动失败：" + String(e));
      }
    },
    [launchers, showToast],
  );

  const openFolder = useCallback(
    async (l: Launcher) => {
      if (!l.path) return;
      try {
        await api.openFolder(l.path);
      } catch (e) {
        showToast("打开文件夹失败：" + String(e));
      }
    },
    [showToast],
  );

  const copyPath = useCallback(
    async (l: Launcher) => {
      if (!l.path) return;
      try {
        await navigator.clipboard.writeText(l.path);
        showToast("路径已复制到剪贴板");
      } catch {
        showToast("复制失败");
      }
    },
    [showToast],
  );

  const removeLauncher = useCallback(
    async (l: Launcher) => {
      try {
        await api.deleteLauncher(l.file);
      } catch (e) {
        showToast("删除失败：" + String(e));
        return;
      }
      // 用 ref 读最新值：HealthDialog 循环 await 删除时闭包 state 是旧快照
      const favs = favoritesRef.current.filter((f) => f !== l.key);
      const nextGroups = groupsRef.current.map((g) => ({
        ...g,
        keys: g.keys.filter((k) => k !== l.key),
      }));
      favoritesRef.current = favs;
      groupsRef.current = nextGroups;
      setFavorites(favs);
      setGroups(nextGroups);
      await persistConfig({ favorites: favs, groups: nextGroups });
      await load();
      showToast(`已删除 ${l.label}`);
    },
    [persistConfig, load, showToast],
  );

  const confirmRemove = useCallback(
    (l: Launcher) => {
      setConfirm({
        title: "移除启动脚本",
        message: `将永久删除以下启动脚本：\n\n${l.label}\n${l.file}\n\n继续？`,
        okText: "删除",
        danger: true,
        onOk: () => removeLauncher(l),
      });
    },
    [removeLauncher],
  );

  // ---------- 会话管理（v2.0.0 阶段一） ----------

  const toggleExpand = useCallback(
    async (key: string) => {
      if (expandedKey === key) {
        setExpandedKey(null);
        return;
      }
      setExpandedKey(key);
      const l = launchers.find((x) => x.key === key);
      if (!l?.path) {
        showToast("该项目未解析到路径，无法读取会话");
        return;
      }
      setSessionsByKey((prev) => ({ ...prev, [key]: null })); // 加载中
      try {
        const list = await api.listSessions(l.path);
        setSessionsByKey((prev) => ({ ...prev, [key]: list }));
      } catch (e) {
        setSessionsByKey((prev) => ({ ...prev, [key]: [] }));
        showToast("加载会话失败：" + String(e));
      }
    },
    [expandedKey, launchers, showToast],
  );

  const renameSession = useCallback(
    async (newTitle: string) => {
      if (!renameTarget) return;
      const { session, key } = renameTarget;
      await api.renameSession(session.file, newTitle); // 失败时向上抛给对话框显示
      setRenameTarget(null);
      // 重命名后刷新该项目会话列表（若仍处于展开状态）
      if (expandedKey === key) {
        const l = launchers.find((x) => x.key === key);
        if (l?.path) {
          const list = await api.listSessions(l.path).catch(() => null);
          if (list) setSessionsByKey((prev) => ({ ...prev, [key]: list }));
        }
      }
      showToast("已重命名");
    },
    [renameTarget, expandedKey, launchers, showToast],
  );

  const refreshSessions = useCallback(
    async (key: string) => {
      const l = launchers.find((x) => x.key === key);
      if (!l?.path) return;
      const list = await api.listSessions(l.path).catch(() => null);
      if (list) setSessionsByKey((prev) => ({ ...prev, [key]: list }));
    },
    [launchers],
  );

  const deleteSession = useCallback(
    async (key: string, session: SessionInfo) => {
      try {
        await api.deleteSession(session.file);
        await refreshSessions(key);
        // 右侧正显示该会话 → 清空
        setActiveSession((cur) =>
          cur && cur.session.file === session.file ? null : cur,
        );
        showToast(`已删除「${session.title}」，可在回收站恢复`);
      } catch (e) {
        showToast("删除失败：" + String(e));
      }
    },
    [refreshSessions, showToast],
  );

  const confirmDeleteSession = useCallback(
    (key: string, session: SessionInfo) => {
      setConfirm({
        title: "删除会话",
        message: `将删除会话：\n\n「${session.title}」\n\n删除后移入回收站（可恢复），继续？`,
        okText: "删除",
        danger: true,
        onOk: () => deleteSession(key, session),
      });
    },
    [deleteSession],
  );

  // ---------- 会话内容（v2.0.0 阶段二） ----------

  const loadSessionMessages = useCallback(
    async (key: string, session: SessionInfo) => {
      const launcher = launchers.find((x) => x.key === key);
      setActiveSession({
        session,
        key,
        projectPath: launcher?.path ?? null,
      });
    },
    [launchers],
  );

  const resumeSession = useCallback(
    async (key: string, session: SessionInfo) => {
      const launcher = launchers.find((x) => x.key === key);
      if (!launcher?.path) {
        showToast("该项目未解析到路径，无法继续对话");
        return;
      }
      try {
        await api.resumeSession(session.file, launcher.path);
        showToast(`已打开「${session.title}」的继续对话窗口`);
      } catch (e) {
        showToast("启动失败：" + String(e));
      }
    },
    [launchers, showToast],
  );

  // ---------- 渲染 ----------

  return (
    <div className="app">
      <Header
        dark={dark}
        onToggleTheme={toggleTheme}
        claudeOk={claudeOk}
        missingCount={missing.length}
        onHealth={() => setDialog("health")}
        onSettings={() => setSettingsOpen(true)}
      />

      <Toolbar
        search={search}
        onSearch={setSearch}
        onNew={() => setDialog("new")}
        onBatch={() => setDialog("batch")}
        onHealth={() => setDialog("health")}
        onTrash={() => setTrashOpen(true)}
      />

      <main className="main main-split">
        <div className="main-left">
          <ProjectList
            sections={sections}
            plain={groups.length === 0}
            favorites={favorites}
            selectedKey={selectedKey}
            expandedKey={expandedKey}
            activeSessionFile={activeSession?.session.file ?? null}
            sessionsByKey={sessionsByKey}
            onSelect={setSelectedKey}
            onLaunch={launch}
            onToggleFav={toggleFav}
            dragEnabled={search.trim() === ""}
            onReorderFavorite={reorderFavorites}
            onToggleExpand={toggleExpand}
            onToggleGroup={toggleGroupCollapsed}
            onReorderGroup={reorderGroups}
            onRenameGroup={(name) => setGroupDialog({ mode: "rename", group: name })}
            onDeleteGroup={confirmDeleteGroup}
            onRenameSession={(key, session) => setRenameTarget({ session, key })}
            onDeleteSession={confirmDeleteSession}
            onOpenSession={loadSessionMessages}
            onResumeSession={resumeSession}
            onContextMenu={(x, y, key) => setMenu({ x, y, key })}
          />
        </div>
        <SessionViewer
          session={activeSession?.session ?? null}
          projectPath={activeSession?.projectPath ?? null}
          onResume={() => {
            if (activeSession) {
              resumeSession(activeSession.key, activeSession.session);
            }
          }}
          onToast={showToast}
        />
      </main>

      <StatusBar
        total={launchers.length}
        favCount={favorites.length}
        missingCount={missing.length}
        claudeOk={claudeOk}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          launcher={launchers.find((l) => l.key === menu.key) ?? null}
          favorites={favorites}
          groups={groups}
          onClose={() => setMenu(null)}
          onToggleFav={toggleFav}
          onOpenFolder={openFolder}
          onCopyPath={copyPath}
          onRemove={confirmRemove}
          onMoveToGroup={moveToGroup}
          onStartCreateGroup={(key) => {
            setMenu(null);
            setGroupDialog({ mode: "create", launcherKey: key });
          }}
          onHealth={() => {
            setMenu(null);
            setDialog("health");
          }}
        />
      )}

      {dialog === "new" && (
        <NewLauncherDialog
          onClose={() => setDialog(null)}
          onCreated={async () => {
            setDialog(null);
            await load();
          }}
        />
      )}

      {dialog === "batch" && (
        <BatchAddDialog
          onClose={() => setDialog(null)}
          onDone={async (count) => {
            setDialog(null);
            await load();
            showToast(`批量添加完成：新增 ${count} 个启动脚本`);
          }}
        />
      )}

      {dialog === "health" && (
        <HealthDialog
          launchers={launchers}
          claudeOk={claudeOk}
          onClose={() => setDialog(null)}
          onDelete={async (items) => {
            for (const l of items) await removeLauncher(l);
            setDialog(null);
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          okText={confirm.okText}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onOk={async () => {
            await confirm.onOk();
            setConfirm(null);
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          closeAction={closeAction}
          onClose={() => setSettingsOpen(false)}
          onSave={async (action) => {
            setCloseAction(action);
            await persistConfig({ closeAction: action });
            setSettingsOpen(false);
            showToast("设置已保存");
          }}
        />
      )}

      {renameTarget && (
        <RenameDialog
          sessionTitle={renameTarget.session.title}
          onClose={() => setRenameTarget(null)}
          onRenamed={renameSession}
        />
      )}

      {trashOpen && (
        <TrashDialog
          onClose={() => setTrashOpen(false)}
          onChanged={() => {
            // 回收站操作后刷新当前展开项目的会话列表
            if (expandedKey) refreshSessions(expandedKey);
          }}
          onToast={showToast}
        />
      )}

      {closeChoiceOpen && (
        <CloseChoiceDialog
          onClose={() => setCloseChoiceOpen(false)}
          onChoose={handleCloseChoice}
        />
      )}

      {groupDialog?.mode === "create" && (
        <GroupNameDialog
          title="新建分组"
          existingNames={groups.map((g) => g.name)}
          onClose={() => setGroupDialog(null)}
          onSubmit={(name) => createGroupAndAssign(name, groupDialog.launcherKey)}
        />
      )}

      {groupDialog?.mode === "rename" && (
        <GroupNameDialog
          title="重命名分组"
          initial={groupDialog.group}
          exclude={groupDialog.group}
          existingNames={groups.map((g) => g.name)}
          onClose={() => setGroupDialog(null)}
          onSubmit={(name) => renameGroup(groupDialog.group, name)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
