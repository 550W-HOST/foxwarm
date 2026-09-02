# Unit: src-llm-gemini

Files: `src/llmProviders/gemini.ts`, `src/llmProviders/gemini.test.ts`

## Purpose

Implements Gemini's native `generateContent` protocol: provider-neutral history conversion, function declaration schema normalization, thought-signature replay, and streamed SSE response collection.

## Key exports

- `convertToGeminiFormat(contents)` — converts Foxwarm messages to Gemini `contents`, including text, thoughts, function calls/results, timing markers, and inline images.
- `convertJsonSchemaToGeminiSchema(schema)` — removes JSON Schema keywords unsupported by Gemini function declarations while retaining the callable shape.
- `collectGeminiStream(stream, signal, options?)` — collects `streamGenerateContent?alt=sse` chunks into one response and emits text/reasoning/tool progress snapshots.
- `GeminiStreamProgressSnapshot` — provider-neutral streaming progress shape.

## Behavior

- User and tool messages become Gemini `user` content; model messages become `model` content. Adjacent equal roles are merged only in the outbound clone.
- Persisted provider thought signatures are sent as `thoughtSignature` only when the shared concrete-model compatibility filter retained them.
- Function responses retain call IDs and names, carry formatted structured output, and attach matching tool-result images. All responses for a tool batch are serialized before timing markers, interruption text, or images in the immediately following user turn; this satisfies both native Gemini and Claude-backed gateways that preserve Anthropic's strict tool-result adjacency rule.
- Missing streamed function-call IDs receive deterministic content-derived IDs so Foxwarm can pair later tool responses.
- Streaming preserves ordered text, thought, function-call, and inline-data parts and retains the last usage metadata and finish reason.
- Abort and malformed SSE behavior follow the same request-layer error/retry path as OpenAI stream collectors.

## Integration

- `src/llm.ts` selects this unit for concrete `providerType: gemini`, builds the native model URL and headers, and normalizes response parts and usage.
- Canonical hydrated images are converted only at the provider boundary and Gemini `inlineData.data` is redacted from request diagnostics.
- Configuration defaults and public schema exposure are owned by [src-config](./src-config.md).

## Design decisions

[2026-09-02] Native Gemini is a first-class concrete provider protocol rather than an OpenAI-compatible alias. Its configured `baseUrl` includes the native API version root (normally `v1beta`); the request layer appends `/models/<encoded-model>:streamGenerateContent?alt=sse` and authenticates `apiKey` with `x-goog-api-key`.

Provider-neutral `effort: none` maps to a zero thinking budget. Non-zero effort deliberately leaves Gemini's model-native policy unchanged because supported controls vary between budget-based and level-based model generations; model configuration remains the place to select a specific tier or add explicit native request fields.
