# Module: Nodes and executable providers

Main-owned generic registry, executable-provider file/process primitives, Session placement, persistent administrator-approved trust, credential-authenticated WebSocket and exec-only Shell HTTP connections, ordinary native remote tools, exec and authenticated Session events.

## Boundaries

This module connects existing CLI/browser/Android Node protocol clients to the .NET host. Optional lifecycle requests go to configured providers; Core itself supplies no provisioning driver or OS isolation. Fixed Code/PTY services use advertised authenticated capabilities, not model-tool dispatch. Whole-file consumers use the generic registry, retaining the existing CLI transfer protocol for resident Nodes. Remote exec authority is transient and bounded; the client owns its process and pending replay. [Remote Node integration](../threads/remote-node-compatibility.md#net-external-node-integration) owns the canonical connected contract and remaining phase boundaries.

Executable registry/files, persistent provider exec and optional lifecycle are connected. Discovery and lifecycle authority are canonical in [provider lifecycle](../threads/tool-dispatch-node-execution.md#d-dispatch-node-provider-lifecycle). Session Worker hosting and managed controllers remain excluded; see [delivery scope](../overview.md#d-dotnet-delivery-scope).

## Units

- [.NET headless CLI Node](../units/dotnet-cli-node.md) — separate authenticated file/exec and fixed Code filesystem/read-only Git executable.
- [Shared native primitives](../units/dotnet-node-primitives.md) — the narrow Main/CLI algorithm library.

- [.NET executable Node registry and files](../units/dotnet-node-providers.md)

- [External Shell HTTP exec transport](../units/external-shell-http.md)
- [External Node trust and ordinary tools](../units/external-nodes.md)
- [External Node Code service transport](../units/external-node-services.md)
- [External Node file consumers](../units/external-node-files.md)
- [External exec authority and Node Session events](../units/remote-exec.md)
- [Unified tools and Session tool execution](../units/tools-registry.md)
- [Tool authorization and isolation compatibility](../units/tool-authorization.md)

## Tests and callers

The external Node unit maps the persistent registry/save-lane tests and real host/official-client qualification. The ordinary Node path uses the existing Session owner and tool authorization; Main-owned observation and history remain available offline.
