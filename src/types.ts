export interface Launcher {
  label: string;
  path: string | null;
  file: string;
  key: string;
  /** undefined = 尚未检查（启动时秒渲染，后台异步检查后回填） */
  healthy?: boolean;
}

export type CloseAction = "quit" | "minimize" | null;

export interface Config {
  favorites: string[];
  dark: boolean;
  /** null/undefined = 每次询问；"quit" = 直接退出；"minimize" = 最小化到托盘 */
  closeAction?: CloseAction;
}

export interface CreateResult {
  file: string;
  existed: boolean;
}

export interface ClaudeProject {
  name: string;
  path: string;
  /** true = 真实路径已不存在（项目代码被删除），不参与生成 */
  missing: boolean;
  /** true = 数据根 scripts/ 下已有该项目的启动脚本 */
  existing: boolean;
}

/** Claude Code 会话元数据（来自 ~/.claude/projects 下 jsonl 的轻量解析） */
export interface SessionInfo {
  sessionId: string;
  /** 显示标题：customTitle > aiTitle > 首条用户消息 */
  title: string;
  /** 副行摘要：customTitle > lastPrompt > summary > 首条用户消息 */
  summary: string;
  /** 最后修改时间（epoch ms） */
  lastModified: number;
  /** jsonl 文件绝对路径（重命名时回传） */
  file: string;
}

/** 回收站中的会话备份（删除 = 移入回收站，可恢复） */
export interface TrashedSession {
  /** 备份文件绝对路径（恢复/永久删除时回传） */
  file: string;
  sessionId: string;
  /** 标题（复用会话元数据解析） */
  title: string;
  /** 删除时间（YYYYMMDD_HHMMSS） */
  deletedAt: string;
  /** 原项目 mangled 目录名 */
  projectDir: string;
  /** 原项目真实路径（unmangle 解析，可能为 null） */
  projectPath: string | null;
}

/** 会话内容块（阶段二：只读查看） */
export interface ContentBlock {
  /** text | thinking | tool_use | tool_result */
  kind: string;
  text?: string | null;
  name?: string | null;
  input?: unknown;
  toolUseId?: string | null;
  isError?: boolean | null;
}

/** 会话中的一条消息 */
export interface SessionMessage {
  /** user | assistant */
  kind: string;
  blocks: ContentBlock[];
  timestamp?: string | null;
  model?: string | null;
}

export interface SessionMessages {
  /** 本批消息（最多 limit 条） */
  messages: SessionMessage[];
  /** 还有更早的消息未加载（向上分页） */
  hasMore: boolean;
  /** 会话总消息数 */
  total: number;
  /** 本批起始位置（0 = 从最早一条开始） */
  offset: number;
}
