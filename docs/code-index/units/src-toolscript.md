# Unit: src-toolscript

Files: src/toolscript.ts, src/toolscript.test.ts
Secondary files: src/toolscriptSkills.test.ts

## Purpose

Implements persisted foreground/background ToolScript runs in the Monty Python-subset VM. It validates `main(args)`, enforces VM/slice limits, dispatches a small host API, stores snapshots/run records, resumes waits, and coordinates managed-session leases.

## Actual exports

- `tool_run_script(args, ctx)` — start a run; mode may be foreground or background.
- `tool_start_toolscript_run(args, ctx)` — hidden compatibility-only background starter; current callers use `tool_run_script` with background mode.
- `tool_continue_script(args, ctx)` — resume an agent-input or timeout-checkpoint wait owned by the current session.
- `tool_list_toolscript_runs`, `tool_get_toolscript_run`, `tool_cancel_toolscript_run` — hidden management handlers.
- `resumeBackgroundToolScriptRunForManagedSession(args)` — internal managed-event continuation.
- `getToolScriptRunForTests`, `resetToolScriptRunsForTests`.

ToolScript result/run types are internal, not exported TypeScript API types.

## Host API

- `call_tool(...)` — normalize shorthand or a unified descriptor, dynamically load `./tools`, and invoke the exported `call_tool` handler with the outer `ToolContext`.
- `request_model_without_context(prompt, model?)` — production one-shot model request using the current session as configuration context but not its history.
- `ask_agent(question)` — persist a snapshot and return an agent continuation.
- `open_managed_session`, `session_step`, `release_managed_session`, `wait_for_managed_event` — explicit managed-session controller operations.

Unknown external function names are returned to Monty as runtime exceptions that list the available host API and tell authors to define local helpers before `main(args)`. There is no separate ToolScript file-I/O or MCP client path; scripts compose normal Foxwarm tools through `call_tool`.

## Stable-symbol index

| Symbol/section | Responsibility |
|---|---|
| source/timeout/limit parsing | `main(args)` validation and bounded execution options |
| call-tool descriptor normalization | String shorthand and unified target descriptor to wrapper args |
| run persistence | Owner-scoped JSON record load/save/list |
| `executeScriptHostCall` | Host function dispatch and unknown-call diagnostics |
| `advanceExecution` | Complete, host-call, agent-wait, managed-wait, and timeout-safe checkpoints |
| `startRun` / `resumeRun` | Monty start and snapshot continuation |
| tool handlers | Session ownership, mode, continuation, cancellation, and result shaping |

## Behavior

- Default slice timeout is 30 seconds; allocation, memory, recursion, and duration limits are passed to Monty.
- Timeout is checked at safe host-call boundaries and does not interrupt an in-progress host call. When exceeded, the run stores the pending return/exception plus snapshot and returns a continuable timeout state.
- Foreground and background runs both execute the initial slice inside `run_script`. Automatic wake is limited to background managed-event waits; agent-input and timeout waits require `continue_script`.
- `ask_agent` and managed-event waits persist snapshots; completed/failed/cancelled runs clear resumable snapshots.
- Run records live under the state data root and are accessible only from the owner session.
- `activeBackgroundRuns` prevents concurrent execution/resume of one background run.
- Managed leases acquired by a run are recorded and released on cancellation/completion cleanup.
- `call_tool` subcalls publish ToolScript progress and are kept in the outer run result/record. They do not append each nested call as ordinary outer-session tool history.
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

Unknown external calls are not described as supported host APIs. The runtime lists the actual host functions and points local-helper authors to the required helper-before-`main(args)` ordering.
