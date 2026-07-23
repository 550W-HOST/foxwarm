# Unit: shared-node-tools

Files: packages/shared/src/fileToolCore.ts, packages/shared/src/nodeTools.ts, packages/shared/src/nodeTools.test.ts, packages/shared/src/nodeCapabilities.ts, packages/shared/src/nodeFileTransfer.ts, packages/shared/src/execCwd.ts, packages/shared/src/index.ts, packages/shared/src/tokenCount.ts, packages/shared/src/toolResponseFormatting.ts, packages/shared/src/webuiToolRendering.ts, packages/shared/src/webuiToolRendering.test.ts
Secondary files: packages/shared/src/outputTruncation.ts, packages/shared/src/outputTruncation.test.ts

## Purpose

Provides shared file system tools, shell execution, browser automation, and utility functions used by node-side agents. These tools enable reading/writing/editing files, executing commands with background process support, browsing web pages via Puppeteer, and formatting tool responses.

## Key Exports

- `nodeTools` — aggregated object of all node tool functions (read, write, edit, apply_patch, exec, get_default_cwd, browse_*)
- `read`, `write`, `edit`, `apply_patch`, `exec`, `get_default_cwd` — file and shell tool functions
- `readFileToolPath`, `writeFileToolPath`, `readDirectoryListing`, `findWriteParentIssue`, `formatWriteParentIssueMessage` — shared file read/write core used by both master-side and node-side wrappers
- `browse_open`, `browse_list`, `browse_get`, `browse_close`, `browse_interact` — browser automation tools
- `buildBrowserScreenshotResult` — builds the current structured `inlineData` screenshot result without source-specific base64 fields
- `CLI_NODE_CAPABILITIES` — tool schema definitions for all node tools (used for LLM tool registration)
- `resolveNodePath`, `getNodeAgentDir`, `resolveNodeTransferPath` — path resolution utilities
- `readNodeTransferFile`, `writeNodeTransferFile` — base64 file transfer helpers
- `detectTransferMimeType` — MIME type detection for file transfers
- `resolveExecCwd`, `validateResolvedExecCwd`, `resolveValidatedExecCwd` — exec working directory resolution and validation
- `estimateTokenCount` — lightweight token count estimator
- `formatStructuredValue`, `formatToolResponsePayload`, `formatCompactObjectPreview` — YAML-based response formatting for model-facing and WebUI display paths
- Shared patch parsing, line-count, and per-operation summary helpers are re-exported from the package index.
- `truncateOutputForDisplay` — line-aware excerpt helper used by tool-output guard and persistent exec output formatting
- `parseSessionLinkText`, `shouldUseStreamingToolPlaceholder` — small pure helpers used by WebUI tool/text renderers and covered by shared Node tests

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `escapeRegExp(text)` | ~19 | Escapes special regex characters in a string |
| `applyExactReplacement(content, searchText, replaceText, label)` | ~21 | Replaces exactly one occurrence of text or throws |
| `normalizeOptionalLineBound(value)` (fileToolCore) | ~35 | Treats omitted/null/non-finite/0 line bounds as absent |
| `readDirectoryListing(fullPath, displayPath, startLine, endLine)` (fileToolCore) | ~65 | Reads and paginates a directory listing |
| `getInlineImageMimeType(filePath)` (fileToolCore) | ~120 | Detects image MIME types supported for inline read results |
| `readFileToolPath(fullPath, displayPath, startLine, endLine)` (fileToolCore) | ~126 | Reads file/directory/image; handles line ranges and 0-bound compatibility |
| `findWriteParentIssue(fullPath)` (fileToolCore) | ~158 | Returns the first missing/non-directory parent for write targets, following symlinked directories |
| `formatWriteParentIssueMessage(issue, retryHint)` (fileToolCore) | ~181 | Formats write parent errors consistently for master/node callers |
| `formatWriteContentRefRetryHint(filePath, contentRef, createDirs)` (fileToolCore) | ~26 | Formats an executable, JSON-escaped cached-content retry call for write failures |
| `writeFileToolPath(fullPath, content, options)` (fileToolCore) | ~205 | Attempts the real filesystem write first, then enriches parent-path failures with diagnostics |
| `resolveToolPath(filePath, ctx)` | ~27 | Resolves a node tool file path using session context |
| `read(args, ctx)` | ~107 | Tool: reads a file or directory |
| `write(args, ctx)` | ~112 | Tool: writes content to a file; requires existing parent dirs unless `createDirs=true` |
| `edit(args, ctx)` | ~120 | Tool: replaces exact text in a file |
| `applyPatchOperations(input, resolveOperationPath)` | ~127 | Applies multi-file patch operations (add/update) |
| `apply_patch(args, ctx)` | ~155 | Tool: applies OpenAI-style patch envelopes |
| `exec(args, ctx)` | ~160 | Tool: executes shell commands with timeout and background support |
| `get_default_cwd(args, ctx)` | ~230 | Tool: returns the default working directory |
| `SharedBrowserManager` (class) | ~235 | Manages Puppeteer browser tabs with open/get/close/interact |
| `buildBrowserScreenshotResult(tab, buffer)` | after `SharedBrowserManager` | Builds the canonical screenshot tool result used on the node wire |
| `browse_open(args)` | ~305 | Tool: opens a browser tab |
| `browse_list()` | ~306 | Tool: lists open browser tabs |
| `browse_get(args)` | ~307 | Tool: gets tab content or screenshot |
| `browse_close(args)` | ~308 | Tool: closes a browser tab |
| `browse_interact(args)` | ~309 | Tool: interacts with a browser tab |
| `expandHomePath(filePath)` (nodeFileTransfer) | ~20 | Expands ~ to home directory |
| `getNodeAgentDir(agentName)` | ~25 | Resolves the agent working directory |
| `resolveNodePath(filePath, agentName, sessionCwd)` | ~32 | Resolves relative/absolute file paths for an agent |
| `resolveNodeTransferPath(filePath, agentName, restrictToAgentDir)` | ~38 | Resolves transfer path with optional traversal guard |
| `detectTransferMimeType(filePath)` | ~45 | Detects MIME type and image flag from extension |
| `readNodeTransferFile(filePath, agentName, restrictToAgentDir)` | ~50 | Reads a file and returns base64 transfer payload |
| `writeNodeTransferFile(filePath, agentName, dataBase64, overwrite, restrictToAgentDir)` | ~60 | Writes a base64-encoded file to disk |
| `expandHomePath(filePath)` (execCwd) | ~22 | Expands ~ to home directory |
| `resolveExecCwd(options)` | ~28 | Resolves exec cwd from explicit/session/default sources |
| `buildInvalidExecCwdMessage(resolved, reason, nodeId)` | ~44 | Builds a descriptive error message for invalid cwd |
| `validateResolvedExecCwd(resolved, nodeId)` | ~49 | Validates that resolved cwd exists and is accessible |
| `resolveValidatedExecCwd(options)` | ~73 | Resolves and validates exec cwd in one call |
| `estimateTokenCount(text)` | ~1 | Estimates token count using codepoint heuristics |
| `formatStructuredValue(value)` | ~20 | Formats a value as YAML or string |
| `formatToolResponsePayload(response)` | ~32 | Formats tool response, unwrapping single `output` key |
| `formatCompactObjectPreview(response)` | ~42 | Formats compact preview of single-key objects |
| `parseSessionLinkText(text)` | (webuiToolRendering.ts) | Parses recognized session-id text patterns into link/text segments |
| `shouldUseStreamingToolPlaceholder(options)` | (webuiToolRendering.ts) | Detects synthetic streaming tool calls whose args should not be parsed yet |

## Dependencies

- `./applyPatch` — `applyUpdatePatch`, `buildAddedFileContent`, `parseApplyPatchInput`
- `./fileToolCore` — shared read/write core also used by master-side wrappers
- `./nodeFileTransfer` — `detectTransferMimeType`, `getNodeAgentDir`, `resolveNodePath`
- `./persistentExec` — `PersistentExecManager`, timeout constants, exec types

## Behavior

- File operations resolve paths relative to session cwd or agent directory, with home path expansion; node wrappers then delegate read/write behavior to `fileToolCore`
- `exec` spawns shell commands via `PersistentExecManager`; commands exceeding timeout continue in background and fire a system event on completion with log file path
- Node-side `exec` shares master-side timeout resolution: finite values above 60 seconds clamp to 60 and emit the requested/effective warning in the immediate foreground or background-switch result; invalid and below-minimum values still reject.
- `edit` enforces single-occurrence matching to prevent ambiguous replacements
- `write` refuses to overwrite unless explicitly told, and requires parent directories to already exist unless `createDirs=true` is passed. For the default path it first attempts `fs.writeFile` directly, so symlinked parent directories work naturally; friendly parent errors are generated only after write failure.
- `SharedBrowserManager` lazily launches a headless Puppeteer instance and manages tabs by UUID
- Shared browser screenshots write current structured inline data. Old remote-node screenshot shapes are read only under [D-node-thread-tool-result-compatibility](../threads/node-communication.md#d-node-thread-tool-result-compatibility).
- Directory reads are paginated (50 items default) with navigation hints
- File and directory read `startLine`/`endLine` values of `0` are treated as omitted, matching master-side read compatibility for optional numeric placeholders
- File transfer functions enforce path traversal restrictions by default
- Exec cwd validation produces detailed error messages distinguishing cwd issues from missing shell errors
- Output exceeding `INLINE_OUTPUT_LIMIT` (10K chars) is truncated with a pointer to the log file
- Node `apply_patch` success and partial-failure summaries use the shared per-operation formatter, including per-file add/update counts; the count contract is canonical in [D-apply-patch-change-counts](./shared-apply-patch.md#d-apply-patch-change-counts).

## Integration

- `CLI_NODE_CAPABILITIES` is consumed by the orchestration layer to register available tools with the LLM
- `nodeTools` object is the primary interface invoked by the node runtime when dispatching tool calls
- `execCwd` utilities are used by `exec` to resolve and validate working directories before spawning processes
- `nodeFileTransfer` supports inter-node file transfer operations (read/write with base64 encoding and SHA-256 verification)
- `toolResponseFormatting` is used upstream to serialize tool results into YAML for LLM consumption and by WebUI to format full tool response payloads consistently
- `webuiToolRendering` supplies pure, testable helper logic for WebUI session-link text parsing and streaming partial tool-call guards
- `estimateTokenCount` is shared across master and node packages for context budget management
- Re-exported from `index.ts` as the public API surface of the `shared` package
- Master-side `src/tools/helpers.ts` imports `fileToolCore` from `packages/shared/dist/fileToolCore`, so the root build must build `packages/shared` before compiling `src`.
