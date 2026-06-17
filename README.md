# Cursor Chat Manager

离线查看与管理 **Cursor 本体对话库** 的小工具：像 Cursor 一样渲染历史对话、批量删除对话、回收磁盘空间。**零第三方依赖**，仅用 Python 标准库。

## 它解决什么问题

Cursor 把所有对话存在一个 SQLite 库里（`state.vscdb`），实测可膨胀到数 GB（本机为 2.4GB，其中消息气泡 1.24GB、agent 缓存 589MB）。本工具让你在 **Cursor 关闭后**：

- 浏览全部历史对话（标题、时间、模型、消息数、体积）
- 点开任意对话，按 Cursor 的样式渲染（用户消息、AI Markdown、可折叠的「思考过程」与「工具调用」）
- 勾选 **批量删除**，自动级联清理该对话的全部消息、检查点、文件快照，并同步全局对话索引
- 一键 **VACUUM** 回收被删除数据占用的磁盘空间

## 快速开始

三种运行方式，按需选择：

### A. 桌面 App（原生窗口，推荐，不开浏览器）

```bash
pip3 install pywebview      # 仅首次
python3 desktop.py
```

会弹出一个独立的原生窗口（macOS 用系统内置 WebView），内部引擎只绑定 `127.0.0.1`，对用户完全不可见。

### B. 打包成可双击的 .app（macOS）

```bash
pip3 install pywebview pyinstaller
./build_app.sh
```

产物在 `dist/Cursor Chat Manager.app`，可直接双击运行，或拖进「应用程序」文件夹。

### C. 网页/CLI 模式（零依赖）

```bash
python3 app.py                      # 自动开浏览器到 http://127.0.0.1:8848/
python3 app.py --port 9000          # 换端口
python3 app.py --db /path/state.vscdb   # 指定库（默认自动按平台定位）
python3 app.py --no-browser         # 不自动开浏览器
```

默认库路径：

| 平台    | 路径                                                                    |
| ------- | --------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`  |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`                      |
| Linux   | `~/.config/Cursor/User/globalStorage/state.vscdb`                     |

## 安全设计（重要）

- **运行检测**：检测到 Cursor 正在运行时，仅允许只读浏览，删除 / VACUUM 全部禁用。要清理请先 **完全退出 Cursor**（库为 WAL 模式，运行时外部写入会与 Cursor 的内存缓存冲突，可能损坏数据）。
- **删除前自动备份**：每次删除前用 SQLite 在线备份 API 生成一致性整库快照 `state.vscdb.ccm-backup-<时间戳>`。
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

> 注意：`agentKv:blob:*`（内容寻址的 agent 缓存，本机 589MB）与 `inlineDiff:<workspaceId>:*`（按工作区划分）**不**随单个对话删除，属于二期的「孤儿缓存回收」。

## 数据模型速查

- 对话索引：`ItemTable.composer.composerHeaders` → `{ allComposers: [head...] }`
- 对话元数据：`cursorDiskKV` 的 `composerData:<id>`（含 `fullConversationHeadersOnly` 有序气泡表）
- 对话消息：`cursorDiskKV` 的 `bubbleId:<id>:<bid>`（`type` 1=用户 / 2=AI；正文 `text`、推理 `thinking`、工具调用 `toolFormerData`）

## 文件结构

```
cursor-chat-manager/
├── desktop.py        # 原生桌面 App 入口 (pywebview 窗口)
├── app.py            # 标准库 http.server 服务端 + 路由 + create_server
├── cursor_db.py      # 数据层：定位/只读/备份/级联删除/VACUUM/搜索/统计/agentKv 回收
├── index.html        # 单页界面
├── static/
│   ├── app.js        # 前端逻辑 + 内置 Markdown 渲染 + BajieAsk 消息美化
│   └── style.css     # 仿 Cursor 暗色主题
├── build_app.sh      # 一键打包为 .app (PyInstaller)
└── README.md
```

## 功能一览

- 对话列表（标题/时间/模型/消息数/体积，可搜索、排序、按内容筛选「仅空对话」）
- 像 Cursor 一样渲染对话（用户气泡、Cursor 回复、可折叠思考与工具调用）
- **BajieAsk 多 Agent 对话美化**：`reply_message` 还原为 Cursor 回复、`wait_message` 收到的消息还原为用户气泡、`suggestions` 渲染为快捷回复 chips，超时/保活噪声自动隐藏
- 全文搜索（跨全部对话搜消息正文/思考/工具，关键词高亮）
- 导出对话为 Markdown
- 统计仪表盘（对话/消息/按模型/按天/磁盘占用）
- 批量删除对话（级联清理 + 可选删后自动 VACUUM）
- agentKv 孤儿缓存回收（清理未被任何对话引用的工具结果缓存）
