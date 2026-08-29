# Claude助手（claude-fast）

一键在项目目录启动 Claude Code 的桌面应用：**Electron（Node.js 后端）+ React + TypeScript（前端）+ Vite**，Windows + macOS 双平台，不限定工作区目录。

> **版本线**：仓库已重新规划，当前全部代码为 **v1.0.0**（`package.json` 版本号）。历史上的 PowerShell/WinForms 版、Tauri/Rust 版与 v2.x/v3.x 旧版号均已作废，代码中不要再按旧版本号理解。

## 核心文件

| 文件 | 作用 |
|---|---|
| `src/` | 前端：React + TypeScript + Vite。`App.tsx` 状态管理；`src/components/` 15 个 UI 组件（对话框/列表/会话查看器等）；`src/lib/api.ts` 封装全部 preload 桥调用（`window.claudeFast`） |
| `electron/main.ts` | Electron 主进程：窗口 / 托盘 / 单实例 / 关闭拦截 / 全部 IPC 命令注册 |
| `electron/preload.ts` | `contextBridge` 白名单 API（渲染进程无 Node 权限，全部经 `ipcRenderer.invoke`） |
| `electron/backend/` | 后端业务模块：`paths.ts`（数据根/项目目录定位）、`launchers.ts`（脚本列表/创建/查重）、`scriptnames.ts`（命名/模板/`parseCdPath`）、`config.ts`（配置三步保护）、`mangle.ts`（目录名正反解析）、`sessions.ts`（会话列表/元数据/内容解析）、`trash.ts`（回收站）、`platform.ts`（启动/健康检查/resume/批量扫描）、`text.ts`（标题清洗） |
| `tools/` | 构建脚本：`dev.mjs`（并行 vite + electron）、`build-electron.mjs`（esbuild 编译主进程） |
| `build/` | 打包图标（icon.ico / icon.png / icon.icns） |
| `README.md` | 使用说明、构建方法 |

> 本目录为**纯源码库**（与 GitHub 仓库一致）：不含 exe、scripts、config.json——这些运行时产物/用户数据都在数据根目录（见「数据根目录」）。

## 启动脚本约定

- 每个 `claude-*.bat`（Windows）/ `claude-*.sh`（macOS）内容固定：`cd` 到项目路径 → 检查 `claude` 命令 → 启动 `claude`，统一生成到数据根 `scripts/`。
- Windows **必须写 `call claude` 而不是 `claude`**：`claude` 是 `claude.cmd` shim，批处理调用其他 .cmd 不加 `call` 时 cmd 不返回，错误处理不执行。bat 约定：UTF-8 编码、CRLF 换行、`chcp 65001` 后输出中文、出错 `pause` 保留窗口。
- macOS `.sh` 模板（`genSh`）：`#!/bin/bash` + `fail()` 函数（提示+等回车）+ `cd "/路径" || fail` + `command -v claude` 检查 `|| fail` + `exec claude`；路径经 `shQuote` 转义（`\` `"` `$` 反引号）防注入；写脚本后自动 `chmod +x`。
- 脚本里的目录路径是**绝对路径**（项目移动后需同步修改脚本）。

## 跨平台层

- `scriptExt()` 返回 bat/sh；`legacyMarker()` 兼容旧标记 `claude-claude-fast.<ext>`；`parseCdPath` 兼容 `cd /d` 与 `cd "/path"` 两种语法。
- `launchClaude`：Windows 走 `spawn("cmd.exe", ["/c", `"path"`], { windowsVerbatimArguments: true })`（Node 默认会按 MSVC 规则转义引号，cmd 不认 `\"`，必须 verbatim 让引号原样传递）；macOS 走 `open -a Terminal`。
- `resumeSession(file, projectPath)`：新开终端窗口执行 `claude --resume <session-id>`。Windows 用 `buildResumeCmdline` 拼防注入命令行；macOS 写临时 .sh 到系统临时目录再 `open -a Terminal`（无需 osascript 自动化权限）。共用 `validateResumePath`，但平台规则不同：Windows 拒绝 cmd 元字符；macOS 路径经 `shQuote` 进 `cd "..."` 后元字符均为字面量，故仅拒控制字符 + 要求路径存在（避免误伤含 `( ) ' \` 的合法 mac 路径）。
- `openFolder`：explorer.exe / `open`；`checkClaude`：`where` / `sh -c "command -v claude"`（均 3 秒超时，Promise 不阻塞渲染）。
- `checkClaude`/`checkLaunchers` 等 spawn 系函数 Windows 一律 `windowsHide: true`，防止后台命令闪黑窗。

## mangle / unmangle（Claude Code 项目目录名解析）

- 正向 `mangleProjectPath`：`: \ / _ .` → `-`（如 macOS `/Users/foo/bar` → `-Users-foo-bar`）。
- 反向 `unmangleCandidates` 分平台：Windows 解析 `X--...`（盘符格式），macOS 解析 `-Users-...`（根 `/`），共用 `enumSegmentPaths` 枚举歧义候选（层级最多者优先；段过多 >5 降级防组合爆炸）。
- Claude Code CLI 的项目目录为 `~/.claude/projects`（macOS 同 Linux）；macOS 后备 `~/Library/Application Support/Claude/projects`（**Claude Desktop** 内置 code 的会话目录，仅当 `~/.claude` 缺失且此处存在时使用）；`CLAUDE_CONFIG_DIR` 环境变量（官方自定义数据目录）优先于以上所有。`getClaudeProjectsDir` / `scanClaudeProjects` 按此优先级定位。

## 功能

- **收藏置顶**（`favorites`）：点星标或右键收藏，金色置顶。已收藏项可**整行拖拽排序**（顺序即 `favorites` 数组顺序，松手后复用 `saveConfig` 落盘；按 key 重排非索引，失效 key 原位保留；搜索过滤期间禁用拖拽；未收藏行不可拖拽）。前端用原生 HTML5 DnD——主进程的 **`will-navigate` 拦截是前提**（Electron 渲染层默认拖文件/链接会导航离开页面，`main.ts` 里 `webContents.on("will-navigate", e => e.preventDefault())` 与 `setWindowOpenHandler` deny 保证页面内 dragover/drop 可用，勿当冗余代码删掉）。
- **健康检查不阻塞启动**：`listLaunchers` 只解析脚本内容不做目录 stat（秒返回）；前端渲染后异步调 `checkLaunchers` 并行检查，失效目录自动标红；「健康检查」对话框打开时现场重新检查。
- **批量添加**：扫描 Claude Code 项目目录，`unmangleCandidates` 反解出真实路径并验证存在性，失效项目（`missing`）不参与生成。命名**无工作区概念**：任何路径统一用叶子目录名（如 `myapp` → `claude-myapp.bat`）；同名自动加序号（`claude-myapp-2.bat`，`pickUniqueScriptPath`），**绝不覆盖**其他项目的脚本。
- **会话管理**：点击项目行展开其 Claude Code 会话列表（异步加载不阻塞 UI）；会话行显示标题 + 相对时间 + 摘要，悬停出现 ✎ 重命名、🗑 删除。`listSessions(projectPath)` 用真实路径正向 mangle 定位 `<projects>/<mangled>/`，对每个 `.jsonl` 只读首尾各 64KB（`LITE_READ_BUF_SIZE`）提取元数据：标题回退链 customTitle > aiTitle > 首条用户消息；**命令消息（如 `/init`）被跳过——只执行命令、无实质对话的会话不进列表**；sidechain/纯元数据会话过滤；按 mtime 倒序。`renameSession(file, newTitle)` 安全校验（限 projects 目录下 uuid.jsonl）后向 jsonl **追加** `custom-title` 行（与 Claude Code `/rename` 同机制，不覆盖原文件）。
- **回收站（删除 = 移入回收站）**：`deleteSession` 先备份到数据根 `trash/sessions/<时间戳>/<项目>/` 再删除；「🗑 回收站」对话框可 `restoreSession` 恢复（移回原目录，Claude Code 可继续 resume）或 `purgeSession` / `purgeTrash` 永久删除（行内二次确认）。
- **会话内容查看**：左右分栏（左 320px 项目/会话列表，右内容区）。`getSessionMessages(file)` 全量读 jsonl 提取 user/assistant 消息（text/thinking/tool_use/tool_result 块，`MAX_SESSION_MESSAGES=500` 截断，过滤 sidechain/isMeta/命令消息），前端聊天式渲染（思考/工具调用/工具结果 `<details>` 折叠、围栏代码块等宽）。
- **单实例**（`app.requestSingleInstanceLock()`）：重复启动不新建进程，`second-instance` 回调里 show + restore + focus + `setAlwaysOnTop` 开关（对抗 Windows 前台锁定，勿当冗余代码删掉）把已有窗口调到前台。
- **关闭行为**：主进程拦截窗口 `close`（`e.preventDefault()` + 向渲染层发 `window:close-requested`），前端按 `closeAction` 分发：`quit` → `destroyWindow`（绕过拦截）、`minimize` → `hideWindow`（托盘）、未设置 → 弹窗询问。托盘菜单「退出程序」与 `quitApp` IPC 走 `quitting` 标志绕过拦截直接退出。
- 其他：深色主题（`dark`）、搜索过滤、右键菜单、新建/删除启动脚本、开机自启动（`app.setLoginItemSettings`：Windows 注册表 Run 项 / macOS 登录项）、系统托盘（左键显示窗口/右键菜单：显示窗口+退出；**不能用 `setContextMenu`**——Windows 上设置后左键单击也会弹菜单，会顶掉「左键显示窗口」）。状态存 `config.json`。

## 数据根目录（双模式）

`resolveRootDir(process.execPath)` 自动区分：

1. **便携模式**：exe 所在目录向上（最多 6 级）查找含 `config.json` + `scripts/` 的目录（或旧标记 `claude-claude-fast.bat`）——开发目录、整体移动的文件夹、绿色版走此路径。
2. **安装模式**：找不到时回退 `%APPDATA%\claude-fast`（macOS `~/Library/Application Support/claude-fast`），首次运行自动创建 `scripts/`。

## 铁律

- **绝不删除数据根的 `config.json` / `.bak`**——用户收藏在这里。`saveConfig` 三步保护：写临时文件 → 旧文件备份为 `.bak` → 原子替换；`loadConfig` 读主文件失败时自动从 `.bak` 回退。
- **会话删除必先备份**：删除会话 = `deleteSessionFile` 先 rename/copy 到 `trash/sessions/<UTC时间戳>/<mangled项目>/` 再删原文件；恢复时目标已存在必须拒绝（防覆盖）。
- **渲染进程零 Node 权限**：新增后端能力时，在 `electron/main.ts` 注册 IPC handler + `electron/preload.ts` 白名单 API + `src/lib/electron-api.d.ts` 类型声明三处同步；不得在渲染层开 `nodeIntegration` 或放宽 contextIsolation。
- ⚠️ **生产渲染层以 file:// 加载**：`vite.config.ts` 的 `base: './'` 是前提（默认 `/` 时资源 404 白屏），勿删。
- ⚠️ **打包必须走 `npm run dist:*`**（= `npm run build` + electron-builder）：主进程由 esbuild 编译为 `dist-electron/*.cjs`，未构建直接 `electron .` 会找不到模块。

## 开发命令

```bash
npm install                  # 依赖（国内可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 加速）
npm run dev                  # 开发模式（vite 热更新 + electron，主进程改动自动重启）
npm test                     # 后端单元测试（107 个：路径解析/脚本生成/配置/扫描/根目录定位/会话管理/mangle/回收站）
npm run typecheck            # 类型检查（前端 tsc + electron tsc）
npm run build                # 生产构建（typecheck + vite build + esbuild 编译主进程）
npm run dist:win             # Windows NSIS 安装包（别名：npm run electron:build）
npm run dist:mac             # macOS dmg（x64 + arm64）
```

构建产物：Windows 为 NSIS 安装包（`release/Claude助手_<版本>_x64-setup.exe`，`perMachine`、安装界面中英双语、免管理员、可换安装目录）；macOS 为 `release/Claude助手-<版本>-<arch>.dmg`（x64 + arm64 双架构）。绿色版取安装目录内容（asar 包内含 dist 与 dist-electron），与 config.json/scripts 同层放置即为便携模式。
