# Behavior: ToolScript and scheduled work

For developers and Agents changing programmatic tool use, script results/continuations, or work scheduled for later. A program can consume tool data without exposing every intermediate value to the model. A script run, its caller's turn, a launched process, and a timer invocation have different lifetimes. [Execution and waiting](execution-and-waiting.md) owns process receipts and Session turn controls; this page owns how programs and schedules use those operations.

## Execute a program using authorized tools

**Governing capability and authority constraints; directly selected.** Let a program compose existing tools and consume native values while retaining the caller's normal permissions. The VM, run records and display projection are derived mechanisms; executing code inside ToolScript does not grant direct host filesystem/process authority.

`run_script` executes supplied code or a file-backed program in the constrained ToolScript VM. Its `args`/`argsJson` supplies the program's input. Filesystem, process, and other host effects go through authorized tool calls; loading a skill or running a script does not enable otherwise denied tools.

A file source's Node selects where source is read, not where the VM or every nested operation executes. Nested tools independently resolve their actual Node, cwd, paths, and authorization. Source must come from a proven complete authorized read or complete-transfer fallback, not a shortened display excerpt. A complete programmatic read can be used directly without another transfer. Exact completeness and transport rules remain at [authorized file source](../units/src-toolscript.md#d-toolscript-authorized-file-source), with placement at [Nodes and workspaces](nodes-workspaces-and-permissions.md#selection-routes-operations-not-the-whole-session).

### What does the program consume, and what does the model receive?

| Consumer | Observable result |
| --- | --- |
| Nested `call_tool` in the program | Native result values through resolved dispatch. The program can compute with them without parsing a readable model/browser receipt. Native shape is operation-specific, not a universal text envelope. |
| Programmatic discovery | The same readable discovery `output`, plus structured tool descriptors and available warnings. Requested schema detail includes available MCP output contracts in the detailed subset, not an invented schema for every tool. |
| Calling model's outer run/continuation result | Run status and identity, printed output for that invocation, returned business value when present, pause/error information where relevant, and supported promoted images. Discarded nested values do not automatically become individual model-visible results. |
| Run inspection | Persisted run diagnostics and cumulative stdout, including activity that is not copied into the lean execution result. Inspection is not execution or automatic continuation. |

Ordinary model-facing `search_tools` returns readable `output`; trusted programmatic calls additionally supply descriptors. The programmatic context is supplied by real execution, not a caller argument that bypasses permission checks. Discovery can show an argument-dependent capability that later fails strict authorization or target validation. Keep those rules at [discoverable versus invocable](nodes-workspaces-and-permissions.md#discoverable-is-not-necessarily-invocable); formatter/schema budgets stay at [unified discovery](../modules/tools-and-permissions.md#d-tools-unified-discovery).

A normal reduction can read a large value, compute a small answer, and return only that answer. Printing publishes text into the outer result; returning publishes the business value. Neither is a claim that the nested operation's side effects succeeded beyond its real receipt. False, zero, null, and empty values remain author data, not absent-result failures. Supported image-bearing returns promote images into the ordinary tool-image lifecycle rather than requiring the model to decode embedded bytes; [image representations](files-images-and-attachments.md#original-image-provider-input-and-browser-preview-are-not-the-same-object) explain their later use.

The outer result does not automatically publish unprinted intermediate values when a later host invocation fails. Already printed output remains available with the failure, and an already-started exec retains its independent tracking/completion. [Cancellation receipts](execution-and-waiting.md#cancellation-receipts-must-describe-what-is-known) owns settled nested-exec results and the fence before later host effects. Bounded readable output and preserved success/error classification remain at the [generic result/control boundary](execution-and-waiting.md#tool-values-presentation-and-turn-controls-have-different-consumers).

## Pause and resume the run

Foreground and background modes both execute their first slice inside `run_script`; background mode is not a generic detached job queue. A slice timeout pauses at a safe host-call checkpoint, not by cutting off an in-progress tool/model call. `ask_agent` and timeout checkpoints require `continue_script`; only the separate background managed-event path auto-resumes. A script pause is not a caller-Session `wait` and does not itself request another model turn.

A pause receipt identifies the run and continuation, with its question or timeout reason. Continuation resumes saved VM state under the owning Session, not current file source or a fresh replay of earlier effects. Editing the source after a pause therefore does not change that saved program. Compatible restart snapshots can continue; incompatible snapshots fail clearly rather than pretending to rerun the source.

Printed output in a continuation response is the new output from that continuation, not every earlier print repeated. Inspection retains cumulative stdout. A failed slice can expose partial output and a real traceback without a normal return value; that failure does not undo effects already performed. [ToolScript runtime](../units/src-toolscript.md#behavior) owns run/snapshot formats and [scripting](../modules/scripting.md) owns the managed-event exception.

Runs and snapshots are owner-Session scoped. Completing a script does not grant another Session permission to resume it. Newly executed calls retain current authorization, Node placement, path checks and isolation; possession of an old continuation is not a stored grant for future effects.

## End the caller's turn deliberately

A run returning normally is not a final assistant answer and does not by itself put its caller into a Session wait. The terminal-wait contract established on 2026-10-19 keeps ordinary `call_tool("wait", ...)`: it affects the caller only when it remains the last host invocation and the outer explicit `run_script`/`continue_script` completes normally:

```python
result = call_tool("exec", {"command": args["command"], "timeout": 1})
if result.get("status") == "running":
    call_tool("wait", {"waitExecIds": [result["execId"]]})
return result
```

The exec's script-facing result supplies real structured status/identity; this example does not parse a human-readable receipt. The wait is deferred until normal outer completion, leaving the script's business return value independent. No special `finish` object or dictionary with control-looking keys is recognized.

| What follows a nested wait | Does the caller enter that wait? |
| --- | --- |
| Pure computation, `print`, ordinary return | Yes, on normal outer completion after current validation/authorization. |
| Another host invocation, including a failed tool, nested script, model call, or `ask_agent` | No; the later invocation invalidates the earlier intent. A later actual wait may establish a new one. |
| Script error or pause | No wait is armed on that outcome. |
| Safe timeout checkpoint followed by continuation | The dedicated saved intent can survive, but only normal completion with no later host invocation commits it. |
| A returned/stored object that merely resembles a wait receipt | No; script data is never scanned for control. |

The last-host-call rule exists so the caller cannot enter wait while the script still has later host work to perform. Nested scripts share this boundary: an inner completion cannot arm a caller wait while its parent can still call tools. A wake resumes the Session's ordinary turn; it does not resume execution after the script's completed return. Actual script checkpoints resume saved VM state through `continue_script` instead.

Wait source validation, sibling-error cleanup, fallback timing and ordinary incoming wakes remain at [explicit Session wait](execution-and-waiting.md#explicit-wait-ends-an-otherwise-finished-turn). Script return values and stdout do not establish trusted control authority. The current external-result control limitation remains explicit at [execution Open Questions](execution-and-waiting.md#open-questions), not a supported return-value protocol.

## Schedule a message or execute a quiet script

**Selected capability distinction; quiet owner-bound script timers were directly requested.** Reuse ordinary authorized ToolScript without waking a model or appending conversation when only script work is needed. Scheduler records and restart rules implement that purpose; timer delivery is not evidence of a completed model turn.

Timer tools are discoverable rather than injected into every default tool schema. Registration creates a persisted schedule, not proof that the later action ran. The target defaults to the calling Session; timer access is still authorized. Scheduling for a new Session and scheduling a script for the current owner are different actions:

| Scheduled action | Work and settings at firing | Model/history consequence |
| --- | --- | --- |
| Message to an existing Session | Enqueues the stored message as source-labelled timer input. | Ordinary input can wake idle work or join busy work at supported safe points. Receipt is not proof the model consumed it or answered. |
| Message to a new Session | Allocates a fresh Session under the recorded target Agent, using captured prospective model/raw effort/Node settings. The inherited model/effort pair is revalidated against current model capability at fire time. | The message enters that new Session's queue, not the owner's conversation. Creation alone and message consumption remain different events. |
| Owner-bound ToolScript | Runs one slice through the actual owner's authorized ToolScript path. It resolves current owner routing, rereads file-backed source, and rechecks starter/source/host permissions. | No automatic history append, model request, error notification, or caller-turn wait. The script chooses whether to send a notification or perform another effect. |

ToolScript timers belong to the calling canonical Session; a message target is not permission to configure code for another owner. Supplied script updates replace the complete specification. File source is not read at registration, so editing it changes later invocations; this differs from resuming a previously paused snapshot. Source Node selection still does not relocate nested calls.

Quiet execution exists so recurring checks can notify only when there is something useful to report, without involving a model for every tick. A real script send, one-shot model call, or background exec completion retains that operation's ordinary effects; “quiet timer” does not suppress effects the program explicitly requests. An unattended nested wait has no calling model turn to stop/wait and does not replace the owner's existing Session wait. A failed or paused script remains observable through run inspection and structured logs, not an automatic model error message.

Main-local script execution can run while its owner's model request is in flight without replacing that request's abort controller. Worker execution uses its exact owner's cooperative safe points; one outstanding provider/tool await can delay a tick. Do not infer prompt concurrent execution in every placement merely from the same timer API. [Timer owner routing](../units/src-timers.md#script-action-contract) retains those mechanics.

### Change a schedule, finish an invocation, or restart

- A one-time message timer is removed after delivery or delivery failure; a one-time script timer is removed after its attempted slice, including failure or pause. Cron timers remain scheduled. Registration or `lastTriggeredAt` is not a business-success guarantee: script time records an attempted invocation, while message time records successful delivery admission.
- Only one slice of the same script timer may be in flight, including owner admission. Overlapping ticks are skipped, not accumulated for replay. Completion, failure, or pause ends that invocation; a paused run needs ordinary manual continuation and is not automatically resumed by a later tick.
- Update preserves omitted timer fields and replaces the supplied schedule/payload as defined by the action. An older in-flight invocation cannot consume an accepted replacement record when it finishes. Delete stops future ticks, not prior tool effects or an already-started process.
- Restart reloads schedules: an overdue one-shot becomes due, while cron resumes scheduling rather than replaying every missed tick. There is no general exactly-once effect guarantee. [Persistence and recovery](persistence-and-recovery.md#recoverable-pauses-and-independent-work) owns unknown outcomes and retained run/process evidence.

Exact schedule grammar/time interpretation, normalization, rescheduling failure behavior, wait-timeout timers, and persisted records remain in [timers](../units/src-timers.md). Internal Session-wait timeouts are not public script timers or ordinary message-timer subscriptions.

## Change and test entry points

- `src/tools/unifiedSearch.ts`, `src/tools/resolvedTools.ts`, and `src/toolscript.ts` connect discovery, native nested dispatch, execution projection, and saved continuation. `src/tools/unifiedTools.test.ts` covers ordinary/programmatic discovery; `src/toolscript.test.ts` covers native values, lean outer results, cumulative inspection, continuation deltas, real provider serialization and image promotion.
- `src/toolscriptSource.test.ts` and [authorized file source](../units/src-toolscript.md#d-toolscript-authorized-file-source) cover source permission/completeness/placement. `src/toolscriptWait.test.ts` covers normal completion, invalidation, nesting, checkpoints and batch-error cleanup. `src/sessionTurnRunnerDetachedOwner.test.ts` connects a real owned exec completion, returned image and final nested wait through the runner.
- `src/toolsSessionAgent/timers.ts`, `src/timers.ts`, `src/timerScript.ts`, and [timer implementation](../units/src-timers.md) connect registration to message or owner-bound script consumers. `src/timerScript.test.ts` covers quiet busy-owner execution, live source/permission checks, explicit self-notification, pause/failure, overlap and replacement; `src/timerWorker.test.ts` covers the cooperative Worker path. `src/timers.test.ts` covers message scheduling, updates and new-Session model/effort drift.
