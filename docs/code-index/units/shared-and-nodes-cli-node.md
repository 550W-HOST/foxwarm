# Unit: CLI Node client, proxy, TUI, and PTY service

Files: `packages/cli-node/src/client.ts`, `packages/cli-node/src/masterProxy.ts`, `packages/cli-node/src/nodePtyService.ts`, `packages/cli-node/src/processTitle.ts`, `packages/cli-node/src/tui.ts`, `packages/cli-node/src/masterProxy.test.ts`, `packages/cli-node/src/nodeProtocolCompatibility.test.ts`, `packages/cli-node/src/nodePtyService.test.ts`, `packages/cli-node/src/processTitle.test.ts`, `packages/cli-node/src/sessionEventAck.test.ts`

## Purpose

Runs an authenticated operator/remote Node client, optional TUI, Main proxy transport, PTY service, process-title lifecycle, and session-event acknowledgement handling.

## Stable symbols and callers

`client.ts` is the CLI Node entry/client; `masterProxy.ts` adapts remote calls to the shared Node protocol; `nodePtyService.ts` owns target-platform PTY requests; `tui.ts` is the operator surface. Protocol compatibility and event ack tests are the external-boundary evidence.

## Behavior and side effects

The CLI Node is a remote execution environment, not Session authority. Authentication, node identity, capability negotiation, PTY lifetime, and event acknowledgements remain transport contracts. The .NET host index does not claim that every CLI-node route is already wired into the .NET Main.

## Tests

The paired CLI tests listed in `Files:` plus package build entry points in `packages/cli-node/package.json`.
