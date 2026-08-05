# Unit: src-llm

Files: src/llm.ts, src/llm.test.ts, src/llmRouting.test.ts, src/llmVirtualRouting.test.ts, src/llmVirtualMessageMeta.test.ts, src/parallelToolExecution.test.ts
Secondary files: src/llmRequestJournal.ts

## Purpose

Owns provider request routing, Anthropic conversion/parsing, session prompt snapshots, prompt-cache keys, retries/aborts, interaction logs, stream progress, unified result parsing, tool execution batches, and one-shot requests. OpenAI conversion/stream assembly is delegated to `src/llmProviders/openai.ts`.

## Key exports

- `chat(parts, session, iteration?, options?)` — optionally append user parts, request one provider turn from current model-visible history, update stats, and append the model result.
- `requestLlmOnce(options)` — provider request without automatic session-history orchestration.
- `executeTools(functionCalls, toolContext, session)` — model-ordered tool batch execution with serial barriers, bounded adjacent direct-exec segments, progress/control folding, and one final tool message.
- `CurrentSessionEffects` / `createDefaultCurrentSessionEffects()` — local-only normal-turn hooks for current-session append/persist, stream events, abort registration, and explicit-wait rollback; they are not DTOs or RPC contracts.
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
- Canonical image references are hydrated into cloned messages immediately before provider serialization for all three protocols. Persisted messages remain reference-only, and request/virtual-route diagnostics redact hydrated image payloads. Canonical contract: [image blob lifecycle](../threads/image-blob-lifecycle.md).
- OpenAI and Anthropic payloads receive current tool schemas and current Foxwarm system/source wrappers.
- Canonical history keeps logical queued messages separate. The Anthropic serializer coalesces adjacent same-role entries only in its outbound payload, while OpenAI serializers retain separate message entries. Queue-boundary ownership is [D-pipeline-canonical-queue-item-boundaries](../threads/message-processing-pipeline.md#d-pipeline-canonical-queue-item-boundaries).
- Streaming progress emits throttled reasoning/text/tool-call snapshots.
- Retry waits are abortable. Terminal failures move bounded diagnostics to error logs, emit a final retry event, and throw `LlmRequestError`; they do not create fake assistant `Error:` messages. Canonical boundary: [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).
- The historical `maxRetries` option/event field means total attempts; the default is six. Virtual attempts rebuild the complete selected concrete request, and unusable empty/reasoning-only responses retry. Canonical semantics: [model routing](../threads/model-routing.md).
- HTTP classification recognizes nested structured model-not-found errors and bounded common text forms without broadening ordinary HTTP 400 retries. A virtual outer request captures route activation once so old retries cannot replace newer configuration state.
- Successful results normalize into `ChatResult`, record the provider-qualified concrete model ID and usage, and may contain function calls for the router loop. A virtual route additionally carries its resolved configuration key through `ChatResult.virtualModelKey` into every successful provider-generated assistant message, including tool-call-only turns; canonical semantics are owned by [D-model-routing-concrete-attribution](../threads/model-routing.md#d-model-routing-concrete-attribution).
- OpenAI Chat Completions response parsing carries JSON-object `provider_specific_fields` into `ChatResult.providerMeta` with the producing concrete `modelId`; `chat` persists that scoped metadata on the assistant message. Later Chat Completions request plans pass their exact concrete model ID to the serializer, so the opaque fields round-trip only to the same concrete model and are omitted after model switches or on incompatible virtual targets.
- OpenAI Responses maps only its official `usage.output_tokens_details.reasoning_tokens`, and OpenAI Chat Completions maps only its official `usage.completion_tokens_details.reasoning_tokens`. When either field is exposed, it persists as the optional `TokenUsage.reasoningTokens` component while the provider's full output/completion count remains `outputTokens`; Anthropic Messages has no corresponding separately reported reasoning usage field. Cross-module accounting semantics are [D-pipeline-provider-usage-components](../threads/message-processing-pipeline.md#d-pipeline-provider-usage-components).
- Provider usage remains optional: a usable response without a usage object succeeds and simply omits token accounting, including OpenAI-compatible Chat Completions streams which ignore `stream_options.include_usage`.
- Display-only messages and internal `__meta` are excluded from provider input.
- Before the first physical send, `requestLlmOnce` journals the repaired provider-neutral messages, system prompt, and exact tool schema through content-addressed objects and a bounded manifest. Every physical attempt records concrete routing and a semantic-payload digest; canonical ownership is [canonical LLM request journal](../threads/llm-request-journal.md).
- Successful `ChatResult` values carry the durable request/attempt identity, and `chat` persists that link on assistant metadata. Post-response journal-result failures are logged without entering the provider retry loop.
- Tool execution keeps per-call result/image/control state local. Direct and unified builtin paths share exhaustive placement resolution, so only node-environment tools follow `currentNode`; placement metadata remains separate from permission checks. A remote execution node enters the fixed Node execution service, while `master` still invokes the local named handler with no RPC. Adjacent direct `exec` calls use a bounded parallel segment and pass one captured node/cwd snapshot; all other tools are barriers, and final parts are flattened in original call order. Canonical scheduling and placement contracts: [D-dispatch-exec-parallel-segments](../threads/tool-dispatch.md#d-dispatch-exec-parallel-segments) and [D-dispatch-node-environment-placement](../threads/tool-dispatch.md#d-dispatch-node-environment-placement).
- `executeTools` resolves exactly one source owner before preparing any call. A `LocalSessionTurnHost` call with `CurrentSessionEffects` trusts only the exact passed Session whose identity matches (or supplies) the source ID; a mismatch fails before tool/effect work. A legacy/direct call without effects ignores passed Session objects, loads one existing source Session by ID, and fails rather than creating a missing source. Routing, permission, handler context, current-session persistence, and the captured parallel-exec node/cwd snapshot all use that same owner.
- The first persisted response in a tool batch may carry the successful preceding LLM request timing for serializer-owned model input; canonical contract: [D-pipeline-input-time](../threads/message-processing-pipeline.md#d-pipeline-input-time).
- Tool-result internals fold explicit wait-token cleanup and successful handoff post-actions without exposing hidden sentinels to providers. The router owns post-append wait arming under [D-pipeline-handoff-wait](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait).
- The current real `LocalSessionTurnHost` injects one explicit `CurrentSessionEffects` object into normal `chat` and `executeTools` calls. Provider streaming/reset, abort registration/cleanup, prompt-cache persistence, message append, and failed-batch explicit-wait rollback therefore do not require an implicit lookup of the current hot Session. Low-level/one-shot requests without injected effects retain their existing behavior and are outside this seam.
- The same local effects binding exposes only a non-serialized `persistCurrentSession` callback inside the tool runtime context. Current `set_goal` uses it to persist its passed Session; no new RPC method or `CurrentSessionEffects` operation was added.

## Compatibility

- Existing legacy bracketed system/source content is recognized during serialization/history repair. New wrappers use current Foxwarm tags.
- Documented legacy system-prompt location and memory frontmatter shapes remain readers.
- Provider/model field compatibility is owned by [src-config](./src-config.md#compatibility).

## Design decisions

### D-llm-provider-router

Provider type selects one current request protocol: Responses, Chat Completions, or Anthropic Messages. Provider-specific message/stream code is separated where it has a stable boundary.
