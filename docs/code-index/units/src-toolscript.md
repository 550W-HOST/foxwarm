# Unit: src-toolscript

Files: src/toolscript.ts, src/toolscript.test.ts, src/toolscriptImageParts.test.ts, src/toolscriptSource.test.ts, src/toolscriptSourceRouting.test.ts
Secondary files: src/toolscriptSkills.test.ts, package.json, package-lock.json

## Purpose

Implements persisted foreground/background ToolScript runs in the Monty 0.0.19 Python-subset VM. It lazily prefers Monty's native crash-isolated subprocess pool and falls back to Monty's Node in-process WASM pool when the native package fails during import or evaluation. It feeds top-level source with legacy `main(args)` auto-call compatibility, enforces VM/slice limits, dispatches a small host API, stores version-identified snapshots/run records, resumes waits, and coordinates managed-session leases.

## Actual exports

- `tool_run_script(args, ctx)` — start an inline run or load complete file source from `node` plus `filePath`; mode may be foreground or background.
- `tool_start_toolscript_run(args, ctx)` — hidden compatibility-only background starter; current callers use `tool_run_script` with background mode.
- `tool_continue_script(args, ctx)` — resume an agent-input or timeout-checkpoint wait owned by the current session.
- `tool_list_toolscript_runs`, `tool_get_toolscript_run`, `tool_cancel_toolscript_run` — hidden management handlers.
- `resumeBackgroundToolScriptRunForManagedSession(args)` — internal managed-event continuation.
- `shutdownToolScriptRuntime()` — production process-lifecycle close for the lazily created Monty pool; it is safe when unused and preserves persisted run records/snapshots.
- `forceToolScriptNativeImportFailureForTests`, `getToolScriptRunForTests`, `resetToolScriptMontyRuntimeForTests`, `resetToolScriptRunsForTests` — test-only runtime controls and record inspection.

ToolScript result/run types are internal, not exported TypeScript API types.

Host calls inherit only the current invocation signal and check it before another host effect; persisted background resumption receives a fresh context, not an old turn signal. See [Stop and Run queued](../threads/message-processing-pipeline.md#d-pipeline-control-commands).

## Host API

The default-injected `run_script` description includes the Python-subset syntax, synchronous `call_tool` usage with a tool name or tool ID, and a minimal inline example with `args` and `return`.

- `call_tool(...)` — normalize shorthand or a unified descriptor, dynamically load `./tools`, and invoke the exported `call_tool` handler with the outer exact `ToolContext`, including its trusted placement/persist hooks and programmatic producer hint.
- `request_model_without_context(prompt, model?)` — production one-shot model request using the current session's raw effort and optional model selection but not its history; returns the text plus canonical parts (text and Blob-referenced images) without reasoning, function calls, provider metadata, or image bytes.
- `ask_agent(question)` — persist a snapshot and return an agent continuation.
- `open_managed_session`, `session_step`, `release_managed_session`, `wait_for_managed_event` — explicit managed-session controller operations.

The exact-owner Task facade emits a process-local completion receipt containing taskId/attachedSessionId. Each run/continue slice forwards only receipts actually emitted during that slice into its internal outer post-action; nested script contexts forward the same trusted callback. Script return values, stdout and saved run data are never scanned for completion claims. The existing child-handoff consumer handles the receipt; TaskService remains the sole completion/creator-notification owner.

Unknown external function names are returned to Monty as runtime exceptions that list the available host API. Monty OS-function suspensions are rejected rather than exposed or mounted. There is no separate ToolScript file-I/O or MCP client path; scripts compose normal Foxwarm tools through `call_tool`.

## Stable-symbol index

| Symbol/section | Responsibility |
|---|---|
| source/timeout/limit parsing | Native top-level source, legacy main auto-call and bounded execution options |
| call-tool descriptor normalization | String shorthand and unified target descriptor to wrapper args |
| run persistence | Owner-scoped JSON record load/save/list |
| `executeScriptHostCall` | Host function dispatch and unknown-call diagnostics |
| Monty runtime lifecycle | Lazy pool creation, checked-out session cleanup, and test-only restart simulation |
| `advanceExecution` | Async complete, name lookup, host-call, OS rejection, agent-wait, managed-wait, and timeout-safe checkpoints |
| `startRun` / `resumeRun` | Feed source into a checked-out worker or load a compatible snapshot into a fresh worker session |
| `projectExecutionResult` / tool handlers | Lean execution responses, presentation hook, and explicit diagnostic inspection |

## Behavior

- Runtime loading is native-first. If the native Monty package cannot be imported or evaluated, Foxwarm logs the native error and loads `@pydantic/monty/wasm`; the direct `@bjorn3/browser_wasi_shim` dependency supplies the WASI host that Monty 0.0.19 does not publish as a runtime dependency.
- The selected Monty pool is owned by the current Foxwarm OS process. Graceful process shutdown awaits one idempotent pool close, including a creation already in progress; shutdown while unused creates nothing, and a later use after completed shutdown may lazily create a fresh pool. Closing the VM pool never removes persisted ToolScript run records or waiting snapshots.
- On Node, the WASM fallback runs in-process rather than in the native subprocess pool, so it does not provide the native backend's subprocess crash isolation or hard watchdog. Monty's memory, recursion, and duration limits still apply, and Foxwarm continues to reject OS-function suspensions and mounts so host effects cannot bypass `call_tool`.
- Default slice timeout is 30 seconds; memory, recursion, and duration limits are passed to Monty. Monty 0.0.19 has no allocation-count limit.
- Timeout is checked at safe host-call boundaries and does not interrupt an in-progress host call. When exceeded, the run stores the pending return/exception plus snapshot and returns a continuable timeout state.
- Host-call failures are injected back into the suspended script only at the host-call boundary. Once a host result has been returned, later script/runtime errors propagate as their original Monty traceback without attempting a second resume of the consumed snapshot.
- Foreground and background runs both execute the initial slice inside `run_script`. Automatic wake is limited to background managed-event waits; agent-input and timeout waits require `continue_script`.
- `ask_agent` and managed-event waits persist snapshots together with the exact VM/snapshot-format identity; completed/current-runtime failed/cancelled runs clear resumable snapshots.
- A snapshot is loaded into a fresh pool session when a run continues, so waiting runs survive a Foxwarm process restart. Native and WASM pools share the same Monty 0.0.19 snapshot format and persisted runtime identity, so a waiting run can resume after the selected backend changes. Old or unknown snapshot formats fail with a deterministic restart-the-run error while retaining the historical record and incompatible snapshot. Completed historical records remain readable without conversion.
- Monty OS functions and mounts are not exposed. Filesystem, environment, clock, and process effects remain behind normal `call_tool` permissions.
- Run records live under the state data root and are accessible only from the owner session. New file-backed records retain the resolved `sourceNode`; older records without it remain readable and resumable.
- `activeBackgroundRuns` prevents concurrent execution/resume of one background run.
- Managed leases acquired by a run are recorded. Controllers normally release them explicitly; cancellation and incompatible-snapshot terminalization perform best-effort cleanup. Failed releases remain recorded so calling `cancel_toolscript_run` on the terminal record retries cleanup.
- `call_tool` subcalls publish live progress and remain in run diagnostics. `run_script` and `continue_script` expose only lean execution results; an in-process hook carries nested activity into model-invisible response metadata. See [D-dispatch-toolscript-execution-projection](../threads/tool-dispatch-node-execution.md#d-dispatch-toolscript-execution-projection). Nested calls do not append ordinary outer-session tool history.
- In Session-worker placement, managed-session host functions and cleanup of persisted managed leases fail before importing/calling child managed-session state. ToolScript progress emission returns before any child `sessionManager.notifySessionEvent`; transient running/final/error progress may drop until committed publication, while persisted run/subcall state remains authoritative. Ordinary VM/model/ask-agent/timeout and nested already-closed tools remain available; a later fixed managed reverse service owns that deferred closure.
- `request_model_without_context` uses request-journal purpose `toolscript-one-shot`; it supplies the exact passed owner's prompt-cache key and raw effort so Worker placement never rehydrates or saves a second child-global Session merely to resolve request identity. Its canonical prompt and normalized provider result are durable independently of the outer ToolScript history boundary.
- `continue_script` returns stdout produced in that continuation slice, omitting the field when empty; persisted status retains cumulative stdout.
- Outer model/WebUI presentation uses the shared print/return/metadata section renderer without changing native execution responses or nested script values. The contract and presentation boundary are [D-dispatch-toolscript-execution-projection](../threads/tool-dispatch-node-execution.md#d-dispatch-toolscript-execution-projection).
- Diagnostic `executedTools` is cumulative, while `subCalls`, `hostCallCount`, and `lastHostCall` describe the latest execution slice. These are not fields of the default execution response.
- Inline image payloads from a final result are promoted to the outer tool result and replaced with compact placeholders inside the textual result.
- Canonical image parts returned by a final result (for example the `parts` of a `request_model_without_context` result, whether the script returns the result object or an object carrying its `parts`) are promoted the same way, except that their bytes stay in the image Blob store and only the reference travels to the outer tool result. The promoted reference becomes the session-visible image under the tool-result image id convention, the textual result keeps a bounded placeholder in its place, and an unresolvable reference fails the tool result instead of leaving a dangling image. The rewrite is limited to the promoted image entries themselves: a `parts` list that contains no promoted image, and every other result field, stays byte-identical, while text that rode along on a promoted part remains visible next to the placeholder.
- MCP image content returned through a nested unified `call_tool` is source-normalized into the same inline payload shape, then promoted through the outer ToolScript result and provider image serialization without copying base64 into textual output.

## Compatibility

- Ordinary top-level source reads `args` and preserves native return/final-expression behavior and host suspensions. Legacy main auto-call is governed by [D-toolscript-top-level-source](#d-toolscript-top-level-source).
- Script-only read/exec/search fields and byte/capability limits are canonical in [D-dispatch-programmatic-tool-data](../threads/tool-dispatch-node-execution.md#d-dispatch-programmatic-tool-data).

- `call_tool` accepts string shorthand and the current unified descriptor. A string containing `:` is passed as `toolId` to the canonical resolver, which owns supported prefixes, format errors, concrete authorization and routing; it never falls back to a builtin name. Explicit keyword `toolId` retains precedence, and positional/keyword tool-argument merging is unchanged. Plain string shorthand for direct Node-capability names resolves to `source=node`; descriptor examples use `source=node` with omitted `nodeId` for the current Node. An explicit `builtin:read` remains invalid because file tools are Node capabilities.
- `continue_script.input` is a string at the tool boundary; structured input is passed as JSON text and parsed by the script.
- Documented user automation may still call hidden `start_toolscript_run`; current model guidance and bundled skills use `run_script({ mode: "background" })`.
- Hidden direct MCP runtime handlers still exist, but ToolScript examples use unified `call_tool` so builtin/MCP/node dispatch shares one path.

## Design decisions

### D-toolscript-dynamic-dispatch

Nested tool execution dynamically calls the exported `./tools.call_tool` wrapper. It does not call `toolExecutor.executeTools` and does not maintain a parallel registry.

### D-toolscript-safe-timeout

A slice timeout pauses only at a host-call checkpoint with a persisted pending return/exception, allowing exact continuation instead of restarting the script.

### D-toolscript-owner-bound-run

A run and its snapshot belong to one session. Cross-session inspection/resume is rejected, while managed-session access requires explicit leases.

### D-toolscript-unknown-call-diagnostic

Unknown external calls are not described as supported host APIs. The runtime lists only the actual Foxwarm host functions; ordinary helpers may appear anywhere in the loaded module.

### D-toolscript-versioned-snapshot-runtime

[2026-08-03] Every new run persists the Monty engine version and snapshot-format identity. Continuation accepts only an exact current-format match because Monty snapshots are version-specific. An incompatible waiting run becomes a clearly failed historical record without attempting conversion or deleting its snapshot; completed historical records remain readable. Before terminalizing an incompatible controller, Foxwarm best-effort releases its managed leases; failed release references are retained so a later terminal `cancel_toolscript_run` call can retry cleanup.

### D-toolscript-os-effects-through-tools

[2026-08-03] Foxwarm does not expose Monty OS functions or filesystem mounts. All filesystem, environment, clock, and process effects must pass through `call_tool` so normal session, node, path, and isolation checks remain authoritative.

### D-toolscript-process-lifetime-pool

[2026-08-10] Each Foxwarm OS process owns its lazily created native/WASM Monty pool for that process lifetime. Supported graceful shutdown must await the pool close before process exit or teardown of services used by ToolScript host calls. The close is idempotent, owns a pending creation exactly once, does not create an unused runtime, and leaves persisted runs/snapshots intact; later runtime use may lazily create a new pool.

### D-toolscript-one-shot-parts

[2026-09-19] `request_model_without_context` keeps its existing text behavior and additionally returns the canonical parts of the low-level result, so a script can hand a model-produced image back to the outer tool result instead of dropping it. The parts carry text and image parts whose bytes stay in the image Blob store; reasoning, function calls, provider metadata, and transport-only reference fields are not projected, and no image bytes enter the script value, the run record, or the model-visible text. A final result returning those parts promotes only the image parts through the shared tool-result image boundary, keeps other parts in place, and replaces the promoted entries with a bounded placeholder, while JSON that does not match the canonical reference shape is never treated as an image.

### D-toolscript-top-level-source

[2026-10-03] New runs feed ordinary top-level source directly to Monty with `args` as input, without requiring `main(args)`. Native top-level return, final-expression behavior and normal host suspensions are preserved. Explicitly permitted legacy compatibility retains the existing multiline regex for a source that looks like `def main(args)` and appends `main(args)` only for that form. Installed MontySession has no direct named-function invocation API; there is no second feed or new persistence lifecycle. Existing waiting snapshots continue their recorded execution without source rewrite or reparse. Current small examples favor top-level source; real legacy file-backed generator coverage remains. Local/neighbor module import is not implemented.

### D-toolscript-authorized-file-source

[2026-10-15] `run_script` and the hidden compatibility starter accept `node` plus `filePath`. Omitted, blank, or `current` Node selectors use the Session's selected Node at invocation; explicit `master` reads Main. Source selection does not move the Monty VM, mutate the Session Node/cwd, or alter nested tools' default Node. Nonblank inline code still wins over filePath, but an explicit Node selector with inline code is rejected. Inline execution retains the existing master builtin-policy target without acquiring a fictional file source.

A file-backed starter is authorized as its own builtin against the actual source `targetNode` and source-aware filePath facts, then independently requires that Node's canonical `read` permission and existing structural restrictions before loading any source. Main source paths reuse Agent/cwd/home/token resolution and generic realpath containment; only this source entry trims surrounding path whitespace, identically for authorization and I/O. Remote path facts retain exact Node identity without imposing Main containment on an opaque namespace. Optional-source discovery remains conservative for explicit permitted Nodes.

The resolved starter captures one source-only Node/cwd tuple before outer authorization. Both model preflight and canonical starter checks derive file facts from that tuple without rewriting raw arguments; the loader uses the same tuple for read permission and I/O. A concurrent Session cwd settings update can change the live VM/nested-tool context but cannot retarget an already resolved source. This transient capture is consumed only by source loading and is not persisted as VM routing, a lock, or a filesystem snapshot.

Main reads complete UTF-8 source directly. Non-master reads use the source-fenced `node-execution` readonly file facade. Primitive providers supply complete filesystem bytes. Authenticated CLI source reads first execute canonical `read`, retaining its local approval hook; denial or error never proceeds to transfer. Programmatic content is used only when metadata proves full-file coverage (`selectedBytes == sizeBytes` and `truncated: false`); otherwise the same source is obtained through existing complete-file transfer, using the actual resolved path when available. Display text and partial content are never executed. Read capability, availability, provider restrictions and complete-transfer/primitive-result checks remain authoritative; unsupported backends fail without fallback. There is no new shared source-size limit, distribution cache or remote VM. Snapshot continuation resumes the owner-scoped saved VM state without reopening or reauthorizing historical source; newly executed nested tool calls retain their own current authorization.

Legacy CLI peers without resolved-path metadata retain target-native absolute/rooted/home/Agent-token handling and same-target cwd for ordinary relative source paths. A Windows cwd plus a drive-relative path on another drive is ambiguous without the target runtime's per-drive cwd; source loading fails with a request for a drive-absolute path instead of guessing. A colon in a POSIX or provider-owned path does not imply Windows semantics.
