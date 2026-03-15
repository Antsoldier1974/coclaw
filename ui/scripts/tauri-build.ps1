# Tauri 构建 wrapper：自动加载 ~/.coclaw/keys/ 下的签名私钥
# 用法：
#   .\scripts\tauri-build.ps1                                          # 默认构建
#   .\scripts\tauri-build.ps1 --bundles nsis                           # Windows NSIS
#   .\scripts\tauri-build.ps1 --target universal-apple-darwin --bundles dmg  # macOS DMG

$ErrorActionPreference = "Stop"

$keyFile = if ($env:COCLAW_TAURI_KEY_FILE) { $env:COCLAW_TAURI_KEY_FILE } else { "$HOME\.coclaw\keys\tauri-updater.key" }

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    if (Test-Path $keyFile) {
        $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyFile -Raw
        Write-Host "[tauri-build] Loaded signing key from $keyFile"
    } else {
        Write-Warning "[tauri-build] No signing key found at $keyFile"
        Write-Warning "[tauri-build] Auto-update signing will be skipped."
        Write-Warning "[tauri-build] To fix: place your key at ~/.coclaw/keys/tauri-updater.key"
    }
}

pnpm tauri build @args
