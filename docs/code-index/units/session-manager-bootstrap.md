# Unit: Session manager bootstrap, admission, and catalog publication

Files: `dotnet/Foxwarm/Sessions/SessionManager.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Bootstrap.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Admission.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Catalog.cs`

## Purpose

Builds the Main Session manager, initializes identity/catalog/archive services, admits exact Session lifetimes, and publishes owners only after authority recovery succeeds.

## Stable methods and callers

`LoadMainHostAsync` validates startup evidence, runs the shared fixed [SQLite-only Archive migration](./archive-message-store.md#legacy-migration-and-jsonl-export), without bootstrapping no-source catalog branches or presentation aliases ahead of their directional identity owner, then performs identity/catalog initialization and owner loading before Vector starts. Physical legacy files retain exact catalog parent metadata if an earlier accepted cold load already retired Source metadata without importing Archive branches. Admission resolves identity, calls `PersistentSessionAuthorityStore.LoadAsync`, distinguishes null store result from cataloged missing-authority, applies `RecoverBusySnapshot`, strict-saves recovery, then publishes the owner. Catalog helpers expose Main identity/topology/presentation query/publication callbacks; presentation changes keep live parent fields aligned with the Main catalog before owner state notifications.

Normal Main startup reports bounded outcomes from its existing Vector mode/readiness, already loaded catalog rows, required/admitted Session owners and exec registry count. It does not load additional histories, scan retained exec directories or claim that Vector readiness means historical backfill completion. Non-Main `LoadAsync` does not add these normal-start summaries.

## Contract and side effects

The constructed manager pins independent journal and Archive data-root writers without opening their connections before startup evidence validation. `BeginShutdown` closes manager/runner admission synchronously and fences future timers/wait producers without tearing down effects dependencies. `ShutdownAsync` also invokes this boundary, drains accepted exact turn owners, finishes accepted publications and foreground wrappers, then cancels/drains independent planners before ToolScript/executor/MCP/Node/WebSocket teardown and final ordered saves. A creation already accepted at closure can publish only a fenced runner. [Accepted script timer slices](./tasks-timers.md#owner-bound-toolscript-timers) also drain before service teardown, including narrow cold-owner admission/publication with a fenced runner; this does not reopen general admission or borrow a model turn. Journal and Archive leases remain pinned through accepted saves and are released by disposal after successful shutdown. A failed foreground drain does not run dependency disposal; the shared host owns forced termination. See [Main-local lifecycle shutdown](../threads/session-lifecycle.md#d-lifecycle-main-local-shutdown).

Stale busy recovery clears busy fields and stopping, adds one deduplicated resume event, saves strictly, and only then publishes. Stopping-only admission rejects. The catalog cannot reconstruct semantic JSON history or authorize a missing registered lifetime.

Admitted owners publish bounded local list projections on owner state/message events. Agent binding clear also recaptures affected admitted owners before topology invalidation, because effective placement can change without a Session authority mutation. It does not admit cold catalog members or rewrite retained selection/cwd.

`CaptureLocalProjection` carries the common transient runtime only while the owner has active/waiting/queued/compaction work. Independent background compaction therefore remains visible even with idle foreground state. Visible-signature comparison and ordinary overlay removal retain their bounded lifetime; idle runtime objects are not retained merely to differ from catalog rows. Catalog-only fallback never hydrates all Session histories. Agent removal uses that complete catalog rather than `Owners()`; its bounded membership-changing admission is described in [lifecycle and identity](./session-manager-lifecycle-identity.md#agent-deletion-callers).

## Tests

`SessionAdmissionTests.cs`; `SessionIdentityRecoveryTests.cs`; `SessionCatalogPublicationTests.cs`; startup/bootstrap tests; `SessionShutdownTests.cs`; `dotnet/scripts/qualify-shutdown-recovery.mjs`.
