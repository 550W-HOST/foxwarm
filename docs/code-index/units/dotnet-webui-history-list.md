# Unit: WebUI history, Session list, and bounded replay routes

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.History.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiContinuousHistory.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.List.cs`

## Purpose

Serves bounded Session history/replay, list/search/pagination, architecture/tree, and current-history status routes from the correct JSON/catalog/Archive boundaries.

## Stable methods and callers

History routes use `SessionRuntime`/Archive context readers for exact owner/history operations and return explicit `VECTOR_DISABLED` for unsupported Vector-backed history. List routes call `SessionListQueries`/`SessionCatalog.Page`, `Children`, `Scopes`, and bounded replay helpers; they do not hydrate cold catalog members or rebuild active history from Archive.

## Contract and side effects

Semantic history/queue/wait comes from active Session authority; identity/topology/presentation/list summaries come from Main catalog; immutable Archive is read-only context/audit. The Debug file route resolves encoded Session IDs through the same raw-target/catalog helper as other Session routes, so ordinary Agent-qualified IDs and aliases locate the real authority file. Pagination/cursor/agent-scope limits are validated before SQL/read work. A missing authority for an already cataloged Session remains an admission integrity error, not an empty replay.

`GET /api/sessions/{id}/history/continuous` resolves the live Session/alias, captures the ordinary snapshot's latest sequence, and calls `WebUiContinuousHistory.Read` on the existing effective Archive reader. Initial/latest and exclusive `beforeSeq` pages read descending; exclusive `afterSeq` reads ascending. Pages contain at most 100 original messages in ascending order, with canonical sequence/timestamp, optional first/last sequence, and direction-relative `hasMore`. One bounded one-record probe determines continuation without counting or materializing the whole Archive. Cumulative fork caps and Archive identity resolution remain storage-owned. Duplicate/unknown/invalid query values and mixed directions fail before paging. After normal image materialization the route rechecks the live catalog binding. It never updates active history, realtime frontiers, Vector state, or a persisted watermark. Canonical consumer semantics: [continuous Chat history](../threads/archive-and-recall.md#d-webui-continuous-chat-history).

All message-bearing routes use [WebUI message transport](./webui-message-transport.md), including both CTX expansion copies, exact Archive `messageJson`, Debug history/queue, continuous pages and Vector search source messages. Projection does not alter the Archive or saved Session file. Debug additionally reuses `WebUiContract.SanitizeQueuedPreviewParts` for known `queue[].parts`, bounding their top-level text/system/thinking and omitting inline attachments. Prebuilt `queue[].message` retains the ordinary message projection; arbitrary nested tool/user data is not treated as queue text.

History search source messages and exact/earlier/later viewer windows use the [History-specific hosted display projection](./webui-message-transport.md#history-hosted-display-projection). Ordinary Chat, continuous history, exact Archive reads and Debug retain hosted replay metadata after the ordinary WebUI projection.

Metadata search normalizes queries and candidate fields through the [Unicode lowercase owner](./session-domain.md#metadata-search-lowercasing), retaining substring matching and original metadata.

## Tests

`SessionTurnTests.cs`; `SessionCatalogTests.cs`; `SessionCatalogPublicationTests.cs`; `SessionCatalogSourceTests.cs`; bounded replay/list route tests; `WebUiAdjacentProjectionTests` (owned HTTP queue/Debug and converter-to-Archive viewer display/preservation paths), `WebUiMessageTransportVectorTests` (real local Vector History search display projection). `WebUiContinuousHistoryTests` covers reopened cumulative fork pages, exact snapshot bounds, live aliases, image transport and invalid queries; `dotnet/Foxwarm.Tests/Fixtures/continuous-history-fixture-ts.mjs` seeds original rows through Source persistence APIs for `packages/webui/test/mainHostContinuousDownloads.e2e.mjs`, which qualifies real compaction, earlier/newer/reconnect/restored-window reads and an archived image in the built original App.
