#!/usr/bin/env python3
"""Cursor Chat Manager —— 原生桌面 App 入口。

用 pywebview 在系统原生 WebView 里打开界面 (macOS 用内置 WKWebView)，
内部跑一个仅绑定 127.0.0.1 的本地引擎，对用户完全不可见——体验就是一个独立 App，
不开浏览器、没有地址栏。

运行:
    python3 desktop.py
首次需安装依赖:
    pip3 install pywebview
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
import threading

import cursor_db as cdb
from app import create_server


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    ap = argparse.ArgumentParser(description="Cursor Chat Manager (桌面版)")
    ap.add_argument("--db", default=cdb.default_db_path(), help="state.vscdb 路径")
    args = ap.parse_args()

    try:
        import webview
    except ImportError:
        sys.stderr.write(
            "未安装 pywebview。请先运行:\n    pip3 install pywebview\n再启动 python3 desktop.py\n")
        sys.exit(1)

    port = _free_port()
    server = create_server(args.db, "127.0.0.1", port)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    running = cdb.is_cursor_running()
    title = "Cursor Chat Manager" + ("（只读：Cursor 运行中）" if running else "")
    webview.create_window(
        title,
        f"http://127.0.0.1:{port}/",
        width=1320,
        height=880,
        min_size=(960, 600),
    )
    webview.start()


if __name__ == "__main__":
    main()
