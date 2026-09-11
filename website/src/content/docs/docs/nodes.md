---
title: Nodes
description: Add an authenticated execution environment to a Foxwarm instance for tools and fixed services.
---

A **Node** is an execution environment that provides tools or fixed services to Foxwarm. Every installation has the local `master` Node; other Nodes are optional.

Add a Node when tools need to run on another machine, in a dedicated environment, or through a browser or interactive client. Session history and Agent memory remain with the Foxwarm instance.

## Pair a Node

From a running Foxwarm Session, ask for pairing help:

```text
/node pair-help
```

Foxwarm returns bootstrap commands based on the address used to reach the instance. Run one on the target environment, then approve the pending identity:

```text
/node list
/node approve <pending-id> <node-id>
```

The remote machine must be able to reach the Foxwarm master URL in the bootstrap. If the Node should connect through a different address, use the bootstrap's host override.

## Choose a Node client

- A bare-metal Node runs the official client directly on Linux, macOS, or Windows.
- An interactive CLI Node asks for local confirmation before tool calls.
- The Docker bootstrap creates a containerized Node from the current master's source bundle.
- A Browser Node provides supported browser operations through the extension.

Capabilities vary by Node. Foxwarm marks a connected Node **upgrade required** when its core protocol is incompatible. Update it from the current master's bootstrap or source bundle before using its tools.

## Choose a Node for a Session

Use `/node` to inspect or select execution Nodes. Tools that use the current Node will then run there. Some actions accept an explicit Node and do not use the Session default.

:::note
Node authentication establishes identity. It does not turn every Node into a security sandbox, so configure the environment for the trust level of its work.
:::

See the repository [Node client quick start](https://github.com/550W-HOST/foxwarm/blob/main/docs/node-client.md) for bootstrap flags, detached operation, systemd setup, Docker, optional terminal dependencies, and troubleshooting.
