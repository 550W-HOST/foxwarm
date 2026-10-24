# Unit: Vector owner placement and Main integration

Files: `dotnet/Foxwarm/Vector/VectorService.cs`, `dotnet/Foxwarm/Vector/VectorWire.cs`, `dotnet/Foxwarm/Vector/VectorChild.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Vector.cs`

Secondary files: `dotnet/Foxwarm.Tests/Vector/VectorStartupTests.cs`, `dotnet/scripts/qualify-vector-startup.mjs`

## Purpose

Provides the single enabled Vector owner and the small Main-facing facade used by committed Archive hooks, recall, history search and lifecycle. It is not Session Worker placement, a generic RPC registry, a Node provider or a second Main server.

## Placement and lifecycle

`VectorService` captures normalized configuration. Disabled operations stay lazy and create no vector/native/lexical owner. With `dbWorkers:false`, one local `VectorRuntime` owns native state. With the default `dbWorkers:true`, one supervised child owns that same runtime and communicates over a private current-user named pipe. Request capacity is 256 in either mode. Local operation failures pass through the same typed `VECTOR_OPERATION_FAILED` boundary as child replies, so an embedding outage remains a paired tool result and the model can continue. Existing typed disabled/unavailable codes pass through unchanged; local cancellation still propagates to the caller cancellation boundary. This adaptation surrounds only Vector operation dispatch, not foreground model requests or authoritative Session writes. Embedding HTTP error details use the existing 500-character payload clip in both placements, including JSON error bodies. Owner unavailability reports `VECTOR_UNAVAILABLE` without creating a second in-process native owner or falling back to another placement.

Main completes authoritative identity/migration work before starting the owner. `SessionManager.LoadOwnersAsync` catches only the selected Vector start, logs initialization failure and continues with that same unavailable service; authoritative loading stays outside the catch. The [optional startup contract](../threads/process-topology-and-rpc.md#vector-placement) retains placement/configuration, distinguishes retryable unavailability from explicit disabled mode and adds no local retry scheduler.

Required native open and optional lexical open/recovery remain on the initialization path. Initial dense/lexical Archive-maxima enumeration, including shadow catchup, yields out of that path into retained startup tasks in both placements. Promotion becoming ready does not replace an unfinished shadow task. Child readiness keeps its 10-second deadline and does not await `WaitForStartupAsync`; local placement uses the same startup waits without a readiness timeout. Startup waits include enumeration/backfill, and disposal settles those tasks before stores close. Readiness does not mean historical completeness or immediate query responsiveness.

Exits reject pending requests for that connection generation; stale connection completion cannot fail a replacement's calls. Restart uses 250 ms to 5 s backoff, and no replacement starts before the previous child confirms exit. Shutdown stops restart/admission, drains accepted requests, closes transport, then uses the existing bounded wait/TERM/KILL phases. Unconfirmed exit retains ownership and reports an error. Parent disconnect has bounded child cleanup, not durable cross-Main fencing.

Console and optional Desktop dispatch the private child branch before ordinary Main composition. Desktop dispatch precedes WinForms initialization and its single-instance guard; the same Desktop apphost can own its child without depending on a separately shipped console runtimeconfig. The child starts no HTTP listener, UI, Agent lifecycle or Session owner.

## Main caller map

- `SessionManager.LoadOwnersAsync` starts Vector after committed identity recovery; shutdown settles Session work and accepted indexing hooks before disposing Vector.
- `PersistentSessionAuthorityStore` notifies only after active authority publication, including a post-rename durability error. Precommit Archive staging/compensation does not notify. Notification is best effort and cannot change the commit result. Compaction supplies the Archive writer's owned inserted block values, not borrowed mutable proposal objects.
- `OnArchiveCommitted` computes bounded hints and schedules raw/block work, then indexes committed memory facts asynchronously. It does not replace the save lane, Archive writer, journal or projection owner.
- `ForceVectorIndexAsync` captures current authoritative sequence/block hints, awaits its queued target run (not merely an earlier background run), and only on success commits the legacy index-position compatibility fields through the ordinary save lane.
- Fork seeds progress from captured caps; same-owner identity move/recovery invokes rename, with inverse rename on existing rollback. Newly created uncommitted branches reset derived data before exact branch compensation. Clear/deletion retain committed Archive and its derived sources.
- `ResolveVectorScope` preserves isolated-current-Session and nonisolated-current-Agent model scope without hydrating searched owners. `VectorCanonicalSourceAllowed` rechecks resolved source authority before preview/fallback; [recall](./vector-recall.md) owns that contract.

## Tests and limits

`VectorStorageTests` exercises both actual placements, disabled side effects, worker loss with a held request, pending rejection and replacement. `VectorRecallTurnTests` drives ordinary Session ingress and the owner runner with real Responses HTTP/SSE and embedding HTTP peers: both placements pair a query-embedding 503 error, send it in the second model request and commit the final answer; successful recall has the same continuation and Archive pairing controls. Stop during a dispatched query settles its result without another model request or replay. `VectorMainCallerTests` invokes ordinary Main append, model tool dispatch, same/cross-Agent move, captured fork, administrator HTTP and `/session index`. `VectorCompactionTests` uses the actual Main planner/commit and verifies drained fact publication after restart.

`VectorStartupTests` opens a real table, truncates its latest manifest, then checks unavailable direct operations and disposal in both placements. `qualify-vector-startup.mjs` reuses the owned Main process fixture for healthy seed, corrupt local/child startup, disabled controls, semantic API/model-tool failure, canonical message/Archive persistence across restart, admin/signal shutdown and fatal corrupt Catalog/Archive controls. Each exchange requires the marked canonical user input, its later recall response and a still-later final model answer, including after restart; earlier history cannot satisfy it. No fixture repairs the derived manifest.

These fixtures are separate disposable runtimes. They do not establish Windows Desktop runtime qualification, deployment readiness, stronger parent-loss fencing or a Session Worker platform.
