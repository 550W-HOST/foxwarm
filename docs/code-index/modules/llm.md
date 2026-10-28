# Module: LLM

> TypeScript Main compatibility/reference map. The active .NET Main architecture is mapped in the [overview](../overview.md); these contracts do not by themselves establish .NET runtime support.

## Responsibility

LLM owns model/provider configuration consumption, snapshot consumption, provider serialization, streaming collection, retry/error behavior, provider-facing prompt-cache handling, interaction diagnostics, and the MCP client transport used by tool dispatch.

## Units

- [src-llm](../units/src-llm.md) — routing, Anthropic path, snapshot consumption, retries, logs, and one-shot/session requests.
- [src-conditional-memory](../units/src-conditional-memory.md) — pure conditional memory-source filtering and current-model snapshot header helpers.
- [src-llm-request-journal](../units/src-llm-request-journal.md) — content-addressed canonical request inputs, bounded manifests, attempts, and reconstruction.
- [src-model-routing](../units/src-model-routing.md) — virtual target selection and process-local failover health.
- [src-llm-openai](../units/src-llm-openai.md) — OpenAI Responses/Chat Completions conversion and stream collectors.
- [src-llm-openai-images](../units/src-llm-openai-images.md) — hosted Responses `image_generation` tool declaration, provider image validation, blob persistence, and same-model replay metadata.
- [src-mcp-client](../units/src-mcp-client.md) — MCP config, connection lifecycle, discovery, invocation, and result normalization.
- [src-mcp-caller-connections](../units/src-mcp-caller-connections.md) — explicitly started online receiving connections and two-instance local/Worker loopback coverage.
- [src-mcp-external-service](../units/src-mcp-external-service.md) — fixed local RPC ownership boundary used by all current MCP callers.
- [src-config](../units/src-config.md) — canonical provider/model expansion and path/default resolution.

## Public interfaces

- `chat` and `requestLlmOnce`.
- Session snapshot/cache utilities are consumed directly from [Session prompt state](../units/src-session-prompt.md), not exported by LLM.
- `LlmRequestError`, retry events, abort recognition, and provider payload sanitization.
- OpenAI conversion/stream collectors.
- OpenAI custom function-tool request serialization explicitly uses non-strict mode while preserving schema-required keys; canonical decision: [D-llm-openai-non-strict-function-tools](../units/src-llm.md#d-llm-openai-non-strict-function-tools).
- MCP list/call/configuration APIs.

## Provider routing

Canonical image messages remain blob-reference-only until the provider request boundary; clone-only hydration and diagnostic redaction are owned by [image blob lifecycle](../threads/image-blob-lifecycle.md).

- `openai` and `openai-responses` use the Responses API; concrete models may opt into the hosted `web_search` tool, whose completed output items remain provider-owned and model-scoped.
- Concrete Responses models may also opt into the hosted `image_generation` tool. Completed images become canonical blob-reference image parts, so the same lifecycle rule above applies; the retained TypeScript path replays only on the producing concrete model. The maintained host also admits declared [native-history compatibility](../units/model-configuration.md#native-history-compatibility), subject to Responses eligibility. Unsupported protocols or virtual entries reject enabled image-generation config before a request.
- `openai-completions` uses Chat Completions.
- `anthropic` uses Anthropic Messages.
- `session-hash` and `failover` resolve strict concrete leaves before provider serialization. Canonical contract: [model routing](../threads/model-routing.md).
- Provider configuration/default/override rules are canonical in [src-config](../units/src-config.md#model-resolution).
- Provider-neutral effort selection and concrete-attempt fallback/mapping are canonical in [model routing](../threads/model-routing.md#d-model-routing-effort).

## Invariants

- Provider responses normalize to one `ChatResult`/`MessagePart` model.
- Anthropic and OpenAI serialization share one tool-response formatter.
- Prompt snapshots use deterministic framework/memory/skill precedence.
- Memory-backed snapshots filter per-source conditions for one canonical concrete model and carry a first-line generation marker. Canonical ownership: [conditional memory snapshots](../threads/conditional-memory-snapshots.md).
- Outbound payloads replace lone surrogates.
- Terminal failures throw `LlmRequestError` and never become fake model-visible assistant text.
- Persisted and routing prompt-cache keys follow model-facing prefix lineage; only a selected `openai-ws` concrete plan derives its provider-facing key from Session identity and the confirmed request scope. Canonical contract: [D-model-routing-openai-ws-prompt-cache-key](../threads/model-routing.md#d-model-routing-openai-ws-prompt-cache-key).
- MCP summaries do not expose secret values.
- One-shot CLI/ToolScript model requests reuse production provider code.
- Every production provider-request path enters the canonical request journal before send; exact wire capture remains outside that contract.
- A selected retry leaf may resolve a different memory-backed prompt; the request keeps the first attempt prompt and later attempts reference their effective prompt. Canonical interaction: [conditional memory snapshots](../threads/conditional-memory-snapshots.md) and [canonical LLM request journal](../threads/llm-request-journal.md).
- Completed responses without non-whitespace content and without tool calls are accepted as normal turn ends by default; a concrete provider or model may set `disallowEmptyResponse` to make them retryable failures. Successful virtual results attribute the concrete leaf. Canonical contract: [model routing](../threads/model-routing.md).

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

### D-llm-anthropic-default-ephemeral-cache

[2026-10-12] Every Anthropic Messages request built by the Anthropic-format serializer carries the top-level `cache_control: { type: 'ephemeral' }` by default, using the protocol's automatic caching with the provider's default lifetime. The default is part of the attempt-local payload before the ordinary `extraFields` merge, so an explicit `extraFields.cache_control` replaces it. The serializer adds no `prompt_cache_key`, no per-block breakpoints, and no TTL policy; OpenAI Responses and Chat Completions payloads are unchanged.

### D-llm-anthropic-messages-streaming

[2026-10-12] Anthropic Messages requests stream by default. `extraFields.stream: false` is the only opt-out and selects the JSON path with a matching body and parser; no official-domain detection or separate streaming configuration exists. Streamed and JSON responses converge on one canonical response shape, so stop reasons, usage, and thinking handling are identical on both paths. Streaming never dispatches tools before `content_block_stop`, and a stream that ends without `message_stop` or a final `stop_reason` is a failed attempt. Pings do not extend the watchdog; only an open thinking block widens the inactivity window to 10 minutes. Tests use mock or loopback transports only, so real provider behavior remains unverified in this batch.

### D-llm-reject-unknown-provider-type

[2026-10-12] An unset or empty `providerType` keeps the OpenAI default. Each supported concrete type uses its own protocol, and only `anthropic` uses the Anthropic serializer. Any other non-empty type is rejected at models-config expansion and, for entries that bypass that path, before request headers, auth, or body are built. Third-party compatible services select a supported protocol and set `baseUrl`; they do not get a catch-all protocol.

## Canonical ownership

Retry presentation is canonical in [D-pipeline-display-only-retries](../threads/message-processing-pipeline.md#d-pipeline-display-only-retries). MCP result cleanup is canonical in [D-mcp-source-normalization](../units/src-mcp-client.md#d-mcp-source-normalization).
Canonical training-input durability is owned by [D-llm-request-journal-canonical-boundary](../threads/llm-request-journal.md#d-llm-request-journal-canonical-boundary).
