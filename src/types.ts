export interface Project {
  /** 唯一键 = 项目绝对路径 */
  key: string;
  /** 叶子目录名（显示用） */
  name: string;
  /** 项目绝对路径 */
  path: string;
  /** undefined = 尚未检查（列表先渲染，后台异步检查后回填）；false = 路径已不存在 */
  healthy?: boolean;
}

export type CloseAction = "quit" | "minimize" | null;

export interface Group {
  name: string;
  /** 分组内项目的 key（= 项目绝对路径） */
  keys: string[];
}

export interface Config {
  /** 收藏的项目绝对路径（置顶） */
  favorites: string[];
  /** 手动添加的项目路径清单 */
  projects: string[];
  /** 被用户从列表移除的项目路径（会话扫描会重新发现它们，需排除） */
  excluded?: string[];
  dark: boolean;
  /** null/undefined = 每次询问；"quit" = 直接退出；"minimize" = 最小化到托盘 */
  closeAction?: CloseAction;
  /** 项目分组（namespace），数组顺序 = 显示顺序 */
  groups: Group[];
  /** 已折叠的分组名 */
  collapsed: string[];
}

/** 主列表分节（App 派生，ProjectList 渲染） */
export type Section =
  | { kind: "favorites"; items: Project[] }
  | { kind: "group"; name: string; items: Project[]; collapsed: boolean }
  | { kind: "ungrouped"; items: Project[] };

export interface ClaudeProject {
  name: string;
  path: string;
  /** true = 真实路径已不存在（项目代码被删除），不可启动 */
  missing: boolean;
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
