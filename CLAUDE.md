# Claude助手（claude-fast）

一键在项目目录启动 Claude Code 的桌面应用：**Tauri 2 + React + TypeScript（前端）+ Rust（后端）**，Windows + macOS 双平台，不限定工作区目录。

> **版本线**：仓库已重新规划，当前全部代码为 **v1.0.0**（`package.json` / `Cargo.toml` / `tauri.conf.json` 三处版本号一致）。历史上的 PowerShell/WinForms 版与 v2.x/v3.x 旧版号均已作废，代码中不要再按旧版本号理解。
>
> **去脚本化（重要）**：项目清单为**路径模型**——`config.json` 的 `favorites`/`projects` 存的都是**项目绝对路径**（不再是脚本名），`+` 号启动直接 `cmd /k cd /d "项目" && claude`，**不再生成/执行 scripts/ 启动脚本**。旧版脚本在首次启动时被自动解析迁移（`ensure_projects_migrated`，幂等）。项目列表 = Claude 会话目录扫描（unmangle 反解）∪ config.projects 手动清单。

## 核心文件

| 文件 | 作用 |
|---|---|
| `src/` | 前端：React + TypeScript + Vite。`App.tsx` 状态管理；`src/components/` UI 组件（对话框/列表/会话查看器等）；`src/lib/api.ts` 封装全部 Tauri invoke |
| `src-tauri/src/lib.rs` | 后端：**全部 commands 与单元测试都在此**（约 2800 行，`#[cfg(test)]`）。项目清单系：`list_projects`/`add_project`/`remove_project`/`launch_project`/`check_projects`；一次性迁移：`ensure_projects_migrated` |
| `README.md` | 使用说明、构建方法 |

> 本目录为**纯源码库**（与 GitHub 仓库一致）：不含 exe、scripts、config.json——这些运行时产物/用户数据都在数据根目录（见「数据根目录」）。

## 启动与项目清单（去脚本化）

- **不再生成/执行启动脚本**：`+` 号启动直接新开终端执行 `cmd /k cd /d "项目路径" && claude`（Windows ShellExecuteW；macOS 临时 sh + Terminal.app），claude 退出后窗口保留。
- 项目列表 = **Claude 会话目录扫描**（`~/.claude/projects` unmangle 反解）∪ `config.projects`（手动添加的项目路径），按路径去重；收藏（favorites）存项目绝对路径。
- 「移除」= 从清单移除项目（不删磁盘文件）；「批量添加」= 把扫描到的项目加入清单。
- 旧版启动脚本（`scripts/claude-*.bat|sh`）在首次启动时被 `ensure_projects_migrated` 自动解析迁移（key → 路径），脚本文件保留在磁盘不自动删除。
- 健康检查（`check_projects`）直接检查项目路径是否存在。

## 跨平台层

- `script_ext()` 返回 bat/sh；`legacy_marker()` 兼容旧标记 `claude-claude-fast.<ext>`；`parse_cd_path` 兼容 `cd /d` 与 `cd "/path"` 两种语法。
- `launch_claude`：Windows 走 `ShellExecuteW` 开 cmd（Rust `Command` args 的引号会被 cmd 误解析，必须 ShellExecuteW）；macOS 走 `open -a Terminal`。
- `resume_session(file, project_path)`：新开终端窗口执行 `claude --resume <session-id>`。Windows 用 `build_resume_cmdline` 拼防注入命令行；macOS 写临时 .sh 到系统临时目录再 `open -a Terminal`（无需 osascript 自动化权限）。共用 `validate_resume_path`，但平台规则不同：Windows 拒绝 cmd 元字符；macOS 路径经 `sh_quote` 进 `cd "..."` 后元字符均为字面量，故仅拒控制字符 + 要求路径存在（避免误伤含 `( ) ' \` 的合法 mac 路径）。
- `open_folder`：explorer.exe / `open`；`check_claude`：`where` / `sh -c "command -v claude"`（均 3 秒超时，阻塞线程池执行不卡 UI）。

## mangle / unmangle（Claude Code 项目目录名解析）

- 正向 `mangle_project_path`：`: \ / _ .` → `-`（如 macOS `/Users/foo/bar` → `-Users-foo-bar`）。
- 反向 `unmangle_candidates` 分平台：Windows 解析 `X--...`（盘符格式），macOS 解析 `-Users-...`（根 `/`），共用 `enum_segment_paths` 枚举歧义候选（层级最多者优先）。
- Claude Code CLI 的项目目录为 `~/.claude/projects`（macOS 同 Linux）；macOS 后备 `~/Library/Application Support/Claude/projects`（**Claude Desktop** 内置 code 的会话目录，仅当 `~/.claude` 缺失且此处存在时使用）；`CLAUDE_CONFIG_DIR` 环境变量（官方自定义数据目录）优先于以上所有。`get_claude_projects_dir` / `scan_claude_projects` 按此优先级定位。

## 功能

- **收藏置顶**（`favorites`）：点星标或右键收藏，金色置顶。已收藏项可**整行拖拽排序**（顺序即 `favorites` 数组顺序，松手后复用 `save_config` 落盘；按 key 重排非索引，失效 key 原位保留；搜索过滤期间禁用拖拽；未收藏行不可拖拽）。前端用原生 HTML5 DnD——**`tauri.conf.json` 的 `dragDropEnabled: false` 是前提**（默认 true 时 Windows 上 WebView2 的 OLE 拖放处理会拦截页面内 dragover/drop，勿当冗余配置删掉）。
- **健康检查不阻塞启动**：`list_launchers` 只解析脚本内容不做目录 stat（秒返回）；前端渲染后异步调 `check_launchers` 并行检查，失效目录自动标红；「健康检查」对话框打开时现场重新检查。
- **批量添加**：扫描 Claude Code 项目目录，`unmangle_candidates` 反解出真实路径并验证存在性，失效项目（`missing`）不参与添加；已在清单中的项目标记跳过。清单存**项目绝对路径**于 `config.projects`。
- **会话管理**：点击项目行展开其 Claude Code 会话列表（异步加载不阻塞 UI）；会话行显示标题 + 相对时间 + 摘要，悬停出现 ✎ 重命名、🗑 删除。`list_sessions(project_path)` 用真实路径正向 mangle 定位 `<projects>/<mangled>/`，对每个 `.jsonl` 只读首尾各 64KB（`LITE_READ_BUF_SIZE`）提取元数据：标题回退链 customTitle > aiTitle > 首条用户消息；**命令消息（如 `/init`）被跳过——只执行命令、无实质对话的会话不进列表**；sidechain/纯元数据会话过滤；按 mtime 倒序。`rename_session(file, new_title)` 安全校验（限 projects 目录下 uuid.jsonl）后向 jsonl **追加** `custom-title` 行（与 Claude Code `/rename` 同机制，不覆盖原文件）。
- **回收站（删除 = 移入回收站）**：`delete_session` 先备份到数据根 `trash/sessions/<时间戳>/<项目>/` 再删除；「🗑 回收站」对话框可 `restore_session` 恢复（移回原目录，Claude Code 可继续 resume）或 `purge_session` / `purge_trash` 永久删除（行内二次确认）。
- **会话内容查看**：左右分栏（左 320px 项目/会话列表，右内容区）。`get_session_messages(file)` 全量读 jsonl 提取 user/assistant 消息（text/thinking/tool_use/tool_result 块，`MAX_SESSION_MESSAGES=500` 截断，过滤 sidechain/isMeta/命令消息），前端聊天式渲染（思考/工具调用/工具结果 `<details>` 折叠、围栏代码块等宽）。
- **单实例**（`tauri-plugin-single-instance`）：重复启动不新建进程，回调里 show + unminimize + set_focus + `set_always_on_top` 开关（对抗 Windows 前台锁定，勿当冗余代码删掉）把已有窗口调到前台。
- 其他：深色主题（`dark`）、搜索过滤、右键菜单、新建/删除启动脚本、关闭行为可选（`close_action`：询问/退出/最小化到托盘）、系统托盘（显示窗口/退出）。状态存 `config.json`。

## 数据根目录（双模式）

`resolve_root_dir()` 自动区分：

1. **便携模式**：exe 所在目录向上（最多 6 级）查找含 `config.json` + `scripts/` 的目录（或旧标记 `claude-claude-fast.bat`）——开发目录、整体移动的文件夹、绿色版走此路径。
2. **安装模式**：找不到时回退 `%APPDATA%\claude-fast`（macOS `~/Library/Application Support/claude-fast`），首次运行自动创建 `scripts/`。

## 铁律

- **绝不删除数据根的 `config.json` / `.bak`**——用户收藏在这里。`save_config` 三步保护：写临时文件 → 旧文件备份为 `.bak` → 原子替换；`load_config` 读主文件失败时自动从 `.bak` 回退。
- ⚠️ **必须用 `npm run tauri build`（或 `npx tauri build`）构建，禁止直接 `cargo build --release`**：只有 tauri CLI 自动加 `--features tauri/custom-protocol`，缺它产物是 dev 模式，运行时连 `http://localhost:1420` 白屏。
- 国内网络首次构建需 crates.io 镜像（用户 `~/.cargo/config.toml` 已配 rsproxy.cn）。

## 开发命令

```bash
npm install                  # 前端依赖
npm run tauri dev            # 开发模式（热更新）
cd src-tauri && cargo test   # 后端单元测试（61 个：路径解析/脚本生成/配置/扫描/根目录定位/会话管理/mangle/sh_quote）
npm run tauri build          # 生产构建
# macOS 通吃包（Intel + Apple Silicon）：npm run tauri build -- --target universal-apple-darwin
```

构建产物：Windows 为 NSIS 安装包（`src-tauri/target/release/bundle/nsis/Claude助手_<版本>_x64-setup.exe`，`installMode: perMachine`、安装界面中英双语、免管理员），安装到 `%LOCALAPPDATA%\Programs\Claude助手`；macOS 为 `bundle/macos/Claude助手.app` 与 `bundle/dmg/*.dmg`。便携 exe 从 `src-tauri/target/release/` 复制（须与 config.json/scripts 同层）。
