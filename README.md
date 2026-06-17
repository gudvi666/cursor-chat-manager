# Cursor Chat Manager

离线查看与管理 **Cursor 本体对话库** 的桌面应用：像 Cursor 一样渲染历史对话、全文搜索、导出 Markdown、批量删除对话、回收磁盘空间。基于 **Tauri 2 + Rust + React 19**，原生桌面体验、单文件安装包，直接用 `rusqlite` 读写 SQLite，无需 Python 运行时。

## 它解决什么问题

Cursor 把所有对话存在一个 SQLite 库里（`state.vscdb`），实测可膨胀到数 GB（本机为 2.4GB，其中消息气泡 1.24GB、agent 缓存 589MB）。本工具让你在 **Cursor 关闭后**：

- 浏览全部历史对话（标题、时间、模型、消息数、体积）
- 点开任意对话，按 Cursor 的样式渲染（用户消息、AI Markdown、可折叠的「思考过程」与「工具调用」）
- 全文搜索、导出 Markdown、查看统计仪表盘
- 勾选 **批量删除**，自动级联清理该对话的全部消息、检查点、文件快照，并同步全局对话索引
- 一键 **VACUUM** 回收被删除数据占用的磁盘空间
- **agentKv 孤儿缓存回收**，清理未被任何对话引用的工具结果缓存

## 快速开始

### A. 下载安装包（推荐）

到 [Releases](https://github.com/gudvi666/cursor-chat-manager/releases) 下载对应平台的安装包：

| 平台    | 安装包                                       |
| ------- | -------------------------------------------- |
| macOS   | `.dmg`（Intel + Apple Silicon 通用包）        |
| Windows | `.msi` 或 `.exe`（NSIS）                       |

安装包由 GitHub Actions 在推送 `v*` tag 时自动构建并发布（见 `.github/workflows/build-desktop.yml`）。

### B. 从源码运行（开发）

前置依赖：**Rust 工具链**（rustup）、**Node 20+**、**pnpm 9**，以及各平台的 Tauri 系统依赖（macOS 需 Xcode Command Line Tools；Windows 需 WebView2 + MSVC 生成工具；Linux 需 webkit2gtk 等，详见 [Tauri 前置要求](https://tauri.app/start/prerequisites/)）。

```bash
cd tauri
pnpm install
pnpm tauri dev        # 开发模式（热重载）
pnpm tauri build      # 打包当前平台安装包
```

打包产物在 `tauri/src-tauri/target/release/bundle/`。

默认库路径（应用启动时自动按平台定位，也可在界面里用「打开」按钮手动选择）：

| 平台    | 路径                                                                    |
| ------- | --------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`  |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`                      |
| Linux   | `~/.config/Cursor/User/globalStorage/state.vscdb`                     |

## 安全设计与使用风险（务必阅读）

> ⚠️ **数据库损坏风险**：本工具会直接读写 Cursor 本体的 SQLite 库（`state.vscdb`）。删除 / VACUUM 属于写操作，极端情况下（操作过程中断电、磁盘写满、库被其他进程占用等）仍可能损坏数据库。请在操作前确认目标对话确实不再需要，并始终依赖下方的自动备份兜底。

- **运行检测**：检测到 Cursor 正在运行时，仅允许只读浏览，删除 / VACUUM / 缓存清理全部禁用。要清理请先 **完全退出 Cursor**（库为 WAL 模式，运行时外部写入会与 Cursor 的内存缓存冲突，可能损坏数据）。
- **每次删除前自动备份**：每次执行删除前，都会用 SQLite 在线备份 API（`rusqlite` 的 backup）生成一份一致性整库快照 `state.vscdb.ccm-backup-<时间戳>`，与原库存放在同一目录。
- **备份不会自动删除**：备份快照需由你**手动清理**，工具不会自动回收。每份快照大小约等于整库体积（实测可达数 GB），多次操作会持续累积。**请在磁盘空间充足时使用**，并定期删除不再需要的 `state.vscdb.ccm-backup-*` 文件。
- **事务化删除**：级联删除在单事务内完成，出错自动回滚。

## 删除时清理了哪些键

对每个对话 `composerData:<id>`，级联删除以下 `cursorDiskKV` 键，并从 `ItemTable.composer.composerHeaders` 移除其条目：

- `composerData:<id>`
- `bubbleId:<id>:*`（消息气泡）
- `checkpointId:<id>:*`（检查点）
- `codeBlockPartialInlineDiffFates:<id>:*`
- `ofsContent:<id>:*`（原始文件快照）
- `messageRequestContext:<id>:*`（部分版本）
- `ItemTable` 中 `workbench.panel.composerChatViewPane.<id>.hidden`

> 注意：`agentKv:blob:*`（内容寻址的 agent 缓存，本机 589MB）**不**随单个对话删除，由独立的「孤儿缓存回收」处理——扫描出未被任何对话引用的 blob 后再清理。

## 数据模型速查

- 对话索引：`ItemTable.composer.composerHeaders` → `{ allComposers: [head...] }`
- 对话元数据：`cursorDiskKV` 的 `composerData:<id>`（含 `fullConversationHeadersOnly` 有序气泡表）
- 对话消息：`cursorDiskKV` 的 `bubbleId:<id>:<bid>`（`type` 1=用户 / 2=AI；正文 `text`、推理 `thinking`、工具调用 `toolFormerData`）

## 文件结构

```
cursor-chat-manager/
├── .github/workflows/
│   └── build-desktop.yml     # CI：macOS + Windows 打包，推 v* tag 自动构建并发布 Release
├── tauri/                    # Tauri 桌面应用（Rust + React）
│   ├── src/                  # React 19 + antd 6 前端
│   │   ├── App.tsx           # 主界面（对话 / 搜索 / 统计 / 清理 四视图）
│   │   ├── api.ts            # 调用 Tauri 命令的封装 + 格式化辅助
│   │   ├── markdown.ts       # 内置 Markdown 渲染 + BajieAsk 消息美化
│   │   └── styles.css        # 仿 Cursor 暗色主题
│   ├── src-tauri/            # Rust 后端
│   │   ├── src/db.rs         # 数据层：rusqlite 直读写 state.vscdb（定位 / 备份 / 级联删除 / VACUUM / 搜索 / 统计 / agentKv 回收 / 导出）
│   │   ├── src/lib.rs        # Tauri 命令注册
│   │   ├── Cargo.toml        # Rust 依赖（rusqlite / serde / chrono / regex / dirs）
│   │   └── tauri.conf.json   # 应用配置（窗口 / 打包 / 图标）
│   ├── package.json          # 前端依赖与脚本
│   └── vite.config.ts
└── README.md
```

## 功能一览

- 对话列表（标题 / 时间 / 模型 / 消息数 / 体积，可搜索、排序）
- 像 Cursor 一样渲染对话（用户气泡、Cursor 回复、可折叠思考与工具调用）
- **BajieAsk 多 Agent 对话美化**：`reply_message` 还原为 Cursor 回复、`wait_message` 收到的消息还原为用户气泡、`suggestions` 渲染为快捷回复 chips，超时 / 保活噪声自动隐藏
- 全文搜索（跨全部对话搜消息正文 / 思考 / 工具，按 composerId 分 4 段并行扫描，关键词高亮）
- 导出对话为 Markdown（写入系统下载目录）
- 统计仪表盘（对话 / 消息 / 按模型 / 按天 / 按键前缀体积占用）
- 批量删除对话（级联清理 + 可选删后自动 VACUUM）
- agentKv 孤儿缓存回收（扫描未被任何对话引用的工具结果缓存后清理）

## 技术栈

- **后端**：Rust + [Tauri 2](https://tauri.app/) + [rusqlite](https://github.com/rusqlite/rusqlite)（`bundled` 内置 SQLite、`backup` 在线备份），辅以 `serde` / `chrono` / `regex` / `dirs`
- **前端**：React 19 + [Ant Design 6](https://ant.design/) + TypeScript + Vite
- **打包**：`tauri-action` 在 GitHub Actions 上产出 macOS 通用包（dmg/app）+ Windows 安装包（msi/nsis）
