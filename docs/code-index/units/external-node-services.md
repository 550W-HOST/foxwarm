# Unit: External Node Code service transport

Files: `dotnet/Foxwarm/Nodes/NodeConnectionHub.Services.cs`

## Purpose

Connects authenticated, compatible Node capabilities to the fixed filesystem, read-only Git and PTY consumers. These are trusted administrator/browser APIs, not ordinary model tools, shell execution, Provider lifecycle or an external-owner platform.

## Stable symbols and callers

- `NodeConnectionHub.Service` captures the registered connection generation and advertised service version. `Services` discovers currently executable service endpoints. Missing or old capabilities produce `UnsupportedService`; an offline, revoked or replaced connection produces `NodeUnavailable`. There is no Master fallback.
- `RequestServiceAsync` sends `node_service_request` with an opaque request ID, service, fixed operation and arguments. The pending invocation binds the exact connection and service; a different peer, a retired generation, an explicitly wrong service or an unknown/late ID cannot complete it. Error replies retain their service code and HTTP status. Cancellation/deadline/disconnection removes local correlation without retrying an uncertain remote effect; the official protocol has no service-request cancellation command.
- `CommandServiceAsync` sends the official one-way `node_service_command` framing used for terminal input, resize, detach and correlated helper results. Submission is serialized with existing credential revocation and connection replacement.
- `HandleServiceEvent` admits only advertised fixed services on the current authenticated generation. `ServiceReceived` includes a Main-captured endpoint, not peer-supplied Node or Session authority. `ServicesDisconnected` invalidates affected browser transports without reporting remote process death.
- An optional request-response receiver publishes terminal attachment readiness synchronously before later events from the same socket. This preserves ready/backlog/output ordering rather than relying on asynchronous task-continuation scheduling.

Callers: [Code files/Git](./code-services.md) and [terminal routing/helper](./terminal.md). Existing ordinary tool, exec/completion, heartbeat and whole-file-transfer frames remain independent.

## Authorization and version boundary

The host's normal instance-token/cookie authentication grants administrator API access. These services do not fabricate a Session, Agent or model principal and do not pass through model-tool authorization. Model tools still use their real Session and concrete policy. Code capability URLs and the browser bridge retain their narrower origin/source/hash checks separately from ordinary HTTP authentication.

`vscode-fs` and `vscode-pty` require version 1; status/content require `vscode-git` version 1 and immutable commit details require version 2. The matching client owns operation validation and actual filesystem/Git/process effects. The [.NET CLI](./dotnet-cli-node.md#fixed-code-services) implements filesystem version 1, Git version 2 and PTY version 1 only when its native backend is available.

## Tests

`dotnet/Foxwarm.Tests/Tools/NodeServiceTransportTests.cs` covers service discovery/version rejection, exact connection/request/service correlation, cancellation, replacement, disconnect and authenticated event identity using real HTTP/WebSocket transports. `packages/webui/test/experimentHostNodeCode.e2e.mjs` connects unchanged official CLI services to owned real hosts and browser consumers, including real files, Git, PTYs, resize, fanout, detach/close, reconnect, helper ownership and optional official Code assets.
