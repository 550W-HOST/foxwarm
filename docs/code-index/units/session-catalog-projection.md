# Unit: Session catalog projections and indexed queries

Files: `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Projection.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Queries.cs`

## Purpose

Projects validated Session snapshots into bounded Main-owned list/architecture/presentation rows and serves exact, cursor, child, scope, count, and alias queries without hydrating Session authority.

## Stable methods and callers

- `Page` provides bounded keyset pages by time/default/architecture order, including root/agent filters and `hasMore`.
- `Children`, `ChildCounts`, and `Scopes` serve bounded architecture/tree requests and reject oversized batches or invalid agent-forest modes.
- `Get`, `GetMany`, `List`, `Resolve`, `Presentation`, and `PathIds` implement exact identity/alias and presentation navigation; `Resolve` preserves missing versus ambiguous aliases.
- `RestartIds` selects indexed busy, queue and managed-pending work only; a declared wait alone does not admit its history.
- Projection helpers overlay runtime `busy`, queue, managed-pending, and Main presentation fields into query rows while leaving authority files untouched.

Callers: `SessionListQueries`, `WebUIChannel` session/list/architecture routes, `MessageRouter` presentation commands, and `SessionManager` catalog publication. These paths are catalog-only; exact semantic mutations use the owner/save lane.

## Contract and side effects

Queries are read-only SQL operations with maintained count/index boundaries. `PublishAuthority` is the publication edge: it overlays current Main-owned fields, rejects stale catalog membership unless insertion is explicitly allowed, writes one projection transaction, and raises its change event afterward. A newer JSON authority can coexist with an older projection until a later publication succeeds.

Ordinary `Get` and `Resolve` calls no longer acquire the writer monitor after initialization: each owns a short-lived pooled read-only connection and one SQLite statement snapshot. `Resolve` selects exact precedence and up to two alias owners in the same statement. They may observe the last committed state while a writer is in progress, and subsequent calls see its commit. Reentrant calls while the catalog monitor is already held, including mutation-admission callbacks, use the writer connection and its current transaction. Other query methods retain their existing monitor ownership, including multi-statement rows/counts, presentation/parent navigation, and activity summaries; no row or revision cache is added.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionCatalogTests.cs`; `SessionCatalogPublicationTests.cs`; `SessionCatalogSourceTests.cs`; `SessionIdentityBoundaryTests.cs`.
`SessionCatalogConcurrencyTests.cs` covers held-writer exact/resolution reads, retained children rows/count exclusion, concurrent first reads, identity/parent transitions, and disposal/reopen.
