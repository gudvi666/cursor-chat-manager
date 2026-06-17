#!/usr/bin/env bash
# 把 Cursor Chat Manager 打包成可双击运行的原生 .app (macOS)。
# 依赖: pip3 install pywebview pyinstaller
set -euo pipefail
cd "$(dirname "$0")"

echo "[*] 清理旧产物…"
rm -rf build dist "Cursor Chat Manager.spec"

echo "[*] PyInstaller 打包中…"
python3 -m PyInstaller --noconfirm --windowed \
  --name "Cursor Chat Manager" \
  --add-data "index.html:." \
  --add-data "static:static" \
  --collect-all webview \
  desktop.py

echo "[✓] 完成: dist/Cursor Chat Manager.app"
echo "    可直接双击运行，或拖到「应用程序」文件夹。"
