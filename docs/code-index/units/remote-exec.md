# Unit: External exec authority and Node Session events

Files: `dotnet/Foxwarm/Nodes/NodeConnectionHub.Exec.cs`, `dotnet/Foxwarm/Nodes/RemoteExecAuthority.cs`, `dotnet/Foxwarm/Sessions/SessionManager.NodeEvents.cs`

## Purpose

Dispatches real advertised external exec through the existing authorized tool registry. Main owns transient start-time reservations and Session admission; the official client owns its process, artifacts and pending completion replay. This is not a persistent exec queue, a process-polling service, an external-owner platform or a Worker mailbox.

## Stable symbols and consumers

- `NodeConnectionHub.ExecuteAsync` reserves the exact identity before exec dispatch. `ExecuteOnceAsync` carries the Main-owned original canonical Session/Agent, captured Node/cwd, exec identity and completion grant over the authenticated connection. Ordinary non-exec tools retain the same correlated transport; Master exec retains `LocalExecManager`.
- `RemoteExecAuthority` owns reserved, active and outcome-unknown claims, opportunistically expires them after 24 hours and signs Source-compatible completion capabilities with `state/node_event_capability_secret`. `Activate`, `Exact`, `Has`, `Complete`, `Rebind`, `Retire` and `Clear` supply the narrow consumers for waits, ingress and lifecycle. Claims use actual Session owner objects, not fabricated or persisted principals.
- `HandleToolReply` uses the authenticated correlated response to settle a known foreground/pre-start result or preserve an uncertain start. `CancelExecWaitAsync` sends the advertised `tool_call_cancel` handshake without discarding its reply correlation.
- `SessionManager.RegisterRemoteExecBackgroundAsync` accepts only an exact reservation, original signature and current owner lifetime. A peer-returned arbitrary exec ID is not active wait authority.
- `SessionManager.AdmitNodeSessionEventAsync` authenticates exec completion against the start-time Node/Session/exec grant, then admits through the real owner/save lane. Ordinary background/trigger/onboot events use the current or bound Node rule. `WakeNodeEventOwner` triggers only newly admitted runnable work.

Callers: direct model calls, `call_tool`, native inline ToolScript, authenticated `/node_ws`, `waitExecIds`, Session rename/delete and host shutdown. The [external Node unit](./external-nodes.md) owns trust and transport publication; [Session wait admission](./session-save-lane-wait.md) owns durable receipt/queue publication.

## Contracts

Only `remote_exec_background` with the exact authenticated identity, original canonical Session, exec ID and signature activates a remote wait target. Returned output, cwd text and arbitrary exec IDs never create authority. Session selection changes do not revoke a started exec's completion grant. Rename retains its original signed Session and resolves aliases to the same owner while updating Main-owned Agent claims; deletion removes those claims and fences the retired lifetime. Node rename does not translate old grants to the new authenticated identity.

Exec completion uses `remote-exec-completion:<execId>` and bounded `acceptedExternalEventIds` (newest 32). The transport sends `session_event_accepted` only after strict admission or durable duplicate proof. Precommit failure does not publish the queue/receipt or send success. A committed-but-unsynced admission publishes the owner result but reports failure; duplicate retry finishes strict durability without reinserting or waking twice. The transient claim is released only after that boundary succeeds. This is bounded deduplication, not permanent exactly-once delivery.

Stop and Run queued end foreground waiting through actual advertised cancellation/background-registration support; the real client reports whether a command started. They do not kill the remote process. Older unsupported peers retain correlation until the actual result/deadline and never receive invented not-started or killed results. Disconnect, timeout and cancellation uncertainty never authorize replay. Legacy ID bridging and collision retry occur only after explicit pre-start rejection. Main shutdown fences/drains pending correlations and admissions. Main restart restores the signing secret and durable receipts, not active claims, queued commands or a new completion's start-time authority; an authenticated, signed persisted duplicate can be acknowledged, while a new unproven completion is rejected.

An exec error with `execStarted:false` is a definite pre-start rejection. An omitted field is unknown, unless the existing exact validation/collision rejection independently establishes no effect; Main retains its claim as `outcome-unknown` and does not replay it. The .NET CLI's [Windows launch helper](./dotnet-node-primitives.md#windows-persistent-exec-output) uses omission after a lost/unusable receipt, retaining original artifact paths in the error rather than asserting false or inventing a PID. This uses the existing optional wire field and does not change persisted exec records.

Remote cwd is forwarded only for the captured selected Node. Explicit cwd and the official client's default selection work unchanged; stdout is not a cwd protocol. Main filesystem resolution never receives a remote namespace. Main-owned status/history and Session creation remain possible offline; an actual remote effect fails without Master fallback. Model-created named Sessions, children, forks and timer-created Sessions retain their applicable source/captured or bound Node. Timer admission and internal wait clocks are Main-owned rather than conditioned on an online external process.

## External owners

[Ordinary inbound MCP](./dotnet-inbound-mcp.md) owns a separate `ExternalExecOwnership` record set and actual v3 external wire owner. `RemoteExecAuthority.IssueExternal`/`VerifyExternal` reuse the persisted capability secret with the Source v2 external-completion payload; internal Session claims and completion ownership remain unchanged.

## Tests

`dotnet/Foxwarm.Tests/Tools/RemoteExecProtocolTests.cs` uses real authenticated WebSockets and actual Session save lanes for strict pre/post-rename faults, duplicate ACK, exact registration, supported/unsupported Stop, explicit legacy/collision rejection, actual CLI definite-versus-unknown error projection and claim settlement, Session rename/delete and restart receipt-versus-new-authority evidence. `packages/webui/test/experimentHostRemoteExec.e2e.mjs` uses owned real .NET hosts, unchanged official CLI processes and real Monty dispatch. It verifies side-effect counts, canonical pairs, Archive/authority, foreground/timeout/background, bounded direct parallel calls, concrete authorization, current/explicit/default cwd, switch/wait, strict-save retry, dropped ACK, official pre-start collision, interactive pre-start Stop, post-start Stop, Run queued, Session/Node lifecycle, official pending-event replay, Main restart uncertainty, creation/fork/timer placement and genuine ordinary background/trigger/onboot producers.

Transfer/copy, remote ToolScript source, image delivery, Code/PTY services, Shell HTTP, provider lifecycle and Worker/inbound MCP remain outside this unit's connected phase.
