# Unit: CLI Node native runtime

Files: `packages/cli-node-runtime/`

## Purpose

Provides target-platform native dependencies/build glue for the CLI Node, including PTY/process support consumed by `packages/cli-node/src/nodePtyService.ts`.

## Stable navigation

The TypeScript client/proxy and protocol entry points are in [CLI Node](./cli-node-client.md). Native runtime packaging determines which PTY/process features can be advertised during Node capability negotiation.

## Boundary behavior

This package is a remote execution runtime, not a .NET Main service and not Session authority. Build/install failures affect Node capability availability; they do not turn a missing capability into a local Main tool permission.
