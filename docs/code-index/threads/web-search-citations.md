# Thread: Hosted web-search sources and citations

## D-hosted-search-citation-integrity

[2026-10-30] Preserve the distinction between search evidence and a precise citation. A provider's consulted-source list, an explicitly opened page, and a text annotation do not establish the same relationship. Never infer an internal reference-to-URL mapping from list position, a matching number, another request, or a similarly titled page.

The complete path is Responses request → stream assembly → canonical provider metadata → subsequent request projection → assistant Markdown and hosted-search presentation. Inline reference tokens are meaningful only in assistant prose; authored code, user/tool text and stored raw messages remain literal.

## Request and persistence

When hosted search is enabled, request `web_search_call.action.sources` in addition to any existing required or configured includes. Preserve actual source metadata through stream/final merging and canonical history. Do not introduce a Session-global reference-number registry: internal provider reference IDs can be reused across requests.

For a subsequent model request, project explicitly untrusted source records from the actual hosted output items into readable context without rewriting canonical messages. This makes returned URLs available across local tool calls; native provider replay remains scoped to its concrete model. Source records are evidence, not instructions and not a reconstructed numbered citation map.

### D-hosted-search-evidence-prefix-stability

[2026-11-10] **User decision; serves the governing goal [D-request-prefix-stability](../overview.md#d-request-prefix-stability).** Hosted web search is the model's own provider-hosted behavior and may run as often as the model chooses. Projected evidence therefore has no request-wide byte, source or call budget and no preference for recent calls. Each call's evidence text depends only on that call's stored output item, so a model message carries the same evidence in every later request and a new search never changes bytes already sent.

- Per-record safety rules stay: credential-free HTTP(S) URLs only, individual URL/title length limits, JSON escaping, and whole records omitted rather than truncated.
- A fixed per-call bound (64 sources, 16 KiB of serialized call data) contains a pathological single call; it depends only on that call.
- Request-scoped deduplication keeps the first occurrence of a call (same request identity and same evidence), so it depends only on earlier messages. A later call that repeats an older URL gets its own evidence; the older message is unchanged.
- Total evidence grows with the number of searches, like the rest of history; compaction, not a request-time budget, bounds older context.

The former 16 KiB / 64-source / eight-call request budget trimmed or removed evidence on older messages whenever a new search arrived. That rewrote already-sent history and broke the provider prompt-cache prefix for most requests after repeated searches.

## Presentation

Precise safe URL annotations belong to their own text part. Resolve a bare internal reference only when its text span is unambiguously matched by such annotations. Unknown references keep inspectable IDs rather than being silently removed or converted into a guessed link. Streamed partial syntax must not flash private-use glyphs. Search-source lists remain separately labeled from sentence citations. Existing normal Markdown links and deduplicated Sources lists continue to work.

The Raw view and stored history are not rewritten. A historical response without a saved mapping cannot acquire an accurate link solely from its internal reference number.

## Source entry points

- [C# Responses request, streaming and replay](../units/model-responses.md)
- [C# concrete request history](../units/model-common-wire.md)
- [LLM routing and normalization](../units/src-llm.md)
- [Responses conversion and streaming](../units/src-llm-openai.md)
- [Shared Markdown rendering](../units/webui-chat-shared.md)
- [Chat timeline](../units/webui-chat-timeline.md)

## Verification boundary

Cover source retrieval with and without reasoning, sparse final-event enrichment, same-request versus unrelated-reference isolation, tool-call continuation, malformed or unsafe URLs, exact annotation offsets including Unicode, multiple references, literal code, streamed markers, and reload of persisted messages. Live provider checks use synthetic prompts rather than replaying private Session history. A provider may omit metadata despite the include request; that must not produce fabricated citations or repeated automatic repair calls.
