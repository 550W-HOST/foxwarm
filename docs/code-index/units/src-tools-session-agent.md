# Unit: src-tools-session-agent

Files: src/toolsSessionAgent.ts (facade), src/toolsSessionAgent/helpers.ts, src/toolsSessionAgent/interSession.ts, src/toolsSessionAgent/archiveLexicalRecall.ts, src/toolsSessionAgent/archiveLexicalRecall.test.ts, src/toolsSessionAgent/archiveRecall.ts, src/toolsSessionAgent/archiveRecallVectorFallback.test.ts, src/toolsSessionAgent/archiveRecallVectorQuality.test.ts, src/toolsSessionAgent/detachedSessionMessages.test.ts, src/contextPreviewRenderer.ts, src/contextPreviewRenderer.test.ts, src/toolsSessionAgent/timers.ts, src/toolsSessionAgent/agents.ts, src/toolsSessionAgent/skills.ts, src/toolsSessionAgent/settings.ts, src/toolsSessionAgent/sessionCrud.ts, src/sessionStatus.ts, src/toolsSessionAgent/toolsSessionAgentArchiveGuard.test.ts, src/toolsSessionAgent/toolsSessionAgentResult.test.ts, src/toolsSessionAgent/sessionTool.test.ts, src/toolsSessionAgent/handoffWait.test.ts

## Purpose

Implements the session agent tool functions that allow an AI agent to manage sessions, communicate across sessions, access archived context, set goals, manage timers, send files, and control execution flow. The test files validate archive/recall preview rendering, budget clamping, filtering, and tool result formatting.

## Key Exports (from facade)

- `tool_create_child_session`, `tool_send_to_session`, `tool_wait`, `tool_submit_compact_plan`, `tool_send_to_channel`, `tool_send_file` — inter-session communication
- `tool_get_session_messages`, `tool_get_archived_messages`, `tool_get_archived_blocks`, `tool_recall` — archive/recall
- `tool_create_timer`, `tool_list_timers`, `tool_update_timer`, `tool_delete_timer` — timer management
  `create_timer` and `update_timer` retain schedule/mode/target/next-run information but omit the message body from their successful model-facing receipts. `list_timers` remains the detail query and includes message text; timer firing still delivers the persisted message.
- `tool_create_agent`, `tool_list_agents`, `tool_set_agent_inherit`, `tool_set_agent_isolated`, `tool_move_session`, `tool_create_session` — agent/session management
- `tool_skill` — skill list/load actions
- `tool_set_session_compact_threshold`, `tool_set_session_child_model`, `tool_refresh_session_snapshot` — settings

Compact-threshold settings, child-model settings, snapshot refresh, and current stop can mutate the exact passed current Session when `session`, `sessionId`, target identity, and the local-only `persistCurrentSession` hook agree. Display-name updates are Main-owned catalog metadata: a Worker routes them through the fixed Main Management operation, and Main applies the SessionRuntime catalog update without persisting Worker authority. Compact/child settings normalize the passed owner exactly like SessionRuntime and persist only when the normalized settings view changes; canonical in-memory assign/delete still occurs for no-ops. Worker status formatting uses only that owner and marks remote node connectivity unknown instead of consulting a child catalog. Current archived-message/block permission checks also use the exact owner. Recall trims explicit session/agent selectors; current aliases and the exact owner's current-agent vector scope remain local/reverse-safe without a global Session lookup. Explicit other-session Worker targets are pre-handler fenced; local legacy/direct callers retain their existing SessionRuntime/SessionManager paths. Snapshot refresh delegates to the shared passed-Session prompt builder rather than looking the owner up again.
- `tool_session`, `tool_delete_session`, `tool_stop_session`, `tool_compact_session` — session status/list/display-name/parent update and lifecycle

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
| `formatTimerSummary` | Builds a human-readable timer creation receipt without the message body |
| `formatTimerUpdateSummary` | Builds a human-readable timer update receipt without the message body |
| `expandHomePath` | Expands `~` prefix to OS home directory |
| `resolveAgentPath` | Resolves relative file path against agent or session CWD |
| `detectMimeType` | Returns MIME type based on file extension |
| `isNonEmptyString` | Type guard for non-empty trimmed strings |
| `normalizeToolModelKey` | Validates a model key against available models config |
| `normalizeForceModel` | Strictly parses the nested intentional Session-creation model/effort override |
| `normalizeCreateChildSessionArgs` / `normalizeCreateSessionArgs` | Apply the closed non-mutating top-level creation key sets shared by local handlers and Main-management |
| `formatMessageLogRange` | Formats a message sequence range label |
| `formatBlockIdRange` | Formats a block ID range label |
| `shouldEnforceIsolatedMasterPathAccess` | Checks if isolated path restrictions apply |
| `prepareChannelFile` / `prepareRemoteChannelFile` | Prepares file metadata for channel delivery |
| `formatSendFileSessionResult` / `buildSendFileResult` | Formats send_file tool results |

### toolsSessionAgent/interSession.ts — Inter-session communication
| Function | Description |
|----------|-------------|
| `tool_create_child_session` | Creates a child session (fork or new), optionally assigning its display name before initial delivery |
| `tool_send_to_session` | Sends a message to another session's queue; self-sends are rejected |
| `tool_wait` | Ends the agent's current turn with __toolLoopControl |
| `tool_submit_compact_plan` | Submits a compaction plan |
| `tool_send_to_channel` | Sends a message to a specific channel target |
| `tool_send_file` | Sends a file to session channels or a specific channel |

### toolsSessionAgent/archiveRecall.ts — Archive retrieval and recall
| Function | Description |
|----------|-------------|
| `tool_get_session_messages` | Returns recent messages plus the target session's canonical execution-state summary through the shared total-budget preview renderer; a trusted current owner reads its passed history directly |
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
| `searchStructuredRecallSources` | Shared ranked source-family retrieval and Archive reload used by model recall and the authenticated history viewer; caller supplies the already-authorized scope. The viewer requests bounded raw source reads and structured Timeline messages, while model recall retains its existing renderer and preview budget. |
| `selectBoundedVectorRawMessageWindow` | Scans one raw source family by bounded effective Archive pages with the same message scorer and anchor tie-break as `selectVectorRawMessageWindow`, then reads a bounded neighborhood for the original atomic tool-group/window selector; I/O is proportional to matched source-family length but each SQL page and retained message set are bounded. |
| `formatArchivedMessagePreview` | Formats archived rows through the shared renderer with valid Archive row timestamp precedence and persisted-message fallback |
| `formatArchivedBlockPreview` | Formats archived blocks listing |

### contextPreviewRenderer.ts — Shared recall/session preview rendering
| Function | Description |
|----------|-------------|
| `normalizeContextPreviewBudget` | Treats `previewLength` as a total budget, clamps to 1000-20000, and returns warning strings |
| `createMessageContextPreviewItem` | Converts a message into searchable/renderable preview data with configurable tool folding; explicit read callers render stored display-only content while retaining the heading visibility marker |
| `createArchivedBlockContextPreviewItem` | Converts an archive block into searchable/renderable preview data |
| `renderContextPreviewItems` | Applies staged literal/regex post-filters, collects bounded priority notices only from selected items plus caller notices, reserves an exact empty result or meaningful item body, clips lower-priority title text first, optionally caps the filtered item set with a truthful selection notice, and enforces an exact UTF-16 code-unit total budget without splitting grapheme clusters |
| `selectVectorRawMessageWindow` | Selects a bounded contiguous authoritative raw window from query/chunk and explicit-positive-filter locators, bilingual/identifier overlap, substantive-content preference, and unique-ID complete atomic tool exchanges; reports exact omitted positive-filter source IDs |
| `extractStrongArchiveLocators` | Deterministically extracts at most four bounded high-confidence hash/Session/Node/path/symbol/slash-command/CamelCase/snake_case/numeric identifiers; ambiguous lowercase hyphen prose requires exact infrastructure shape or explicit ID/quoting context |
| `searchArchiveLexicalSideChannel` | Scores bounded Archive candidates from block summaries or substantive model-visible message text and emits source-backed raw/block locations |
| `fuseDenseAndLexicalHits` | Combines dense and lexical ranks at canonical source-family level with bounded shared boost and raw containment collapse |
| `formatMessageHeading` | Builds consistent message headings with full local timestamps, role emoji, origin labels, and visibility suffix |
| `renderMessageItems` / `clipRenderedPreview` / `elideRepeatedMessageDates` | Tracks only generated message-heading spans through grouped vector snippets and final clipping, then elides dates in surviving displayed order |

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
| `tool_create_agent` | Creates a new agent with optional main session and optional exact agent tool-rule replacement |
| `tool_list_agents` | Lists all agents with session counts, isolation, inheritance, and exact tool-rule count |
| `tool_set_agent_inherit` | Configures agent shared memory inheritance, with optional explicit transitive snapshot refresh |
| `tool_set_agent_isolated` | Sets or clears agent node isolation and optionally replaces exact tool rules (`[]` clears); rules without `nodeId` preserve the current binding |
| `tool_move_session` | Moves a session to a new ID or agent, preserving its incoming parent unless an optional existing `parentSessionId` intentionally reparents it |
| `tool_create_session` | Creates a new session under an agent |

### toolsSessionAgent/skills.ts — Skill discovery
| Function | Description |
|----------|-------------|
| `tool_skill` | Lists available skills or loads one entry document/resource list according to `action` |

### toolsSessionAgent/settings.ts — Session settings
| Function | Description |
|----------|-------------|
| `tool_set_session_compact_threshold` | Reads or updates the trusted passed owner's compaction threshold, with the existing SessionRuntime path for other/legacy targets |
| `tool_set_session_child_model` | Reads or atomically updates the trusted passed owner's future-child model/effort defaults, with the existing SessionRuntime path for other/legacy targets |
| `tool_refresh_session_snapshot` | Refreshes a trusted passed owner's prompt snapshot directly, or uses the existing ID-based path for other/legacy targets |

### toolsSessionAgent/sessionCrud.ts — Session lifecycle
| Function | Description |
|----------|-------------|
| `tool_session` | Model-facing session helper: status, paginated list, display-name update, and parent update actions |
| `tool_delete_session` / `deleteSessionForSource` | Deletes another permitted session through the shared lifecycle orchestrator; Worker placement uses the fixed Main operation and canonical source/alias self-delete is forbidden |
| `tool_stop_session` | Sends stop signal to a busy session |
| `tool_compact_session` | Requests session compaction |

### src/sessionStatus.ts — Shared session status/list formatting
| Function | Description |
|----------|-------------|
| `buildSessionStatusInfo` | Builds the shared status data used by `/status` and `session({action:"status"})`: agent/session identity, agent dir, parent id, model plus raw/effective current and child effort, message count, token/image estimate, last usage, effective auto-compact threshold, current node connectivity, cwd/default cwd, busy/queue state, and recent child sessions. |
| `formatSessionStatus` | Formats status info for command/tool output. |
| `formatSessionListRow` | Shared row formatter reused by status child-session rows and session list output. |
| `buildSessionListOutput` | Formats a paginated catalog list for `session({action:"list"})`, scoped to the source Session Agent by default; `scope:"all"` retains global catalog listing. Invalid scope and missing current-source identity fail before querying. |

## Dependencies

- `./sessionManager` — session CRUD, message appending, archive access, agent inheritance/isolation
- `./session/layeredContext` — archive block formatting and retrieval
- `./session/archive` — message archive append/read
- `./session/messageVisibility` — redacting display-only content for model consumption
- `./session/compactPlan` — compact plan tool name constant
- `./contextPreviewRenderer` — shared total-budget renderer for recall/get_session_messages/vector-query previews (tool folding, filters, match-centered snippets)
- `./config` — agent directory resolution, model config, constants (`AGENTS_DIR`, `COMPACT_KEEP_PERCENT`)
- `./llm` — LLM interaction layer, normalizeSystemPromptFiles
- `./skills` — skill listing and document loading
- `./timers` — timer CRUD and view types
- `./nodes/manager` — node management for remote file send
- `./isolatedCheck` — permission guards for isolated sessions (path access, channel, timer, archived read)
- `./utils/messageFormat` — text formatting helpers
- `./utils/unicode` — safe unicode truncation
- `./utils/localTime` — local timestamp formatting
- `./utils/messagePreviewTime` — valid persisted timestamps and shared local-day comparison state
- `./channel` — `ChannelFile` type

## Behavior

- `create_child_session.taskId` binds an unowned existing task to the actual new child before initial delivery; missing/owned/terminal task preflight rejects before creation. Shared task contracts are canonical in [src-tasks](./src-tasks.md).

- `get_session_messages` and `recall` render through the shared context preview renderer: `previewLength` is a total output budget, values are clamped to 1000-20000 with a warning, tool calls/results default to name/id/status-only, and `contentFilter` / `includeRegex` / `excludeRegex` post-filter full message/block/tool content with match-centered snippets. An exact trusted current owner (matching target/context/passed Session plus the local owner persistence hook) slices passed history directly and uses the passed-session isolation guard; other/no-hook/mismatched calls retain global ID lookups. Every successful result includes the target session's concise canonical runtime-state summary, including empty pages and pages reduced to zero matches; a nonzero queue length is appended without changing message selection or filter semantics.
- `contentFilter` is a literal case-insensitive result post-filter, never a semantic or retrieval query. `get_session_messages` first selects its page; exact recall first resolves `target`; vector recall first searches with `vector_query` and reloads source archive items; only then does the shared renderer filter. Filter stages run in the documented order `contentFilter` -> `includeRegex` -> `excludeRegex`, report separate exclusion counts, and keep the notice visible even when zero items remain or body previews are truncated.
- Exact current-session `recall` targets use a trusted passed owner only when the owner hook and context/session identity agree and the target is absent, the canonical current ID, or a persisted current alias. Under Worker placement, explicit other targets route through the fixed Main-management read boundary: Main uses a detached read-only source, catalog-only target identity, exact archive reloads, existing isolation/agent scope, total preview bounds, and the selected vector facade. Vector scope resolution never hydrates an explicit target Session.
- For CTX-BLOCK drill-down, the block metadata/summary header is not counted as a raw source message. Message-backed blocks post-filter/count source messages; block-backed blocks post-filter/count immediate child block summary items. When `contentFilter` excludes anything, recall tells the caller to omit it for complete target contents and use `vector_query` for semantic search.
- The old `query` argument has been removed from both model-facing schemas and is explicitly rejected by the `recall` / `get_session_messages` runtime rather than silently ignored or compatibility-read.
- `recall({ vector_query })` performs lineage-bounded semantic retrieval, then resolves each ranked canonical source family back to one original archived message-range or block item before rendering. Modern block-identified facts reload their creating block and add bounded matched-fact wording/metadata; legacy null-block facts retain raw source reload. The shared renderer applies `contentFilter`, `includeRegex`, and `excludeRegex` before the final unique-source limit and reports any additional matched groups omitted by that limit. When a legacy/stale source cannot be reloaded, recall preserves the bounded vector-text compatibility preview and emits one content-free structured warning under [D-context-source-backed-recall](../threads/context-compaction-and-recall.md#d-context-source-backed-recall). A crossing legacy fact hit is discarded rather than reloading a partial source range; the legacy `search_vector` / `search_memory` tools are removed rather than wrapped for compatibility.
- Raw vector families render one query/chunk/filter-centered authoritative message window instead of the whole range from its first message. Headings label full/selected sequence ranges and omissions; exact archived message headings/text, valid unique-ID adjacent tool exchanges, shared tool folding, post-filters, and total preview budget remain authoritative. Positive filters retain full-range inclusion semantics while also steering localization; when a required match remains outside the bounded window, the selected item adds priority exact `msg#N` drill-down guidance that survives minimum-budget body truncation. Recent current-Session rows remain in live history; ordinary semantic recall treats persistent checkpoint lag as silent eventual consistency, performs no status/deadline lookup solely for lag, and emits no pending-index notice. Checkpoint/max-latency status remains a diagnostic/indexing API, and Phase2A is bootstrap/error-only. Empty semantic results keep their exact meaning while long query/title text is lower-priority and clipped first.
- After successful dense retrieval, exact/current-Session scope may run the bounded identifier side-channel and fuse its canonical source families before the same Archive reload/filter/limit/preview flow. Generic lowercase hyphen prose cannot activate a rank-promoting lane, while exact infrastructure-shaped or explicitly identified/quoted Node/Session IDs remain eligible. Block summaries are preferred; raw candidate selection and final scoring both use `formatSubstantiveMessageSearchText`, including channel-wrapper precedence, dual-field handling, and ephemeral/RAG/thinking/tool-only/display exclusion. Broad current-agent scope never invokes Archive lexical lookup, lookup failure is dense-only best effort, and disabled Vector semantics are unchanged.
- Legacy archived-message/block tools still exist as hidden/direct archive readers, but the model-facing path for exact and semantic context recall is `recall`.
- `tool_recall` rejects legacy parameter names (`startSeq`, `endSeq`, `includeMessages`, etc.) with guidance to use the new `target` selector syntax (`msg#N-M`, `B#N`, `blocks`).
- `renderContextBlockExpansion` is not a model-facing tool. WebUI uses it with `sessionId + blockId` to render temporary one-layer archive previews as structured timeline messages; one shared load obtains the parent block and immediate source records, then a pure formatter produces the compatible `text` field from the same data used for structured `items/messages`. Child block messages include `__meta.contextBlock` for recursive expansion, and raw archive messages keep their original message shape/seq metadata. Missing sessions/blocks are reported with structured errors.
- `tool_wait` returns a `__toolLoopControl` signal that stops the current turn. Current calls must declare at least one valid source or fallback: a two-or-more `waitAllSessions` barrier, nonempty `waitAnySessions`, exact owned active/queued-completion `waitExecIds`, `waitForInput:true`, or positive `wakeIfNoActivityAfterSeconds`. A wait with `waitExecIds` and no explicit fallback uses 600 seconds; `wakeIfNoActivityAfterSeconds:null` disables that default, and `waitForInput:true` keeps the wait input-dominated. `timeoutSeconds` and source-less waits are rejected. Session targets resolve through the Main-owned catalog/topology service, while exec ownership is checked against the exact process-local exec runtime. The fallback schedules the existing wait-timeout event and does not cancel an active exec.
- `tool_session` replaces the old `list_sessions` tool and owns the display-name request while Main owns the resulting catalog metadata. With omitted args or `action:"status"`, it returns the same status fields as `/status` using `src/sessionStatus`: agent id/name, agent dir, session id, parent id, token/image estimate, last usage (with optional reasoning tokens displayed inside output rather than added to total), auto-compact threshold, current node, current cwd/default cwd, canonical runtime-state summary, and up to 10 recent child sessions. Status accepts an optional `sessionId`; the exact current owner uses the passed Session, while another target uses the SessionRuntime projection and a Worker routes through the closed Main-management read boundary without hydrating a Worker stub or accidentally reusing the caller Session. Target status carries the target history and persistent-memory snapshot into the shared token/image estimate. Missing targets fail explicitly, and status formatting does not create a Session as a fallback. Isolated sessions may query only their current ID or own alias; cross-target status is rejected, and parent updates retain the existing non-isolated management boundary. With `action:"list"`, it filters to the source Session Agent by default (or accepts explicit `scope:"all"`) before the existing pagination (`start`, `count`) and row formatting; with `action:"update-display-name"`, it sets or clears a display name through the Main-owned catalog operation and reports the previous/resulting values or an explicit no-op. With `action:"update-parent"`, `parentSessionId` is required and must be an existing non-empty Session ID or null; the operation changes only the parent relation and returns the target, previous parent, and resulting parent IDs. Worker callers route it through Main's closed management operation, reusing `sessionManager.setSessionParent` relation/cycle/claim behavior. Isolated sessions may use owner-local status but not list/update-display-name/update-parent.
- `tool_submit_compact_plan` remains guarded outside dedicated compaction, but its model-facing schema now includes `preserveMessages` and `removePreservedMessages` for compact-time raw-message preservation/removal handled by `src/session/compactPlan` and `src/session/history`.
- `tool_send_to_session` delegates to session relations, accepts `<main>` / `<parent>` special target ids, and cannot target the current/source session itself; self-send errors include current/requested/resolved IDs and remind agents that messages to the current session's direct user should be ordinary assistant text instead.
- `send_to_session` and `create_child_session` expose `afterSend:"continue" | "finish" | "wait"`. `finish` is the completed-child report path and stops idle without wait state, including when a sibling tool fails; both terminal child-creation modes await any initial delivery, while `wait` additionally requires a non-empty message and records resolved targets. Hidden legacy stop/wait booleans remain runtime-readable but are absent from the model schema. Canonical orchestration: [D-pipeline-handoff-wait](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait).
- `tool_skill({ action: "load" })` is progressive-disclosure oriented: it returns `SKILL.md` plus skill directory/resource-path guidance, not full companion resources. The list/load actions share the same resolution, and isolated sessions may use them for their own agent only.
- `create_child_session.displayName` optionally sets the new child's display name in the initial fork/non-fork Session and Main-owned catalog persistence, before any initial message delivery. It does not change the allocated session ID or inherit the parent's name when omitted. Like `create_session` creation, string values are stored as supplied (including `""` or surrounding spaces); non-string values are rejected before ID allocation. The existing display-name update action separately trims/clears names.
- Path resolution expands `~` and resolves relative paths against the agent directory or session CWD.
- All mutating tools check isolation status via `requireNotIsolated` before proceeding.
- `delete_session` defaults to one target and shares the Main-owned lifecycle orchestrator with WebUI and `/session delete`. It detaches surviving direct children, preserves channel/busy/claim revalidation, and may tear down another exact Worker target through the fixed reverse operation. The canonical current source or any alias resolving to it is rejected before target preparation; there is no self-destruct protocol. Canonical semantics: [D-lifecycle-descendant-actions](../threads/session-lifecycle.md#d-lifecycle-descendant-actions).
- `move_session` reports the previous/resulting parent after identity success. If its optional post-move parent write fails, the result explicitly says the identity move committed and the requested parent was not confirmed; canonical semantics: [D-lifecycle-identity-move-relations](../threads/session-lifecycle.md#d-lifecycle-identity-move-relations).
- Goal setting normalizes text, resolves remind-every defaults, and persists to session state.
- `create_child_session` and `create_session` accept intentional model-facing overrides only through optional `forceModel: { modelId?, effort? }`. Omission or `{}` preserves existing inheritance/default behavior; removed top-level `model`/`effort`, every other unknown top-level key, malformed objects, and unknown nested keys are rejected before creation effects. Local raw handlers and Main-management use the same closed non-mutating argument normalizers. `create_child_session.node` remains a semantic argument through canonical resolution and Main authorization: omission inherits the parent's current Node, while an accepted explicit value becomes the child's current Node. Effort-only forcing applies to the otherwise inherited/resolved model through the existing atomic normalizer. `set_session_child_model` remains the separate future-child settings surface. Canonical dispatch ownership: [D-dispatch-resolved-target](../threads/tool-dispatch.md#d-dispatch-resolved-target). Canonical model semantics: [D-model-routing-effort](../threads/model-routing.md#d-model-routing-effort).
- `tool_compact_session` starts async-capable snapshot planning immediately without a compact-planning queue item; for a busy `asyncCompact:false` target it reports that the target must become idle first. Only ready compact commits use the queue safe point.
- Timer create/update delegates to the `timers` module and returns formatted summaries; list/delete remain scoped by current or explicit session ID.

## Integration

- These tool functions are authoritative raw handlers. Most are invoked directly by the builtin dispatcher; Main-owned messaging/timer/catalog operations plus Worker cross-session recall/archive reads, agent/session creation, other-target session deletion, and node bootstrap/pairing use the closed Main Management RPC service. Agent creation may derive only from the exact current detached Worker source; source conversion and explicit another-source creation remain fenced.
- Relies on `sessionManager` as the central persistence and session lifecycle layer.
- Archive guard logic protects the context window from oversized retrievals, forcing the agent to narrow queries iteratively.
- Isolation checks integrate with the node system to enforce sandboxing for agents running on specific nodes.
- The `__toolLoopControl` return shape is consumed by the orchestration layer to halt or continue the agent turn loop.

## Design Decisions

- [2026-08-01] Every successful `get_session_messages` response must include the target session's execution state via the shared `buildSessionRuntimeState` and `formatSessionRuntimeStateSummary` path, including empty and fully filtered pages. Keep the four-state runtime taxonomy canonical rather than defining retrieval-specific labels; append only a nonzero queue count when the compact summary would otherwise omit pending work.

- [2026-07-22] Rename the shared literal result filter on `recall` and `get_session_messages` from ambiguous `query` to `contentFilter`. It is explicitly a case-insensitive post-filter after target/page/vector retrieval; `target` owns exact CTX-BLOCK/range selection and `vector_query` owns semantic search. Do not preserve old `query` compatibility: reject it clearly. Report staged literal/include/exclude exclusion counts, and preserve the count/omit-filter hint even for zero-result or truncated previews.

### D-message-preview-timestamps

Message previews use persisted `Message.__meta.timestamp`, with a valid authoritative Archive row timestamp taking precedence and the persisted Message timestamp as fallback for raw Archive rows. Only finite numeric values representable by `Date` are timed. Each displayed message shows local time to seconds and the numeric UTC offset. The first displayed message/page shows its full local date; only the immediately preceding displayed message on the same local day permits date elision. Missing/invalid message times remain untimed, reset comparison, and never use wall-clock time or body/wrapper parsing.

The shared renderer applies this comparison after filters, result selection and clipping. Grouped raw vector windows retain generated heading spans so the first surviving row keeps its date even when match-centered snippets omit earlier rows. Date removal only shortens the bounded output and never modifies matching body text. `/messages` uses the same time state with a fresh state per page. Archived CTX-BLOCK ranges, canonical messages, Archive storage, provider serialization and WebUI Timeline timing are unchanged.

### D-session-tool-list-scope

[2026-07-02, updated 2026-09-28] The old model-facing `list_sessions` builtin is removed rather than compatibility-wrapped. The replacement is the default model-facing `session` tool: `session()` / `session({action:"status"})` for current status, and `session({action:"list", start, count, scope?})` for catalog listing. List defaults to the calling Session's Agent; only explicit `scope:"all"` retains the previous global view. Filter before pagination to keep offsets and totals consistent. The existing list permission and isolation checks remain unchanged; the scope option is not a grant and does not alter WebUI lists.
- [2026-07-02] `/status` and `session({action:"status"})` must share the same status information source/formatter (`src/sessionStatus`) and expose the union of old `/status` fields plus the new tool fields: agent id/name, agent dir, session id, parent id, model, message/token/image status, last usage, last message time, effective auto-compact threshold, current node/connection, current cwd/default cwd, busy/queue state, and recent child sessions.
- [2026-08-26] Session status/list distinguishes all-session, any-session, exec, input, and fallback waits. Current model calls must declare a real source/fallback; legacy persisted source-less waits remain readable without acquiring current quiescence semantics.
