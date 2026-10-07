# Unit: CLI Node client, proxy, TUI, and PTY service

Files: `packages/cli-node/src/client.ts`, `packages/cli-node/src/masterProxy.ts`, `packages/cli-node/src/nodePtyService.ts`, `packages/cli-node/src/processTitle.ts`, `packages/cli-node/src/tui.ts`, `packages/cli-node/src/masterProxy.test.ts`, `packages/cli-node/src/nodeProtocolCompatibility.test.ts`, `packages/cli-node/src/nodePtyService.test.ts`, `packages/cli-node/src/processTitle.test.ts`, `packages/cli-node/src/sessionEventAck.test.ts`

## Purpose

Runs an authenticated remote/operator Node client, Main proxy transport, optional TUI, PTY service, process-title lifecycle, and Session-event acknowledgement handling.

## Stable symbols and callers

`NodeClient.connect`, `disconnect`, `startLocalTriggerServer`, `sendSessionEvent`, `listBoundSessions`, `getSessionHistory`, and `sendSessionMessage` own the client API; `masterProxy` adapts authenticated remote calls; `NodePtyService`/`loadNodePtyService` own optional target PTY; `tui.ts` owns operator auto-approval/interception.

## Behavior and external contracts

Pairing sends `pair_request`, persists approved credentials, then reconnects authenticated before `node_register`. Heartbeat sends ping every 30 seconds, expects pong within 10 seconds, and reconnects after 5 seconds. Explicit negotiated protocol compatibility is checked before persistent-exec recovery; absent response retains legacy generation behavior, while incompatible targets stay visible for diagnosis but cannot dispatch.

Session events carry an explicit acknowledgement boundary: accepted/rejected/disconnected/missing-ACK outcomes determine whether the sender removes or retains a completion-notification record. Background persistent-exec tracking is retained/retried until the shared 24-hour tracking-only expiry; expiry does not kill processes or delete artifacts.

The client is a remote execution environment, not Session authority. File transfer uses shared helpers; PTY availability is optional and does not remove file/model/session capabilities. PTY terminal `code` access uses capability-bound local helper IPC. External-owner tool calls remain separate from Session/Agent fields and are rejected before effect when malformed or mixed.

## Tests

`packages/cli-node/src/nodeProtocolCompatibility.test.ts`; `sessionEventAck.test.ts`; `nodePtyService.test.ts`; `masterProxy.test.ts`; `processTitle.test.ts`.
