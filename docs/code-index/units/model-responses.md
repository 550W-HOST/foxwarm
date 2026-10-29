# Unit: OpenAI Responses HTTP and WebSocket adapters

Files: `dotnet/Foxwarm/Models/Responses/ResponsesAttempt.cs`, `dotnet/Foxwarm/Models/Responses/HostedResponsesTools.cs`, `dotnet/Foxwarm/Models/Responses/OpenAIResponsesClient.cs`, `dotnet/Foxwarm/Models/Responses/ResponsesRequestPlan.cs`, `dotnet/Foxwarm/Models/Responses/ResponsesStreaming.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsChatService.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsResource.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsState.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsTransport.cs`

## Purpose

Plans and sends Responses requests, collects event streams, executes supported hosted tools, and manages stateful Responses WebSocket leases/handshakes.

## Stable methods and callers

- `ResponsesRequestPlan` derives request JSON, previous-response/state handles, tool definitions, image parts, and journal-safe request text.
- `OpenAIResponsesClient.ExecuteAsync` owns HTTP response status/error handling and returns a streaming/non-streaming attempt result.
- `ResponsesEventAccumulator`/`ResponsesSseCollector.CollectAsync` parse response events, record output text/reasoning/tool calls/usage, emit rebuilt completed items (including streamed summary/content enrichment), and stop on terminal/error events.
- `ResponsesAttempt` shares SSE/WS completed-prefix ordering, guarded reasoning retention, conversion, per-physical-attempt generated-image budget and suffix extraction. The exact ordinary turn host supplies its append/delivery callback; detached services have no segment-commit authority.
- `HostedResponsesTools` exposes provider-hosted search/hosted tools as definitions/results; it does not grant local filesystem or Session authority.
- `ResponsesWsChatService`, `ResponsesWsResource`, `ResponsesWsState`, and `ResponsesWsTransport` own connection lease, handshake, resumable state, close/error, and resource disposal for WebSocket turns.

Callers: `SessionChatService`, `ModelRequestOwner`, model routing, image transport, and `LlmRequestJournalStore`. The turn host decides when a provider result becomes canonical Session history.

## Contract and side effects

HTTP/SSE and WebSocket attempts preserve provider request IDs and usage/error provenance. Both adapters return normalized result usage even when an empty completed response has no canonical assistant row, so the owner can commit cumulative totals without manufacturing history. A disconnected stream or invalid event leaves the attempt incomplete; already committed completed commentary remains canonical, while uncommitted drafts and partial tool calls do not. Retry preparation uses current committed history rather than duplicating segments; see the [segment flow](../threads/model-request-and-streaming.md#completed-responses-segments). Hosted tools remain provider-scoped and are not confused with local ToolAuthorization.

WebSocket transport failure normalization checks the original caller's cancellation as well as the linked attempt token before classifying a resource interruption. Ordinary Stop therefore reaches abort journaling even when the resource's caller callback wins the linked-token race; independent inactivity deadlines, upstream disconnects and provider failures retain their own classifications. This does not change send, retry or routing-health policy.

Routine WS dispatch, completion, expected discard and idle close diagnostics use the shared [Main diagnostic boundary](./dotnet-webui-logs.md#real-producer-and-lifetime) rather than treating every stderr lifecycle line as an ERROR. Request/receive/replay failures, attempt timeouts, an active upstream close and abnormal close codes remain failures; caller cancellation remains ordinary lifecycle. A normal peer acknowledgement of an idle close requested locally (pool clear, expiry or eviction) is also routine; the resource records that idle-close intent before entering Closed rather than treating every Closed resource as a successful close. Non-Main callers keep diagnostics on stderr, not their stdout payload stream.

`ResponsesClientOptions.RequestModel` carries the resolved upstream name, while `ConcreteModelId` remains the configured internal provider-qualified identity for attribution and WS connection ownership; native-history admission uses the captured catalog [compatibility projection](./model-configuration.md#native-history-compatibility). The [configuration unit](./model-configuration.md#contract-and-side-effects) owns `upstreamModelId` resolution. Equal upstream names alone never merge native replay or WS chains.

Configured HTTP Responses requests (`openai` and `openai-responses`) send the owner's prompt-cache lineage as `prompt_cache_key`; WebSocket requests retain their existing Session/scope-derived key. `ConfiguredModelRequests.Plan` passes the selected key to `ResponsesRequestPlan`, where expanded `extraFields` retain normal override precedence.

Indexed reasoning-summary part-added, part-done, text-delta and text-done events synthesize a reasoning output item even without output-item lifecycle notifications. Part text replaces the indexed summary, including an empty string; an empty text-done retains existing text. Ordered progress and completed output preserve indexed summary boundaries. A positionally aligned final output enriches those items with final fields such as encrypted reasoning; condensed or unaligned output does not replace the stream's indexed sequence.

## Replay and hosted output boundaries

WebSocket state belongs to the concrete request/cache generation and its owned connection lease. The complete semantic body is prepared and its digest recorded before connection-specific suffix selection or reconnect. Reuse depends on compatible committed input and tool pairs, not merely a prior response ID. Malformed function arguments use the shared [per-call argument-error boundary](./session-domain.md#tool-argument-parsing), preserving valid siblings and safe replay instead of retrying the complete response. A reconnect sends the appropriate complete request rather than pretending a failed socket retained state.

### D-responses-hosted-tool-purpose

**Derived constraint; explicitly selected after comparing ordinary and compact requests.** It serves [prefix stability](../threads/conditional-memory-snapshots.md#d-memory-request-prefix-stability) alongside the [shared custom-tool schema](../modules/llm.md#d-llm-stable-tool-schema). Declaration equality is required; array construction and request-purpose handling below are its implementation. Native execution remains a provider effect and is not governed by the local custom-call gate.

[2026-10-27] Ordinary turns and dedicated `compact-plan` requests use the same configured native `web_search` and `image_generation` declarations, options, array order and `tool_choice` precedence. This includes both awaited and background compaction: their shared journal purpose selects the same declarations even though their request scopes can differ. `ResponsesRequestPlan` appends search then image after custom functions; configured search choice and `extraFields` overrides retain ordinary precedence. Keeping this part of the request identical supports the [stable request prefix](../threads/conditional-memory-snapshots.md#d-memory-request-prefix-stability). The distinct `background` and `setup-test` purposes continue to suppress configured hosted tools. Background compaction's independent [WebSocket cache-key scope](../threads/model-routing.md#d-model-routing-openai-ws-prompt-cache-key) is unchanged.

These declarations permit provider-hosted execution upstream. The compact planner's [local custom-call gate](../threads/context-compaction.md#d-context-compact-runtime-gate) controls local dispatch and plan acceptance, not provider-hosted execution.

Generated bytes pass through the existing blob store before canonical result/journal publication. Classification reuses `RasterImageMime.Detect` while retaining PNG/JPEG/WebP/GIF only, with BMP explicitly rejected. Strict base64, declared-format matching and blob-reference validation remain unchanged. Limits are 32 MiB decoded per image, 64 MiB cumulative per physical attempt, and eight successfully externalized images. Partial-image events carry status only, not preview bytes.

History-compatible Responses generated-image replay uses verified original blob bytes, including declared model/provider variants at both hydration and final native serialization. Incompatible/protocol-mismatched requests use bounded placeholder/local-ID guidance without reading that blob; a missing compatible blob fails locally before send. Image outcomes use the shared physical attempt's cumulative successful externalization count across committed prefixes and the final suffix. Prior commentary is not image success. A failed-image-only suffix with no successful image produces the existing non-retryable, non-countable response error after provider output processing, not a pre-send hydration failure. A successful prefix image followed by failed suffix images adds the actual failure note only to the suffix, without republishing image parts or usage. Web-search metadata and generated-image allowlisting have different contracts; do not apply the image allowlist to search output. Canonical history and journal retain references, not hydrated base64. See [model request ordering](../threads/model-request-and-streaming.md) and [image ownership](../threads/images-and-attachments.md).

SSE and WebSocket image activity share the attempt-local latched inactivity floor in [wire helpers](./model-common-wire.md). The floor survives an image completion and later ordinary output; Stop and explicit hard deadlines remain independent.

## Tests

`dotnet/Foxwarm.Tests/Models/DefaultToolWireTests.cs` drives ordinary SessionManager turns with the full selected default catalog through HTTP and WebSocket peers that reject missing function discriminators and malformed function envelopes. Both paths resolve model-level search/image enablement, disablement and inherited tuning into the final wire options, keep native declarations separate, execute an explicit channel send against an owned fake, and continue with the paired tool result. Companion declaration and serializer tests cover discovery-only local functions and the Completions/Anthropic schema projections without starting channel consumers.

`dotnet/Foxwarm.Tests/Sessions/RequestPrefixTests.cs` compares final ordinary and compact HTTP/WS requests with enabled/disabled hosted features, native options/order, search choice and `extraFields.tool_choice` override, identical instructions and older history, and a successful plan submission/commit. Awaited WS retains the ordinary cache key; background WS retains its independent key. `ModelInteractionDiagnosticsTests` also checks compact declarations and unchanged `background`/`setup-test` suppression while keeping image diagnostics content omitted.

`dotnet/Foxwarm.Tests/Models/ResponsesClientTests.cs`; `ResponsesStreamingTests.cs`; `ResponsesWsTests.cs`; `HostedResponsesToolsTests.cs`; hosted WebSocket image tests; `ResponsesPrefixCommitTests.cs` (durable prefix/failure/Stop/retry, guarded reasoning, barriers, local failure, empty suffix and image replay); `HostedImageWatchdogParityTests.cs` (controlled-clock actual SSE/WS activity and hard deadline).

`ResponsesWsCancellationTests.cs` holds linked-attempt propagation behind a real original-caller socket abort, distinguishes independent timeout/disconnect failures, and checks ordinary Stop journal classification, one send and idle owner settlement.

`ResponsesParityTests.cs` exercises ordinary HTTP request owners for both Responses aliases, cache-key overrides, canonical encrypted-reasoning replay, and provider SSE bytes for indexed summary synthesis, part-added seeds, empty replacement and final-output alignment.
