# Unit: WebUI channel registration and shared DTO contract

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Nodes.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiContract.cs`

## Purpose

Registers the .NET WebUI route surface and defines shared request/response/event DTOs, route limits, deployment-relative identifiers, and host-to-client compatibility shapes.

## Stable methods and callers

`WebUIChannel.Register` composes route groups and injects `SessionManager`, `SessionRuntime`, `TaskService`, `ImageBlobStore`, `TerminalRegistry`, `CodeWorkbench`, and realtime publisher dependencies. `WebUiContract` owns parsing/serialization helpers and bounded pagination/operation results consumed by all partial route units and React WebUI units.

## Contract and side effects

Routes are registered behind `HttpServer` normal auth. DTO validation precedes manager/runtime calls; this file does not write Session JSON, Archive, or catalog directly. Accepted/committed/partial failures retain explicit status fields for browser state reconciliation.

Authenticated `GET /api/sessions/{id}/nodes` reads catalog identity and real Node topology without admitting a Session owner, returning `nodes[{id,label,selectable,reason}]` and `lockedReason`. Approved offline and incompatible choices retain useful reasons; Agent-bound choices are locked and scoped to that binding. `POST /api/sessions/{id}/node` admits the actual owner and delegates selection with cwd retention, returning `{session}` after durable publication. The original composer permits busy selection; no new busy/Worker restriction is added. Its semantics are governed by [the original composer decision](./webui-chat-composer.md#d-composer-session-node-picker), with explicit .NET tool/command cwd clearing kept separate in [remote compatibility](../threads/remote-node-compatibility.md#net-external-node-integration).

`WebUiContract.Session` and owner `BuildDto` project effective execution placement into history, composer responses and realtime snapshots, so the original picker survives refresh and reconnect. History resolves the Node from its captured authority snapshot through the owner's Agent binding. Both use the same resolver as `SessionManager.ExecutionPlacement`: trimmed stored selection, otherwise the isolated Agent's recorded binding, otherwise `master`. Retained authority with absent or null `currentNode` therefore presents its actual execution Node without writing a selection or changing cwd, history, settings or usage. Main catalog listings remain bounded projections; rendering does not admit other catalog members or change identity/alias ownership.

## Tests

`WebUiStartupTests.cs`; `SessionExecutionNodeProjectionTests.cs` (retained absent/null selection, persisted Agent binding, explicit remote placement and read-only DTOs); route contract/serialization fixtures; all partial WebUI route tests; `experimentHostNodeConsumers.e2e.mjs` (original picker, real Node connection, binding, busy selection, save faults and cold restart); `experimentHostLegacyNodeProjection.e2e.mjs` (normal startup with file token, retained authority, original picker, reload/realtime and cold restart without selection writes or provider calls).
