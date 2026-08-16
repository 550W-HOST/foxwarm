# Module: shared utilities

## Responsibility

Owns reusable cross-package implementations for patch application, file/exec/browser node tools, fixed Code node services, terminal-helper IPC, persistent command management, and Unicode/line-aware output excerpts. Higher layers provide session/permission/protocol policy around these implementations.

## Units

- [shared-apply-patch](../units/shared-apply-patch.md) — patch envelope parsing and add/update/delete content operations.
- [shared-node-tools](../units/shared-node-tools.md) — shared file core, node tool registry/schemas, transfer, cwd, browser, token, and formatting helpers.
- [shared-vscode-node-service](../units/shared-vscode-node-service.md) — fixed filesystem/read-only Git service and advertised versions.
- [shared-code-helper-ipc](../units/shared-code-helper-ipc.md) — terminal-scoped helper executable and capability-authenticated local IPC.
- [shared-persistent-exec](../units/shared-persistent-exec.md) — foreground/background process lifecycle, logs, registry, recovery, and notifications.
- [shared-output-truncation](../units/shared-output-truncation.md) — Unicode-safe line-aware excerpts and metadata footer.
- [shared-config-schemas](../units/shared-config-schemas.md) — pure public-safe App/Models Draft-07 schemas shared by browser consumers.

Durable JSON semantics are canonical in [src-utils](../units/src-utils.md#d-disk-json-durability), not duplicated here.

## Public interfaces

- `nodeTools`, `CLI_NODE_CAPABILITIES`.
- shared low-level native file/process backends, file read/write semantic core, and node transfer/path helpers.
- patch parsing/content-application functions plus per-operation change-count summaries.
- `PersistentExecManager` and shared timeout/cwd resolution.
- `truncateOutputForDisplay`.
- `formatToolResponsePayload`, `formatStructuredValue`, token estimation, Foxwarm attribute/attachment markup formatting, and small WebUI rendering helpers.
- `APP_CONFIG_SCHEMA`, `MODELS_CONFIG_SCHEMA`, and `KNOWN_PROVIDER_TYPES` through the `configSchemas` package export.
- `executeVscodeNodeService`, `VSCODE_NODE_SERVICE_VERSIONS`.
- `CodeHelperIpcServer` and fixed open/add request types.

## Invariants

- Patch matching normalizes LF internally, restores original line endings, and refuses ambiguous exact replacements.
- Master and node patch results share per-file add/update counts; the exact counting and display contract is canonical in [D-apply-patch-change-counts](../units/shared-apply-patch.md#d-apply-patch-change-counts).
- Write refuses overwrite by default and creates parents only with `createDirs=true`; it attempts the real write before enriching parent errors.
- Master and node wrappers reuse shared file/cwd/timeout semantics rather than independently approximating them; local target-specific system calls sit behind the small file/process contracts described by the canonical unit/thread decisions.
- Exec cwd expands home, must exist, and must be a directory before spawn.
- Finite exec timeouts above the runtime maximum clamp with a separate warning; invalid/below-minimum values reject.
- Persistent exec owns atomic status/log/cwd metadata, can reconcile registry awareness after restart, and uses bounded binary-safe excerpts for oversized logs; canonical details: [D-persistent-exec-bounded-log-excerpts](../units/shared-persistent-exec.md#d-persistent-exec-bounded-log-excerpts).
- Large output uses Unicode-safe per-line shortening plus whole-line middle omission and a footer pointing to captured command output/log.
- File transfer resolves paths with traversal restrictions by default.
- Code services accept fixed operations and versions, not arbitrary model tools.
- Terminal helper receives no WebUI/node credential and cannot choose trusted node/terminal identity.

## Compatibility

- Shared file reads treat numeric `startLine`/`endLine` zero as omitted for optional-schema placeholders.
- The root build compiles `packages/shared` before root consumers that import its `dist` output.

## Design decisions

### D-shared-write-first

Attempt the requested write using atomic filesystem flags before parent diagnostics; this preserves valid symlinked parent behavior while still producing friendly errors.

### D-shared-exec-contract

Cwd validation and timeout clamping are shared. Timeout warnings remain separate metadata so output truncation cannot erase them.

### D-shared-line-aware-output

When output overflows, shorten extreme individual lines and omit whole middle line ranges with explicit Foxwarm placeholders and original-size metadata.

### D-shared-package-boundary

Keep the shared package as the parity boundary for root, CLI node, WebUI helpers, and tests; do not duplicate an implementation to avoid a build dependency.

## Canonical cross-module ownership

- Shared master/node file semantics: [D-dispatch-shared-file-semantics](../threads/tool-dispatch.md#d-dispatch-shared-file-semantics).
- Model tools versus fixed backend services: [D-node-thread-tool-service-split](../threads/node-communication.md#d-node-thread-tool-service-split).
- Terminal helper IPC and trusted routing: [D-node-thread-helper-ipc](../threads/node-communication.md#d-node-thread-helper-ipc).
