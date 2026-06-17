#!/usr/bin/env python3
"""Cursor Chat Manager —— 离线查看 / 批量删除 Cursor 对话库的小工具。

零第三方依赖, 仅用 Python 标准库 (http.server)。启动后浏览器打开本地页面:
    python3 app.py                 # 用默认库路径, 自动开浏览器
    python3 app.py --port 8848     # 指定端口
    python3 app.py --db /path/state.vscdb --no-browser

安全设计:
- 检测到 Cursor 正在运行时, 只读浏览可用, 但删除 / VACUUM 一律被拒绝。
- 删除前自动整库备份 (.ccm-backup-时间戳)。
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import cursor_db as cdb

ROOT = os.path.dirname(os.path.abspath(__file__))

# 体积扫描结果缓存 (cid -> {n, bytes}); 扫描一次较慢, 缓存复用
_size_cache: dict | None = None
_size_lock = threading.Lock()

# agentKv 孤儿扫描结果缓存 (哈希列表 + 统计)
_orphan_cache: dict | None = None
_orphan_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "CursorChatManager/1.0"

    # 让日志安静一些
    def log_message(self, fmt, *args):  # noqa: A003
        pass

    # ----- 工具方法 ----- #
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, relpath, content_type):
        full = os.path.join(ROOT, relpath)
        if not os.path.isfile(full):
            self._send_json({"error": "not found"}, 404)
            return
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # ----- 路由 ----- #
    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        db = self.server.db_path  # type: ignore[attr-defined]
        try:
            if path == "/" or path == "/index.html":
                return self._send_file("index.html", "text/html; charset=utf-8")
            if path == "/static/app.js":
                return self._send_file("static/app.js", "application/javascript; charset=utf-8")
            if path == "/static/style.css":
                return self._send_file("static/style.css", "text/css; charset=utf-8")

            if path == "/api/info":
                info = cdb.db_info(db)
                info["sizeCacheReady"] = _size_cache is not None
                return self._send_json(info)

            if path == "/api/conversations":
                convs = cdb.list_conversations(db)
                if _size_cache is not None:
                    # 缓存就绪后, 不在 bubble 缓存里的对话即 0 条消息 (空壳), 一并标 0
                    for c in convs:
                        s = _size_cache.get(c["id"])
                        c["messageCount"] = s["n"] if s else 0
                        c["sizeBytes"] = s["bytes"] if s else 0
                return self._send_json({"conversations": convs, "sizeCacheReady": _size_cache is not None})

            if path == "/api/conversation":
                cid = (qs.get("id") or [None])[0]
                if not cid:
                    return self._send_json({"error": "missing id"}, 400)
                return self._send_json(cdb.get_conversation(db, cid))

            if path == "/api/prefix-stats":
                return self._send_json({"prefixes": cdb.prefix_stats(db)})

            if path == "/api/search":
                q = (qs.get("q") or [""])[0]
                return self._send_json(cdb.search_messages(db, q))

            if path == "/api/stats":
                return self._send_json(cdb.stats_overview(db))

            if path == "/api/export":
                cid = (qs.get("id") or [None])[0]
                if not cid:
                    return self._send_json({"error": "missing id"}, 400)
                md = cdb.export_markdown(db, cid)
                body = md.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/markdown; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="conversation-{cid[:8]}.md"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return None

            return self._send_json({"error": "unknown route"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._send_json({"error": str(e)}, 500)

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        db = self.server.db_path  # type: ignore[attr-defined]
        body = self._read_body()
        try:
            if path == "/api/scan-sizes":
                return self._send_json(self._scan_sizes(db))
            if path == "/api/backup":
                return self._send_json({"backupPath": cdb.backup_db(db)})
            if path == "/api/vacuum":
                return self._send_json(cdb.vacuum_db(db))
            if path == "/api/delete":
                ids = body.get("ids") or []
                do_backup = body.get("backup", True)
                do_vacuum = bool(body.get("vacuum", False))
                res = cdb.delete_conversations(db, ids, do_backup=do_backup, vacuum=do_vacuum)
                self._invalidate_caches()
                return self._send_json(res)
            if path == "/api/agentkv-scan":
                global _orphan_cache
                with _orphan_lock:
                    _orphan_cache = cdb.scan_agentkv_orphans(db)
                r = {k: v for k, v in _orphan_cache.items() if k != "orphanHashes"}
                return self._send_json(r)
            if path == "/api/agentkv-purge":
                if _orphan_cache is None:
                    return self._send_json({"error": "请先扫描孤儿缓存"}, 400)
                do_backup = body.get("backup", True)
                do_vacuum = body.get("vacuum", True)
                res = cdb.delete_agentkv_orphans(
                    db, _orphan_cache["orphanHashes"], do_backup=do_backup, vacuum=do_vacuum)
                self._invalidate_caches()
                return self._send_json(res)
            return self._send_json({"error": "unknown route"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._send_json({"error": str(e)}, 500)

    def _invalidate_caches(self):
        global _size_cache, _orphan_cache
        with _size_lock:
            _size_cache = None
        with _orphan_lock:
            _orphan_cache = None

    def _scan_sizes(self, db) -> dict:
        global _size_cache
        with _size_lock:
            conn = cdb._connect_ro(db)
            sql = (
                "SELECT substr(key,10,36) AS cid, count(*) AS n, sum(length(value)) AS b "
                "FROM cursorDiskKV WHERE key>='bubbleId:' AND key<'bubbleId;' GROUP BY cid"
            )
            cache = {}
            for r in conn.execute(sql).fetchall():
                cache[r["cid"]] = {"n": r["n"], "bytes": r["b"] or 0}
            conn.close()
            _size_cache = cache
        return {"scanned": len(cache)}


def create_server(db_path: str, host: str = "127.0.0.1", port: int = 8848) -> ThreadingHTTPServer:
    """构造并返回已绑定数据库路径的 HTTP 服务 (供 CLI / 原生 app 复用)。"""
    server = ThreadingHTTPServer((host, port), Handler)
    server.db_path = db_path  # type: ignore[attr-defined]
    return server


def main():
    ap = argparse.ArgumentParser(description="Cursor Chat Manager")
    ap.add_argument("--db", default=cdb.default_db_path(), help="state.vscdb 路径")
    ap.add_argument("--port", type=int, default=8848)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"[!] 找不到数据库: {args.db}")
        print("    用 --db 指定 state.vscdb 路径。")
        return

    server = create_server(args.db, args.host, args.port)

    url = f"http://{args.host}:{args.port}/"
    running = cdb.is_cursor_running()
    print("=" * 60)
    print("  Cursor Chat Manager")
    print(f"  数据库 : {args.db}")
    print(f"  地址   : {url}")
    print(f"  Cursor : {'正在运行 → 仅只读浏览, 删除/VACUUM 已禁用' if running else '未运行 → 可删除/回收空间'}")
    print("=" * 60)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
