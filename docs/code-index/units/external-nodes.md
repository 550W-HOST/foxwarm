# Unit: External Node trust and ordinary tools

Files: `dotnet/Foxwarm/Nodes/ApprovedNodeRegistry.cs`, `dotnet/Foxwarm/Nodes/NodeConnectionHub.cs`, `dotnet/Foxwarm/Nodes/NodeRoutes.cs`, `dotnet/Foxwarm/Nodes/NodeBootstrap.cs`, `dotnet/Foxwarm/Nodes/NodeToolDefinitions.cs`, `dotnet/Foxwarm/Nodes/RemoteNodeResult.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Nodes.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Node.cs`, `dotnet/Foxwarm/MessageRouter.Nodes.cs`

## Purpose

Records administrator-approved trust in already-running Node environments, negotiates their authenticated WebSocket connections, and dispatches advertised ordinary tools. This is not a Node Provider or environment-creation service.

## Stable symbols and consumers

- `ApprovedNodeRegistry` reads Source-compatible `state/nodes.json` and `state/node_token`, with numbered/legacy registry backup readers. Atomic updates persist credential hashes, pending requests and unclaimed pairing credentials. `Create`, `Request`, `Approve`, `Claim`, `Reject`, `Rename`, `Remove`, `Touch` and `Cleanup` implement the trust lifecycle. Credentials are rechecked at registration, so removing and recreating an identity cannot revive a socket authenticated with the old credential.
- `NodeConnectionHub.HandleAsync` owns `/node_ws` authentication, registration, protocol negotiation, heartbeat, quarantine and connection replacement. `ExecuteAsync` correlates calls to the exact authenticated connection; `DiscoveredDefinitions` provides an atomic compatible-capability snapshot without turning an offline Node into a model-preparation failure.
- `NodeRoutes.Register` supplies administrator list/inspect, onboarding/pending/commands/create/approve/reject, rename and removal APIs. `NodeBootstrap` serves the packaged official setup templates and source archive with deployment-prefixed addresses. `MessageRouter.HandleNodeCommandAsync` serves the existing `/node` administrator command family.
- `SessionManager.SelectNodeAsync` validates placement and commits it through `SessionSaveLane.CommitNodeAsync`, which publishes `currentNode` and clears old `cwd` in one authority save. `ExecutionPlacement` captures Node/cwd together; `ExecutionEnvironment` renders the request-time connection context without rewriting persistent Agent memory.
- `NodeToolDefinitions` provides only list/select/inspect and the approved pairing helpers. `ToolRegistry` and `UnifiedTools` consume advertised capabilities for current or explicit targets, while Main-local capabilities retain their existing implementation and authorization.
- `RemoteNodeResult.Normalize` removes the private documented path sidecar and translates documented legacy Node image carriers at ingress. Arbitrary peer fields remain data and do not become Main paths, cwd mutations or control receipts.

## Current contracts

The canonical integration boundary is [Remote Node compatibility](../threads/remote-node-compatibility.md#net-external-node-integration). Pairing/approved credentials are independent of administrator cookies/tokens. Credential-bearing URLs are excluded from ordinary ASP.NET request logging. Ordinary listings never expose credential hashes or unclaimed auth tokens; approved credential/setup responses are explicitly secret-bearing administrator operations.

The negotiated protocol range is 1–3, with absent offers treated as legacy version 1. Incompatible Nodes stay connected for diagnostics and ping/pong but have no executable capabilities. Replacement rejects predecessor calls and fences its late replies/close. Capability changes take effect on the new registered connection; duplicate registration follows the official Source behavior and is ignored.

The optional advertised `get_default_cwd` is a real call, not a synthetic shell effect. Without it, selection reports an unknown default. Remote cwd strings are forwarded in the Node namespace; Main-owned memory, configuration, Archive and observation paths do not pass them through Main path resolution. Existing Main exec semantics retain a declared captured cwd and use invocation-time live cwd when the captured local value was unset.

Agent Node binding uses existing Agent metadata and owner admission/creation. Administrator Agent creation accepts `isolatedNode`; updates use the existing PUT route. The default-hidden `set_agent_isolated` model consumer binds/clears placement and replaces the existing exact legacy rule array, with the existing isolated-caller restriction. Omitting `nodeId` preserves binding; rule-only updates do not clear cwd. It is a tool-authorization boundary, not an OS/network sandbox. Offline Nodes do not block Main-owned Session history, status or deletion; remote effects fail without Main fallback. The model batch skips every remaining unstarted call after failed or canceled Node selection, including wrapped selection and a later selection call.

## Phase boundary

Remote exec is excluded from discovered/model capabilities and rejects explicit dispatch because persistent reservations, completion authority, ACK/waits and Stop are not connected yet. File transfer/copy, remote ToolScript source, image delivery, Code/PTY Node services and Shell HTTP also remain unconnected. Inline native ToolScript can dispatch ordinary Node tools through the same concrete registry. Protocol 3 negotiation does not grant external-owner or Session-event behavior. Official CLI/browser/Android client code is unchanged.

## Tests

`dotnet/Foxwarm.Tests/Tools/ExternalNodeRegistryTests.cs` covers persisted credentials/claims, expiry, backup compatibility, rename/removal, protocol negotiation and legacy result normalization. `dotnet/Foxwarm.Tests/Sessions/SessionNodeCommitTests.cs` covers real pre/post-rename placement publication and remote cwd exclusion from Main paths. `packages/webui/test/experimentHostExternalNodes.e2e.mjs` starts owned real host/client processes and exercises the official CLI, official Chrome MV3 extension, model/native ToolScript dispatch, authorization, selection batching, restart, identity correlation, fencing and browser image/heartbeat paths. Physical Android hardware is not qualified by these tests.
