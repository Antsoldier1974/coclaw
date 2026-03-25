# WSL2 网络配置指南

> 适用场景：在 WSL2 中运行 OpenClaw gateway 的用户

## 为什么需要配置

WSL2 mirrored 网络模式默认阻止来自局域网的 UDP 入站流量。这会导致：

- WebRTC P2P 无法建立，所有连接走 TURN 中继（延迟更高、消耗服务器带宽）
- 局域网内的设备无法通过 UDP 直连 WSL2 中的服务

## 配置步骤

### 1. 开放 Hyper-V 防火墙（必须）

以管理员身份打开 PowerShell，执行：

```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
```

验证：

```powershell
Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
# 确认 DefaultInboundAction 为 Allow
```

### 2. 允许 Windows Defender 防火墙 UDP 入站（必须）

```powershell
New-NetFirewallRule -DisplayName "WSL2 UDP Inbound" -Direction Inbound -Protocol UDP -Action Allow -Profile Any
```

### 3. 确认 WSL2 使用 mirrored 网络模式

检查 `%USERPROFILE%\.wslconfig`，确保包含：

```ini
[wsl2]
networkingMode=Mirrored
```

修改后需重启 WSL2：

```powershell
wsl --shutdown
```

## 验证

配置完成后，在 WSL2 中运行：

```bash
# 获取 WSL2 的 LAN IP
ip addr show eth1 | grep 'inet '
```

然后从局域网内的其他设备（如手机）访问 `http://<WSL2-IP>:19999`（需先在 WSL2 中启动一个 HTTP 服务）。如果能访问，说明 TCP 连通。

> **注意**：截至 2026-03，即使完成以上配置，WSL2 mirrored 模式对来自 LAN 的 **新 UDP 入站** 仍可能存在限制（已建立连接的 UDP 返回流量不受影响）。如需完整的 UDP 入站支持，建议在原生 Linux 环境中运行 OpenClaw。

## 回滚

如需恢复默认设置：

```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Block
Remove-NetFirewallRule -DisplayName "WSL2 UDP Inbound"
```
