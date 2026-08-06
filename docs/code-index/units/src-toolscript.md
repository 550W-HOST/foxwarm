# Unit: src-toolscript

Files: src/toolscript.ts, src/toolscript.test.ts
Secondary files: src/toolscriptSkills.test.ts, package.json, package-lock.json

## Purpose

Implements persisted foreground/background ToolScript runs in the Monty 0.0.19 Python-subset VM. It lazily prefers Monty's native crash-isolated subprocess pool and falls back to Monty's Node in-process WASM pool when the native package fails during import or evaluation. It validates `main(args)`, enforces VM/slice limits, dispatches a small host API, stores version-identified snapshots/run records, resumes waits, and coordinates managed-session leases.

## Actual exports

- `tool_run_script(args, ctx)` — start a run; mode may be foreground or background.
- `tool_start_toolscript_run(args, ctx)` — hidden compatibility-only background starter; current callers use `tool_run_script` with background mode.
- `tool_continue_script(args, ctx)` — resume an agent-input or timeout-checkpoint wait owned by the current session.
- `tool_list_toolscript_runs`, `tool_get_toolscript_run`, `tool_cancel_toolscript_run` — hidden management handlers.
- `resumeBackgroundToolScriptRunForManagedSession(args)` — internal managed-event continuation.
- `forceToolScriptNativeImportFailureForTests`, `getToolScriptRunForTests`, `resetToolScriptMontyRuntimeForTests`, `resetToolScriptRunsForTests` — test-only runtime controls and record inspection.

ToolScript result/run types are internal, not exported TypeScript API types.

## Host API

- `call_tool(...)` — normalize shorthand or a unified descriptor, dynamically load `./tools`, and invoke the exported `call_tool` handler with the outer exact `ToolContext`, including its trusted placement/persist hooks.
- `request_model_without_context(prompt, model?)` — production one-shot model request using the current session as configuration context but not its history.
- `ask_agent(question)` — persist a snapshot and return an agent continuation.
- `open_managed_session`, `session_step`, `release_managed_session`, `wait_for_managed_event` — explicit managed-session controller operations.

Unknown external function names are returned to Monty as runtime exceptions that list the available host API. Monty OS-function suspensions are rejected rather than exposed or mounted. There is no separate ToolScript file-I/O or MCP client path; scripts compose normal Foxwarm tools through `call_tool`.

## Stable-symbol index

| Symbol/section | Responsibility |
|---|---|
| source/timeout/limit parsing | `main(args)` validation and bounded execution options |
| call-tool descriptor normalization | String shorthand and unified target descriptor to wrapper args |
| run persistence | Owner-scoped JSON record load/save/list |
| `executeScriptHostCall` | Host function dispatch and unknown-call diagnostics |
| Monty runtime lifecycle | Lazy pool creation, checked-out session cleanup, and test-only restart simulation |
| `advanceExecution` | Async complete, name lookup, host-call, OS rejection, agent-wait, managed-wait, and timeout-safe checkpoints |
| `startRun` / `resumeRun` | Feed source into a checked-out worker or load a compatible snapshot into a fresh worker session |
| tool handlers | Session ownership, mode, continuation, cancellation, and result shaping |

## Behavior

- Runtime loading is native-first. If the native Monty package cannot be imported or evaluated, Foxwarm logs the native error and loads `@pydantic/monty/wasm`; the direct `@bjorn3/browser_wasi_shim` dependency supplies the WASI host that Monty 0.0.19 does not publish as a runtime dependency.
- On Node, the WASM fallback runs in-process rather than in the native subprocess pool, so it does not provide the native backend's subprocess crash isolation or hard watchdog. Monty's memory, recursion, and duration limits still apply, and Foxwarm continues to reject OS-function suspensions and mounts so host effects cannot bypass `call_tool`.
- Default slice timeout is 30 seconds; memory, recursion, and duration limits are passed to Monty. Monty 0.0.19 has no allocation-count limit.
- Timeout is checked at safe host-call boundaries and does not interrupt an in-progress host call. When exceeded, the run stores the pending return/exception plus snapshot and returns a continuable timeout state.
- Foreground and background runs both execute the initial slice inside `run_script`. Automatic wake is limited to background managed-event waits; agent-input and timeout waits require `continue_script`.
- `ask_agent` and managed-event waits persist snapshots together with the exact VM/snapshot-format identity; completed/current-runtime failed/cancelled runs clear resumable snapshots.
- A snapshot is loaded into a fresh pool session when a run continues, so waiting runs survive a Foxwarm process restart. Native and WASM pools share the same Monty 0.0.19 snapshot format and persisted runtime identity, so a waiting run can resume after the selected backend changes. Old or unknown snapshot formats fail with a deterministic restart-the-run error while retaining the historical record and incompatible snapshot. Completed historical records remain readable without conversion.
- Monty OS functions and mounts are not exposed. Filesystem, environment, clock, and process effects remain behind normal `call_tool` permissions.
- Run records live under the state data root and are accessible only from the owner session.
- `activeBackgroundRuns` prevents concurrent execution/resume of one background run.
- Managed leases acquired by a run are recorded. Controllers normally release them explicitly; cancellation and incompatible-snapshot terminalization perform best-effort cleanup. Failed releases remain recorded so calling `cancel_toolscript_run` on the terminal record retries cleanup.
- `call_tool` subcalls publish ToolScript progress and are kept in the outer run result/record. They do not append each nested call as ordinary outer-session tool history.
- In Session-worker placement, managed-session host functions and cleanup of persisted managed leases fail before importing/calling child managed-session state. Ordinary VM/model/ask-agent/timeout and nested already-closed tools remain available; a later fixed managed reverse service owns that deferred closure.
- `request_model_without_context` uses request-journal purpose `toolscript-one-shot`; its canonical prompt and normalized provider result are durable independently of the outer ToolScript history boundary.
- `continue_script` returns stdout produced in that continuation slice; persisted status retains cumulative stdout.
- `executedTools` is cumulative, while `subCalls`, `hostCallCount`, and `lastHostCall` describe the latest execution slice.
- Inline image payloads from a final result are promoted to the outer tool result and replaced with compact placeholders inside the textual result.
- MCP image content returned through a nested unified `call_tool` is source-normalized into the same inline payload shape, then promoted through the outer ToolScript result and provider image serialization without copying base64 into textual output.

## Compatibility

- `call_tool` accepts the supported string shorthand and the current unified descriptor. New examples use the descriptor.
- `continue_script.input` is a string at the tool boundary; structured input is passed as JSON text and parsed by the script.
- Documented user automation may still call hidden `start_toolscript_run`; current model guidance and bundled skills use `run_script({ mode: "background" })`.
- Hidden direct MCP runtime handlers still exist, but ToolScript examples use unified `call_tool` so builtin/MCP/node dispatch shares one path.

## Design decisions

### D-toolscript-dynamic-dispatch

Nested tool execution dynamically calls the exported `./tools.call_tool` wrapper. It does not call `llm.executeTools` and does not maintain a parallel registry.

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
