import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { ClaudeProject } from "../types";
import Modal from "./Modal";

interface Props {
  onClose: () => void;
  onDone: (addedCount: number) => void;
}

export default function BatchAddDialog({ onClose, onDone }: Props) {
  const [projects, setProjects] = useState<ClaudeProject[] | null>(null);
  const [dir, setDir] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // 已在 config.projects 清单中的项目路径（小写比对）——不可再勾选
  const [inList, setInList] = useState<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const [dir, list, cfg] = await Promise.all([
          api.getClaudeProjectsDir(),
          api.scanClaudeProjects(),
          api.loadConfig(),
        ]);
        if (disposed) return;
        const inListSet = new Set((cfg.projects ?? []).map((p) => p.toLowerCase()));
        setDir(dir);
        setProjects(list);
        setInList(inListSet);
        // 默认勾选未失效且尚未加入清单的项目；已失效与已在列表的不勾选
        setChecked(
          new Set(
            list
              .filter((p) => !p.missing && !inListSet.has(p.path.toLowerCase()))
              .map((p) => p.path),
          ),
        );
      } catch (e) {
        if (disposed) return;
        setResult("扫描失败：" + String(e));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submit = async () => {
    const targets = (projects ?? []).filter((p) => checked.has(p.path));
    setBusy(true);
    setResult(null);
    let added = 0;
    const errors: string[] = [];
    for (const p of targets) {
      try {
        await api.addProject(p.path);
        added++;
      } catch (e) {
        errors.push(`${p.name}: ${e}`);
      }
    }
    setBusy(false);
    setResult(
      `成功添加 ${added} 个项目。` +
        (errors.length ? `\n失败 ${errors.length} 个：\n${errors.join("\n")}` : ""),
    );
    if (!errors.length) {
      onDone(added);
    }
  };

  /** 项目 path 去叶子段的父目录（纯前端推导，后端不动） */
  const parentDir = (p: string): string => {
    const norm = p.replace(/[\\/]+$/, "");
    const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
    return i > 0 ? norm.slice(0, i) : "";
  };

  const grouped = useMemo(() => {
    const map = new Map<string, ClaudeProject[]>();
    for (const p of projects ?? []) {
      const parent = parentDir(p.path);
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent)!.push(p);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))
      .map(([parent, items]) => ({
        parent,
        leaf: parent ? (parent.split(/[\\/]/).pop() ?? parent) : "（根目录）",
        items: [...items].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
      }));
  }, [projects]);

  const missingCount = (projects ?? []).filter((p) => p.missing).length;
  const inListCount = (projects ?? []).filter((p) => inList.has(p.path.toLowerCase())).length;

  return (
    <Modal title="批量添加项目" width={640} onClose={onClose}>
      <div className="batch">
        <div className="form-label">
          扫描 Claude Code 项目目录 <code>{dir || "…"}</code>
          ，共 {projects?.length ?? "…"} 个项目
          {projects && missingCount > 0 && (
            <>
              ，其中 <span className="batch-missing">{missingCount} 个已失效</span>
            </>
          )}
          {projects && inListCount > 0 && (
            <>
              ，其中 <span className="batch-done">{inListCount} 个已在列表中</span>
            </>
          )}
          。勾选后一键加入项目列表：
        </div>
        <div className="batch-list">
          {!projects &&
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          {grouped.map((g) => (
            <div key={g.parent || "__root__"}>
              <div className="batch-group-head" title={g.parent || undefined}>
                {g.leaf}
                <span className="group-count">{g.items.length}</span>
              </div>
              {g.items.map((p) => {
                const listed = inList.has(p.path.toLowerCase());
                return (
                  <label
                    key={p.path}
                    className={
                      "batch-item" +
                      (p.missing ? " batch-item-missing" : "") +
                      (listed ? " batch-item-done" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(p.path)}
                      disabled={p.missing || listed}
                      onChange={() => toggle(p.path)}
                    />
                    <div className="batch-item-body">
                      <div className="row-label">
                        {p.missing && <span className="batch-missing">[已失效] </span>}
                        {listed && <span className="batch-done">[已在列表] </span>}
                        {p.name}
                      </div>
                      <div className="row-path">
                        {p.missing && <span className="batch-missing">解析路径：</span>}
                        {p.path}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          ))}
          {projects && projects.length === 0 && (
            <div className="empty">Claude Code 项目目录中没有发现项目</div>
          )}
        </div>
        {result && <div className="form-error">{result}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !projects || checked.size === 0}
          >
            {busy ? "添加中…" : `加入项目列表（${checked.size}）`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
