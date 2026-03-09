# OpenClaw Channel 插件机制深度分析

> 日期：2026-03-07
> 状态：研究文档
> 涉及模块：OpenClaw 核心、Channel 插件、WebChat

## 一、核心机制与消息流程

### 1. Channel 插件注册

Channel 插件通过 `api.registerChannel({ plugin })` 注册，`ChannelPlugin` 是一个包含多个 adapter 的结构体：

- **`config`** — 账号配置（列出账号、解析账号）
- **`gateway`** — 启动/停止账号的监听器（如 Telegram 的轮询/webhook）
- **`outbound`** — 发送回复（`sendText`、`sendMedia`、`sendPoll`）
- **`security`** — DM 策略、安全警告
- **`groups`** — 群组策略
- **`commands`** — 命令处理
- **`streaming`** — 流式响应控制
- 以及 `threading`、`mentions`、`actions` 等十余个可选 adapter

`ChannelPlugin` 完整类型定义位于 `src/channels/plugins/types.plugin.ts`。

### 2. 消息收发流程（以 Telegram 为例）

**入站（用户 → Agent）：**

```
用户在 Telegram 发送消息
  → 监听器（polling/webhook）捕获消息
  → 构建 MessageContext（提取 sender、chatType、peerId）
  → resolveAgentRoute() 确定目标 agent
  → buildAgentPeerSessionKey() 计算 session key
  → 安全检查（DM policy、allowlist、group policy）
  → 派发给对应 session 的 agent 执行
```

**出站（Agent → 用户）：**

```
Agent 生成回复
  → reply dispatcher 调度
  → channel 的 outbound.sendText() 将回复发送到 Telegram API
  → 自动分块（Telegram 限 4000 字符）、支持 threading/media/poll
```

### 3. 关键源码文件

| 用途 | 文件路径 |
|------|---------|
| 插件 API 与类型 | `src/plugins/types.ts` |
| Channel 插件接口 | `src/channels/plugins/types.plugin.ts` |
| Adapter 定义 | `src/channels/plugins/types.adapters.ts` |
| Session Key 构建 | `src/routing/session-key.ts` |
| DM 策略逻辑 | `src/security/dm-policy-shared.ts` |
| Telegram 实现 | `extensions/telegram/src/channel.ts` |
| Telegram 消息上下文 | `src/telegram/bot-message-context.ts` |
| 插件运行时类型 | `src/plugins/runtime/types-channel.ts` |
| WebChat gateway 方法 | `src/gateway/server-methods/chat.ts` |
| 官方 session 文档 | `docs/concepts/session.md` |

---

## 二、WebChat 与 IM Channel 的核心差异

| 维度 | WebChat（内置 UI） | IM Channel（Telegram 等） |
|------|-------|----------|
| **本质** | 内置于 gateway 的 RPC 接口，非标准 channel 插件 | 通过插件 SDK 注册的完整 channel 插件 |
| **通信方式** | WebSocket 直连 gateway，调用 `chat.send` RPC | 独立监听进程，轮询/webhook 接收消息 |
| **Session Key** | 用户直接指定（如 `agent:main:main`） | 由 `buildAgentPeerSessionKey()` 根据 dmScope 自动计算 |
| **流式响应** | 实时 delta 事件流（WebSocket 推送） | block coalescing（合并缓冲，防止消息轰炸） |
| **Media** | 内联 base64 | 需要下载/上传到平台 API |
| **健康监控** | 无（依赖 WebSocket 连接状态） | 有独立的 health monitor，自动重连 |
| **并发** | 每 session 串行 | 可配置并发度 + 平台级限速 |
| **特有能力** | `chat.abort`（中止）、`chat.inject`（注入）、历史加载 | reactions、polls、threading、native commands（`/start`） |

**关键区别**：WebChat 不经过 `buildAgentPeerSessionKey()`，它的 session key 由调用方直接传入 `chat.send({ sessionKey })`。而 IM channel 的 session key 是根据消息元数据和 `dmScope` 配置自动推导的。

---

## 三、Session Key 命名规则

源码位于 `src/routing/session-key.ts:127-174`，核心函数是 `buildAgentPeerSessionKey()`。

### 1. DM（直接消息）— 受 dmScope 控制

| dmScope | Session Key 格式 | 示例 |
|---------|-----------------|------|
| `"main"`（默认） | `agent:<agentId>:<mainKey>` | `agent:main:main` |
| `"per-peer"` | `agent:<agentId>:direct:<peerId>` | `agent:main:direct:123456` |
| `"per-channel-peer"` | `agent:<agentId>:<channel>:direct:<peerId>` | `agent:main:telegram:direct:123456` |
| `"per-account-channel-peer"` | `agent:<agentId>:<channel>:<accountId>:direct:<peerId>` | `agent:main:telegram:default:direct:123456` |

### 2. 群组/频道 — 不受 dmScope 影响

| 类型 | Session Key 格式 | 示例 |
|------|-----------------|------|
| 群组 | `agent:<agentId>:<channel>:group:<peerId>` | `agent:main:telegram:group:chat123` |
| 频道 | `agent:<agentId>:<channel>:channel:<peerId>` | `agent:main:discord:channel:general` |
| 帖子/话题 | 在基础 key 后追加 `:thread:<threadId>` | `agent:main:telegram:group:chat123:topic:5` |

### 3. 源码与文档的差异

官方文档 (`docs/concepts/session.md`) 中用 `dm:<peerId>` 描述 session key 格式，但实际源码 (`src/routing/session-key.ts`) 中使用的是 `direct:<peerId>`。**以源码为准。**

---

## 四、dmScope = "main" 时，IM Channel 与 WebChat 是否共享同一个 Session Key？

**是的，会共享。**

当 `dmScope` 为 `"main"` 时（默认值）：

- 所有 IM channel 的 DM 消息都会被路由到 `agent:main:main`
- WebChat 默认也使用 `agent:main:main`
- **它们使用完全相同的 session key，共享同一个会话上下文**

这意味着用户在 Telegram 发的消息和在 WebChat 发的消息会出现在同一个对话记录中，agent 能看到两边的上下文。

这也正是官方文档中强调的安全风险：多人使用 `dmScope: "main"` 时，所有人共享一个会话，可能泄露隐私。

---

## 五、dmScope 非 "main" 时，IM Channel 的 Session Key 规则

以 `dmScope: "per-channel-peer"` 为例，不同来源的 session key：

| 来源 | Session Key |
|------|------------|
| Alice 通过 Telegram（userId: 123） | `agent:main:telegram:direct:123` |
| Alice 通过 WhatsApp（phone: +1234） | `agent:main:whatsapp:direct:+1234` |
| Bob 通过 Telegram（userId: 456） | `agent:main:telegram:direct:456` |
| WebChat | 仍然是调用方指定的，通常 `agent:main:main` |

所以 **dmScope 非 main 时，IM channel 的 DM 会话与 WebChat 的会话是隔离的**。WebChat 走 `agent:main:main`，而各 IM channel 的 DM 走各自的 `agent:main:<channel>:direct:<peerId>`。

### Identity Links（跨 Channel 身份关联）

如果需要跨 channel 共享同一个人的会话，可以配置 `session.identityLinks`：

```json5
{
  session: {
    dmScope: "per-channel-peer",
    identityLinks: {
      alice: ["telegram:123", "whatsapp:+1234"]
    }
  }
}
```

此时 Alice 的 session key 会用 canonical name 替换 peerId：

- Telegram: `agent:main:telegram:direct:alice`
- WhatsApp: `agent:main:whatsapp:direct:alice`

注意：channel 部分仍然不同，所以即使用了 identityLinks，`per-channel-peer` 模式下不同 channel 的会话仍然隔离。如需跨 channel 合并，应使用 `per-peer` 模式，此时：

- Telegram: `agent:main:direct:alice`
- WhatsApp: `agent:main:direct:alice`（相同，合并了）

Identity Links 的实现逻辑位于 `src/routing/session-key.ts:176-220` 的 `resolveLinkedPeerId()` 函数。匹配规则：

1. 尝试匹配 `peerId` 本身（不带 channel 前缀）
2. 尝试匹配 `<channel>:<peerId>`（带 channel 前缀）
3. 若匹配到，用 canonical name 替换 peerId
4. 当 `dmScope` 为 `"main"` 时，跳过 identity links（因为已经共享主 session）

---

## 六、dmScope 是全局设置还是 Per-Channel 设置？

**dmScope 是全局设置，适用于所有 IM channel。**

源码和文档均证实：

- `dmScope` 配置在 `session.dmScope`（根级别的 `session` 配置块中）
- **不存在** `channels.telegram.dmScope` 这样的 per-channel 设置
- 所有 channel 调用 `buildAgentPeerSessionKey()` 时，读取的是同一个 `dmScope` 值
- 每个 channel 可以独立配置 DM policy（`allowFrom`、`pairing` 等安全策略），但 **session 分组策略（dmScope）是统一的**

配置示例：

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    dmScope: "per-channel-peer",  // 全局生效，所有 channel 共用
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"]
    }
  }
}
```

---

## 七、dmScope 决策树

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

### dmScope 适用与不适用的范围

**适用于：**

- 仅限直接消息（1:1 DM）
- 来自任何 channel 插件（Telegram、Slack、WhatsApp 等）的入站 DM

**不适用于：**

- 群组和频道（始终独立隔离）
- Cron jobs、Webhooks、子 agent 运行
- WebChat（session key 由调用方直接指定）
- Thread/topic sessions（继承父 key + thread ID）

---

## 八、实际场景示例

### 场景 1：单用户设置（默认）

```json5
{ session: { dmScope: "main" } }
```

| 来源 | Session Key |
|------|------------|
| Alice (Telegram 123) | `agent:main:main` |
| Alice (WhatsApp +1234) | `agent:main:main` |
| Bob (Discord) | `agent:main:main` |
| WebChat | `agent:main:main` |

**结果**：所有来源共享一个会话（多用户场景下不安全！）

### 场景 2：多用户共享收件箱

```json5
{ session: { dmScope: "per-channel-peer" } }
```

| 来源 | Session Key |
|------|------------|
| Alice (Telegram 123) | `agent:main:telegram:direct:123` |
| Alice (WhatsApp +1234) | `agent:main:whatsapp:direct:+1234` |
| Bob (Discord bob1234) | `agent:main:discord:direct:bob1234` |
| WebChat | `agent:main:main`（由调用方指定） |

**结果**：每个 channel+人 隔离，安全

### 场景 3：跨 Channel 身份合并

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

| 来源 | Session Key |
|------|------------|
| Alice (Telegram 123) | `agent:main:direct:alice` |
| Alice (WhatsApp +1234) | `agent:main:direct:alice` |

**结果**：同一人跨 channel 共享会话，实现上下文连续性

---

## 九、Channel 插件的运行时服务

插件注册后，通过 `PluginRuntime` 获得丰富的运行时能力（定义于 `src/plugins/runtime/types-channel.ts`）：

- **`channel.text`** — 文本分块（markdown/plain）
- **`channel.reply`** — 回复派发（含 typing 指示器）
- **`channel.routing`** — agent 路由解析
- **`channel.pairing`** — 配对请求管理
- **`channel.media`** — 媒体下载/保存
- **`channel.session`** — session 元数据记录
- **`channel.groups`** — 群组策略解析
- **`channel.commands`** — 命令授权检查
- **`channel.<provider>`** — 平台特定方法（如 `channel.telegram.sendMessageTelegram`）

---

## 十、总结对照表

| 问题 | 结论 |
|------|------|
| dmScope 是全局还是 per-channel？ | **全局**，配置在 `session.dmScope` |
| dmScope="main" 时 IM 与 WebChat 共享 session？ | **是**，都是 `agent:main:main` |
| dmScope 非 main 时 IM 与 WebChat 隔离？ | **是**，IM 走各自的 key，WebChat 仍然 `agent:main:main` |
| 群组受 dmScope 影响？ | **不受影响**，始终 `agent:<id>:<channel>:group:<peerId>` |
| WebChat 走 buildAgentPeerSessionKey？ | **不走**，session key 由调用方直接指定 |
| 各 channel 的安全策略独立？ | **是**，DM policy/allowlist 按 channel 配置 |
| 源码中 DM session key 用 `dm:` 还是 `direct:`？ | **`direct:`**（文档写的 `dm:` 有误） |
