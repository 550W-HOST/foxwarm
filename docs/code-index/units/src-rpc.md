# Unit: src-rpc

Files: src/rpc/types.ts, src/rpc/registry.ts, src/rpc/client.ts, src/rpc/localTransport.ts, src/rpc/processClientTransport.ts, src/rpc/processServer.ts, src/rpc/index.ts
Secondary files: src/rpc/rpcContract.test.ts, src/rpc/rpcTestService.ts, src/rpc/rpcTestChild.ts

## Purpose

Provides the minimal typed asynchronous service boundary shared by in-process handlers and supervised child processes. It keeps placement out of business APIs while enforcing structured-clone DTO ownership, protocol/service versions, process generations, cancellation/deadlines, bounded requests/events, structured errors, readiness, and graceful drain.

## Key exports

- `defineRpcService`, `rpcMethod`, and `rpcEvent` — typed runtime service descriptors.
- `RpcServiceRegistry` — exact service/version registration and handler dispatch.
- `RpcClient` / `RpcTransport` — placement-neutral typed callers.
- `LocalRpcTransport` — asynchronous structured-clone local dispatch with bounded events.
- `ProcessRpcClientTransport` / `ProcessRpcServer` — versioned parent/child IPC, readiness, cancellation, event acknowledgements, generation filtering, and drain.
- `RpcError` — transport-safe code/message/retryability/details envelope.

## Behavior

- Local calls clone both request and response DTOs and schedule handler invocation asynchronously. Callers cannot observe or mutate handler-owned references.
- Child calls require matching protocol/build/service versions and process generation. Child exit rejects outstanding work as retryable unavailable; stale-generation messages are ignored.
- Abort and deadline signals are forwarded to handlers. Cancellation is cooperative: a handler or native dependency may finish after its caller has stopped waiting.
- Request count and unacknowledged events are bounded. Server events carry sequence and trace metadata and receive client acknowledgements.
- Drain rejects new calls, waits for accepted handlers, invokes service cleanup, then acknowledges. The process supervisor remains responsible for the final process exit/kill policy.
- Large application payloads do not gain a special inline wire shape; services use bounded DTOs and file/blob/snapshot references.

## Tests

One transport contract suite runs against local and real forked-child placements. It covers clone isolation, invalid DTO rejection, structured handler errors, events, cancellation, readiness, and drain.

## Canonical ownership

Cross-module placement and parity are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).