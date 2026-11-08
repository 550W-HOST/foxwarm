# Unit: Session catalog projections and indexed queries

Files: `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Projection.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Queries.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Groups.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Activity.cs`, dotnet/Foxwarm.Tests/Sessions/SessionCatalogActivityTests.cs, dotnet/Foxwarm.Tests/Sessions/SessionListActivityTests.cs, dotnet/Foxwarm.Tests/Channels/WebUiStartupTests.SidebarChildWindow.cs

## Purpose

Projects validated Session snapshots into bounded Main-owned list/architecture/presentation rows and serves exact, cursor, child, scope, count, and alias queries without hydrating Session authority.

## Stable methods and callers

- `Page` provides bounded keyset pages by time/default/architecture order, including root/agent filters and `hasMore`.
- `Children`, `ChildCounts`, and `Scopes` serve bounded architecture/tree requests and reject oversized batches or invalid agent-forest modes. They use real parents.
- `SessionCatalog.Groups.cs` serves Sidebar Agent/Node groups: `GroupCounts`, `GroupPage` (keyset member pages, optionally excluding an Agent main placed separately) and `GroupKeys`; `Page(pinnedOnly)` serves the pinned section of a grouped Sidebar. On open it adds the grouping indexes and maintained `catalog_node_count`, and drops the retired `catalog_sidebar_*` objects; the contract is [D-sidebar-groups](../threads/main-catalog-storage-and-indexed-queries.md#d-sidebar-groups).
- `SessionCatalog.Activity.cs` owns the maintained `subtree_time` column (newest own `last_message_time` among a row and its real descendants), its generated `subtree_rank`, the trigger-based maintenance, the one-time backfill and the activity indexes. Tree-mode Sidebar `Page`, `Children` and `GroupPage` order and key by `subtree_rank`; `SubtreeTimes` and `RecentChildCounts` serve the presentation field and the recent-activity child window. The contract is [D-sidebar-tree-activity](../threads/main-catalog-storage-and-indexed-queries.md#d-sidebar-tree-activity).
- `Get`, `GetMany`, `List`, `Resolve`, `Presentation`, and `PathIds` implement exact identity/alias and presentation navigation; `Resolve` preserves missing versus ambiguous aliases.
- `RestartIds` selects indexed busy, queue and managed-pending work only; a declared wait alone does not admit its history.
- `RecentWaitIds` returns wait-bearing IDs through an indexed recency cutoff for startup liveness observation. It does not replace the complete startup binding-validation read or restrict unrelated recovery. Activity eligibility and authoritative rechecks are owned by [wait liveness](./session-domain.md#wait-liveness-observation-and-admission).
- `QuestionRows` returns Sessions whose projection has open `ask_user` questions through the additive partial index `idx_session_catalog_question_presence`, ordered by recency. The metadata projection carries `questions: { open, revision, waiting? }` and the row signature includes it; see [structured user questions](./session-questions.md).
- Projection helpers overlay runtime `busy`, queue, managed-pending, and Main presentation fields into query rows while leaving authority files untouched.

Callers: `SessionListQueries`, `WebUIChannel` session/list/architecture routes, `MessageRouter` presentation commands, and `SessionManager` catalog publication. These paths are catalog-only; exact semantic mutations use the owner/save lane.

## Contract and side effects

The bounded metadata projection includes the optional boolean `llmFailed` fact for cold presentation; it adds no query index, restart selection or hot-owner requirement.

For [Claude Code Sessions](./session-claude-runtime.md), the projection also retains bounded runtime/status/model/usage and Continue capability, excluding the Main-local cwd/transcript checkpoint paths. The latest-user/input frontiers provide Continue capability without scanning history in metadata callbacks.

Queries are read-only SQL operations with maintained count/index boundaries. `PublishAuthority` is the publication edge: it overlays current Main-owned fields, rejects stale catalog membership unless insertion is explicitly allowed, writes one projection transaction, and raises its change event afterward. A newer JSON authority can coexist with an older projection until a later publication succeeds.

Ordinary `Get` and `Resolve` calls no longer acquire the writer monitor after initialization: each owns a short-lived pooled read-only connection and one SQLite statement snapshot. `Resolve` selects exact precedence and up to two alias owners in the same statement. They may observe the last committed state while a writer is in progress, and subsequent calls see its commit. Reentrant calls while the catalog monitor is already held, including mutation-admission callbacks, use the writer connection and its current transaction. Other query methods retain their existing monitor ownership, including multi-statement rows/counts, presentation/parent navigation, and activity summaries; no row or revision cache is added.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionCatalogTests.cs`; `SessionCatalogPublicationTests.cs`; `SessionCatalogSourceTests.cs`; `SessionIdentityBoundaryTests.cs`. `SessionCatalogSourceTests` compares every query with the Source oracle (Node 24.21.0 / Unicode 17 required); its schema comparison excludes only the additive grouping and subtree-activity objects and the question-presence index; its data keeps every Session at least as new as its descendants, because the oracle orders by each row's own time.
`SessionCatalogActivityTests.cs` covers maintained subtree times through deep chains, publication, reparent/promote, deletion, parents published late or by alias, a randomized comparison with a full recomputation, direct writers that ignore the column, upgrade/backfill of an existing catalog and its idempotent reopen, query plans and per-parent child limits. `SessionListActivityTests.cs` covers tree-mode ordering and keyset continuation for roots, children and group pages (Flat unchanged, displayed time unchanged) and the initial child window (0/1/3/7 recent children give 1/1/3/5); `WebUiStartupTests.SidebarChildWindow.cs` covers the HTTP routes.
`SessionSidebarGroupsTests.cs` covers group counts and pages by own Agent/Node (tree and Flat), saved order and keyset continuation, the pinned-only page, maintained Node counts against a full recount through topology changes, trigger-only writers and re-creation, and retiring the earlier Sidebar objects without a version change. `WebUiStartupTests.SidebarGroups.cs` covers the grouped HTTP routes.
`SessionCatalogConcurrencyTests.cs` covers held-writer exact/resolution reads, retained children rows/count exclusion, concurrent first reads, identity/parent transitions, and disposal/reopen.
