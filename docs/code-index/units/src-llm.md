# Unit: src-llm

Files: src/llm.ts, src/llmRequestTiming.ts, src/llm.test.ts, src/llmRequestTiming.test.ts, src/llmRouting.test.ts, src/llmVirtualRouting.test.ts, src/llmVirtualMessageMeta.test.ts, src/parallelToolExecution.test.ts
Secondary files: src/llmRequestJournal.ts

## Purpose

Owns provider request routing, Anthropic conversion/parsing, session prompt snapshots, prompt-cache keys, retries/aborts, interaction logs, stream progress, unified result parsing, tool execution batches, and one-shot requests. OpenAI and Gemini conversion/stream assembly are delegated to their provider modules.

## Key exports

- `chat(parts, session, iteration?, options?)` — optionally append user parts, request one provider turn from current model-visible history while forwarding the Session's raw optional effort, update stats, and append the model result.
- `requestLlmOnce(options)` — provider request without automatic session-history orchestration.
- `executeTools(functionCalls, toolContext, session)` — model-ordered tool batch execution with serial barriers, bounded adjacent direct-exec segments, progress/control folding, and one final tool message.
- `CurrentSessionEffects`, `CurrentSessionTurnEffects`, and `createDefaultCurrentSessionEffects()` — local-only normal-turn hooks. The provider/tool base carries a trusted local/Session-worker placement marker plus append/persist, stream, abort, and explicit-wait rollback; the runner extension adds canonical append-many, busy, wait, and history/runtime event ownership. They are not DTOs or RPC contracts.
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
| `gemini` | Gemini native SSE at `<baseUrl>/models/<model>:streamGenerateContent?alt=sse` |
| `session-hash`, `failover` | Resolve a concrete leaf per outer attempt, then use that leaf's protocol |

`getOpenAIRequestApi()` returns null for non-OpenAI values. `gemini` has an explicit native branch; remaining custom provider types retain Anthropic-compatible behavior unless source routing is extended.

## Tool-response formatting

Anthropic conversion and both OpenAI serializers use `packages/shared/src/toolResponseFormatting.ts` through the built shared package. Structured tool responses remain structured internally; the shared formatter owns provider-facing text. Image parts are promoted separately and accompanied by image guidance. Canonical decision: [D-llm-shared-response-format](../modules/llm.md#d-llm-shared-response-format).

## Prompt snapshot behavior

- Framework prompt precedence: top-level agent framework prompt, then documented legacy main-agent framework fallback.
- Memory is resolved across inherited/current agents with session frontmatter filters.
- Visible skills are listed as compact metadata; full skill docs remain on-demand.
- Dynamic hints include agent folder and layered-context recall guidance.
- Prompt-cache keys are random UUIDs tied to model-facing prefix lineage and persisted by normal session callers. Canonical lineage: [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).
- Provider `extraFields` and `extraHeaders` expand `${SESSION_CACHE_KEY}` from the resolved prompt-cache key and `${TURN_ID}` from the request's ephemeral turn identity. A low-level request generates one fallback identity for its retry set; the normal SessionTurnRunner supplies one identity for the whole session turn.
- A provider-neutral optional request effort is resolved once per outer request. Each physical concrete attempt uses the requested value when its leaf allows it, otherwise that leaf's configured default. Requests without an explicit value use the selected leaf default.

## Request behavior

- Provider payloads are sanitized for lone surrogates and may be gzip/brotli compressed per model config.
- Canonical image references are hydrated into cloned messages immediately before provider serialization for all four protocols. That shared boundary normalizes current HEIC/HEIF references to provider-safe raster data while persisted messages remain reference-only, and request/virtual-route diagnostics redact hydrated image payloads. Canonical contract: [image blob lifecycle](../threads/image-blob-lifecycle.md).
- OpenAI and Anthropic payloads receive current tool schemas and current Foxwarm system/source wrappers.
- The application-level `llm.maxOutput` limit is sent as `max_output_tokens` to OpenAI Responses, `max_tokens` to Chat Completions and Anthropic-compatible requests, and `generationConfig.maxOutputTokens` to Gemini. Provider/model `extraFields` may override it at their existing later merge boundary; the default and canonical configuration contract are [D-config-default-max-output](./src-config.md#d-config-default-max-output).
- Gemini sends the same application output limit as `generationConfig.maxOutputTokens`, carries native thought signatures and function call IDs through concrete-model-scoped history, accepts image-only output as usable, and maps native usage metadata into the shared token fields. Detailed conversion and stream ownership are in [src-llm-gemini](./src-llm-gemini.md).
- OpenAI Responses and Chat Completions custom function tools explicitly set `strict: false` at their protocol-defined tool locations while preserving each JSON Schema `required` array unchanged. Anthropic continues to receive the same schema through `input_schema`.
- Canonical history keeps logical queued messages separate. The Anthropic serializer coalesces adjacent same-role entries only in its outbound payload, while OpenAI serializers retain separate message entries. Queue-boundary ownership is [D-pipeline-canonical-queue-item-boundaries](../threads/message-processing-pipeline.md#d-pipeline-canonical-queue-item-boundaries).
- Streaming progress emits throttled reasoning/text/tool-call snapshots.
- Retry waits are abortable. Terminal failures move bounded diagnostics to error logs, emit a final retry event, and throw `LlmRequestError`; they do not create fake assistant `Error:` messages. Canonical boundary: [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).
- A caller may supply an independent `abortSignal` to `chat`/the one-shot request path. Compaction uses this seam with ordinary Session-turn abort registration disabled, so `/stop` and `/stop compact` cannot cancel each other's provider request when both overlap.
- The historical `maxRetries` option/event field means total attempts; the default is six. Virtual attempts rebuild the complete selected concrete request, and unusable empty/reasoning-only responses retry. Canonical semantics: [model routing](../threads/model-routing.md).
- First-class effort is applied after expanded `extraFields` on an attempt-local payload, overriding only known effort/thinking paths without mutating model configuration. OpenAI Responses uses `reasoning.effort`, Chat Completions uses `reasoning_effort`, and Anthropic-format providers use `output_config.effort`; `none` also maps to Gemini's zero thinking budget, while non-zero Gemini effort leaves the model-native policy unchanged. The removed global thinking-budget mechanism no longer injects `budget_tokens`.
- HTTP classification recognizes nested structured model-not-found errors and bounded common text forms without broadening ordinary HTTP 400 retries. A virtual outer request captures route activation once so old retries cannot replace newer configuration state.
- Successful results normalize into `ChatResult`, record the provider-qualified concrete model ID and usage, and may contain function calls for the router loop. A virtual route additionally carries its resolved configuration key through `ChatResult.virtualModelKey` into every successful provider-generated assistant message, including tool-call-only turns; canonical semantics are owned by [D-model-routing-concrete-attribution](../threads/model-routing.md#d-model-routing-concrete-attribution).
- Normal chat request history retains only a model message's canonical concrete `__meta.modelId` as provider-planning provenance; all other internal metadata remains excluded. Each physical attempt uses that identity on an attempt-local clone to remove model-specific reasoning artifacts only after a proven concrete-model mismatch, then strips all `__meta` before any provider serializer. Virtual failover therefore re-evaluates compatibility for every selected leaf without mutating canonical history. Canonical contract: [D-model-routing-history-reasoning-compatibility](../threads/model-routing.md#d-model-routing-history-reasoning-compatibility).
- OpenAI Chat Completions response parsing carries JSON-object `provider_specific_fields` into `ChatResult.providerMeta` with the producing concrete `modelId`; `chat` persists that scoped metadata on the assistant message. Later Chat Completions request plans pass their exact concrete model ID to the serializer, so the opaque fields round-trip only to the same concrete model and are omitted after model switches or on incompatible virtual targets.
- OpenAI Responses can opt into the hosted `web_search` tool through concrete model `webSearch` settings. Raw provider/model config accepts the designated boolean/object form and resolves to a normalized object before inheritance/use. The tool is appended beside Foxwarm function tools for eligible Responses requests (not compact/setup-test requests); completed `web_search_call` items and URL annotations persist as ordered model-part metadata and are replayed only to the producing concrete model. They never enter `executeTools` or produce `function_call_output`. General toggle shape is canonical in [D-config-feature-toggle-shorthand](./src-config.md#d-config-feature-toggle-shorthand).
- OpenAI Responses maps only its official `usage.output_tokens_details.reasoning_tokens`, OpenAI Chat Completions maps only `usage.completion_tokens_details.reasoning_tokens`, and Gemini maps `usageMetadata.thoughtsTokenCount`. Reported reasoning remains a component of the full output total; Anthropic Messages has no corresponding separately reported field. Cross-module accounting semantics are [D-pipeline-provider-usage-components](../threads/message-processing-pipeline.md#d-pipeline-provider-usage-components).
- Provider usage remains optional: a usable response without a usage object succeeds and simply omits token accounting, including OpenAI-compatible Chat Completions streams which ignore `stream_options.include_usage`.
- Display-only messages and internal `__meta` are excluded from provider payloads; the narrow historical concrete model provenance used during request planning remains journal-visible but is stripped before serialization.
- Before the first physical send, `requestLlmOnce` journals the repaired provider-neutral messages, system prompt, and exact tool schema through content-addressed objects and a bounded manifest. Every physical attempt records concrete routing and a semantic-payload digest; canonical ownership is [canonical LLM request journal](../threads/llm-request-journal.md).
- Successful `ChatResult` values carry the durable request/attempt identity and logical request timing. The successful journal result retains both, and `chat` persists the identity plus `startedAt`, `completedAt`, and monotonic `durationMs` on assistant metadata. Post-response journal-result failures are logged without entering the provider retry loop. Canonical timing semantics belong to [D-pipeline-input-time](../threads/message-processing-pipeline.md#d-pipeline-input-time).
- Tool execution keeps per-call result/image/control state local. Direct provider calls resolve through the same canonical resolver/executor as unified and ToolScript calls, so only Node capabilities follow `currentNode`; capability source remains separate from process placement and permission checks. A non-master Node ID enters the fixed Node execution service for Main-owned provider resolution, MCP enters its fixed external service, and master-local Node capabilities invoke the named handler with no Node RPC. Adjacent direct `exec` calls use a bounded parallel segment and pass one captured node/cwd snapshot; all other tools are barriers, and final parts are flattened in original call order. Canonical contracts: [D-dispatch-resolved-target](../threads/tool-dispatch.md#d-dispatch-resolved-target), [D-dispatch-generic-node-providers](../threads/tool-dispatch.md#d-dispatch-generic-node-providers), [D-dispatch-exec-parallel-segments](../threads/tool-dispatch.md#d-dispatch-exec-parallel-segments), and [D-dispatch-node-environment-placement](../threads/tool-dispatch.md#d-dispatch-node-environment-placement).
- Tool-start argument previews normalize strings, primitives, objects, arrays, and malformed raw argument text into a bounded string before logging, broadcast, or runtime-state publication. This presentation normalization preserves the strict Session-worker publication DTO contract in [D-process-topology-session-events](../threads/process-topology-and-rpc.md#d-process-topology-session-events).
- `executeTools` resolves exactly one source owner before preparing any call. A `LocalSessionTurnHost` call with `CurrentSessionEffects` trusts only the exact passed Session whose identity matches (or supplies) the source ID; a mismatch fails before tool/effect work. A legacy/direct call without effects ignores passed Session objects, loads one existing source Session by ID, and fails rather than creating a missing source. Routing, permission, handler context, current-session persistence, and the captured parallel-exec node/cwd snapshot all use that same owner.
- The first persisted response in a tool batch may carry the successful preceding LLM request timing for serializer-owned model input; canonical contract: [D-pipeline-input-time](../threads/message-processing-pipeline.md#d-pipeline-input-time).
- Tool-result internals fold explicit wait-token cleanup and successful handoff post-actions without exposing hidden sentinels to providers. Successful `send_to_session` calls additionally retain only their exact resolved targets in hidden batch metadata; failed calls and other tool names cannot contribute targets. The router owns post-append wait arming under [D-pipeline-handoff-wait](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait) and parent-boundary resolution under [D-pipeline-persisted-child-handoff-boundary](../threads/message-processing-pipeline.md#d-pipeline-persisted-child-handoff-boundary).
- The current real `LocalSessionTurnHost` binds one explicit `CurrentSessionTurnEffects` object across runner, `chat`, and `executeTools`. Provider streaming/reset, abort registration/cleanup, prompt-cache persistence, one/many message append, complete busy transitions, wait persistence, history/runtime events, and failed-batch explicit-wait rollback therefore can use the same exact Session owner without an implicit current-session lookup. Default unbound busy claims retain the destructive-lifecycle guard, use the full exact-owner save, and rely on that save's single state notification; base-effects adapters persist through the supplied method receiver and add the legacy local notification once. Explicit bound custom turn effects own their detached fencing policy. Low-level/one-shot requests without injected effects retain their existing behavior and are outside this seam.
- The same local effects binding exposes a non-serialized `persistCurrentSession` callback and trusted placement marker inside the tool runtime context. Current `set_goal` uses the callback to persist its passed Session; Worker tool guards consume the marker before raw handler dispatch without inferring placement from arguments or Session presence.

## Compatibility

- Existing legacy bracketed system/source content is recognized during serialization/history repair. New wrappers use current Foxwarm tags.
- Documented legacy system-prompt location and memory frontmatter shapes remain readers.
- Provider/model field compatibility is owned by [src-config](./src-config.md#compatibility).

## Design decisions

### D-llm-provider-router

Provider type selects one current request protocol: Responses, Chat Completions, Anthropic Messages, or Gemini native generateContent. Provider-specific message/stream code is separated where it has a stable boundary.

### D-llm-openai-non-strict-function-tools

[2026-08-13] Every Foxwarm custom function tool sent through OpenAI Responses or Chat Completions explicitly uses non-strict mode. The original JSON Schema `required` list remains the sole provider-facing required-key contract, so optional properties may be omitted; runtime tool validation and defaults remain authoritative. Responses places `strict: false` beside `parameters`, while Chat Completions places it inside the nested `function` object. Hosted provider tools such as Responses `web_search` and Anthropic `input_schema` are unchanged.
