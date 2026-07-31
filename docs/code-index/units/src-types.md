# Unit: src-types

Files: src/types.ts

## Purpose

Defines the core TypeScript interfaces and type aliases used throughout the system for messages, sessions, LLM interactions, tool definitions, and streaming events.

## Key Exports

- `MessagePart` — Polymorphic message content block (text, thinking, function calls, inline data, etc.)
- `FunctionCall` / `FunctionResponse` — Tool invocation and result structures
- `MessageProviderMeta` — Message-level opaque provider metadata persisted on assistant messages and echoed back verbatim on later requests; `providerSpecificFields` carries the OpenAI Chat Completions `provider_specific_fields` (e.g. `reasoning_signature`) round-trip
- `Message` — Role-tagged message with parts and metadata
- `Session` — Full session state including history, queue, stats, model config, and context frontier
- `QueueItem` / `QueueSource` — Inbound work items and their origin metadata; `QueueSource.weworkStreamId` carries WeWork stream/card binding from channel intake into the turn loop
- `ChatResult` — LLM response envelope with text, provider-prefixed concrete model id, optional resolved virtual model key, usage, and tool calls
- `ToolDefinition` / `ToolFunction` — Tool schema and handler signature
- `SessionStreamEvent` — Real-time WebUI streaming/progress events
- `ChannelTurnProgress`, `ChannelTurnToolRef`, `ChannelTurnToolResult` — Transient per-turn channel display progress for LLM/tool status, currently consumed by WeWork stream-card aggregation; `tool-calls-start` can carry model text for atomic text+running-tool card updates.
- `TokenUsage` / `SessionStats` / `SessionTokenTotals` — Token accounting. `TokenUsage.reasoningTokens` is an optional provider-reported component of `outputTokens`, never an additional total.
- `AnthropicMessage` / `AnthropicContentBlock` / `OpenAIResponsesContent` — Provider-specific message formats
- `ContextBlockMessageMeta` — Structured metadata attached to rendered CTX-BLOCK messages under `Message.__meta.contextBlock` for WebUI/API consumers.
- `ContextFrontierItem` — Layered-context frontier tracking
- `MaybePromise<T>`, `SessionReply`, `SessionBroadcast` — Utility types

## Function Index

No functions or methods are defined in this file — it contains only interface and type declarations.

## Dependencies

None. This file has no imports from other project modules or external packages.

## Behavior

Pure type declarations with no runtime logic, state changes, or side effects. The `Session` interface defines mutable state shape (busy flags, queue, history, stopping flag) that is managed elsewhere, plus metadata such as optional WebUI `sidebarOrder` sibling ordering and `pinned` presentation state. The `Message.modelVisible` field controls whether a message is included in LLM context. Model-message `__meta` may carry `usage`, concrete `modelId`, optional `virtualModelKey`, `contextBlock`, `contextFrontierItem`, and `preservedFromBlockId`; LLM request construction strips `__meta` before provider calls. `usage.reasoningTokens`, when present, is a provider-reported subset of `usage.outputTokens`; its cross-module accounting contract is [D-pipeline-provider-usage-components](../threads/message-processing-pipeline.md#d-pipeline-provider-usage-components). Canonical model-attribution semantics belong to [D-model-routing-concrete-attribution](../threads/model-routing.md#d-model-routing-concrete-attribution). `ContextFrontierItem` is a discriminated union supporting layered compaction.

## Integration

This is the foundational type module consumed across the entire system — session management, LLM adapters (Anthropic, OpenAI), tool execution, message queuing, streaming, channel progress display, and compaction all depend on these definitions. Provider-specific types (`AnthropicMessage`, `OpenAIResponsesContent`) bridge the internal `Message` format to external API shapes.