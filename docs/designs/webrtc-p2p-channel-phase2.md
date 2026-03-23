# WebRTC P2P 数据通道设计 — Phase 2：通信切换

> 创建时间：2026-03-23
> 状态：草案
> 前置文档：`webrtc-p2p-channel.md`（整体架构与 Phase 1）
> 范围：将 UI ↔ Plugin 的业务通信从 WS 中转切换为 RTC DataChannel 直连，WS 作为兜底

---

## 一、概述

### 目标

Phase 1 已建立 WebRTC DataChannel 基础设施（连接建立、信令、ICE 恢复）。Phase 2 的核心任务是**将业务 RPC 通信切换到 DataChannel**：

1. UI 优先通过 RTC DataChannel 与 Plugin 通信
2. 当 RTC 不可用时（严格网络环境等），自动降级到 WS 中转（与 Phase 1 行为一致）
3. Plugin 保持向后兼容，同时接受 RTC 和 WS 来源的请求

### 不在范围内

- 文件传输（Phase 3）
- APK 前后台切换导致的 JS 暂停 / WebRTC 断开（后续独立课题）
- 停止 Plugin 向 Server WS 的业务广播（Phase 2 完成后数天内单独处理）
- SSE 通道调整

---

## 二、消息流变更

### Phase 1（现状）

```
UI  ──req──> WS ──> Server ──> WS ──> Plugin ──> Gateway
UI  <──res── WS <── Server <── WS <── Plugin <── Gateway
UI  <─event─ WS <── Server <── WS <── Plugin <── Gateway
```

### Phase 2（RTC 模式）

```
UI  ──req──> DataChannel("rpc") ──────────────> Plugin ──> Gateway
UI  <──res── DataChannel("rpc") <────────────── Plugin <── Gateway
UI  <─event─ DataChannel("rpc") <────────────── Plugin <── Gateway

Plugin 同时将 res/event 广播给 Server WS（向后兼容，暂时保留），
Server 继续广播给 UI WS，但 UI 在 RTC 模式下忽略这些 WS 业务消息。
```

### Phase 2（WS 降级模式）

与 Phase 1 完全一致，RTC 不参与业务通信。

---

## 三、传输模式选择

### 核心原则

**传输模式一旦选定就固定**，不在两个通道之间动态切换。避免双通道并行处理和消息拼接的复杂度。

唯一的例外是 RTC 不可恢复时的降级（见第四节），这属于"放弃旧通道并切换"，而非两个通道并行。

### 选择流程

**首次连接**：

```
WS 首次连通
  → transportMode = null（连接中，不允许业务请求）
  → 异步发起 RTC 建连（initRtcAndSelectTransport）
  → 启动超时计时器（15 秒）

情况 A：RTC DataChannel open 事件在计时器内触发
  → transportMode = 'rtc'
  → 取消计时器

情况 B：计时器到期，RTC 未就绪
  → transportMode = 'ws'
  → 关闭/放弃 RTC 尝试
  → 日志：RTC 不可用，使用 WS
```

**WS 重连**（与首次不同）：

```
WS 重连
  → transportMode 保持不变（通常为 'ws'，或 RTC 仍健康则为 'rtc'）
  → 异步发起 RTC 建连（initRtcAndSelectTransport，内含防重入守卫）
  → RTC 仍健康 → 函数提前返回，什么都不做
  → RTC 不存在/已 failed → 后台尝试新建
    → 成功：原子切换 transportMode = 'rtc'
    → 超时/失败：transportMode 保持 'ws'，用户无感知
```

> 关键区别：WS 重连时 **不** 将 transportMode 重置为 null，避免阻塞用户操作。重连发生在无活跃请求的时刻（WS 断开时 pending 已被 reject），transport 切换是安全的。

> **关键**：transportMode 必须在 `dc.onopen`（DataChannel 实际可用）时设置，而非在 `pc.connectionState === 'connected'`（ICE/DTLS 就绪）时设置。两者通常几乎同时触发，但存在时序差异——若在 PC connected 时就设置 transportMode，可能在 DataChannel 尚未 open 时就发送 RPC，导致失败。

### 超时时间

**15 秒**。TURN relay 建连通常 2-5 秒，15 秒足够覆盖慢网络下的 TURN 协商，同时不让用户等待过久。

### 降级粘性

一旦降级到 WS，**当前 WS 连接生命周期内不再尝试 RTC**。避免反复切换。下次 WS 重连时重新尝试 RTC。

### 用户状态呈现

| transportMode | 用户看到 | 说明 |
|---|---|---|
| `null` | 连接中... | WS 已通，正在尝试 RTC |
| `'rtc'` | 已连接 | 可选：小图标标记 P2P / Relay |
| `'ws'` | 已连接 | 可选：小图标标记"中继模式" |
| RTC 恢复中 | 重连中... | ICE restart / rebuild 进行中 |

---

## 四、RTC 中途失败的降级处理

### 场景

`transportMode === 'rtc'`，RTC 连接在使用过程中不可恢复（ICE restart + full rebuild 均耗尽）。

### 处理

```
RTC 不可恢复
  → transportMode = 'ws'
  → reject 所有 viaRtc 的挂起请求（error code: RTC_LOST）
  → 后续请求自动走 WS
  → 用户可能需要重发消息
```

**不尝试续接正在进行的操作**。处理方式与当前 WS 断线重连一致：挂起请求失败，用户重发。

### Fallback 触发条件

| 触发 | 条件 | 说明 |
|---|---|---|
| RTC 建连超时 | 15 秒内 DataChannel 未就绪 | 严格网络环境，UDP/TURN 不通 |
| RTC 不可恢复 | ICE restart（2次）+ full rebuild（3次）全部耗尽 | 网络环境剧变 |

| **不**触发 | 条件 | 说明 |
|---|---|---|
| RTC `disconnected` | ICE 层自动恢复中 | 短暂抖动，通常自愈 |
| 单次 RTC `failed` | ICE restart 未耗尽 | 还有恢复机会 |
| WS 断开重连 | RTC 可能仍健康 | 不连带处理 |

---

## 五、RTC 连接生命周期

### 与 WS 解耦

Phase 1 中 RTC 生命周期绑定 WS。Phase 2 中 **RTC 独立管理**，WS 断开重连不影响健康的 RTC 连接。

```
WS 断开重连 ──────────────────────────────────────────────────────
  │
  │  若 RTC 仍然 connected → 无操作，RTC 继续工作
  │  若 RTC 不存在        → 重新执行传输选择流程
  │  若 RTC 已 failed     → 全新建连（full rebuild，新 connId）
  │

RTC 自身恢复 ─────────────────────────────────────────────────────
  │
  │  disconnected → 等 ICE 自动恢复
  │  failed       → ICE restart（需 WS 在线传信令）
  │              → 若 WS 此时也断了，等 WS 恢复后再 restart
  │  ICE restart 失败 → full rebuild
  │  full rebuild 耗尽 → 降级到 WS
```

### connId 跨 WS 重连

**问题**：WS 重连后 Server 分配新 `connId`，Plugin 侧 `WebRtcPeer.__sessions` 以旧 `connId` 为 key。

**方案**（最小改动）：

- RTC 仍健康（`connected`）：无需信令，无问题
- RTC 已 `failed`：直接 full rebuild（新 offer、新 connId），不尝试 ICE restart
  - 理由：WS 都断过了，网络拓扑可能已变，full rebuild 更可靠
- **ICE restart 仅在同一 WS 连接内使用**（connId 不变时）

### WS 重连后重新触发传输选择

**现状问题**：`bots.store.__listenForReady()` 注册的 WS `'state'` 监听器是**一次性**的——首次 `connected` 后立即移除。WS 断线重连时 state 再次变为 `connected`，但无人监听，不会重新触发 `initRtcForBot` 和传输选择。

**变更**：需要**持久**的 WS 状态监听器。将传输选择逻辑封装为独立函数 `initRtcAndSelectTransport(botId, conn)`，由持久监听器在每次 WS `connected` 时调用。

```javascript
// 注册一次，不移除，随 BotConnection 生命周期存在
conn.on('state', (state) => {
	if (state === 'connected') {
		initRtcAndSelectTransport(botId, conn);
	}
});
```

`initRtcForBot` 已有防重入守卫（RTC 健康时跳过），重复调用是安全的。传输选择定时器也在函数内部管理，重复调用时先清理旧定时器。

### initRtcForBot 防重入

现有守卫已满足需求：若该 bot 已有健康的 RTC 连接（非 `closed`/`failed` 状态），直接跳过。

### 恢复策略汇总

> 实现时需逐条覆盖。

| # | 场景 | 处理 |
|---|------|------|
| 1 | RTC `disconnected` | 等待 ICE 自动恢复，不做主动操作 |
| 2 | RTC `failed`，WS 在线且 connId 未变 | ICE restart（复用 PC），最多 2 次 |
| 3 | ICE restart 耗尽 | full rebuild（新 PC、新 offer），最多 3 次 |
| 4 | full rebuild 耗尽 | 降级到 WS（`transportMode = 'ws'`） |
| 5 | WS 断开，RTC 仍 `connected` | RTC 不动，用户可继续交互 |
| 6 | WS 重连，RTC 仍 `connected` | 跳过 `initRtcForBot`，transportMode 不变 |
| 7 | WS 重连，RTC 已 `failed` | 直接 full rebuild（新 connId，不尝试 ICE restart） |
| 8 | WS 断开，RTC 也 `failed` | 等 WS 恢复后 full rebuild |
| 9 | 业务请求时 transportMode 为 null | reject，UI 层提示"连接中" |

---

## 六、DataChannel 消息格式

复用现有 WS RPC 协议格式，无需定义新协议：

```javascript
// 请求（UI → Plugin）
{ type: "req", id: "ui-1711234567-1", method: "agent", params: { ... } }

// 响应（Plugin → UI）
{ type: "res", id: "ui-1711234567-1", ok: true, payload: { status: "accepted", runId: "..." } }

// 事件（Plugin → UI）
{ type: "event", event: "agent", payload: { runId: "...", stream: "assistant", data: { ... } } }
```

与 WS 通道完全一致，Plugin 侧处理逻辑可复用。

---

## 七、各端实现

### 7.1 UI 侧

#### 7.1.1 BotConnection 变更

`BotConnection` 内部完成传输层切换，所有上层消费者（chat.store、agents.store 等）继续使用 `botConn.request()` 和 `botConn.on('event:*')`，无需感知通道变化。

**新增字段与方法**：

```javascript
// 传输模式
__transportMode = null; // 'rtc' | 'ws' | null
__rtc = null;           // WebRtcConnection 引用

setRtc(rtcConn) { this.__rtc = rtcConn; }
clearRtc() { this.__rtc = null; }

setTransportMode(mode) {
	const prev = this.__transportMode;
	this.__transportMode = mode;

	// RTC → WS 降级：清理 RTC 侧的挂起请求
	if (prev === 'rtc' && mode === 'ws') {
		for (const [id, waiter] of this.__pending) {
			if (waiter.viaRtc) {
				clearTimeout(waiter.timer);
				const err = new Error('RTC connection lost');
				err.code = 'RTC_LOST';
				waiter.reject(err);
				this.__pending.delete(id);
			}
		}
	}
}
```

**修改 `request()`**：

```javascript
request(method, params = {}, options = {}) {
	if (this.__transportMode === 'rtc') {
		if (!this.__rtc?.isReady) {
			const err = new Error('RTC channel not ready');
			err.code = 'RTC_NOT_READY';
			return Promise.reject(err);
		}
		const id = `ui-${Date.now()}-${this.__counter++}`;
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, viaRtc: true };
			if (options.onAccepted) waiter.onAccepted = options.onAccepted;
			if (options.onUnknownStatus) waiter.onUnknownStatus = options.onUnknownStatus;
			const timeoutMs = options.timeout ?? DEFAULT_RPC_TIMEOUT_MS;
			waiter.timer = setTimeout(() => {
				this.__pending.delete(id);
				const err = new Error('rpc timeout');
				err.code = 'RPC_TIMEOUT';
				reject(err);
			}, timeoutMs);
			this.__pending.set(id, waiter);
			try {
				this.__rtc.send({ type: 'req', id, method, params });
			}
			catch {
				this.__pending.delete(id);
				clearTimeout(waiter.timer);
				const err = new Error('rtc send failed');
				err.code = 'RTC_SEND_FAILED';
				reject(err);
			}
		});
	}

	if (this.__transportMode === 'ws') {
		// 原有 WS 发送逻辑，保持不变，仅为 waiter 补上 viaRtc: false
		if (!this.__ws || this.__ws.readyState !== 1) {
			const err = new Error('not connected');
			err.code = 'WS_CLOSED';
			return Promise.reject(err);
		}
		const id = `ui-${Date.now()}-${this.__counter++}`;
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, viaRtc: false };
			// ... 其余与原逻辑完全一致
		});
	}

	// transportMode === null: 连接中
	const err = new Error('Not connected');
	err.code = 'NOT_CONNECTED';
	return Promise.reject(err);
}
```

**修改 `__onMessage()`（WS 消息处理）**：

```javascript
__onMessage(event) {
	let payload;
	try { payload = JSON.parse(String(event.data ?? '{}')); }
	catch { return; }

	// 系统消息始终处理
	if (payload?.type === 'pong') return;
	if (payload?.type?.startsWith('rtc:')) { this.__emit('rtc', payload); return; }
	if (payload?.type === 'session.expired') { /* 现有逻辑 */ return; }
	if (payload?.type === 'bot.unbound') { /* 现有逻辑 */ return; }

	// 业务消息（res / event）
	if (this.__transportMode === 'rtc') {
		// RTC 模式下忽略 WS 业务消息
		console.debug('[botConn] WS 业务消息忽略(RTC active):',
			payload.type, payload.id ?? payload.event ?? '');
		return;
	}

	// WS 模式或 transportMode === null：走原有逻辑
	if (payload?.type === 'event' && payload.event) {
		this.__emit(`event:${payload.event}`, payload.payload);
		return;
	}
	if (payload?.type === 'res' && payload.id) {
		this.__handleRpcResponse(payload);
	}
}
```

**新增 `__onRtcMessage()`**（由 WebRtcConnection DataChannel 回调）：

```javascript
__onRtcMessage(payload) {
	if (this.__transportMode !== 'rtc') return;

	if (payload.type === 'res' && payload.id) {
		this.__handleRpcResponse(payload);
	} else if (payload.type === 'event' && payload.event) {
		this.__emit(`event:${payload.event}`, payload.payload);
	}
}
```

> `__handleRpcResponse` 是纯 ID 匹配逻辑，与传输方式无关，RTC 和 WS 消息共享此方法无问题。

**修改 WS 断开时的 pending 清理**：

> **重要**：现有 `__rejectAllPending()` 在 WS close 事件和 `__cleanup()` 中调用，会无差别 reject 所有挂起请求。当 `transportMode === 'rtc'` 时，WS 断开不应影响通过 RTC 发出的请求。

```javascript
// WS close 事件处理中，替换原有的 __rejectAllPending 调用：
if (this.__transportMode === 'rtc') {
	// RTC 模式下 WS 断开不影响 RTC 请求，仅清理 WS 请求（理论上没有）
	for (const [id, waiter] of this.__pending) {
		if (!waiter.viaRtc) {
			clearTimeout(waiter.timer);
			const err = new Error('connection closed');
			err.code = 'WS_CLOSED';
			waiter.reject(err);
			this.__pending.delete(id);
		}
	}
} else {
	this.__rejectAllPending('connection closed');
}
```

`__cleanup()` 中的 `__rejectAllPending` **不需要**此判断——它仅在 `disconnect()` 和 `bot.unbound` 等完整拆除场景调用，此时 RTC 也会被一并关闭，应 reject 所有 pending。

> **关键设计点**：当 `transportMode === 'ws'` 时，消息收发路径与 Phase 1 完全一致，没有任何新代码参与。WS fallback 不是"新功能"，而是"不启用新功能"。

#### 7.1.2 WebRtcConnection 变更

**新增 API**：

```javascript
// 通过 DataChannel 发送 JSON
send(payload) {
	this.__rpcChannel.send(JSON.stringify(payload));
}

// DataChannel 是否可用
get isReady() {
	return this.__rpcChannel?.readyState === 'open';
}
```

**新增 `onReady` 回调**（通知 DataChannel 实际可用）：

```javascript
// 构造函数中
this.onReady = null;  // 新增

// dc.onopen 回调中（__setupDataChannelEvents 或 __buildPeerConnection 中的 dc.onopen）
dc.onopen = () => {
	this.__log('info', 'DataChannel "rpc" opened');
	this.__botConn.sendRaw({ type: 'rtc:ready' });
	this.onReady?.();  // 新增：通知外部 DataChannel 可用
};
```

**修改 `dc.onmessage`**（Phase 1 仅日志 → Phase 2 回调 BotConnection）：

```javascript
dc.onmessage = (event) => {
	try {
		const payload = JSON.parse(event.data);
		this.__botConn.__onRtcMessage(payload);
	} catch (err) {
		console.warn('[rtc] DataChannel 消息解析失败:', err);
	}
};
```

#### 7.1.3 传输选择编排函数

将传输选择逻辑封装在 `webrtc-connection.js` 中的模块级函数，由 `bots.store` 调用：

```javascript
/**
 * 为 bot 初始化 RTC 并执行传输选择
 * WS 每次连通时调用；内含防重入守卫
 */
export async function initRtcAndSelectTransport(botId, botConn) {
	// 防重入：现有 RTC 健康则跳过
	const existing = rtcInstances.get(botId);
	if (existing && existing.state !== 'closed' && existing.state !== 'failed') return;
	if (existing) existing.close();

	const rtc = new WebRtcConnection(botId, botConn);
	rtcInstances.set(botId, rtc);

	// 传输选择：15 秒内 DataChannel open → RTC，否则 → WS
	let settled = false;
	const fallbackTimer = setTimeout(() => {
		if (settled) return;
		settled = true;
		console.warn('[rtc] RTC 建连超时，降级到 WS botId=%s', botId);
		rtc.close();
		rtcInstances.delete(botId);
		botConn.clearRtc();
		botConn.setTransportMode('ws');
	}, 15_000);

	rtc.onReady = () => {
		if (settled) return;
		settled = true;
		clearTimeout(fallbackTimer);
		botConn.setRtc(rtc);
		botConn.setTransportMode('rtc');
	};

	// RTC 不可恢复时降级
	rtc.onStateChange = () => {
		// 同步状态到 store（复用现有 getBotsStore 模式）
		getBotsStore().then((store) => {
			store.rtcStates = { ...store.rtcStates, [botId]: rtc.state };
			if (rtc.candidateType) {
				store.rtcCandidateTypes = { ...store.rtcCandidateTypes, [botId]: rtc.candidateType };
			}
		}).catch(() => {});

		// state === 'failed' 仅在所有恢复尝试（ICE restart + full rebuild）耗尽后才被设置
		if (rtc.state === 'failed') {
			botConn.clearRtc();
			botConn.setTransportMode('ws');
		}
	};

	try {
		const resp = await httpClient.get('/api/v1/turn/creds');
		await rtc.connect(resp.data);
	} catch (err) {
		if (settled) return;
		settled = true;
		clearTimeout(fallbackTimer);
		console.warn('[rtc] init failed, 降级到 WS botId=%s: %s', botId, err?.message);
		rtc.close();
		rtcInstances.delete(botId);
		botConn.clearRtc();
		botConn.setTransportMode('ws');
	}
}
```

#### 7.1.4 bots.store 变更

**持久监听 WS 状态**（替换原有的一次性监听）：

```javascript
// __listenForReady 中，对每个 bot 注册持久监听器
// 首次 connected 时执行完整初始化（loadAgents 等），后续 connected 仅重新触发传输选择
const initializedBots = new Set(); // 模块级

conn.on('state', (state) => {
	if (state !== 'connected') return;

	if (!initializedBots.has(id)) {
		initializedBots.add(id);
		catchFire(id, conn);  // 完整初始化（含传输选择）
	} else {
		// WS 重连：仅重新触发传输选择
		initRtcAndSelectTransport(id, conn).catch(() => {});
	}
});
```

> `initRtcForBot` 调用点改为 `initRtcAndSelectTransport`（后者包含前者的逻辑 + 传输选择定时器）。

**注意**：`removeBotById()` 中需增加 `initializedBots.delete(id)` 清理，否则 bot 被移除后重新添加时会被误判为"已初始化"，跳过 `catchFire`（loadAgents 等完整初始化）。

### 7.2 Plugin 侧

#### 7.2.1 WebRtcPeer 变更

**构造函数新增 `onRequest` 回调**：

```javascript
constructor({ onSend, onRequest, logger, PeerConnection }) {
	this.__onRequest = onRequest; // (payload, connId) => void
	// ... 其余不变
}
```

**新增 `broadcast()`**：

```javascript
// 向所有已打开的 rpcChannel 广播
broadcast(payload) {
	const data = JSON.stringify(payload);
	for (const [connId, session] of this.__sessions) {
		const dc = session.rpcChannel;
		if (dc?.readyState === 'open') {
			try { dc.send(data); }
			catch (err) { this.__logDebug(`[${connId}] broadcast 发送失败: ${err.message}`); }
		}
	}
}
```

**修改 `__setupDataChannel()`**：

```javascript
__setupDataChannel(connId, dc) {
	dc.onopen = () => { /* 不变 */ };
	dc.onclose = () => { /* 不变 */ };
	dc.onmessage = (event) => {
		try {
			const raw = typeof event.data === 'string' ? event.data : event.data.toString();
			const payload = JSON.parse(raw);
			if (payload.type === 'req') {
				this.__onRequest?.(payload, connId);
			} else {
				this.__logDebug(`[${connId}] 未知 DC 消息类型: ${payload.type}`);
			}
		} catch (err) {
			this.logger.warn?.(`[coclaw/rtc] [${connId}] DC 消息解析失败: ${err.message}`);
		}
	};
}
```

#### 7.2.2 RealtimeBridge 变更

**创建 WebRtcPeer 时传入 `onRequest`**：

```javascript
this.webrtcPeer = new WebRtcPeer({
	onSend: (msg) => this.__forwardToServer(msg),
	onRequest: (payload, connId) => {
		// 复用现有的 gateway 请求处理
		void this.__handleGatewayRequestFromServer(payload);
	},
	logger: this.logger,
});
```

**gateway 响应/事件转发增加 RTC 广播**：

在 gateway WS message handler 中（`realtime-bridge.js` 约 line 515-517），`gatewayReady` 后转发 `res`/`event` 的位置：

```javascript
// 现有（line 517）
this.__forwardToServer(payload);
// 新增
this.webrtcPeer?.broadcast(payload);
```

> 内部 RPC 响应（ID 在 `gatewayPendingRequests` 中的）在 line 500-510 已被拦截消费并 `return`，不会到达此处，不会被误广播。

**`__handleGatewayRequestFromServer` 合成的错误响应也需广播**：

> **重要**：当 gateway 不可用时，此方法合成 `GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED` 错误响应，仅通过 `__forwardToServer()` 发送到 Server WS。如果请求来自 RTC DataChannel，UI 在 RTC 模式下忽略 WS 业务消息，永远收不到此错误，请求会挂至超时。

```javascript
// __handleGatewayRequestFromServer 中的两处错误响应，追加 broadcast：
const errorRes = {
	type: 'res', id: payload.id, ok: false,
	error: { code: 'GATEWAY_OFFLINE', message: 'Gateway is offline' },
};
this.__forwardToServer(errorRes);
this.webrtcPeer?.broadcast(errorRes);  // 新增
```

> 注意：不能将 `__forwardToServer` 统一替换为"forward + broadcast"的 helper，因为 `__forwardToServer` 也被 `WebRtcPeer.onSend` 用于回传 RTC 信令消息（`rtc:answer`、`rtc:ice`），信令消息不应广播到 DataChannel。**仅在转发 gateway 业务响应/事件和合成错误响应的位置追加 broadcast。**

### 7.3 Server 侧

**无变更。**

继续转发 `rtc:*` 信令消息，继续透传 Plugin → UI 的业务消息。

---

## 八、边界情况

| 场景 | 处理 |
|------|------|
| RTC 未就绪时用户发消息 | `request()` reject（code: `NOT_CONNECTED`），UI 层提示"连接中" |
| RTC 中途断开（可恢复） | 挂起请求保持等待；RTC ICE restart / rebuild 触发；恢复后继续 |
| RTC 中途断开（不可恢复） | 降级到 WS；reject 所有 `viaRtc` 挂起请求（code: `RTC_LOST`）；用户重发 |
| WS 断开但 RTC 健康 | 业务正常（走 RTC）；WS pending 请求清理时跳过 `viaRtc` 请求 |
| WS 断开导致 `__rejectAllPending` | 仅 reject `viaRtc === false` 的请求，保留 `viaRtc === true` 的请求 |
| 多 tab 同时连接 | 各 tab 独立 DataChannel，Plugin broadcast 全部发送；各 tab 按 ID / runId 过滤 |
| Plugin 重启 | 所有 RTC 断开，UI 走恢复流程，最终 full rebuild 或 WS 降级 |
| DataChannel 消息大小 | 单条 JSON-RPC 远小于 256KB 限制；agent streaming 事件逐条推送，每条都小 |
| Plugin 内部 RPC 响应 | ID 在 `gatewayPendingRequests` 中（前缀 `coclaw-gw-*` / `coclaw-agent-*`），被 plugin 内部消费后 `return`，不广播 |
| Plugin 合成的错误响应 | `GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED` 同时发给 Server WS 和 RTC broadcast |
| 两阶段 `agent` 请求中 RTC 断开 | pending request reject → `chat.store` 的 `Promise.race` 捕获错误 → 清理 event listener → 用户重发 |

---

## 九、变更影响汇总

### 需要实施的模块

| 模块 | 变更量 | 需实施 | 说明 |
|---|---|---|---|
| `ui/services/bot-connection.js` | 中等 | 是 | `setTransportMode()` + `request()` 分支 + `__onRtcMessage` + WS 消息过滤 + WS close pending 清理 |
| `ui/services/webrtc-connection.js` | 低 | 是 | `send()` + `isReady` + `onReady` 回调 + `dc.onmessage` 改为回调 BotConnection |
| `ui/stores/bots.store.js` | 低-中 | 是 | 持久 WS 监听器 + 传输选择编排 |
| `plugins/openclaw/src/webrtc-peer.js` | 低 | 是 | `onRequest` + `broadcast()` + `dc.onmessage` 解析 |
| `plugins/openclaw/src/realtime-bridge.js` | 低 | 是 | `onRequest` 接入 + 两处 `broadcast()` 调用 + 错误响应 broadcast |
| `server/` | 零 | 否 | 无变更 |

### 实施顺序建议

1. **Plugin 侧**（独立，无 UI 依赖）：WebRtcPeer 变更 → RealtimeBridge 变更 → 测试
2. **UI 侧**（依赖 Plugin 侧完成）：BotConnection 变更 → WebRtcConnection 变更 → bots.store 编排 → 测试
3. **端到端验证**
