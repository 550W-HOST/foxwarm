# Unit: shared-node-protocol

Files: packages/shared/src/nodeProtocol.ts, packages/shared/src/nodeProtocol.test.ts

## Purpose

Defines the pure cross-package core Node-protocol compatibility contract used by Master and the CLI Node before any executable capability is admitted.

## Key exports

- `NodeProtocolRange` and `NodeProtocolCompatibility` — bounded transport-generation and negotiation-result DTOs.
- `LEGACY_NODE_PROTOCOL_RANGE` — generation 1, assigned only when old peers omit protocol metadata.
- `CURRENT_NODE_PROTOCOL_RANGE` — the range implemented by the current Master and CLI Node.
- `normalizeNodeProtocolRange()` — strict plain-data and integer-bound validation.
- `resolveAdvertisedNodeProtocol()` — explicit legacy classification for an absent offer.
- `negotiateNodeProtocol()` — newest-version intersection or `upgrade-required` result.
- `describeNodeProtocolCompatibility()` — bounded operator-facing diagnosis.

## Behavior

Malformed ranges reject; omitted ranges become legacy generation 1; disjoint ranges never silently select a fallback. Negotiation returns data rather than performing transport effects so registration, persistence, provider routing, CLI validation, WebUI status, and tests consume one implementation.

The protocol covers the coupled WebSocket execution contract, including request/result envelopes, execution IDs, session events, file transfer, and backend-service framing. It is separate from per-tool schemas and individual backend-service version numbers.

## Canonical ownership

Quarantine and fail-closed behavior are canonical in [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility).