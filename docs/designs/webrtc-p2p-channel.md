# WebRTC P2P 数据通道设计

> 创建时间：2026-03-23
> 状态：草案
> 范围：UI ↔ Plugin 之间的 WebRTC DataChannel 通信方案，含 P2P 直连与 TURN 中继兜底

---

## 一、概述

### 背景

当前 UI 与 Plugin（OpenClaw 侧）的通信完全经由 CoClaw Server 中转（WebSocket）。对于 JSON-RPC 消息和小数据量场景，这已够用。但随着文件传输等大数据量需求的出现，Server 中转的带宽成本和延迟成为瓶颈。

### 目标

在 UI 与 Plugin 之间建立 WebRTC DataChannel，实现：

1. **优先 P2P 直连**：UI 和 Plugin 在网络允许时直接通信，不经过 Server
2. **TURN 中继兜底**：当 P2P 不可达时（NAT 限制、防火墙等），通过 TURN 服务器透明中继
3. **多通道隔离**：RPC 消息与文件传输走独立 DataChannel，互不阻塞
4. **对应用层透明**：无论 P2P 还是 TURN 中继，上层业务代码无需感知

### 核心设计原则

- **WebRTC 自身降级足够**：TURN 是 WebRTC 的内建兜底机制，只要 coturn 进程正常，数据一定能通。WebSocket 通道不承担数据传输的降级职责，职责分明
- **WebSocket 通道保留**：用于信令传输和其它业务交互（认证、元数据等），不承担 P2P 数据降级
- P2P / TURN 的选择由 ICE 框架自动完成，应用层不干预
- Server 仅承担信令转发和 TURN 凭证分发，不参与数据通道
- **Phase 1 仅建连不使用**：首阶段只实现基础设施和连接建立，现有业务仍走原有通道，DataChannel 不承载任何业务数据

### 术语

| 术语 | 含义 |
|------|------|
| Signaling | WebRTC 建连前交换 SDP 和 ICE Candidate 的过程，复用现有 WebSocket 通道 |
| STUN | 帮助端点发现自身公网地址的协议服务 |
| TURN | P2P 不可达时的数据中继服务 |
| ICE | 自动选择最优连接路径的框架（host → srflx → relay） |
| DataChannel | WebRTC 中用于传输任意数据的通道，基于 SCTP |
| connId | Server 为每个 WebSocket 连接分配的唯一标识，用于信令精确路由（见第六节） |

---

## 二、整体架构

```
Browser (UI)                    Server (coclaw.net)                Plugin (OpenClaw 侧)
     |                               |                                  |
     |--- WebSocket (signaling) ---->|<--- WebSocket (signaling) -------|
     |                               |                                  |
     |  GET /api/v1/turn/creds |  (TURN 凭证随 rtc:offer 注入)     |
     |<---- { urls, username, cred } |                                  |
     |                               |                                  |
     |        coturn (STUN+TURN) 同机部署                                |
     |                               |                                  |
     |====== DataChannel "rpc" (P2P 直连，优先) ========================>|
     |====== DataChannel "file:<id>" (临时，per-transfer) =============>|
     |                               |                                  |
     |====== DataChannel (经 TURN 中继，fallback) ======================>|
     |              ^                                                    |
     |              |_ 对应用层透明，代码完全相同                           |
```

### Server 的三个角色

| 角色 | 职责 | 实现方式 |
|------|------|---------|
| Signaling | 转发 SDP offer/answer 和 ICE Candidate | 现有 WebSocket，增加 `rtc:` 前缀消息类型 |
| STUN | 帮助 UI 和 Plugin 发现公网地址 | coturn（独立容器） |
| TURN | P2P 不通时透明中继数据 | coturn（同一实例） |

### 协议栈

```
应用数据（JSON-RPC / 文件分片）
  ↓
SCTP（消息分帧、可靠性、多流复用）
  ↓
DTLS（加密，WebRTC 强制）
  ↓
ICE（路径选择：直连 or TURN 中继）
  ↓
UDP（主要）/ TCP（降级）
```

---

## 三、技术选型

### Plugin 侧（Node.js）：werift

| 维度 | 说明 |
|------|------|
| 包名 | `werift` |
| 类型 | 纯 TypeScript/JavaScript 实现 |
| 优势 | 零原生依赖、跨平台无编译问题、`--ignore-scripts` 无影响 |
| 适用性 | DataChannel 传输 JSON-RPC 和文件，性能对个人 OpenClaw 场景足够 |

**选择理由**：OpenClaw 安装插件时执行 `npm install --ignore-scripts`，原生绑定库（如 `node-datachannel`）的 postinstall 下载预编译二进制会被跳过，可能导致加载失败。werift 纯 JS 实现完全规避此问题。

> 注意：werift 将是 `@coclaw/openclaw-coclaw` 插件的**第一个 runtime 依赖**（当前 `dependencies` 为空），会增加包体积和安装时间。

#### werift API 关键注意事项

| 注意点 | 说明 |
|--------|------|
| 导入路径 | `import { RTCPeerConnection } from 'werift'` |
| `iceServers.urls` | **必须是单个 `string`**，不是数组。每个 STUN/TURN URL 须拆分为独立对象 |
| W3C 兼容 | werift 同时提供 W3C 回调风格（`pc.onicecandidate`）和原生事件风格（`pc.onIceCandidate.subscribe`）。**统一使用 W3C 回调风格**，降低心智负担，且浏览器侧代码写法一致 |
| DataChannel 消息类型 | `dc.onmessage` 的 `event.data` 为 `string | Buffer`，注意 Buffer 处理 |
| 获取 candidate 类型 | 使用 werift 特有 API：`pc.iceTransports[0].connection.nominated?.localCandidate.type`（同步，无需 `getStats`） |
| 关闭 | `await pc.close()` 是异步方法 |

```javascript
// werift iceServers 配置示例 — 注意每个 URL 独立一个对象
const pc = new RTCPeerConnection({
	iceServers: [
		{ urls: `stun:${domain}:3478` },
		{ urls: `turn:${domain}:3478?transport=udp`, username, credential },
		{ urls: `turn:${domain}:3478?transport=tcp`, username, credential },
	],
});
```

### Browser 侧：原生 WebRTC API

浏览器内置 `RTCPeerConnection` + `RTCDataChannel`，无需额外依赖。

**Capacitor WebView 兼容性**：UI 在 Android/iOS 上通过 Capacitor WebView 运行（远程 URL 模式）。Android Chromium WebView 和 iOS WKWebView (14.3+) 均原生支持 WebRTC DataChannel API，无需额外 Capacitor 插件。DataChannel 不涉及媒体采集，不需要摄像头/麦克风权限。

### STUN/TURN 服务：coturn

工业标准实现（10+ 年历史），RFC 5389/5766 完整支持，Docker 官方镜像。

---

## 四、连接模型

### 呼叫方向与角色

- **UI 是主叫方**（Offerer）：创建 SDP offer 并发起连接
- **Plugin 是被叫方**（Answerer）：收到 offer 后回复 answer

原因：Plugin 可能不在线，由 UI 在确认 Plugin 在线后主动发起更自然；Plugin 侧无需感知何时有 UI 连入。

### 连接粒度

- 一个 UI 实例对一个 Plugin 建立**一条 PeerConnection**
- 同一用户多个浏览器 tab 各自独立建连（各有独立的 connId，信令精确路由）
- 同一 Plugin 可被多个 UI 实例连接

### 建连时机

UI 确认 Plugin 在线（WS 通道已连通）后，**自动发起** WebRTC 建连。不依赖用户操作。

---

## 五、数据通道设计

### 5.1 持久通道：`rpc`

| 属性 | 值 |
|------|-----|
| 通道名 | `rpc` |
| 创建时机 | WebRTC 连接建立时由 UI（主叫方）创建 |
| 生命周期 | 与 PeerConnection 相同 |
| 配置 | `ordered: true`（可靠有序） |
| 用途 | JSON-RPC 消息、文件操作控制消息（发起传输/确认完成/取消/错误通知） |

> Phase 1 阶段：`rpc` 通道创建但**不承载任何业务数据**，仅验证通道可达性。

### 5.2 临时通道：文件传输

> Phase 3 实现。此处仅描述目标设计。

每次文件传输创建一条独立的临时 DataChannel，传输完成后关闭。

| 属性 | 值 |
|------|-----|
| 通道名 | `file:<transferId>`（transferId 为 UUID，由发起方生成） |
| 创建方 | **谁发数据谁创建**（下载时 Plugin 创建，上传时 UI 创建） |
| 生命周期 | 创建 → 传输数据 → 发送方关闭（关闭即完成信号） |
| 配置 | `ordered: true`（可靠有序） |
| 分片 | 应用层分片（16-64KB，待实测确定最优值） |
| 流控 | 监听 `bufferedamountlow` 事件，避免发送缓冲区溢出 |

**选择临时通道 per-transfer 的理由**：
- DataChannel 创建极其廉价（仅新建 SCTP stream，无需重新 DTLS 握手）
- 天然隔离：多文件并发传输互不阻塞，无需应用层多路复用
- 生命周期清晰：open → 传数据 → close，无状态残留
- 流控天然：每条通道独立的 `bufferedAmount`，互不干扰

### 5.3 文件传输流程

> Phase 3 实现。此处仅描述目标设计。

**文件下载（UI 从 Plugin 读取）**：

```
UI (rpc)                                     Plugin
 |                                             |
 | { method: "file.read", path: "..." }  ----> |
 | <--- { transferId, fileName, size }         |
 |                                             |
 |    Plugin 创建 DataChannel file:<id>        |
 | <========= 分片数据 ======================= |
 | <========= 分片数据 ======================= |
 |              Plugin 关闭通道 (完成信号)       |
 |                                             |
 | UI 重组文件                                  |
```

**文件上传（UI 写入 Plugin）**：

```
UI (rpc)                                     Plugin
 |                                             |
 | { method: "file.write", path, size } -----> |
 | <--- { transferId }                         |
 |                                             |
 |    UI 创建 DataChannel file:<id>            |
 | =========== 分片数据 =====================> |
 | =========== 分片数据 =====================> |
 |              UI 关闭通道                      |
 |                                             |
 | <--- RPC 确认 { method: "file.writeOk" }    |
```

**双向对称**：将来 Plugin 主动发起传输时，机制完全相同，仅 RPC 请求方向反转，无需改协议结构。

---

## 六、信令协议

复用现有 WebSocket 通道，新增 `rtc:` 前缀消息类型。`rtc:` 前缀与 CoClaw 业务消息前缀明确区分。

### 6.1 connId 机制

**问题**：同一用户可能在多个浏览器 tab 连接同一个 bot（同一 botId 下 `uiSockets` 中有多个 socket）。WebRTC 信令是点对点的——Plugin 的 `rtc:answer` 必须精确投递到发起 offer 的那个 UI socket，而非广播给所有 tab。

**方案**：Server 在 WebSocket 连接建立时，为每个连接分配一个 `connId`（格式：`c_<随机hex>`，如 `c_a7f3`、`c_0b2e91`），挂在 socket 对象上。使用随机值而非自增整数，避免 Server 重启后计数器归零导致的理论碰撞风险。

**路由规则**：

| 方向 | 路由依据 | 说明 |
|------|---------|------|
| UI → Plugin | `botId`（从 WS 连接上下文取） | Plugin 通常只有一个 socket，直接投递 |
| Plugin → UI | `toConnId`（消息字段） | Server 在 `uiSockets.get(botId)` 中查找 `connId` 匹配的 socket |

**生命周期**：`connId` 与 WebSocket 连接同生同灭，WS 断开后自动失效。重连后获得新 `connId`。

### 6.2 信令消息类型

| 消息类型 | 方向 | 用途 |
|----------|------|------|
| `rtc:offer` | UI → Server → Plugin | SDP offer |
| `rtc:answer` | Plugin → Server → UI | SDP answer |
| `rtc:ice` | 双向 | ICE Candidate 交换 |
| `rtc:ready` | UI → Server | DataChannel 就绪通知 |
| `rtc:closed` | 双向 | WebRTC 连接断开通知 |

### 6.3 消息格式

```javascript
// SDP 交换（UI → Plugin）
{ type: "rtc:offer", payload: { sdp: "..." } }
// Server 转发时自动附上 fromConnId:
{ type: "rtc:offer", fromConnId: "c_a7f3", payload: { sdp: "..." } }

// SDP 交换（Plugin → UI）
{ type: "rtc:answer", toConnId: "c_a7f3", payload: { sdp: "..." } }

// ICE Candidate 交换（双向）
// UI → Plugin:
{ type: "rtc:ice", payload: { candidate: "...", sdpMid: "...", sdpMLineIndex: 0 } }
// Plugin → UI:
{ type: "rtc:ice", toConnId: "c_a7f3", payload: { candidate: "...", sdpMid: "...", sdpMLineIndex: 0 } }

// 连接状态通知（UI 发送时无 fromConnId，Server 转发时自动附上）
{ type: "rtc:ready" }   // → Plugin 收到: { type: "rtc:ready", fromConnId: "c_a7f3" }
{ type: "rtc:closed" }  // → Plugin 收到: { type: "rtc:closed", fromConnId: "c_a7f3" }
```

### 6.4 建连流程

```
UI (connId=c_a7f3)             Server                       Plugin
 |                            |                            |
 | GET /api/v1/turn/creds                            |
 |<--- { urls, user, cred } --|                            |
 |                            |                            |
 | -- rtc:offer ------------> | 附上 fromConnId + turnCreds
 |                            | -- rtc:offer ------------> |
 |                            |   (Plugin 从中取 TURN 凭证)  |
 |                            |                            |
 |                            | <-- rtc:answer             |
 | <-- rtc:answer ----------- |   (toConnId=c_a7f3, 定向投递)  |
 |                            |                            |
 | -- rtc:ice --------------> | -- rtc:ice --------------> |
 | <------------- rtc:ice --- | <------------- rtc:ice --- |
 |    （多轮交换）              |    （多轮交换）              |
 |                            |                            |
 |========= DataChannel 建立（P2P 或 TURN）===========>    |
 |                            |                            |
 | -- rtc:ready ------------> | -- rtc:ready ------------> |
```

Server 对 `rtc:*` 消息**仅做透传路由**，不解析 SDP/ICE 内容。路由逻辑：
- UI 来源（`onUiMessage`）：根据 socket 上下文的 `botId` 转发到 bot socket，并附上 `fromConnId`
- Plugin 来源（`onBotMessage`）：根据消息中的 `toConnId` 在 `uiSockets.get(botId)` 中定向投递

---

## 七、连接生命周期与恢复

### 7.1 ICE 层保活

WebRTC ICE 层自动发送 STUN Binding Indication（约 15-30s 间隔），维持 NAT 映射。**应用层不需要实现 ping/pong 心跳**。

### 7.2 连接恢复策略

优先使用 **ICE restart** 恢复连接，而非重建 PeerConnection：

| 连接状态 | 处理方式 |
|----------|---------|
| `disconnected` | 等待 ICE 层自动恢复（短暂网络抖动通常会自愈） |
| `failed` | 发起 ICE restart（`iceRestart: true`），在不重建 PeerConnection 的前提下重新协商路径 |
| ICE restart 失败 | 关闭 PeerConnection，全新建连 |

ICE restart 的优势：保留已建立的 DataChannel 和应用层状态，仅重新协商网络路径，恢复速度快。

### 7.3 TURN 凭证刷新

TURN 凭证有 TTL（默认 24h）。长时间在线的 UI 需要在到期前刷新：

- UI 在凭证剩余有效期不足 1h 时，向 Server 请求新凭证
- 下一次 ICE restart 时使用新凭证
- 正常连接期间不需要刷新（已建立的 TURN allocation 不受凭证过期影响）

### 7.4 WebSocket 通道保留

WebSocket 连接始终保持，职责：
1. **信令通道**：WebRTC 建连、ICE restart
2. **业务交互**：认证、元数据查询等 Server 相关操作
3. **Plugin-Server 连接**：Plugin 作为被叫方，其 WS 连接始终需要保持

> UI 与 Server 的 SSE 通道当前不动，后续再处理。

### 7.5 连接路径日志

WebRTC 建连成功后，记录实际使用的 ICE candidate 类型：

| candidate 类型 | 含义 |
|---------------|------|
| `host` | 局域网直连 |
| `srflx` | NAT 穿透后的 P2P 直连 |
| `relay` | 经 TURN 中继 |

此日志对自部署用户排查"到底走的是 P2P 还是 TURN 中继"至关重要。

---

## 八、Server 侧实现

### 8.1 TURN 凭证

WebRTC 双方都需要 ICE server 配置（含 TURN 凭证）来创建 `RTCPeerConnection`。凭证基于 Server 与 coturn 共享的 `TURN_SECRET` 通过 HMAC-SHA1 生成。

**UI 侧获取**：通过 REST API。

- **路径**：`GET /api/v1/turn/creds`
- **认证**：`requireSession`（内联于路由文件，与现有 `bot.route.js` 等一致）
- **路由文件**：新建 `server/src/routes/turn.route.js`，在 `app.js` 中以 `app.use('/api/v1/turn', turnRouter)` 挂载，路由内部处理 `GET /creds`
- **挂载位置**：`app.js` 现有路由在 `app.use('/api/v1/claws', clawRouter)` 之后（约 line 95），新增 `app.use('/api/v1/turn', turnRouter)` 即可
- **Nginx 无需改动**：现有 `/api/` 前缀 location 已覆盖

**完整路由实现**：

```javascript
// server/src/routes/turn.route.js
import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

function requireSession(req, res) {
	if (req.isAuthenticated?.() && req.user) return true;
	res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
	return false;
}

function genTurnCreds(identity, secret, ttl = 86400) {
	const timestamp = Math.floor(Date.now() / 1000) + ttl;
	const username = `${timestamp}:${identity}`;
	const hmac = crypto.createHmac('sha1', secret);
	hmac.update(username);
	const domain = process.env.APP_DOMAIN;
	return {
		username,
		credential: hmac.digest('base64'),
		ttl,
		urls: [
			`stun:${domain}:3478`,
			`turn:${domain}:3478?transport=udp`,
			`turn:${domain}:3478?transport=tcp`,
		],
	};
}

// 启动时校验：TURN_SECRET 未配置则阻止启动
const TURN_SECRET = process.env.TURN_SECRET;
if (!TURN_SECRET) {
	throw new Error('[coclaw] TURN_SECRET is required but not set');
}

// GET /api/v1/turn/creds
router.get('/creds', (req, res) => {
	if (!requireSession(req, res)) return;
	const userId = String(req.user.id ?? req.user);
	res.json(genTurnCreds(userId, TURN_SECRET));
});

export { router as turnRouter, genTurnCreds };
```

**HTTP 响应格式**：

```json
{
  "username": "1711234567:42",
  "credential": "base64hmac==",
  "ttl": 86400,
  "urls": [
    "stun:coclaw.net:3478",
    "turn:coclaw.net:3478?transport=udp",
    "turn:coclaw.net:3478?transport=tcp"
  ]
}
```

**Plugin 侧获取**：Server 在转发 `rtc:offer` 时**注入 TURN 凭证**到消息中，Plugin 无需单独调用 API。

```javascript
// Server 转发 rtc:offer 到 Plugin 时：
{
	type: "rtc:offer",
	fromConnId: "c_a7f3",
	payload: { sdp: "..." },
	turnCreds: {            // Server 注入
		username: "1711234567:bot_abc",
		credential: "base64...",
		ttl: 86400,
		urls: ["stun:...", "turn:..."]
	}
}
```

> `genTurnCreds` 由 `turn.route.js` 导出，`bot-ws-hub.js` 中 import 复用，避免重复实现。

### 8.2 信令转发

在 `bot-ws-hub.js` 中增加 `rtc:*` 类型的处理逻辑。

#### 8.2.1 connId 分配

**位置**：`bot-ws-hub.js` 的 UI socket 注册流程（`wsServer.handleUpgrade` 回调中 `role === 'ui'` 分支，当前约 line 430 `registerSocket(uiSockets, botId, ws)` 之后）。

```javascript
// 在 registerSocket(uiSockets, botId, ws) 之后立即分配：
ws.connId = 'c_' + crypto.randomBytes(4).toString('hex'); // 如 "c_a7f3e0b2"
```

需在文件头部 `import crypto from 'crypto'`。

**生命周期**：`connId` 仅活在 `ws` 对象上，WS 关闭后自动失效。不需要额外的 Map 存储。

#### 8.2.2 查找特定 UI socket

当前没有按 `connId` 查找 UI socket 的函数。新增：

```javascript
// bot-ws-hub.js — 新增辅助函数
function findUiSocketByConnId(botId, connId) {
	const set = uiSockets.get(String(botId));
	if (!set) return null;
	for (const ws of set) {
		if (ws.connId === connId && ws.readyState === 1) return ws;
	}
	return null;
}
```

#### 8.2.3 路由实现

**`onUiMessage` 增加分支**（当前约 line 323-362）：在现有 `ping` 处理之后、`rpc.req` 标准化之前，插入 `rtc:` 类型判断：

```javascript
// onUiMessage — 新增 rtc:* 处理（插入在 ping 处理之后）
if (type === 'rtc:offer' || type === 'rtc:ice' || type === 'rtc:ready' || type === 'rtc:closed') {
	payload.fromConnId = ws.connId;
	if (type === 'rtc:offer') {
		payload.turnCreds = genTurnCreds(String(botId), process.env.TURN_SECRET);
	}
	const sent = forwardToBot(botId, payload);
	if (!sent) {
		rtcLogDebug(`rtc message dropped, bot offline botId=${botId} type=${type}`);
	} else {
		if (type === 'rtc:offer') rtcLogInfo(`rtc:offer forwarded bot=${botId} connId=${ws.connId}`);
		else rtcLogDebug(`${type} forwarded bot=${botId} connId=${ws.connId}`);
	}
	return; // 不走后续的 req 标准化和转发
}
```

**`onBotMessage` 增加分支**（当前约 line 273-321）：在现有 `ping` 处理之后、`res`/`rpc.res` 处理之前：

```javascript
// onBotMessage — 新增 rtc:* 处理（插入在 ping 处理之后）
if (type === 'rtc:answer' || type === 'rtc:ice' || type === 'rtc:closed') {
	const target = findUiSocketByConnId(botId, payload.toConnId);
	if (target) {
		target.send(JSON.stringify(payload));
		if (type === 'rtc:answer') rtcLogInfo(`rtc:answer routed to connId=${payload.toConnId}`);
		else rtcLogDebug(`${type} routed to connId=${payload.toConnId}`);
	} else {
		rtcLogWarn(`rtc target not found botId=${botId} connId=${payload.toConnId}`);
	}
	return;
}
```

#### 8.2.4 日志辅助函数

与现有 `wsLogInfo`/`wsLogDebug` 模式对齐，在 `bot-ws-hub.js` 顶部新增：

```javascript
function rtcLogInfo(msg) { console.info(`[coclaw/rtc] ${msg}`); }
function rtcLogWarn(msg) { console.warn(`[coclaw/rtc] ${msg}`); }
function rtcLogDebug(msg) { if (WS_VERBOSE) console.debug(`[coclaw/rtc] ${msg}`); }
```

> 复用现有 `WS_VERBOSE`（`process.env.COCLAW_WS_DEBUG === '1'`）控制 debug 日志。

Server 不解析 SDP/ICE 内容，仅做路由。日志使用 `[coclaw/rtc]` 前缀（与现有 `[coclaw/ws]` 对齐），debug 级别日志受 `COCLAW_WS_DEBUG` 环境变量控制。

---

## 九、各端实现架构

### 9.1 Plugin 侧：WebRtcPeer 类

将 WebRTC 逻辑封装为独立的 `WebRtcPeer` 类（`plugins/openclaw/src/webrtc-peer.js`），由 `RealtimeBridge` 持有和协调。

**职责分离**：

```
RealtimeBridge
├── serverWs       — CoClaw Server WS 连接（信令 + 业务消息）
├── gatewayWs      — OpenClaw Gateway WS 连接（本地，不变）
└── webrtcPeer     — WebRTC PeerConnection 管理（新增）
```

**拆分理由**：
- `RealtimeBridge` 已有约 750 行，承担双 WS 管理和消息桥接，直接嵌入 WebRTC 逻辑会过于臃肿
- `WebRtcPeer` 可独立测试（mock werift 的 PeerConnection）
- 后续文件传输需要复杂的分片/流控逻辑，独立类更易扩展

#### 9.1.1 WebRtcPeer API 设计

Plugin 同时接受来自多个 UI（不同终端/tab）的连接，因此以 `connId` 为粒度管理多条 PeerConnection。

```javascript
// plugins/openclaw/src/webrtc-peer.js
import { RTCPeerConnection as WeriftRTCPeerConnection } from 'werift';

export class WebRtcPeer {
	/**
	 * @param {object} opts
	 * @param {function} opts.onSend - 回调，将信令消息交给 RealtimeBridge 发送
	 *   签名: (payload: object) => void
	 *   payload 示例: { type: 'rtc:answer', toConnId, payload: { sdp } }
	 * @param {object} [opts.logger] - 可选 logger（OpenClaw pino 风格）
	 * @param {function} [opts.PeerConnection] - 可替换的 PeerConnection 构造函数（测试用）
	 */
	constructor({ onSend, logger, PeerConnection }) {
		this.__onSend = onSend;
		this.logger = logger ?? console;
		this.__PeerConnection = PeerConnection ?? WeriftRTCPeerConnection;
		/** @type {Map<string, { pc: RTCPeerConnection, rpcChannel: RTCDataChannel|null }>} */
		this.__sessions = new Map(); // connId → { pc, rpcChannel }
	}

	/** 处理来自 Server 转发的信令消息 */
	async handleSignaling(msg) { ... }

	/** 关闭所有 PeerConnection，释放资源 */
	async closeAll() { ... }

	/** 关闭指定 connId 的 PeerConnection */
	async closeByConnId(connId) { ... }

	// --- 私有方法 ---
	async __handleOffer(msg) { ... }
	async __handleIce(msg) { ... }
	__setupDataChannel(connId, dc) { ... }
	__logDebug(message) { ... }
}
```

#### 9.1.2 handleSignaling 实现要点

```javascript
async handleSignaling(msg) {
	const connId = msg.fromConnId ?? msg.toConnId; // offer 用 fromConnId，ice 用任一
	if (msg.type === 'rtc:offer') {
		await this.__handleOffer(msg);
	} else if (msg.type === 'rtc:ice') {
		await this.__handleIce(msg);
	} else if (msg.type === 'rtc:ready' || msg.type === 'rtc:closed') {
		// Phase 1：仅日志
		this.__logDebug(`${msg.type} from ${connId}`);
		if (msg.type === 'rtc:closed') {
			await this.closeByConnId(connId);
		}
	}
}

async __handleOffer(msg) {
	const connId = msg.fromConnId;
	this.logger.info?.(`[coclaw/rtc] offer received from ${connId}, creating answer`);

	// 同一 connId 重复 offer → 先关闭旧连接（UI 侧重建场景）
	if (this.__sessions.has(connId)) {
		await this.closeByConnId(connId);
	}

	// 从 Server 注入的 turnCreds 构建 iceServers
	// werift 的 urls 必须是单个 string，每个 URL 独立一个对象
	const iceServers = [];
	if (msg.turnCreds) {
		const { urls, username, credential } = msg.turnCreds;
		for (const url of urls) {
			const server = { urls: url };
			if (url.startsWith('turn:')) {
				server.username = username;
				server.credential = credential;
			}
			iceServers.push(server);
		}
	}

	const pc = new this.__PeerConnection({ iceServers });
	const session = { pc, rpcChannel: null };
	this.__sessions.set(connId, session);

	// ICE candidate → 发给 UI
	pc.onicecandidate = ({ candidate }) => {
		if (!candidate) return;
		this.__onSend({
			type: 'rtc:ice',
			toConnId: connId,
			payload: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex },
		});
	};

	// 连接状态变更
	pc.onconnectionstatechange = () => {
		const state = pc.connectionState;
		this.logger.info?.(`[coclaw/rtc] [${connId}] connectionState: ${state}`);
		if (state === 'connected') {
			const nominated = pc.iceTransports?.[0]?.connection?.nominated;
			if (nominated) {
				const type = nominated.localCandidate?.type ?? 'unknown';
				this.logger.info?.(`[coclaw/rtc] [${connId}] ICE connected via ${type}`);
			}
		} else if (state === 'failed' || state === 'closed') {
			// 对端异常断开时自动清理
			this.__sessions.delete(connId);
		}
	};

	// 监听 UI 创建的 DataChannel（UI 是主叫方，创建 channel）
	pc.ondatachannel = ({ channel }) => {
		this.logger.info?.(`[coclaw/rtc] [${connId}] DataChannel "${channel.label}" received`);
		if (channel.label === 'rpc') {
			session.rpcChannel = channel;
			this.__setupDataChannel(connId, channel);
		}
	};

	// 处理 offer → 生成 answer
	await pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);

	this.__onSend({
		type: 'rtc:answer',
		toConnId: connId,
		payload: { sdp: answer.sdp },
	});
	this.logger.info?.(`[coclaw/rtc] answer sent to ${connId}`);
}

async __handleIce(msg) {
	const connId = msg.fromConnId;
	const session = this.__sessions.get(connId);
	if (!session) {
		this.__logDebug(`ICE candidate from ${connId} but no session`);
		return;
	}
	await session.pc.addIceCandidate(msg.payload);
	this.__logDebug(`[${connId}] ICE candidate added`);
}

__setupDataChannel(connId, dc) {
	dc.onopen = () => {
		this.logger.info?.(`[coclaw/rtc] [${connId}] DataChannel "${dc.label}" opened`);
	};
	dc.onclose = () => {
		this.logger.info?.(`[coclaw/rtc] [${connId}] DataChannel "${dc.label}" closed`);
		const session = this.__sessions.get(connId);
		if (session && dc.label === 'rpc') session.rpcChannel = null;
	};
	dc.onmessage = (event) => {
		// Phase 1：仅日志，不处理业务数据
		this.__logDebug(`[${connId}] DataChannel "${dc.label}" message: ${String(event.data).slice(0, 100)}`);
	};
}

async closeByConnId(connId) {
	const session = this.__sessions.get(connId);
	if (!session) return;
	this.__sessions.delete(connId);
	await session.pc.close();
	this.logger.info?.(`[coclaw/rtc] [${connId}] closed`);
}

async closeAll() {
	const closing = [...this.__sessions.keys()].map((id) => this.closeByConnId(id));
	await Promise.all(closing);
}

__logDebug(message) {
	if (typeof this.logger?.debug === 'function') {
		this.logger.debug(`[coclaw/rtc] ${message}`);
	}
}
```

#### 9.1.3 RealtimeBridge 适配

当前 `serverWs` 的消息处理（`realtime-bridge.js` 约 line 688-710）仅处理 `bot.unbound`、`req`、`rpc.req` 三种 type，其它 type 静默丢弃。

**变更 1：新增实例属性**

```javascript
// 构造函数中新增：
this.webrtcPeer = null;
```

**变更 2：serverWs message handler 增加 rtc: 分发**

在 `bot.unbound` 判断（约 line 692）之后、`req`/`rpc.req` 判断（约 line 699）之前插入：

```javascript
if (payload?.type?.startsWith('rtc:')) {
	if (!this.webrtcPeer) {
		this.webrtcPeer = new WebRtcPeer({
			onSend: (msg) => this.__forwardToServer(msg),
			logger: this.logger,
		});
	}
	try {
		await this.webrtcPeer.handleSignaling(payload);
	} catch (err) {
		this.logger.warn?.(`[coclaw/rtc] signaling error: ${err?.message}`);
	}
	return;
}
```

> WebRtcPeer 延迟创建（收到第一个 offer 时），避免 Plugin 无 UI 连接时的无用实例化。
> 使用 `startsWith('rtc:')` 统一匹配所有 rtc 消息类型（含 rtc:ready、rtc:closed）。
> 独立 try/catch 避免 werift 异常被外层误标为 "parse failed"。

**变更 3：清理**

在 `serverWs` close 事件处理中（现有 `__closeGatewayWs()` 旁），增加：

```javascript
if (this.webrtcPeer) {
	await this.webrtcPeer.closeAll();
	this.webrtcPeer = null;
}
```

**数据流向总结**：

```
[rtc:offer]  Server → serverWs.onmessage → webrtcPeer.handleSignaling()
[rtc:answer] webrtcPeer.__onSend() → __forwardToServer() → Server
[rtc:ice]    双向，同上述两条路径
[rtc:ready]  Server → webrtcPeer.handleSignaling()（仅日志）
[rtc:closed] Server → webrtcPeer.handleSignaling() → closeByConnId()
```

### 9.2 UI 侧：WebRtcConnection 类

新建 `WebRtcConnection` 类（`ui/src/services/webrtc-connection.js`），与 `BotConnection` 平级。

#### 9.2.1 BotConnection 适配（两处变更）

**变更 1：新增 `sendRaw(payload)` 方法**

```javascript
// bot-connection.js — 新增（与 request() 方法相邻）
/**
 * 发送非 RPC 原始消息（用于 WebRTC 信令等）
 * @param {object} payload - 完整消息对象，直接 JSON 序列化发送
 * @returns {boolean} 是否发送成功
 */
sendRaw(payload) {
	if (!this.__ws || this.__ws.readyState !== 1) return false;
	try {
		this.__ws.send(JSON.stringify(payload));
		return true;
	}
	catch { return false; }
}
```

**变更 2：`__onMessage` 增加 `rtc:` 分发**

在 `__onMessage` 方法中（约 line 223 `pong` 处理之后），增加：

```javascript
// rtc 信令消息 → 转发给 WebRtcConnection
if (payload?.type?.startsWith('rtc:')) {
	this.__emit('rtc', payload);
	return;
}
```

#### 9.2.2 WebRtcConnection API 设计

```javascript
// ui/src/services/webrtc-connection.js

export class WebRtcConnection {
	/**
	 * @param {string} botId
	 * @param {import('./bot-connection').BotConnection} botConn - 关联的 WS 连接
	 * @param {object} [opts]
	 * @param {function} [opts.PeerConnection] - 可替换的 RTCPeerConnection 构造函数（测试用，默认浏览器原生）
	 */
	constructor(botId, botConn, opts = {}) {
		this.botId = botId;
		this.__botConn = botConn;
		this.__PeerConnection = opts.PeerConnection ?? globalThis.RTCPeerConnection;
		this.__pc = null;            // RTCPeerConnection
		this.__rpcChannel = null;    // DataChannel "rpc"
		this.__state = 'idle';       // 'idle' | 'connecting' | 'connected' | 'failed' | 'closed'
		this.__candidateType = null; // 'host' | 'srflx' | 'relay' | null
		this.__onRtcMsg = null;      // BotConnection 上的 rtc 事件监听器引用
	}

	/** 状态（只读） */
	get state() { return this.__state; }
	get candidateType() { return this.__candidateType; }

	/** 发起 WebRTC 连接 */
	async connect(turnCreds) { ... }

	/** 关闭连接 */
	close() { ... }

	// --- 私有方法 ---
	__onSignaling(msg) { ... }
	__setState(s) { ... }
	__log(level, msg) { ... }
}
```

#### 9.2.3 connect() 实现要点

```javascript
async connect(turnCreds) {
	if (this.__state !== 'idle' && this.__state !== 'closed' && this.__state !== 'failed') return;
	this.__setState('connecting');

	// 构建 ICE 配置
	const iceServers = [];
	if (turnCreds) {
		for (const url of turnCreds.urls) {
			const s = { urls: url };
			if (url.startsWith('turn:')) {
				s.username = turnCreds.username;
				s.credential = turnCreds.credential;
			}
			iceServers.push(s);
		}
	}

	const pc = new this.__PeerConnection({ iceServers });
	this.__pc = pc;

	// ICE candidate → 通过 WS 发给 Plugin
	pc.onicecandidate = (event) => {
		if (!event.candidate) return;
		this.__botConn.sendRaw({
			type: 'rtc:ice',
			payload: event.candidate.toJSON(),
		});
	};

	// 连接状态
	pc.onconnectionstatechange = () => {
		const s = pc.connectionState;
		this.__log('info', `connectionState: ${s}`);
		if (s === 'connected') {
			this.__setState('connected');
			// 获取 candidate 类型
			pc.getStats().then((report) => {
				for (const stat of report.values()) {
					if (stat.type === 'candidate-pair' && stat.nominated) {
						for (const s2 of report.values()) {
							if (s2.type === 'local-candidate' && s2.id === stat.localCandidateId) {
								this.__candidateType = s2.candidateType;
								const label = s2.candidateType === 'relay' ? 'TURN' : 'P2P';
								this.__log('info', `ICE connected via ${s2.candidateType} (${label})`);
							}
						}
					}
				}
			});
		} else if (s === 'failed') {
			this.__setState('failed');
		} else if (s === 'closed') {
			this.__setState('closed');
		}
	};

	// 监听来自 Plugin 的信令响应
	this.__onRtcMsg = (msg) => this.__onSignaling(msg);
	this.__botConn.on('rtc', this.__onRtcMsg);

	// 创建 rpc DataChannel（UI 是主叫方）
	const dc = pc.createDataChannel('rpc', { ordered: true });
	this.__rpcChannel = dc;
	dc.onopen = () => {
		this.__log('info', 'DataChannel "rpc" opened');
		this.__botConn.sendRaw({ type: 'rtc:ready' });
	};
	dc.onclose = () => {
		this.__log('info', 'DataChannel "rpc" closed');
		this.__rpcChannel = null;
	};
	dc.onmessage = (event) => {
		// Phase 1：仅日志
		this.__log('debug', `DataChannel "rpc" message: ${String(event.data).slice(0, 100)}`);
	};

	// 创建并发送 offer
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	this.__botConn.sendRaw({
		type: 'rtc:offer',
		payload: { sdp: offer.sdp },
	});
	this.__log('info', `offer sent for bot ${this.botId}`);
}

__onSignaling(msg) {
	if (msg.type === 'rtc:answer') {
		this.__log('info', 'answer received, setting remote description');
		this.__pc?.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp });
	} else if (msg.type === 'rtc:ice') {
		this.__pc?.addIceCandidate(msg.payload).catch(() => {});
	}
}

close() {
	if (this.__onRtcMsg) {
		this.__botConn.off('rtc', this.__onRtcMsg);
		this.__onRtcMsg = null;
	}
	if (this.__pc) {
		this.__botConn.sendRaw({ type: 'rtc:closed' });
		this.__pc.close();
		this.__pc = null;
	}
	this.__rpcChannel = null;
	this.__setState('closed');
}

__setState(s) {
	if (this.__state === s) return;
	this.__state = s;
	// 同步更新 botsStore（见 9.2.4）
}

__log(level, msg) {
	console[level]?.(`[WebRTC] ${msg}`);
}
```

#### 9.2.4 botsStore 集成

**state 新增**（`bots.store.js` state() 中）：

```javascript
rtcStates: {},          // botId → 'idle' | 'connecting' | 'connected' | 'failed' | 'closed'
rtcCandidateTypes: {},  // botId → 'host' | 'srflx' | 'relay' | null
```

**WebRTC 连接实例管理**：不放在 store 中（store 存状态，不存实例），而是在 `webrtc-connection.js` 中维护一个模块级 Map：

```javascript
// ui/src/services/webrtc-connection.js（模块级）
const rtcInstances = new Map(); // botId → WebRtcConnection

/**
 * 为指定 bot 发起 WebRTC 连接
 * @param {string} botId
 * @param {BotConnection} botConn
 */
export async function initRtcForBot(botId, botConn) {
	// 幂等：已有连接且非 closed/failed 则跳过
	const existing = rtcInstances.get(botId);
	if (existing && existing.state !== 'closed' && existing.state !== 'failed') return;
	if (existing) existing.close();

	const rtc = new WebRtcConnection(botId, botConn);
	rtcInstances.set(botId, rtc);

	try {
		// 获取 TURN 凭证
		const resp = await axios.get('/api/v1/turn/creds');
		await rtc.connect(resp.data);
	}
	catch (err) {
		console.warn('[WebRTC] init failed for bot %s: %s', botId, err?.message);
		rtc.close();
		rtcInstances.delete(botId);
	}
}

/** 关闭指定 bot 的 WebRTC 连接 */
export function closeRtcForBot(botId) {
	const rtc = rtcInstances.get(botId);
	if (rtc) {
		rtc.close();
		rtcInstances.delete(botId);
	}
}
```

**触发时机**：在 `botsStore.__listenForReady()` 的 `fire()` 函数中（约 line 111），`checkPluginVersion` 之后调用：

```javascript
const fire = async (id, conn) => {
	const info = await checkPluginVersion(conn);
	this.pluginVersionOk = { ...this.pluginVersionOk, [id]: info.ok };
	this.pluginInfo = { ...this.pluginInfo, [id]: { version: info.version, clawVersion: info.clawVersion } };
	if (!info.ok) console.warn('[bots] plugin version outdated for botId=%s', id);

	// WebRTC 连接（非阻塞，不影响后续 agent/session 加载）
	initRtcForBot(id, conn).catch(() => {});

	await useAgentsStore().loadAgents(id);
	useSessionsStore().loadAllSessions();
	useTopicsStore().loadAllTopics();
};
```

**状态同步**：`WebRtcConnection.__setState()` 中直接更新 store：

```javascript
__setState(s) {
	if (this.__state === s) return;
	this.__state = s;
	const store = useBotsStore();
	store.rtcStates = { ...store.rtcStates, [this.botId]: s };
	if (this.__candidateType) {
		store.rtcCandidateTypes = { ...store.rtcCandidateTypes, [this.botId]: this.__candidateType };
	}
}
```

**清理时机**：在 `botsStore.removeBotById()` 和 `BotConnection.disconnect()` 的 `bot-unbound` 事件处理中调用 `closeRtcForBot(botId)`。

Phase 1 阶段这些状态仅用于展示和日志，不影响业务逻辑。

---

## 十、日志规范

各端在 WebRTC 相关操作中需记录关键状态变更日志，便于排查连接问题。

### 10.1 日志级别

| 级别 | 用途 |
|------|------|
| `info` | 关键状态变更（建连成功/失败、通道打开/关闭、连接路径类型） |
| `debug` | 辅助排查（SDP 摘要、ICE candidate 详情、状态机迁移） |

### 10.2 各端日志要点

**UI 侧**（`console.info` / `console.debug`，带 `[WebRTC]` 前缀，与现有 `[BotConn]` 标签风格一致）：
- `info`：offer 发起、answer 收到、DataChannel open/close、ICE 连接状态变更（connected/failed/closed）、最终 candidate 类型
- `debug`：ICE candidate 添加、SDP 类型和长度、ICE gathering 状态变更

**Plugin 侧**（通过 `this.logger.info?.()` / `__logDebug()` 模式，带 `[coclaw/rtc]` 前缀，与现有 `[coclaw]` 前缀和可选链调用风格一致）：
- `info`：offer 收到、answer 发出、DataChannel open/close、ICE 连接状态变更、最终 candidate 类型
- `debug`：ICE candidate 添加、PeerConnection 状态迁移

**Server 侧**（新增 `rtcLogInfo` / `rtcLogDebug` 辅助函数，带 `[coclaw/rtc]` 前缀，与现有 `wsLogInfo` / `wsLogDebug` 模式一致，debug 受 `COCLAW_WS_DEBUG` 控制）：
- `info`：connId 分配、`rtc:offer`/`rtc:answer` 转发（仅记录 connId 和 botId，不记录 SDP 内容）
- `debug`：`rtc:ice` 转发

### 10.3 示例

```
# UI 侧
[WebRTC] offer sent for bot bot_abc
[WebRTC] answer received, setting remote description
[WebRTC] ICE connected via srflx (P2P)
[WebRTC] DataChannel "rpc" opened

# Plugin 侧
[coclaw/rtc] offer received from c_a7f3, creating answer
[coclaw/rtc] [c_a7f3] ICE connected via relay
[coclaw/rtc] [c_a7f3] DataChannel "rpc" opened

# Server 侧
[coclaw/rtc] rtc:offer forwarded bot=bot_abc connId=c_a7f3
[coclaw/rtc] rtc:answer routed to connId=c_a7f3
```

---

## 十一、部署方案

### 11.1 coturn 容器

在 `deploy/compose.yaml` 中新增 coturn 服务：

```yaml
coturn:
  image: coturn/coturn:latest
  network_mode: host
  restart: unless-stopped
  logging: *default-logging
  volumes:
    - ./coturn/turnserver.conf.template:/etc/turnserver.conf.template:ro
  entrypoint: ["/bin/sh", "-c"]
  command:
    - |
      envsubst < /etc/turnserver.conf.template > /tmp/turnserver.conf
      exec turnserver -c /tmp/turnserver.conf
  environment:
    TURN_SECRET: ${TURN_SECRET}
    TURN_EXTERNAL_IP: ${TURN_EXTERNAL_IP}
    APP_DOMAIN: ${APP_DOMAIN}
    TURN_MIN_PORT: ${TURN_MIN_PORT:-50000}
    TURN_MAX_PORT: ${TURN_MAX_PORT:-50500}
```

**`network_mode: host` 的原因**：TURN 需要分配 relay 端口池（默认 50000-50500），逐个映射不现实。host 网络模式下 coturn 直接使用宿主机网络栈。

**注意**：host 网络模式下 coturn 不在 Docker bridge 网络中，与 server 容器不共享 compose 的内部 DNS。`TURN_SECRET` 通过 `.env` 同一变量分别传给 server 容器（用于 HMAC 计算）和 coturn（作为 `static-auth-secret`）。

**envsubst 机制**：`entrypoint` 在启动时将模板中的 `${VAR}` 替换为环境变量值，写入 `/tmp/turnserver.conf`，然后 `exec turnserver` 替换 shell 进程。coturn 官方镜像基于 Debian，通常含 `envsubst`（`gettext-base`），但 slim 变体可能不含。**部署时需验证**：`docker run --rm coturn/coturn:latest which envsubst`；若不存在，改用 `sed` 替换：

```sh
# envsubst 不可用时的替代方案
sed -e "s|\${TURN_SECRET}|$TURN_SECRET|g" \
    -e "s|\${TURN_EXTERNAL_IP}|$TURN_EXTERNAL_IP|g" \
    -e "s|\${APP_DOMAIN}|$APP_DOMAIN|g" \
    -e "s|\${TURN_MIN_PORT}|$TURN_MIN_PORT|g" \
    -e "s|\${TURN_MAX_PORT}|$TURN_MAX_PORT|g" \
    /etc/turnserver.conf.template > /tmp/turnserver.conf
```

**健康检查**：

```yaml
# 可选，稳定后启用
healthcheck:
  test: ["CMD", "turnutils_stunclient", "127.0.0.1"]
  interval: 30s
  timeout: 5s
  retries: 3
```

### 11.2 coturn 配置模板

`deploy/coturn/turnserver.conf.template`（注意文件名带 `.template` 后缀）：

```ini
listening-port=3478
external-ip=${TURN_EXTERNAL_IP}
realm=${APP_DOMAIN}
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SECRET}
min-port=${TURN_MIN_PORT}
max-port=${TURN_MAX_PORT}
fingerprint
no-cli
verbose
```

> 日志输出到 stdout（不配置 `log-file`），由 Docker json-file 日志驱动管理轮转。稳定后可去掉 `verbose`。

**TLS（TURN over TLS）— 当前未启用：**

```ini
# 启用条件：用户反馈 UDP 3478 被防火墙拦截。
# 启用前需注意：
# 1. coturn 容器需挂载证书卷（复用 certbot/conf）
# 2. certbot 续期脚本需增加 coturn 重启逻辑
# 3. coturn 重启会断开所有活跃的 TURN 中继连接（不支持优雅 reload）
# 4. 若需复用 443 端口，需在 nginx 层做 TLS 分流（SNI-based routing），复杂度较高
#
# tls-listening-port=5349
# cert=/etc/letsencrypt/live/<APP_DOMAIN>/fullchain.pem
# pkey=/etc/letsencrypt/live/<APP_DOMAIN>/privkey.pem
```

### 11.3 环境变量（.env）

在 `deploy/.env.example` 中新增：

```ini
# === TURN（WebRTC 中继）===
# 共享密钥（Server 与 coturn 间的认证密钥，用于生成临时 TURN 凭证）
# 生成方法: openssl rand -base64 32
TURN_SECRET=replace_with_strong_random_secret
# 服务器公网 IP（coturn 需要显式指定，用于 NAT 穿透）
TURN_EXTERNAL_IP=YOUR_PUBLIC_IP
# TURN 中继端口范围（500 个端口足以应对个人使用场景）
TURN_MIN_PORT=50000
TURN_MAX_PORT=50500
```

`TURN_SECRET` 和 `APP_DOMAIN` 需添加到 `compose.yaml` 中 server 容器的 `environment:` 块（现有模式为内联 `environment:` 而非 `env_file`）：

```yaml
# compose.yaml server 服务 environment 块新增：
TURN_SECRET: ${TURN_SECRET}
APP_DOMAIN: ${APP_DOMAIN}
```

coturn 通过 `turnserver.conf`（经 envsubst 替换）获取 `TURN_SECRET`，两侧使用同一个值。

### 11.4 防火墙/安全组

需开放以下端口：

| 端口 | 协议 | 用途 |
|------|------|------|
| 3478 | UDP + TCP | STUN/TURN 监听 |
| 50000-50500 | UDP | TURN relay 端口池 |

### 11.5 本地开发环境配置

本地开发时 UI 和 Plugin 通常在同一台机器（或同一局域网），ICE 会直接选择 `host` candidate 直连，**不依赖 STUN/TURN**。但 Server 启动需要 `TURN_SECRET`，且 TURN 凭证 API 需要正常返回。

**配置方式**：在 `server/.env`（或 `.env.development`）中设置：

```ini
# 本地开发用，随意值即可（不需要真实 coturn 运行）
TURN_SECRET=dev-secret-placeholder
APP_DOMAIN=localhost
```

**效果**：
- Server 正常启动，TURN 凭证 API 正常返回（凭证指向 `localhost:3478`）
- UI 和 Plugin 收到的 iceServers 包含 `stun:localhost:3478` 和 `turn:localhost:3478`
- 由于本地没有运行 coturn，STUN/TURN 候选不可达，ICE 框架会跳过它们，直接使用 `host` candidate 建连
- DataChannel 在 `host` 直连上正常工作

**不需要本地运行 coturn**：除非需要测试 TURN 中继路径（如模拟防火墙场景），否则本地开发无需启动 coturn 容器。

**测试 TURN 路径**（可选）：如需本地验证 TURN 中继，可启动 coturn 容器：

```bash
# 在 deploy/ 下
TURN_SECRET=dev-secret-placeholder TURN_EXTERNAL_IP=127.0.0.1 APP_DOMAIN=localhost \
  docker compose up coturn
```

此时在 `RTCPeerConnection` 配置中设置 `iceTransportPolicy: 'relay'` 可强制走 TURN 路径。

---

## 十二、分阶段实施计划

### Phase 1：基础设施（建连但不使用）

**目标**：WebRTC DataChannel 成功建立并保持连接，验证 P2P/TURN 通路可用。**DataChannel 不承载任何业务数据**，现有 RPC 和事件仍走原有 WS/SSE 通道。

#### Phase 1 实施任务清单

按依赖关系排序，箭头表示依赖。每步完成后运行对应模块的 `pnpm check` + `pnpm test`。

**Step 1：部署 — coturn 基础设施** （无代码依赖，可最先启动）

| 任务 | 文件 | 说明 |
|------|------|------|
| 1a | `deploy/coturn/turnserver.conf.template` | 新建 coturn 配置模板 |
| 1b | `deploy/compose.yaml` | 新增 coturn service |
| 1c | `deploy/.env.example` | 新增 TURN_* 环境变量说明 |
| 1d | 云平台安全组 | 开放 UDP 3478 + 50000-50500 |

验收：`docker compose up coturn`，`turnutils_stunclient <server-ip>` 返回 mapped address。

**Step 2：Server — TURN 凭证 API** （← Step 1 的 TURN_SECRET）

| 任务 | 文件 | 说明 |
|------|------|------|
| 2a | `server/src/routes/turn.route.js` | 新建，实现 `GET /creds` + `genTurnCreds` |
| 2b | `server/src/app.js` | 挂载 `turnRouter`（约 line 95 后新增一行） |
| 2c | `deploy/compose.yaml` | server environment 块新增 `TURN_SECRET`、`APP_DOMAIN` |
| 2d | `server/src/routes/turn.route.test.js` | 单元测试 |

验收：`curl -b session_cookie /api/v1/turn/creds` 返回有效凭证 JSON。

**Step 3：Server — 信令转发** （← Step 2 的 genTurnCreds 导出）

| 任务 | 文件 | 说明 |
|------|------|------|
| 3a | `server/src/bot-ws-hub.js` | 头部 `import crypto`，新增 `rtcLog*` 辅助函数 |
| 3b | 同上 | UI socket 注册处新增 `ws.connId` 分配 |
| 3c | 同上 | 新增 `findUiSocketByConnId()` 函数 |
| 3d | 同上 | `onUiMessage` 新增 `rtc:*` 路由分支 |
| 3e | 同上 | `onBotMessage` 新增 `rtc:*` 路由分支 |
| 3f | `server/src/bot-ws-hub.test.js` | 补充 connId 分配、rtc 路由、定向投递的测试 |

验收：两端 WS mock 客户端交换 rtc:offer/answer/ice，验证精确路由。

**Step 4：Plugin — WebRtcPeer** （← Step 3 的信令通路）

| 任务 | 文件 | 说明 |
|------|------|------|
| 4a | `plugins/openclaw/package.json` | `dependencies` 新增 `werift` |
| 4b | `plugins/openclaw/src/webrtc-peer.js` | 新建 WebRtcPeer 类 |
| 4c | `plugins/openclaw/src/webrtc-peer.test.js` | 单元测试（mock werift PeerConnection） |
| 4d | `plugins/openclaw/src/realtime-bridge.js` | 构造函数新增 `this.webrtcPeer = null`；serverWs handler 新增 rtc: 分发；close 时清理 |
| 4e | `plugins/openclaw/src/realtime-bridge.test.js` | 补充 rtc 消息分发到 WebRtcPeer 的测试 |

验收：Plugin 收到 mock offer → 产出 answer + ICE candidates。

**Step 5：UI — WebRtcConnection** （← Step 3 的信令通路）

| 任务 | 文件 | 说明 |
|------|------|------|
| 5a | `ui/src/services/bot-connection.js` | 新增 `sendRaw()`、`__onMessage` 增加 `rtc:` 分发 |
| 5b | `ui/src/services/bot-connection.test.js` | 补充 sendRaw 和 rtc 事件分发的测试 |
| 5c | `ui/src/services/webrtc-connection.js` | 新建 WebRtcConnection 类 + `initRtcForBot`/`closeRtcForBot` |
| 5d | `ui/src/services/webrtc-connection.test.js` | 单元测试（mock RTCPeerConnection） |
| 5e | `ui/src/stores/bots.store.js` | state 新增 `rtcStates`/`rtcCandidateTypes`；`__listenForReady` 中调用 `initRtcForBot`；`removeBotById` 中调用 `closeRtcForBot` |
| 5f | `ui/src/stores/bots.store.test.js` | 补充 rtc 状态相关测试 |

> Step 4 和 Step 5 无互相依赖，可并行开发。

验收：打开浏览器，Plugin 在线 → DevTools Console 可见 `[WebRTC] DataChannel "rpc" opened`。

**Step 6：端到端验证**

| 任务 | 说明 |
|------|------|
| 6a | 本地环境：UI + Plugin 同机，验证 host candidate 直连 |
| 6b | 部署环境：UI(外网) + Plugin(内网)，验证 srflx/relay 路径 |
| 6c | 多 tab：两个浏览器 tab 各自独立建连，互不干扰 |
| 6d | WS 断连恢复：断开 Plugin WS → 重连后 WebRTC 自动重建 |

### Phase 2：RPC 通道启用

- 将 JSON-RPC 消息迁移到 `rpc` DataChannel
- 连接恢复（ICE restart）
- TURN 凭证刷新机制

### Phase 3：文件传输

- 临时 DataChannel 文件传输（`file:<id>`）
- 应用层分片/重组/流控
- 传输进度通知

### Phase 4：稳定性与优化

- 连接质量监控
- TURN over TLS（按需启用）

---

## 十三、测试策略

### 13.1 各层测试方式

| 层 | 测试类型 | Mock 对象 | 关注点 |
|----|---------|----------|--------|
| `turn.route.js` | 单元测试 | `req`/`res` 对象 | HMAC 计算正确性、认证拦截、`TURN_SECRET` 缺失时启动报错 |
| `bot-ws-hub.js` (rtc) | 单元测试 | WS mock（`{ send, readyState, connId }` 对象） | connId 分配、`findUiSocketByConnId` 查找、offer 注入 turnCreds、answer 定向路由、ice 双向转发、target 不存在时的 warn 日志 |
| `WebRtcPeer` | 单元测试 | mock werift `RTCPeerConnection`（见下方） | offer→answer 流程、ICE candidate 回调→onSend 调用、DataChannel 事件、多 connId 并发、closeByConnId/closeAll 清理 |
| `WebRtcConnection` | 单元测试 | mock 浏览器 `RTCPeerConnection`（见下方） | connect 流程、信令收发、状态机转换、close 清理、幂等 connect |
| `BotConnection` 适配 | 单元测试 | 现有 WS mock | sendRaw 发送/失败、rtc: type 分发到 'rtc' 事件 |
| `botsStore` 集成 | 单元测试 | mock BotConnection + mock initRtcForBot | rtcStates/rtcCandidateTypes 更新、removeBotById 调用 closeRtcForBot |

### 13.2 Mock 模式

**Plugin 侧 — mock werift PeerConnection**：

```javascript
// webrtc-peer.test.js 中注入 mock
function createMockPC() {
	const pc = {
		onicecandidate: null,
		onconnectionstatechange: null,
		ondatachannel: null,
		connectionState: 'new',
		iceTransports: [{ connection: { nominated: null } }],
		setRemoteDescription: async () => {},
		createAnswer: async () => ({ sdp: 'mock-sdp-answer' }),
		setLocalDescription: async () => {},
		addIceCandidate: async () => {},
		close: async () => {},
	};
	return pc;
}
```

通过构造函数的依赖注入传入 mock（WebRtcPeer 需支持 `opts.PeerConnection` 可选参数，默认为 werift 的 `RTCPeerConnection`）：

```javascript
// webrtc-peer.js 构造函数调整
constructor({ onSend, logger, PeerConnection }) {
	this.__PeerConnection = PeerConnection ?? WeriftRTCPeerConnection;
	// ...
}
// __handleOffer 中使用 this.__PeerConnection 而非直接 import
const pc = new this.__PeerConnection({ iceServers });
```

**UI 侧 — mock 浏览器 RTCPeerConnection**：

```javascript
// webrtc-connection.test.js
class MockRTCPeerConnection {
	constructor() {
		this.onicecandidate = null;
		this.onconnectionstatechange = null;
		this.connectionState = 'new';
		this.localDescription = null;
	}
	createDataChannel(label, opts) {
		return { label, onopen: null, onclose: null, onmessage: null, readyState: 'connecting' };
	}
	async createOffer() { return { type: 'offer', sdp: 'mock-sdp' }; }
	async setLocalDescription(desc) { this.localDescription = desc; }
	async setRemoteDescription() {}
	async addIceCandidate() {}
	async getStats() { return new Map(); }
	close() { this.connectionState = 'closed'; }
}
```

同样通过依赖注入（`WebRtcConnection` 构造函数增加可选 `opts.PeerConnection`）。

### 13.3 验收标准

- 所有新增代码通过 `pnpm check`（lint）
- 单元测试通过 `pnpm test`
- 覆盖率不低于项目基线（lines/functions ≥ 70%，branches ≥ 60%）
- 端到端：浏览器 DevTools Console 可见完整建连日志链（offer → answer → ICE → DataChannel open → candidate 类型）

---

## 十四、风险与约束

> 原第十三节，因新增测试策略章节而顺延。

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| werift 性能不足 | 大文件传输速率受限 | 个人场景可接受；极端情况可切换到 node-datachannel |
| coturn 崩溃 | 所有 TURN 中继连接中断 | compose 自动重启 + 健康检查；P2P 直连不受影响 |
| coturn 重启断连 | TURN 中继连接中断 | 应用层 ICE restart 自动恢复 |
| 对称 NAT | P2P 无法直连 | TURN 自动兜底，对应用层透明 |
| 浏览器兼容性 | 极旧浏览器不支持 WebRTC | 现有 WS 通道保留，业务不受影响 |
| Capacitor WebView | iOS < 14.3 不支持 WebRTC | 目标用户设备版本远高于此，风险极低 |
| TURN 凭证过期 | 新连接/ICE restart 无法使用 TURN | UI 在过期前主动刷新凭证 |
| werift 作为首个 runtime 依赖 | 插件包体积增大、安装时间增长 | 纯 JS 实现，无原生编译开销，影响可控 |
