# Unit: Vector owner placement and Main integration

Files: `dotnet/Foxwarm/Vector/VectorService.cs`, `dotnet/Foxwarm/Vector/VectorWire.cs`, `dotnet/Foxwarm/Vector/VectorChild.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Vector.cs`

## Purpose

Provides the single enabled Vector owner and the small Main-facing facade used by committed Archive hooks, recall, history search and lifecycle. It is not Session Worker placement, a generic RPC registry, a Node provider or a second Main server.

## Placement and lifecycle

`VectorService` captures normalized configuration. Disabled operations stay lazy and create no vector/native/lexical owner. With `dbWorkers:false`, one local `VectorRuntime` owns native state. With the default `dbWorkers:true`, one supervised child owns that same runtime and communicates over a private current-user named pipe. Request capacity is 256 in either mode. Failure is bounded `VECTOR_UNAVAILABLE`, never a second in-process native owner or placement fallback.

Main completes authoritative identity/migration work before starting the owner. Child readiness is independent of `WaitForStartupAsync`. Exits reject pending requests for that connection generation; stale connection completion cannot fail a replacement's calls. Restart uses 250 ms to 5 s backoff, and no replacement starts before the previous child confirms exit. Shutdown stops restart/admission, drains accepted requests, closes transport, then uses the existing bounded wait/TERM/KILL phases. Unconfirmed exit retains ownership and reports an error. Parent disconnect has bounded child cleanup, not durable cross-Main fencing.

Console and optional Desktop dispatch the private child branch before ordinary Main composition. Desktop dispatch precedes WinForms initialization and its single-instance guard; the same Desktop apphost can own its child without depending on a separately shipped console runtimeconfig. The child starts no HTTP listener, UI, Agent lifecycle or Session owner.

## Main caller map

- `SessionManager.LoadOwnersAsync` starts Vector after committed identity recovery; shutdown settles Session work and accepted indexing hooks before disposing Vector.
- `PersistentSessionAuthorityStore` notifies only after active authority publication, including a post-rename durability error. Precommit Archive staging/compensation does not notify. Notification is best effort and cannot change the commit result. Compaction supplies the Archive writer's owned inserted block values, not borrowed mutable proposal objects.
- `OnArchiveCommitted` computes bounded hints and schedules raw/block work, then indexes committed memory facts asynchronously. It does not replace the save lane, Archive writer, journal or projection owner.
- `ForceVectorIndexAsync` captures current authoritative sequence/block hints, awaits its queued target run (not merely an earlier background run), and only on success commits the legacy index-position compatibility fields through the ordinary save lane.
- Fork seeds progress from captured caps; same-owner identity move/recovery invokes rename, with inverse rename on existing rollback. Newly created uncommitted branches reset derived data before exact branch compensation. Clear/deletion retain committed Archive and its derived sources.
- `ResolveVectorScope` preserves isolated-current-Session and nonisolated-current-Agent model scope without hydrating searched owners. `VectorCanonicalSourceAllowed` rechecks resolved source authority before preview/fallback; [recall](./vector-recall.md) owns that contract.

## Tests and limits

`VectorStorageTests` exercises both actual placements, disabled side effects, worker loss with a held request, pending rejection and replacement. `VectorMainCallerTests` invokes ordinary Main append, model tool dispatch, same/cross-Agent move, captured fork, administrator HTTP and `/session index`. `VectorCompactionTests` uses the actual Main planner/commit and verifies drained fact publication after restart.

These fixtures are separate disposable runtimes. They do not establish Windows Desktop runtime qualification, deployment readiness, stronger parent-loss fencing or a Session Worker platform.
