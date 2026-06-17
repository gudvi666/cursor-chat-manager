"""Cursor 对话库数据层。

封装对 Cursor 本体 SQLite 库 (state.vscdb) 的定位、只读浏览、安全写入、
备份与级联删除。所有写操作都强制要求 Cursor 未运行，并在删除前自动整库备份。

数据模型 (经实测):
- 全局库   : <userData>/User/globalStorage/state.vscdb (WAL 模式)
- 对话索引 : ItemTable.composer.composerHeaders -> {"allComposers": [head...]}
- 对话元数据: cursorDiskKV  composerData:<cid>
- 对话消息 : cursorDiskKV  bubbleId:<cid>:<bid>   (type 1=用户, 2=AI)
- 级联附属 : checkpointId / codeBlockPartialInlineDiffFates / ofsContent  均以 :<cid>: 划分
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime

# 以 composerId 为单位级联清理的键前缀 (键形如  <prefix>:<cid>:<sub>)
COMPOSER_SCOPED_PREFIXES = [
    "bubbleId",
    "checkpointId",
    "codeBlockPartialInlineDiffFates",
    "ofsContent",
    "messageRequestContext",  # 部分版本存在, 不存在则删 0 条无副作用
]

# ItemTable 中需同步清理的、按对话划分的键
ITEM_PANE_PREFIX = "workbench.panel.composerChatViewPane."
HEADERS_KEY = "composer.composerHeaders"


def default_db_path() -> str:
    """返回当前平台 Cursor 全局库的默认路径。"""
    home = os.path.expanduser("~")
    sysname = platform.system()
    if sysname == "Darwin":
        base = os.path.join(home, "Library", "Application Support", "Cursor")
    elif sysname == "Windows":
        base = os.path.join(os.environ.get("APPDATA", os.path.join(home, "AppData", "Roaming")), "Cursor")
    else:  # Linux 及其它
        base = os.path.join(home, ".config", "Cursor")
    return os.path.join(base, "User", "globalStorage", "state.vscdb")


def is_cursor_running() -> bool:
    """检测 Cursor 是否在运行。写/删操作必须在 Cursor 完全关闭时进行。

    实现要点:
    - macOS/Linux 用一次 ``ps`` 拉全部进程命令行后匹配, 比写死 pgrep 模式更稳健;
      实测 macOS 主进程命令行不含 ``MacOS/Cursor`` 精确子串, 但所有 Cursor 进程路径
      都含 ``/Cursor.app/``, 故以此为准。
    - 主动排除本工具自身 (命令行含 cursor-chat-manager / app.py / 本进程 pid),
      避免把自己误判成 Cursor。
    - 任一环节异常时保守返回 True (视为在运行, 禁止写), 宁稳勿险。
    """
    sysname = platform.system()
    me = os.getpid()
    try:
        if sysname == "Windows":
            out = subprocess.run(["tasklist"], capture_output=True, text=True, timeout=10).stdout
            return "Cursor.exe" in out

        out = subprocess.run(["ps", "-Ao", "pid=,command="], capture_output=True, text=True, timeout=10).stdout
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) < 2:
                continue
            try:
                pid = int(parts[0])
            except ValueError:
                continue
            if pid == me:
                continue
            low = parts[1].lower()
            # 排除本工具自身 (无论从哪个终端启动)
            if "cursor-chat-manager" in low or "app.py" in low or "cursor_db" in low or "ccm_test" in low:
                continue
            if "/cursor.app/" in low:  # macOS Cursor 应用 (主进程 + 全部 helper)
                return True
            if sysname != "Darwin":  # Linux: electron 版 Cursor
                if (".appimage" in low or "/cursor" in low or low.split()[0].endswith("cursor")) and "cursor" in low:
                    return True
        return False
    except Exception:
        return True


def _connect_ro(path: str) -> sqlite3.Connection:
    """以只读 URI 方式打开 (WAL 下不阻塞 Cursor 的写, 也不会被其阻塞)。"""
    uri = f"file:{_uri_path(path)}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def _connect_rw(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _uri_path(path: str) -> str:
    # file: URI 需要对空格等做百分号编码
    from urllib.parse import quote
    return quote(path)


# --------------------------------------------------------------------------- #
# 库信息 / 统计
# --------------------------------------------------------------------------- #

def db_info(path: str) -> dict:
    info = {
        "path": path,
        "exists": os.path.exists(path),
        "cursorRunning": is_cursor_running(),
        "sizeBytes": 0,
        "walBytes": 0,
        "journalMode": None,
        "pageSize": None,
        "pageCount": None,
    }
    if not info["exists"]:
        return info
    info["sizeBytes"] = os.path.getsize(path)
    wal = path + "-wal"
    if os.path.exists(wal):
        info["walBytes"] = os.path.getsize(wal)
    try:
        conn = _connect_ro(path)
        info["journalMode"] = conn.execute("PRAGMA journal_mode").fetchone()[0]
        info["pageSize"] = conn.execute("PRAGMA page_size").fetchone()[0]
        info["pageCount"] = conn.execute("PRAGMA page_count").fetchone()[0]
        conn.close()
    except Exception as e:  # noqa: BLE001
        info["error"] = str(e)
    return info


def prefix_stats(path: str) -> list[dict]:
    """cursorDiskKV 各键前缀的条目数与字节占用 (全表扫描, 可能耗时数十秒)。"""
    conn = _connect_ro(path)
    sql = (
        "SELECT CASE WHEN instr(key,':')>0 THEN substr(key,1,instr(key,':')-1) ELSE '(no-colon)' END AS pfx, "
        "count(*) AS n, sum(length(value)) AS bytes FROM cursorDiskKV GROUP BY pfx ORDER BY bytes DESC"
    )
    rows = [dict(r) for r in conn.execute(sql).fetchall()]
    conn.close()
    return rows


# --------------------------------------------------------------------------- #
# 对话列表 / 详情
# --------------------------------------------------------------------------- #

def list_conversations(path: str) -> list[dict]:
    """从全局索引 composer.composerHeaders 读取对话清单 (与 Cursor 历史面板一致)。"""
    conn = _connect_ro(path)
    row = conn.execute("SELECT value FROM ItemTable WHERE key=?", (HEADERS_KEY,)).fetchone()
    conn.close()
    if not row:
        return []
    try:
        data = json.loads(row[0])
    except Exception:
        return []
    heads = data.get("allComposers", []) if isinstance(data, dict) else []
    out = []
    for h in heads:
        cid = h.get("composerId")
        if not cid:
            continue
        out.append({
            "id": cid,
            "name": h.get("name") or "(未命名)",
            "createdAt": h.get("createdAt"),
            "lastUpdatedAt": h.get("lastUpdatedAt"),
            "mode": h.get("unifiedMode") or h.get("forceMode"),
            "contextUsagePercent": h.get("contextUsagePercent"),
        })
    return out


def _bubble_count(conn: sqlite3.Connection, cid: str) -> int:
    lo = f"bubbleId:{cid}:"
    hi = f"bubbleId:{cid};"
    return conn.execute(
        "SELECT count(*) FROM cursorDiskKV WHERE key>=? AND key<?", (lo, hi)
    ).fetchone()[0]


def get_conversation(path: str, cid: str, result_limit: int = 12000) -> dict:
    """加载单个对话, 按 fullConversationHeadersOnly 顺序解析气泡用于渲染。

    若 composerData 缺失, 退化为按 createdAt 排序加载全部 bubbleId:<cid>:*。
    """
    conn = _connect_ro(path)
    cd_row = conn.execute(
        "SELECT value FROM cursorDiskKV WHERE key=?", (f"composerData:{cid}",)
    ).fetchone()

    meta = {}
    order: list[tuple[str, int | None]] = []  # (bubbleId, headerType)
    if cd_row:
        cd = json.loads(cd_row[0])
        meta = {
            "id": cid,
            "name": cd.get("name"),
            "createdAt": cd.get("createdAt"),
            "lastUpdatedAt": cd.get("lastUpdatedAt"),
            "status": cd.get("status"),
            "model": (cd.get("modelConfig") or {}).get("modelName"),
            "mode": cd.get("unifiedMode"),
            "contextTokensUsed": cd.get("contextTokensUsed"),
            "contextTokenLimit": cd.get("contextTokenLimit"),
            "todos": cd.get("todos") or [],
        }
        for h in cd.get("fullConversationHeadersOnly", []):
            order.append((h.get("bubbleId"), h.get("type")))

    bubbles = []
    if order:
        for bid, htype in order:
            r = conn.execute(
                "SELECT value FROM cursorDiskKV WHERE key=?", (f"bubbleId:{cid}:{bid}",)
            ).fetchone()
            if r:
                bubbles.append(_parse_bubble(json.loads(r[0]), result_limit))
    else:
        # 退化路径: 没有 composerData, 直接扫该对话所有 bubble 按时间排序
        lo, hi = f"bubbleId:{cid}:", f"bubbleId:{cid};"
        rows = conn.execute(
            "SELECT value FROM cursorDiskKV WHERE key>=? AND key<?", (lo, hi)
        ).fetchall()
        parsed = [_parse_bubble(json.loads(r[0]), result_limit) for r in rows]
        parsed.sort(key=lambda b: b.get("createdAt") or "")
        bubbles = parsed
        meta = {"id": cid, "name": None}

    conn.close()
    meta["messageCount"] = len(bubbles)
    return {"meta": meta, "bubbles": bubbles}


def _parse_bubble(b: dict, result_limit: int) -> dict:
    """把原始气泡 JSON 解析为渲染友好的结构。"""
    btype = b.get("type")
    out = {
        "id": b.get("bubbleId"),
        "role": "user" if btype == 1 else "assistant",
        "type": btype,
        "createdAt": b.get("createdAt"),
        "text": b.get("text") or "",
        "thinking": None,
        "toolCalls": [],
        "bajie": None,
        "error": None,
    }
    think = b.get("thinking")
    if isinstance(think, dict) and think.get("text"):
        out["thinking"] = {
            "text": think.get("text"),
            "durationMs": b.get("thinkingDurationMs"),
        }

    t = b.get("toolFormerData")
    if isinstance(t, dict) and (t.get("name") or t.get("rawArgs")):
        bajie = _parse_bajie(t.get("name") or "", t)
        if bajie:
            out["bajie"] = bajie
        else:
            args = t.get("rawArgs") or t.get("params") or ""
            result = t.get("result") or ""
            out["toolCalls"].append({
                "name": t.get("name"),
                "status": t.get("status"),
                "args": _truncate(args, result_limit),
                "result": _truncate(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False), result_limit),
            })

    err = b.get("errorDetails")
    if err:
        out["error"] = _truncate(json.dumps(err, ensure_ascii=False), 4000)
    return out


def _truncate(s: str, limit: int) -> str:
    if not isinstance(s, str):
        s = str(s)
    if len(s) > limit:
        return s[:limit] + f"\n…(已截断, 共 {len(s)} 字符)"
    return s


# --------------------------------------------------------------------------- #
# BajieAsk 多 Agent 消息的友好解析 (把 reply/wait 工具调用还原成对话)
# --------------------------------------------------------------------------- #

def _parse_bajie(name: str, t: dict) -> dict | None:
    """识别 BajieAsk 的 reply_message / wait_message / send_to_session 调用并结构化。

    其余 BajieAsk 工具 (list_sessions 等) 返回 None, 走普通工具卡片。
    """
    if "bajieask" not in name.lower():
        return None
    try:
        ra = json.loads(t.get("rawArgs") or "{}")
        args = ra.get("args") if isinstance(ra.get("args"), dict) else ra
    except Exception:
        args = {}
    if not isinstance(args, dict):
        args = {}

    if "reply_message" in name:
        return {"kind": "reply", "content": args.get("content", ""),
                "agentStatus": args.get("agentStatus")}
    if "wait_message" in name:
        received = _parse_wait_result(t.get("result"))
        rk = _classify_received(received)
        return {"kind": "wait", "receivedKind": rk,
                "received": _clean_received(received, rk),
                "suggestions": args.get("suggestions") or [],
                "agentStatus": args.get("agentStatus")}
    if "send_to_session" in name or "broadcast" in name:
        tgt = args.get("targetSessionId") or args.get("targetSessionIds") or "(广播)"
        return {"kind": "send", "target": tgt if isinstance(tgt, str) else ",".join(tgt or []),
                "message": args.get("message", ""), "messageType": args.get("messageType")}
    return None


def _parse_wait_result(res) -> str:
    """wait_message 的 result 为双层嵌套 JSON, 逐层解出真正收到的文本。"""
    if not res:
        return ""
    try:
        o = res if isinstance(res, dict) else json.loads(res)
        inner = o.get("result", o) if isinstance(o, dict) else o
        if isinstance(inner, str):
            inner = json.loads(inner)
        if isinstance(inner, dict) and isinstance(inner.get("content"), list):
            return "".join(c.get("text", "") for c in inner["content"] if isinstance(c, dict))
        return str(inner)
    except Exception:
        return res if isinstance(res, str) else str(res)


def _classify_received(text: str) -> str:
    if not text:
        return "other"
    if text.startswith("[TIMEOUT]"):
        return "timeout"
    if text.startswith("[USER_MSG]"):
        return "user"
    if text.startswith("[AUTO_KEEPALIVE]"):
        return "keepalive"
    if text.startswith("[FROM:"):
        return "inter"
    return "other"


def _clean_received(text: str, kind: str) -> str:
    """剥掉头部标记与尾部 [SYS]/[DISPATCH]/[SYS-RULE] 系统噪声, 留下真正的消息正文。"""
    if kind in ("timeout", "keepalive"):
        return ""
    import re
    s = re.sub(r"^\[USER_MSG\]\[TIME:[^\]]*\]\s*", "", text)
    for marker in ("\n[DISPATCH:", "\n---\n[SYS]", "\n[SYS]", "\n[SYS-RULE]", "\n[ROLE SKILL"):
        i = s.find(marker)
        if i >= 0:
            s = s[:i]
    return s.strip()


# --------------------------------------------------------------------------- #
# 备份 / VACUUM / 删除
# --------------------------------------------------------------------------- #

def backup_db(path: str) -> str:
    """用 SQLite 在线备份 API 生成一致性整库快照 (自动合并 WAL)。返回备份路径。"""
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = f"{path}.ccm-backup-{ts}"
    src = _connect_ro(path)
    dst = sqlite3.connect(backup_path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return backup_path


def vacuum_db(path: str, allow_when_running: bool = False) -> dict:
    """VACUUM 回收空间。需 Cursor 关闭, 且需约等于库大小的临时磁盘空间。

    allow_when_running 仅供库副本测试 / 删除后接力调用时透传, 生产入口永远 False。
    """
    if not allow_when_running and is_cursor_running():
        raise RuntimeError("Cursor 正在运行, 禁止 VACUUM。请先完全退出 Cursor。")
    before = os.path.getsize(path)
    conn = _connect_rw(path)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("VACUUM")
        conn.commit()
    finally:
        conn.close()
    after = os.path.getsize(path)
    return {"beforeBytes": before, "afterBytes": after, "freedBytes": before - after}


def delete_conversations(path: str, ids: list[str], do_backup: bool = True,
                         vacuum: bool = False, allow_when_running: bool = False) -> dict:
    """级联删除若干对话。默认在删除前整库备份, 并要求 Cursor 未运行。

    vacuum=True 时在删除提交后接力执行 VACUUM 回收磁盘空间。
    allow_when_running 仅供在库副本上测试时使用, 生产路径永远传 False。
    """
    if not ids:
        return {"deletedConversations": 0, "deletedKeys": 0}
    if not allow_when_running and is_cursor_running():
        raise RuntimeError("Cursor 正在运行, 禁止删除。请先完全退出 Cursor。")

    backup_path = None
    if do_backup:
        backup_path = backup_db(path)

    idset = set(ids)
    conn = _connect_rw(path)
    deleted_keys = 0
    try:
        conn.execute("BEGIN")
        for cid in ids:
            # composerData 精确键
            cur = conn.execute("DELETE FROM cursorDiskKV WHERE key=?", (f"composerData:{cid}",))
            deleted_keys += cur.rowcount if cur.rowcount > 0 else 0
            # 按对话划分的前缀范围
            for pfx in COMPOSER_SCOPED_PREFIXES:
                lo = f"{pfx}:{cid}:"
                hi = f"{pfx}:{cid};"
                cur = conn.execute(
                    "DELETE FROM cursorDiskKV WHERE key>=? AND key<?", (lo, hi)
                )
                deleted_keys += cur.rowcount if cur.rowcount > 0 else 0
            # ItemTable 中该对话的面板状态键
            cur = conn.execute(
                "DELETE FROM ItemTable WHERE key=?", (f"{ITEM_PANE_PREFIX}{cid}.hidden",)
            )
            deleted_keys += cur.rowcount if cur.rowcount > 0 else 0

        # 同步全局索引 composer.composerHeaders
        removed_heads = 0
        row = conn.execute("SELECT value FROM ItemTable WHERE key=?", (HEADERS_KEY,)).fetchone()
        if row:
            data = json.loads(row[0])
            if isinstance(data, dict) and isinstance(data.get("allComposers"), list):
                before = len(data["allComposers"])
                data["allComposers"] = [
                    c for c in data["allComposers"] if c.get("composerId") not in idset
                ]
                removed_heads = before - len(data["allComposers"])
                conn.execute(
                    "UPDATE ItemTable SET value=? WHERE key=?",
                    (json.dumps(data, ensure_ascii=False), HEADERS_KEY),
                )
        conn.commit()
    except Exception:
        conn.rollback()
        conn.close()
        raise
    conn.close()

    result = {
        "deletedConversations": len(ids),
        "deletedKeys": deleted_keys,
        "removedFromIndex": removed_heads,
        "backupPath": backup_path,
    }
    if vacuum:
        try:
            result["vacuum"] = vacuum_db(path, allow_when_running=allow_when_running)
        except Exception as e:  # noqa: BLE001 — VACUUM 失败不应回滚已成功的删除
            result["vacuumError"] = str(e)
    return result


# --------------------------------------------------------------------------- #
# 全文搜索
# --------------------------------------------------------------------------- #

def search_messages(path: str, query: str, limit: int = 300) -> dict:
    """跨全部对话搜索消息内容 (正文/思考/工具参数均在气泡 value 里, 用 SQL LIKE 一次命中)。

    经实测原始值为 UTF-8 (含中文), LIKE 中英通吃。结果按对话聚合, 附带片段预览。
    """
    query = (query or "").strip()
    if not query:
        return {"query": query, "results": [], "matchCount": 0, "conversationCount": 0}

    conn = _connect_ro(path)
    name_map = {}
    hrow = conn.execute("SELECT value FROM ItemTable WHERE key=?", (HEADERS_KEY,)).fetchone()
    if hrow:
        try:
            for h in (json.loads(hrow[0]).get("allComposers") or []):
                name_map[h.get("composerId")] = h.get("name") or "(未命名)"
        except Exception:
            pass

    like = f"%{query}%"
    by_conv: dict[str, dict] = {}
    matched = 0
    sql = ("SELECT key, value FROM cursorDiskKV WHERE key>='bubbleId:' AND key<'bubbleId;' "
           "AND value LIKE ? LIMIT ?")
    for key, val in conn.execute(sql, (like, limit)):
        parts = key.split(":")
        if len(parts) < 3:
            continue
        cid = parts[1]
        matched += 1
        entry = by_conv.setdefault(cid, {"id": cid, "name": name_map.get(cid, "(未命名)"),
                                         "matches": 0, "snippets": []})
        entry["matches"] += 1
        if len(entry["snippets"]) < 3:
            entry["snippets"].append(_snippet(val, query))
    conn.close()

    results = sorted(by_conv.values(), key=lambda e: e["matches"], reverse=True)
    return {"query": query, "results": results, "matchCount": matched,
            "conversationCount": len(results), "truncated": matched >= limit}


def _snippet(val, query: str, ctx: int = 60) -> str:
    if isinstance(val, bytes):
        val = val.decode("utf-8", "ignore")
    low = val.lower()
    i = low.find(query.lower())
    if i < 0:
        return val[:120]
    start = max(0, i - ctx)
    end = min(len(val), i + len(query) + ctx)
    s = val[start:end].replace("\n", " ").replace("\r", " ")
    return ("…" if start > 0 else "") + s + ("…" if end < len(val) else "")


# --------------------------------------------------------------------------- #
# 导出 Markdown
# --------------------------------------------------------------------------- #

def export_markdown(path: str, cid: str) -> str:
    data = get_conversation(path, cid)
    m = data["meta"]
    lines = [f"# {m.get('name') or '(未命名)'}", ""]
    info = []
    if m.get("model"):
        info.append(f"模型 `{m['model']}`")
    if m.get("mode"):
        info.append(f"模式 `{m['mode']}`")
    info.append(f"{m.get('messageCount', 0)} 条消息")
    if m.get("createdAt"):
        info.append(f"创建 {_fmt_ts(m['createdAt'])}")
    lines.append("> " + " · ".join(info))
    lines.append("")
    if m.get("todos"):
        lines.append("## Todos")
        for td in m["todos"]:
            box = "x" if td.get("status") == "completed" else " "
            lines.append(f"- [{box}] {td.get('content', '')}")
        lines.append("")
    lines.append("---")
    lines.append("")
    for b in data["bubbles"]:
        if not (b.get("text") or (b.get("thinking") or {}).get("text") or b.get("toolCalls") or b.get("error")):
            continue
        who = "👤 用户" if b["role"] == "user" else "🤖 助手"
        lines.append(f"### {who}")
        lines.append("")
        th = b.get("thinking")
        if th and th.get("text"):
            lines.append("<details><summary>💭 思考过程</summary>")
            lines.append("")
            lines.append(th["text"])
            lines.append("")
            lines.append("</details>")
            lines.append("")
        if b.get("text"):
            lines.append(b["text"])
            lines.append("")
        for tc in b.get("toolCalls", []):
            lines.append(f"**🔧 {tc.get('name')}** `{tc.get('status') or ''}`")
            lines.append("")
            if tc.get("args"):
                lines.append("```json")
                lines.append(_as_text(tc["args"]))
                lines.append("```")
            if tc.get("result"):
                lines.append("<details><summary>结果</summary>")
                lines.append("")
                lines.append("```")
                lines.append(_as_text(tc["result"]))
                lines.append("```")
                lines.append("</details>")
            lines.append("")
        if b.get("error"):
            lines.append(f"> ⚠️ 错误: {b['error']}")
            lines.append("")
    return "\n".join(lines)


def _as_text(s) -> str:
    return s if isinstance(s, str) else json.dumps(s, ensure_ascii=False, indent=2)


def _fmt_ts(ms) -> str:
    try:
        if isinstance(ms, str):
            return ms
        return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ms)


# --------------------------------------------------------------------------- #
# 统计仪表盘
# --------------------------------------------------------------------------- #

def stats_overview(path: str) -> dict:
    conn = _connect_ro(path)
    out = {}
    # 对话总数 + 按天/按模式 (来自全局索引, 快)
    heads = []
    hrow = conn.execute("SELECT value FROM ItemTable WHERE key=?", (HEADERS_KEY,)).fetchone()
    if hrow:
        try:
            heads = json.loads(hrow[0]).get("allComposers") or []
        except Exception:
            heads = []
    out["totalConversations"] = len(heads)

    by_day = {}
    for h in heads:
        ts = h.get("createdAt")
        if ts:
            day = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
            by_day[day] = by_day.get(day, 0) + 1
    out["byDay"] = sorted(([d, n] for d, n in by_day.items()), reverse=True)[:30]

    # 总消息数 (索引范围 count, 快)
    out["totalMessages"] = conn.execute(
        "SELECT count(*) FROM cursorDiskKV WHERE key>='bubbleId:' AND key<'bubbleId;'").fetchone()[0]

    # 按模型 (扫 composerData, 数百条, 数秒)
    by_model = {}
    for (v,) in conn.execute(
            "SELECT value FROM cursorDiskKV WHERE key>='composerData:' AND key<'composerData;'"):
        try:
            cd = json.loads(v)
            mdl = (cd.get("modelConfig") or {}).get("modelName") or "(未知)"
            by_model[mdl] = by_model.get(mdl, 0) + 1
        except Exception:
            continue
    out["byModel"] = sorted(([m, n] for m, n in by_model.items()), key=lambda x: x[1], reverse=True)
    out["conversationsWithBody"] = sum(by_model.values())
    conn.close()
    return out


# --------------------------------------------------------------------------- #
# agentKv 孤儿缓存回收
# --------------------------------------------------------------------------- #

_HEX64 = None


def scan_agentkv_orphans(path: str) -> dict:
    """找出未被任何现存对话引用的 agentKv 缓存块 (内容寻址, 哈希在 bubble 里逐字出现)。

    单次扫描全部非 agentKv 值, 正则提取 64 位十六进制引用集; 孤儿 = 全部 agentKv 哈希 - 被引用集。
    返回孤儿哈希列表 (供随后删除) 与体积统计。
    """
    import re
    global _HEX64
    if _HEX64 is None:
        _HEX64 = re.compile(rb"[0-9a-f]{64}")

    conn = _connect_ro(path)
    akv = {}
    for key, n in conn.execute(
            "SELECT key, length(value) FROM cursorDiskKV WHERE key>='agentKv:' AND key<'agentKv;'"):
        akv[key.rsplit(":", 1)[-1]] = n

    referenced = set()
    for (v,) in conn.execute("SELECT value FROM cursorDiskKV WHERE key<'agentKv:' OR key>='agentKv;'"):
        if v is None:
            continue
        if isinstance(v, str):
            v = v.encode("utf-8", "ignore")
        for mm in _HEX64.findall(v):
            referenced.add(mm.decode())
    conn.close()

    orphans = [h for h in akv if h not in referenced]
    return {
        "totalBlobs": len(akv),
        "totalBytes": sum(akv.values()),
        "orphanCount": len(orphans),
        "orphanBytes": sum(akv[h] for h in orphans),
        "orphanHashes": orphans,
    }


def delete_agentkv_orphans(path: str, hashes: list[str], do_backup: bool = True,
                           vacuum: bool = True, allow_when_running: bool = False) -> dict:
    """删除给定的孤儿 agentKv 缓存块。默认删前整库备份、删后 VACUUM, 且要求 Cursor 未运行。"""
    if not hashes:
        return {"deletedBlobs": 0}
    if not allow_when_running and is_cursor_running():
        raise RuntimeError("Cursor 正在运行, 禁止清理缓存。请先完全退出 Cursor。")

    backup_path = backup_db(path) if do_backup else None
    conn = _connect_rw(path)
    deleted = 0
    try:
        conn.execute("BEGIN")
        conn.executemany(
            "DELETE FROM cursorDiskKV WHERE key=?",
            [(f"agentKv:blob:{h}",) for h in hashes],
        )
        # 统计实际删除数
        deleted = conn.total_changes
        conn.commit()
    except Exception:
        conn.rollback()
        conn.close()
        raise
    conn.close()

    result = {"deletedBlobs": deleted, "backupPath": backup_path}
    if vacuum:
        try:
            result["vacuum"] = vacuum_db(path, allow_when_running=allow_when_running)
        except Exception as e:  # noqa: BLE001
            result["vacuumError"] = str(e)
    return result
