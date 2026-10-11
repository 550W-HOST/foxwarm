# Unit: src-file-delivery

Files: src/fileDeliveryService.ts, src/fileDelivery.ts
Secondary files: src/toolsSessionAgent/interSession.ts, src/sessionWorker.ts, src/sessionWorkerSupervisor.ts, src/sessionWorkerRuntimeTestChild.ts, src/fileDeliveryService.test.ts, src/fileDeliveryExternalPlacement.test.ts

## Purpose

Provides the fixed versioned Main-owned file-delivery boundary used by a trusted local Session worker. The Worker sends bounded intent and routing metadata only; Main retains authoritative file preparation, permission, channel/session delivery, WebUI fallback, and remote-node cache behavior.

## Key exports

- `fileDeliveryServiceDescriptor` — fixed `file-delivery@1` descriptor with one operation-specific `deliver` method.
- `createFileDeliveryServiceHandler()` — exact-source-fenced Main handler that reconstructs source agent/isolation identity and calls the shared existing delivery implementation.
- `initializeFileDelivery()` / `deliverFile()` / `shutdownFileDelivery()` — local or borrowed-reverse facade lifecycle; missing reverse service maps to retryable `FILE_DELIVERY_UNAVAILABLE` without local fallback.

## Boundary

Requests contain only bounded source ID, normalized file/target/caption intent, and `{runtimeNodeId,currentNode,cwd}` routing snapshot. They contain no file bytes, base64, callbacks, Session objects, channel objects, or delivery result arrays. Main verifies source identity before lookup/effect, derives agent/isolation identity from its authoritative source, validates non-master targets through the Node boundary, and then reuses `executeSendFileMain` for the single synchronous delivery attempt.

Responses contain only bounded `{output,fullPath}`. Session/channel result arrays and all business/dependency errors, including RpcErrors with details, are converted inside Main to detail-free bounded `FILE_DELIVERY_FAILED`; request/source/routing and handler-response validation errors retain their stable boundary codes. WebUI retains its download-path fallback, remote source files retain the Main-owned download cache, caption remains preferred over the `text` alias, and session/channel targets remain mutually exclusive. There is no retry ledger or outbox.

The facade borrows the Session worker's one reverse transport and never owns its drain. Partial initialization and shutdown fence/clear this client alongside the other borrowed facades before the shared transport drains once.

## Tests

Coverage includes exact-source fencing before lookup, master-cwd and remote-node preparation, session/channel/WebUI target behavior, caption aliasing, bounded cloned errors, missing-service no-fallback behavior, direct/unified/ToolScript Worker parity, and real forked Worker delivery.

## Design Decisions

Cross-process placement and the trusted-local Session-worker boundary are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#d-process-topology-trusted-session-worker-boundary).
