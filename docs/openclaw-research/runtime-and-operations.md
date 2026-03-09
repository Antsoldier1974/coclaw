# OpenClaw 运行时机制与运维要点

> 更新时间：2026-03-09
> 基于 OpenClaw 本地源码研究，聚焦 CoClaw 集成开发中需要深入理解的运行时概念

---

## 一、Agent Run 生命周期

### 1. 执行流程

```
RPC 请求（agent / chat.send）
  ↓ 验证 + 幂等性检查（idempotencyKey）
  ↓ 入队（按 session key 串行 + 全局并发限制）
  ↓ agentCommand 编排
  ↓ runEmbeddedPiAgent 执行（pi-agent-core）
  ↓ 循环：LLM 推理 → 工具调用 → LLM 推理 → ...
  ↓ 结束（stop / toolUse 结束 / timeout / error）
```

### 2. 生命周期事件

通过 WebSocket 事件流推送（`event: "agent"` 或 `event: "chat"`）：

| stream | phase/state | 含义 |
|--------|------------|------|
| `lifecycle` | `start` | Agent run 开始执行 |
| `assistant` | — | 模型输出文本（替换模式，非追加） |
| `tool` | `start` / `update` / `result` | 工具调用的各阶段 |
| `thinking` | — | 模型思考过程 |
| `lifecycle` | `end` | Agent run 正常结束 |
| `lifecycle` | `error` | Agent run 出错 |

### 3. 并发与队列

- **Session 级串行**：同一 session key 同时只能有一个 run（写锁）
- **全局并发限制**：`agents.defaults.maxConcurrent`（默认 4），子 Agent 独立限制（默认 8）
- **超时**：默认 600s agent runtime；`agent.wait` RPC 默认 30s
- **Compaction**：上下文过长时自动摘要压缩，可能触发重试

### 4. CoClaw 集成要点

- 监听 `lifecycle.start` 展示加载状态
- 监听 `assistant` 更新流式文本（注意是**替换模式**）
- 监听 `tool` 展示工具执行轨迹
- 监听 `lifecycle.end` 固化最终内容
- 监听 `lifecycle.error` 展示错误并允许重试
- 通过 `idempotencyKey` 实现重试去重

---

## 二、工具系统（Tool System）

### 1. 工具分类

| 类别 | 说明 | 示例 |
|------|------|------|
| **内置工具** | 始终可用（受工具策略限制） | read, exec, edit, write, process, browser, message |
| **插件工具** | 通过 `registerTool()` 注册，可选（需白名单启用） | 自定义搜索、数据库查询等 |
| **Session 工具** | 管理 session/子 Agent | sessions_spawn, subagents, sessions_list |

### 2. 工具授权

- **工具策略**（`tools.profile` / `tools.allow` / `tools.deny`）：基于权限的 allow/deny 列表
- **每 Agent 覆盖**：`agents.list[].tools` 可限制特定 Agent 的工具访问
- **可选工具**：`optional: true` 的工具需要显式白名单才能启用
- **Elevated exec**：逃逸沙箱的特殊机制，通过 `/elevated` 指令在宿主机执行

### 3. 工具结果

- 结果经过大小限制和图片载荷清理后再记录/推送
- CoClaw 展示工具调用时需处理 `tool` 事件的三个阶段（start → update → result）

---

## 三、模型配置与故障转移

### 1. 模型选择优先级

```
1. 每 Agent 覆盖（agents.list[id].model）
   ↓
2. 全局默认（agents.defaults.model.primary）
   ↓
3. Fallback 链（agents.defaults.model.fallbacks）
```

### 2. 认证 Profile 轮换

- OAuth profile 优先于 API key（同一 provider 内）
- Round-robin 按 `usageStats.lastUsed`（最久未用优先）
- 失败退避：1m → 5m → 25m → 1h（指数退避，有上限）
- 计费禁用：5h-24h 退避

### 3. Session 粘性

- 认证 profile 在 session 内固定（直到 reset 或 compaction）
- 用户通过 `/model …@<profileId>` 锁定 profile

### 4. 模型引用格式

- `provider/model`（按第一个 `/` 分割）
- 白名单：设置 `agents.defaults.models` 后，只允许白名单内的模型

---

## 四、命令与指令系统

### 1. 命令类型

| 类型 | 行为 | 示例 |
|------|------|------|
| **独立命令** | 整条消息作为命令执行 | `/new`, `/reset`, `/stop`, `/status` |
| **指令** | 从消息中剥离，修改 session 设置 | `/think`, `/verbose`, `/model`, `/queue` |
| **内联快捷** | 立即执行并从消息中剥离 | `/help`, `/commands`, `/whoami` |

### 2. 关键命令

| 命令 | 功能 | CoClaw 关注度 |
|------|------|:----------:|
| `/new`, `/reset` | 重置 session（新建 sessionId） | 高 |
| `/stop` | 中止当前 run | 高 |
| `/model` | 切换模型 | 中 |
| `/model status` | 查看认证/端点详情 | 低 |
| `/queue <mode>` | 切换队列模式 | 低 |
| `/status` | 查看上下文窗口使用情况 | 中 |
| `/export-session` | 导出 session | 低 |
| `/subagents` | 管理子 Agent | 低 |
| `/config show\|get\|set` | 查看/修改配置（仅 owner） | 低 |

### 3. 授权

- 命令授权通过 `commands.allowFrom` 或 channel allowlist 控制
- 仅白名单用户的命令走快速路径（跳过队列和模型）

---

## 五、Cron 定时任务

### 1. 基础

- Cron 在 Gateway 内运行，持久化在 `~/.openclaw/cron/jobs.json`
- Session key 格式：`agent:<agentId>:cron:<jobId>`

### 2. 调度方式

| 方式 | 说明 | 示例 |
|------|------|------|
| `at` | 一次性，指定时间点 | 30 分钟后提醒 |
| `every` | 固定间隔 | 每 2 小时检查 |
| `cron` | 5/6 字段表达式 | `0 9 * * 1-5`（工作日 9 点） |

### 3. 执行模式

- **Main session**：作为 system event 注入 Agent 的主会话（`agent:<agentId>:<mainKey>`，通常为 `agent:main:main`），在下一次心跳时执行，共享主会话的完整对话上下文
- **Isolated**（默认）：独立 session `agent:<agentId>:cron:<jobId>`，每次新 sessionId（无历史上下文延续）

### 3.1 Cron 不区分创建来源

无论 Cron 任务是由哪个渠道、哪个用户的对话触发 AI 创建的，任务一旦创建就与来源无关——它们统一挂在对应 Agent 下，存储在 `~/.openclaw/cron/jobs.json` 中。执行时使用的 session 是 Cron 自己的 session（isolated）或 Agent 的主会话（main），不会使用创建者的 per-peer/per-channel-peer session。

任务结果的投递目标需要在创建时通过 `delivery` 显式指定（向哪个 channel/recipient 发送），与创建者的渠道身份没有自动关联。

### 4. 投递模式

- `none`：仅内部执行
- `announce`：向 channel 发送结果
- `webhook`：HTTP POST

### 5. 容错

- 瞬态错误（速率限制、网络、5xx）：指数退避重试
- 永久错误（认证、校验）：立即禁用

---

## 六、Presence 与客户端管理

### 1. 机制

- Gateway 追踪所有连接的客户端（macOS app、CLI、WebChat、CoClaw 等）
- 客户端通过 WebSocket connect 时的 `instanceId` 标识（需稳定）
- 条目 TTL 5 分钟，上限 200 条

### 2. CoClaw 集成

- CoClaw 连接 Gateway 时应发送稳定的 `instanceId`
- 可定期发送 `system-event` beacon 报告活跃状态
- 可实现"已连接设备"UI 展示

---

## 七、消息流式推送

### 1. Block Streaming（分块推送）

- 将模型输出按段落/句子分块推送，模拟人类回复节奏
- 默认关闭，通过 `blockStreamingDefault` 启用
- 分块参数：`minChars: 200`、`maxChars: 800`
- 断句优先级：段落 → 换行 → 句号 → 空格
- 人类延迟：`humanDelay: "natural"`（800-2500ms）

### 2. Preview Streaming（预览推送）

- Channel 特有：Telegram/Discord/Slack 可实时更新临时消息
- 模式：`off`、`partial`（单条预览）、`block`（分块）、`progress`（进度条+最终）

### 3. CoClaw 场景

CoClaw 使用 `agent` RPC 的 `assistant` 事件流，获取的是**完整替换模式**（每次事件包含当前完整文本），与 `chat.send` 的 `delta` 增量模式不同。UI 渲染策略应据此适配。

---

## 八、心跳（Heartbeat）

### 1. 机制

- Gateway 定期在 Agent 的**主会话**（`agent:<agentId>:<mainKey>`，通常为 `agent:main:main`）中触发 agent turn（默认 30 分钟间隔）
- 注意：这里的"主会话"与 dmScope 无关——即使 dmScope 为 `per-channel-peer` 产生了多个独立的渠道 session，心跳仍然只在 `agent:main:main` 中执行
- 不需要用户消息，agent 自行检查 `HEARTBEAT.md` 并决定是否需要行动
- 若 agent 回复以 `HEARTBEAT_OK` 开头且长度 ≤ 300 字符，回复被抑制（不投递）

### 2. 配置

- `heartbeat.intervalMinutes`：间隔（默认 30，Anthropic OAuth 默认 60）
- `heartbeat.target`：`none`（默认）、`last`（发给最近联系人）、指定 channel
- `heartbeat.activeHours`：限制执行时段
- `heartbeat.lightContext: true`：仅注入 `HEARTBEAT.md`（跳过其他 bootstrap 文件）

### 3. 与 Cron 的区别

| 维度 | 心跳 | Cron（isolated） | Cron（main） |
|------|------|-----------------|-------------|
| 执行 session | `agent:main:main` | `agent:main:cron:<jobId>` | `agent:main:main` |
| 上下文延续 | 有（共享主会话历史） | 无（每次全新） | 有（共享主会话历史） |
| 触发方式 | 固定间隔自动触发 | 按 schedule 触发 | 注入心跳队列 |
| 区分来源 | 不区分 | 不区分 | 不区分 |

---

## 九、关键源码索引

| 用途 | 文件路径 |
|------|---------|
| Agent Run 入口 | `src/gateway/server-methods/agent.ts` |
| Agent Loop 概念 | `docs/concepts/agent-loop.md` |
| 工具文档 | `docs/plugins/agent-tools.md` |
| 命令文档 | `docs/tools/slash-commands.md` |
| 模型配置 | `docs/concepts/models.md` |
| 模型故障转移 | `docs/concepts/model-failover.md` |
| 认证文档 | `docs/gateway/authentication.md` |
| Cron 文档 | `docs/automation/cron-jobs.md` |
| Cron 工具 | `src/agents/tools/cron-tool.ts` |
| 队列概念 | `docs/concepts/queue.md` |
| 流式推送 | `docs/concepts/streaming.md` |
| Presence | `docs/concepts/presence.md` |
| 心跳文档 | `docs/gateway/heartbeat.md` |
| 沙箱文档 | `docs/gateway/sandboxing.md` |
| 上下文概念 | `docs/concepts/context.md` |
