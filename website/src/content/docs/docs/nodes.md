---
title: Nodes
description: Choose where tools run, pair a remote client, or use a configured Node provider.
---

A Node is an execution environment for tools. Every installation has the local `master` Node. Add another Node when a task needs files or programs on another machine, a browser extension, or a dedicated worktree environment.

Selecting a Node changes where tools execute. It does not move the Session's conversation history or the Agent's memory to that Node.

## Pair a client on another machine

From a Foxwarm Session, request bootstrap instructions:

```text
/node pair-help
```

Run the appropriate bootstrap on the target machine. Use a master URL that the target can actually reach; its `localhost` is usually not the Foxwarm server. Keep the pairing token private.

Back in Foxwarm, inspect the pending request and approve the Node you intended to add:

```text
/node list
/node approve <pending-id> worker-one
```

The approved Node receives its own credentials for subsequent connections. Save any credentials shown by the pairing flow securely.

### Client choices

- The standard CLI client runs directly on Linux, macOS, or Windows. Linux x64 onboarding downloads the standalone native client; it needs no Node.js or .NET runtime. Other platforms keep the Node.js client.
- The interactive client adds a local approval interface for tool calls.
- The Docker bootstrap selects the native client for Linux x64 containers and the Node.js client for other supported container architectures. Credentials and Agent files persist through data mounts.
- The Browser Node extension provides supported browser operations.

When replacing a Docker Node created with an older template, copy its `/app/agents` contents into the host data directory's `agents` subdirectory before removing the old container. The new template mounts that directory at the same in-container path.

Tools differ between clients. If a Node is marked **upgrade required**, update it from the current master's bootstrap or source bundle before using it. Existing approved credentials can normally be retained.

See the repository's [Node client guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/node-client.md) for bootstrap flags, service installation, and client troubleshooting.

## Share your existing browser

Open **Nodes → New nodes → Browser**, download the extension ZIP and extract it. In Chrome or Chromium, open `chrome://extensions`, enable Developer mode and use **Load unpacked** to select the extracted folder. The setup page provides your Main address and private pairing token; enter them in the extension, Connect, then approve its request in Foxwarm.

Use the extension popup to share a tab or an entire window with **Ask** or **Auto**. New installations share nothing. A shared window includes current, new and moved-in HTTP(S) tabs; an explicit tab **Off** excludes it. **Clear** restores inheritance. Tab/window sharing lasts for the browser session; remembered site rules persist.

Page operations show Chrome's debugging banner. Pressing **Cancel** or the extension's **Stop** stops Browser Node until you deliberately Connect again. Debugger permission is broad and the extension enforces sharing; Chrome does not isolate this permission by window. Avoid editing the same tab at the same time as an Agent. The first distribution supports unpacked Chrome/Chromium, not Firefox or a browser store.

Browser tools have short Node-local names such as `list_tabs`, `get_tab_content`, `fill` and `screenshot`. They control your shared logged-in tabs. The separate `browse_*` tools use a process-owned browser. You can leave a development Node selected and explicitly target Browser Node through tool discovery and `call_tool`.

## Select the execution Node

To select an approved or provider-created Node for the current Session:

```text
/node worker-one
```

To return to local execution:

```text
/node master
```

Tools that use the Session's current Node will execute there. A tool with an explicit Node argument can target a different permitted Node. An isolated Agent remains bound to its isolation Node; changing a Session selection does not remove that restriction.

`/node list` shows the local Node, approved clients, and pending pairings. Provider-created Nodes use the model-facing `node` tool for discovery and lifecycle operations; they are not pending clients to approve.

## Provider-created Nodes

A Node provider is configured in `state/config.yaml` under `nodeProviders`. Restart Foxwarm after changing provider configuration.

Executable providers use the [provider protocol](https://github.com/550W-HOST/foxwarm/blob/main/docs/executable-node-provider-protocol.md). Their capabilities depend on the adapter; do not assume every provider supplies browser tools, terminals, or lifecycle operations.

## Access and trust

Node authentication identifies a client. Tool rules decide which callers may use it. Neither replaces the host's file permissions or network controls.

Grant shell access only to environments suitable for the task.

External MCP clients have a narrower Node surface than internal Sessions. See [MCP execution environments](/docs/mcp-inbound/#supported-execution-environments) before configuring external access.
