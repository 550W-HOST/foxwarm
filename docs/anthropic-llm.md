# Anthropic LLM 配置指南

Foxwarm 支持 Anthropic Claude 以及 Anthropic 兼容接口。

## 配置方式

Anthropic 模型分成两部分配置：

1. `.env`：放 API 密钥和 provider 默认 URL
2. `state/models.yaml`：放模型列表和默认模型 key

### `.env`

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_BASE_URL=https://api.anthropic.com
```

### `state/models.yaml`

```yaml
default: anthropic/claude-3-7-sonnet-latest
models:
  anthropic:
    provider: anthropic
    model:
      - claude-3-7-sonnet-latest
```

如果 `state/models.yaml` 缺失，Foxwarm 会回退到 `templates/models.example.yaml`。
推荐先复制模板：

```bash
mkdir -p state
cp templates/models.example.yaml state/models.yaml
```

## 常见模型

| 模型 | 特点 | 适用场景 |
|------|------|----------|
| claude-3-5-sonnet | 综合表现好 | 通用任务 |
| claude-3-opus | 能力最强 | 高复杂度任务 |
| claude-3-haiku | 更快更省 | 轻量任务 |

## 配置示例

### Sonnet

```yaml
default: anthropic/claude-3-5-sonnet-20241022
models:
  anthropic:
    provider: anthropic
    model:
      - claude-3-5-sonnet-20241022
```

### Opus

```yaml
default: anthropic/claude-3-opus-20240229
models:
  anthropic:
    provider: anthropic
    model:
      - claude-3-opus-20240229
```

### Haiku

```yaml
default: anthropic/claude-3-haiku-20240307
models:
  anthropic:
    provider: anthropic
    model:
      - claude-3-haiku-20240307
```

## 高级配置

```bash
MAX_OUTPUT=16384
THINKING_BUDGET=10000
CONTEXT_LIMIT=122880
```

## 提供商选择

当前 session 使用哪个 provider，取决于所选模型 key 对应的 YAML 条目：

```yaml
models:
  anthropic:
    provider: anthropic
    model:
      - claude-3-7-sonnet-latest
```

选择规则：

1. 先看 `session.model`
2. 如果为空，则使用 `state/models.yaml` 中的 `default`
3. 该条目的 `provider` 决定请求格式

可通过以下命令查看或切换：

```bash
/model
/model anthropic/claude-3-7-sonnet-latest
/model default
```

## 切换提供商

### OpenAI → Anthropic

1. 更新 `.env`
2. 更新 `state/models.yaml` 默认模型
3. 发送新请求，或重启 Foxwarm

### Anthropic → OpenAI

1. 更新 `.env`
2. 更新 `state/models.yaml` 默认模型
3. 发送新请求，或重启 Foxwarm

## Anthropic 兼容 API

```bash
# .env
ANTHROPIC_API_KEY=your-key
ANTHROPIC_BASE_URL=https://your-provider.com/v1
```

```yaml
# state/models.yaml
default: custom-anthropic/claude-3-5-sonnet
models:
  custom-anthropic:
    provider: anthropic
    model:
      - claude-3-5-sonnet
```

## 故障排查

### API 密钥错误
- 检查 `ANTHROPIC_API_KEY`
- 检查 provider 是否正确读取了 `.env`

### 连接错误
- 检查网络连接
- 检查 `ANTHROPIC_BASE_URL`

### 模型错误
- 检查 YAML 中的模型名称
- 检查 provider 是否支持该模型
