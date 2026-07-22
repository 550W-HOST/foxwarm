# Unit: src-llm

Files: src/llm.ts, src/llm.test.ts, src/llmRouting.test.ts, src/llmVirtualRouting.test.ts

## Purpose

Owns provider request routing, Anthropic conversion/parsing, session prompt snapshots, prompt-cache keys, retries/aborts, interaction logs, stream progress, unified result parsing, tool execution batches, and one-shot requests. OpenAI conversion/stream assembly is delegated to `src/llmProviders/openai.ts`.

## Key exports

- `chat(parts, session, iteration?, options?)` — optionally append user parts, request one provider turn from current model-visible history, update stats, and append the model result.
- `requestLlmOnce(options)` — provider request without automatic session-history orchestration.
- `executeTools(functionCalls, toolContext, session)` — normal tool batch with progress/control handling.
- `buildSessionSystemPromptSnapshot(options)` — framework prompt, memory, skill catalog, and dynamic hints.
- `generatePromptCacheKey`, `ensurePromptCacheKey`.
- `sanitizeProviderRequestPayload`, `isAbortError`.
- `LlmRequestError`, `isLlmRequestError`, retry event types/defaults/delay helper.
- `getOpenAIRequestApi(providerType)` — exact OpenAI surface routing.
- `DEFAULT_LLM_MAX_ATTEMPTS` plus compatibility `DEFAULT_LLM_MAX_RETRIES`; `classifyHttpFailure`.
- `fixToolCalls(contents)` — provider-safe tool-call/response history normalization.

## Provider routing

| `providerType` | Request path / format |
|---|---|
| `openai`, `openai-responses` | OpenAI Responses API at `<baseUrl>/responses` |
| `openai-completions` | OpenAI Chat Completions at `<baseUrl>/chat/completions` |
| `anthropic` | Anthropic Messages at `<baseUrl>/v1/messages` |
| `session-hash`, `failover` | Resolve a concrete leaf per outer attempt, then use that leaf's protocol |

`getOpenAIRequestApi()` returns null for other values; the current request branch then uses Anthropic-format handling. Custom provider types therefore need Anthropic-compatible behavior unless source routing is extended.

## Tool-response formatting

Anthropic conversion and both OpenAI serializers use `packages/shared/src/toolResponseFormatting.ts` through the built shared package. Structured tool responses remain structured internally; the shared formatter owns provider-facing text. Image parts are promoted separately and accompanied by image guidance. Canonical decision: [D-llm-shared-response-format](../modules/llm.md#d-llm-shared-response-format).

## Prompt snapshot behavior

- Framework prompt precedence: top-level agent framework prompt, then documented legacy main-agent framework fallback.
- Memory is resolved across inherited/current agents with session frontmatter filters.
- Visible skills are listed as compact metadata; full skill docs remain on-demand.
- Dynamic hints include agent folder and layered-context recall guidance.
- Prompt-cache keys are random UUIDs tied to model-facing prefix lineage and persisted by normal session callers. Canonical lineage: [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).

## Request behavior

- Provider payloads are sanitized for lone surrogates and may be gzip/brotli compressed per model config.
- OpenAI and Anthropic payloads receive current tool schemas and current Foxwarm system/source wrappers.
- Streaming progress emits throttled reasoning/text/tool-call snapshots.
- Retry waits are abortable. Terminal failures move bounded diagnostics to error logs, emit a final retry event, and throw `LlmRequestError`; they do not create fake assistant `Error:` messages. Canonical boundary: [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).
- The historical `maxRetries` option/event field means total attempts; the default is six. Virtual attempts rebuild the complete selected concrete request, and unusable empty/reasoning-only responses retry. Canonical semantics: [model routing](../threads/model-routing.md).
- Successful results normalize into `ChatResult`, record provider-qualified model ID and usage, and may contain function calls for the router loop.
- Display-only messages and internal `__meta` are excluded from provider input.

## Compatibility

- Existing legacy bracketed system/source content is recognized during serialization/history repair. New wrappers use current Foxwarm tags.
- Documented legacy system-prompt location and memory frontmatter shapes remain readers.
- Provider/model field compatibility is owned by [src-config](./src-config.md#compatibility).

## Design decisions

### D-llm-provider-router

Provider type selects one current request protocol: Responses, Chat Completions, or Anthropic Messages. Provider-specific message/stream code is separated where it has a stable boundary.
