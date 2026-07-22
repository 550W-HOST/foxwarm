# Unit: src-session-agent-ops

Files: src/session/agentOps.ts, src/session/agentMetadata.ts, src/session/agentMetadata.test.ts

## Purpose

Manages agent lifecycle operations (creation, renaming, moving sessions between agents) and agent metadata (isolation, inheritance, system prompt snapshots). Provides validation, file-system reorganization of session artifacts, and persistent storage of per-agent configuration.

## Key Exports

- `validateAgentName(agentName)` — validates agent name format
- `validateSessionName(sessionName)` — validates session name format
- `createSessionInAgent(options, deps)` — creates a new session scoped to an agent
- `createAgentWithSession(options, deps)` — creates a new agent directory and its initial session
- `moveSessionToTarget(options, deps)` — renames or moves a session across agents
- `AgentMetadata` (interface) — shape of per-agent config (isolated, isolatedNode, inherit)
- `createAgentMetadataStore(filePath)` — factory for the disk-backed metadata store
- `loadAgentMetadata()` — loads metadata from disk into memory
- `getAgentMetadata(agentName)` — returns metadata for an agent
- `getAgentIsolationNode(agentName)` — returns the isolation node if set
- `isAgentIsolated(agentName)` — checks isolation flag
- `isSessionEffectivelyIsolated(session)` — checks if a session's agent is isolated
- `setAgentMetadata(agentName, meta)` — persists metadata for an agent
- `refreshSessionSnapshot(deps, sessionId)` — rebuilds a session's system prompt snapshot
- `getAgentInheritanceChain(agentName)` — resolves the full inheritance chain
- `setAgentInherit(deps, agentName, inheritAgentName)` — sets/clears inheritance and refreshes affected sessions
- `setAgentIsolation(deps, agentName, isolatedNode)` — toggles isolation and updates sessions
- `setAgentMetadataStoreForTests(store)` / `resetAgentMetadataForTests()` — test helpers

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `validateAgentName(agentName)` | ~25 | Regex check for valid agent name characters |
| `validateSessionName(sessionName)` | ~30 | Rejects empty or slash-containing session names |
| `buildSessionId(agentName, sessionName)` | ~35 | Constructs composite session ID from agent and name |
| `initializeAgentDirectory(options)` | ~42 | Creates agent dir, optionally copies memory from source |
| `renameSessionIdentity(options, deps)` | ~80 | Renames session ID, moves all associated files, updates aliases and children |
| `createSessionInAgent(options, deps)` | ~130 | Creates a session within an existing agent with a fresh promptCacheKey and metadata |
| `createAgentWithSession(options, deps)` | ~(truncated) | Creates agent directory then creates its initial session |
| `moveSessionToTarget(options, deps)` | ~(truncated) | Orchestrates session move/rename with optional agent creation |
| `getSessionSystemPromptOptions(session)` | ~8 (agentMetadata) | Extracts prompt options from a session |
| `normalizeAgentMetadataPayload(raw, filePath)` | ~30 (agentMetadata) | Validates raw loaded metadata shape |
| `createAgentMetadataStore(filePath)` | ~33 (agentMetadata) | Instantiates DiskJsonData for agent metadata |
| `setAgentMetadataStoreForTests(store)` | ~45 (agentMetadata) | Replaces store instance for testing |
| `resetAgentMetadataForTests()` | ~50 (agentMetadata) | Clears in-memory metadata map |
| `normalizeAgentMetadata(meta)` | ~53 (agentMetadata) | Strips skills, normalizes isolatedNode |
| `saveAgentMetadata()` | ~63 (agentMetadata) | Serializes in-memory map to disk |
| `loadAgentMetadata()` | ~85 (agentMetadata) | Reads metadata file, populates in-memory map |
| `getAgentMetadata(agentName)` | ~105 (agentMetadata) | Returns metadata or empty object |
| `getAgentIsolationNode(agentName)` | ~109 (agentMetadata) | Returns isolation node string if isolated |
| `isAgentIsolated(agentName)` | ~115 (agentMetadata) | Boolean isolation check |
| `isSessionEffectivelyIsolated(session)` | ~119 (agentMetadata) | Delegates to isAgentIsolated via session's agent |
| `setAgentMetadata(agentName, meta)` | ~124 (agentMetadata) | Normalizes and persists metadata |
| `refreshSessionSnapshot(deps, sessionId)` | ~129 (agentMetadata) | Rebuilds single session's prompt snapshot |
| `getAgentInheritanceChain(agentName)` | ~139 (agentMetadata) | Walks inherit links with cycle detection |
| `setAgentInherit(deps, agentName, inheritAgentName)` | ~155 (agentMetadata) | Sets inheritance, validates cycles, refreshes sessions |
| `setAgentIsolation(deps, agentName, isolatedNode)` | ~195 (agentMetadata) | Toggles isolation, updates currentNode on sessions |

## Dependencies

- `../llm` — `ensurePromptCacheKey`, `buildSessionSystemPromptSnapshot`
- `../config` — `getAgentDir`, `getAgentMemoryDir`, `getSessionArchiveLogPath`, `getSessionArchiveImagesDir`, `getSessionBlockArchiveLogPath`, `getLegacySessionFrontierPath`, `SESSIONS_DIR`, `AGENTS_FILE`
- `../types` — `Session`
- `../common` — `logger`
- `../utils/diskJsonData` — `DiskJsonData`
- `./archiveStore` — `renameSessionArchiveStore`

## Behavior

- Agent operations use a dependency-injection pattern (`SessionAgentOpsDeps` / `AgentMetadataDeps`) for session access, enabling testability.
- `renameSessionIdentity` performs a multi-step atomic-ish rename: updates in-memory maps, moves history/archive/image files plus any leftover legacy frontier file on disk, updates child sessions' parent references, and persists everything.
- Agent metadata is held in an in-memory `Map` backed by a single JSON file (no backup rotation). Normalization strips `skills` and cleans `isolatedNode`.
- Isolation enforcement prevents cross-agent session moves when either source or target agent is isolated.
- Inheritance chain resolution detects cycles and logs a warning rather than throwing.
- Setting inheritance or isolation triggers a refresh of system prompt snapshots for all affected sessions (including transitive inheritors).

## Integration

- Consumed by the broader session manager which provides the `deps` implementations (session CRUD, alias cache, channel management).
- Relies on `llm` module for prompt cache key management and system prompt snapshot building; new sessions created here pass their canonical session id into snapshot construction so session-specific memory frontmatter can match, and use a fresh key even when recording `parentSessionId` because this path does not fork/copy the parent's prefix.
- Archive store and archive index are coordinated during session renames to keep on-disk state consistent.
- `DiskJsonData` utility provides the lightweight persistence layer with fallback/recovery semantics.
- Test file validates round-trip persistence and normalization (no backup files created).