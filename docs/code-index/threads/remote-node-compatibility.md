# Thread: Remote Node and Worker compatibility

## Existing producer to consumer paths

```text
TypeScript/Python CLI, browser, Android, or sandbox Node
  -> shared Node protocol/auth/capability negotiation
  -> remote transport (proxy/WebSocket/HTTP/PTY/file transfer)
  -> TypeScript Main/node services and their current consumers
```

These paths remain real repository components. They are not shown as a .NET `SessionOwner` child chain because the current .NET host has local file/exec/terminal/MCP implementations and compatibility adapters, but no blanket claim that all remote Node/Worker runtimes are wired into the .NET Main.

- **Producers:** CLI Node client, browser extension background transport, Android `server.py`, and sandbox runtime emit protocol requests/results with node identity/capabilities.
- **Owner:** each Node runtime owns its local process/tab/device/worktree operations; shared protocol files own wire shapes; TypeScript Main/remote services own current routing where still present. Main-side `ToolRegistry`/authorization remains the authority for whether a remote capability may be invoked.
- **Durable/transport boundary:** shared protocol schemas, auth/pairing, event ack, file transfer, tool-result envelopes, PTY frames, and process lifetimes. Remote Node local state is not Session JSON/Archive authority.
- **Consumers:** TypeScript Main compatibility paths, CLI TUI, browser popup/extension, Android clients, sandbox provider, and selected Code/terminal bridges.

## Compatibility contract

Preserve optional fields, capability negotiation, auth/error semantics, bounded transfer/truncation, and event acknowledgement at stable protocol boundaries. Do not infer .NET Main integration from shared package existence. Do not use a Node protocol capability as a bypass around `ToolAuthorizationEvaluation` or local path/exec policy.

## Current gaps

Remote Node topology and Worker ownership remain migration work. Root package start/build still targets TypeScript Main (`lib/index.js`); the .NET `Program` is an experiment/host entry with explicit environment requirements, not a switched root launcher. Vector admission/search is also not a current .NET capability.

## Canonical units and tests

- [Shared protocol](../units/shared-node-protocol.md)
- [CLI Node](../units/shared-and-nodes-cli-node.md)
- [Browser Node](../units/shared-and-nodes-browser-node.md)
- [Android Node](../units/shared-and-nodes-android-node.md)
- [Sandbox Node](../units/shared-and-nodes-sandbox-node.md)
- [Tools/permissions](../threads/tools-permissions-and-exec.md)
- shared protocol, CLI compatibility, browser protocol/tool-result, Android auth, and sandbox worktree tests.
