# Unit: src-tools-session-agent

Files: src/toolsSessionAgent.ts (facade), src/toolsSessionAgent/helpers.ts, src/toolsSessionAgent/interSession.ts, src/toolsSessionAgent/archiveRecall.ts, src/contextPreviewRenderer.ts, src/contextPreviewRenderer.test.ts, src/toolsSessionAgent/timers.ts, src/toolsSessionAgent/agents.ts, src/toolsSessionAgent/skills.ts, src/toolsSessionAgent/settings.ts, src/toolsSessionAgent/sessionCrud.ts, src/sessionStatus.ts, src/toolsSessionAgent/toolsSessionAgentArchiveGuard.test.ts, src/toolsSessionAgent/toolsSessionAgentResult.test.ts, src/toolsSessionAgent/sessionTool.test.ts, src/toolsSessionAgent/handoffWait.test.ts

## Purpose

Implements the session agent tool functions that allow an AI agent to manage sessions, communicate across sessions, access archived context, set goals, manage timers, send files, and control execution flow. The test files validate archive/recall preview rendering, budget clamping, filtering, and tool result formatting.

## Key Exports (from facade)

- `tool_create_child_session`, `tool_send_to_session`, `tool_wait`, `tool_submit_compact_plan`, `tool_send_to_channel`, `tool_send_file` — inter-session communication
- `tool_get_session_messages`, `tool_get_archived_messages`, `tool_get_archived_blocks`, `tool_recall` — archive/recall
- `tool_create_timer`, `tool_list_timers`, `tool_update_timer`, `tool_delete_timer` — timer management
- `tool_create_agent`, `tool_list_agents`, `tool_set_agent_inherit`, `tool_set_agent_isolated`, `tool_move_session`, `tool_create_session` — agent/session management
- `tool_skill` — skill list/load actions
- `tool_set_goal`, `tool_set_session_compact_threshold`, `tool_set_session_child_model`, `tool_update_session_snapshot` — settings

`tool_set_goal`, compact-threshold settings, child-model settings, and snapshot refresh can mutate the exact passed current Session when `session`, `sessionId`, target identity, and the local-only `persistCurrentSession` hook agree. Status reads use the same owner. Explicit other-session targets, identity mismatch, and legacy/direct callers without that hook retain their existing SessionRuntime/SessionManager paths. Snapshot refresh delegates to the shared passed-Session prompt builder rather than looking the owner up again.
- `tool_session`, `tool_delete_session`, `tool_stop_session`, `tool_compact_session` — session status/list/display-name update and lifecycle

## Function Index

### toolsSessionAgent/helpers.ts — Shared types and utilities
| Function | Description |
|----------|-------------|
| `buildEndTurnResult` | Constructs a stop-turn control result |
| `normalizeWaitTimeoutSeconds` | Validates and normalizes timeout seconds input |
| `normalizeWaitAllSessions` | Validates and deduplicates session ID array |
| `normalizePositivePreviewLength` | Coerces preview length to positive integer or fallback |
| `assertPreviewRequestWithinLimit` | Throws if combined preview budget exceeds char limit |
| `formatTimerTimestamp` | Formats a timer timestamp as ISO string or 'n/a' |
| `formatTimerSummary` | Builds a human-readable timer creation summary |
| `formatTimerUpdateSummary` | Builds a human-readable timer update summary |
| `expandHomePath` | Expands `~` prefix to OS home directory |
| `resolveAgentPath` | Resolves relative file path against agent or session CWD |
| `detectMimeType` | Returns MIME type based on file extension |
| `isNonEmptyString` | Type guard for non-empty trimmed strings |
| `normalizeToolModelKey` | Validates a model key against available models config |
| `formatMessageLogRange` | Formats a message sequence range label |
| `formatBlockIdRange` | Formats a block ID range label |
| `shouldEnforceIsolatedMasterPathAccess` | Checks if isolated path restrictions apply |
| `prepareChannelFile` / `prepareRemoteChannelFile` | Prepares file metadata for channel delivery |
| `formatSendFileSessionResult` / `buildSendFileResult` | Formats send_file tool results |

### toolsSessionAgent/interSession.ts — Inter-session communication
| Function | Description |
|----------|-------------|
| `tool_create_child_session` | Creates a child session (fork or new) |
| `tool_send_to_session` | Sends a message to another session's queue; self-sends are rejected |
| `tool_wait` | Ends the agent's current turn with __toolLoopControl |
| `tool_submit_compact_plan` | Submits a compaction plan |
| `tool_send_to_channel` | Sends a message to a specific channel target |
| `tool_send_file` | Sends a file to session channels or a specific channel |

### toolsSessionAgent/archiveRecall.ts — Archive retrieval and recall
| Function | Description |
|----------|-------------|
| `tool_get_session_messages` | Returns recent messages plus the target session's canonical execution-state summary through the shared total-budget preview renderer |
| `tool_get_archived_messages` | Fetches archived messages by sequence range |
| `tool_get_archived_blocks` | Fetches archived context blocks by ID range |
| `tool_recall` | Retrieves archived context via target selector syntax |
| `parseRecallTarget` | Parses recall target string into structured selector |
| `buildRecallOverview` | Builds overview of archived blocks/messages |
| `buildRecallFrontierBlocks` | Returns top-level frontier blocks |
| `buildRecallBlockDetail` | Returns detail for a specific block |
| `buildRecallMessagesForBlock` | Returns messages covered by a block |
| `buildRecallMessagesByRange` | Returns messages in a sequence range |
| `renderContextBlockExpansion` | Read-only WebUI helper that expands one CTX-BLOCK layer into structured child block/raw message items without session queue/tool mutation |
| `formatArchivedMessagePreview` | Formats a single archived message for display |
| `formatArchivedBlockPreview` | Formats archived blocks listing |

### contextPreviewRenderer.ts — Shared recall/session preview rendering
| Function | Description |
|----------|-------------|
| `normalizeContextPreviewBudget` | Treats `previewLength` as a total budget, clamps to 1000-20000, and returns warning strings |
| `createMessageContextPreviewItem` | Converts a message into searchable/renderable preview data with configurable tool folding |
| `createArchivedBlockContextPreviewItem` | Converts an archive block into searchable/renderable preview data |
| `renderContextPreviewItems` | Applies staged literal/regex post-filters, returns per-stage exclusion counts, renders filter notices/match-centered snippets, and enforces total-budget truncation |
| `formatMessageHeading` | Builds consistent message headings with role emoji, origin labels, and visibility suffix |

### toolsSessionAgent/timers.ts — Timer management
| Function | Description |
|----------|-------------|
| `tool_create_timer` | Creates a cron or one-shot timer |
| `tool_list_timers` | Lists active timers for a session |
| `tool_update_timer` | Updates a timer's message, schedule, or new-session target fields in place |
| `tool_delete_timer` | Deletes a timer by ID |

### toolsSessionAgent/agents.ts — Agent and session creation
| Function | Description |
|----------|-------------|
| `tool_create_agent` | Creates a new agent with optional main session |
| `tool_list_agents` | Lists all agents with session counts |
| `tool_set_agent_inherit` | Configures agent shared memory inheritance |
| `tool_set_agent_isolated` | Sets or clears agent node isolation |
| `tool_move_session` | Moves a session to a new ID or agent, preserving its incoming parent unless an optional existing `parentSessionId` intentionally reparents it |
| `tool_create_session` | Creates a new session under an agent |

### toolsSessionAgent/skills.ts — Skill discovery
| Function | Description |
|----------|-------------|
| `tool_skill` | Lists available skills or loads one entry document/resource list according to `action` |

### toolsSessionAgent/settings.ts — Session settings
| Function | Description |
|----------|-------------|
| `tool_set_goal` | Sets or clears the session goal |
| `tool_set_session_compact_threshold` | Reads or updates the trusted passed owner's compaction threshold, with the existing SessionRuntime path for other/legacy targets |
| `tool_set_session_child_model` | Reads or updates the trusted passed owner's child-model default, with the existing SessionRuntime path for other/legacy targets |
| `tool_update_session_snapshot` | Refreshes a trusted passed owner's prompt snapshot directly, or uses the existing ID-based path for other/legacy targets |

### toolsSessionAgent/sessionCrud.ts — Session lifecycle
| Function | Description |
|----------|-------------|
| `tool_session` | Model-facing session helper: status, paginated list, and display-name update actions |
| `tool_delete_session` | Deletes a session (with busy-session safety) |
| `tool_stop_session` | Sends stop signal to a busy session |
| `tool_compact_session` | Requests session compaction |

### src/sessionStatus.ts — Shared session status/list formatting
| Function | Description |
|----------|-------------|
| `buildSessionStatusInfo` | Builds the shared status data used by `/status` and `session({action:"status"})`: agent/session identity, agent dir, parent id, model, message count, token/image estimate, last usage (including an optional provider-reported reasoning component), last message time, effective auto-compact threshold, current node connectivity, cwd/default cwd, busy/queue state, and recent child sessions. |
| `formatSessionStatus` | Formats status info for command/tool output. |
| `formatSessionListRow` | Shared row formatter reused by status child-session rows and session list output. |
| `buildSessionListOutput` | Formats the old list_sessions-style paginated list for `session({action:"list"})`. |

## Dependencies

- `./sessionManager` — session CRUD, message appending, archive access, agent inheritance/isolation
- `./session/goal` — goal state management (set/clear/resolve remind settings)
- `./session/layeredContext` — archive block formatting and retrieval
- `./session/archive` — message archive append/read
- `./session/messageVisibility` — redacting display-only content for model consumption
- `./session/compactPlan` — compact plan tool name constant
- `./contextPreviewRenderer` — shared total-budget renderer for recall/get_session_messages/vector-query previews (tool folding, filters, match-centered snippets)
- `./config` — agent directory resolution, model config, constants (`AGENTS_DIR`, `COMPACT_PERCENT`)
- `./llm` — LLM interaction layer, normalizeSystemPromptFiles
- `./skills` — skill listing and document loading
- `./timers` — timer CRUD and view types
- `./nodes/manager` — node management for remote file send
- `./isolatedCheck` — permission guards for isolated sessions (path access, channel, timer, archived read)
- `./utils/messageFormat` — text formatting helpers
- `./utils/unicode` — safe unicode truncation
- `./utils/localTime` — local timestamp formatting
- `./channel` — `ChannelFile` type

## Behavior

- `get_session_messages` and `recall` render through the shared context preview renderer: `previewLength` is a total output budget, values are clamped to 1000-20000 with a warning, tool calls/results default to name/id/status-only, and `contentFilter` / `includeRegex` / `excludeRegex` post-filter full message/block/tool content with match-centered snippets. Every successful `get_session_messages` result also includes the target session's concise canonical runtime-state summary, including empty pages and pages reduced to zero matches; a nonzero queue length is appended without changing message selection or filter semantics.
- `contentFilter` is a literal case-insensitive result post-filter, never a semantic or retrieval query. `get_session_messages` first selects its page; exact recall first resolves `target`; vector recall first searches with `vector_query` and reloads source archive items; only then does the shared renderer filter. Filter stages run in the documented order `contentFilter` -> `includeRegex` -> `excludeRegex`, report separate exclusion counts, and keep the notice visible even when zero items remain or body previews are truncated.
- For CTX-BLOCK drill-down, the block metadata/summary header is not counted as a raw source message. Message-backed blocks post-filter/count source messages; block-backed blocks post-filter/count immediate child block summary items. When `contentFilter` excludes anything, recall tells the caller to omit it for complete target contents and use `vector_query` for semantic search.
- The old `query` argument has been removed from both model-facing schemas and is explicitly rejected by the `recall` / `get_session_messages` runtime rather than silently ignored or compatibility-read.
- `recall({ vector_query })` performs lineage-bounded semantic retrieval, then resolves vector hit metadata back to original archived messages/blocks before rendering. A crossing legacy fact hit is discarded rather than reloading a partial source range; the legacy `search_vector` / `search_memory` tools are removed rather than wrapped for compatibility.
- Legacy archived-message/block tools still exist as hidden/direct archive readers, but the model-facing path for exact and semantic context recall is `recall`.
- `tool_recall` rejects legacy parameter names (`startSeq`, `endSeq`, `includeMessages`, etc.) with guidance to use the new `target` selector syntax (`msg#N-M`, `B#N`, `blocks`).
- `renderContextBlockExpansion` is not a model-facing tool. WebUI uses it with `sessionId + blockId` to render temporary one-layer archive previews as structured timeline messages; child block messages include `__meta.contextBlock` for recursive expansion, and raw archive messages keep their original message shape/seq metadata. Missing sessions/blocks are reported with structured errors.
- `tool_wait` returns a `__toolLoopControl` signal that stops the agent's current turn. It accepts optional `waitExecIds?: string[]` as advisory metadata for runtime-state display; empty/omitted args remain a normal wait for any new message/event.
- `tool_session` replaces the old `list_sessions` tool and owns display-name changes. With omitted args or `action:"status"`, it returns the same status fields as `/status` using `src/sessionStatus`: agent id/name, agent dir, session id, parent id, token/image estimate, last usage (with optional reasoning tokens displayed inside output rather than added to total), auto-compact threshold, current node, current cwd/default cwd, canonical runtime-state summary, and up to 10 recent child sessions. With `action:"list"`, it preserves old list pagination (`start`, `count`) and row formatting; with `action:"update-display-name"`, it sets or clears a display name and reports the previous/resulting values or an explicit no-op. Isolated sessions may use status but not list/update-display-name.
- `tool_submit_compact_plan` remains guarded outside dedicated compaction, but its model-facing schema now includes `preserveMessages` and `removePreservedMessages` for compact-time raw-message preservation/removal handled by `src/session/compactPlan` and `src/session/history`.
- `tool_send_to_session` delegates to session relations, accepts `<main>` / `<parent>` special target ids, and cannot target the current/source session itself; self-send errors include current/requested/resolved IDs and remind agents that messages to the current session's direct user should be ordinary assistant text instead.
- `send_to_session(waitAfterHandoff:true)` emits a hidden post-batch generic-wait request only after delivery succeeds. `create_child_session(waitAfterHandoff:true)` requires a non-empty initial message and awaits its delivery before emitting the same request; ordinary unflagged child creation retains its existing asynchronous initial-send behavior. The former option name is not compatibility-read. Canonical orchestration: [D-pipeline-handoff-wait](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait).
- `tool_skill({ action: "load" })` is progressive-disclosure oriented: it returns `SKILL.md` plus skill directory/resource-path guidance, not full companion resources. The list/load actions share the same resolution, and isolated sessions may use them for their own agent only.
- Path resolution expands `~` and resolves relative paths against the agent directory or session CWD.
- All mutating tools check isolation status via `requireNotIsolated` before proceeding.
- `move_session` reports the previous/resulting parent after identity success. If its optional post-move parent write fails, the result explicitly says the identity move committed and the requested parent was not confirmed; canonical semantics: [D-lifecycle-identity-move-relations](../threads/session-lifecycle.md#d-lifecycle-identity-move-relations).
- Goal setting normalizes text, resolves remind-every defaults, and persists to session state.
- `tool_compact_session` starts async-capable snapshot planning immediately without a compact-planning queue item; for a busy `asyncCompact:false` target it reports that the target must become idle first. Only ready compact commits use the queue safe point.
- Timer create/update delegates to the `timers` module and returns formatted summaries; list/delete remain scoped by current or explicit session ID.

## Integration

- These tool functions are authoritative raw handlers. Most are invoked directly by the builtin dispatcher; `send_to_session`, `send_to_channel`, `list_agents`, and timer CRUD are invoked through the closed local Main Management RPC service so direct, unified, and ToolScript callers share one boundary.
- Relies on `sessionManager` as the central persistence and session lifecycle layer.
- Archive guard logic protects the context window from oversized retrievals, forcing the agent to narrow queries iteratively.
- Isolation checks integrate with the node system to enforce sandboxing for agents running on specific nodes.
- The `__toolLoopControl` return shape is consumed by the orchestration layer to halt or continue the agent turn loop.

## Design Decisions

- [2026-08-01] Every successful `get_session_messages` response must include the target session's execution state via the shared `buildSessionRuntimeState` and `formatSessionRuntimeStateSummary` path, including empty and fully filtered pages. Keep the four-state runtime taxonomy canonical rather than defining retrieval-specific labels; append only a nonzero queue count when the compact summary would otherwise omit pending work.

- [2026-07-22] Rename the shared literal result filter on `recall` and `get_session_messages` from ambiguous `query` to `contentFilter`. It is explicitly a case-insensitive post-filter after target/page/vector retrieval; `target` owns exact CTX-BLOCK/range selection and `vector_query` owns semantic search. Do not preserve old `query` compatibility: reject it clearly. Report staged literal/include/exclude exclusion counts, and preserve the count/omit-filter hint even for zero-result or truncated previews.

- [2026-07-02] The old model-facing `list_sessions` builtin is removed rather than compatibility-wrapped. The replacement is the default model-facing `session` tool: `session()` / `session({action:"status"})` for current status, and `session({action:"list", start, count})` for the old list behavior.
- [2026-07-02] `/status` and `session({action:"status"})` must share the same status information source/formatter (`src/sessionStatus`) and expose the union of old `/status` fields plus the new tool fields: agent id/name, agent dir, session id, parent id, model, message/token/image status, last usage, last message time, effective auto-compact threshold, current node/connection, current cwd/default cwd, busy/queue state, and recent child sessions.
- [2026-07-07] Session status/list should expose canonical `runtimeState` while keeping old busy/queue information. `wait({})` stays allowed and should be reported as `idle`; `waitExecIds` is optional/advisory metadata for `waiting:exec` display.
