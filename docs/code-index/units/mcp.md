# Unit: Outbound MCP client

Files: `dotnet/Foxwarm/McpClient.Connections.cs`, `dotnet/Foxwarm/McpClient.cs`, `dotnet/Foxwarm/McpConfiguration.cs`
Secondary files: `dotnet/Foxwarm.Tests/Mcp/OutboundMcpFixture.cs`, `dotnet/Foxwarm.Tests/Mcp/OutboundMcpLifecycleTests.cs`, `dotnet/Foxwarm.Tests/Mcp/OutboundMcpResultsTests.cs`, `dotnet/Foxwarm.Tests/Mcp/Fixtures/outbound-peer.mjs`, `packages/webui/test/experimentHostMcp.e2e.mjs`, `packages/webui/test/experimentHostMcp.peer.mjs`

## Purpose

Loads configured outbound MCP servers, maintains official SDK clients/transports, and supplies discovery and calls to the unified tool registry. It does not implement inbound MCP or Session notifications.

## Stable methods and callers

- `McpConfiguration.Get`, `Snapshot`, and `UpdateAsync` own validated, persist-before-publish live server configuration and redacted summaries. Manual file edits are startup-only.
- `McpClient.ListToolsAsync` and `CallAsync` accept the actual trusted Session owner and its captured connection generation from `UnifiedTools`/`ToolRegistry`; nested ToolScript uses the same Session executor. Unowned low-level HTTP probes remain short-lived, not an anonymous shared connection identity.
- `WithClientAsync`, `ConnectEntryAsync`, and `ObserveDisconnectAsync` acquire/release bindings, fence late initialization, and remove disconnected clients. `MatchesConfiguration` rechecks the live configuration at acquisition and publication, including concurrent publication before the mutation hook runs.
- `InvalidateServer` runs after committed managed configuration changes; `InvalidateOwner` advances the exact owner's connection generation during real identity move/deletion. `BeginShutdown`, `DrainAsync`, and `DisposeAsync` fence new calls and drain admitted operations, initializers, disposal, and disconnect observers.
- `NormalizeResult`, `PlainText`, and `NormalizeImages` apply [Source MCP normalization](./src-mcp-client.md#d-mcp-source-normalization) at this source boundary, before the ordinary tool/history or native ToolScript projections.

## Connection and cancellation contract

HTTP/SSE/auto bindings belong to one in-process Session owner/lifetime, generation, named server, and configuration. Different Sessions never share a stateful peer Session. No model argument, fabricated principal, or persisted peer-session record supplies this identity. The owner's ordinary mutation admission protects acquisition against current identity/deletion claims; SDK initialization remains independently cancellable rather than holding the mutation lease for a network round trip.

Stdio retains the process key of server, command, args, env, cwd, and stderr. Token/header/timeout-only changes do not restart its process. A changed/disabled stdio configuration removes the prior binding from new acquisition: established active calls may finish using their captured process, while idle processes and unpublished initialization are closed. The existing 60-second idle cleanup remains stdio-only.

The pinned official Core SDK owns transport initialization/fallback and stateful HTTP session termination through `OwnsSession`; there is no custom HTTP DELETE or idle timer. A failed already-sent tool call is not retried through another transport. Request cancellation uses the SDK token/API boundary. The existing bounded, typed stdio cancellation notification remains because a token-only timeout did not reliably notify the official peer with this SDK; it cannot undo completed peer effects. Cancelling one HTTP request does not close a binding while another lease remains active; a cancelled last lease may close its idle binding. Configuration/owner invalidation cancels the affected HTTP lifetime, and a late connection cannot be published after invalidation.

Secrets are redacted using the exact configuration which supplied a connection's credentials, including failures after a concurrent configuration change. MCP discovery/execution remains subject to the ordinary unified authorization boundary.

## Tests

`OutboundMcpLifecycleTests` uses official JavaScript SDK peers for stdio reuse, stateful initialize fallback, owner-scoped HTTP discovery/call/native Monty reuse and isolation, concurrent/single cancellation, real configuration/move/deletion/shutdown hooks, invalidated initialization, SSE, and auto initialization cleanup without effect replay.

`OutboundMcpResultsTests` uses those peers plus an official C# SDK ASP.NET stateless/discover peer. Default SDK result metadata is preserved; an explicit official outgoing-message filter also qualifies metadata-free scalar/null/array structured results. Tests pass real values through the Session executor, native Monty, ordinary turn pairing, JSON/Archive persistence, image references/provider projection, and compaction previews. Audio and binary resource content remain result data, without playback or decoding.

`experimentHostMcp.e2e.mjs` exercises the original App and actual HTTP Main through disposable SDK peers and a synthetic provider, including paired result forms, stdio process-key changes with active calls, real Stop, four HTTP/SSE/auto placements, control receipts, clean restart, Archive rows, and owned process cleanup. Existing authorization, image, ToolScript, and owner lifecycle regressions remain relevant.
