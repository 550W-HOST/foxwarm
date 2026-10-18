# Unit: Session-facing MCP notifications and explicit text channels

Files: `dotnet/Foxwarm/McpClient.Notifications.cs`, `dotnet/Foxwarm/McpClient.ReceiveTransport.cs`, `dotnet/Foxwarm/McpReplyChannel.cs`, `dotnet/Foxwarm/Channels/TextChannels.cs`, `dotnet/Foxwarm/Sessions/SessionManager.McpNotifications.cs`, `dotnet/Foxwarm/Sessions/SessionManager.TextChannels.cs`
Secondary files: `dotnet/Foxwarm/McpClient.Connections.cs`, `dotnet/Foxwarm/McpInboundHttp.cs`, `dotnet/Foxwarm/McpInboundSessions.cs`, `dotnet/Foxwarm/McpExternalContext.cs`, `dotnet/Foxwarm/McpAttachedResponseStream.cs`, `dotnet/Foxwarm/Sessions/SessionRuntime.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.cs`, `dotnet/Foxwarm/Tools/UnifiedToolDefinitions.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.cs`

## Purpose and Source ownership map

Implements [explicit notification reception and replies](../threads/tool-dispatch-mcp.md#d-dispatch-mcp-explicit-notifications) on the existing trusted Session/server binding, without changing ordinary external execution authority or adding another receiving Session identity.

| Behavioral Source | .NET owner and actual callers |
| --- | --- |
| `tools/mcpTools.ts`, `mcpExternalService.ts` | `SessionToolExecutor` → `SessionManager.ManageMcpNotificationsAsync`: discoverable, default-hidden `mcp_notifications`; exact current owner and complete concrete builtin authorization. |
| `mcpCallerConnections.ts`, `mcpClient.ts` | `McpClient.ManageNotificationsAsync`, `ReceiveNotificationAsync`, `PreflightReplyAsync`, `PingNotificationsAsync`, and the existing caller pool: one ordinary/reception connection, disabled preinstalled handler, exact peer capability and real physical GET readiness. |
| `mcpExternalService.ts` notification producer | `SessionManager.McpNotifications` → `SessionRuntime.SubmitExternalAsync` → strict normal User save-lane admission, with final binding/source/permission fences. |
| `mcpInboundHttp.ts`, `mcpInboundSessionService.ts` | `McpReplyChannel`, `McpInboundHttp`, `McpInboundSessions`: context-owned text-only reply registration and admission lease; public SDK notifications use the qualified physical attachment. |
| `channel.ts`, `session/channels.ts`, `toolsSessionAgent/interSession.ts` | `TextChannels`, `SessionManager.SendToChannelAsync`: real registered destinations, existing exact caller authorization and isolated own-attachment restriction. |
| `channels/webuiChannel.ts.sendMessage` | The running `WebUIChannel` registers its text method. `PresentChannelText` emits the existing trusted temporary message projection; no history append or model turn is created. |

## Reception and authorization

Session-owned HTTP clients advertise experimental `foxwarm/session-notifications` version 1 during initialization and install the custom `notifications/foxwarm/session_message` handler before connecting. The handler remains disabled until explicit start. Real external-context outbound owners do not advertise internal reception. Start requires the exact enabled configured server, explicit Streamable HTTP, peer version 1 and an actual successful standalone GET response. It neither recreates an ordinary connection nor resets its remote Node/cwd/exec state. Stop terminates that caller/server context; status never lazily initializes a connection. Missing names never fall back to another server.

Start, each admitted notification, official reply-aware preflight and the standard five-minute ping reauthorize the current Session through generic policy and retained legacy isolation rules. The final ingress assertion rechecks the exact owner/generation/binding and current policy. A move, deletion, managed server mutation/disable, OAuth account change, inbound context disposal or shutdown fences the corresponding producer. Session shutdown first stops notification production; already-admitted ordinary leases settle before their retiring connection closes. Stdio and ordinary calls retain their separate owners/drain.

Only a negotiated Foxwarm peer's `foxwarm_session` send receives reply-aware preflight. New `allowReply:true` and read-old `reply:true` need permitted enabled reception and a current physical receiver; conflicting booleans reject before invocation. Unrelated third-party same-name tools/arguments and opaque MCP result data do not acquire this meaning.

Received original text and whitespace stay in a separate text part between server-owned escaped external-input metadata parts containing configured server, endpoint, local time and hint. The canonical/provider role remains User. No source Session, parent/child relation, handoff receipt or reply-wait authority is inferred. Text-only external ingress validates its real current owner but does not depend on an unrelated attachment Node being online; file/media ingress retains its materialization boundary. Bounds and known-credential checks run before admission, including credentials retained for the actual OAuth GET lifetime.

## Pinned client readiness seam

The qualified official Core SDK is 2.2.0. Its public `HttpClientTransportOptions.EnableStandaloneGetStream` opens GET asynchronously after initialization, but no public readiness/body-lifetime event is supplied. `ReceiveTransport.Handler` observes the actual SDK request through its supported `HttpClient` constructor seam. It marks readiness only on a successful session-bound `text/event-stream` GET, wraps body reads to observe EOF/failure/disposal, and keeps each stream's credential snapshot only for that lifetime. Failed GETs fail readiness rather than treating initialized POST as a receiver. It does not parse frames, replace SDK transport/framing, reflect into private members, or introduce a reception-control RPC.

SDK same-context GET reconnection remains available with no offline replay. GET status is independent of ordinary POST/tool errors. A 404 or static credential rejection retires the binding without replaying a possibly executed call; OAuth same-grant renewal preserves it and insufficient-scope errors do not rebuild it. SDK-owned DELETE has a five-second cleanup budget before transport close. The inbound physical attachment seam and its exact SDK assumptions remain canonical in [ordinary inbound MCP](./dotnet-inbound-mcp.md#d-dotnet-inbound-mcp-pinned-sdk).

## Explicit text delivery

`McpReplyChannel` registers only while a permitted reply-enabled admission is pending or has actually committed. Failed pre-effect admissions release their registration; an explicitly committed-but-unsynced strict admission retains its real destination while reporting uncertainty. Context retirement unregisters the endpoint. Every send requires the same live negotiated context and physical attachment, and captures that attachment before entering the SDK writer. Successful send means an attempted online delivery, never a receiving acknowledgement.

`send_to_channel` is default-injected and uses the concrete builtin identity through direct, unified and native ordinary ToolScript dispatch. A non-isolated authorized caller can send to any registered destination, including an unattached endpoint and one supplied to another Session. Isolated callers still require their own persisted attachment even with an exact capability allow. Conversation IDs preserve colons. Adapter failures propagate. Temporary MCP endpoints never become Session attachments and receive no ordinary assistant output, logs, history, progress or broadcasts.

Successful builtin sends use the existing ordinary tool result and trusted ToolScript subcall presentation. Channel destinations do not fabricate `sessionMessages`, a Session handoff receipt or authority from peer-returned metadata. The WebUI text adapter uses the existing temporary instant-message event and does not persist the destination text in target history. No durable channel store, outbox, ACK, retry, recovery or automatic forwarding is added.

## Qualification

`McpNotificationTests` partials use normal Session executors, official C# clients, independent official JavaScript SDK peers, real HTTP GET disconnect/reconnect and real strict JSON admission. They cover original text and metadata separation, shared ordinary/start context, independent owners, disabled/malformed/progress filtering, direct/unified/native explicit replies, permission and legacy-rule reauthorization, isolated attachments, physical readiness, unsupported reception preserving ordinary calls, third-party same-name tools, ping, accepted ordinary drain, credential withholding, OAuth renewal/disconnect, selective account/config/owner cleanup, stop/restart and no offline replay.

`experimentHostMcpNotifications.e2e.mjs` runs two normal Main processes and a controlled ordinary provider. It exercises actual User/provider roles and wait wake, normal assistant non-forwarding, direct/unified/native replies and trusted subcall presentation, registered temporary WebUI text through the real realtime socket, official JavaScript capability/read-old explicit reply, and stale destinations after stop/new context. Existing ordinary inbound, pinned attachment, outbound/OAuth and caller permission tests remain relevant; this feature does not replace their raw-result, CLI or browser authority contracts.
