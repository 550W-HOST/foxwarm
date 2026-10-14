# Unit: WebUI history, Session list, and bounded replay routes

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.History.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.List.cs`

## Purpose

Serves bounded Session history/replay, list/search/pagination, architecture/tree, and current-history status routes from the correct JSON/catalog/Archive boundaries.

## Stable methods and callers

History routes use `SessionRuntime`/Archive context readers for exact owner/history operations and return explicit `VECTOR_DISABLED` for unsupported Vector-backed history. List routes call `SessionListQueries`/`SessionCatalog.Page`, `Children`, `Scopes`, and bounded replay helpers; they do not hydrate cold catalog members or rebuild active history from Archive.

## Contract and side effects

Semantic history/queue/wait comes from active Session authority; identity/topology/presentation/list summaries come from Main catalog; immutable Archive is read-only context/audit. The Debug file route resolves encoded Session IDs through the same raw-target/catalog helper as other Session routes, so ordinary Agent-qualified IDs and aliases locate the real authority file. Pagination/cursor/agent-scope limits are validated before SQL/read work. A missing authority for an already cataloged Session remains an admission integrity error, not an empty replay.

## Tests

`SessionTurnTests.cs`; `SessionCatalogTests.cs`; `SessionCatalogPublicationTests.cs`; `SessionCatalogSourceTests.cs`; bounded replay/list route tests.
