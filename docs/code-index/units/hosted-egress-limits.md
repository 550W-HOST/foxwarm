# Unit: Egress guard, tenant limits and tenant settings

Files: `dotnet/Foxwarm/Net/EgressHttp.cs`, `dotnet/Foxwarm/Net/EgressPolicy.cs`, `dotnet/Foxwarm/Channels/ChannelHttpClients.cs`, `dotnet/Foxwarm.Tests/Net/EgressMatrixTests.cs`, `dotnet/Foxwarm.Tests/Net/EgressFixture.cs`, `dotnet/Foxwarm.Tests/Net/EgressSourceRulesTests.cs`, `dotnet/Foxwarm.Tests/Net/EgressFileModeParityTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.Egress.cs`
Secondary files: `dotnet/Foxwarm/RuntimeCapabilities.cs`, `dotnet/Foxwarm/Hosted/Config/DeploymentConfiguration.cs`, `dotnet/Foxwarm/Models/AppConfigurationSplit.cs`, `dotnet/Foxwarm/Hosted/HostedEntry.cs`, `dotnet/Foxwarm/McpOAuthHttp.cs`, `dotnet/Foxwarm/McpOAuth.Resource.cs`, `dotnet/Foxwarm/McpClient.Connections.cs`, `dotnet/Foxwarm/Models/ProviderHttpRequest.cs`, `dotnet/Foxwarm/Models/ConfiguredModelRequests.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsTransport.cs`, `dotnet/Foxwarm/Sessions/SessionManager.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Setup.cs`, `dotnet/Foxwarm/Channels/ManagedChannels.cs`, `dotnet/Foxwarm/Channels/QQBotChannel.cs`, `dotnet/Foxwarm/Channels/QQBotChannel.Gateway.cs`, `dotnet/Foxwarm/Channels/WeWorkChannel.WebSocket.cs`, `dotnet/Foxwarm/Asr/AsrProxy.cs`, `dotnet/Foxwarm/Asr/AsrProxy.Stream.cs`, `dotnet/Foxwarm/Vector/VectorRuntime.cs`, `dotnet/Foxwarm/Hosted/HostedCli.cs`, `dotnet/Foxwarm/CliCommands.cs`

## Purpose

In hosted mode nothing a tenant configures (model `baseUrl`, MCP servers, OAuth metadata, channel endpoints, redirects) may make a replica connect to an internal destination: the database, object storage, the mesh, cluster services or cloud metadata. Kubernetes NetworkPolicy can't tell the operator tenant from a hosted tenant on one replica, so the guard is in the application. File mode's outbound behavior doesn't change.

## D-egress-factory

**Approved plan P2 §7.1 (E13).**

- **One factory.** `EgressHttp` is the only constructor of outbound HTTP handlers, HTTP clients and WebSocket connections in the Main server: `Handler(policy, purpose, options)`, `Client(...)`, `PinnedHandler(...)` (addresses resolved and checked once by the caller, OAuth discovery and tokens), `WebSocket()` and `ConnectWebSocketAsync(...)`. `EgressHandlerOptions` carries what call sites set: redirects, cookies, the connect timeout, the proxy (file mode only) and the file-mode handler type.
- **Guarded handlers.** A `SocketsHttpHandler` with `UseProxy = false` (an environment proxy would otherwise carry the connection past the check) and a `ConnectCallback` that resolves the host itself, checks every address, and connects to a checked address without resolving again. One denied address refuses the connection, so a name can't mix a public and an internal answer. The callback runs for every new connection, so redirects and later lookups (rebinding) are checked each time. An IPv4-mapped address is connected as IPv4.
- **WebSockets.** A guarded policy always connects through a guarded invoker: the caller's invoker if it has one (Responses, ASR), otherwise one the factory builds and disposes after the handshake, as `ClientWebSocket`'s own connect does.
- **HTTP/3** would bypass the connect callback (QUIC); no site requests it and the source rule keeps it that way.
- **Denial** is `EgressDeniedException` thrown from the connect callback, before any byte is sent. Callers see their existing connection-failure shape (`HttpRequestException`, `WebSocketException`): Setup's model list answers 502 "Provider model list request failed.", a model request fails as a connection error. The exception text is draft copy for the coordinator.

## D-egress-policy

**Approved plan P2 §7.1; operator semantics as below (EG proposal, 2026-11-27).**

- **Profiles.** `EgressPolicy.Unguarded` is file mode: every site builds exactly the handler it built before. `Hosted` denies the default internal set; `Operator` allows it. Both apply the deployment's `egress.deny` and their own allow exceptions. The policy is `RuntimeCapabilities.Egress`, fixed at runtime construction; `RuntimeCapabilities.Hosted` defaults to `Hosted` without deployment rules, and the hosted entry adds the deployment's.
- **Default deny set** (`EgressAddresses.IsInternal`): `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (metadata included), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/3` (multicast, reserved, broadcast); `::/16` (unspecified, loopback and every IPv4-compatible form), `fc00::/7`, `fe80::/10`, `ff00::/8`. IPv4-mapped addresses are checked as the IPv4 address. It is the set `McpOAuthHttp` already used, now shared.
- **Deployment rules** (`egress` in the deployment configuration, `EgressRules`): `deny` adds CIDRs or addresses for both guarded profiles (cluster pods and services, the database, object storage, the mesh); `allow.hosted` and `allow.operator` list CIDRs, addresses or exact host names that profile may reach anyway. A host exception skips the address check for that name. Malformed entries refuse startup naming the entry.
- **Purposes.** `Model`, `Mcp`, `Channel` use the profile's rules. `Deployment` (the ASR service, which the deployment configures) uses the operator rules even in a hosted runtime.
- **OAuth** (`McpOAuthHttp.PinnedClientAsync`) keeps its own rule (an unrelated private endpoint is refused unless same-origin or both loopback) and adds the policy's: a hosted tenant's same-origin private endpoint is refused too.

## D-egress-call-sites

| Site | Purpose | File-mode handler (unchanged) |
|---|---|---|
| `SessionManager.http` (models, Setup list and test probes, text-redaction detection), `CliCommands` (`foxwarm model`, unguarded) | Model | `HttpClientHandler { UseCookies = false }` under `ProviderResponseDecodingHandler`, no client timeout |
| Responses WebSockets (`ResponsesWsTransport`, the Setup probe's owned transport too) | Model | `SocketsHttpHandler { UseCookies = false }` under `WsHandshakeHeaders` |
| Outbound MCP without OAuth (`McpClient.PlainHttp`) | Mcp | `HttpClientHandler` defaults |
| MCP resource requests with OAuth (`McpOAuthService.ResourceTransport`) | Mcp | `SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }` |
| OAuth discovery and tokens (`McpOAuthHttp.PinnedClientAsync`) | Mcp | pinned `SocketsHttpHandler`, 15 s connect timeout |
| Telegram, Matrix, WeWork, Weixin (`ChannelHttpClients`, one client per type per runtime instead of a process-wide static) | Channel | `HttpClientHandler` defaults, no client timeout |
| QQ Bot API (`QQBotChannel.CreateHttp`), QQ Bot gateway and WeWork WebSockets | Channel | `SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }`; WebSockets connect without an invoker |
| ASR proxy and its stream | Deployment | `HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }` |
| Vector embeddings (file mode only) | Model, unguarded | `HttpClientHandler` defaults, 60 s |
| `hosted health` probe | Deployment, unguarded | `SocketsHttpHandler { UseProxy = false }`, 3 s |

Node and Provider outbound traffic is out of scope (`D-node-isolation-boundary`).

## Tests

- `EgressMatrixTests` (plan §11 egress matrix) on `EgressFixture`, a scripted resolver and a connector that carries two global addresses to a loopback server: every denied literal kind, names resolving to each (and mixed answers), redirects to each by literal and by name, a WebSocket upgrade to each, all refused for hosted with no connect attempted; public names resolved once per connection and connected at the checked address; rebinding public → loopback → metadata refused on the next connections; the operator profile reaching loopback directly, by name, by redirect and by WebSocket, and refused by `egress.deny` in every form; allow exceptions per profile; the deployment purpose; the deployment rules' validation.
- `EgressSourceRulesTests`: no file but the factory constructs `HttpClient`, `SocketsHttpHandler`, `HttpClientHandler`, `ClientWebSocket`, a raw `Socket` or `TcpClient` (the P1 standby forwarder is exempt), connects a WebSocket directly, requests HTTP/3, or calls `ProviderHttpRequest.CreateClient()` without a policy; the negative check runs each forbidden form through the rule.
- `EgressFileModeParityTests`: per call site, the file-mode handler type and every public setting equal the base's construction, and the client timeout.
- `HostedStartupTests.AHostedTenantCantMakeTheReplicaConnectToInternalDestinations`: in the hosted runtime, Setup's model list and model test (HTTP and Responses WebSocket) to loopback, IPv4-mapped loopback, `localhost`, metadata and RFC 1918 are refused and the peer receives nothing; the hosted turn test reaches its loopback model only through `egress.allow.hosted`.

## Open Questions

- NAT64 (`64:ff9b::/96`) and 6to4 forms aren't in the default set; a deployment that routes them to internal IPv4 adds them to `egress.deny`.
