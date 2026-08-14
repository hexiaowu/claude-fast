# Claude助手

在任意项目目录中一键启动 Claude Code，无需手动进目录、开终端、敲命令。支持 Windows 与 macOS。

## 目录结构

```
claude-fast/
├── src/                     前端源码（React + TypeScript + Vite）
├── src-tauri/               Rust 后端源码（Tauri 2）
├── app-icon.png             图标源文件（tauri icon 输入）
├── package.json / vite.config.ts / tsconfig.json / index.html
├── CLAUDE.md                项目说明（进入本文件夹时 Claude 自动加载）
└── README.md
```

> 本目录为**纯源码库**（与 GitHub 仓库一致）。程序本体通过**安装包**分发（Windows：`Claude助手_<版本>_x64-setup.exe`；macOS：`Claude助手_<版本>_x64.dmg` + `.app`）；用户数据（启动脚本 `scripts/`、收藏 `config.json`）在安装版数据目录 `%APPDATA%\claude-fast`（macOS 为 `~/Library/Application Support/claude-fast`）。

## 使用

双击桌面上的「Claude助手」快捷方式（或开始菜单的 `Claude助手`）打开图形界面。
Tauri 应用为 GUI 程序，启动时**不会出现多余的 cmd 窗口**，关闭界面即完全退出。

- **启动 Claude Code** → 点击项目行内的「启动」按钮，新开终端窗口进入该项目目录并运行 claude（窗口保持不关）
- **展开会话列表** → 点击项目行展开/收起其 Claude Code 会话列表（标题 + 时间 + 摘要），✎ 可重命名会话（写入 jsonl 的 custom-title，Claude Code 官方 /rename 同机制，改名后官方 CLI 同样生效）；🗑 删除会话（二次确认，删除后移入回收站）
- **🗑 回收站** → 顶部工具栏按钮；删除的会话在这里，可一键恢复（回到原项目，Claude Code 可继续 resume）或永久删除（需再次确认）
- **📖 会话内容查看** → 点击会话行，右侧区域以聊天形式显示会话内容（用户/助手消息、思考过程折叠、工具调用与结果折叠、代码块等宽渲染；超过 500 条只显示最近部分）；点会话内容区的「刷新」按钮可重新加载该会话的最新内容
- **▶ 继续对话** → 点击会话行 ▶ 按钮（或右侧「继续对话」按钮），新开终端窗口在项目目录执行 `claude --resume <会话id>` 继续对话（窗口保持不关）
- **★ 收藏** → 把常用项目置顶。点每行左侧星标，或右键项目选「收藏 / 取消收藏」；收藏名单保存在 `config.json`，重启后依然有效
- **批量添加** → 一键扫描 Claude Code 项目目录（Windows `%USERPROFILE%\.claude\projects`；macOS `~/.claude/projects`——Claude Code CLI 的规范路径），自动反向解析真实路径并批量生成启动脚本（路径已失效的项目标红跳过，自动跳过已存在的）
- **健康检查** → 扫描所有启动项：失效目录在列表中用**红色**标记，点按钮可弹出详细报告（含 `claude` 命令是否可用）
- **🌙 深色 / ☀ 浅色** → 切换主题，偏好保存在 `config.json`
- **右键菜单** → 收藏 / 取消收藏、打开所在文件夹、复制路径、健康检查
- **新建启动脚本** → 输入项目路径（或点「浏览」选文件夹），自动生成启动脚本

## 开发与构建

技术栈：**Tauri 2（Rust 后端）+ React + TypeScript + Vite**。

```bash
# 安装依赖
npm install

# 开发模式（热更新，需要 Rust 工具链）
npm run tauri dev

# 单元测试（Rust 后端逻辑：路径解析 / 脚本生成 / 配置读写 / 目录扫描）
cd src-tauri && cargo test

# 生产构建（前端构建 + Rust release 编译 + 安装包：Windows 为 NSIS，macOS 为 .app + .dmg）
npm run tauri build

# macOS 通吃包（可选）：lipo 合并 Intel + Apple Silicon 两种架构，一个包两种芯片都能跑
# 需先：rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

> 首次在 macOS 上构建前，建议先跑 `cd src-tauri && cargo test`——它会编译全部 mac 分支代码并执行 mac 专属测试（如 resume 脚本生成），是最快的验证方式。

构建产物（Windows）：`src-tauri/target/release/bundle/nsis/Claude助手_<版本>_x64-setup.exe`（安装包，可选择安装目录、免管理员）
和 `src-tauri/target/release/claude-fast.exe`（便携版，需与 config.json/scripts 同层放置）。

构建产物（macOS）：`src-tauri/target/release/bundle/macos/Claude助手.app`（拖入「应用程序」即可）
和 `src-tauri/target/release/bundle/dmg/Claude助手_<版本>_<架构>.dmg`（安装镜像；<架构> 为 aarch64 / x86_64 / universal，取决于构建目标）。

### 架构要点

- **数据目录定位（双模式）**：exe 从自身所在目录向上逐级查找首个含 `config.json` + `scripts/` 子目录的目录（兼容旧的 `claude-claude-fast.bat` 标记）——**便携模式**（开发目录/绿色版/整个文件夹移动）。找不到标记时回退到 **安装模式**：`%APPDATA%\claude-fast`（macOS 为 `~/Library/Application Support/claude-fast`），首次运行自动创建 `scripts/` 目录。因此：绿色版把 exe 放项目根即可用；安装版装到 Program Files（只读）也能正常读写用户数据。
- **后端**（`src-tauri/src/lib.rs`）：扫描 `scripts/` 下的 `claude-*.bat`（macOS 为 `claude-*.sh`）、解析脚本内 `cd` 路径（兼容 bat 的 `cd /d "..."` 与 sh 的 `cd "/path"`）、健康检查、生成/删除启动脚本（新建一律写入 `scripts/`）、批量扫描 Claude Code 项目目录（`unmangle_candidates` 反向解析 mangled 目录名并检测失效，Windows 盘符格式与 macOS `/` 格式各有实现）、启动 Claude（Windows 用 ShellExecuteW 开 cmd，macOS 用 `open -a Terminal`）、读写 `config.json`。
- **config.json 保护**：`save_config` 采用「写临时文件 → 备份旧文件到 `.bak` → 原子替换」三步；`load_config` 读取失败时自动从 `.bak` 回退。**绝不删除 `config.json` / `.bak`**，否则用户的收藏丢失。
- **启动脚本约定**（Windows .bat）：UTF-8 编码、CRLF 换行、`chcp 65001` 后输出中文、`call claude`（不加 `call` 时 cmd 不返回，错误处理不执行）、出错时 `pause` 保留窗口。（macOS .sh）：`#!/bin/bash`、`cd "/路径" || exit 1`、`command -v claude` 检查、`exec claude` 启动、出错时提示并等待回车，脚本自动 chmod +x。
- **批量添加的命名**：统一用项目**叶子目录名**（不限定工作区目录，项目可分布在任意位置），如某项目目录以 `myapp` 结尾，则生成 `claude-myapp.bat`（macOS 为 `.sh`）；同名叶子目录自动加序号（`claude-myapp-2.bat`），不会互相覆盖。
- **打包目标**：`bundle.targets = ["nsis", "app", "dmg"]`（`tauri.conf.json`）——各平台构建时自动过滤：Windows 只打 NSIS 安装包，macOS 只打 .app + .dmg；不要删掉该字段（Tauri 在 Windows 上的默认目标是 MSI/WiX，会导致打包失败）。
- **前端**（`src/`）：`App.tsx` 状态管理 + 组件化 UI（列表 / 搜索 / 收藏 / 右键菜单 / 各对话框），`src/lib/api.ts` 封装 Tauri invoke 调用。

## 添加新项目

方式一：**「批量添加」按钮** —— 自动扫描 Claude Code 项目目录 `~/.claude/projects`（Claude Code 管理过的所有项目），目录名反向解析出真实路径；已被删除的项目标红失效、不参与生成；一键批量生成启动脚本（适合初次使用或新增了多个项目时）。

方式二：「新建」按钮，输入项目路径单个添加。

方式三：手动复制 `scripts/` 下任意 `claude-xxx.bat`（macOS 为 `claude-xxx.sh`），改名并修改里面的这一行：

```bat
cd /d "你的项目路径"
```

## 说明

- 脚本会先 `cd` 到项目目录，再调用 `claude` 启动（Windows 为 `call claude`）。
- 项目目录不存在或 `claude` 命令未找到时，会显示错误并暂停，不会直接闪退。
- Claude Code 正常退出后窗口会自动关闭。
- 各启动脚本里的目录路径是**绝对路径**（项目若移动需同步修改对应脚本）。
- **跨平台**：Windows 与 macOS 行为一致（启动脚本/会话管理/回收站/批量添加全部支持）；macOS 上 Claude Code CLI 的会话目录为 `~/.claude/projects`（规范路径），批量添加来源即此。
- 国内网络下首次 `cargo build` 拉取依赖很慢，可在 `C:\Users\<你>\.cargo\config.toml` 配置 crates.io 镜像（本项目用的是 `https://rsproxy.cn/index/` sparse 源）。
