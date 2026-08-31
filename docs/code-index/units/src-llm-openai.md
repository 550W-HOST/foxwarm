# Unit: src-llm-openai

Files: src/llmProviders/openai.ts, src/llmProviders/openai.test.ts

## Purpose

Implements the OpenAI LLM provider, handling conversion of internal message formats to OpenAI API formats (Chat Completions and Responses APIs) and streaming SSE response collection with progress reporting.

## Key Exports

- `convertToOpenAIFormat(contents, concreteModelId?, historyReasoningField?)` — Converts internal `Message[]` to OpenAI Chat Completions message format, emits model-scoped provider metadata only for its originating concrete model, and selects exactly one configured assistant-history reasoning key
- `convertToOpenAIResponsesFormat(contents, concreteModelId?)` — Converts internal `Message[]` to OpenAI Responses API input format and replays same-concrete-model hosted output metadata in order
- `collectOpenAIResponsesStream(stream, signal, options?)` — Collects and reassembles a streamed OpenAI Responses API SSE response; options can receive raw decoded chunks and complete SSE blocks
- `collectOpenAIChatCompletionsStream(stream, signal, options?)` — Collects and reassembles a streamed OpenAI Chat Completions SSE response; options can receive raw decoded chunks and complete SSE blocks
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
- **Image handling**: Embeds inline image data as `image_url` parts with base64 data URIs, associates images with their originating tool calls, and appends image guidance text.
- **Tool timing marker**: When the first persisted function response in a batch carries preceding-request timing, both OpenAI serializers prepend one `kind="time"` marker before that call's images/output. The cross-module contract is [D-pipeline-input-time](../threads/message-processing-pipeline.md#d-pipeline-input-time).
- **SSE stream collection**: Both stream collectors parse chunked SSE data using a buffer with `\n\n` delimiters, handle `[DONE]` sentinel, and support abort signals. They incrementally build up the response object from deltas. They also expose optional `onRawChunk(text)` and `onRawSseBlock(block)` callbacks so the caller can log exact decoded provider stream data without changing parser semantics.
- **Progress reporting**: Both collectors emit `onProgress` callbacks with current snapshot state (reasoning text, output text, tool call names/indices) as deltas arrive.
- **Responses API specifics**: Handles `response.output_item.added`, text/refusal/arguments deltas, URL annotation events, reasoning summary parts, and `response.completed`. Preserves completed `web_search_call` output items and annotations for provider-neutral history replay; the request serializer emits them only for their producing concrete model and keeps their output order. When `response.completed.output` is condensed relative to interleaved streamed output indexes, the streamed indexed sequence remains authoritative; completed-output enrichment is used only when the full arrays are contiguous, equal-length, same-type, and nonconflicting by present IDs. Hosted search items are never converted into Foxwarm function calls.
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
