import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";

interface Props {
  title: string;
  initial?: string;
  existingNames: string[];
  /** 重命名时传旧名（允许保持不变） */
  exclude?: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

/** 分组名输入对话框：空白/重名校验在前端，数据只落本机 config.json */
export default function GroupNameDialog({
  title,
  initial = "",
  existingNames,
  exclude,
  onClose,
  onSubmit,
}: Props) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const name = value.trim();
    if (!name) {
      setError("分组名不能为空。");
      return;
    }
    if (name !== exclude && existingNames.includes(name)) {
      setError("已存在同名分组。");
      return;
    }
    onSubmit(name);
  };

  return (
    <Modal title={title} width={460} onClose={onClose}>
      <div className="form">
        <label className="form-label">分组名（仅保存在本机 config.json）</label>
        <input
          ref={inputRef}
          className="input grow"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          spellCheck={false}
          maxLength={100}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit}>
            确定
          </button>
        </div>
      </div>
    </Modal>
  );
}
