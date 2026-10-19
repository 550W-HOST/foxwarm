# Module: Shared and Nodes

TypeScript protocol and execution packages that remain real boundaries while the .NET Main migration proceeds. A Node capability is selected through the Node protocol and host authorization; it is not automatically a Main-local capability.

## Units

- [Shared Node protocol and capability shapes](../units/shared-node-protocol.md)
- [Shared file and local execution primitives](../units/shared-node-tools.md)
- [Shared persistent exec lifecycle](../units/shared-persistent-exec.md)
- [Shared output truncation and bounded excerpts](../units/shared-output-truncation.md)
- [Shared apply-patch parsing and file changes](../units/shared-apply-patch.md)
- [Shared pure configuration schemas](../units/shared-config-schemas.md)
- [Shared Code helper IPC](../units/shared-code-helper-ipc.md)
- [Shared VS Code Node service and Git details](../units/shared-vscode-node-service.md)
- [Authenticated CLI Node client, PTY service, and process lifecycle](../units/cli-node-client.md)
- [CLI Node master proxy](../units/cli-node-master-proxy.md)
- [CLI Node TUI](../units/cli-node-tui.md)
- [CLI Node native runtime](../units/shared-and-nodes-cli-runtime.md)
- [Browser extension Node transport, permissions, tabs, and popup](../units/browser-node-extension.md)
- [Android-compatible Python Node server and authentication helpers](../units/shared-and-nodes-android-node.md)
- [VS Code Web extension assets and dedicated web integration build boundary](../units/vscode-web-extensions.md)

## Cross-module contract

[Remote Node compatibility](../threads/remote-node-compatibility.md) owns the transport boundary; [Tools, permissions, and exec](../threads/tools-permissions-and-exec.md) owns Main-side authorization and dispatch.
