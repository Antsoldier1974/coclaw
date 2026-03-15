#!/usr/bin/env bash
# Tauri 构建 wrapper：自动加载 ~/.coclaw/keys/ 下的签名私钥
# 用法：
#   ./scripts/tauri-build.sh              # 默认构建（当前 OS）
#   ./scripts/tauri-build.sh --bundles nsis   # Windows NSIS
#   ./scripts/tauri-build.sh --target universal-apple-darwin --bundles dmg  # macOS DMG

set -euo pipefail

KEY_FILE="${COCLAW_TAURI_KEY_FILE:-$HOME/.coclaw/keys/tauri-updater.key}"

# 若环境变量未设置，尝试从文件读取
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    if [ -f "$KEY_FILE" ]; then
        export TAURI_SIGNING_PRIVATE_KEY
        TAURI_SIGNING_PRIVATE_KEY=$(cat "$KEY_FILE")
        echo "[tauri-build] Loaded signing key from $KEY_FILE"
    else
        echo "[tauri-build] WARNING: No signing key found at $KEY_FILE"
        echo "[tauri-build] Auto-update signing will be skipped."
        echo "[tauri-build] To fix: place your key at ~/.coclaw/keys/tauri-updater.key"
    fi
fi

pnpm tauri build "$@"
