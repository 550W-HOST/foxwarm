# Unit: src-llm-search-sources

Files: src/llmSearchSources.ts, src/llmSearchSources.test.ts, src/llmSearchSourcesRequest.test.ts, src/llmSearchSourcesWs.test.ts

## Purpose

Preserves hosted Responses search-source data across stream enrichment and prepares per-call, provider-neutral evidence for later model requests. Native search items remain owned by the originating concrete model; URL evidence is portable data, not native tool replay or a citation-reference resolver.

## Interfaces

- `HOSTED_SEARCH_SOURCES_INCLUDE` identifies the Responses include requested when the final tool declaration enables hosted web search.
- `mergeHostedSearchAction` retains streamed source records when later action payloads omit them or contain an empty list, and enriches repeated records by their actual source type and URL.
- `projectHostedSearchEvidence` clones only changed historical model messages and inserts a text data part before local function calls. It runs before incompatible native metadata is removed by concrete-model history preparation.
- `safeHostedSearchUrl` accepts bounded absolute HTTP(S) URLs without credentials, whitespace/control characters, or backslashes.

## Boundaries

- Read actual `action.sources` entries with `type: url`. Optional provider-supplied titles are retained; absent titles are never inferred. `open_page.action.url` is represented separately as an opened page, not as a citation match.
- Evidence carries the producing concrete model, provider call ID, and canonical request ID when available. Missing legacy request IDs do not authorize cross-message deduplication. There is no process-wide or cross-session source index.
- No array index is translated into a private citation reference. Evidence explicitly has no citation-reference mapping and supplies direct URLs instead.
- Evidence is explicitly labeled untrusted external data and JSON-escaped; fetched titles cannot close prompt wrappers. It is not inserted into system/developer instructions or fabricated tool results.
- [2026-11-10] Each call's evidence depends only on its own stored output item: there is no request-wide byte, source or call budget and no recency preference, so a later search never changes evidence already sent with an older message. A single call is capped at 64 sources and 16 KiB of serialized call data. Deduplication keeps the first occurrence. User decision and rationale: [D-hosted-search-evidence-prefix-stability](../threads/web-search-citations.md#d-hosted-search-evidence-prefix-stability), serving [D-request-prefix-stability](../overview.md#d-request-prefix-stability).
- URLs and titles have individual limits; whole records are omitted rather than truncating JSON or URL strings. Reprojection is deterministic and does not append duplicate evidence.
- Canonical messages, native output metadata, and source request journals are not rewritten by projection. The helper neither fetches URLs nor interprets page content.

## Integration and tests

`src/llm.ts` merges the sources include after `extraFields` and effort normalization, preserving custom includes and reasoning replay. It applies evidence before concrete-model filtering, so a model/protocol switch retains safe source data without opaque native replay.

A Responses WebSocket turn that emits hosted search discards its completed chain: the added evidence is inserted inside that turn's model message, before its local calls, and was never part of the provider's stored chain, which a `previous_response_id` continuation can only extend. It is delivered in the next full request; because evidence no longer changes afterwards, that request keeps the earlier prompt-cache prefix, and exact-prefix reuse can resume after it.

`src/llmProviders/openai.ts` deep-merges search actions. When final output arrays are not positionally aligned, only an unambiguous exact-ID search call may receive source enrichment. Unmatched or ambiguous IDs do not contribute URLs.

Tests cover include precedence with reasoning enabled/disabled, empty/omitted final sources, final-only enrichment, mismatched IDs, search/local-tool/reply handoff, switched-model isolation, immutable history, invalid URL filtering, escaping, per-call bounds, per-call stability under later calls, first-occurrence deduplication, and duplicate prevention. Search items wait for final assembly before immutable early-prefix commit, preventing final-only sources from being lost.
