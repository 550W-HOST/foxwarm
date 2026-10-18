# Unit: Node data usage

Files: packages/shared/src/dataUsage.ts, packages/shared/src/dataUsageScanner.ts, src/storage/dataUsage.ts, src/storage/dataUsage.test.ts, packages/cli-node/src/dataUsageService.test.ts
Secondary files: packages/cli-node/src/client.ts, src/channels/webuiChannel.ts

## Purpose and symbols

Canonical contract: [Node data usage](../threads/node-data-usage.md).

- `DataUsageReport`, `DataUsageState`, `parseDataUsageState`: bounded, closed projection with category/workspace reconciliation.
- `scanDataUsage`: metadata-only asynchronous walk of configured state/Agents roots; root/ inode deduplication, no followed symlinks, bounded entries/time, explicit partial scans, bounded workspace/child output.
- `DataUsageSampler.read`: one background scan, cached replies and refresh throttle. Failures retain the last sample.
- `readNodeDataUsage`: local sampler or optional remote fixed-operation service, correlated connection ownership and retained offline sample. No model tool execution.
- `registerDataUsageRoutes`: administrator-only `/api/nodes/:nodeId/data-usage`; no filesystem path input and no-store responses.

The CLI advertises `foxwarm-data:1` only where this implementation exists, initializes roots from the same credential-state and node-tool path helpers used by its runtime, and accepts only `read` with optional boolean `refresh`. Other Node types and old clients remain unsupported. No retention/deletion operation is added. Scan caching is process-local; this metric does not add another persisted authority store.

## Verification

`dataUsage.test.ts` checks category reconciliation, workspace/hard-link accounting, symlink exclusion, partial bounds, cache coalescing and administrator-only route registration. Tests require an isolated temporary `FOXWARM_DATA_DIR`.
