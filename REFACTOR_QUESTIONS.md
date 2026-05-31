# Refactor Questions & Findings

## Dead / Unused Exports — RESOLVED

All confirmed dead exports below have been removed in commits `41cf9359` through `16b44a33`:

- sessionManager: `shouldProcessQueuedItemForWait`, `removeAliasCacheEntry`, `*AllGroupMembers` aliases, `sendTo/sendFileToChannelById`
- session/channels: same `*AllGroupMembers` aliases and `ById` wrappers
- config: `getSkillMemoryDir`
- session/history: `buildDroppedRangePlaceholder`, `buildArchiveLookupInstruction`
- session/compactPlan: `describeCreatedRanges`
- session/archiveStore: `setVectorCheckpoint` (async), `getVectorSearchLineageSync`
- session/agentMetadata: `refreshDirectAgentSessions`
- llm: `appendTerminalModelTextAndReturn`
- nodes/registry: `DEFAULT_REGISTRY`

## Questions (need user input before changing)

1. **Legacy migration code**: There's substantial legacy migration code across the codebase (env→yaml config, legacy channel attachments, legacy vector checkpoints, legacy WebUI settings paths, legacy log dirs). Is any of this still needed for active deployments, or can some be removed?

2. **`getPersistentMemory` in llm.ts**: Only used in test mocks. The actual memory loading goes through `buildSessionSystemPromptSnapshot`. Is this function still needed or is it vestigial?

3. **`maybeCompressLlmRequestBody` in llm.ts**: Fully implemented but never called. Config supports `requestCompression` field. Enable it by wiring the call, or remove as dead code?

4. **`src/selftest/toolLoopStallSelfTest.ts` (825 lines)**: Is this still actively used/run, or is it a one-off diagnostic that could be moved to tests?

## Potential Simplification Targets (no action taken yet)

- `src/session/history.ts` (1406 lines): Could split compaction logic from archive query logic
- `src/vector.ts` (1621 lines): Could split embedding/indexing from search/query
- `src/channels/webuiChannel.ts` (1966 lines): Large but it's a single HTTP server with many routes; splitting routes into sub-files is possible
- `packages/webui/src/App.tsx` (1661 lines): Single component with 52 hooks and 19 useEffects. Could extract custom hooks (useSSEConnection, useThemeManagement, useWorkbenchTabs) but risky without good test coverage
- **92 `as any` casts** across src/ (excluding tests): would benefit from stricter typing but requires enabling `strict: true` first

## Deduplication Done

- `expandHomePath` / `resolveAgentPath`: consolidated from 5 copies into `src/utils/pathResolve.ts`
- Unused imports cleaned across ~30 files (noUnusedLocals warnings: 41 → 7)
