# OpenClaw 核心架构与 Session 机制

> 更新时间：2026-03-09
> 基于 OpenClaw 本地源码验证

---

## 一、三层模型

OpenClaw 的核心设计可以概括为三层：

- **渠道层（Channel）**：消息从哪来、回哪去（Telegram、WhatsApp、Slack、WebChat 等）
- **大脑层（Agent）**：谁在思考（`main`、`work`、`family` 等独立 AI 个体）
- **记忆层（Session）**：对话写进哪本"聊天笔记本"

每个 agent 拥有独立的 workspace、sessions 存储和认证状态。`main` 只是默认 agentId，不比其他 agent 更"高级"。

---

## 二、Channel 插件体系

### 1. 插件注册

Channel 插件通过 `api.registerChannel({ plugin })` 注册，`ChannelPlugin` 是包含多个 adapter 的结构体：

- **`config`** — 账号配置（列出账号、解析账号）
- **`gateway`** — 启动/停止账号监听器（如 Telegram 的轮询/webhook）
- **`outbound`** — 发送回复（`sendText`、`sendMedia`、`sendPoll`）
- **`security`** — DM 策略、安全警告
- **`groups`** — 群组策略
- **`commands`** — 命令处理
- **`streaming`** — 流式响应控制
- 以及 `threading`、`mentions`、`actions` 等十余个可选 adapter

类型定义：`src/channels/plugins/types.plugin.ts`

### 2. 消息收发流程

**入站（用户 → Agent）：**

```
用户在 IM 发送消息
  → 监听器捕获消息
  → 构建 MessageContext（sender、chatType、peerId）
  → resolveAgentRoute() 确定目标 agent
  → buildAgentPeerSessionKey() 计算 session key
  → 安全检查（DM policy、allowlist、group policy）
  → 派发给对应 session 的 agent 执行
```

**出站（Agent → 用户）：**

```
Agent 生成回复
  → reply dispatcher 调度
  → channel outbound.sendText() 发送到 IM 平台 API
  → 自动分块、支持 threading/media/poll
```

### 3. 运行时服务

插件注册后，通过 `PluginRuntime` 获得运行时能力（`src/plugins/runtime/types-channel.ts`）：

| 服务 | 用途 |
|------|------|
| `channel.text` | 文本分块（markdown/plain） |
| `channel.reply` | 回复派发（含 typing 指示器） |
| `channel.routing` | agent 路由解析 |
| `channel.pairing` | 配对请求管理 |
| `channel.media` | 媒体下载/保存 |
| `channel.session` | session 元数据记录 |
| `channel.groups` | 群组策略解析 |
| `channel.commands` | 命令授权检查 |

### 4. WebChat 与 IM Channel 的核心差异

| 维度 | WebChat（内置 UI） | IM Channel（Telegram 等） |
|------|-------|----------|
| **本质** | 内置于 gateway 的 RPC 接口 | 通过插件 SDK 注册的 channel 插件 |
| **通信** | WebSocket 直连 gateway | 独立监听进程，轮询/webhook |
| **Session Key** | 调用方直接指定 | 由 `buildAgentPeerSessionKey()` 自动计算 |
| **流式响应** | 实时 delta 事件流 | block coalescing（合并缓冲） |
| **Media** | 内联 base64 | 下载/上传到平台 API |
| **特有能力** | `chat.abort`、`chat.inject`、历史加载 | reactions、polls、threading |

**关键区别**：WebChat 不经过 `buildAgentPeerSessionKey()`，session key 由调用方直接传入。

---

## 三、Session 机制

### 1. Session Key 与 Session ID

**Session Key**（逻辑路由标识）：
- 标识"对话桶"，决定消息归属到哪个上下文
- 格式如 `agent:main:main`、`agent:main:telegram:direct:123456`
- 存储位置：`~/.openclaw/agents/<agentId>/sessions/sessions.json` 的 map key
- 通常不变（除非修改路由配置）

**Session ID**（物理 transcript 标识）：
- UUID v4，标识具体的 transcript 文件
- 对应文件：`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- 每次 `/new` 或 `/reset` 生成新 UUID

**两者关系**：

```
sessions.json
┌──────────────────────────────────────────────┐
│ "agent:main:main" (sessionKey)                │
│   → { sessionId: "5c8e...", updatedAt, … }    │
│                                                │
│ "agent:main:telegram:direct:123" (sessionKey)  │
│   → { sessionId: "a1b2...", updatedAt, … }    │
└──────────────────────────────────────────────┘
                   ↓ 映射
      sessions/5c8e....jsonl   (transcript 文件)
      sessions/a1b2....jsonl   (transcript 文件)
```

- 一个 sessionKey 在任意时刻关联一个 sessionId
- **Orphan session**：transcript 文件存在，但 sessionKey 已从 sessions.json 中删除

### 2. Session Key 命名规则

核心函数 `buildAgentPeerSessionKey()`，源码 `src/routing/session-key.ts:127-174`。

**DM（直接消息）— 受 dmScope 控制：**

| dmScope | Session Key 格式 | 示例 |
|---------|-----------------|------|
| `"main"`（默认） | `agent:<agentId>:<mainKey>` | `agent:main:main` |
| `"per-peer"` | `agent:<agentId>:direct:<peerId>` | `agent:main:direct:123456` |
| `"per-channel-peer"` | `agent:<agentId>:<channel>:direct:<peerId>` | `agent:main:telegram:direct:123456` |
| `"per-account-channel-peer"` | `agent:<agentId>:<channel>:<accountId>:direct:<peerId>` | `agent:main:telegram:default:direct:123456` |

> 注：官方文档 (`docs/concepts/session.md`) 中用 `dm:<peerId>` 描述格式，但源码实际使用 `direct:<peerId>`。**以源码为准。**

**群组/频道 — 不受 dmScope 影响：**

| 类型 | 格式 | 示例 |
|------|------|------|
| 群组 | `agent:<agentId>:<channel>:group:<peerId>` | `agent:main:telegram:group:chat123` |
| 频道 | `agent:<agentId>:<channel>:channel:<peerId>` | `agent:main:discord:channel:general` |
| 帖子/话题 | 在基础 key 后追加 `:thread:<threadId>` | `agent:main:telegram:group:chat123:topic:5` |

**Cron Key：**

- `agent:main:cron:<jobId>`：cron job 级锚点 key
- `agent:main:cron:<jobId>:run:<runId/sessionId>`：单次运行快照 key

### 3. dmScope 详解

**dmScope 是全局设置**，配置在 `session.dmScope`，适用于所有 IM channel。不存在 per-channel 的 dmScope 设置。

```
                    dmScope 决策树（仅 DM）
                         │
             ┌───────────┼───────────────┐
             │           │               │
           "main"    "per-peer"    "per-channel-peer" / "per-account-..."
             │           │               │
     agent:main:main   agent:main:     agent:main:<channel>:
     (所有 DM 共享,     direct:<peer>   direct:<peer>
      含 WebChat)       (按人隔离)       (按 channel+人 隔离)
```

**适用于**：仅限 1:1 DM 消息。
**不适用于**：群组/频道、Cron jobs、WebChat（key 由调用方指定）、Thread/topic。

**dmScope = "main" 时的重要行为**：所有 IM channel 的 DM 和 WebChat 都使用 `agent:main:main`，共享同一个会话上下文。多人场景下存在隐私风险。

### 4. Identity Links（跨 Channel 身份关联）

配置 `session.identityLinks` 可实现跨 channel 身份关联：

```json5
{
  session: {
    dmScope: "per-peer",
    identityLinks: {
      alice: ["telegram:123", "whatsapp:+1234"]
    }
  }
}
```

此时 Alice 通过不同 channel 的 DM 都会路由到 `agent:main:direct:alice`。

实现逻辑：`src/routing/session-key.ts:176-220` 的 `resolveLinkedPeerId()`。当 `dmScope` 为 `"main"` 时跳过 identity links（已共享主 session）。

### 5. Session 生命周期

```
1. 创建 — 首次消息 → 计算 sessionKey → 生成 sessionId → 写入 sessions.json
2. 活跃 — 同一 sessionKey → 追加 transcript → 更新元数据
3. 重置 — /new 或 /reset → 旧 transcript 归档 → 生成新 sessionId → sessionKey 不变
4. 孤立 — 删除或配置变更 → sessionKey 从 sessions.json 移除 → transcript 文件留存
```

- `agent:main:main` 的 entry 是**按需创建**的，非启动时预置
- 自动 reset（freshness 失效）不会推送专门事件

---

## 四、Gateway 架构

### 1. 核心角色

Gateway 是**中央消息路由枢纽**，也是唯一持有 Channel 连接的进程：

- **统一接入点**：所有消息表面（IM 平台 + WebChat）的入口/出口
- **控制平面**：管理所有客户端（macOS app、CLI、Web UI、自动化）
- **Session 管理器**：维护对话状态
- **Agent 调度器**：路由入站消息到 agent，投递响应回 channel

### 2. WebSocket 连接管理

```
Client              Gateway
   |                  |
   |—— connect ———————>|
   |                  |—— validate auth
   |<—— connect.challenge ——|
   |—— (challenge response) ——>|
   |<—— hello-ok (with snapshot) ——|
   |<—— presence event ———————>|
   |<—— tick event (heartbeat) ——>|
```

- **心跳**：Gateway 每 30s 发送 `tick` 事件
- **断线检测**：tick 间隔 > 60s 视为中断
- **慢消费者保护**：socket `bufferedAmount` 超阈值 → 关闭（code 1008）
- **事件不重放**：断线后客户端需刷新状态
- **序列号追踪**：事件携带 `seq`，客户端检测间隙
- **指数退避重连**：初始 1000ms

### 3. 消息路由流程

```
入站 IM 消息
  ↓ 去重检查（recentUpdates 缓存）
  ↓ 顺序键处理（按 chat_id/topic_id 保持有序）
  ↓ 消息处理（提取内容、发送者验证、群组激活检查）
  ↓ 路由解析（resolveAgentRoute → Agent ID + Session key）
  ↓ Agent Run（加载上下文 → LLM 推理 → 工具执行 → 输出）
  ↓ 响应发送（分块、Markdown、threading、流式预览）
  ↓ 用户在 IM 中看到回复
```

---

## 五、关键源码索引

| 用途 | 文件路径 |
|------|---------|
| 插件 API 与类型 | `src/plugins/types.ts` |
| Channel 插件接口 | `src/channels/plugins/types.plugin.ts` |
| Adapter 定义 | `src/channels/plugins/types.adapters.ts` |
| Session Key 构建 | `src/routing/session-key.ts` |
| DM 策略逻辑 | `src/security/dm-policy-shared.ts` |
| 插件运行时类型 | `src/plugins/runtime/types-channel.ts` |
| Telegram 实现 | `extensions/telegram/src/channel.ts` |
| Gateway 核心 | `src/gateway/` |
| Session 管理 | `src/gateway/session-utils.ts` |
| 消息路由 | `src/gateway/server-chat.ts` |
| WebChat RPC | `src/gateway/server-methods/chat.ts` |
| Agent RPC | `src/gateway/server-methods/agent.ts` |
| 概念文档 | `docs/concepts/session.md` |
