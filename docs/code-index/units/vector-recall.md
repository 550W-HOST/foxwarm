# Unit: Vector search, Archive source selection and previews

Files: `dotnet/Foxwarm/Vector/VectorSearch.cs`, `dotnet/Foxwarm/Vector/VectorRecall.cs`, `dotnet/Foxwarm/Vector/VectorRawWindow.cs`, `dotnet/Foxwarm/Vector/ArchiveLexicalRecall.cs`, `dotnet/Foxwarm/Sessions/SessionManager.VectorHistory.cs`

## Purpose

Turns derived dense/lexical candidates into scoped source families, then reloads authoritative Archive context for model recall and administrator History. Stored dense text is only a compatibility fallback, not the preferred source of truth.

## Search and caller contract

`VectorRuntime.SearchAsync` applies escaped Agent/Session/cumulative-lineage predicates, clips crossing raw ranges from Archive, rejects crossing legacy fact spans, filters patterns, adapts candidate count up to 1024, and groups deterministic raw/block/fact sources. Ranking retains semantic distance buckets, block/fact/recency preference, matched fact metadata and overlap diversity. Hybrid fusion uses identifier/prose lane weights and shared-source boosts rather than vector-distance substitution.

`ArchiveRecallTool.ExecuteAsync` selects nonempty `vector_query` before exact-target parsing or owner admission. It uses existing current-Session/current-Agent model scope and the Source-compatible model-facing definition. Semantic disabled/unavailable errors retain their Vector code in the model tool response; `VECTOR_UNAVAILABLE` is retryable, while explicit `VECTOR_DISABLED` is not. Exact overview/block/message selectors retain their existing behavior. `limit` counts unique sources after selected-context filtering; preview text, headers, notices and drill-down advice share the existing bounded renderer budget.

`VectorRecall.SearchAsync` reloads raw ranges and blocks from immutable Archive. Modern facts resolve their block, never silently widen into raw text when that block is absent. Raw selection respects tool-call/response atomicity, meaningful/fallback anchors, normal seven-message windows, a hard sixteen-message cap and positive-filter omission notices attached to their source item. Only groups surviving final filters and the requested result limit contribute those notices; query-level notices remain separate. The renderer collects priority notices before warnings/filter/selection notices and the title, following the Source limits. Administrator source reload scans bounded pages with bounded neighbors; it does not transfer a whole raw source range merely to choose a display window.

`SearchVectorHistoryAsync` serves the real authenticated administrator `/api/history/search` route with source ranges, bounded messages/blocks, earlier/later metadata and image externalization. Omitted or empty Session filters select global or Agent scope and reload each hit from its own Archive identity. Only a nonempty exact Session filter supplies a resolved read identity, preserving canonical aliases and captured fork lineage/caps. Scoped WebUI identities remain forbidden from that global endpoint. Disabled/unavailable Vector is 503; actual search failures are not an empty-success response.

## Canonical scope after alias resolution

Current-Agent model semantic search rechecks each resolved canonical source against the same target boundary as explicit semantic targeting, before Archive text or old stored-text fallback can return. Historical Agent/Session metadata in a dense or lexical row does not grant access after cross-Agent move. The existing durable canonical Session identity determines Agent scope even after deletion removes the active catalog row: never-moved retained history remains searchable, and moved-then-deleted history does not regain its original Agent scope. Captured allowed fork lineage and cumulative caps remain valid; exact Archive lookup and administrator global scope retain their existing authority.

This deliberately closes a reproduced pre-move-content exposure in the reference implementation. It does not migrate dense rows or promise destination-Agent dense retrieval of old content. The Source limitation and the narrow scope correction are separate responsibilities.

## Fallback and failure limits

When exact current-Session persistent lexical search is unconfigured/unready/backfilling or query failed, `ArchiveLexicalRecall` can supplement identifier search from bounded Archive reads. Limits are 16 lineage entries, 2000 substantive visible messages and 1000 blocks per branch, 64 branch candidates and 256 total candidates. Role/visibility filters apply before the message limit; late parent messages/blocks remain clipped by captured caps. Literal ranking/deduplication preserves Source behavior without scanning arbitrary Sessions.

If authoritative source is absent, legacy stored text can supply a bounded compatibility preview only after the same caller scope boundary. Warnings contain bounded source metadata and reason, never query or text. Logging failure does not break recall. Exact missing targets still do not create owners, databases, branch reservations or active history from Archive.

## Tests

`VectorRecipeTests`, `VectorSearchQualityTests`, `VectorTransientRecallTests`, `VectorFallbackTests`, and `VectorMainCallerTests`. `VectorHistoryHttpScopeTests` exercises authenticated global/Agent requests with omitted and empty Session filters against real indexed hits, with canonical alias and captured-lineage controls. The executable TypeScript route comparison is `src/channels/webuiHistorySearch.test.ts`. Frozen Source fixtures cover recipes/Unicode/query compilation/raw windows, distance/fact/source grouping and fusion, actual transient reads and legacy persisted rows. The supported move comparison records the reference pre-move-content discrepancy; C# tests assert rejection plus same-Agent, captured-lineage, exact and administrator controls in both placements.
