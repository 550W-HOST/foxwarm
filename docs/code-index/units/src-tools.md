# Unit: src-tools

Files: src/tools.ts (facade), src/tools/resolvedTools.ts, src/tools/placement.ts, src/tools/helpers.ts, src/tools/fileTools.ts, src/tools/memoryTools.ts, src/tools/execTools.ts, src/tools/imageTools.ts, src/tools/browserTools.ts, src/tools/mcpTools.ts, src/tools/nodeTools.ts, src/tools/vectorTools.ts, src/tools/unifiedSearch.ts, src/tools/definitions.ts, src/tools/placement.test.ts, src/tools/applyPatchOutput.test.ts, src/utils/pathResolve.ts
Secondary files: src/tools/unifiedTools.test.ts, src/sessionWorkerToolPlacement.test.ts

## Purpose

Implements the core tool registry and execution layer for the agent system. Defines all built-in tool definitions (parameters, descriptions, permissions), dispatches tool calls to their implementations, and manages file I/O, command execution, memory operations, MCP integration, node management, and session/agent orchestration.

## Key Exports (from src/tools.ts facade)

- `definitions` — Array of all tool definition objects (from `tools/definitions.ts`)
- `modelFacingDefinitions` — Subset of definitions directly exposed to the model
- `callTool(toolName, args, context)` — Main dispatcher that routes tool calls to implementations
- `assertToolAvailableForPlacement(toolName, args, context)` — trusted-placement pre-handler fence; Worker-unsupported operations fail retryably before raw singleton/lifecycle code.
- The closed Main Management wrappers cover messaging/timers/catalog operations plus Worker cross-session recall/archive reads, Main-owned agent/session creation, other-target session deletion, and node bootstrap/pairing.
- `BUILTIN_TOOL_PLACEMENTS` — Exhaustive ownership metadata for every registered builtin, independent of schemas and permission rules.
- `NODE_ENVIRONMENT_BUILTIN_NAMES` — Intentional current-node environment primitive names.
- `resolveBuiltinToolPlacement(name, args, currentNode)` — Resolves action-aware ownership and the current execution node.
- `isToolDirectlyExposedToModel(toolName)` — Check if a tool has `defaultInject: true`
- `getToolPermissionNode(toolName, executionNode, targetNode)` — Determine which node governs permission for a tool call
- `resolveMemorySearchOptions` — Scope/lineage helper used by `recall({ vector_query })` to constrain semantic retrieval before archive back-resolution; an exact trusted current owner supplies source identity/aliases directly.

## Function Index

### tools/helpers.ts — Shared types and utilities
| Function | Description |
|----------|-------------|
| `getPendingWriteScopeKey` | Builds scope key for pending write ref isolation |
| `prunePendingWriteRefs` | Evicts expired/oversized entries from pending write cache |
| `registerPendingWriteRef` | Stores content for deferred file writes with TTL |
| `peekPendingWriteRefContent` | Retrieves pending write content after validating its session/agent scope without consuming it |
| `expandHomePath` | Expands `~` prefix to OS home directory |
| `resolveAgentPath` | Re-export from `src/utils/pathResolve.ts`; resolves relative/absolute/home paths against session cwd or the agent directory |
| `resolveAgentMemoryPath` | Resolves paths within agent memory directory |
| `readResolvedPath` | Master wrapper around shared `readFileToolPath`; reads file/directory/image and treats start/end line 0 as omitted |
| `writeResolvedPath` | Master wrapper around shared `writeFileToolPath`; writes content with overwrite and parent-directory checks |
| `editResolvedPath` | Applies exact text replacement in a file |
| `deleteResolvedPath` | Deletes a file (refuses directories) |
| `applyPatchOperations` | Applies structured patch (add/update/delete) operations |
| `applyExactReplacement` | Single-match regex replacement with validation |

### tools/fileTools.ts — File read/write/edit/patch/delete
| Function | Description |
|----------|-------------|
| `tool_read` | Reads a file with optional line range |
| `tool_write` | Writes content, supports contentRef for large writes, and can explicitly create parent dirs with `createDirs=true` |
| `tool_edit` | Exact text replacement in a file |
| `tool_apply_patch` | Applies structured patch edits to files |

### tools/memoryTools.ts — Agent memory operations
| Function | Description |
|----------|-------------|
| `tool_read_memory` | Reads a memory file |
| `tool_write_memory` | Creates a new memory file |
| `tool_edit_memory` | Edits a memory file in place |
| `tool_delete_memory` | Deletes a memory file |
| `tool_apply_patch_memory` | Applies patch edits to memory files |

### tools/execTools.ts — Shell command execution
| Function | Description |
|----------|-------------|
| `tool_exec` | Executes shell commands with timeout and background support |

### tools/imageTools.ts — Image operations
| Function | Description |
|----------|-------------|
| `tool_image_crop` | Crops a region from a referenced image |
| `tool_image_write_to_file` | Writes a referenced image to disk |

### tools/browserTools.ts — Headless browser
| Function | Description |
|----------|-------------|
| `tool_browse_open` | Opens a URL in headless browser |
| `tool_browse_list` | Lists open browser tabs |
| `tool_browse_get` | Gets content or screenshot from a tab |
| `tool_browse_close` | Closes a browser tab |
| `tool_browse_interact` | Interacts with a browser tab (click, type, etc.) |

### tools/mcpTools.ts — MCP server integration
| Function | Description |
|----------|-------------|
| `tool_mcp_config` | Configures MCP server connections and an optional bounded per-server tool-call timeout (`0` clears to SDK default) |
| `tool_list_mcp_servers` | Lists configured MCP servers |

### tools/nodeTools.ts — Remote node management
| Function | Description |
|----------|-------------|
| `tool_node` | Dispatches model-facing registered-node list/select actions |
| `tool_list_nodes` | Lists registered nodes and marks the session's current node |
| `tool_change_current_node` | Changes the session's current execution node |
| `tool_copy_between_nodes` | Copies files between nodes |
| `tool_node_bootstrap_info` | Generates bootstrap info for node pairing |
| `tool_node_pair_approve` | Approves a pending node pairing request |
| `tool_node_pair_list` | Lists pending node pairing requests |

### tools/vectorTools.ts — Vector recall scope utilities
| Function | Description |
|----------|-------------|
| `resolveMemorySearchOptions` | Resolves scope/session/agent for vector search from a trusted current owner or Main-local detached read source, using catalog-only lookup for explicit other targets |

### tools/unifiedSearch.ts — Unified tool search/call
| Function | Description |
|----------|-------------|
| `tool_search_tools` | Unified search across builtin, MCP, and node tool sources |
| `tool_call_tool` | Parses the unified call surface and delegates to the canonical resolved-tool executor |

### tools/resolvedTools.ts — Canonical invocation resolution
| Function | Description |
|----------|-------------|
| `resolveDirectTool` | Resolves direct provider invocations into one builtin or Node operation |
| `resolveUnifiedTool` | Resolves `call_tool` IDs/descriptors; omitted Node IDs use the current target and builtin aliases for Node capabilities are rejected |
| `executeResolvedTool` | Authorizes the resolved concrete target and dispatches through local, Node, or MCP owners; `call_tool` itself is permission-neutral |
| `buildUnifiedToolId` | Constructs the source-qualified identifier used by discovery |

### tools/definitions.ts — Tool definition array
| Export | Description |
|--------|-------------|
| `definitions` | Array of all tool definition objects (schemas, descriptions, permissions) |

### tools/placement.ts — Process-placement ownership
| Export | Description |
|--------|-------------|
| `BUILTIN_TOOL_PLACEMENTS` | Typed exhaustive map across node-environment, session-owner, main-management, external-service, and dispatcher/container owners |
| `resolveBuiltinToolPlacement` | Resolves mixed action metadata and routes only node-environment builtins to `currentNode` |
| `NODE_ENVIRONMENT_BUILTIN_NAMES` | Stable derived list used by parity tests against applicable CLI-node capabilities |

## Dependencies

- `./vector` — Vector/semantic search operations used internally by `recall({ vector_query })`
- `./sessionManager` — Session lifecycle management
- `./session/archiveStore` — `getVectorSearchLineage` for archive retrieval
- `./tokenCount` — `estimateTokenCount` for budget enforcement
- `./config` — `WORKSPACE_DIR`, `getAgentDir`, `getAgentMemoryDir`
- `./isolatedCheck` — `checkPathAccess`, `checkToolPermission` for sandboxing
- `./mcpClient` — MCP server communication
- `./browser` — `browserManager` for headless browser tools
- `./nodes/manager` — `nodesManager` for remote node orchestration
- `./nodes/bootstrapInfo` — Node pairing/bootstrap utilities
- `./execManager` — Persistent command execution lifecycle
- `./applyPatch` — Structured file patch application
- `../../packages/shared/dist/fileToolCore` — shared read/write file tool core reused by master and node wrappers
- `../../packages/shared/dist/fileOperations` — native low-level file backend and injectable `FileOperations` contract
- `./session/compactPlan` — `COMPACT_PLAN_TOOL_DEFINITION`
- `./toolImages` — Image reference resolution and cropping
- `./jsonObjectArgs` — Argument parsing helpers
- `./toolscript` — Toolscript run/continue/list/cancel tools
- `./toolsSessionAgent` — Session, agent, timer, and channel management tools
- `./mainManagementTools` — local versioned RPC caller for the first closed main-owned tool set
- `./nodeExecution` — local versioned RPC caller used by direct/unified Node placement and dynamic Node calls; explicit master Node calls remain local and canonical-set-only

## Behavior

- **File access control**: File wrappers resolve targets with `resolveAgentPath`, then enforce `checkPathAccess` before I/O.
- **Shared read/write core**: After master-specific path resolution, isolation checks, and `contentRef` handling, `readResolvedPath` / `writeResolvedPath` delegate file/directory/image read and write-parent semantics to `packages/shared/src/fileToolCore.ts`. Main explicitly selects the native low-level backend unless an internal exact ToolContext supplies another backend; public tool names, schemas, path policy, and output/error contracts are unchanged.
- **Read range placeholders**: `startLine` / `endLine` values of `0` are treated as omitted for file and directory reads, so provider-emitted optional numeric placeholders do not produce empty reads.
- **Bounded file reads**: Master and remote non-image reads share `fileToolCore` bounded display behavior. Large source files retain only bounded samples before model output handling, while finite line ranges stream only to their endpoint; use ranges for targeted content. Canonical contract: [D-bounded-file-read-excerpts](./shared-node-tools.md#d-bounded-file-read-excerpts).
- **Write parent dirs**: `write` requires parent directories to already exist by default. Passing `createDirs=true` explicitly creates missing parent directories. The shared core first attempts the actual write, then diagnoses parent-path failures so symlinked parent directories work normally. Missing-parent failures report the first missing parent path and, when possible, return a `contentRef` retry hint so large content can be reused.
- **Pending write refs**: Large file writes that fail validation produce a `contentRef` token cached in memory (TTL 15 min, max 2 MB per entry, 8 MB total). A ref remains limited to its exact session and agent but may write the cached payload to the original target or any different target that independently passes ordinary path resolution, isolation checks, overwrite/createDirs policy, and target-local file operations. Failed retries retain the ref; a successful write consumes it. Failure guidance provides an executable `write({ ... })` retry call with the actual escaped failing path, reference, and required flags, explicitly tells the model not to include the mutually exclusive `content` argument because the attempted content is already cached, explains authorized alternate-path reuse, and directs intentional content corrections to omit `contentRef` and submit only the new content plus the desired path and required flags.
- **Command execution**: `tool_exec` delegates to `execManager` for persistent processes with configurable timeouts, foreground/background modes, and working-directory tracking. Its schema has no hard maximum so finite requests above 60 seconds reach the shared resolver, clamp to 60, and produce a warning in the immediate result footer; minimum/finite validation remains strict. Inline display is already bounded, so model guidance tells agents not to add `head`/`tail` merely for context control: a filtering pipeline changes the captured command output. The master description also reminds agents that a timed-out process remains outstanding while they continue other work; this stays aligned with node guidance under [D-persistent-exec-background-timeout-footer-tree](./shared-persistent-exec.md#d-persistent-exec-background-timeout-footer-tree). Canonical capture/excerpt semantics: [D-persistent-exec-bounded-log-excerpts](./shared-persistent-exec.md#d-persistent-exec-bounded-log-excerpts).
- **Exec cwd sync notice**: When a command changes the session cwd, the `exec` tool appends a `SESSION CWD CHANGED` notice at the end of the tool output and states that the new cwd becomes the default for later `exec/read/edit/write/apply_patch` calls. Parallel segments defer this mutation/notice until every segment member settles, then replay it in model order before the next barrier under [D-dispatch-exec-parallel-segments](../threads/tool-dispatch.md#d-dispatch-exec-parallel-segments).
- **Placement versus permissions**: Process-placement ownership is exhaustive metadata in `tools/placement.ts`; isolation remains independently enforced by `checkToolPermission` plus tool-local guards.
- **Canonical resolved dispatch**: Direct provider calls, unified `call_tool`, and ToolScript nested calls resolve through `resolvedTools.ts`. Capability source, execution target, and process/service ownership stay separate. `call_tool` is a permission-neutral dispatcher/container and only the independently resolved concrete identity is authorized; MCP then retains its authoritative Main service recheck. Recursive `builtin:call_tool` target selection is rejected, while the top-level provider-facing interface remains registered. Local calls retain the exact outer ToolContext and current Session owner. Direct node-environment names and `source=node` use the same current-target routing; `source=builtin` rejects those names. Static node-environment capabilities retain the existing tool permission check. Custom advertised remote-node tools rely on the shared Node service's exact source/bound-target/advertised-tool guard in both Main-local and Worker reverse placement, preserving isolated bound-node capability access without general policy configuration.
- **Worker placement fences**: Current-session effects carry a trusted internal local/Session-worker marker into direct and nested ToolContexts. Exact current status/archive/settings and current-session/current-agent recall remain in the Worker owner. Cross-session recall/archive reads, agent/session creation, other-target `delete_session`, and node bootstrap/pairing route through the fixed Main-management facade; delete rejects canonical source/alias self-targets before effect. Source conversion, identity move/rename, and agent-wide snapshot-affecting inheritance/isolation changes remain retryable pre-handler failures. Exact tool-rule replacement on an unchanged isolation binding is the narrow metadata-only exception; Workers refresh the current agent before authorization/discovery. The detached Main recall path preserves isolation/agent scope, total preview bounds, exact archive source reload, and the selected vector facade. Cross-session control/settings, `stop_session` beyond the current session, and managed ToolScript paths remain fenced. Worker selection never falls back to Main hydration or performs a stale catch-time rollback after the authoritative persistence hook may have resynced/poisoned the hot owner.
- **Context retrieval**: `recall` is the single model-facing entry point for exact archive drill-down (`target`) and semantic vector retrieval (`vector_query`). `search_vector` / `search_memory` are removed rather than compatibility-wrapped. `recall` and `get_session_messages` share a context preview renderer with total-budget `previewLength`, tool folding, and staged `contentFilter`/regex result post-filtering. `get_session_messages` additionally reports the target session's canonical execution-state summary on every successful response. Their old literal `query` field is absent from model-facing schemas and explicitly rejected at runtime.
- **Consolidated resource tools**: `session` owns status/list/update-display-name, `skill` owns list/load, and `node` owns list/select. Removed internal names and superseded action aliases are absent from definitions/runtime exports; the canonical consolidation decision is [D-tools-resource-action-consolidation](../modules/tools-and-permissions.md#d-tools-resource-action-consolidation).
- **Wait guidance and runtime metadata**: `wait` is described to models as pausing until new session activity rather than polling, with active-turn input joining only at normal queue safe points and source boundaries; the canonical contract is [D-pipeline-activity-wait](../threads/message-processing-pipeline.md#d-pipeline-activity-wait). It supports `waitExecIds?: string[]` as advisory metadata for runtime-state display (`waiting:exec`). `wait({})` and `wait({ waitAllSessions: [] })` remain equivalent ordinary waits and are rendered as `idle` by status/UI. A non-empty `waitAllSessions` value must normalize to at least two distinct IDs because it is reserved for a real all-session report barrier.
- **Atomic handoff wait**: `send_to_session` and `create_child_session` expose exact optional `waitAfterHandoff` booleans with no compatibility alias. Successful flagged handoffs finish the turn and wait for new session activity after the batch is visible; failures do not, while reply delivery is unchanged for both boolean values. The resulting wait is not target-filtered and does not wait for task completion. The older handoff plus explicit `wait` sequence remains supported. Canonical contract: [D-pipeline-handoff-wait](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait).
- **Compact plan submission**: `submit_compact_plan` remains model-facing across normal and compact phases. Its required `replaceAsBlocks` accepts the preferred direct block array or a JSON string encoding the same array, with optional block-associated `memoryFacts`; compact-only `preserveMessages` / `removePreservedMessages` remain direct arrays for exact raw-message preservation/removal in active history.
- **MCP result pass-through**: MCP result cleanup is owned by `src/mcpClient.callTool`; unified `call_tool` passes the normalized value onward, so ToolScript and unified calls receive parsed object/array values for single-text JSON responses without MCP-specific branches. MCP discovery and invocation are available only through `search_tools` and `call_tool` (`toolId: "mcp:<server>/<tool>"` or `source:"mcp"`).
- **MCP configuration disclosure**: `mcp_config` and `list_mcp_servers` remain registered hidden builtins invoked through `call_tool`; the bundled `mcp-management` skill provides setup guidance without injecting their schemas into ordinary provider requests. Managed live-snapshot semantics are canonical in [D-dispatch-mcp-live-configuration](../threads/tool-dispatch.md#d-dispatch-mcp-live-configuration).
- **Model-facing schema validity**: Default-injected tool definitions are the single schema source passed to providers. Every top-level property in a model-facing tool must have a concrete schema shape (`type`, `enum`, or composition keywords), because OpenAI Responses rejects description-only properties.
- **Model effort schemas**: `create_child_session` and `create_session` expose optional canonical effort values, while the existing `set_session_child_model` schema owns future-child model/effort inspection and mutation. Canonical semantics: [D-model-routing-effort](../threads/model-routing.md#d-model-routing-effort).
- **Memory operations**: Read/write/edit/delete/patch operations target per-agent memory directories. These file CRUD operations do not automatically update the session-archive vector index.
- **Patch result summaries**: Master file and memory patch wrappers use the shared per-operation formatter for per-file add/update counts, including operations listed after a partial failure; the count contract is canonical in [D-apply-patch-change-counts](./shared-apply-patch.md#d-apply-patch-change-counts).

## Integration

- Consumed by the session runtime (via `callTool`) as the execution backend for all model-requested actions.
- Tool definitions are surfaced to the model through `modelFacingDefinitions` for function-calling schemas.
- Interacts with `sessionManager` and `toolsSessionAgent` for multi-session orchestration (child sessions, channels, timers).
- Connects to remote nodes through `nodesManager` for distributed execution.
- Integrates with MCP servers for extensible external tool access.
- Uses `execManager` for long-running shell processes with lifecycle tracking.
- Browser tools delegate to `browserManager` for web automation capabilities.

## Design Decisions

### D-tools-write-contentref-target-reuse

[2026-08-19] A pending `contentRef` is a short-lived cached payload capability scoped to one exact session and agent, not to the path whose failed write created it. A retry may choose any `filePath` that independently passes ordinary resolution, isolation/path authorization, overwrite/createDirs policy, structural service placement, and the selected target-local file backend before any filesystem effect. A failed retry retains the ref for another attempt; only a successful write consumes it. Do not extend refs across sessions, agents, processes, or content replacement.

### D-tools-write-contentref-retry-guidance

[2026-07-24, updated 2026-08-19] Pending-write retry guidance must show a directly executable cached retry `write({ ... })` call containing the actual JSON-escaped failing `filePath`, `contentRef`, `overwrite: true`, and `createDirs: true` when required. State directly that the attempted content is already cached, that the same-session/same-agent ref may instead target another independently authorized `filePath`, and that the model must not include or pass the mutually exclusive `content` argument when using `contentRef`. If the model intentionally corrects or replaces the attempted content, instruct it to omit `contentRef` and call `write` with only the newly generated content plus the desired path and required flags. Never permit both content sources in one call, and do not rely only on indirect wording about generating or sending content again.

- [2026-07-22] Model-facing archive retrieval schemas must distinguish `target`, `vector_query`, and `contentFilter`; do not retain the old ambiguous `query` field for `recall` or `get_session_messages`.

- [2026-07-11] Keep the exec schema's minimum of 1 second but remove its hard maximum. Document 60 seconds as the maximum effective timeout, clamp larger finite requests at runtime, and keep the warning outside truncatable command output.
- [2026-06-05] Ordinary fixed-schema tools no longer expose generic `node` arguments. Session current-node routing and explicit target-bearing tools determine the execution node; special multi-node tools keep explicit source/target node arguments.
- [2026-07-02] `list_sessions` remains removed rather than compatibility-wrapped; current resource-action ownership is canonical in [D-tools-resource-action-consolidation](../modules/tools-and-permissions.md#d-tools-resource-action-consolidation).
- [2026-07-07] Keep `wait({})` as a valid model-facing control tool call. `waitAllSessions` and `waitExecIds` improve synchronization/status labels but are not required arguments.