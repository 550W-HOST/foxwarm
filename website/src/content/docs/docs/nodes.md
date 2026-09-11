---
title: Optional Nodes
description: Add an authenticated execution environment to a Foxwarm instance when local master tools are not enough.
---

A **Node** is an execution environment that exposes tools or fixed services to Foxwarm. The built-in `master` Node is the default local environment. Additional Nodes are optional.

Use a Node when work must happen on another machine, inside a dedicated environment, or through a browser/interactive client. A Node does not become the authority for Session history or Agent memory.

## Pair a Node

From a running Foxwarm Session, ask for pairing help:

```text
/node pair-help
```

The response contains bootstrap commands based on the address used to reach your Foxwarm instance. Run the chosen bootstrap on the target environment, then approve the pending identity from Foxwarm:

```text
/node list
/node approve <pending-id> <node-id>
```

The remote machine must be able to reach the Foxwarm master URL used by the bootstrap. If you downloaded through one address but the Node should connect through another, provide the bootstrap's explicit host override.

## Choose the right Node style

- **Bare-metal Node:** runs the official Node client directly on Linux, macOS, or Windows.
- **Interactive CLI Node:** asks for local confirmation before tool calls, useful when a person is supervising the environment.
- **Docker bootstrap:** creates a containerized Node from the current master's source bundle.
- **Browser Node:** exposes supported browser operations through the browser extension path.

Capabilities vary by Node. A connected identity can still be marked **upgrade required** when its core protocol is incompatible; update it from the current master's bootstrap/source bundle before using it for tools.

## Switch a Session's current Node

Use `/node` to inspect or select execution Nodes. Tools that resolve against the current Node then run there. Some actions explicitly target a Node instead of using the Session default.

:::note
Authentication establishes Node identity; it is not a claim that every Node is a security sandbox. Choose and configure each environment according to the trust level of the work it will receive.
:::

See the repository [Node client quick start](https://github.com/550W-HOST/foxwarm/blob/main/docs/node-client.md) for bootstrap flags, detached operation, systemd setup, Docker, optional terminal dependencies, and troubleshooting.
