# Thread: Session ownership and persistence

This is the primary end-to-end contract for Session state. Start with the producer path below, then open the linked units for the operation being changed.

## Normal producer to consumer path

```text
HTTP/WebUI or command ingress
  -> MessageRouter / SessionManager / SessionIngress
  -> exact SessionEntry + SessionSaveLane
  -> PersistentSessionAuthorityStore
  -> Archive SQLite (when canonical history/compaction data is appended)
  -> LinuxAtomicJsonFile (active Session JSON authority)
  -> SessionCatalog.PublishAuthority (Main-owned projection)
  -> SessionRuntime/WebUI queries and restart hydration
```

- **Producers:** `MessageRouter.HandleMessageAsync`, `SessionManager` lifecycle operations, `SessionIngress.EnqueueAsync`, and `WebUIChannel` route handlers create queue items or request an exact owner operation. Session turn/semantic producers do not bypass the owning save/store; Main-owned identity, topology, presentation, and deletion operations may call `SessionCatalog` APIs directly because catalog SQLite is their canonical boundary.
- **Owner:** `SessionRuntime` resolves the exact `SessionOwner`; `SessionEntry` guards mutable state; `SessionSaveLane` serializes all persistence operations. `SessionRegistry`/`SessionTurnRunner` claim one processor and drive model/tool turns.
- **Durable boundary:** `PersistentSessionAuthorityStore` validates a `SessionSnapshot`, writes the active JSON authority, and publishes Main-owned catalog fields. Canonical append and compaction use Archive-first ordering described below. Semantic history/queue/wait/settings remain JSON-owned; catalog identity, topology, presentation, aliases, and runtime summaries are Main-owned authority/projection fields defined by `SessionCatalog`.
- **Consumers:** the next turn reads `SessionEntry` state; cold startup loads the per-Session JSON through `PersistentSessionAuthorityStore.LoadAsync`; WebUI and list/architecture routes read `SessionCatalog` identity/topology/presentation projections and bounded queries; Archive readers consume immutable raw messages/blocks and lineage without reconstructing active history.

## Active JSON authority

[Session authority JSON](../units/session-authority-json.md) owns the current active `history` array and queue, message counters, wait declaration, busy/stopping state, model/settings fields, memory snapshot, persisted child-handoff boundary, and other validated semantic state. Legacy Goal values are read-compatible migration inputs; production Goal writers/reminders are retired and a valid legacy Goal is migrated during the owning strict save path. `SessionAuthorityDocument` rejects unsupported worker/frontier/catalog-only shapes instead of silently accepting them. `PersistentSessionAuthorityStore.ToAuthority` removes catalog-only fields and rebuilds the persisted `history`/queue from the snapshot before validation.

If the authority file is missing while Archive rows exist, `PersistentSessionAuthorityStore.LoadAsync` throws an integrity error: Archive is not a substitute source for active Session history. If no authority and no Archive rows exist, the store returns `null`; the caller then decides whether this is a permitted new lifetime. `SessionManager.Admission` rejects an already catalog-registered/member lifetime with `Cataloged Session authority is missing` and preserves existing identity reservations rather than creating an empty Session.

## Ordered save lane

[Save-lane core](../units/session-save-lane-core.md) appends every operation to one tail. A failed best-effort operation is swallowed and recorded; it does not poison later strict work. Identity mutations, display/settings changes, memory snapshots, canonical history append, compaction, queue admission, wait transitions, fork/clear, and retry notices enter this lane or an operation that is explicitly nested in it. A retired lane rejects new work after draining its predecessor.

The turn path claims `SessionEntry.TryClaimProcessor`, marks busy, prepares canonical messages, and calls `CommitCanonicalAppendAsync`. Queue admission uses `SessionSaveLane.AdmitAsync`; ordinary input uses the best-effort path that updates hot queue state before attempting persistence, so an accepted HTTP admission is not a durable-completion receipt. Strict inter-Session/wait events use the strict admission path and publish after the store result; `AdmitTimerAsync` is explicitly timer-marked `SaveKind.BestEffort` and follows the hot-first path. Passive queue entries remain durable candidates but do not trigger a processor.

Stop/dequeue has an intentional immediate path: `SessionControl.StopAsync` reaches `SessionEntry.BeginStop`, records stopping state, and cancels the current CTS before the save tail completes. Later finalization persists the result and must not let an older snapshot overwrite the stop/queue outcome. Dequeue and safe-point finalization still use the owner/save-lane ordering; stop is not reduced to an in-memory-only flag or falsely described as waiting for persistence before taking effect.

## Canonical append ordering and errors

1. `SessionSaveLane.CommitCanonicalAppendAsync` prepares the next history snapshot and the exact appended message rows while holding the lane order.
2. `PersistentSessionAuthorityStore.CommitCanonicalAppendAsync` validates the bound snapshot, calls `SqliteArchiveMessageStore.WriteMessages`, and retains the exact list of rows newly inserted by this operation.
3. It writes the active JSON authority with `LinuxAtomicJsonFile.Write`.
4. A failure before rename rolls back only those newly inserted Archive rows. An exact replay row is not deleted, and a conflicting immutable row fails closed.
5. A failure after rename is `AuthorityCommittedException`: the JSON authority is committed, hot state is published, and callers must treat the operation as committed even if directory sync or catalog projection failed.
6. A catalog projection failure is also reported after JSON commit. The owner keeps the newer semantic snapshot and the catalog remains an older projection until a later strict save republishes it.

Canonical append also applies consumed queue-item child-handoff transitions to the staged authority snapshot; passive/unconsumed queue items do not change that boundary. Trusted send/task receipts resolve the boundary through a strict SaveLane operation after tool execution and before the tool-result history row is appended; a later boundary-publication failure is recorded without converting the already durable task/send result into `tool_error`, and a later tool-row failure does not undo the committed effect. The representative evidence is `PersistentSessionTurnTests.AuthorityFailurePublishesOnlyPostRenameCommit`, `ArchiveConflictDoesNotPublishOrDeletePreexistingRow`, `ExactArchiveReplayIsNotDeletedWhenAuthorityPrecommitFails`, and `PersistencePrimitiveTests.AtomicWriter*`.

## Compaction, fork, and clear

[Compaction and Archive](../units/session-compaction.md) prepares a staged snapshot plus block/message rows. `SessionSaveLane.CommitCompactionAsync` delegates to `PersistentSessionAuthorityStore.CommitCompactionAsync`, which writes immutable Archive rows first, writes active JSON second, and rolls back only newly inserted rows on a pre-rename failure. The operation may replace or prune the active JSON history used for the next prompt; that does not delete or rewrite immutable Archive rows. Archive lineage readers apply branch caps to inherited rows and never copy parent rows into a child.

Fork and clear are lifecycle operations in the save lane (`SessionSaveLane.CaptureForkAsync` and `ClearHistoryAsync`) and manager (`SessionManager.ForkAsync`/`ClearAsync`). They coordinate captured queue/history, Archive branch metadata, and the new/current active JSON lifetime. A failed child creation or clear reports the committed side explicitly; it must not invent success from a partially written projection.

## Catalog projection and indexed reads

[Catalog schema/migration](../units/session-catalog-schema.md), [catalog projection](../units/session-catalog-projection.md), and [catalog mutations](../units/session-catalog-mutations.md) split the Main-owned SQLite boundary by behavior. `SessionCatalog.PublishAuthority` overlays Main-owned identity/topology/presentation/runtime-summary fields and rejects a missing membership unless insertion was explicitly allowed. `SessionCatalog.Page`, `Children`, `ChildCounts`, `Scopes`, `Resolve`, and bounded exact-ID methods serve list/architecture/presentation queries with maintained counts and cursor/index limits.

The catalog is not a projection of every Session field: active semantic history, queue, wait, and model state belong to per-Session JSON, while the catalog stores identity/topology/presentation and bounded runtime summaries. Catalog-only channel metadata may be overlaid while remaining absent from active JSON. A projection can therefore be newer or older than JSON during a committed-but-not-published window; query callers must preserve that distinction rather than rebuilding semantic state from the projection.

## Startup, busy recovery, and identity moves

`SessionManager.LoadMainHostAsync` initializes Archive identity evidence and the catalog before loading owners. During admission, `SessionManager.Admission` checks the loaded snapshot: `RecoverBusySnapshot` clears `Busy`, `BusyStartedAt`, and `Stopping`, appends one deduplicated restart-resume event, and calls `SaveStrictAsync` before `PublishOwner`. A stopping-only snapshot is rejected instead of being treated as ordinary recovery. The store-level `LoadAsync` result and manager-level admission are distinct: if an already registered catalog member has no authority JSON, manager admission throws `Cataloged Session authority is missing`; it does not create an empty lifetime or rebuild from Archive. Existing identity reservations remain authoritative.

Identity move and Archive reservation code use [Archive identity](../units/archive-identity-and-moves.md) and [lifecycle save operations](../units/session-save-lane-lifecycle.md). Committed mappings are mirrored between `session-id-reservations.jsonl` and SQLite; conflicts, cycles, unsupported pending recovery evidence, or ownership ambiguity fail startup without repairing either authority opportunistically.

## Representative tests

- `dotnet/Foxwarm.Tests/Sessions/PersistentSessionTurnTests.cs`
- `dotnet/Foxwarm.Tests/Sessions/SessionCatalogPublicationTests.cs`
- `dotnet/Foxwarm.Tests/Sessions/SessionCatalogSourceTests.cs`
- `dotnet/Foxwarm.Tests/Sessions/SessionIdentityRecoveryTests.cs`
- `dotnet/Foxwarm.Tests/Sessions/SessionIdentityMoveTests.cs`
- `dotnet/Foxwarm.Tests/Storage/PersistencePrimitiveTests.cs`
- `dotnet/Foxwarm.Tests/Storage/ArchiveLineageTests.cs`
- `dotnet/Foxwarm.Tests/Sessions/CommittedArchiveBoundaryTests.cs`

## Current boundary

The .NET source contains Main-local task service APIs, attached-child binding, persisted child-handoff boundary state, valid legacy Goal migration on strict saves, request-local task context, and compaction progress checkpoint calls. Request context is model-request-only and does not append history or wake a Session. Existing `OpenAIRequestText` child-reminder compatibility handling is separate from the persisted boundary state.
