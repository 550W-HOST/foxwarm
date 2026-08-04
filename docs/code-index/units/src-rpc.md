# Unit: src-rpc

Files: src/rpc/types.ts, src/rpc/registry.ts, src/rpc/client.ts, src/rpc/localTransport.ts, src/rpc/processClientTransport.ts, src/rpc/processServer.ts, src/rpc/index.ts
Secondary files: src/rpc/rpcContract.test.ts, src/rpc/rpcTestService.ts, src/rpc/rpcTestChild.ts

## Purpose

Provides the minimal typed asynchronous service boundary shared by in-process handlers and supervised child processes. It keeps placement out of business APIs while enforcing structured-clone DTO ownership, protocol/service versions, process generations, cancellation/deadlines, bounded requests/events, structured errors, readiness, and graceful drain.

## Key exports

- `defineRpcService`, `rpcMethod`, and `rpcEvent` — typed runtime service descriptors.
- `RpcServiceRegistry` — exact service/version registration and handler dispatch.
- `RpcClient` / `RpcTransport` — placement-neutral typed callers.
- `LocalRpcTransport` — asynchronous structured-clone local dispatch with bounded requests/events and process-equivalent error DTOs.
- `ProcessRpcClientTransport` / `ProcessRpcServer` — versioned parent/child IPC, readiness, cancellation, event acknowledgements, generation filtering, and drain.
- `RpcError` — transport-safe code/message/retryability/details envelope.

## Behavior

- Local calls clone both request and response DTOs and schedule handler invocation asynchronously. Handler failures cross the same serialized/cloned/deserialized error envelope as process calls, while a caller's own abort reason retains its identity.
- Child calls require matching protocol/build/service versions and process generation. Child exit or IPC disconnect rejects outstanding work as retryable unavailable; stale-generation messages are ignored.
- Abort and deadline signals are forwarded to handlers. Cancellation is cooperative: a handler or native dependency may finish after its caller has stopped waiting.
- Request count and unacknowledged events are bounded. Server events carry sequence and trace metadata and receive client acknowledgements.
- Drain rejects new calls, waits for accepted handlers, invokes service cleanup, then acknowledges. The process supervisor remains responsible for the final process exit/kill policy.
- Parent IPC disconnect aborts active child requests, stops acceptance, runs service cleanup within a bound, and exits even if cleanup does not settle.
- Large application payloads do not gain a special inline wire shape; services use bounded DTOs and file/blob/snapshot references.

## Tests

One transport contract suite runs against local and real forked-child placements. It covers clone isolation, handler-owned error isolation and ordinary-error parity, invalid-DTO capacity safety, request backpressure, events, caller-owned cancellation, readiness, drain, and bounded exit after parent disconnect.

## Canonical ownership

Cross-module placement and parity are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).