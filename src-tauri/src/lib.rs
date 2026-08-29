use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 控制台子进程不创建新窗口（GUI 主进程 spawn where 等工具时防止闪黑窗口，仅 Windows）
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 启动脚本专用目录（相对数据根目录）
const SCRIPTS_DIR: &str = "scripts";

/// 当前平台的启动脚本扩展名：Windows 用 .bat，macOS 用 .sh
fn script_ext() -> &'static str {
    #[cfg(windows)]
    {
        "bat"
    }
    #[cfg(not(windows))]
    {
        "sh"
    }
}

/// 旧版便携模式数据根标记文件名（Windows 为 claude-claude-fast.bat）
fn legacy_marker() -> String {
    format!("claude-claude-fast.{}", script_ext())
}

// ---------------- 数据模型 ----------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItem {
    /// 唯一键 = 项目绝对路径
    key: String,
    /// 叶子目录名（显示用）
    name: String,
    /// 项目绝对路径
    path: String,
    /// true = 路径当前不存在（标红、不可启动）
    missing: bool,
    // healthy 不在 list_projects 中计算（避免启动时阻塞在目录检查上），
    // 由前端调用 check_projects 异步获取后回填。
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 收藏的项目绝对路径（置顶）
    favorites: Vec<String>,
    /// 手动添加的项目路径清单（Claude 会话扫描之外的补充）
    #[serde(default)]
    projects: Vec<String>,
    dark: bool,
    /// 关闭窗口行为：None=每次询问；Some("quit")=直接退出；Some("minimize")=最小化到托盘
    #[serde(default)]
    close_action: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DataRootInfo {
    path: String,
    install_mode: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProject {
    /// 真实路径的叶子目录名（用于显示）
    name: String,
    /// 解析出的真实路径（不存在时为首选候选路径）
    path: String,
    /// true = 真实路径已不存在（项目代码被删除）
    missing: bool,
}

/// 会话元数据（从 jsonl 的 head/tail 轻量提取，不读全文件）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// 会话 ID（uuid，即 jsonl 文件名）
    session_id: String,
    /// 最终显示标题：customTitle > aiTitle > 首条用户消息
    title: String,
    /// 副行摘要：customTitle > lastPrompt > summary 字段 > 首条用户消息
    summary: String,
    /// 最后修改时间（文件 mtime，epoch ms）
    last_modified: i64,
    /// jsonl 文件绝对路径（重命名时回传）
    file: String,
}

/// 会话内容块（对齐 Claude Code jsonl 的 content 块格式）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    /// text | thinking | tool_use | tool_result
    kind: String,
    /// text/thinking/tool_result 的文本内容
    text: Option<String>,
    /// tool_use 工具名
    name: Option<String>,
    /// tool_use 输入（JSON 原样）
    input: Option<serde_json::Value>,
    /// tool_result 关联的 tool_use id
    tool_use_id: Option<String>,
    /// tool_result 是否报错
    is_error: Option<bool>,
}

/// 会话中的一条消息（user / assistant）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    /// user | assistant
    kind: String,
    blocks: Vec<ContentBlock>,
    timestamp: Option<String>,
    /// assistant 的模型名
    model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessages {
    /// 本批消息（最多 limit 条）
    messages: Vec<SessionMessage>,
    /// 还有更早的消息未加载（向上分页用）
    has_more: bool,
    /// 会话总消息数
    total: usize,
    /// 本批起始位置（0 = 从最早一条开始）
    offset: usize,
}

/// 会话内容渲染的最大消息数（防止超大 jsonl 拖垮 UI）
const MAX_SESSION_MESSAGES: usize = 500;

// ---------------- 路径定位 ----------------

/// 判断目录是否为数据根：新布局（config.json + scripts/ 子目录）或旧布局
/// （根目录直接放 claude-claude-fast.<bat|sh>）
fn is_root_dir(dir: &Path) -> bool {
    (dir.join("config.json").is_file() && dir.join(SCRIPTS_DIR).is_dir())
        || dir.join(legacy_marker()).is_file()
}

/// 安装模式数据根：%APPDATA%\claude-fast（Windows）/
/// ~/Library/Application Support/claude-fast（macOS）。
/// 安装包模式下 exe 位于 Program Files（只读），用户数据统一放这里。
fn app_data_root() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("APPDATA").unwrap_or_default();
    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .map(|h| format!("{}/Library/Application Support", h))
        .unwrap_or_default();
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(base).join("claude-fast")
}

/// 定位数据根目录（双模式）：
/// 1. **便携模式**：exe 所在目录向上逐级查找首个根目录标记
///    （config.json + scripts/，或旧标记 claude-claude-fast.bat）——
///    开发目录、整体移动的文件夹、绿色版均走此路径。
/// 2. **安装模式**：找不到便携标记时回退到应用数据目录
///    （%APPDATA%\claude-fast），首次运行自动创建 scripts/ 子目录。
fn resolve_root_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let mut dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    for _ in 0..6 {
        if is_root_dir(&dir) {
            return dir;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    // 安装模式：应用数据目录（幂等创建 scripts/，保证「安装后自动生效」）
    let app = app_data_root();
    let _ = fs::create_dir_all(app.join(SCRIPTS_DIR));
    app
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    }
}

fn read_config_file(path: &Path) -> Option<Config> {
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(strip_bom(&raw)).ok()
}

/// 从启动脚本内容解析 `cd` 行中的目录路径。兼容 bat 的 `cd /d "..."` 与
/// sh 的 `cd "/path"` / `cd /path`（带引号/不带引号均可）。
fn parse_cd_path(content: &str) -> Option<String> {
    for line in content.lines() {
        let t = line.trim();
        let lower = t.to_ascii_lowercase();
        // bat: `cd /d "path"`；sh: `cd "/path"` / `cd /path`（前缀长度固定）
        let rest = if lower.starts_with("cd /d") {
            &t[5..]
        } else if lower.starts_with("cd ") {
            &t[3..]
        } else {
            continue;
        };
        let rest = rest.trim();
        if let Some(stripped) = rest.strip_prefix('"') {
            if let Some(end) = stripped.find('"') {
                return Some(stripped[..end].to_string());
            }
        } else {
            let p = rest.split_whitespace().next().unwrap_or("");
            if !p.is_empty() {
                return Some(p.to_string());
            }
        }
    }
    None
}

// ---------------- commands ----------------

// ---------------- 项目清单（去脚本化） ----------------

fn stat_is_dir(p: &str) -> bool {
    Path::new(p).is_dir()
}

/// 构建主列表：Claude 会话扫描 ∪ config.projects 手动清单，按路径去重。
/// missing = 路径当前不存在（仍显示、标红、不可启动）。
fn list_projects_impl(projects_dir: &Path, manual: &[String]) -> Vec<ProjectItem> {
    let mut out: Vec<ProjectItem> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let push = |item: ProjectItem, out: &mut Vec<ProjectItem>, seen: &mut Vec<String>| {
        let key = item.key.to_lowercase();
        if !seen.iter().any(|s| *s == key) {
            seen.push(key);
            out.push(item);
        }
    };
    for s in scan_claude_projects_blocking(projects_dir) {
        push(
            ProjectItem {
                key: s.path.clone(),
                name: s.name.clone(),
                path: s.path,
                missing: s.missing,
            },
            &mut out,
            &mut seen,
        );
    }
    for mp in manual {
        let name = Path::new(mp)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| mp.clone());
        push(
            ProjectItem {
                key: mp.clone(),
                name,
                path: mp.clone(),
                missing: !stat_is_dir(mp),
            },
            &mut out,
            &mut seen,
        );
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 把一个项目路径加入手动清单（已在清单中则原样返回）。路径必须是存在的目录。
fn add_project_to(manual: &mut Vec<String>, dir: &str) {
    if !stat_is_dir(dir) {
        return;
    }
    if !manual.iter().any(|p| p.eq_ignore_ascii_case(dir)) {
        manual.push(dir.to_string());
    }
}

/// 从手动清单移除项目路径（收藏同步移除由调用方处理）
fn remove_project_from(manual: &mut Vec<String>, dir: &str) {
    manual.retain(|p| !p.eq_ignore_ascii_case(dir));
}

/// 解析数据根 scripts/ 下旧启动脚本（Tauri 版遗留）→ 脚本 stem → cd 路径。
/// 用于去脚本化的一次性迁移；脚本文件本身保留不动。
fn legacy_script_paths(scripts: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(entries) = fs::read_dir(scripts) else {
        return map;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !stem.to_lowercase().starts_with("claude-") {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext != script_ext() {
            continue;
        }
        if let Some(cd) = parse_cd_path(&fs::read_to_string(&p).unwrap_or_default()) {
            map.insert(stem.to_string(), cd);
        }
    }
    map
}

/// 旧脚本清单一次性迁移（去脚本化）：解析旧脚本的 cd 路径完成 key → 项目路径映射：
///   projects  = 全部脚本指向的项目路径
///   favorites = 旧收藏 key 映射后的项目路径（找不到的丢弃）
/// 判定：config.json 原始内容含 "projects" 字段（或无 config 文件）即视为已迁移。
fn ensure_projects_migrated() {
    ensure_projects_migrated_in(&resolve_root_dir());
}

fn ensure_projects_migrated_in(root: &Path) {
    let cfg_path = root.join("config.json");
    let Ok(text) = fs::read_to_string(&cfg_path) else {
        return; // 无 config（全新安装）
    };
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    if raw.get("projects").is_some() {
        return; // 已迁移
    }
    let key_to_path = legacy_script_paths(&root.join(SCRIPTS_DIR));
    let legacy_favs: Vec<String> = raw
        .get("favorites")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let cfg = load_config_from(root);
    let mut projects: Vec<String> = Vec::new();
    for p in key_to_path.values() {
        if !projects.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            projects.push(p.clone());
        }
    }
    let mut favorites: Vec<String> = Vec::new();
    for k in legacy_favs {
        if let Some(p) = key_to_path.get(&k) {
            if !favorites.iter().any(|x| x.eq_ignore_ascii_case(p)) {
                favorites.push(p.clone());
            }
        }
    }
    let _ = save_config_to(root, favorites, projects, cfg.dark, cfg.close_action);
}

#[tauri::command]
fn list_projects() -> Vec<ProjectItem> {
    let cfg = load_config();
    list_projects_impl(&claude_projects_dir(), &cfg.projects)
}

#[tauri::command]
fn add_project(path: String) -> Result<(), String> {
    let mut cfg = load_config();
    if !stat_is_dir(&path) {
        return Err("路径不存在或不是文件夹".to_string());
    }
    add_project_to(&mut cfg.projects, &path);
    save_config(cfg.favorites.clone(), cfg.projects.clone(), cfg.dark, cfg.close_action.clone())
}

#[tauri::command]
fn remove_project(path: String) -> Result<(), String> {
    let mut cfg = load_config();
    remove_project_from(&mut cfg.projects, &path);
    // 收藏里同步移除（列表键已变为项目路径）
    remove_project_from(&mut cfg.favorites, &path);
    save_config(cfg.favorites.clone(), cfg.projects.clone(), cfg.dark, cfg.close_action.clone())
}

/// 读取配置：主文件损坏时自动回退到 .bak 并恢复主文件（收藏不丢失）
#[tauri::command]
fn load_config() -> Config {
    load_config_from(&resolve_root_dir())
}

fn load_config_from(root: &Path) -> Config {
    let cfg_path = root.join("config.json");
    let bak_path = root.join("config.json.bak");
    if let Some(c) = read_config_file(&cfg_path) {
        return c;
    }
    if let Some(c) = read_config_file(&bak_path) {
        let _ = fs::copy(&bak_path, &cfg_path);
        return c;
    }
    Config::default()
}

/// 保存配置：写临时文件 → 旧文件备份为 .bak → 原子替换
#[tauri::command]
fn save_config(
    favorites: Vec<String>,
    projects: Vec<String>,
    dark: bool,
    close_action: Option<String>,
) -> Result<(), String> {
    save_config_to(
        &resolve_root_dir(),
        favorites,
        projects,
        dark,
        close_action,
    )
}

fn save_config_to(
    root: &Path,
    favorites: Vec<String>,
    projects: Vec<String>,
    dark: bool,
    close_action: Option<String>,
) -> Result<(), String> {
    let cfg = Config {
        favorites,
        projects,
        dark,
        close_action,
    };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    let cfg_path = root.join("config.json");
    let bak_path = root.join("config.json.bak");
    let tmp_path = root.join("config.json.tmp");
    fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    if cfg_path.exists() {
        fs::copy(&cfg_path, &bak_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_path, &cfg_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 启动项目（新会话）：新开终端，cd 到项目目录运行 claude。
/// 不经过任何脚本文件；Windows ShellExecuteW 启动 `cmd /k cd /d "dir" && claude`
/// （默认终端委托，整树同一控制台会话）；macOS 临时 sh + Terminal.app。
#[tauri::command]
fn launch_project(path: String) -> Result<(), String> {
    let dir = path.trim().to_string();
    if !Path::new(&dir).is_dir() {
        return Err("项目路径不存在".to_string());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

        // /k 让 claude 退出后窗口保留、便于查看输出
        let cmdline = format!("/k cd /d \"{dir}\" && claude");
        let exe: Vec<u16> = "cmd.exe".encode_utf16().chain(Some(0)).collect();
        let params: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
        let wd: Vec<u16> = dir.encode_utf16().chain(Some(0)).collect();
        let res = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                exe.as_ptr(),
                params.as_ptr(),
                wd.as_ptr(),
                SW_SHOW,
            )
        };
        if res as isize > 32 {
            Ok(())
        } else {
            Err(format!("启动失败（ShellExecute 返回 {}）", res as isize))
        }
    }
    #[cfg(not(windows))]
    {
        // macOS：临时 sh + Terminal.app（无需 osascript 自动化权限）
        let sh = std::env::temp_dir().join(format!(
            "claude-fast-open-{}-{}.sh",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        fs::write(
            &sh,
            format!(
                "#!/bin/bash\ncd {} || exit 1\nexec claude\n",
                sh_quote(&dir)
            ),
        )
        .map_err(|e| format!("写入临时脚本失败：{e}"))?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&sh, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置临时脚本权限失败：{e}"))?;
        Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&sh)
            .spawn()
            .map_err(|e| format!("启动 Terminal 失败：{e}"))?;
        Ok(())
    }
}

// ---------------- 会话继续对话（v2.0.0 阶段二：方向 B resume） ----------------

/// shell 双引号内转义（macOS 命令行拼装用：路径可能含 `"`、`$`、反引号、`\`，
/// 转义后放入 `cd "..."` 不会被展开/截断）。
/// Windows 构建中仅被 macOS 专属代码引用（launch_project 的非 windows 分支）。
#[allow(dead_code)]
fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if c == '\\' || c == '"' || c == '$' || c == '`' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}


/// 校验 resume 的项目路径（防命令注入，两平台共用）：
/// 空路径拒绝；控制字符一律拒绝；路径必须真实存在。
/// Windows：cmd 引号较弱，`%VAR%` `^` `& | < > ( )` 等即使双引号内仍有作用，故显式拒绝。
/// macOS：路径经 sh_quote 转义后放进 `cd "..."`，双引号内 `$ ` \ "` 之外的特殊字符
/// 均为字面量，故不再额外拒字符——否则会误伤含 `(` `)` `'` `\` 等的合法 mac 路径
/// （这类路径在「新建/启动」能通过，resume 却拒绝，造成行为不一致）。
fn validate_resume_path(project_path: &str) -> Result<(), String> {
    let proj = project_path.trim();
    if proj.is_empty() {
        return Err("项目路径不能为空".to_string());
    }
    #[cfg(windows)]
    {
        let forbidden = ['"', '&', '|', '<', '>', '^', '%', '!', '(', ')'];
        for c in forbidden {
            if proj.contains(c) {
                return Err("项目路径包含非法字符".to_string());
            }
        }
    }
    if proj.chars().any(|c| c.is_control()) {
        return Err("项目路径包含非法字符".to_string());
    }
    if !Path::new(proj).is_dir() {
        return Err("项目路径不存在".to_string());
    }
    Ok(())
}

/// 构造 resume 的 cmd 命令行（Windows）：
/// `cmd /k cd /d "<项目路径>" && claude --resume <session-id>`
#[cfg(windows)]
fn build_resume_cmdline(project_path: &str, session_id: &str) -> Result<String, String> {
    validate_resume_path(project_path)?;
    let proj = project_path.trim();
    Ok(format!("/k cd /d \"{proj}\" && claude --resume {session_id}"))
}

/// 构造 resume 的临时脚本内容（macOS）：
/// `cd "/path" && exec claude --resume <id>`，写入临时文件后由 Terminal 运行。
/// 路径经 sh_quote 转义 + validate_resume_path 校验，无注入面。
#[cfg(not(windows))]
fn build_resume_script(project_path: &str, session_id: &str) -> Result<String, String> {
    validate_resume_path(project_path)?;
    let proj = project_path.trim();
    Ok(format!(
        "#!/bin/bash\ncd \"{}\" || exit 1\nexec claude --resume {session_id}\n",
        sh_quote(proj)
    ))
}

/// 继续对话：新开终端窗口，在项目目录运行 `claude --resume <session-id>`
/// （打开 claude 并 resume 到该会话；用户在 claude 里继续对话，退出 claude 即结束）。
/// Windows：ShellExecuteW 新开 cmd；macOS：临时 .sh + Terminal.app 打开。
#[tauri::command]
fn resume_session(file: String, project_path: String) -> Result<(), String> {
    let (_path, session_id) = validate_session_file(&file)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

        let cmdline = build_resume_cmdline(&project_path, &session_id)?;
        let exe: Vec<u16> = "cmd.exe".encode_utf16().chain(Some(0)).collect();
        let params: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
        let dir: Vec<u16> = Path::new(project_path.trim())
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let res = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                exe.as_ptr(),
                params.as_ptr(),
                dir.as_ptr(),
                SW_SHOW,
            )
        };
        if res as isize > 32 {
            Ok(())
        } else {
            Err(format!("启动失败（ShellExecute 返回 {}）", res as isize))
        }
    }
    #[cfg(not(windows))]
    {
        // 临时脚本放系统临时目录（内容幂等，同名覆盖无害；系统自动清理），
        // 用 `open -a Terminal` 打开——不需要 osascript 自动化权限
        let content = build_resume_script(&project_path, &session_id)?;
        let tmp = std::env::temp_dir().join(format!("claude-fast-resume-{session_id}.sh"));
        fs::write(&tmp, content).map_err(|e| format!("写入临时脚本失败：{e}"))?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置临时脚本权限失败：{e}"))?;
        Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&tmp)
            .spawn()
            .map_err(|e| format!("启动 Terminal 失败：{e}"))?;
        Ok(())
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = Command::new("explorer.exe");
    #[cfg(not(windows))]
    let mut cmd = Command::new("open");
    cmd.arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// claude 命令可用性检查：在阻塞线程池中执行，不阻塞主线程/UI。
/// Windows 用 `where`、macOS 用 `command -v`；两者都可能因 PATH 含慢速
/// 目录（网络盘等）卡住，限制 3 秒超时。
#[tauri::command]
async fn check_claude() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("where");
            c.arg("claude").creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", "command -v claude"]);
            c
        };
        let Ok(mut child) = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// 健康检查：并行检查各项目路径是否存在（在阻塞线程池中执行，
/// 不阻塞主线程/UI；某个路径卡住时其余结果不受影响）
#[tauri::command]
async fn check_projects(paths: Vec<String>) -> Vec<bool> {
    let mut tasks = Vec::with_capacity(paths.len());
    for p in paths {
        tasks.push(tauri::async_runtime::spawn_blocking(move || {
            Path::new(&p).is_dir()
        }));
    }
    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        out.push(t.await.unwrap_or(false));
    }
    out
}

/// Claude Code 项目目录（会话 jsonl 所在）：`<数据根>/projects`。
/// 数据根优先级：
/// 1. `CLAUDE_CONFIG_DIR` 环境变量（官方支持的自定义数据目录，设置后
///    配置/会话/日志整体迁移到该目录下，任何平台都生效）；
/// 2. 平台默认——本项目面向 **Claude Code CLI**（终端 `claude` 命令），
///    其规范路径即 `~/.claude`（macOS/Linux 与 Windows 的
///    `%USERPROFILE%\.claude` 对应）：`~/.claude/projects` **优先**；
///    macOS 后备：`~/Library/Application Support/Claude` 是 **Claude
///    Desktop**（GUI 应用）的数据目录，若用户通过 Desktop 内置的 code
///    功能产生过会话，其 projects 在这里——存在且 `~/.claude` 缺失时才用。
fn claude_projects_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = dir.trim();
        if !d.is_empty() {
            return PathBuf::from(d).join("projects");
        }
    }
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        // CLI 规范路径优先（~/.claude 若是指向 Desktop 数据目录的 symlink，
        // 两处本就是同一目录，返回哪个都等价）
        let cli = PathBuf::from(&home).join(".claude").join("projects");
        if cli.is_dir() {
            return cli;
        }
        // 后备：Claude Desktop 内置 code 的会话目录
        let desktop = PathBuf::from(&home).join("Library/Application Support/Claude/projects");
        if desktop.is_dir() {
            return desktop;
        }
        cli
    }
    #[cfg(not(target_os = "macos"))]
    PathBuf::from(home).join(".claude").join("projects")
}

// ---------------- 会话管理（v2.0.0 阶段一） ----------------

/// jsonl 轻量读取的 head/tail 缓冲大小：会话文件可达数 MB 甚至更大，
/// 只读首尾各 64KB 即可提取全部元数据（与 cc-haha 的 LITE_READ_BUF_SIZE 一致）。
const LITE_READ_BUF_SIZE: usize = 64 * 1024;

/// Claude Code 项目目录名的正向 mangle：`:`、`\`、`/`、`_`、`.` 均替换为 `-`
/// （与 Claude Code 官方规则一致，Windows 与 macOS 通用；macOS 路径
/// `/Users/foo/bar` → `-Users-foo-bar`，根 `/` 占开头一个 `-`）：
///   D:\MyWorkspaces\jikehongbao → D--MyWorkspaces-jikehongbao
///   /Users/me/proj              → -Users-me-proj
fn mangle_project_path(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '_' | '.' => '-',
            _ => c,
        })
        .collect()
}

/// UUID v4 格式校验（会话文件名主体）
fn is_valid_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *b != b'-' {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// 剥离 XML 标签块（如 <command-name>/<command-args> 包裹的标题源）。
/// command-args 块**保留块内文本**（它是标题内容本身），其余块整体剥离；
/// 无闭合标签的孤立 `<` 原样保留。对应 cc-haha cleanSessionTitleSource。
fn strip_xml_blocks(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        if let Some(gt) = rest[start..].find('>') {
            let inner = &rest[start + 1..start + gt];
            let name: String = inner
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !name.is_empty() {
                let close = format!("</{}>", name);
                let after = &rest[start + gt + 1..];
                if let Some(end) = after.find(&close) {
                    if name == "command-name" || name == "command-args" {
                        // 保留块内文本（命令名/参数就是标题内容本身，
                        // 如 /init 会话的标题即 "/init"）
                        out.push_str(&after[..end]);
                        out.push(' ');
                    } else {
                        out.push(' ');
                    }
                    rest = &after[end + close.len()..];
                    continue;
                }
            }
        }
        out.push('<');
        rest = &rest[start + 1..];
    }
    out.push_str(rest);
    out
}

/// 摘要/标题清洗：换行/制表符折叠为空格、剥离 XML 标签块、合并空白、截断
fn clean_summary(s: &str) -> String {
    let s = s
        .chars()
        .map(|c| if c == '\r' || c == '\n' || c == '\t' { ' ' } else { c })
        .collect::<String>();
    let s = strip_xml_blocks(&s);
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(150).collect()
}

/// 把一段 jsonl 文本按行解析为 JSON（坏行忽略——head/tail 边界行可能被截断）
fn parse_json_lines(text: &str) -> Vec<serde_json::Value> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .collect()
}

/// 在行列表中取**最后一条**指定 type 行的字符串字段（tail 优先，head 兜底）
fn last_field_of_type(lines: &[serde_json::Value], ty: &str, field: &str) -> Option<String> {
    lines
        .iter()
        .rev()
        .find_map(|v| {
            if v.get("type").and_then(|t| t.as_str()) == Some(ty) {
                v.get(field)
                    .and_then(|f| f.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        })
        .filter(|s| !s.trim().is_empty())
}

/// 提取首个**非命令**的 user 消息文本（字符串 content 或 text 块数组）。
/// 命令消息（/init、/clear 等，content 含 <command-name>/<command-message>）
/// 不算实质对话内容：只有命令没有普通对话的会话无需展示。
fn extract_first_prompt(head: &[serde_json::Value]) -> Option<String> {
    for v in head {
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
            continue;
        }
        let msg = v.get("message")?;
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let text = match msg.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(arr)) => arr
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        // 命令消息跳过（不算实质内容）
        if text.contains("<command-name>") || text.contains("<command-message>") {
            continue;
        }
        // 清洗后为空（如纯 XML 包裹且内容为空的极端情况）→ 跳过该条
        let cleaned = clean_summary(&text);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }
    None
}

/// 从 head/tail 提取会话元数据。None = 该文件不是有效会话（sidechain 等）。
fn session_meta_from_lite(
    head: &str,
    tail: &str,
    session_id: &str,
    last_modified: i64,
) -> Option<SessionInfo> {
    let head_lines = parse_json_lines(head);
    let tail_lines = parse_json_lines(tail);
    // sidechain 会话（并行子会话）不在列表中展示
    if head_lines
        .first()
        .and_then(|v| v.get("isSidechain"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    // 标题优先级：手动重命名 > AI 自动标题 > 首条用户消息
    let custom_title = last_field_of_type(&tail_lines, "custom-title", "customTitle")
        .or_else(|| last_field_of_type(&head_lines, "custom-title", "customTitle"));
    let ai_title = last_field_of_type(&tail_lines, "ai-title", "aiTitle")
        .or_else(|| last_field_of_type(&head_lines, "ai-title", "aiTitle"));
    let first_prompt = extract_first_prompt(&head_lines);
    // 摘要回退链：customTitle > lastPrompt > summary 字段 > 首条消息
    let summary = custom_title
        .clone()
        .or_else(|| last_field_of_type(&tail_lines, "last-prompt", "lastPrompt"))
        .or_else(|| last_field_of_type(&head_lines, "last-prompt", "lastPrompt"))
        .or_else(|| last_field_of_type(&tail_lines, "summary", "summary"))
        .or_else(|| last_field_of_type(&head_lines, "summary", "summary"))
        .or_else(|| first_prompt.clone())
        .map(|s| clean_summary(&s))
        .unwrap_or_default();
    let title = custom_title
        .or(ai_title)
        .or(first_prompt)
        .map(|s| clean_summary(&s))
        .filter(|s| !s.is_empty()) // 清洗后为空视为无标题
        .unwrap_or_else(|| "未命名会话".to_string());
    // 只有元数据（无任何内容）的会话跳过：含只执行了 /init 等命令的会话
    // （命令消息不算实质内容，extract_first_prompt 已跳过）
    if summary.is_empty() && title == "未命名会话" {
        return None;
    }
    Some(SessionInfo {
        session_id: session_id.to_string(),
        title,
        summary,
        last_modified,
        file: String::new(), // 由调用方回填
    })
}

/// 读取会话 jsonl 的 head/tail（单 fd 两次 read），返回原始文本
fn read_head_tail(path: &Path) -> Option<(String, String, i64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let meta = f.metadata().ok()?;
    let size = meta.len();
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u8; LITE_READ_BUF_SIZE];
    let head_n = f.read(&mut buf).ok()?;
    let head = String::from_utf8_lossy(&buf[..head_n]).to_string();
    let mut tail = head.clone();
    if size > LITE_READ_BUF_SIZE as u64 {
        f.seek(SeekFrom::Start(size - LITE_READ_BUF_SIZE as u64))
            .ok()?;
        let tail_n = f.read(&mut buf).ok()?;
        tail = String::from_utf8_lossy(&buf[..tail_n]).to_string();
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some((head, tail, mtime))
}

/// 列出某项目（真实路径）的 Claude Code 会话，按最后修改时间倒序。
/// 在 Tauri 阻塞线程池执行，不冻结 UI。
#[tauri::command]
async fn list_sessions(project_path: String) -> Vec<SessionInfo> {
    let dir = claude_projects_dir().join(mangle_project_path(&project_path));
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".jsonl") {
            continue;
        }
        let session_id = &name[..name.len() - 6];
        if !is_valid_uuid(session_id) {
            continue;
        }
        let Some((head, tail, mtime)) = read_head_tail(&p) else {
            continue;
        };
        if let Some(mut info) = session_meta_from_lite(&head, &tail, session_id, mtime) {
            info.file = p.to_string_lossy().to_string();
            out.push(info);
        }
    }
    out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    out
}

// ---------------- 会话内容读取（v2.0.0 阶段二：方向 A 只读查看） ----------------

/// 从 content 块数组中提取文本（tool_result 的 content 可能是 string 或数组）
fn block_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        serde_json::Value::Array(arr) => {
            let parts: Vec<&str> = arr
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

/// 提取 XML 标签内容（简单字符串匹配，不处理嵌套同名标签）
fn extract_xml_tag(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = s.find(&open)? + open.len();
    let rest = &s[start..];
    let end = rest.find(&close)?;
    let t = rest[..end].trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 解析一条消息的 content 为内容块列表。命令消息（<command-name> 等）返回空。
fn parse_content_blocks(content: Option<&serde_json::Value>, role: &str) -> Vec<ContentBlock> {
    let mut out = Vec::new();
    match content {
        Some(serde_json::Value::String(s)) => {
            // 命令消息（/init 等）不算实质对话内容
            if s.contains("<command-name>") || s.contains("<command-message>") {
                return out;
            }
            // 后台任务完成通知（<task-notification> 包裹，Claude Code 以 user 字符串
            // 消息写入）→ 按工具结果展示，不当作普通用户输入。
            // 内容字段：<result> 结果正文（Markdown）> <summary> 一行摘要 > 整块文本；
            // 完整输出在 <output-file> 指向的临时文件里（不跨进程读取）。
            if s.contains("<task-notification>") {
                let text = extract_xml_tag(s, "result")
                    .or_else(|| extract_xml_tag(s, "summary"))
                    .or_else(|| extract_xml_tag(s, "task-notification"));
                if let Some(t) = text {
                    out.push(ContentBlock {
                        kind: "tool_result".to_string(),
                        text: Some(t),
                        name: None,
                        input: None,
                        tool_use_id: extract_xml_tag(s, "tool-use-id"),
                        is_error: None,
                    });
                }
                return out;
            }
            let t = s.trim();
            if !t.is_empty() {
                out.push(ContentBlock {
                    kind: "text".to_string(),
                    text: Some(t.to_string()),
                    name: None,
                    input: None,
                    tool_use_id: None,
                    is_error: None,
                });
            }
        }
        Some(serde_json::Value::Array(arr)) => {
            for b in arr {
                let Some(ty) = b.get("type").and_then(|t| t.as_str()) else {
                    continue;
                };
                match ty {
                    "text" | "thinking" => {
                        // text 块字段是 text；thinking 块字段是 thinking；tool_result 才是 content
                        let raw = b
                            .get("text")
                            .or_else(|| b.get("thinking"))
                            .or_else(|| b.get("content"));
                        if let Some(t) = raw.and_then(block_text) {
                            out.push(ContentBlock {
                                kind: ty.to_string(),
                                text: Some(t),
                                name: None,
                                input: None,
                                tool_use_id: None,
                                is_error: None,
                            });
                        }
                    }
                    "tool_use" => {
                        let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if !name.is_empty() {
                            out.push(ContentBlock {
                                kind: "tool_use".to_string(),
                                text: None,
                                name: Some(name.to_string()),
                                input: b.get("input").cloned(),
                                // tool_use 块的 id（tool_result 的 tool_use_id 关联它）
                                tool_use_id: b
                                    .get("id")
                                    .and_then(|i| i.as_str())
                                    .map(String::from),
                                is_error: None,
                            });
                        }
                    }
                    "tool_result" => {
                        let text = b.get("content").and_then(block_text);
                        if let Some(t) = text {
                            out.push(ContentBlock {
                                kind: "tool_result".to_string(),
                                text: Some(t),
                                name: None,
                                input: None,
                                tool_use_id: b.get("tool_use_id").and_then(|i| i.as_str()).map(String::from),
                                is_error: b.get("is_error").and_then(|e| e.as_bool()),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {
            // assistant 的 content 可能是字符串（旧格式），上面 String 分支已处理；
            // 其它类型（如直接文本对象）忽略
            let _ = role;
        }
    }
    out
}

/// 解析 jsonl 全文为会话消息列表（核心逻辑，供 command 与测试复用）：
/// 只提取 user/assistant 消息，过滤元数据行 / sidechain / isMeta / 命令消息。
fn parse_session_messages(content: &str) -> Vec<SessionMessage> {
    let mut messages = Vec::new();
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let Some(ty) = v.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        if ty != "user" && ty != "assistant" {
            continue;
        }
        // sidechain / isMeta 消息跳过（与列表过滤语义一致）
        if v.get("isSidechain").and_then(|s| s.as_bool()).unwrap_or(false) {
            continue;
        }
        if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        let Some(role) = msg.get("role").and_then(|r| r.as_str()) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let blocks = parse_content_blocks(msg.get("content"), role);
        if blocks.is_empty() {
            continue;
        }
        messages.push(SessionMessage {
            kind: role.to_string(),
            blocks,
            timestamp: v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string()),
            model: msg.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()),
        });
    }
    messages
}

/// 向上分页切片：默认返回**最后** limit 条（打开会话时焦点在最新）；
/// 传 offset 返回从该位置起的 limit 条（加载更早时传 offset - limit）。
fn slice_messages(
    all: Vec<SessionMessage>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> SessionMessages {
    let total = all.len();
    let limit = limit.unwrap_or(MAX_SESSION_MESSAGES).clamp(1, 2000);
    let start = match offset {
        Some(o) => o.min(total),
        None => total.saturating_sub(limit),
    };
    let end = (start + limit).min(total);
    let messages = if start < end {
        all[start..end].to_vec()
    } else {
        Vec::new()
    };
    SessionMessages {
        messages,
        has_more: start > 0,
        total,
        offset: start,
    }
}

/// 读取会话内容（只读查看用，向上分页）。在 Tauri 线程池执行，不阻塞 UI。
#[tauri::command]
async fn get_session_messages(
    file: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<SessionMessages, String> {
    let (path, _) = validate_session_file(&file)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    Ok(slice_messages(parse_session_messages(&content), offset, limit))
}

/// 向会话 jsonl 追加 custom-title 行（核心逻辑，供 command 与测试复用）
fn append_custom_title(path: &Path, session_id: &str, title: &str) -> Result<(), String> {
    use std::io::Write;
    let line = serde_json::json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": session_id,
    })
    .to_string();
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| format!("打开会话文件失败：{e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("写入会话文件失败：{e}"))
}

/// 校验会话文件路径：必须位于 Claude Code 项目目录下、名称为 <uuid>.jsonl。
/// 返回 (path, session_id)。
fn validate_session_file(file: &str) -> Result<(PathBuf, String), String> {
    let path = PathBuf::from(file);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("非法会话文件名")?;
    if !name.ends_with(".jsonl") {
        return Err("非法会话文件".to_string());
    }
    let session_id = name[..name.len() - 6].to_string();
    if !is_valid_uuid(&session_id) {
        return Err("非法会话文件".to_string());
    }
    if !path.starts_with(&claude_projects_dir()) {
        return Err("会话文件不在 Claude Code 目录中".to_string());
    }
    Ok((path, session_id))
}

/// 重命名会话：向 jsonl **追加**一行 custom-title（Claude Code CLI 的 /rename
/// 同机制，改完后官方 CLI 与第三方工具均识别新标题）。不修改/覆盖原文件。
#[tauri::command]
fn rename_session(file: String, new_title: String) -> Result<(), String> {
    let (path, session_id) = validate_session_file(&file)?;
    // 标题清洗：去控制字符、trim、限长
    let title: String = new_title
        .chars()
        .map(|c| if c == '\r' || c == '\n' || c == '\t' { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let title: String = title.chars().take(200).collect();
    append_custom_title(&path, &session_id, &title)
}

/// 从 Unix epoch 秒计算公历日期（civil_from_days 算法），返回 (年, 月, 日)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC 时间戳目录名：YYYYMMDD_HHMMSS（备份/回收站目录用，与全局
/// 「破坏性操作先备份」铁律的 cache_backup_20260807_1300 风格一致）
fn utc_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    format!("{y:04}{m:02}{d:02}_{h:02}{mi:02}{s:02}")
}

/// 删除会话文件的核心逻辑：**先备份到 trash_root/<时间戳>/<项目>/ 再删除**
/// （数据安全铁律：破坏性操作先备份；备份即回收站，可恢复）。返回备份文件路径。
fn delete_session_file(path: &Path, trash_root: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("非法会话文件名")?;
    // 保留原项目 mangled 目录名，恢复时直接放回 projects/<mangled>/
    let mangled = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    let backup_dir = trash_root
        .join(utc_timestamp())
        .join(mangled);
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    let backup = backup_dir.join(name);
    // 同卷 rename 原子优先；跨卷（便携模式 exe 在别的盘）回退 copy + remove
    if fs::rename(path, &backup).is_err() {
        fs::copy(path, &backup).map_err(|e| format!("备份会话失败：{e}"))?;
        fs::remove_file(path).map_err(|e| format!("删除会话失败：{e}"))?;
    }
    Ok(backup)
}

/// 删除会话：先移入回收站（trash/）再删除原文件。返回备份路径（前端提示可恢复）。
#[tauri::command]
fn delete_session(file: String) -> Result<String, String> {
    let (path, _) = validate_session_file(&file)?;
    let backup = delete_session_file(&path, &trash_root())?;
    Ok(backup.to_string_lossy().to_string())
}

/// 数据根下回收站目录：<root>/trash/sessions
fn trash_root() -> PathBuf {
    resolve_root_dir().join("trash").join("sessions")
}

/// 回收站中的一条会话备份
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashedSession {
    /// 备份文件绝对路径（恢复/永久删除时回传）
    file: String,
    /// 会话 ID
    session_id: String,
    /// 标题（复用会话元数据解析：customTitle > aiTitle > 首条消息）
    title: String,
    /// 删除时间（备份目录名 YYYYMMDD_HHMMSS）
    deleted_at: String,
    /// 原项目 mangled 目录名
    project_dir: String,
    /// 原项目路径（unmangle 反向解析，找到真实存在者；找不到则为空）
    project_path: Option<String>,
}

/// 列出回收站中的全部会话备份（按删除时间倒序）。trash_root 可注入（测试用临时目录）。
fn list_trashed_sessions_in(trash_root: &Path) -> Vec<TrashedSession> {
    let mut out = Vec::new();
    let Ok(batches) = fs::read_dir(trash_root) else {
        return out;
    };
    for batch in batches.flatten() {
        let ts = batch.file_name().to_string_lossy().to_string();
        let Ok(projects) = fs::read_dir(batch.path()) else {
            continue;
        };
        for proj in projects.flatten() {
            let project_dir = proj.file_name().to_string_lossy().to_string();
            let Ok(files) = fs::read_dir(proj.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                if !p.is_file() {
                    continue;
                }
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let session_id = name[..name.len() - 6].to_string();
                if !is_valid_uuid(&session_id) {
                    continue;
                }
                // 复用会话元数据解析提取标题
                let title = match read_head_tail(&p) {
                    Some((head, tail, _)) => session_meta_from_lite(&head, &tail, &session_id, 0)
                        .map(|i| i.title)
                        .unwrap_or_else(|| "未命名会话".to_string()),
                    None => "未命名会话".to_string(),
                };
                // 反向解析原项目路径（取真实存在者）
                let project_path = unmangle_candidates(&project_dir)
                    .into_iter()
                    .find(|c| Path::new(c).exists());
                out.push(TrashedSession {
                    file: p.to_string_lossy().to_string(),
                    session_id,
                    title,
                    deleted_at: ts.clone(),
                    project_dir: project_dir.clone(),
                    project_path,
                });
            }
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    out
}

/// 列出回收站中的全部会话备份（按删除时间倒序）
#[tauri::command]
fn list_trashed_sessions() -> Vec<TrashedSession> {
    list_trashed_sessions_in(&trash_root())
}

/// 校验回收站备份文件路径：必须位于数据根 trash/sessions/ 下、名称为 <uuid>.jsonl。
/// 返回 (path, session_id, mangled 项目目录名)。
fn validate_trash_file(file: &str) -> Result<(PathBuf, String, String), String> {
    let path = PathBuf::from(file);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("非法备份文件")?;
    if !name.ends_with(".jsonl") {
        return Err("非法备份文件".to_string());
    }
    let session_id = name[..name.len() - 6].to_string();
    if !is_valid_uuid(&session_id) {
        return Err("非法备份文件".to_string());
    }
    let trash_root = resolve_root_dir().join("trash").join("sessions");
    if !path.starts_with(&trash_root) {
        return Err("备份文件不在回收站中".to_string());
    }
    // 备份路径结构：trash/sessions/<ts>/<mangled>/<uuid>.jsonl
    let mangled = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .ok_or("非法备份文件")?
        .to_string();
    Ok((path, session_id, mangled))
}

/// 恢复会话的核心逻辑：移回 projects_root/<mangled>/。返回恢复后的路径。
fn restore_trashed_file(path: &Path, projects_root: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or("非法备份文件")?;
    // 备份路径结构：trash/sessions/<ts>/<mangled>/<uuid>.jsonl
    let mangled = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .ok_or("非法备份文件")?;
    let target_dir = projects_root.join(mangled);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建项目目录失败：{e}"))?;
    let target = target_dir.join(name);
    // 目标已存在（会话已恢复过）→ 拒绝，避免覆盖
    if target.exists() {
        return Err("目标位置已存在同名会话，请先确认是否已恢复过".to_string());
    }
    if fs::rename(path, &target).is_err() {
        fs::copy(path, &target).map_err(|e| format!("恢复会话失败：{e}"))?;
        fs::remove_file(path).map_err(|e| format!("清理备份失败：{e}"))?;
    }
    Ok(target)
}

/// 从回收站恢复会话：移回 ~/.claude/projects/<mangled>/，返回恢复后的路径。
#[tauri::command]
fn restore_session(file: String) -> Result<String, String> {
    let (path, _session_id, _mangled) = validate_trash_file(&file)?;
    let target = restore_trashed_file(&path, &claude_projects_dir())?;
    Ok(target.to_string_lossy().to_string())
}

/// 从回收站永久删除备份（不可恢复）。调用方必须已二次确认。
#[tauri::command]
fn purge_session(file: String) -> Result<(), String> {
    let (path, _, _) = validate_trash_file(&file)?;
    fs::remove_file(&path).map_err(|e| format!("删除备份失败：{e}"))
}

/// 清空回收站的核心逻辑：彻底删除 trash/sessions 下的全部会话备份（释放磁盘空间，不可恢复）。
/// 调用方必须已二次确认。返回被删除的会话数。
fn purge_trash_in(trash_root: &Path) -> Result<usize, String> {
    let count = list_trashed_sessions_in(trash_root).len();
    if count == 0 {
        return Ok(0);
    }
    for entry in fs::read_dir(trash_root).map_err(|e| format!("读取回收站失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取回收站失败：{e}"))?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("删除备份目录失败：{e}"))?;
        } else {
            fs::remove_file(&path).map_err(|e| format!("删除备份失败：{e}"))?;
        }
    }
    Ok(count)
}

/// 清空回收站（彻底删除全部会话备份，释放磁盘空间，不可恢复）。调用方必须已二次确认。
#[tauri::command]
fn purge_trash() -> Result<usize, String> {
    purge_trash_in(&trash_root())
}

/// 通用反向解析：把 segments 按分隔符候选集枚举出全部路径。
/// seps[0] 是主分隔符（Windows `\` / macOS `/`），seps[1..] 是可能的
/// 合并字符（`-` `_` `.`）；「层级最多（全用主分隔符）」的候选排最前，
/// 调用方用 exists 验证取真实存在者。段过多（>5）时降级避免组合爆炸。
fn enum_segment_paths(
    segments: &[&str],
    seps: &[char],
    build: impl Fn(&[char]) -> String,
) -> Vec<String> {
    let gaps = segments.len() - 1; // 间隙数：每个间隙可能是主分隔符或合并字符
    if gaps == 0 {
        return vec![build(&[])];
    }
    if gaps > 5 {
        // 段过多：仅生成「全主分隔符」+「单个间隙合并」候选，避免组合爆炸
        let mut out = vec![build(&vec![seps[0]; gaps])];
        for i in 0..gaps {
            for c in &seps[1..] {
                let mut s = vec![seps[0]; gaps];
                s[i] = *c;
                out.push(build(&s));
            }
        }
        return out;
    }
    // 按合并间隙数 m 从少到多枚举（m 少 = 主分隔符多 = 层级多，优先）；
    // 选中间隙再遍历合并字符（- _ .），其余间隙当主分隔符
    let mut out = Vec::new();
    for m in 0..=gaps {
        let combos = combinations(gaps, m);
        for combo in combos {
            // 对选中的 m 个间隙做合并字符笛卡尔积
            let mut cart: Vec<Vec<char>> = vec![Vec::new()];
            for _ in 0..m {
                let mut next = Vec::new();
                for p in &cart {
                    for c in &seps[1..] {
                        let mut q = p.clone();
                        q.push(*c);
                        next.push(q);
                    }
                }
                cart = next;
            }
            for chars in cart {
                let mut seps_used = vec![seps[0]; gaps];
                for (pos, c) in combo.iter().zip(chars.iter()) {
                    seps_used[*pos] = *c;
                }
                out.push(build(&seps_used));
            }
        }
    }
    out
}

/// Claude Code 项目目录名的反向解析（Windows 版）。mangled 规则（实测）：
/// `:`、`\`、`_`、`.` 均替换为 `-`，`-` 保留，例如：
///   D:\MyWorkspaces\jikehongbao     → D--MyWorkspaces-jikehongbao
///   D:\WeChatProjects\tms_app       → D--WeChatProjects-tms-app
///   D:\MyWorkspaces\cms\DoraCMS-3.1 → D--MyWorkspaces-cms-DoraCMS-3-1
/// 反向存在歧义（每个 `-` 可能是 `\`/`_`/`.`/`-`），因此返回**按优先级排序的候选
/// 路径列表**：层级最多（`-` 尽量当分隔符）的解释优先，调用方用 exists 验证取真实存在者。
#[cfg(windows)]
fn unmangle_candidates(name: &str) -> Vec<String> {
    let b = name.as_bytes();
    // 格式：盘符字母 + "--"（':' 与根目录 '\' 各占一个 '-'）
    if b.len() < 3 || !(b[0] as char).is_ascii_alphabetic() || b[1] != b'-' || b[2] != b'-' {
        return Vec::new();
    }
    let drive = b[0] as char;
    let segments: Vec<&str> = name[3..].split('-').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Vec::new();
    }
    let build = |seps: &[char]| -> String {
        let mut s = format!("{}:\\{}", drive, segments[0]);
        for (i, sep) in seps.iter().enumerate() {
            s.push(*sep);
            s.push_str(segments[i + 1]);
        }
        s
    };
    enum_segment_paths(&segments, &['\\', '-', '_', '.'], build)
}

/// Claude Code 项目目录名的反向解析（macOS 版）。macOS 上路径
/// `/Users/foo/bar` 被 mangle 成 `-Users-foo-bar`（`/` 与 `:`、`_`、`.`、`\`
/// 均替换为 `-`，根目录 `/` 占开头一个 `-`）。反向枚举候选，层级最多者优先。
#[cfg(not(windows))]
fn unmangle_candidates(name: &str) -> Vec<String> {
    if !name.starts_with('-') {
        return Vec::new();
    }
    let segments: Vec<&str> = name[1..].split('-').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Vec::new();
    }
    let build = |seps: &[char]| -> String {
        let mut s = format!("/{}", segments[0]);
        for (i, sep) in seps.iter().enumerate() {
            s.push(*sep);
            s.push_str(segments[i + 1]);
        }
        s
    };
    enum_segment_paths(&segments, &['/', '-', '_', '.'], build)
}

/// n 选 k 的下标组合（升序）
fn combinations(n: usize, k: usize) -> Vec<Vec<usize>> {
    fn rec(n: usize, k: usize, start: usize, cur: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if cur.len() == k {
            out.push(cur.clone());
            return;
        }
        for i in start..n {
            cur.push(i);
            rec(n, k, i + 1, cur, out);
            cur.pop();
        }
    }
    let mut out = Vec::new();
    rec(n, k, 0, &mut Vec::new(), &mut out);
    out
}

/// 批量扫描核心（同步）：扫描 Claude Code 项目目录（~/.claude/projects），
/// 把每个 mangled 目录名反向解析出真实路径；真实路径已不存在的项目
/// 标记 missing=true。list_projects_impl 与批量添加共用。
fn scan_claude_projects_blocking(projects_dir: &Path) -> Vec<ClaudeProject> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(projects_dir) else {
        return out;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !e.path().is_dir() {
            continue;
        }
        let cands = unmangle_candidates(&name);
        let existing = cands.iter().find(|c| Path::new(c).is_dir());
        let path = existing.cloned().unwrap_or_else(|| {
            cands.first().cloned().unwrap_or_default()
        });
        if path.is_empty() {
            continue;
        }
        let leaf = Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        out.push(ClaudeProject {
            name: leaf,
            missing: existing.is_none(),
            path,
        });
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    out
}

/// 批量添加：扫描 Claude Code 项目目录（~/.claude/projects）供批量加入清单。
/// 在阻塞线程池中执行，避免冻结 UI。
#[tauri::command]
async fn scan_claude_projects() -> Vec<ClaudeProject> {
    tauri::async_runtime::spawn_blocking(|| {
        scan_claude_projects_blocking(&claude_projects_dir())
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn get_claude_projects_dir() -> String {
    claude_projects_dir().to_string_lossy().to_string()
}

/// 返回数据根信息：path = 数据根目录；installMode = true 表示处于安装模式
/// （数据根在 %APPDATA% 而非 exe 所在目录）
#[tauri::command]
fn get_data_root() -> DataRootInfo {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let root = resolve_root_dir();
    DataRootInfo {
        path: root.to_string_lossy().to_string(),
        install_mode: root != exe_dir,
    }
}

// ---------------- 入口 ----------------

// ---------------- 单元测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "claude-fast-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn parse_cd_quoted() {
        assert_eq!(
            parse_cd_path("@echo off\r\nchcp 65001 >nul\r\ncd /d \"D:\\MyWorkspaces\\yaotu\\tdc\""),
            Some("D:\\MyWorkspaces\\yaotu\\tdc".to_string())
        );
    }

    #[test]
    fn parse_cd_unquoted() {
        assert_eq!(
            parse_cd_path("cd /d C:\\proj"),
            Some("C:\\proj".to_string())
        );
    }

    #[test]
    fn parse_cd_missing() {
        assert_eq!(parse_cd_path("@echo off\r\necho hi"), None);
    }

    #[test]
    fn parse_cd_case_insensitive() {
        assert_eq!(
            parse_cd_path("CD /D \"X:\\y z\""),
            Some("X:\\y z".to_string())
        );
    }

    #[test]
    fn parse_cd_sh_quoted() {
        // macOS 脚本：cd "/path"（含 || exit 1 后缀）
        assert_eq!(
            parse_cd_path("#!/bin/bash\ncd \"/Users/me/My Workspaces/proj\" || exit 1\nexec claude"),
            Some("/Users/me/My Workspaces/proj".to_string())
        );
    }

    #[test]
    fn parse_cd_sh_unquoted() {
        assert_eq!(
            parse_cd_path("cd /Users/me/proj"),
            Some("/Users/me/proj".to_string())
        );
    }

    #[test]
    fn strip_bom_works() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"{\"a\":1}");
        let c: serde_json::Value = serde_json::from_slice(strip_bom(&b)).unwrap();
        assert_eq!(c["a"], 1);
    }

    #[test]
    fn sh_quote_escapes_shell_metachars() {
        // 双引号内转义：\ " $ ` 前加反斜杠，其余原样
        assert_eq!(sh_quote(r#"a"b$c`d\e"#), r#"a\"b\$c\`d\\e"#);
        assert_eq!(sh_quote("/Users/me/proj"), "/Users/me/proj");
        assert_eq!(sh_quote("普通 中文 路径"), "普通 中文 路径");
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_drive_root() {
        assert_eq!(unmangle_candidates("D--baitai"), vec!["D:\\baitai"]);
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_plain_path() {
        let c = unmangle_candidates("D--MyWorkspaces-jikehongbao");
        assert_eq!(c[0], "D:\\MyWorkspaces\\jikehongbao");
        // 歧义候选也保留（'-' 可能是 _ . - 或 \ 分隔）
        assert_eq!(c.len(), 4);
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_underscore_and_dash_candidates() {
        let c = unmangle_candidates("D--WeChatProjects-tms-app");
        // 优先级：全分隔 > 单间隙合并 > 双间隙合并（- _ . 顺序）
        assert_eq!(c[0], "D:\\WeChatProjects\\tms\\app");
        assert!(c.contains(&"D:\\WeChatProjects\\tms_app".to_string()));
        assert!(c.contains(&"D:\\WeChatProjects\\tms-app".to_string()));
        assert!(c.contains(&"D:\\WeChatProjects-tms_app".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_dot_and_dash_candidates() {
        let c = unmangle_candidates("D--MyWorkspaces-cms-DoraCMS-3-1");
        assert_eq!(c[0], "D:\\MyWorkspaces\\cms\\DoraCMS\\3\\1");
        // 实测：DoraCMS-3.1 被 mangle 成 DoraCMS-3-1（'.' → '-'）
        assert!(c.contains(&"D:\\MyWorkspaces\\cms\\DoraCMS-3.1".to_string()));
        assert!(c.contains(&"D:\\MyWorkspaces\\cms\\DoraCMS-3-1".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_rejects_bad_names() {
        assert!(unmangle_candidates("").is_empty());
        assert!(unmangle_candidates("no-dashes").is_empty());
        assert!(unmangle_candidates("-X--abc").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn unmangle_long_path_limits_candidates() {
        // 段过多时降级为有限候选（不爆炸）
        let c = unmangle_candidates("D--a-b-c-d-e-f-g-h");
        assert!(!c.is_empty());
        assert!(c.len() <= 1 + 7 * 3);
        assert_eq!(c[0], "D:\\a\\b\\c\\d\\e\\f\\g\\h");
    }

    #[cfg(not(windows))]
    #[test]
    fn unmangle_macos_root_path() {
        // /Users/foo/bar → mangle → -Users-foo-bar；反向首候选为全 '/' 分隔（层级最多）
        let c = unmangle_candidates("-Users-foo-bar");
        assert_eq!(c[0], "/Users/foo/bar");
        assert!(c.contains(&"/Users-foo/bar".to_string())); // 间隙合并候选之一
    }

    #[cfg(not(windows))]
    #[test]
    fn unmangle_macos_underscore_and_dash_candidates() {
        let c = unmangle_candidates("-Users-me-tms-app");
        // 优先级：全分隔 > 单间隙合并（- _ . 顺序）
        assert_eq!(c[0], "/Users/me/tms/app");
        assert!(c.contains(&"/Users/me/tms_app".to_string()));
        assert!(c.contains(&"/Users/me/tms-app".to_string()));
    }

    #[cfg(not(windows))]
    #[test]
    fn unmangle_macos_rejects_bad_names() {
        // mac 的 mangled 名必以 '-' 开头（根 / 占开头一个 '-'）
        assert!(unmangle_candidates("").is_empty());
        assert!(unmangle_candidates("no-leading-dash").is_empty());
        assert!(unmangle_candidates("D--baitai").is_empty()); // Windows 格式，mac 不认
    }

    #[cfg(not(windows))]
    #[test]
    fn unmangle_macos_long_path_limits_candidates() {
        // 段过多时降级为有限候选（不爆炸）
        let c = unmangle_candidates("-a-b-c-d-e-f-g-h");
        assert!(!c.is_empty());
        assert!(c.len() <= 1 + 7 * 3);
        assert_eq!(c[0], "/a/b/c/d/e/f/g/h");
    }

    #[test]
    fn enum_segment_paths_macos_style() {
        // macOS 风格枚举（主分隔符 /，合并候选 - _ .）：
        // -Users-me-proj → 层级最多候选 /Users/me/proj 排最前
        let segments: Vec<&str> = "Users-me-proj".split('-').collect();
        let build = |seps: &[char]| -> String {
            let mut s = format!("/{}", segments[0]);
            for (i, sep) in seps.iter().enumerate() {
                s.push(*sep);
                s.push_str(segments[i + 1]);
            }
            s
        };
        let c = enum_segment_paths(&segments, &['/', '-', '_', '.'], build);
        assert_eq!(c[0], "/Users/me/proj");
        // 歧义候选也在（'-' 可能是 _ . -）
        assert!(c.contains(&"/Users/me-proj".to_string()));
        assert!(c.contains(&"/Users_me/proj".to_string()));
        assert!(c.contains(&"/Users-me/proj".to_string()));

        // 单段：无歧义
        let seg1: Vec<&str> = vec!["baitai"];
        let c1 = enum_segment_paths(&seg1, &['/', '-', '_', '.'], |_| {
            format!("/{}", seg1[0])
        });
        assert_eq!(c1, vec!["/baitai"]);
    }

    #[test]
    fn resolve_root_finds_project() {
        let root = resolve_root_dir();
        // 新布局：config.json + scripts/ 子目录
        assert!(root.join("config.json").is_file());
        assert!(root.join(SCRIPTS_DIR).is_dir());
        // 兼容旧标记
        assert!(is_root_dir(&root));
    }

    #[test]
    fn is_root_dir_detects_layouts() {
        let root = temp_root("root");
        // 新布局
        fs::write(root.join("config.json"), "{}").unwrap();
        fs::create_dir_all(root.join(SCRIPTS_DIR)).unwrap();
        assert!(is_root_dir(&root));
        // 只有 config.json 没有 scripts 目录 → 不是根
        fs::remove_dir_all(root.join(SCRIPTS_DIR)).unwrap();
        assert!(!is_root_dir(&root));
        // 旧布局：claude-claude-fast.bat
        fs::write(root.join("claude-claude-fast.bat"), "").unwrap();
        assert!(is_root_dir(&root));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn app_data_root_points_to_claude_fast() {
        let p = app_data_root();
        assert!(!p.as_os_str().is_empty());
        let s = p.to_string_lossy().to_lowercase();
        assert!(s.contains("claude-fast"));
    }

    #[test]
    fn claude_projects_dir_honors_config_env() {
        // CLAUDE_CONFIG_DIR（官方支持的自定义数据目录）优先于平台默认
        let fake = temp_root("cc-config-dir");
        std::env::set_var("CLAUDE_CONFIG_DIR", &fake);
        let p = claude_projects_dir();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(p, fake.join("projects"));
        fs::remove_dir_all(&fake).unwrap();
    }

    // ---------------- 会话管理（v2.0.0 阶段一） ----------------

    #[test]
    fn mangle_project_path_works() {
        assert_eq!(
            mangle_project_path("D:\\MyWorkspaces\\jikehongbao"),
            "D--MyWorkspaces-jikehongbao"
        );
        assert_eq!(
            mangle_project_path("D:\\WeChatProjects\\tms_app"),
            "D--WeChatProjects-tms-app"
        );
        assert_eq!(
            mangle_project_path("D:\\MyWorkspaces\\cms\\DoraCMS-3.1"),
            "D--MyWorkspaces-cms-DoraCMS-3-1"
        );
        // 冒号与根斜杠各占一个 `-`
        assert_eq!(mangle_project_path("D:\\baitai"), "D--baitai");
        // macOS 路径：/ 也替换为 -，根 / 占开头一个 -
        assert_eq!(
            mangle_project_path("/Users/me/proj"),
            "-Users-me-proj"
        );
        assert_eq!(
            mangle_project_path("/Users/me/My Workspaces/my_app"),
            "-Users-me-My Workspaces-my-app"
        );
    }

    #[test]
    fn is_valid_uuid_checks_format() {
        assert!(is_valid_uuid("5426d6d0-c08f-43bd-94df-4d6d99e5c699"));
        assert!(!is_valid_uuid("5426d6d0-c08f-43bd-94df"));
        assert!(!is_valid_uuid("not-a-uuid"));
        assert!(!is_valid_uuid("5426d6d0c08f43bd94df4d6d99e5c699"));
    }

    #[test]
    fn strip_xml_blocks_removes_command_wrappers() {
        // command-name / command-args 内容保留为标题（官方 /resume 列表同款语义）
        assert_eq!(
            strip_xml_blocks("<command-name>/flow</command-name>"),
            "/flow "
        );
        assert_eq!(
            strip_xml_blocks(
                "<command-name>/init</command-name><command-args>测试</command-args>"
            ),
            "/init 测试 "
        );
        // 无闭合标签的孤立尖括号保留
        assert_eq!(strip_xml_blocks("a < b > c"), "a < b > c");
    }

    #[test]
    fn clean_summary_folds_whitespace() {
        assert_eq!(clean_summary("  多行\n文本\t折叠  "), "多行 文本 折叠");
        let long = "x".repeat(300);
        assert_eq!(clean_summary(&long).chars().count(), 150);
    }

    /// 构造一段含标题/消息的 jsonl head 文本
    fn sample_head() -> String {
        format!(
            "{}\n{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"5426d6d0-c08f-43bd-94df-4d6d99e5c699"}"#,
            r#"{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"修复登录页面的 bug"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
            r#"{"type":"ai-title","aiTitle":"修复登录页面","sessionId":"5426d6d0-c08f-43bd-94df-4d6d99e5c699"}"#,
        )
    }

    #[test]
    fn session_meta_uses_custom_title_first() {
        let tail = r#"{"type":"custom-title","customTitle":"手动改的名字","sessionId":"5426d6d0-c08f-43bd-94df-4d6d99e5c699"}"#;
        let info = session_meta_from_lite(
            &sample_head(),
            tail,
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            1000,
        )
        .unwrap();
        assert_eq!(info.title, "手动改的名字");
        assert_eq!(info.summary, "手动改的名字");
        assert_eq!(info.last_modified, 1000);
    }

    #[test]
    fn session_meta_falls_back_to_ai_title() {
        let info = session_meta_from_lite(
            &sample_head(),
            "",
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            1000,
        )
        .unwrap();
        assert_eq!(info.title, "修复登录页面");
        assert_eq!(info.summary, "修复登录页面的 bug");
    }

    #[test]
    fn session_meta_falls_back_to_first_prompt() {
        // 命令后跟了普通对话的会话：标题用第一条普通消息（命令消息被跳过）
        let head = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name><command-args>新建项目</command-args>"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":"帮我看一下这个项目的结构"},"timestamp":"2026-08-12T06:48:00.000Z"}"#,
        );
        let info = session_meta_from_lite(&head, "", "x", 0).unwrap();
        assert_eq!(info.title, "帮我看一下这个项目的结构");
        assert_eq!(info.summary, "帮我看一下这个项目的结构");
    }

    #[test]
    fn session_meta_only_init_command_is_hidden() {
        // 只执行了 /init 的会话：无任何实质对话内容 → 不进入列表
        let head = format!(
            "{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-message>init</command-message>\n<command-name>/init</command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        assert!(session_meta_from_lite(&head, "", "x", 0).is_none());
        // 即使命令带参数也一样隐藏
        let head2 = format!(
            "{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        assert!(session_meta_from_lite(&head2, "", "x", 0).is_none());
    }

    #[test]
    fn session_meta_blank_command_content_is_untitled() {
        // 命令内容清洗后为空的极端情况：无任何可显示内容 → 会话被过滤（不进列表）
        let head = format!(
            "{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name></command-name>"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        assert!(session_meta_from_lite(&head, "", "x", 0).is_none());
    }

    #[test]
    fn session_meta_extracts_text_blocks_from_array_content() {
        let head = format!(
            "{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"第一段"},{"type":"tool_use","name":"x"}]},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
        );
        let info = session_meta_from_lite(&head, "", "x", 0).unwrap();
        assert_eq!(info.title, "第一段");
    }

    #[test]
    fn session_meta_skips_sidechain() {
        let head = r#"{"parentUuid":null,"isSidechain":true,"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-08-12T06:47:46.519Z"}"#;
        assert!(session_meta_from_lite(head, "", "x", 0).is_none());
    }

    #[test]
    fn session_meta_skips_metadata_only() {
        let head = r#"{"type":"mode","mode":"normal","sessionId":"x"}"#;
        assert!(session_meta_from_lite(head, "", "x", 0).is_none());
    }

    #[test]
    fn session_meta_tail_wins_over_head() {
        // 同一个字段 head 与 tail 都有时，取 tail 的最后一条
        let head = sample_head();
        let tail = r#"{"type":"ai-title","aiTitle":"tail 里的新标题","sessionId":"5426d6d0-c08f-43bd-94df-4d6d99e5c699"}"#;
        let info = session_meta_from_lite(
            &head,
            tail,
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            0,
        )
        .unwrap();
        assert_eq!(info.title, "tail 里的新标题");
    }

    #[test]
    fn read_head_tail_handles_large_and_small_files() {
        let dir = temp_root("sess-headtail");
        // 小文件：head == tail
        let small = dir.join("a.jsonl");
        fs::write(&small, sample_head()).unwrap();
        let (head, tail, mtime) = read_head_tail(&small).unwrap();
        assert_eq!(head, tail);
        assert!(mtime > 0);
        // 大文件：tail 是文件末尾 64KB
        let big = dir.join("b.jsonl");
        let mut content = sample_head();
        let filler = "x".repeat(200_000);
        content.push_str(&filler);
        content.push_str(&sample_head());
        fs::write(&big, content).unwrap();
        let (head, tail, _) = read_head_tail(&big).unwrap();
        assert!(head.len() <= 64 * 1024);
        assert!(tail.len() <= 64 * 1024);
        // 大文件的 tail 应从末尾取（能解析出末尾的 ai-title）
        assert!(tail.contains("修复登录页面"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn append_custom_title_writes_json_line() {
        let dir = temp_root("sess-rename");
        let file = dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&file, sample_head()).unwrap();
        append_custom_title(&file, "5426d6d0-c08f-43bd-94df-4d6d99e5c699", "新名字")
            .unwrap();
        let content = fs::read_to_string(&file).unwrap();
        // 原内容保留，末尾追加一行
        assert!(content.starts_with(r#"{"type":"mode""#));
        let last = content.lines().last().unwrap();
        let v: serde_json::Value = serde_json::from_str(last).unwrap();
        assert_eq!(v["type"], "custom-title");
        assert_eq!(v["customTitle"], "新名字");
        assert_eq!(v["sessionId"], "5426d6d0-c08f-43bd-94df-4d6d99e5c699");
        // 追加后再次提取应识别新标题
        let (head, tail, _) = read_head_tail(&file).unwrap();
        let info = session_meta_from_lite(
            &head,
            &tail,
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            0,
        )
        .unwrap();
        assert_eq!(info.title, "新名字");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn append_custom_title_escapes_special_chars() {
        let dir = temp_root("sess-rename-esc");
        let file = dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&file, sample_head()).unwrap();
        append_custom_title(
            &file,
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
            r#"含"引号"和\反斜杠"#,
        )
        .unwrap();
        let content = fs::read_to_string(&file).unwrap();
        let last = content.lines().last().unwrap();
        let v: serde_json::Value = serde_json::from_str(last).unwrap();
        assert_eq!(v["customTitle"], r#"含"引号"和\反斜杠"#);
        fs::remove_dir_all(&dir).unwrap();
    }

    // ---------------- 回收站（v2.0.0 阶段一：删除会话 = 移入回收站） ----------------

    #[test]
    fn utc_timestamp_matches_format() {
        let ts = utc_timestamp();
        assert_eq!(ts.len(), 15);
        assert!(ts.as_bytes().iter().all(|b| b.is_ascii_digit() || *b == b'_'));
        // 年份合理范围（2025-2035）
        let year: i64 = ts[..4].parse().unwrap();
        assert!((2025..=2035).contains(&year));
    }

    #[test]
    fn civil_from_days_is_accurate() {
        // 已知日期：2000-01-01（UTC epoch 946684800 = 10957 天）
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        // 2026-08-12（epoch 秒 1786492800 / 86400 = 20676.99...，取整）
        assert_eq!(civil_from_days(20_676), (2026, 8, 11)); // 边界 ±1 天可接受
    }

    #[test]
    fn delete_session_moves_to_trash_with_project_dir() {
        let root = temp_root("trash-del");
        let projects = root.join("projects");
        let trash = root.join("trash").join("sessions");
        let mangled = "D--MyWorkspaces-myProject-claude-fast";
        let proj_dir = projects.join(mangled);
        fs::create_dir_all(&proj_dir).unwrap();
        let file = proj_dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&file, sample_head()).unwrap();
        let content_before = fs::read_to_string(&file).unwrap();

        let backup = delete_session_file(&file, &trash).unwrap();
        // 原文件已删除
        assert!(!file.exists());
        // 备份在 trash/<ts>/<mangled>/<uuid>.jsonl
        assert!(backup.starts_with(&trash));
        assert!(backup.ends_with("D--MyWorkspaces-myProject-claude-fast/5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), content_before);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_trashed_sessions_parses_and_sorts() {
        let root = temp_root("trash-list");
        let trash = root.join("trash").join("sessions");
        // 两个时间批次（倒序：20260812 在前）
        let older = trash.join("20260811_100000").join("D--baitai");
        let newer = trash.join("20260812_090000").join("D--MyWorkspaces-myProject-claude-fast");
        fs::create_dir_all(&older).unwrap();
        fs::create_dir_all(&newer).unwrap();
        fs::write(
            older.join("11111111-1111-4111-8111-111111111111.jsonl"),
            sample_head(),
        )
        .unwrap();
        fs::write(
            newer.join("22222222-2222-4222-8222-222222222222.jsonl"),
            sample_head(),
        )
        .unwrap();

        let list = list_trashed_sessions_in(&trash);
        assert_eq!(list.len(), 2);
        // 倒序：新的在前
        assert_eq!(list[0].deleted_at, "20260812_090000");
        assert_eq!(list[1].deleted_at, "20260811_100000");
        // 标题从 jsonl 解析（sample_head 有 ai-title「修复登录页面」）
        assert_eq!(list[0].title, "修复登录页面");
        assert_eq!(list[0].session_id, "22222222-2222-4222-8222-222222222222");
        assert_eq!(list[0].project_dir, "D--MyWorkspaces-myProject-claude-fast");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restore_trashed_file_roundtrip() {
        let root = temp_root("trash-restore");
        let projects = root.join("projects");
        let trash = root.join("trash").join("sessions");
        let mangled = "D--MyWorkspaces-myProject-claude-fast";
        let proj_dir = projects.join(mangled);
        fs::create_dir_all(&proj_dir).unwrap();
        let file = proj_dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&file, sample_head()).unwrap();
        let content_before = fs::read_to_string(&file).unwrap();

        // 删除 → 回收站
        let backup = delete_session_file(&file, &trash).unwrap();
        assert!(!file.exists());

        // 恢复 → 回到原项目目录
        let restored = restore_trashed_file(&backup, &projects).unwrap();
        assert_eq!(restored, file);
        assert!(file.exists());
        assert_eq!(fs::read_to_string(&file).unwrap(), content_before);
        assert!(!backup.exists());

        // 重复恢复（目标已存在）→ 报错
        let err = restore_trashed_file(&backup, &projects).unwrap_err();
        assert!(err.contains("已存在"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restore_trashed_file_rejects_duplicate_target() {
        let root = temp_root("trash-restore-dup");
        let projects = root.join("projects");
        let trash = root.join("trash").join("sessions");
        let mangled = "D--baitai";
        let proj_dir = projects.join(mangled);
        fs::create_dir_all(&proj_dir).unwrap();
        // 目标已存在同名文件
        let existing = proj_dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&existing, "existing").unwrap();
        // 回收站里也有一个同名备份
        let backup_dir = trash.join("20260812_090000").join(mangled);
        fs::create_dir_all(&backup_dir).unwrap();
        let backup = backup_dir.join("5426d6d0-c08f-43bd-94df-4d6d99e5c699.jsonl");
        fs::write(&backup, "backup").unwrap();

        let err = restore_trashed_file(&backup, &projects).unwrap_err();
        assert!(err.contains("已存在"));
        // 原备份未被破坏
        assert!(backup.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn purge_trash_physically_deletes() {
        let root = temp_root("trash-purge");
        let trash = root.join("trash").join("sessions");
        // 两个时间批次，共 3 个会话
        let batch1 = trash.join("20260811_100000").join("D--baitai");
        let batch2 = trash.join("20260812_090000").join("D--MyWorkspaces-myProject-claude-fast");
        fs::create_dir_all(&batch1).unwrap();
        fs::create_dir_all(&batch2).unwrap();
        fs::write(batch1.join("11111111-1111-4111-8111-111111111111.jsonl"), sample_head()).unwrap();
        fs::write(batch2.join("22222222-2222-4222-8222-222222222222.jsonl"), sample_head()).unwrap();
        fs::write(batch2.join("33333333-3333-4333-8333-333333333333.jsonl"), sample_head()).unwrap();

        let count = purge_trash_in(&trash).unwrap();
        assert_eq!(count, 3);
        // 回收站已空（根目录保留，供后续继续接收删除的会话）
        assert!(trash.exists());
        assert!(list_trashed_sessions_in(&trash).is_empty());
        // 磁盘上没有任何残留备份（trash/ 下只剩空的 sessions/）
        assert_eq!(
            fs::read_dir(root.join("trash")).unwrap().flatten().count(),
            1
        );

        // 空回收站再次清空 → 0
        let count2 = purge_trash_in(&trash).unwrap();
        assert_eq!(count2, 0);
        fs::remove_dir_all(&root).unwrap();
    }

    // ---------------- 会话内容读取（v2.0.0 阶段二：方向 A） ----------------

    #[test]
    fn parse_session_messages_extracts_blocks() {
        let jsonl = format!(
            "{}\n{}\n{}\n{}\n{}\n",
            r#"{"type":"mode","mode":"normal","sessionId":"x"}"#,
            r#"{"type":"user","message":{"role":"user","content":"你好，帮我看看"},"timestamp":"2026-08-12T06:47:46.519Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"好的，我来看看"},{"type":"thinking","thinking":"先分析一下"},{"type":"tool_use","id":"toolu_abc","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-08-12T06:47:47.000Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file1.txt"}]},"timestamp":"2026-08-12T06:47:47.500Z"}"#,
            r#"{"type":"ai-title","aiTitle":"标题","sessionId":"x"}"#,
        );
        let r = parse_session_messages(&jsonl);
        assert_eq!(r.len(), 3);
        // 元数据行（mode/ai-title）被过滤
        // 消息 1：user 文本
        assert_eq!(r[0].kind, "user");
        assert_eq!(r[0].blocks.len(), 1);
        assert_eq!(r[0].blocks[0].kind, "text");
        assert_eq!(r[0].blocks[0].text.as_deref(), Some("你好，帮我看看"));
        assert_eq!(r[0].timestamp.as_deref(), Some("2026-08-12T06:47:46.519Z"));
        // 消息 2：assistant text + thinking + tool_use
        let m2 = &r[1];
        assert_eq!(m2.kind, "assistant");
        assert_eq!(m2.model.as_deref(), Some("claude-sonnet-4"));
        assert_eq!(m2.blocks.len(), 3);
        assert_eq!(m2.blocks[0].kind, "text");
        assert_eq!(m2.blocks[1].kind, "thinking");
        assert_eq!(m2.blocks[2].kind, "tool_use");
        assert_eq!(m2.blocks[2].name.as_deref(), Some("Bash"));
        assert_eq!(m2.blocks[2].tool_use_id.as_deref(), Some("toolu_abc"));
        assert_eq!(
            m2.blocks[2].input.as_ref().and_then(|v| v.get("command")).and_then(|v| v.as_str()),
            Some("ls")
        );
        // 消息 3：user tool_result
        let m3 = &r[2];
        assert_eq!(m3.blocks[0].kind, "tool_result");
        assert_eq!(m3.blocks[0].text.as_deref(), Some("file1.txt"));
        assert_eq!(m3.blocks[0].tool_use_id.as_deref(), Some("toolu_1"));
    }

    #[test]
    fn parse_session_messages_skips_meta_sidechain_commands() {
        let jsonl = format!(
            "{}\n{}\n{}\n{}\n",
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"系统注入"}}"#,
            r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"子会话"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"正常的对话"}}"#,
        );
        let r = parse_session_messages(&jsonl);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].blocks[0].text.as_deref(), Some("正常的对话"));
    }

    #[test]
    fn parse_session_messages_treats_task_notification_as_tool_result() {
        // 后台任务完成通知（user 字符串消息）不应显示成用户输入，而是工具结果
        let jsonl = format!(
            "{}\n",
            r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>a35ea541f842e114e</task-id>\n<tool-use-id>call_ffd1d8c7a52341febe1c28d0</tool-use-id>\n<output-file>C:\\temp\\x.output</output-file>\n<status>completed</status>\n<summary>Agent 任务完成</summary>\n<result>任务完成，共处理 5 个文件\n- a.ts 已更新</result>\n</task-notification>"}}"#,
        );
        let r = parse_session_messages(&jsonl);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, "user");
        let b = &r[0].blocks[0];
        assert_eq!(b.kind, "tool_result");
        assert_eq!(b.tool_use_id.as_deref(), Some("call_ffd1d8c7a52341febe1c28d0"));
        let text = b.text.as_deref().unwrap();
        // 提取的是 <result> 内容
        assert!(text.contains("任务完成，共处理 5 个文件"));
        assert!(text.contains("a.ts 已更新"));
        // 不应包含 XML 标签本身
        assert!(!text.contains("<task-notification>"));
        assert!(!text.contains("<summary>"));

        // 无 <result> 时回退 <summary>
        let jsonl2 = format!(
            "{}\n",
            r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<summary>只有摘要</summary>\n</task-notification>"}}"#,
        );
        let r2 = parse_session_messages(&jsonl2);
        assert_eq!(r2[0].blocks[0].text.as_deref(), Some("只有摘要"));
    }

    #[test]
    fn parse_session_messages_truncates_at_limit() {
        // 901 条消息 → 默认取最后 500 条，has_more=true，offset=401
        let mut jsonl = String::new();
        for i in 0..(MAX_SESSION_MESSAGES + 401) {
            jsonl.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"消息 {i}\"}}}}\n"
            ));
        }
        let all = parse_session_messages(&jsonl);
        assert_eq!(all.len(), MAX_SESSION_MESSAGES + 401);

        // 默认（不带 offset）：最后 500 条
        let r = slice_messages(all.clone(), None, None);
        assert!(r.has_more);
        assert_eq!(r.total, MAX_SESSION_MESSAGES + 401);
        assert_eq!(r.offset, 401);
        assert_eq!(r.messages.len(), MAX_SESSION_MESSAGES);
        assert!(r.messages[0].blocks[0].text.as_deref().unwrap().contains("消息 401"));

        // 加载更早：offset=0（第一页）
        let r0 = slice_messages(all.clone(), Some(0), None);
        assert!(!r0.has_more);
        assert_eq!(r0.offset, 0);
        assert_eq!(r0.messages.len(), MAX_SESSION_MESSAGES);
        assert!(r0.messages[0].blocks[0].text.as_deref().unwrap().contains("消息 0"));

        // 小会话：不足 500 条 → 全部返回，has_more=false
        let small = slice_messages(all[..100].to_vec(), None, None);
        assert!(!small.has_more);
        assert_eq!(small.offset, 0);
        assert_eq!(small.messages.len(), 100);

        // 自定义 limit
        let rl = slice_messages(all, Some(100), Some(50));
        assert_eq!(rl.offset, 100);
        assert_eq!(rl.messages.len(), 50);
        assert!(rl.messages[0].blocks[0].text.as_deref().unwrap().contains("消息 100"));
    }

    #[test]
    fn parse_session_messages_ignores_bad_lines() {
        let jsonl = "这不是 json\n{\"type\":\"user\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"ok\"}}\n";
        let r = parse_session_messages(jsonl);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].blocks[0].text.as_deref(), Some("ok"));
    }

    #[test]
    fn parse_session_messages_handles_array_text_and_errors() {
        let jsonl = format!(
            "{}\n{}\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"多块"},{"type":"text","text":"拼接"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"出错了"}]}]}}"#,
        );
        let r = parse_session_messages(&jsonl);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].blocks.len(), 2);
        assert_eq!(r[1].blocks[0].is_error, Some(true));
        assert_eq!(r[1].blocks[0].text.as_deref(), Some("出错了"));
    }

    // ---------------- 会话继续对话（v2.0.0 阶段二：方向 B resume） ----------------

    #[cfg(windows)]
    #[test]
    fn build_resume_cmdline_ok() {
        let dir = temp_root("resume-cmd");
        let cmd = build_resume_cmdline(
            dir.to_str().unwrap(),
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
        )
        .unwrap();
        assert!(cmd.starts_with("/k cd /d \""));
        assert!(cmd.contains("&& claude --resume 5426d6d0-c08f-43bd-94df-4d6d99e5c699"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn build_resume_cmdline_rejects_bad_paths() {
        // 空路径
        assert!(build_resume_cmdline("", "x").is_err());
        // 引号
        assert!(build_resume_cmdline("D:\\My\\\"Workspaces", "x").is_err());
        // cmd 特殊字符（& | < > %）
        assert!(build_resume_cmdline("D:\\a&b", "x").is_err());
        assert!(build_resume_cmdline("D:\\a|b", "x").is_err());
        assert!(build_resume_cmdline("D:\\a%b", "x").is_err());
        // 不存在的目录
        let nonexist = std::env::temp_dir().join(format!("cf-no-such-{}", std::process::id()));
        assert!(build_resume_cmdline(nonexist.to_str().unwrap(), "x").is_err());
    }

    #[test]
    fn validate_resume_path_checks() {
        // 空路径
        assert!(validate_resume_path("").is_err());
        // 不存在的目录
        let nonexist = std::env::temp_dir().join(format!("cf-no-such-{}", std::process::id()));
        assert!(validate_resume_path(nonexist.to_str().unwrap()).is_err());
        // 存在的目录通过
        let dir = temp_root("resume-valid");
        assert!(validate_resume_path(dir.to_str().unwrap()).is_ok());
        // 平台元字符：Windows 拒 cmd 特殊字符，macOS 拒 bash 特殊字符
        #[cfg(windows)]
        {
            assert!(validate_resume_path("D:\\a&b").is_err());
            assert!(validate_resume_path("D:\\a|b").is_err());
            assert!(validate_resume_path("D:\\a^b").is_err());
        }
        #[cfg(not(windows))]
        {
            // macOS：路径放进 cd "..." 经 sh_quote 转义，双引号内这些字符均为字面量，
            // 不再额外拒绝（避免误伤含 ( ) ' \ 等的合法 mac 路径）。用真实目录验证通过。
            let d = temp_root("resume-tricky");
            let tricky = d.join("my'app (v2)\\3"); // 含 ' ( ) 空格 \ ——合法 mac 文件名字符
            fs::create_dir_all(&tricky).unwrap();
            assert!(validate_resume_path(tricky.to_str().unwrap()).is_ok());
            // 控制字符仍拒绝
            assert!(validate_resume_path(&format!("{}\u{1}", d.to_str().unwrap())).is_err());
            fs::remove_dir_all(&d).unwrap();
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    /// macOS resume 临时脚本内容（Windows 上不编译，随 mac 构建跑）
    #[cfg(not(windows))]
    #[test]
    fn build_resume_script_ok() {
        let dir = temp_root("resume-sh");
        let script = build_resume_script(
            dir.to_str().unwrap(),
            "5426d6d0-c08f-43bd-94df-4d6d99e5c699",
        )
        .unwrap();
        assert!(script.starts_with("#!/bin/bash\n"));
        assert!(script.contains(&format!("cd \"{}\" || exit 1", dir.to_str().unwrap())));
        assert!(script.contains("exec claude --resume 5426d6d0-c08f-43bd-94df-4d6d99e5c699"));
        fs::remove_dir_all(&dir).unwrap();
    }

    // ---------------- 去脚本化：项目清单与迁移 ----------------

    #[test]
    fn list_projects_impl_merges_scan_and_manual() {
        let root = temp_root("proj-list");
        let projects = root.join("projects");
        // 手动添加但磁盘上存在的路径 → 非 missing；手动添加但不存在的 → missing
        let real = Path::new(&root).join("real_proj");
        fs::create_dir_all(&real).unwrap();

        let list = list_projects_impl(&projects, &[real.to_str().unwrap().to_string(), "D:\\ghost\\path".to_string()]);
        // 会话目录为空 → 只有手动项；大小写不敏感去重后 2 条
        assert_eq!(list.len(), 2);
        let delta = list.iter().find(|x| x.path == "D:\\ghost\\path").unwrap();
        assert!(delta.missing);
        assert_eq!(delta.name, "path");
        let real_item = list.iter().find(|x| x.path == real.to_str().unwrap()).unwrap();
        assert!(!real_item.missing);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn legacy_config_migrates_to_projects() {
        let root = temp_root("proj-migrate");
        // 旧脚本：claude-oldproj.bat 指向 D:\legacy\proj；claude-dead.bat 指向不存在目录
        let scripts = root.join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::write(
            scripts.join("claude-oldproj.bat"),
            "@echo off\r\ncd /d \"D:\\legacy\\proj\"",
        )
        .unwrap();
        fs::write(
            scripts.join("claude-dead.bat"),
            "@echo off\r\ncd /d \"D:\\legacy\\dead\"",
        )
        .unwrap();
        // 旧版 config：favorites 存脚本 key、无 projects 字段
        fs::write(
            root.join("config.json"),
            r#"{"favorites": ["claude-oldproj", "claude-unknown"], "dark": false}"#,
        )
        .unwrap();

        ensure_projects_migrated_in(&root);

        let migrated = load_config_from(&root);
        // projects = 全部脚本路径（顺序按解析序，包含已失效的）
        assert!(migrated
            .projects
            .iter()
            .any(|p| p.eq_ignore_ascii_case("D:\\legacy\\proj")));
        assert!(migrated
            .projects
            .iter()
            .any(|p| p.eq_ignore_ascii_case("D:\\legacy\\dead")));
        // favorites = 旧收藏 key 映射后的路径；unknown 找不到被丢弃
        assert_eq!(migrated.favorites, vec!["D:\\legacy\\proj"]);
        // 幂等：二次调用不再变化
        ensure_projects_migrated_in(&root);
        let again = load_config_from(&root);
        assert_eq!(again.projects, migrated.projects);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn add_remove_project_updates_lists() {
        // add_project_to 要求路径真实存在（不存在的路径被静默忽略）
        let dir = temp_root("add-rm");
        let alpha = dir.join("alpha");
        let beta = dir.join("beta");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta).unwrap();
        let mut manual: Vec<String> = Vec::new();
        add_project_to(&mut manual, alpha.to_str().unwrap());
        // 大小写不敏感去重
        add_project_to(&mut manual, &alpha.to_str().unwrap().to_uppercase());
        assert_eq!(manual.len(), 1);
        add_project_to(&mut manual, beta.to_str().unwrap());
        assert_eq!(manual.len(), 2);
        remove_project_from(&mut manual, &beta.to_str().unwrap().to_uppercase());
        assert_eq!(manual, vec![alpha.to_str().unwrap().to_string()]);
        // 不存在的路径被静默忽略
        add_project_to(&mut manual, "D:\\ghost\\never");
        assert_eq!(manual.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}

/// 退出程序（托盘菜单/前端调用；绕过关闭拦截直接退出）
/// 当前平台是否支持开机自启动（官方 tauri-plugin-autostart 支持 Windows / macOS / Linux，
/// 前端据此决定是否显示「开机自启动」设置项；未来某平台不支持时只需改这一处）。
#[tauri::command]
fn autostart_supported() -> bool {
    cfg!(any(windows, target_os = "macos", target_os = "linux"))
}

/// 把主窗口显示到最前台（托盘「显示窗口」菜单 / 托盘左键点击 / 单实例回调共用）。
/// Windows 前台锁定：进程不占前台时 SetFocus 可能被忽略；先强制置顶再取消，
/// 确保窗口真正浮到最前（隐藏到托盘后点托盘图标恢复时必经此路径）。
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();        // 隐藏状态 → 显示
        let _ = w.unminimize();  // 最小化状态 → 恢复
        let _ = w.set_focus();
        let _ = w.set_always_on_top(true);
        let _ = w.set_always_on_top(false);
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 开机自启动：Windows 写注册表 Run 项 / macOS 用 LaunchAgent（两端均支持）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        // 单实例：再次启动时不再新建进程，而是把已有主窗口调到前台
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            // 旧脚本清单一次性迁移（去脚本化）：解析 scripts/ 旧脚本生成
            // config.projects / 新版 favorites（路径），幂等
            ensure_projects_migrated();

            let show_i = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Claude助手")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            check_projects,
            load_config,
            save_config,
            add_project,
            remove_project,
            launch_project,
            open_folder,
            check_claude,
            scan_claude_projects,
            get_claude_projects_dir,
            list_sessions,
            rename_session,
            delete_session,
            list_trashed_sessions,
            restore_session,
            purge_session,
            purge_trash,
            get_session_messages,
            resume_session,
            get_data_root,
            autostart_supported,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
