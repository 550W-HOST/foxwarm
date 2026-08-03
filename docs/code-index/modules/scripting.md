# Module: scripting

## Responsibility

Scripting owns ToolScript: a constrained Python-like automation runtime implemented with Monty. It provides foreground and background runs, persistent run records, safe suspension and continuation, nested tool calls, optional model requests without session context, and managed-session orchestration.

## Key units

- [src-toolscript](../units/src-toolscript.md) — Foxwarm tool handlers, run persistence, host-call dispatch, suspension, and continuation.

## Public interfaces

- `run_script` — start a foreground ToolScript run.
- `run_script({ mode: "background" })` — use the persisted background mode required for managed-event auto-wake; the initial slice still executes in the initiating tool call.
- `continue_script` — resume a run waiting for agent input or a timeout checkpoint.
- Hidden, discoverable management tools list, inspect, and cancel persisted runs.
- Hidden `start_toolscript_run` remains callable only for documented user-automation compatibility.
- `resumeBackgroundToolScriptRunForManagedSession` resumes controllers when a managed-session event arrives.
- Scripts call the external host functions `call_tool`, `request_model_without_context`, `ask_agent`, `open_managed_session`, `session_step`, `release_managed_session`, and `wait_for_managed_event`; Monty provides ordinary language/runtime behavior such as `print`.

## Invariants

- Source must define `main(args)`.
- The Monty worker VM enforces memory, recursion, and duration limits; the current runtime does not expose an allocation-count limit.
- The slice timeout is checked at safe host-call boundaries and does not interrupt an in-progress tool or model call.
- ToolScript has no separate file host API. Any file operation composed through `call_tool` passes the normal Foxwarm tool/path/isolation checks.
- Monty OS-function and mount capabilities are rejected so they cannot bypass the normal tool boundary, as required by [D-toolscript-os-effects-through-tools](../units/src-toolscript.md#d-toolscript-os-effects-through-tools).
- A persisted run belongs to one session; other sessions cannot inspect or resume it.
- A background run cannot be resumed concurrently.
- VM snapshots and run records persist an exact runtime/format identity so compatible waiting runs survive process restart; incompatible waiting snapshots fail clearly without affecting completed history, as required by [D-toolscript-versioned-snapshot-runtime](../units/src-toolscript.md#d-toolscript-versioned-snapshot-runtime).
- Nested tool calls execute through the normal tool layer but are represented as subcalls of the outer ToolScript run rather than appended as ordinary outer-session tool history.
- Managed-session leases are released explicitly by controllers or best-effort during cancellation and incompatible-snapshot terminalization; failed cleanup remains retryable from the terminal run record under [D-toolscript-versioned-snapshot-runtime](../units/src-toolscript.md#d-toolscript-versioned-snapshot-runtime).
- Only background managed-event waits auto-wake. Agent-input and timeout waits require `continue_script` in either mode.

## Compatibility

- The recommended `call_tool` shape is the unified descriptor (`toolId` or source/server/node/name plus args). A supported string shorthand may remain as a convenience reader, but new examples use the descriptor.
- `continue_script.input` is a string at the tool boundary. Structured continuation data is carried as a JSON string and parsed by the script.

Safe timeout/snapshot suspension is canonical in [D-toolscript-safe-timeout](../units/src-toolscript.md#d-toolscript-safe-timeout).

## Design decisions

### D-toolscript-one-run-model

Foreground and background execution are modes of one persisted ToolScript run model, not separate engines.
Both modes execute their initial slice in the initiating `run_script` call; background mode is not a detached generic job queue.

### D-toolscript-agent-pause

ToolScript exposes `ask_agent`, not a separate direct-user prompt primitive. The current agent receives the question and resumes the run through `continue_script`.

### D-toolscript-history-boundary

Nested calls remain observable in the ToolScript result and run record without polluting the outer session with every internal tool call.

### D-toolscript-managed-controller

Managed-session orchestration is available through explicit host primitives. The runtime does not depend on source-rewrite macros or a second controller framework.

### D-toolscript-minimal-host-api

The host API stays small and composable. Tool discovery remains the agent's responsibility through the normal Foxwarm tool surfaces rather than a ToolScript-only discovery helper.
