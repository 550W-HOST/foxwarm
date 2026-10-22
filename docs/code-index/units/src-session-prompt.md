# Unit: src-session-prompt

Files: src/session/promptSnapshot.ts, src/session/promptCache.ts, src/session/sessionMemoryFrontmatter.test.ts, src/session/sessionSystemPromptFiles.test.ts
Secondary files: src/conditionalMemoryRuntime.test.ts, src/skillCatalogSnapshot.test.ts, src/llm.test.ts, src/session/agentMetadata.test.ts, src/session/historyCompactPlanRetry.test.ts, src/sessionTurnRunnerDetachedOwner.test.ts

## Purpose

Builds Session system-prompt snapshots and owns persisted prompt-cache key generation/reuse outside provider orchestration. Lifecycle, agent settings, compaction and LLM callers use these modules directly. Observable source selection and adoption are owned by [working instructions](../behaviors/conversation-and-history.md#which-instructions-are-in-the-working-context). Snapshot building reads metadata facts and filesystem sources; it does not load SessionManager, provider execution, the tool registry or upper-level authorization dispatch.

## Key exports

- `normalizeSystemPromptFiles(value)` preserves the established list/string normalization and the distinction between omitted default sources and an explicit empty custom selection.
- `buildSessionSystemPromptSnapshot(options)` assembles framework/memory sources, the visible skill catalog and existing generated guidance for an explicit concrete model identity.
- `resolveConcreteModelIdForSnapshot(model, modelsConfigOverride?)` resolves known concrete configuration without selecting a virtual route. It uses `config.getModelIdForMetadata`, the same identity helper as provider result attribution.
- `resolveSessionSnapshotModelId(session)` prefers the snapshot's recorded concrete identity, then a directly resolvable concrete configuration.
- `buildSessionSystemPromptSnapshotForSession(session)` rebuilds with that truthful identity or returns `undefined` for an unmaterialized virtual Session.
- `generatePromptCacheKey()` and `ensurePromptCacheKey(session)` live in `promptCache.ts`. They generate random UUIDs and reuse valid stored lineage keys without persistence or a Session lookup. Callers retain their existing best-effort/strict persistence responsibilities.

## Source assembly

- Default memory order is the current framework source (or the existing legacy main-agent framework fallback), followed by inherited/current Agent memory in chain order and filename order. Ordinary memory files retain Session frontmatter selection before model-specific conditional filtering. Framework sources remain raw-content sources before conditional filtering.
- Explicit `systemPromptFiles` replace default memory selection, preserve listed order, support the established absolute/home-relative/Agent-relative paths, and retain missing/non-file errors. Isolated custom memory calls the same pure `utils/agentPathAccess.checkPathAccess` guard as tool file wrappers.
- Skill catalog assembly calls `skills.listSkills` and keeps only the visible metadata catalog. Generated directory/recall guidance and skill instructions are not scanned for conditional-memory blocks.
- Snapshot construction preserves existing wrappers, guidance and first-line model marker bytes. Conditional grammar/header ownership remains [src-conditional-memory](./src-conditional-memory.md).

## Dependency direction

`promptSnapshot` depends on config/model identity, conditional-memory helpers, skills, the lower-level `agentMetadata` facts/store, and filesystem/path utilities. `agentMetadata` does not import snapshot construction or settings operations. `agentSettings` composes those facts with snapshot building for refresh/inheritance/isolation lifecycle changes, receiving existing Session effects from its caller.

The pure path guard depends only on path/config and remains separate from `isolatedCheck`'s SessionManager-dependent dispatch. `promptCache` depends only on UUID generation and the Session type. None of these lower-level paths use an LLM forwarding export, lazy require, generic registry or container.

## Integration and tests

Normal chat still owns actual-attempt snapshot matching and strict exact-owner persistence. Lifecycle refresh, deferred virtual materialization and detached compact/BTW ownership are canonical in [conditional memory snapshots](../threads/conditional-memory-snapshots.md). Fork/fresh/clear/compact lineage is canonical in [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage); the provider-specific WebSocket key derivation remains in LLM, not persisted key generation.

The frontmatter and prompt-file suites exercise raw framework bytes, inheritance, custom source selection/path restrictions and fork/child behavior. Conditional runtime, agent settings and compaction suites exercise selected-model reuse, virtual deferral, refresh and persistence failures. Existing LLM/BTW tests cover cache-key reuse and detached ownership.
