# OpenAI LLM Configuration Guide

Foxwarm supports OpenAI and OpenAI-compatible APIs for language model integration.

## Supported Providers

- **OpenAI**: GPT family and future OpenAI-format models
- **OpenAI-compatible APIs**:
  - Azure OpenAI
  - LM Studio / Ollama / vLLM
  - Groq / Together / other providers exposing OpenAI-style endpoints

## Configuration Model

OpenAI-compatible models are configured in **two places**:

1. `.env` for credentials and provider defaults
2. `state/models.yaml` for available model keys and the default model

## 1) Credentials in `.env`

```bash
OPENAI_API_KEY=sk-...
# Optional
# OPENAI_BASE_URL=https://api.openai.com/v1
```

## 2) Model entries in `state/models.yaml`

```yaml
default: openai/gpt-4.1-mini
models:
  openai:
    provider: openai
    model:
      - gpt-4.1-mini
      - gpt-4o
```

If `state/models.yaml` is missing, Foxwarm falls back to `templates/models.example.yaml`.
Recommended setup:

```bash
mkdir -p state
cp templates/models.example.yaml state/models.yaml
```

## Provider Examples

### Azure OpenAI

```bash
# .env
OPENAI_API_KEY=your_azure_key
OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/v1
```

```yaml
# state/models.yaml
default: azure/gpt-4.1
models:
  azure:
    provider: openai
    model:
      - gpt-4.1
```

### Local Models

```bash
# .env
OPENAI_API_KEY=dummy
OPENAI_BASE_URL=http://localhost:1234/v1
```

```yaml
# state/models.yaml
default: local/qwen2.5-coder
models:
  local:
    provider: openai
    model:
      - qwen2.5-coder
```

### Third-party Providers

```bash
# .env
OPENAI_API_KEY=gsk_...
OPENAI_BASE_URL=https://api.groq.com/openai/v1
```

```yaml
# state/models.yaml
default: groq/llama-3.1-70b-versatile
models:
  groq:
    provider: openai
    model:
      - llama-3.1-70b-versatile
```

## Provider Selection

The selected key in `state/models.yaml` determines the request format:

- `provider: openai` → OpenAI / OpenAI-compatible format
- `provider: anthropic` → Anthropic format

You can inspect or switch the current session model with:

```bash
/model
/model <name>
/model default
```

## Features

### Reasoning

OpenAI reasoning-capable models are supported through the current OpenAI / Responses integrations. Foxwarm preserves provider reasoning metadata where possible so it can remain available in later turns.

### Tool Calling

Foxwarm automatically:
- converts internal tool definitions to the OpenAI function format
- executes requested tools
- continues the conversation until the tool-call loop completes

### Streaming

Foxwarm currently uses non-streaming mode for both OpenAI and Anthropic APIs.

### Token Tracking

Foxwarm tracks and stores:
- input tokens
- output tokens
- cached tokens (when available from provider responses)

## Troubleshooting

### "API key not configured"

Make sure the provider credentials are present in `.env`, or set `apiKey` directly in the relevant YAML model entry.

### Local endpoint connection errors

1. Verify the local server is running
2. Check the base URL
3. Test it manually:

```bash
curl http://localhost:1234/v1/models
```

### Tool calling not working

Some OpenAI-compatible providers do not fully support function calling. Check the provider's API compatibility.

## Switching Providers

To switch between Anthropic and OpenAI-format models:

1. Update `.env` credentials / defaults
2. Update `state/models.yaml`
3. Switch the current session model with `/model`, or restart Foxwarm if you want a clean process boundary

## Reference

- [OpenAI API Docs](https://platform.openai.com/docs/api-reference)
- [Azure OpenAI Docs](https://learn.microsoft.com/en-us/azure/ai-services/openai/)
- [Groq Docs](https://console.groq.com/docs)
- [LM Studio](https://lmstudio.ai/)
