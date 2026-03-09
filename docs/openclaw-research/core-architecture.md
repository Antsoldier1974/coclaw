# OpenClaw 核心架构与 Session 机制

> 更新时间：2026-03-09（子 Agent / Thread / Peer 语义补充）
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

**dmScope 是全局设置**，配置在 `session.dmScope`，适用于所有 IM channel 和所有顶层 Agent。不存在 per-channel 或 per-agent 的 dmScope 设置。

> **默认值辨析**：
> - **代码级运行时默认**：`"main"`（`session-key.ts:140` 等处 `?? "main"`）
> - **本地 onboard 向导默认**：`"per-channel-peer"`（`onboard-config.ts:5` 的 `ONBOARDING_DEFAULT_DM_SCOPE`）
>
> 即：如果 `openclaw.json` 中未设置 dmScope，运行时回退为 `"main"`。但执行 `openclaw onboard`（本地模式）时，向导会自动写入 `"per-channel-peer"`。这是一个 **Breaking Change**（CHANGELOG #23468），因此绝大多数通过 CLI 安装的用户实际使用的都是 `"per-channel-peer"`。
>
> 安装 channel 插件（如 feishu）**不会**修改 dmScope。

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

#### Peer 语义详解

**Peer（对等方）** 指"与 Agent 对话的另一端"。根据聊天类型不同，Peer 的含义有所区别：

| 聊天类型 | Peer 代表 | peerId 来源 |
|---------|----------|------------|
| DM（直接消息） | 发送者本人 | 用户的 channel 原生 ID（如 Telegram userId `123456789`） |
| 群组 | 群组本身 | 群组的 channel 原生 ID（如 Telegram chatId `-1001234567890`） |
| 论坛话题 | 话题 | 组合格式 `<chatId>:topic:<threadId>` |

**peerId 的构造是 channel 适配器的职责**，各 channel 实现各有差异：
- Telegram DM: `resolveTelegramDirectPeerId()` → 优先取 sender userId
- Telegram 群组: `buildTelegramGroupPeerId()` → 取 chatId，若有 topic 则追加 `:topic:<threadId>`
- Slack: DM 取 `senderId`，频道取 `channelId`
- Discord: 取 conversation ID

#### per-peer 与 per-channel-peer 核心差异

两者的关键区别在于 **是否按 channel 维度进一步隔离**：

```
场景：用户 Alice 在 Telegram 和 WhatsApp 上各与 Agent DM

per-peer（按人隔离）:
  Telegram Alice → agent:main:direct:alice_id
  WhatsApp Alice → agent:main:direct:alice_id   ← 同一个 session！
  → Alice 跨 channel 共享上下文

per-channel-peer（按 channel+人 隔离）:
  Telegram Alice → agent:main:telegram:direct:alice_id
  WhatsApp Alice → agent:main:whatsapp:direct:alice_id  ← 不同 session
  → Alice 各 channel 上下文独立
```

**选型建议**（源自 `docs/concepts/session.md`）：
- `per-peer`：适合个人使用，希望跨 channel 延续对话
- `per-channel-peer`：适合多用户收件箱场景，推荐作为生产默认值
- `per-account-channel-peer`：同一 channel 有多个账号时使用（如多个 WhatsApp 号码）

#### Identity Links 的作用

Identity Links 将不同 channel 上的同一自然人映射为统一 peerId，**仅在 dmScope ≠ "main" 时生效**：

```json5
{ session: { dmScope: "per-peer", identityLinks: { alice: ["telegram:123", "discord:456"] } } }
```

此时 `telegram:123` 和 `discord:456` 的 DM 均路由到 `agent:main:direct:alice`。

匹配逻辑（`resolveLinkedPeerId()`）：将入站的 `<channel>:<peerId>` 在 identityLinks 中查找，命中则替换 peerId 为 canonical name。

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

## 五、顶层 Agent（Top-Level Agent）

### 1. 什么是顶层 Agent

顶层 Agent 是 OpenClaw 中**独立的 AI 人格实例**，定义在 `agents.list[]` 配置中。`main` 是默认创建的第一个 Agent（`DEFAULT_AGENT_ID = "main"`），但它并不比其他顶层 Agent "更高级"——所有顶层 Agent 都是平等的 peer 关系。

**典型使用场景**：
- 多人共享一个 Gateway（每人一个 Agent，workspace/认证/session 完全隔离）
- 同一人的多种人格/用途（"work" 用 Opus 处理复杂任务，"fast" 用 Sonnet 日常聊天）
- 按 channel 或角色分流（WhatsApp → 生活 Agent，Discord #ops → 运维 Agent）
- 安全隔离（不可信 Agent 在 sandbox 中运行）

### 2. 创建与删除

**创建**：通过 CLI 命令 `openclaw agents add <name>`（交互式），会：
1. 提示输入 Agent 名称（归一化为小写字母+数字 ID）
2. 创建独立 workspace 目录（默认 `~/.openclaw/workspace-<agentId>`）
3. 创建 agent 状态目录（`~/.openclaw/agents/<agentId>/agent/`，含 `auth-profiles.json`）
4. 创建 session 存储目录（`~/.openclaw/agents/<agentId>/sessions/`）
5. 初始化 workspace 文件（`AGENTS.md`、`SOUL.md` 等）
6. 可选：配置 channel binding（将哪些 channel 消息路由到此 Agent）

**删除**：`openclaw agents delete <agentId>`，会同时清除相关的 bindings。

### 3. 每个顶层 Agent 的独立资源

```
Agent: main（默认）
  ~/.openclaw/workspace/                 ← workspace（可配置）
  ~/.openclaw/agents/main/agent/         ← 状态/认证
  ~/.openclaw/agents/main/sessions/      ← sessions.json + *.jsonl

Agent: work（自定义）
  ~/.openclaw/workspace-work/            ← 独立 workspace
  ~/.openclaw/agents/work/agent/         ← 独立认证
  ~/.openclaw/agents/work/sessions/      ← 独立 session 存储
```

**Workspace 路径解析优先级**（`resolveAgentWorkspaceDir()`）：
1. `agents.list[id].workspace`（显式配置）
2. `agents.defaults.workspace`（仅 main agent）
3. `OPENCLAW_WORKSPACE` 环境变量
4. `~/.openclaw/workspace`（main）/ `~/.openclaw/workspace-<agentId>`（非 main）

### 4. 全局设置 vs 每 Agent 设置

| 设置 | 作用域 | 说明 |
|------|-------|------|
| `session.dmScope` | **全局** | 所有 Agent 共享同一 dmScope |
| `session.identityLinks` | **全局** | 跨 channel 身份关联 |
| `agents.defaults.*` | **全局默认** | 未显式配置的 Agent 继承这些默认值 |
| `agents.list[].model` | **每 Agent** | 模型覆盖 |
| `agents.list[].tools` | **每 Agent** | 工具 allow/deny 列表 |
| `agents.list[].workspace` | **每 Agent** | workspace 路径 |
| `agents.list[].identity` | **每 Agent** | 名称/头像/emoji |
| `agents.list[].sandbox` | **每 Agent** | 沙箱模式 |
| `agents.list[].skills` | **每 Agent** | 启用的 skills 白名单 |
| `agents.list[].heartbeat` | **每 Agent** | 心跳配置 |
| `agents.list[].subagents` | **每 Agent** | 子 Agent 的 spawn 规则 |
| `agents.list[].groupChat` | **每 Agent** | 群聊行为 |

**关键点**：认证（auth profiles）是 **每 Agent 独立** 的，存储在各自的 `agent/auth-profiles.json`。

### 5. 消息路由到非 main Agent

通过 **bindings** 配置决定哪些消息路由到哪个 Agent（详见第七章"Agent 路由"）。若无 binding 匹配，消息回退到 `default: true` 的 Agent 或列表中第一个 Agent（通常是 `main`）。

### 6. CoClaw 的关注点

对 CoClaw 而言，当前阶段用户通常只有 `main` 一个顶层 Agent。但理解顶层 Agent 机制有助于：
- 正确处理多 Agent 场景下的 session 路由
- 未来支持在 CoClaw UI 中切换/管理不同 Agent
- 理解 session key 中 `agentId` 段的含义

---

## 六、子 Agent（Sub-Agent）

### 1. 概念区分：顶层 Agent 与子 Agent

OpenClaw 有两种"Agent"概念，不可混淆：

| 维度 | 顶层 Agent | 子 Agent |
|------|-----------|---------|
| **创建方式** | `openclaw agents add <name>` (CLI) | 主 Agent 运行时通过 `sessions_spawn` 工具动态创建 |
| **Workspace** | 独立 workspace（如 `~/.openclaw/workspace-<agentId>`） | 继承父 Agent 的 workspace |
| **Session 存储** | 独立 `~/.openclaw/agents/<agentId>/sessions/` | 存储在**父 Agent** 的 sessions 目录下 |
| **认证/配置** | 独立 agent 目录 `~/.openclaw/agents/<agentId>/agent/` | 共享父 Agent 认证 |
| **生命周期** | 持久存在，除非手动删除 | 自动归档（默认 60 分钟后删除 transcript） |
| **Session Key** | `agent:<agentId>:main` | `agent:<agentId>:subagent:<uuid>` |

### 2. 创建与删除

**创建**：只有正在执行的 Agent 才能创建子 Agent（通过 `sessions_spawn` 工具，`runtime="subagent"`）。用户不能直接创建子 Agent，也没有 CLI 命令。

**删除**：
- **自动归档**：完成后经过 `archiveAfterMinutes`（默认 60 分钟），transcript 重命名为 `*.deleted.<timestamp>`
- **手动终止**：`/subagents kill <id>`，级联终止子 Agent 的子 Agent
- **立即清理**：spawn 时指定 `cleanup: "delete"`

### 3. Workspace 隔离

子 Agent **不获得独立 workspace**——默认继承父 Agent 的 workspace 目录。区别在于注入的系统文件：

| 文件 | 子 Agent 可见？ |
|------|:------------:|
| `AGENTS.md` | 是 |
| `TOOLS.md` | 是 |
| `SOUL.md` | 否 |
| `IDENTITY.md` | 否 |
| `USER.md` | 否 |
| `HEARTBEAT.md` | 否 |
| `BOOTSTRAP.md` | 否 |

可通过 `attachments` 参数向子 Agent 传递临时文件。

### 4. 层级与嵌套

```
Depth 0: agent:<agentId>:main（主 session）
    ↓ 通过 sessions_spawn 创建
Depth 1: agent:<agentId>:subagent:<uuid>
    ↓ 若 maxSpawnDepth >= 2，可继续创建
Depth 2: agent:<agentId>:subagent:<uuid>:subagent:<uuid>（叶子，不能再创建）
```

| 深度 | 类型 | 能否继续 spawn | 可用工具 |
|------|------|:----------:|---------|
| 0（主） | 主 session | 可以 | 所有 |
| 1（maxDepth=1 时为叶子） | 叶子 | 不可以 | 所有工具（排除 session 管理工具） |
| 1（maxDepth≥2 时为编排者） | 编排者 | 可以 | 包含 `sessions_spawn`、`subagents` 等 |
| 2 | 叶子 | 不可以 | 所有工具（排除 session 管理工具） |

### 5. 与 Channel/WebChat 的关系

子 Agent **不直接与 channel 通信**。结果传递链路：

```
子 Agent 完成任务
  → 将结果 announce 回 requesterSessionKey（父 session）
  → 父 Agent 接收 announce，综合处理
  → 最终通过父 Agent 的 channel 回复用户
```

**Discord 特例**：通过 `thread: true` 可将子 Agent 绑定到 Discord thread，该 thread 内的后续消息直接路由到绑定的子 Agent session。

### 6. 配置

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2,           // 嵌套层级上限（1=仅叶子）
        maxChildrenPerAgent: 5,     // 每个 session 最大并发子 Agent
        maxConcurrent: 8,           // 全局并发上限
        runTimeoutSeconds: 900,     // 运行超时（秒）
        archiveAfterMinutes: 60,    // 完成后自动归档时间
        model: "anthropic/claude-sonnet-4-5",
        thinking: "enabled",
      }
    }
  }
}
```

### 7. 关键源码

| 用途 | 文件路径 |
|------|---------|
| 子 Agent 类型定义 | `src/agents/subagent-registry.types.ts` |
| spawn 实现 | `src/agents/subagent-spawn.ts` |
| spawn 工具 | `src/agents/tools/sessions-spawn-tool.ts` |
| 管理工具 | `src/agents/tools/subagents-tool.ts` |
| 多 Agent 概念文档 | `docs/concepts/multi-agent.md` |
| 子 Agent 工具文档 | `docs/tools/subagents.md` |
| 顶层 Agent 添加 | `src/commands/agents.commands.add.ts` |
| 顶层 Agent 删除 | `src/commands/agents.commands.delete.ts` |
| Agent 路由解析 | `src/routing/resolve-route.ts` |

---

## 七、Thread（消息线程）

### 1. Thread 是什么

Thread 是 **channel 平台的消息分支/话题**，不是代码执行线程。对应：
- Telegram 论坛话题（Forum Topic）
- Discord 帖子/频道线程
- Slack 消息回复线程（thread_ts）

Thread 让同一群组/频道内可以隔离出多个并行对话。

### 2. Thread 与 Session Key 的关系

Thread 通过在 base session key 后追加后缀来实现隔离：

```
Base:   agent:main:telegram:group:-1001234567890
Thread: agent:main:telegram:group:-1001234567890:topic:3
                                                 ^^^^^^^
                                             thread 后缀
```

构建函数：`resolveThreadSessionKeys()`（`src/routing/session-key.ts:234-253`）

各 channel 的 thread ID 格式：
- Telegram: `:topic:<numericId>`（论坛话题 ID）
- Slack: `:thread:<message_ts>`（如 `1770408518.451689`）
- Discord: `:thread:<threadId>`（雪花 ID）

### 3. Thread 对消息路由的影响

**入站**：
1. Channel 适配器提取 `MessageThreadId`、`ThreadParentId`、`IsForum`
2. 调用 `resolveThreadSessionKeys()` 生成带 thread 后缀的 session key
3. 检查是否有 thread binding（见下文），有则路由到绑定的 session
4. 否则使用 thread-suffixed session key

**出站**：
- 回复携带原始 thread ID，确保消息发回正确的 thread
- Telegram: `message_thread_id`；Slack: `thread_ts`；Discord: `threadId`

### 4. Thread Binding（线程绑定）

Thread binding 可将某个 thread 绑定到一个**持久 ACP session 或子 Agent session**：

- 创建：`/acp spawn <agent> --thread auto` 或 `/focus <sessionKey> --thread here`
- 解除：`/unfocus` 或超过 idle 超时
- 效果：该 thread 内的所有消息直接路由到绑定的 session，而非正常的 agent routing

配置：
```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,            // 空闲超时自动解绑
      maxAgeHours: 0,           // 最大存活时间（0=不限）
      spawnAcpSessions: true,   // 允许 /acp spawn --thread
      spawnSubagentSessions: true,
    }
  }
}
```

### 5. 关键源码

| 用途 | 文件路径 |
|------|---------|
| Thread session key 构建 | `src/routing/session-key.ts:234-253` |
| 消息上下文 thread 字段 | `src/auto-reply/templating.ts:146-174` |
| Outbound adapter thread 支持 | `src/channels/plugins/types.adapters.ts:89-125` |
| Thread binding 策略 | `src/channels/thread-bindings-policy.ts` |
| Slack thread 处理 | `src/slack/threading.ts` |
| Discord thread 处理 | `src/discord/monitor/threading.ts` |
| Telegram thread binding | `src/telegram/thread-bindings.ts` |
| Thread-bound agents 设计文档 | `docs/experiments/plans/acp-thread-bound-agents.md` |

---

## 八、Agent 路由（resolveAgentRoute）

当消息到达 Gateway 时，`resolveAgentRoute()` 决定由哪个 Agent 处理，优先级从高到低：

1. **Peer 精确匹配** — 特定 DM/群组 ID 绑定到某 agent
2. **Parent peer 匹配** — thread 继承父会话的 agent 路由
3. **Guild + Roles**（Discord）— 服务器 + 角色组合匹配
4. **Guild**（Discord）— 仅服务器匹配
5. **Team**（Slack）— 工作区匹配
6. **Account** — channel 账号匹配
7. **Channel** — channel 级别回退（`accountId: "*"`）
8. **Default** — 使用 `default: true` 或列表中第一个 agent

配置示例：
```json5
{
  bindings: [
    { agentId: "work", match: { channel: "discord", peer: { kind: "direct", id: "user-123" } } },
    { agentId: "main", match: { channel: "discord", accountId: "default" } }
  ]
}
```

源码：`src/routing/resolve-route.ts`

---

## 九、关键源码索引

| 用途 | 文件路径 |
|------|---------|
| 插件 API 与类型 | `src/plugins/types.ts` |
| Channel 插件接口 | `src/channels/plugins/types.plugin.ts` |
| Adapter 定义 | `src/channels/plugins/types.adapters.ts` |
| Session Key 构建 | `src/routing/session-key.ts` |
| Thread Session Key | `src/routing/session-key.ts:234-253` |
| Agent 路由解析 | `src/routing/resolve-route.ts` |
| Session Key 解析工具 | `src/sessions/session-key-utils.ts` |
| DM 策略逻辑 | `src/security/dm-policy-shared.ts` |
| 插件运行时类型 | `src/plugins/runtime/types-channel.ts` |
| Telegram 实现 | `extensions/telegram/src/channel.ts` |
| Telegram peerId 构建 | `src/telegram/bot/helpers.ts:174-194` |
| Telegram thread binding | `src/telegram/thread-bindings.ts` |
| Slack thread 处理 | `src/slack/threading.ts` |
| Discord thread 处理 | `src/discord/monitor/threading.ts` |
| Gateway 核心 | `src/gateway/` |
| Session 管理 | `src/gateway/session-utils.ts` |
| 消息路由 | `src/gateway/server-chat.ts` |
| WebChat RPC | `src/gateway/server-methods/chat.ts` |
| Agent RPC | `src/gateway/server-methods/agent.ts` |
| 子 Agent 类型 | `src/agents/subagent-registry.types.ts` |
| 子 Agent spawn | `src/agents/subagent-spawn.ts` |
| 子 Agent 工具 | `src/agents/tools/subagents-tool.ts` |
| 消息上下文模板 | `src/auto-reply/templating.ts` |
| Thread binding 策略 | `src/channels/thread-bindings-policy.ts` |
| Session 概念文档 | `docs/concepts/session.md` |
| 多 Agent 概念文档 | `docs/concepts/multi-agent.md` |
| 子 Agent 工具文档 | `docs/tools/subagents.md` |
| 消息概念文档 | `docs/concepts/messages.md` |
| Agent 作用域解析 | `src/agents/agent-scope.ts` |
| Onboard dmScope 默认 | `src/commands/onboard-config.ts:5` |
| Agent 添加命令 | `src/commands/agents.commands.add.ts` |
| Agent 删除命令 | `src/commands/agents.commands.delete.ts` |
| Agent 配置类型 | `src/config/types.agents.ts` |
| Session 路径解析 | `src/config/sessions/paths.ts` |
| Bindings 配置 | `src/config/bindings.ts` |
