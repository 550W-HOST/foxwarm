# Unit: src-nodes-external-exec-ownership

Files: `src/nodes/externalExecOwnership.ts`
Secondary files: `src/nodes/sessionEventCapability.ts`, `src/nodes/manager.ts`, `src/mcpInboundNodeService.ts`, `src/mcpInboundNodeOwnership.test.ts`, `packages/cli-node/src/client.ts`, `packages/shared/src/persistentExec.ts`

## Purpose

Holds Main-process-only authority for real CLI Node persistent commands started by a verified external identity in one generated inbound context. Records are not Foxwarm Session receipts or recoverable persisted owner state.

## Key functions

- `reserveExternalExec` allocates a canonical real petname ID and a separate signed completion capability before effect. The signature binds the authenticated Node ID, external identity, context UUID and exact exec ID. At most 20 records and 64 KiB of original arguments per record are retained for later policy checks. Once full, a new reservation evicts the oldest completed record; 20 unresolved records deny a new effect rather than discarding live ownership.
- `registerExternalExecBackground` and `completeExternalExec` require the authenticated Node source, original owner, exact ID and matching signed capability. Completion output is bounded to 256 KiB; a trusted final cwd may update the selected context through a generation-checked callback. Repeated identical completion receipts are idempotent.
- `getExternalExec`/`listExternalExec` return only that context's records. `markExternalExecUnknown` retains uncertainty after an unconfirmed result; `finishExternalExecForeground` releases only definite pre-effect failures. `releaseExternalExecContext` removes authority on transport disposal without killing a process.

## Boundaries

The Node's own manager captures logs/status and returns partial or final output through authenticated WebSocket requests; Main does not read Node artifact files. Losing Main's map makes old results unavailable even if the Node retained its files. Rule revocation is applied by the caller on each result query. The canonical cross-module contract is [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility).
