# Unit: Session catalog projections and indexed queries

Files: `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Projection.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Queries.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Sidebar.cs`

## Purpose

Projects validated Session snapshots into bounded Main-owned list/architecture/presentation rows and serves exact, cursor, child, scope, count, and alias queries without hydrating Session authority.

## Stable methods and callers

- `Page` provides bounded keyset pages by time/default/architecture order, including root/agent filters and `hasMore`.
- `Children`, `ChildCounts`, and `Scopes` serve bounded architecture/tree requests and reject oversized batches or invalid agent-forest modes. Without an agent filter they follow the Sidebar presentation parent; the agent forest keeps real parents.
- `SessionCatalog.Sidebar.cs` maintains `sidebar_parent` and serves `SidebarGroups`/`SidebarPaths`; the contract is [D-sidebar-agent-grouping](../threads/main-catalog-storage-and-indexed-queries.md#d-sidebar-agent-grouping).
- `Get`, `GetMany`, `List`, `Resolve`, `Presentation`, and `PathIds` implement exact identity/alias and presentation navigation; `Resolve` preserves missing versus ambiguous aliases.
- `RestartIds` selects indexed busy, queue and managed-pending work only; a declared wait alone does not admit its history.
- `RecentWaitIds` returns wait-bearing IDs through an indexed recency cutoff for startup liveness observation. It does not replace the complete startup binding-validation read or restrict unrelated recovery. Activity eligibility and authoritative rechecks are owned by [wait liveness](./session-domain.md#wait-liveness-observation-and-admission).
- Projection helpers overlay runtime `busy`, queue, managed-pending, and Main presentation fields into query rows while leaving authority files untouched.

Callers: `SessionListQueries`, `WebUIChannel` session/list/architecture routes, `MessageRouter` presentation commands, and `SessionManager` catalog publication. These paths are catalog-only; exact semantic mutations use the owner/save lane.

## Contract and side effects

The bounded metadata projection includes the optional boolean `llmFailed` fact for cold presentation; it adds no query index, restart selection or hot-owner requirement.

For [Claude Code Sessions](./session-claude-runtime.md), the projection also retains bounded runtime/status/model/usage and Continue capability, excluding the Main-local cwd/transcript checkpoint paths. The latest-user/input frontiers provide Continue capability without scanning history in metadata callbacks.

Queries are read-only SQL operations with maintained count/index boundaries. `PublishAuthority` is the publication edge: it overlays current Main-owned fields, rejects stale catalog membership unless insertion is explicitly allowed, writes one projection transaction, and raises its change event afterward. A newer JSON authority can coexist with an older projection until a later publication succeeds.

Ordinary `Get` and `Resolve` calls no longer acquire the writer monitor after initialization: each owns a short-lived pooled read-only connection and one SQLite statement snapshot. `Resolve` selects exact precedence and up to two alias owners in the same statement. They may observe the last committed state while a writer is in progress, and subsequent calls see its commit. Reentrant calls while the catalog monitor is already held, including mutation-admission callbacks, use the writer connection and its current transaction. Other query methods retain their existing monitor ownership, including multi-statement rows/counts, presentation/parent navigation, and activity summaries; no row or revision cache is added.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionCatalogTests.cs`; `SessionCatalogPublicationTests.cs`; `SessionCatalogSourceTests.cs`; `SessionIdentityBoundaryTests.cs`.
`SessionSidebarGroupingTests.cs` covers grouping, threshold/main/pin/parent membership changes, cycle-safe hosts, adding missing Sidebar objects without a version change, reopen repair after writes by a Main without Sidebar support, real-only lifecycle descendants and the user-child opening notice.
`SessionCatalogConcurrencyTests.cs` covers held-writer exact/resolution reads, retained children rows/count exclusion, concurrent first reads, identity/parent transitions, and disposal/reopen.
