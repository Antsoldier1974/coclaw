# OpenClaw Gateway 通信协议与交互机制

> 更新时间：2026-03-09
> 基于 OpenClaw 本地源码验证

---

## 一、RPC 发送接口

`chat.send` 与 `agent()` 底层都会触发 agent run，差异在 Gateway 对外协议层。

### 1. `chat.send`

```json
{
  "method": "chat.send",
  "params": {
    "sessionKey": "agent:main:main",
    "message": "用户消息",
    "idempotencyKey": "uuid-v4",
    "thinking": "medium"
  }
}
```

- **必须传** `sessionKey`（不接受 sessionId）
- 内部通过 `loadSessionEntry(sessionKey)` 查找 sessions.json
- 找不到 → 报错 `No session found`

**ACK**：`{ runId, status: "started" }`

**事件流**（`event: "chat"`）：

| state | 含义 |
|-------|------|
| `delta` | 增量文本块（前端累加） |
| `final` | 完整最终文本 |
| `error` | 错误信息 |
| `aborted` | 中止（含部分文本和 stopReason） |

**Delta 载荷示例**：
```json
{
  "event": "chat",
  "payload": {
    "runId": "xxx", "sessionKey": "agent:main:main", "seq": 2,
    "state": "delta",
    "message": {
      "role": "assistant",
      "content": [{ "type": "text", "text": "增量文本" }],
      "timestamp": 1771572313559
    }
  }
}
```

### 2. `agent`

```json
{
  "method": "agent",
  "params": {
    "sessionKey": "agent:main:main",
    "message": "用户消息",
    "deliver": false,
    "idempotencyKey": "uuid-v4",
    "thinking": "medium"
  }
}
```

- 可传 `sessionKey`（路由到 indexed session）或 `sessionId`（直接指向 transcript）
- `sessionKey` 时行为与 `chat.send` 的 session 维护等价
- `sessionId` 是对 orphan session 唯一可靠的方式
- `deliver: false` 阻止消息向外部 channel 投递

**ACK**：`{ runId, status: "accepted", acceptedAt }`

**事件流**（`event: "agent"`）：

| stream | 含义 |
|--------|------|
| `lifecycle` | phase: start / end / error |
| `assistant` | data.text 为**当前完整文本**（替换模式，非追加） |
| `tool` | 工具调用与结果（phase: start / update / result） |
| `thinking` | 思考过程 |

### 3. 关键差异

| 对比项 | chat.send | agent |
|--------|-----------|-------|
| 参数 | sessionKey | sessionKey 或 sessionId |
| ACK | `"started"` | `"accepted"` |
| 事件 | `"chat"` | `"agent"` |
| 文本交付 | delta 增量追加 | 完整替换 |
| 工具/思考可见 | 否 | 是 |
| orphan 支持 | 否 | 是 |
| 中止 | `chat.abort` | 需额外处理 |

---

## 二、IM 交互模式

### 1. 消息队列

同一 session 同时只能有一个 agent run 执行（per-session 写锁）。新消息到达时进入队列。

**队列模式**（`messages.queue.mode`）：

| 模式 | 行为 |
|------|------|
| `collect`（默认） | 排队消息合并为下一轮上下文，当前 run 结束后一次性处理 |
| `steer` | 立即注入当前 run，取消等待中的工具调用 |
| `followup` | 当前 run 结束后，作为下一轮单独处理 |
| `interrupt` | 终止当前 run，用最新消息启动新 run |

**防抖**：快速连发的文本消息默认 1s 窗口合并。媒体/附件和控制命令（`/new`）绕过防抖。

**溢出**：队列上限默认 20 条，超出后按 `summarize` 策略摘要化。

### 2. 流式反馈

**Typing 指示器**：消息入队时立即发送（掩盖队列延迟）。

**Block Streaming**：配置项 `blockStreamingDefault`（可选，未指定时默认关闭）。按段落 → 换行 → 句号 → 空格优先级智能断句。分块参数：`minChars: 200`、`maxChars: 800`。模拟人类节奏：`humanDelay: "natural"`（800-2500ms 间隔）。

**Reasoning 可见性**：`/reasoning on|off|stream` 控制模型思考过程是否暴露给用户。

### 3. 离线投递

Agent 执行不依赖用户在线。回复直接发送到 IM 平台 API，由平台负责投递。Gateway 是 source of truth，session 状态存储在 Gateway 主机上。

---

## 三、Session Transcript 格式

### 1. 文件结构

- 路径：`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- 变体：`.jsonl`（活跃）、`.jsonl.reset.<ts>`（重置归档）、`.jsonl.deleted.<ts>`（已删除）
- 每行一个 JSON 对象，append-only

### 2. JSONL 条目

顶层字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | `"message"` / `"session"` / `"model_change"` / `"custom"` 等 |
| `id` | `string` | 条目唯一 ID |
| `message` | `object` | 当 `type === "message"` 时存在 |

### 3. Message 对象

```jsonc
{
  "role": "user" | "assistant" | "toolResult",
  "content": ContentBlock[] | string,
  "timestamp": 1771572311573,
  "model": "...",           // assistant 独有
  "stopReason": "stop" | "toolUse",  // assistant 独有
  "toolCallId": "call_xxx", // toolResult 独有
  "toolName": "tool_name",  // toolResult 独有
  "isError": false           // toolResult 独有
}
```

### 4. Content Block 类型

| 类型 | 结构 |
|------|------|
| `text` | `{ "type": "text", "text": "内容" }` |
| `thinking` | `{ "type": "thinking", "thinking": "推理过程" }` |
| `toolCall` | `{ "type": "toolCall", "id": "call_xxx", "name": "tool_name", "arguments": {...} }` |

### 5. stopReason 语义

| 值 | 含义 |
|----|------|
| `stop` / `end_turn` | 模型自然结束 |
| `toolUse` | 模型发起工具调用，后续会有 toolResult |

若 task 被 steer（中断），最后一条 assistant 的 `stopReason` 为 `toolUse` 但无后续 toolResult。

### 6. CoClaw UI 分组渲染策略

将扁平 JSONL 按 "user → botTask → user → botTask" 交替分组。规则：

1. 跳过 `type !== "message"` 的条目
2. `role=user` → 结束当前 botTask、push user item
3. `role=assistant` 或 `role=toolResult` → 归入当前 botTask

botTask 输出结构：

```javascript
{
  type: 'botTask',
  id,              // 首条 assistant 的 id
  resultText,      // stopReason=stop 的 text blocks（null=未完成）
  model, timestamp,
  steps: [
    { kind: 'thinking', text },
    { kind: 'toolCall', name },
    { kind: 'toolResult', text },
  ],
}
```

---

## 四、附件处理

### 当前限制

两条 Gateway RPC 路径（`agent` / `chat.send`）都汇聚到 `parseMessageWithAttachments()`（`src/gateway/chat-attachments.ts`），该函数**只处理 image 类型**附件：

```typescript
// 第 123-130 行
if (sniffedMime && !isImageMime(sniffedMime)) {
    log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
    continue;  // ← 非图片在此被丢弃
}
```

返回类型 `ParsedMessageWithImages` 只含 `message` + `images`，无 audio/file 通道。

| 路径 | 图片 | 音频 | 其他文件 |
|------|:----:|:----:|:-------:|
| `agent` / `chat.send` RPC | 支持 | 丢弃 | 丢弃 |
| Channel 消息（Telegram 等） | 支持 | 支持 | 部分支持 |

音频处理能力存在于 channel 消息管道（media-understanding 模块），尚未接入 RPC 路径。

---

## 五、配置参考

### 消息队列

```json
{
  "messages": {
    "queue": { "mode": "collect", "debounceMs": 1000, "cap": 20, "drop": "summarize" },
    "inbound": { "debounceMs": 1000 }
  },
  "agents": { "defaults": { "maxConcurrent": 4 } }
}
```

### 流式推送

```json
{
  "agents": {
    "defaults": {
      "blockStreamingDefault": true,
      "blockStreamingBreak": "text_end",
      "blockStreamingChunk": { "minChars": 200, "maxChars": 800 },
      "humanDelay": "natural"
    }
  }
}
```
