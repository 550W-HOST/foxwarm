# Module: LLM

## Responsibility

LLM owns model/provider configuration consumption, prompt snapshots, provider serialization, streaming collection, retry/error behavior, prompt-cache lineage, interaction diagnostics, and the MCP client transport used by tool dispatch.

## Units

- [src-llm](../units/src-llm.md) — routing, Anthropic path, prompt snapshots, retries, logs, tool batches, and one-shot/session requests.
- [src-llm-request-journal](../units/src-llm-request-journal.md) — content-addressed canonical request inputs, bounded manifests, attempts, and reconstruction.
- [src-model-routing](../units/src-model-routing.md) — virtual target selection and process-local failover health.
- [src-llm-openai](../units/src-llm-openai.md) — OpenAI Responses/Chat Completions conversion and stream collectors.
- [src-mcp-client](../units/src-mcp-client.md) — MCP config, connection lifecycle, discovery, invocation, and result normalization.
- [src-mcp-external-service](../units/src-mcp-external-service.md) — fixed local RPC ownership boundary used by all current MCP callers.
- [src-config](../units/src-config.md) — canonical provider/model expansion and path/default resolution.

## Public interfaces

- `chat`, `requestLlmOnce`, `executeTools`, and prompt snapshot/cache helpers.
- `LlmRequestError`, retry events, abort recognition, and provider payload sanitization.
- OpenAI conversion/stream collectors.
- MCP list/call/configuration APIs.

## Provider routing

Canonical image messages remain blob-reference-only until the provider request boundary; clone-only hydration and diagnostic redaction are owned by [image blob lifecycle](../threads/image-blob-lifecycle.md).

- `openai` and `openai-responses` use the Responses API; concrete models may opt into the hosted `web_search` tool, whose completed output items remain provider-owned and model-scoped.
- `openai-completions` uses Chat Completions.
- `anthropic` uses Anthropic Messages.
- `session-hash` and `failover` resolve strict concrete leaves before provider serialization. Canonical contract: [model routing](../threads/model-routing.md).
- Provider configuration/default/override rules are canonical in [src-config](../units/src-config.md#model-resolution).

## Invariants

- Provider responses normalize to one `ChatResult`/`MessagePart` model.
- Anthropic and OpenAI serialization share one tool-response formatter.
- Prompt snapshots use deterministic framework/memory/skill precedence.
- Outbound payloads replace lone surrogates.
- Terminal failures throw `LlmRequestError` and never become fake model-visible assistant text.
- Prompt-cache keys follow model-facing prefix lineage.
- MCP summaries do not expose secret values.
- One-shot CLI/ToolScript model requests reuse production provider code.
- Every production provider-request path enters the canonical request journal before send; exact wire capture remains outside that contract.
- Empty, whitespace-only, and reasoning-only responses without tool calls are retryable failures; successful virtual results attribute the concrete leaf. Canonical contract: [model routing](../threads/model-routing.md).

## Prompt-cache lineage

Cache keys follow the model-facing prefix rather than session identity; inheritance and rotation are canonical in [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).

Canonical compact behavior: [context compaction and recall](../threads/context-compaction-and-recall.md).

## Compatibility

- Current metadata uses Foxwarm wrappers; supported legacy bracketed history remains readable.
- The current top-level framework prompt has a documented legacy main-agent fallback.
- Provider/model persisted readers are documented in [src-config](../units/src-config.md#compatibility).

## Design decisions

### D-llm-stable-tool-schema

Normal turns, side requests, and compact planning keep one model-facing tool schema when their prompt prefix/schema lineage is shared. Runtime gates enforce special-flow restrictions.

### D-llm-system-wrappers

New provider serialization uses canonical Foxwarm wrappers. Compatibility readers may recognize old persisted headers without generating new legacy forms.

### D-llm-shared-response-format

Structured tool values remain structured until provider serialization, where one shared formatter produces text for all provider protocols.

### D-llm-request-errors

Request failure is exception-driven at the provider boundary. Router, channel, setup, and CLI boundaries choose presentation.

## Canonical ownership

Retry presentation is canonical in [D-pipeline-display-only-retries](../threads/message-processing-pipeline.md#d-pipeline-display-only-retries). MCP result cleanup is canonical in [D-mcp-source-normalization](../units/src-mcp-client.md#d-mcp-source-normalization).
Canonical training-input durability is owned by [D-llm-request-journal-canonical-boundary](../threads/llm-request-journal.md#d-llm-request-journal-canonical-boundary).
