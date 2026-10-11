# Unit: shared-vscode-node-service

Files: packages/shared/src/vscodeNodeService.ts, packages/shared/src/gitCommitDetails.ts, packages/shared/src/gitCommitDetails.test.ts
Secondary files: packages/shared/src/nodeCapabilities.ts

## Purpose

Implements the fixed-operation filesystem and read-only Git services used by Code on CLI nodes. These are authenticated backend service RPCs, not model-facing tools, so Code can operate on a node's real filesystem without translating workbench requests into generic `read`/`write`/`exec` tool calls.

## Key Exports

- `VSCODE_NODE_SERVICE_VERSIONS` — supported service names/versions (`vscode-fs`, `vscode-git`).
- `VscodeNodeServiceError` — structured service error carrying a stable code and HTTP-compatible status.
- `executeVscodeNodeService(service, operation, args)` — validates and executes a fixed filesystem or Git operation in the current node process.
- `serializeVscodeNodeServiceError(error)` — converts service failures into a WebSocket-safe error payload.
- `CLI_NODE_CAPABILITIES.services` — advertises service versions alongside the existing model-tool schemas.

## Behavior

- Filesystem operations are `stat`, `read-directory`, `read-file`, `write-file`, `create-directory`, `delete`, and `rename`; paths must be absolute and file reads/writes are capped at 50 MiB.
- Git operations are read-only `status`, `content`, and v2 `commit`. Status uses porcelain-v2 and supports submodule OID enrichment by reading `.git` metadata without another Git process. Content returns base, immutable commit, or working-tree bytes, capped at 10 MiB.
- `commit` accepts only a direct 7–64 digit hexadecimal commit id (annotated-tag object ids do not silently peel), resolves the canonical Git top-level, and returns metadata plus rename-aware first-parent file/stat changes. Root commits compare with the empty tree; merge commits intentionally compare with their first parent. Results cap at 5,000 files and distinguish binary/submodule entries.
- Binary payloads are base64 inside the node WebSocket JSON protocol.
- Git commands use spawn arguments, not shell interpolation, and repository-relative paths are checked against traversal.
- The current path normalization is POSIX-oriented for Code workspaces; Windows path mapping is deferred with remote PTY/platform work.

## Integration

- `packages/cli-node/src/client.ts` handles `node_service_request` and calls this module.
- `src/nodes/manager.ts` checks advertised versions and correlates requests/responses.
- `src/vscodeWebRoutes.ts` keeps master operations local and dispatches non-master filesystem/Git requests through the node service protocol.
- `src/vscodeWebRoutes.test.ts` exercises the HTTP-to-node-service dispatch with an advertised fake node; a real Docker CLI-node E2E also validated Explorer read/write and SCM status/diff.
- Commit details require advertised `vscode-git` service version 2; older nodes keep status/content compatibility but receive a structured unsupported-service response for commit inspection.
