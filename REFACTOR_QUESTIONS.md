# Refactor Questions & Findings

## Dead / Unused Exports (confirmed via grep, no production callers)

### sessionManager.ts
- `shouldProcessQueuedItemForWait` — exported but never called (internal `applyQueuedItemToWaitState` is used instead)
- `removeAliasCacheEntry` — exported but never called anywhere
- `getChannelDangerouslyAllowAllGroupMembers` — legacy alias, never called (the `AllUsers` variant is used)
- `setChannelDangerouslyAllowAllGroupMembers` — legacy alias, never called
- `sendToChannelById` — exported but never called
- `sendFileToChannelById` — exported but never called

### config.ts
- `getSkillMemoryDir` — exported but never called (skills.ts uses its own `getSkillMemoryDirFromRoot`)

### llm.ts
- `getPersistentMemory` — only used in test mocks, not in production code

### session/channels.ts
- `getChannelDangerouslyAllowAllGroupMembers` — legacy alias, never called from production
- `setChannelDangerouslyAllowAllGroupMembers` — legacy alias, never called from production
- `sendToChannelById` — never called
- `sendFileToChannelById` — never called
- `setChannelsStoreForTests` / `resetChannelsForTests` — test-only helpers (acceptable)

## Questions (need user input before changing)

1. **Legacy migration code**: There's substantial legacy migration code across the codebase (env→yaml config, legacy channel attachments, legacy vector checkpoints, legacy WebUI settings paths, legacy log dirs). Is any of this still needed for active deployments, or can some be removed?

2. **`sendToChannelById` / `sendFileToChannelById`**: These seem like they were intended as public API but never got callers. Remove, or keep for future use?

3. **`getPersistentMemory` in llm.ts**: Only used in test mocks. The actual memory loading goes through `buildSessionSystemPromptSnapshot`. Is this function still needed or is it vestigial?

4. **`src/selftest/toolLoopStallSelfTest.ts` (825 lines)**: Is this still actively used/run, or is it a one-off diagnostic that could be moved to tests?

## Potential Simplification Targets (no action taken yet)

- `src/session/history.ts` (1420 lines): Could split compaction logic from archive query logic
- `src/vector.ts` (1621 lines): Could split embedding/indexing from search/query
- `src/channels/webuiChannel.ts` (1966 lines): Large but it's a single HTTP server with many routes; splitting routes into sub-files is possible but may not add much clarity
