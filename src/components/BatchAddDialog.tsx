import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ClaudeProject } from "../types";
import Modal from "./Modal";

interface Props {
  onClose: () => void;
  onDone: (createdCount: number) => void;
}

export default function BatchAddDialog({ onClose, onDone }: Props) {
  const [projects, setProjects] = useState<ClaudeProject[] | null>(null);
  const [dir, setDir] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api
      .getClaudeProjectsDir()
      .then(setDir)
      .catch(() => {});
    api
      .scanClaudeProjects()
      .then((list) => {
        setProjects(list);
        // 默认勾选未失效且尚未生成启动脚本的项目；
        // 已失效（路径不存在）和已有脚本的不勾选
        setChecked(
          new Set(
            list
              .filter((p) => !p.missing && !p.existing)
              .map((p) => p.path),
          ),
        );
      })
      .catch((e) => setResult("扫描失败：" + String(e)));
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
    let created = 0;
    const errors: string[] = [];
    for (const p of targets) {
      try {
        const r = await api.createLauncher(p.path);
        if (!r.existed) created++;
      } catch (e) {
        errors.push(`${p.name}: ${e}`);
      }
    }
    setBusy(false);
    setResult(
      `成功处理 ${targets.length} 个（新增 ${created} 个，其余已存在）。` +
        (errors.length ? `\n失败 ${errors.length} 个：\n${errors.join("\n")}` : ""),
    );
    if (!errors.length) {
      onDone(created);
    }
  };

  const missingCount = (projects ?? []).filter((p) => p.missing).length;
  const existingCount = (projects ?? []).filter((p) => p.existing).length;

  return (
    <Modal title="批量添加启动脚本" width={640} onClose={onClose}>
      <div className="batch">
        <div className="form-label">
          扫描 Claude Code 项目目录 <code>{dir || "…"}</code>
          ，共 {projects?.length ?? "…"} 个项目
          {projects && missingCount > 0 && (
            <>
              ，其中 <span className="batch-missing">{missingCount} 个已失效</span>
            </>
          )}
          {projects && existingCount > 0 && (
            <>
              ，其中 <span className="batch-done">{existingCount} 个已有启动脚本</span>
            </>
          )}
          。勾选后一键生成启动脚本：
        </div>
        <div className="batch-list">
          {!projects &&
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          {projects?.map((p) => (
            <label
              key={p.path}
              className={
                "batch-item" +
                (p.missing ? " batch-item-missing" : "") +
                (p.existing ? " batch-item-done" : "")
              }
            >
              <input
                type="checkbox"
                checked={checked.has(p.path)}
                disabled={p.missing}
                onChange={() => toggle(p.path)}
              />
              <div className="batch-item-body">
                <div className="row-label">
                  {p.missing && <span className="batch-missing">[已失效] </span>}
                  {p.existing && <span className="batch-done">[已添加] </span>}
                  {p.name}
                </div>
                <div className="row-path">
                  {p.missing && <span className="batch-missing">解析路径：</span>}
                  {p.path}
                </div>
              </div>
            </label>
          ))}
          {projects && projects.length === 0 && (
            <div className="empty">Claude Code 项目目录中没有发现项目</div>
          )}
        </div>
        {result && <div className="form-error">{result}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !projects || checked.size === 0}
          >
            {busy ? "生成中…" : `生成启动脚本（${checked.size}）`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
