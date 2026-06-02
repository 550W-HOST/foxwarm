# Refactor Questions & Findings

## Dead / Unused Exports — RESOLVED

All confirmed dead exports below have been removed in commits `41cf9359` through `b281ef34`:

- sessionManager: `shouldProcessQueuedItemForWait`, `removeAliasCacheEntry`, `*AllGroupMembers` aliases, `sendTo/sendFileToChannelById`
- session/channels: same `*AllGroupMembers` aliases and `ById` wrappers
- config: `getSkillMemoryDir`, `PERSISTENT_MEMORY_DIR`
- session/history: `buildDroppedRangePlaceholder`, `buildArchiveLookupInstruction`
- session/compactPlan: `describeCreatedRanges`
- session/archiveStore: `setVectorCheckpoint` (async), `getVectorSearchLineageSync`
- session/agentMetadata: `refreshDirectAgentSessions`
- llm: `appendTerminalModelTextAndReturn`, `getPersistentMemory`
- nodes/registry: `DEFAULT_REGISTRY`
- session/layeredContext: `copyLayeredContextFiles`, `moveLayeredContextFiles`, `readArchiveBlocks`
- session/metadataStore: `getSessionsMetadataBackupPath`, `getSessionsMetadataCandidatePaths`, `readSessionsMetadataSnapshotFromFile`

## Questions — RESOLVED

1. **Legacy migration code** — REMOVED (`a2be403a`): env→yaml migration, legacy vector checkpoints, legacy WebUI settings path, legacy log dir cleanup. Also removed `dotenv` dependency.

2. **`getPersistentMemory`** — REMOVED (`4f618784`): was vestigial; tests updated to mock `buildSessionSystemPromptSnapshot` directly.

3. **`maybeCompressLlmRequestBody`** — WIRED UP (`76f5894c`): now applied before LLM API requests when `requestCompression` is configured on the model entry.

4. **`src/selftest/toolLoopStallSelfTest.ts`** — KEPT: actively maintained (last modified 2026-05-21), tests critical integration behavior (tool loop, compact, wait, child sessions). Invoked via `npm run selftest:tool-loop-stall`.

## Potential Simplification Targets (no action taken yet)

- `src/session/history.ts` (1396 lines): Could split compaction logic from archive query logic
- `src/vector.ts` (~1550 lines): Could split embedding/indexing from search/query
- `src/channels/webuiChannel.ts` (~1960 lines): Large but it's a single HTTP server with many routes; splitting routes into sub-files is possible
- `packages/webui/src/App.tsx` (1661 lines): Single component with 52 hooks and 19 useEffects. Could extract custom hooks (useSSEConnection, useThemeManagement, useWorkbenchTabs) but risky without good test coverage
- **~90 `as any` casts** across src/ (excluding tests): would benefit from stricter typing but requires enabling `strict: true` first

## Deduplication Done

- `expandHomePath` / `resolveAgentPath`: consolidated from 6 copies into `src/utils/pathResolve.ts`
- `buildChildrenMap`: extracted from 2 inline copies in webuiChannel.ts
- Unused imports cleaned across ~30 files (noUnusedLocals warnings: 62 → 7)

## Pre-existing Test Failures (not caused by refactoring)

- `lib/execToolMessages.test.js`: "read tool truncated output is wrapped with opening and closing notices" — test expects `[TOO LONG ...]` prefix but gets raw content
- `lib/tokenCountImages.test.js`: "/status shows image count instead of inflating image payload into size" — test assertion mismatch
