# Unit: src-tools

Files: src/tools.ts (facade), src/tools/helpers.ts, src/tools/fileTools.ts, src/tools/memoryTools.ts, src/tools/execTools.ts, src/tools/imageTools.ts, src/tools/browserTools.ts, src/tools/mcpTools.ts, src/tools/nodeTools.ts, src/tools/vectorTools.ts, src/tools/unifiedSearch.ts, src/tools/definitions.ts, src/tools/applyPatchOutput.test.ts, src/utils/pathResolve.ts

## Purpose

Implements the core tool registry and execution layer for the agent system. Defines all built-in tool definitions (parameters, descriptions, permissions), dispatches tool calls to their implementations, and manages file I/O, command execution, memory operations, MCP integration, node management, and session/agent orchestration.

## Key Exports (from src/tools.ts facade)

- `definitions` — Array of all tool definition objects (from `tools/definitions.ts`)
- `modelFacingDefinitions` — Subset of definitions directly exposed to the model
- `callTool(toolName, args, context)` — Main dispatcher that routes tool calls to implementations
- `MASTER_ONLY_TOOL_NAMES` — List of tool names restricted to master-level sessions
- `isMasterOnlyToolName(toolName)` — Check if a tool is master-only
- `isToolDirectlyExposedToModel(toolName)` — Check if a tool has `defaultInject: true`
- `getToolPermissionNode(toolName, executionNode, targetNode)` — Determine which node governs permission for a tool call
- `resolveMemorySearchOptions` — Scope/lineage helper used by `recall({ vector_query })` to constrain semantic retrieval before archive back-resolution.

## Function Index

### tools/helpers.ts — Shared types and utilities
| Function | Description |
|----------|-------------|
| `getPendingWriteScopeKey` | Builds scope key for pending write ref isolation |
| `prunePendingWriteRefs` | Evicts expired/oversized entries from pending write cache |
| `registerPendingWriteRef` | Stores content for deferred file writes with TTL |
| `consumePendingWriteRef` | Retrieves and removes a pending write ref, validating scope/path |
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
| `tool_delete_file` | Deletes a single file |

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
| `tool_mcp_config` | Configures MCP server connections |
| `tool_search_mcp_tools` | Searches available MCP tools |
| `tool_list_mcp_servers` | Lists configured MCP servers |

### tools/nodeTools.ts — Remote node management
| Function | Description |
|----------|-------------|
| `tool_remote_node` | Lists nodes/tools or calls a tool on a remote node |
| `tool_node` | Dispatches model-facing registered-node list/select actions |
| `tool_list_nodes` | Lists registered nodes and marks the session's current node |
| `tool_change_current_node` | Changes the session's current execution node |
| `tool_copy_between_nodes` | Copies files between nodes |
| `tool_node_bootstrap_info` | Generates bootstrap info for node pairing |
| `tool_node_pair_approve` | Approves a pending node pairing request |
| `tool_node_pair_list` | Lists pending node pairing requests |

### tools/vectorTools.ts — Vector helper/context utilities
| Function | Description |
|----------|-------------|
| `tool_get_memory_context` | Retrieves messages around a specific timestamp |
| `resolveMemorySearchOptions` | Resolves scope/session/agent for vector search |

### tools/unifiedSearch.ts — Unified tool search/call
| Function | Description |
|----------|-------------|
| `tool_search_tools` | Unified search across builtin, MCP, and node tool sources |
| `tool_call_tool` | Unified tool call dispatcher for builtin, MCP, and node targets |
| `setDefinitionsRef` | Wires definitions reference for builtin search |
| `buildUnifiedToolId` | Constructs a unified tool identifier string |

### tools/definitions.ts — Tool definition array
| Export | Description |
|--------|-------------|
| `definitions` | Array of all tool definition objects (schemas, descriptions, permissions) |

## Dependencies

- `./vector` — Vector/semantic search operations used internally by `recall({ vector_query })` and memory context helpers
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
- `./session/compactPlan` — `COMPACT_PLAN_TOOL_DEFINITION`
- `./toolImages` — Image reference resolution and cropping
- `./jsonObjectArgs` — Argument parsing helpers
- `./toolscript` — Toolscript run/continue/list/cancel tools
- `./toolsSessionAgent` — Session, agent, timer, and channel management tools

## Behavior

- **File access control**: File wrappers resolve targets with `resolveAgentPath`, then enforce `checkPathAccess` before I/O.
- **Shared read/write core**: After master-specific path resolution, isolation checks, and `contentRef` handling, `readResolvedPath` / `writeResolvedPath` delegate file/directory/image read and write-parent semantics to `packages/shared/src/fileToolCore.ts`.
- **Read range placeholders**: `startLine` / `endLine` values of `0` are treated as omitted for file and directory reads, so provider-emitted optional numeric placeholders do not produce empty reads.
- **Bounded file reads**: Master and remote non-image reads share `fileToolCore` bounded display behavior. Large source files retain only bounded samples before model output handling, while finite line ranges stream only to their endpoint; use ranges for targeted content. Canonical contract: [D-bounded-file-read-excerpts](./shared-node-tools.md#d-bounded-file-read-excerpts).
- **Write parent dirs**: `write` requires parent directories to already exist by default. Passing `createDirs=true` explicitly creates missing parent directories. The shared core first attempts the actual write, then diagnoses parent-path failures so symlinked parent directories work normally. Missing-parent failures report the first missing parent path and, when possible, return a `contentRef` retry hint so large content can be reused.
- **Pending write refs**: Large file writes that fail validation produce a `contentRef` token cached in memory (TTL 15 min, max 2 MB per entry, 8 MB total). Failure guidance provides an executable `write({ ... })` retry call with the actual escaped path, reference, and required flags, explicitly tells the model not to include the mutually exclusive `content` argument because the attempted content is already cached, and directs intentional content corrections to omit `contentRef` and submit only the new content plus required path/flags.
- **Command execution**: `tool_exec` delegates to `execManager` for persistent processes with configurable timeouts, foreground/background modes, and working-directory tracking. Its schema has no hard maximum so finite requests above 60 seconds reach the shared resolver, clamp to 60, and produce a warning in the immediate result footer; minimum/finite validation remains strict. Inline display is already bounded, so model guidance tells agents not to add `head`/`tail` merely for context control: a filtering pipeline changes the captured command output. The master description also reminds agents that a timed-out process remains outstanding while they continue other work; this stays aligned with node guidance under [D-persistent-exec-background-timeout-footer-tree](./shared-persistent-exec.md#d-persistent-exec-background-timeout-footer-tree). Canonical capture/excerpt semantics: [D-persistent-exec-bounded-log-excerpts](./shared-persistent-exec.md#d-persistent-exec-bounded-log-excerpts).
- **Exec cwd sync notice**: When a command changes the session cwd, the `exec` tool appends a `SESSION CWD CHANGED` notice at the end of the tool output and states that the new cwd becomes the default for later `exec/read/edit/write/apply_patch` calls. Parallel segments defer this mutation/notice until every segment member settles, then replay it in model order before the next barrier under [D-dispatch-exec-parallel-segments](../threads/tool-dispatch.md#d-dispatch-exec-parallel-segments).
- **Permission gating**: Tools are partitioned into master-only vs. general, and isolated sessions are restricted by the current `checkToolPermission` rule set plus tool-local guards.
- **Unified tool dispatch**: `search_tools` and `call_tool` provide a single interface across builtin, MCP, and remote-node tool sources. The resolved target still passes its normal isolation and tool-local checks.
- **Context retrieval**: `recall` is the single model-facing entry point for exact archive drill-down (`target`) and semantic vector retrieval (`vector_query`). `search_vector` / `search_memory` are removed rather than compatibility-wrapped. `recall` and `get_session_messages` share a context preview renderer with total-budget `previewLength`, tool folding, and staged `contentFilter`/regex result post-filtering. `get_session_messages` additionally reports the target session's canonical execution-state summary on every successful response. Their old literal `query` field is absent from model-facing schemas and explicitly rejected at runtime.
- **Consolidated resource tools**: `session` owns status/list/rename, `skill` owns list/load, and `node` owns list/select. Removed internal names are absent from definitions/runtime exports; the canonical consolidation decision is [D-tools-resource-action-consolidation](../modules/tools-and-permissions.md#d-tools-resource-action-consolidation).
- **Wait runtime metadata**: `wait` supports `waitExecIds?: string[]` as advisory metadata for runtime-state display (`waiting:exec`). Generic `wait({})` remains valid and is rendered as `idle` by status/UI; the schema must not make wait targets required.
- **Atomic handoff wait**: `send_to_session` and `create_child_session` expose exact optional `waitAfterHandoff` booleans with no compatibility alias. Successful flagged handoffs request the existing generic any-event wait after the batch is visible; failures do not, while reply delivery is unchanged for both boolean values. The older handoff plus explicit `wait` sequence remains supported. Canonical contract: [D-pipeline-handoff-wait](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait).
- **Compact plan submission**: `submit_compact_plan` remains model-facing for schema stability and supports `createBlocksJson` entries with optional block-associated `memoryFacts`, plus compact-only `preserveMessages` / `removePreservedMessages` arrays for exact raw-message preservation/removal in the working frontier.
- **MCP result pass-through**: MCP result cleanup is owned by `src/mcpClient.callTool`; unified `call_tool` simply passes the normalized value onward, so ToolScript and direct unified calls receive parsed object/array values for single-text JSON responses without MCP-specific branches. Hidden `call_mcp` / `search_mcp_tools` runtime handlers remain for compatibility, while current model guidance uses `search_tools` and `call_tool` (`toolId: "mcp:<server>/<tool>"` or `source:"mcp"`).
- **MCP configuration disclosure**: `mcp_config` and `list_mcp_servers` remain registered hidden builtins invoked through `call_tool`; the bundled `mcp-management` skill provides setup guidance without injecting their schemas into ordinary provider requests. Managed live-snapshot semantics are canonical in [D-dispatch-mcp-live-configuration](../threads/tool-dispatch.md#d-dispatch-mcp-live-configuration).
- **Model-facing schema validity**: Default-injected tool definitions are the single schema source passed to providers. Every top-level property in a model-facing tool must have a concrete schema shape (`type`, `enum`, or composition keywords), because OpenAI Responses rejects description-only properties.
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

### D-tools-write-contentref-retry-guidance

[2026-07-24] Pending-write retry guidance must show a directly executable cached retry `write({ ... })` call containing the actual JSON-escaped `filePath`, `contentRef`, `overwrite: true`, and `createDirs: true` when required. State directly that the attempted content is already cached and instruct the model not to include or pass the mutually exclusive `content` argument when using `contentRef`. If the model intentionally corrects or replaces the attempted content, instruct it to omit `contentRef` and call `write` with only the newly generated content plus the required path/flags. Never permit both content sources in one call, and do not rely only on indirect wording about generating or sending content again.

- [2026-07-22] Model-facing archive retrieval schemas must distinguish `target`, `vector_query`, and `contentFilter`; do not retain the old ambiguous `query` field for `recall` or `get_session_messages`.

- [2026-07-11] Keep the exec schema's minimum of 1 second but remove its hard maximum. Document 60 seconds as the maximum effective timeout, clamp larger finite requests at runtime, and keep the warning outside truncatable command output.
- [2026-06-05] Ordinary fixed-schema tools no longer expose generic `node` arguments. Session current-node routing and explicit target-bearing tools determine the execution node; special multi-node tools keep explicit source/target node arguments.
- [2026-07-02] `list_sessions` remains removed rather than compatibility-wrapped; current resource-action ownership is canonical in [D-tools-resource-action-consolidation](../modules/tools-and-permissions.md#d-tools-resource-action-consolidation).
- [2026-07-07] Keep `wait({})` as a valid model-facing control tool call. `waitAllSessions` and `waitExecIds` improve synchronization/status labels but are not required arguments.