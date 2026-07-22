# Unit: src-toolscript

Files: src/toolscript.ts, src/toolscript.test.ts
Secondary files: src/toolscriptSkills.test.ts

## Purpose

Implements persisted foreground/background ToolScript runs in the Monty Python-subset VM. It validates `main(args)`, enforces VM/slice limits, dispatches a small host API, stores snapshots/run records, resumes waits, and coordinates managed-session leases.

## Actual exports

- `tool_run_script(args, ctx)` — start a run; mode may be foreground or background.
- `tool_start_toolscript_run(args, ctx)` — explicit background starter.
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

Unknown external function names are returned to Monty as runtime exceptions. There is no separate ToolScript file-I/O or MCP client path; scripts compose normal Foxwarm tools through `call_tool`.

## Stable-symbol index

| Symbol/section | Responsibility |
|---|---|
| source/timeout/limit parsing | `main(args)` validation and bounded execution options |
| call-tool descriptor normalization | String shorthand and unified target descriptor to wrapper args |
| run persistence | Owner-scoped JSON record load/save/list |
| `executeScriptHostCall` | Current host function dispatch |
| `advanceExecution` | Complete, host-call, agent-wait, managed-wait, and timeout-safe checkpoints |
| `startRun` / `resumeRun` | Monty start and snapshot continuation |
| tool handlers | Session ownership, mode, continuation, cancellation, and result shaping |

## Behavior

- Default slice timeout is 30 seconds; allocation, memory, recursion, and duration limits are passed to Monty.
- Timeout is checked at safe host-call boundaries. When exceeded, the run stores the pending return/exception plus snapshot and returns a continuable timeout state.
- `ask_agent` and managed-event waits persist snapshots; completed/failed/cancelled runs clear resumable snapshots.
- Run records live under the state data root and are accessible only from the owner session.
- `activeBackgroundRuns` prevents concurrent execution/resume of one background run.
- Managed leases acquired by a run are recorded and released on cancellation/completion cleanup.
- `call_tool` subcalls publish ToolScript progress and are kept in the outer run result/record. They do not append each nested call as ordinary outer-session tool history.
- `continue_script` returns stdout produced in that continuation slice; persisted status retains cumulative stdout.
- Inline image payloads from a final result are promoted to the outer tool result and replaced with compact placeholders inside the textual result.

## Compatibility

- `call_tool` accepts the supported string shorthand and the current unified descriptor. New examples use the descriptor.
- `continue_script.input` is a string at the tool boundary; structured input is passed as JSON text and parsed by the script.
- Hidden direct MCP runtime handlers still exist, but ToolScript examples use unified `call_tool` so builtin/MCP/node dispatch shares one path.

## Design decisions

### D-toolscript-dynamic-dispatch

Nested tool execution dynamically calls the exported `./tools.call_tool` wrapper. It does not call `llm.executeTools` and does not maintain a parallel registry.

### D-toolscript-safe-timeout

A slice timeout pauses only at a host-call checkpoint with a persisted pending return/exception, allowing exact continuation instead of restarting the script.

### D-toolscript-owner-bound-run

A run and its snapshot belong to one session. Cross-session inspection/resume is rejected, while managed-session access requires explicit leases.
