# 上传图片后 Bot 说没看到图片

## 问题现象

- 在 CoClaw 中向 Bot 发送了图片，消息已发出且界面上能看到图片
- 但 Bot 回复说"没有看到图片"或完全忽略图片内容
- 刷新页面后，该消息中的图片消失

## 原因

这通常不是 CoClaw 的问题，而是 OpenClaw 侧的模型配置缺少了图片能力声明。

OpenClaw 在把消息发给 AI 模型之前，会检查当前模型是否支持图片输入。如果模型配置中没有声明支持图片，OpenClaw 会直接丢弃图片，只把文字发给模型——而且不会有任何提示。

**常见触发场景**：使用自定义 Provider（如通过 Ark、第三方 API 代理等接入的模型）时，模型配置中往往没有声明 `input` 能力，即使模型本身支持看图。

## 排查步骤

### 1. 确认当前使用的模型

打开 OpenClaw 配置文件 `openclaw.json`，找到 `agents.defaults.model.primary` 字段，确认当前主模型是哪个。例如：

```json
"model": {
  "primary": "arkcode/doubao-seed-2.0-code"
}
```

这里 `arkcode` 是 Provider 名，`doubao-seed-2.0-code` 是模型 ID。

### 2. 检查该模型是否声明了图片能力

在 `openclaw.json` 中找到对应 Provider 的模型列表（`models.providers.<provider名>.models`），看该模型条目是否包含 `input` 字段。

如果是这样，就**缺少图片能力声明**：

```json
{
  "id": "doubao-seed-2.0-code",
  "name": "Doubao Seed 2.0 Code"
}
```

### 3. 添加图片能力声明

给该模型条目加上 `input` 字段：

```json
{
  "id": "doubao-seed-2.0-code",
  "name": "Doubao Seed 2.0 Code",
  "input": ["text", "image"]
}
```

> **注意**：请确认你使用的模型确实支持图片输入（即支持 Vision）。如果模型本身不支持，添加此声明也不会有效果。

### 4. 重启 OpenClaw 使配置生效

```bash
openclaw gateway restart
```

### 5. 验证

在 CoClaw 中重新发送一张图片，确认 Bot 能正确识别图片内容。

## 哪些模型需要手动声明

- **内置 Provider**（如 Anthropic、OpenAI 等）的模型通常已自动声明，无需手动配置
- **自定义 Provider**（如通过 Ark、第三方代理接入）的模型大多需要手动声明
- **Ollama / vLLM** 本地模型一律需要手动声明（即使模型支持 Vision，OpenClaw 也不会自动检测）

如果你配置了多个模型且都需要支持图片，建议逐个检查并添加 `input` 声明。
