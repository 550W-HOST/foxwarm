# Unit: src-llm-openai

Files: src/llmProviders/openai.ts, src/llmProviders/openaiWsState.ts, src/llmProviders/openaiWsTransport.ts, src/llmProviders/openai.test.ts, src/llmProviders/openaiWsState.test.ts, src/llmProviders/openaiWsTransport.test.ts

## Purpose

Implements the OpenAI LLM provider, handling conversion of internal message formats to OpenAI API formats (Chat Completions and Responses APIs), streaming event collection, and the process-local stateful Responses WebSocket transport.

## Key Exports

- `convertToOpenAIFormat(contents, concreteModelId?, historyReasoningField?)` — Converts internal `Message[]` to OpenAI Chat Completions message format, emits model-scoped provider metadata only for its originating concrete model, and selects exactly one configured assistant-history reasoning key
- `convertToOpenAIResponsesFormat(contents, concreteModelId?)` — Converts internal `Message[]` to OpenAI Responses API input format and replays same-concrete-model hosted output metadata in order
- `collectOpenAIResponsesStream(stream, signal, options?)` — Collects and reassembles a streamed OpenAI Responses API SSE response; options can receive raw decoded chunks and complete SSE blocks
- `collectOpenAIChatCompletionsStream(stream, signal, options?)` — Collects and reassembles a streamed OpenAI Chat Completions SSE response; options can receive raw decoded chunks and complete SSE blocks
- `fingerprintOpenAIWsRequest(data)` / `extendOpenAIWsPrefix(prefix, replayItems)` — Build stable item-boundary hash chains over final provider-visible Responses requests and exact assistant replay projections
- `OpenAIWsCompletedChainPool` — Process-local idle-chain matching/retention primitive; active transport leases remain outside the pool
- `requestOpenAIResponsesWs(options)` — Sends one Responses `response.create` event over a fresh or exact-prefix-matched socket and returns a completion held pending canonical history commit
- `clearOpenAIWsCompletedChains()` — Bounded resource/test cleanup seam for process-owned idle sockets
- `OpenAIStreamProgressSnapshot` — Type for progress callback snapshots
- `OpenAIStreamToolCallSnapshot` — Type for tool call state during streaming

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `makeAbortError(message?)` | ~10 | Creates a standardized abort error with code |
| `parseSseEventBlock(block)` | ~20 | Parses a single SSE event block into JSON |
| `buildReasoningSummaryText(summaryParts)` | ~12 | Sorts and joins reasoning summary parts into text |
| `appendDelta(existing, delta)` | ~6 | Appends a string delta to an existing value |
| `cleanSnapshotString(value)` | ~6 | Trims and returns a string or undefined |
| `mergeResponseContentPart(existing, incoming)` | ~15 | Merges two content parts for Responses API streaming |
| `mergeResponseOutputItem(existing, incoming)` | ~35 | Deep-merges output items including content/summary arrays |
| `hasUsableReasoningSummary(summary)` | ~7 | Detects streamed reasoning summary text that must survive completed-output enrichment |
| `convertToOpenAIFormat(contents, concreteModelId?, historyReasoningField?)` | ~180 | Converts internal messages to OpenAI Chat Completions format with one configured history reasoning key |
| `convertToOpenAIResponsesFormat(contents, concreteModelId?)` | ~115 | Converts internal messages to OpenAI Responses API format |
| `collectOpenAIResponsesStream(stream, signal, options?)` | ~180 | Collects SSE stream for Responses API, rebuilds output items |
| `collectOpenAIChatCompletionsStream(stream, signal, options?)` | ~250 | Collects SSE stream for Chat Completions API, rebuilds message |

## Dependencies

- `../common` — `logger`
- `../types` — `Message`, `MessagePart`, `OpenAIResponsesContent`
- `../toolCallArgs` — `stringifyFunctionCallArgs`
- `../../packages/shared/dist/toolResponseFormatting` — `formatToolResponsePayload`
- `../toolImages` — `appendImageGuidanceText`

## Behavior

- **Message conversion**: Transforms internal message structures (with `parts` containing `functionCall`, `functionResponse`, `inlineData`) into OpenAI's expected formats. Handles role mapping (`model` → `assistant`), groups tool responses by `tool_call_id`, serializes function call arguments, and renders `MessagePart.system` through Foxwarm XML-ish prompt wrappers instead of legacy `[SYSTEM:]` text.
- **Image handling**: Embeds inline image data as `image_url` parts with base64 data URIs, associates images with their originating tool calls, and appends image guidance text. Both serializers use the shared request-local dedup transform; Responses excludes assistant images from eligibility because that protocol drops them. Tool images are associated to one exact response occurrence of the same ID by nearest part distance, preferring the preceding response on a tie; this supports canonical response-then-image and historical image-then-response order without duplicating guidance across repeated IDs. A deduplicated tool-ID orphan still emits one bounded tool-associated marker without a repeated data URI.
- **Tool timing marker**: When the first persisted function response in a batch carries preceding-request timing, both OpenAI serializers prepend one `kind="time"` marker before that call's images/output. The cross-module contract is [D-pipeline-input-time](../threads/message-processing-pipeline.md#d-pipeline-input-time).
- **SSE stream collection**: Both stream collectors parse chunked SSE data using a buffer with `\n\n` delimiters, handle `[DONE]` sentinel, and support abort signals. The Responses collector terminates promptly on official `response.incomplete` and top-level `error` events as well as `response.failed`; compatible `response.error` remains accepted. Terminal diagnostics retain bounded provider message/status/code context. The collectors incrementally build up the response object from deltas and expose optional raw-capture callbacks plus an unthrottled meaningful-progress callback. Only nonempty generated reasoning/text/refusal/function-argument deltas trigger timeout activity; structural events, hosted-search state, IDs/names, usage, empty deltas, and done snapshots do not. This callback is independent of presentation subscriptions and WebUI throttling.
- **Progress reporting**: Both collectors emit cumulative `onProgress` snapshots containing reasoning, output text, and per-call index/id/name plus cumulative raw argument JSON. Chat Completions preserves its reused-index split rules; Responses uses provider output indexes. The upstream emitter owns wire-delta conversion and throttling.
- **Responses API specifics**: Handles `response.output_item.added`, text/refusal/arguments deltas, URL annotation events, reasoning summary parts, and `response.completed`. Preserves completed `web_search_call` output items and annotations for provider-neutral history replay; the request serializer emits them only for their producing concrete model and keeps their output order. When `response.completed.output` is condensed relative to interleaved streamed output indexes, the streamed indexed sequence remains authoritative; completed-output enrichment is used only when the full arrays are contiguous, equal-length, same-type, and nonconflicting by present IDs. Hosted search items are never converted into Foxwarm function calls.
- **Stateful Responses WebSocket**: `providerType: openai-ws` uses the Responses request/event format over one provider WebSocket per active chain. Every call begins from a complete final request plan. Rolling SHA-256 fingerprints cover every request invariant except transport-owned `input`, `previous_response_id`, and `stream`, then advance at exact input-item boundaries. An idle candidate must match its secret-safe connection identity and exact prefix; longest-prefix and then newest wins. The wire request sends only the remaining suffix with `previous_response_id`, while unmatched requests send the full input. `max_output_tokens` remains part of the complete logical plan and invariant fingerprint, is sent on every full create, and is omitted only from a matched compact continuation carrying a nonempty `previous_response_id`; a reconnect or failed-reuse recovery sends the full cap again. Completed sockets remain leased until the exact canonical assistant message commits, then the existing serializer projects that message back to provider items before releasing the chain. Refusal responses, malformed function-call arguments, and function calls without a stable provider call ID are conservatively not reused because their canonical replay projection cannot reproduce the original item exactly.
- **Pool/resource boundary**: Busy sockets are excluded from idle matching and retention. Local placement retains at most five completed idle chains and Session-worker placement retains one; release prunes LRU sockets. Every successful canonical assistant append/release starts a fixed unreferenced one-minute idle timer that actively removes and closes the completed chain even when no later request arrives. Taking a chain cancels its timer, and a later successful release starts a fresh full idle period; stale callbacks cannot close an active or pending-append lease. Idle close/error, LRU eviction, pool clear, and reuse all cancel the timer. Entries also retain the provider's 60-minute absolute age boundary between requests. Sockets remain referenced while connecting, generating, and pending canonical assistant append; only completed idle sockets are unreferenced, and a reused lease is referenced again. Close/error/abort listeners remain active across the pending-append gap so a disconnected completion cannot enter the pool. The pool stores fingerprints and response IDs, never messages.
- **Event parser reuse**: WebSocket JSON frames are fed into the same Responses event collector used by HTTP/SSE, preserving output merging, progress snapshots, hosted-search metadata, reasoning summaries, and downstream stream protocol behavior.
- **Reasoning summary boundaries**: Indexed streamed reasoning-summary parts preserve their provider-defined order and boundaries. The final completed payload can enrich aligned reasoning items and supply summaries when the stream produced none, but cannot replace a usable streamed summary array with a condensed entry.
- **Chat Completions specifics**: Accumulates `content`, `reasoning_content`, compatible `reasoning`, and `tool_calls` from choice deltas, tracks `finish_reason` and `usage`, and exposes either reasoning field in transient progress. Canonical response parsing prefers non-empty `reasoning_content` and otherwise accepts non-empty `reasoning`; outbound canonical thinking uses the resolved concrete provider's `historyReasoningField`, defaulting to `reasoning_content`, and never sends both keys. Tool calls retain normal provider-index ordering; a fresh function identity can split broken compatible-provider streams which reuse an index, while id-only fragments continue the current call. The collector captures JSON-object `delta.provider_specific_fields` onto the assembled message. `convertToOpenAIFormat` echoes persisted fields only when `Message.providerMeta.sourceModelId` exactly matches the concrete destination model.

## Integration

- Used by the LLM request layer to format outgoing messages and parse streaming responses from OpenAI's APIs. The request layer wires raw callbacks into bounded `rawStream` response-log capture for both successful and failed streaming attempts.
- Relies on `toolCallArgs` for consistent function argument serialization and `toolImages`/`toolResponseFormatting` for tool result presentation.
- The progress snapshot types are consumed by upstream callers to provide real-time streaming feedback to users.
- Supports both the older Chat Completions API and the newer Responses API through separate conversion and collection functions.

## Design Decisions

- [2026-07-06/2026-07-07] Provider-facing system/source metadata must use `src/utils/promptWrappers`: `MessagePart.system` is serialized as canonical Foxwarm tags when recognized (including legacy compaction/fork identity hints, old time/session strings, and goal reminders), otherwise as `<foxwarm-system kind="system">...</foxwarm-system>`; generated textual source wrappers should pass through as one `<foxwarm-message ...>body</foxwarm-message>` part. Do not reintroduce `[SYSTEM: ...]` generation in OpenAI serializers.
- [2026-08-18] Distinct indexed OpenAI Responses SSE reasoning-summary parts are authoritative for summary boundaries and order. An aligned `response.completed` item may enrich other final fields and may supply a summary only when no usable streamed summary exists; it must not replace a usable streamed summary array with a provider-condensed string. Foxwarm persists the separate entries in `providerMeta.thinkingSummaries` and joins them with newlines for the `thinking` display text; do not infer boundaries later from Markdown or concatenated completed text.
