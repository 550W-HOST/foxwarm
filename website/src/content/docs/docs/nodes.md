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

- The standard CLI client runs directly on Linux, macOS, or Windows.
- The interactive client adds a local approval interface for tool calls.
- The Docker bootstrap runs a paired client in a container.
- The Browser Node extension provides supported browser operations.

Tools differ between clients. If a Node is marked **upgrade required**, update it from the current master's bootstrap or source bundle before using it. Existing approved credentials can normally be retained.

See the repository's [Node client guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/node-client.md) for bootstrap flags, service installation, and client troubleshooting.

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

The first-party `docker-worktree` provider creates a container for an **existing Git worktree**. It supplies file and shell tools, preserves the worktree when the Node is destroyed, and defaults to no network access. It does not create or commit the Git worktree for you.

This is different from the Docker bootstrap above: a bootstrap starts a client that pairs with Foxwarm, while the worktree provider manages a container from the master. Follow the [Docker-worktree setup guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/docker-worktree-node-provider.md) for the helper image, allowed roots, and lifecycle calls. The bundled `isolated-worker` Skill can guide a temporary worker setup after the provider is configured.

Custom executable providers have a separate [provider protocol](https://github.com/550W-HOST/foxwarm/blob/main/docs/executable-node-provider-protocol.md). Their capabilities depend on the adapter; do not assume every provider supplies browser tools, terminals, or lifecycle operations.

## Access and trust

Node authentication identifies a client. Tool rules decide which callers may use it. Neither replaces the host's file permissions or network controls.

Grant shell access only to environments suitable for the task. Docker-worktree restrictions help prevent accidental interference, but they are not a guarantee against deliberately malicious commands.

External MCP clients have a narrower Node surface than internal Sessions. See [MCP execution environments](/docs/mcp-inbound/#supported-execution-environments) before configuring external access.
