import { useState } from "react";
import { api } from "../lib/api";
import Modal from "./Modal";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export default function NewLauncherDialog({ onClose, onCreated }: Props) {
  // 默认不预填任何路径（项目不限定在某个工作区目录内）
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    const picked = await api.pickFolder("选择项目文件夹");
    if (picked) setDir(picked);
  };

  const submit = async () => {
    const d = dir.trim().replace(/^"+|"+$/g, "");
    if (!d) {
      setError("请输入或选择项目文件夹路径。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.createLauncher(d);
      onCreated();
      // 提示覆盖/新建结果
      const action = result.existed ? "已覆盖" : "已创建";
      alert(`已${action}启动脚本：\n${result.file}`); // eslint-disable-line no-alert
    } catch (e) {
      setError(String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <Modal title="新建 Claude 启动脚本" width={560} onClose={onClose}>
      <div className="form">
        <label className="form-label">项目文件夹路径（可手动输入，或点「浏览…」选择）</label>
        <div className="form-row">
          <input
            className="input grow"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="例如 D:\MyWorkspaces\yaotu\tdc"
            spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button className="btn" onClick={browse}>
            浏览…
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "创建中…" : "确定"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
