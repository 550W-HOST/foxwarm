# Unit: src-file-delivery

Files: src/fileDeliveryService.ts, src/fileDelivery.ts, src/imageWriteHandoff.ts
Secondary files: src/toolsSessionAgent/interSession.ts, src/sessionWorker.ts, src/sessionWorkerSupervisor.ts, src/sessionWorkerRuntimeTestChild.ts, src/fileDeliveryService.test.ts, src/fileDeliveryExternalPlacement.test.ts, src/tools/imageTools.ts, src/tools/imageTools.test.ts, src/nodes/providerTransfer.test.ts

## Purpose

Provides the fixed versioned Main-owned file-delivery boundary used by a trusted local Session worker. The Worker sends bounded intent and routing metadata only; Main retains authoritative file preparation, permission, channel/session delivery, WebUI fallback, and remote-node cache behavior.

## Key exports

- `fileDeliveryServiceDescriptor` — fixed `file-delivery@2` descriptor with operation-specific `deliver` and `writeImageArtifact` methods.
- `createFileDeliveryServiceHandler()` — exact-source-fenced Main handler that reconstructs source agent/isolation identity and calls the shared existing delivery implementation.
- `getImageWriteHandoffRoot()` / `requireImageWriteHandoffRoot()` / `readOwnedImageWriteHandoff()` — exact-Session private path and regular-file/symlink containment.
- `initializeFileDelivery()` / `deliverFile()` / `writeImageArtifact()` / `shutdownFileDelivery()` — local or borrowed-reverse facade lifecycle; missing reverse service maps to retryable `FILE_DELIVERY_UNAVAILABLE` without local fallback.

## Boundary

`deliver` requests contain only bounded source ID, normalized file/target/caption intent, and `{runtimeNodeId,currentNode,cwd}` routing snapshot. They contain no file bytes, base64, callbacks, Session objects, channel objects, or delivery result arrays. Main verifies source identity before lookup/effect, derives agent/isolation identity from its authoritative source, validates non-master targets through the Node boundary, and then reuses `executeSendFileMain` for the single synchronous delivery attempt.

`deliver` responses contain bounded `{output,fullPath}` plus an optional validated `fileDelivery` receipt. The additive receipt uses the shared versioned DTO, preserves original name and source/cache provenance, and must agree with `fullPath`; older responses without it remain readable. Reply presentation is canonical in [D-reply-file-deliveries](../threads/webui-attachment-presentation.md#d-reply-file-deliveries). Session/channel result arrays and all business/dependency errors, including RpcErrors with details, are converted inside Main to detail-free bounded `FILE_DELIVERY_FAILED`; request/source/routing and handler-response validation errors retain their stable boundary codes. WebUI retains its download-path fallback, remote source files retain the Main-owned download cache, including primitive Providers read through `NodeProviderRegistry.readTransferFile` rather than a WebSocket-only lookup. Relative Provider paths use their environment default, not the Worker/Session cwd; native Main/CLI defaults are unchanged. Cache preparation and file bytes stay in Main, caption remains preferred over the `text` alias, and session/channel targets remain mutually exclusive. There is no retry ledger or outbox.

The facade borrows the Session worker's one reverse transport and never owns its drain. Partial initialization and shutdown fence/clear this client alongside the other borrowed facades before the shared transport drains once.

## Owned image handoff

Worker `image_write_to_file` resolves the image in its exact hot owner, stages only those bytes in a private per-Session operation directory, and sends bounded `{sourceSessionId,artifactPath,intent,routing}`. Main fences the source before lookup, derives Agent identity from catalog metadata, authorizes `image_write_to_file` at the actual target with the separate caller-current snapshot and original optional-argument presence, then accepts only that source's regular image under a real operation directory. Encoded Session path components are bounded and unambiguous; ancestor/operation/file symlinks cannot redirect the owned scope. Main does not hydrate Worker history or image authority.

The operation uses the existing registry writer and returns only completion acknowledgement. Worker retains cleanup and combined operation/cleanup failure reporting. Missing reverse service never falls back locally. This private artifact is not a caller-selected Main copy endpoint; allowing the image write does not grant arbitrary `copy_between_nodes(master,...)` access. Main remote image writes use the same writer while retaining exact-owner image resolution and native/CLI behavior. There is no artifact catalog, token ledger, lease, retry or rollback service.

## Tests

Coverage includes exact-source fencing before lookup, master-cwd and remote-node preparation, session/channel/WebUI target behavior, caption aliasing, bounded cloned errors, missing-service no-fallback behavior, direct/unified/ToolScript Worker parity, and real forked Worker delivery.

## Design Decisions

Cross-process placement and the trusted-local Session-worker boundary are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#d-process-topology-trusted-session-worker-boundary).
