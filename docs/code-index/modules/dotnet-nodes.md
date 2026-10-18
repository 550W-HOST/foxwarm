# Module: External Nodes

Persistent administrator-approved trust, credential-authenticated WebSocket and exec-only Shell HTTP connections, compatible capability discovery, Session placement and ordinary external tools, exec and authenticated Session events.

## Boundaries

This module connects existing CLI/browser/Android Node protocol clients to the .NET host. It does not create environments or grant OS isolation. Fixed Code/PTY services use advertised authenticated capabilities, not model-tool dispatch. Whole-file consumers connect through the existing CLI transfer protocol. Remote exec authority is transient and bounded; the client owns its process and pending replay. [Remote Node integration](../threads/remote-node-compatibility.md#net-external-node-integration) owns the canonical connected contract and remaining phase boundaries.

Session Worker hosting and Node Provider environment lifecycle are excluded from this delivery; see [delivery scope](../overview.md#d-dotnet-delivery-scope).

## Units

- [External Shell HTTP exec transport](../units/external-shell-http.md)
- [External Node trust and ordinary tools](../units/external-nodes.md)
- [External Node Code service transport](../units/external-node-services.md)
- [External Node file consumers](../units/external-node-files.md)
- [External exec authority and Node Session events](../units/remote-exec.md)
- [Unified tools and Session tool execution](../units/tools-registry.md)
- [Tool authorization and isolation compatibility](../units/tool-authorization.md)

## Tests and callers

The external Node unit maps the persistent registry/save-lane tests and real host/official-client qualification. The ordinary Node path uses the existing Session owner and tool authorization; Main-owned observation and history remain available offline.
