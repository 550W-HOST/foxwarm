# Module: Shared and Nodes

TypeScript protocol and execution packages that remain real boundaries while the .NET Main migration proceeds. A Node capability is selected through the Node protocol and host authorization; it is not automatically a Main-local capability.

## Units

- [Shared Node protocol and capability shapes](../units/shared-node-protocol.md)
- [Shared file, exec, and output primitives](../units/shared-local-execution.md)
- [Shared patches, config schemas, markup, and metadata](../units/shared-patches-and-config.md)
- [Shared Code helper IPC and VS Code service](../units/shared-code-ipc.md)
- [Authenticated CLI Node client, TUI, master proxy, PTY service, and process lifecycle](../units/shared-and-nodes-cli-node.md)
- [CLI Node native runtime](../units/shared-and-nodes-cli-runtime.md)
- [Browser extension Node transport, permissions, tabs, and popup](../units/shared-and-nodes-browser-node.md)
- [Android-compatible Python Node server and authentication helpers](../units/shared-and-nodes-android-node.md)
- [Sandbox worktree invocation and file operations](../units/shared-and-nodes-sandbox-node.md)
- [VS Code Web extension assets and dedicated web integration build boundary](../units/shared-and-nodes-vscode-web-assets.md)

## Cross-module contract

[Remote Node compatibility](../threads/remote-node-compatibility.md) owns the transport boundary; [Tools, permissions, and exec](../threads/tools-permissions-and-exec.md) owns Main-side authorization and dispatch.
