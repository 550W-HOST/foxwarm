# Unit: src-nodes-registry

Files: src/nodes/registry.ts, src/nodes/registry.test.ts

## Purpose

Manages a persistent registry of approved nodes and pending pairing requests. Handles the full pairing lifecycle (create, approve, reject, claim, expire) with token-based authentication, WebSocket notifications to waiting clients, and disk-backed storage with backup/recovery.

## Key Exports

- `NodeToolDefinition`, `NodeCapabilitiesSnapshot`, `ApprovedNodeRecord`, `PendingPairingRecord` — core type definitions
- `PENDING_PAIRING_TTL_MS` — expiry constant (1 hour)
- `createNodeRegistryStore(filePath?)` — factory for the disk-backed store
- `initializeNodeRegistry()` — loads registry and cleans expired pairings
- `createPendingPairing(input)` — creates a new pairing request with a 6-digit code
- `approvePendingPairing(pendingId, requestedNodeId?)` — approves a pairing, generates auth token, notifies via WebSocket
- `rejectPendingPairing(pendingId, reason?)` — rejects and notifies client
- `claimApprovedPairing(pendingId)` — retrieves credentials for offline-approved pairings
- `listPendingPairings()` — returns pending pairings with connection status
- `listApprovedNodes()` — returns all approved nodes sorted by ID
- `removeApprovedNode(nodeId)` — deletes an approved node record and any unclaimed approved pending claim for that node
- `moveApprovedNode(oldNodeId, newNodeId)` — renames an approved node record while preserving auth hash/capabilities/metadata
- `cleanupExpiredPendingPairings(now?)` — removes stale pairings and their associated nodes
- `authenticateApprovedNode(nodeId, authToken)` — validates a node's auth token
- `attachPendingPairingSocket(pendingId, ws)` / `detachPendingPairingSocket(pendingId)` — WebSocket lifecycle
- `isReservedNodeId(nodeId)` — checks reserved IDs
- `setNodeRegistryStoreForTests(store)` / `resetNodeRegistryForTests()` — test helpers

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `normalizeRegistryData(raw, filePath)` | ~68 | Validates and normalizes raw JSON into registry shape |
| `createNodeRegistryStore(filePath)` | ~76 | Creates a DiskJsonData instance with backup/error config |
| `cloneDefaultRegistry()` | ~95 | Returns empty registry data object |
| `loadRegistry()` | ~101 | Lazy-loads registry from disk with fallback recovery |
| `saveRegistry()` | ~116 | Persists current registry state to disk |
| `setNodeRegistryStoreForTests(store)` | ~121 | Replaces registry store for testing |
| `resetNodeRegistryForTests()` | ~126 | Clears in-memory state and sockets |
| `hashToken(token)` | ~131 | SHA-256 hashes an auth token |
| `randomToken(bytes)` | ~135 | Generates a random hex token |
| `sanitizeNodeId(value)` | ~139 | Normalizes a string into a valid node ID slug |
| `generatePairCode()` | ~150 | Produces a random 6-digit pairing code |
| `assertNodeIdAllowed(nodeId)` | ~154 | Throws if node ID is invalid or reserved |
| `normalizeExplicitNodeId(value)` | ~161 | Trims and validates an existing explicit node id. |
| `normalizeNewNodeId(value)` | ~167 | Requires a new node id to already be in sanitized slug form and not reserved. |
| `allocateUniqueNodeId(base)` | ~180 | Finds a unique node ID, appending suffix if needed |
| `initializeNodeRegistry()` | ~198 | Loads registry and runs cleanup |
| `isReservedNodeId(nodeId)` | ~203 | Checks membership in reserved set case-insensitively |
| `createPendingPairing(input)` | ~207 | Creates and persists a pending pairing record |
| `attachPendingPairingSocket(pendingId, ws)` | ~229 | Stores WebSocket for a pending pairing |
| `detachPendingPairingSocket(pendingId)` | ~233 | Removes stored WebSocket |
| `listPendingPairings()` | ~237 | Returns sorted pending pairings with connected flag |
| `listApprovedNodes()` | ~245 | Returns sorted approved node records |
| `removeApprovedNode(nodeId)` | ~251 | Removes an approved node and any unclaimed approved-pending credential handoff for it. |
| `moveApprovedNode(oldNodeId, newNodeId)` | ~271 | Renames an approved node, preserving token hash and metadata; rejects missing, reserved, invalid, same-id, and approved conflicts. |
| `getPendingPairingExpiryTimestamp(record)` | ~312 | Determines which timestamp to use for expiry |
| `isPendingPairingExpired(record, now)` | ~316 | Checks if a pairing has exceeded TTL |
| `cleanupExpiredPendingPairings(now)` | ~321 | Removes expired pairings, closes sockets, deletes orphan nodes |
| `authenticateApprovedNode(nodeId, authToken)` | ~355 | Validates token hash and updates lastSeenAt |
| `approvePendingPairing(pendingId, requestedNodeId?)` | ~381 | Full approval flow: allocate ID, store node, notify or stash |
| `claimApprovedPairing(pendingId)` | ~453 | Returns stored credentials for offline approvals |
| `rejectPendingPairing(pendingId, reason?)` | ~470 | Deletes pairing and notifies client via WebSocket |

## Dependencies

- `../config` — `NODES_FILE` (default registry file path)
- `../common` — `logger` (structured logging)
- `../utils/diskJsonData` — `DiskJsonData` (persistent JSON storage with backup rotation and fallback loading)

## Behavior

- Registry state is lazily loaded into memory on first access and written through to disk on every mutation.
- If the primary file is corrupted, the store recovers from rotated backups and rewrites the primary.
- Pending pairings expire after 1 hour (TTL checked on most public operations). Expired pairings that were approved but never claimed also remove their associated approved node record.
- Auth tokens are stored as SHA-256 hashes; plaintext tokens are only held temporarily in pending records for offline claim scenarios.
- WebSocket references are held in an in-memory map to deliver real-time approval/rejection notifications to waiting node clients.
- Node IDs are sanitized, deduplicated with numeric suffixes, and validated against a reserved set.
- Administrative removal deletes the approved credential record and also clears matching unclaimed approved-pending entries so an offline-approved node cannot later claim removed credentials.
- Administrative rename preserves the approved record's token hash/capabilities/metadata under the new id and updates matching unclaimed approved-pending entries; it does not update already-written node-side credentials.
- Capability snapshots persist optional versioned backend `services` alongside model tool definitions so reconnect/list metadata reflects Code FS/Git support.

## Integration

- Used by WebSocket handlers that manage the node pairing handshake (attach/detach socket, claim approved pairing on reconnect).
- Used by API/CLI endpoints for listing, approving/rejecting pairings, and removing/renaming approved nodes.
- `authenticateApprovedNode` is called on every authenticated node connection to verify credentials.
- Relies on `DiskJsonData` for atomic writes and backup rotation, sharing that utility pattern with other persistent stores in the project.