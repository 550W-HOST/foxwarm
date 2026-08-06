# Unit: src-rpc

Files: src/rpc/types.ts, src/rpc/registry.ts, src/rpc/client.ts, src/rpc/localTransport.ts, src/rpc/processClientTransport.ts, src/rpc/processServer.ts, src/rpc/index.ts
Secondary files: src/rpc/rpcContract.test.ts, src/rpc/rpcReverseContract.test.ts, src/rpc/rpcTestService.ts, src/rpc/rpcTestChild.ts, src/rpc/rpcReverseTestChild.ts

## Purpose

Provides the minimal typed asynchronous service boundary shared by in-process handlers and supervised child processes. It keeps placement out of business APIs while enforcing structured-clone DTO ownership, protocol/service versions, process generations, cancellation/deadlines, bounded requests/events, structured errors, readiness, and graceful drain.

## Key exports

- `defineRpcService`, `rpcMethod`, and `rpcEvent` — typed runtime service descriptors.
- `RpcServiceRegistry` — exact service/version registration and handler dispatch.
- `RpcClient` / `RpcTransport` — placement-neutral typed callers.
- `LocalRpcTransport` — asynchronous structured-clone local dispatch with bounded requests/events and process-equivalent error DTOs.
- `ProcessRpcClientTransport` / `ProcessRpcServer` — versioned bidirectional parent/child IPC with distinct forward/reverse wire kinds, readiness, cancellation, generation filtering, and drain. Forward mode retains events; reverse v1 rejects subscriptions/events explicitly.
- `RpcError` — transport-safe code/message/retryability/details envelope.

## Behavior

- Local calls clone both request and response DTOs and schedule handler invocation asynchronously. Handler failures cross the same serialized/cloned/deserialized error envelope as process calls, while a caller's own abort reason retains its identity.
- Process calls in either direction require matching protocol/build/service versions and generation. Child exit or IPC disconnect rejects outstanding work as retryable unavailable; stale-generation messages are ignored. Reverse readiness uses bounded repeated child init announcements until ready/terminal/close/timeout, so either listener may start first without leaving a retry timer behind.
- Abort and deadline signals are forwarded to handlers. Cancellation is cooperative: a handler or native dependency may finish after its caller has stopped waiting.
- Request count and unacknowledged events are bounded. Server events carry sequence and trace metadata and receive client acknowledgements.
- Drain rejects new calls, waits for accepted handlers, invokes service cleanup, then acknowledges. A parent-owned reverse server also exposes local drain/close so the supervisor can stop child-run acceptance, let nested reverse calls finish, and then close the reverse side before process termination.
- Parent IPC disconnect aborts active child requests, stops acceptance, runs service cleanup within a bound, and exits even if cleanup does not settle.
- Large application payloads do not gain a special inline wire shape; services use bounded DTOs and file/blob/snapshot references.

## Tests

Transport contract suites cover local, forward real-child, and reverse real-child placements: clone/error isolation, protocol/generation/service checks, invalid-DTO capacity safety, request backpressure, supported/unsupported events, cancellation/deadlines, accepted-call drain, disconnect/exit rejection, and bounded cleanup.

## Canonical ownership

Cross-module placement and parity are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).