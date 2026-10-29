# Behavior: execution and waiting

For developers and Agents changing shell execution, turn controls, or explicit waits. This page owns their observable meanings; [ToolScript and scheduled work](automation-and-scheduled-work.md) owns program results, continuations and scheduled invocation. A Session turn, a shell process, a persisted script run, and a wait are different lifetimes; ending one does not imply that the others ended. [Messages and turns](./messages-and-turns.md) owns input/request boundaries, while [Nodes, workspaces, and permissions](./nodes-workspaces-and-permissions.md) owns placement and path authority.

## Exec waits for a process; it does not lease its lifetime

**Governing lifetime constraint; directly requested.** A tool wait may finish or be interrupted while its process continues. Foreground/background exec, completion events and log inspection derive from that separation; transport timeouts must not silently become process termination.

[2026-09-06; interruption clarified 2026-10-11]

`exec` launches a shell command in the selected execution environment. Persistent-exec paths retain captured output in a log. It is not the interactive Terminal/PTY surface. `timeout` bounds foreground waiting: the default is 15 seconds, with a minimum of 1 and a maximum of 60 seconds. Requests above 60 are clamped with a warning. The command is not killed when that wait expires. This separation lets the Agent regain control while long-running work continues.

The following receipts describe persistent exec; limited transports are distinguished below.

| Observed outcome | Human/runtime-Agent evidence | What it does not mean |
| --- | --- | --- |
| Completes during foreground wait | Captured output and actual exit status; a nonzero exit is still a real execution result. | No automatic retry, rollback, or proof that requested business work succeeded. |
| Foreground timeout | Partial output and a background receipt with the actual `execId`, execution-Node/log locator, and elapsed time. | The command hit a lifetime limit or was killed. |
| Stop/Run queued interrupts a supported foreground wait | Partial/background-style receipt naming the interrupted wait; tracking and later completion delivery remain. | The configured timeout elapsed, or process side effects were undone. |
| Completion is already available when interruption is observed | The settled completion wins and its real output/status is retained. | An abort should replace it with a synthetic cancellation error. |
| Dispatch/start outcome is uncertain | An error/unknown receipt at that boundary, not permission to launch again. | The command definitely never started. |

A background receipt means completion is still outstanding. Normal tracked completion queues a later event to the owning Session, with the same execution identity and exit information. The Agent can do independent work or explicitly wait for that event; repeatedly rerunning the command is not a way to check it. When a log is available, it belongs to the execution Node, not automatically to Main's filesystem. Output excerpts are bounded; a receipt or preview is not necessarily the complete log.

### Persistence and capability limits

Persistent execution tracking supports restart reconciliation; it does not promise that an OS process survives host shutdown, console closure, Node loss, provider destruction, or external termination. In the current shared manager, background tracking strictly older than 24 hours from start expires without killing the process or deleting artifacts. Treat that as a notification-retention limit, not an execution deadline or a guarantee of indefinite notification.

Native Main/Session-worker execution, compatible authenticated CLI Nodes, and Core-managed primitive-provider exec support foreground-wait handoff. Older Nodes or transports without that capability may return only their eventual real receipt and cannot promise prompt Stop. Primitive-provider polling/start uncertainty and hard owner-loss/deadline cleanup are separate from ordinary user Stop. Do not infer parity from a shared tool name. Transport capabilities and recovery are owned by [tool cancellation](../threads/message-processing-pipeline.md#d-pipeline-control-commands), [persistent exec](../units/shared-persistent-exec.md), and [Node dispatch](../threads/tool-dispatch-node-execution.md#d-dispatch-generic-node-providers).

The exec-only [Shell HTTP Node](../units/src-nodes-shell-http.md) is a concrete limited transport: it retains bounded output samples, not a full log; its initial background reply carries the execution ID/notice, with sampled output arriving at completion. Its process-local dispatch state does not provide the persistent manager's restart reconciliation. Do not manufacture a log locator or complete-output claim for it.

## Stop, Run queued, and Continue

These control the current Session turn, not all work launched by the Agent:

| Action | Current turn | Queued input | Already-started external work |
| --- | --- | --- | --- |
| Stop (`/stop`) | Interrupts the current provider request/foreground tool batch and ends the main run. | Commits queued message/event inputs as ordinary history without running another provider turn for them. Later input can start a new turn. | Exec stops waiting, not the process. Other tools use their supported cancellation path; effects may already have occurred. |
| Run queued (`/dequeue`) | Stops current work when necessary, then continues through the ordinary runner. | Runs queued work rather than passively committing it and stopping. | Same foreground cancellation boundary as Stop; no background-work sweep. |
| Continue (`/continue`) | Resumes an interrupted idle turn using current committed context. It is not regenerate/retry-the-previous-answer. | New compatible input joins at normal safe points. | Does not replay an uncertain external operation automatically. |
| Cancel compaction (`/stop compact`) | Cancels active/pending compaction, independently of the main run. | Does not itself apply Stop's passive-input behavior. | Not a shell-process control. |

Bare Stop does not cancel compaction. If the main run is awaiting synchronous automatic compaction, that compact finishes before ordinary Stop finalization. Standalone compaction is not a main run that bare Stop can stop.

Continue is available only for an idle, interrupted current turn after retained foreground processing has settled, never an actively waiting Session or a completed answer. The .NET runtime processing projection withholds Continue during preparation or cleanup even when the committed busy checkpoint is idle; ordinary idle processing displays Running. The exact owner revalidates committed history before claiming the turn. An unfinished tool exchange, a user/system input without completion, or a current retry failure can leave a turn continuable; complete paired terminal handoffs without batch errors are not interrupted answers. A handoff whose terminal action was suppressed by an error remains continuable if later interrupted. Temporary streams, queued previews, historical viewer rows, and viewport position never establish availability. The [shared continuation classifier](../units/shared-session-continuation.md) owns the precise rules. There is no public `/retry` alias. A lost Continue control response can mean the resumed turn already committed/delivered; report unknown outcome and inspect history rather than automatically issuing it again.

### Cancellation receipts must describe what is known

A stopped batch still needs ordered call/result pairing. Calls prevented from starting receive an unstarted cancellation receipt. Dispatched calls without a settled result identify Stop or Run queued when known and explain possible remote side effects or continued execution; they must not claim rollback. Completed siblings keep their actual results, including errors, partial output and images. An ordinary SDK timeout/disconnect is not relabeled user cancellation.

ToolScript checks foreground interruption before its next host effect; Stop is not arbitrary VM or file-operation preemption. A host call that already returned keeps its real completion and payload: the script can consume, print or return that value before another host call is fenced. Retained printed output remains part of the outer result even if a later invocation fails. An outer failure does not automatically publish unprinted nested values; tracking and later exec completion remain independent. Explicit run cancellation and shutdown retain their separate VM lifetime controls. MCP request cancellation cannot undo remote effects or imply that a pooled server was killed. No control scans returned `execId`/`runId` values to cancel background work. A fresh turn receives a fresh signal.

WebUI control acknowledgement confirms receipt, not settled runtime state. Stop remains pending until canonical stopping/idle feedback arrives; a timeout is not displayed as a successful stop. Controls keep their existing permissions, and HTTP acceptance is not stronger authority than the exact Session owner. Correlated UI feedback, status poses and diagnostic details remain in [runtime presentation](../threads/session-runtime-presentation.md#d-session-control-feedback).

## Tool values, presentation, and turn controls have different consumers

**Governing consumer boundaries with distinct bases.** Direct decisions require native program values and bounded useful model presentation; existing authorization semantics require control to come from trusted handlers. Output formatting and typed receipts are separate derived mechanisms; neither arbitrary result fields nor display truncation may change the other consumer's semantics.

Native tool data, a bounded model/browser receipt, and a turn-control signal have different consumers. [Programmatic execution](automation-and-scheduled-work.md#what-does-the-program-consume-and-what-does-the-model-receive) owns what a script receives, exposes through print/return, or retains only for inspection. Complete-data/source predicates and producer budgets remain at [programmatic tool data](../threads/tool-dispatch-node-execution.md#d-dispatch-programmatic-tool-data), not at the readable preview boundary.

Limiting presentation must preserve the operation's success/error classification. Large successful output must not become a sibling error just because it was shortened: an actual sibling error can suppress the [explicit wait](#explicit-wait-ends-an-otherwise-finished-turn). A preview or saved-output locator does not itself change execution status. The [output guard](../modules/tools-and-permissions.md#d-tools-structured-output-guard) owns the bounded envelope and full-output storage.

Wait and handoff authority comes from the executed control operation, not control-looking fields in returned application data. Script return values and stdout do not establish a wait; [normal ToolScript completion](automation-and-scheduled-work.md#end-the-callers-turn-deliberately) applies its separate trusted last-host-call rule. The maintained host uses [separately typed trusted receipts](../threads/tools-permissions-and-exec.md#outbound-mcp-values-and-trusted-control). The retained TypeScript result-folding limitation is recorded under [Open Questions](#open-questions).

## Explicit wait ends an otherwise-finished turn

**Selected control contract; directly requested.** Wait for a real source of progress rather than busy-polling or declaring a source-free stop. Source lists and fallbacks implement that purpose. The empty-list accommodation is a confirmed input rule, while the [handoff/finish distinction](./collaboration-and-tasks.md#is-sending-a-report-the-same-as-ending-the-current-turn) has separate delivery semantics.

`wait` registers Session wait state and returns; it does not hold the tool invocation open until work completes. Its stop-turn request takes effect after the current tool batch.

[2026-10-29] In the maintained runtime, any non-null top-level tool-response `error` in the complete batch suppresses that batch's terminal controls: explicit `wait`, `afterSend:"wait"`, and `afterSend:"finish"`, including mixed controls. The complete ordered call/result exchange is committed before the model continues to handle the error. The executor consumes pending controls, clears only explicit wait tokens created by that batch, and does not arm a handoff wait. Successful delivery, child creation and Task effects remain committed and are not replayed. A failed handoff supplies no successful terminal effect.

This rule uses the existing tool-error classification, not a scan of script return values, stdout or nonzero exec status. Successful controls keep their existing queue/fast-reply behavior. User Stop, unavailable authorization and fatal persistence failures retain their independent handling.

Use a wait when no useful reply or tool work remains, and declare where progress can come from. `reason` explains a wait but is not a progress source by itself.

| Declaration | Meaning and important boundary |
| --- | --- |
| `waitAnySessions: [id, ...]` | At least one accessible, non-self Session is an expected source. This is not a filter excluding ordinary incoming activity. |
| `waitAllSessions: [a, b, ...]` | At least two distinct accessible, non-self Sessions must each send a new message after the wait starts. Listed messages are deferred and released together after all report; duplicates from one do not satisfy another. |
| `waitExecIds: [execId, ...]` | Names actual accessible active executions owned by this Session/Agent or already-queued completions. PIDs, log paths, and command strings are not execution identities. |
| `waitForInput: true` | Declares external/user input as a real progress source. It does not prevent other ordinary activity from waking the Session. |
| `wakeIfNoActivityAfterSeconds: n` | A positive, one-shot fallback wake, not a polling interval and not cancellation of the dependency. Can accompany a source or stand alone. |

The two nonempty Session-list modes are mutually exclusive. Empty optional `waitAllSessions`, `waitAnySessions`, and `waitExecIds` lists are treated as omitted before source validation, mutual exclusion, or fallback selection. They can accompany another real source or a positive fallback. Empty placeholders alone, including an empty exec list, do not make a source-free `wait({})` valid and do not add the exec fallback.

Session/exec sources are validated under current access and ownership rules; an arbitrary ID is not a subscription capability. With a nonempty `waitExecIds` list, omitting the fallback gives a 600-second wake. Explicit `null` disables that default; `waitForInput:true` also avoids adding it implicitly. An explicit positive fallback still applies. Pure Session barriers and input-only waits have no automatic deadline. The old model-facing `timeoutSeconds` argument is not accepted; reading legacy persisted state is a separate compatibility contract.

Ordinary incoming activity can interrupt these waits. In particular, `waitAllSessions` is not an uninterruptible join: unrelated messages or timeout wake it, flush deferred reports, and supply a reminder of still-missing sources. Passive/compaction maintenance can be wait-neutral rather than fabricating progress. Replacing a barrier with deferred reports is rejected instead of dropping those messages. Clear removes the wait. Stale timeout events cannot wake a later replacement wait.

Declared Session dependencies also support a quiescence diagnostic: a closed dependency group with no observed active/queued work, finite fallback, exec source, or external-input path can receive a bounded `wait-sources-quiescent` wake. That is a request to reassess progress, not a report that work succeeded. Scheduling, current-wait correlation, and bounded concurrent wake admission are documented in [activity-wait mechanics](../threads/message-processing-pipeline.md#d-pipeline-activity-wait).

### Example: long command, one completion wake

An exec returns `execId` after its foreground budget. The Agent can then call `wait` with `waitExecIds` containing that exact ID. Completion is ordinary Session input; a fallback wake merely asks the Agent to reassess while the command may still run. Neither wake authorizes replaying the launch.

A terminal handoff can also end a turn, with or without a Session activity wait. It does not mean the target Task completed. Keep delivery/terminal behavior at the adjacent [handoff contract](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait), including `afterSend`, sibling errors, coalescing and fast replies.

## ToolScript completion is not a return-value control protocol

A completed program, a paused run, and a caller-Session wait have separate effects. [ToolScript and scheduled work](automation-and-scheduled-work.md#end-the-callers-turn-deliberately) owns the normal outer-completion/last-host-call rule for nested `wait`, with native inputs, print/return results, saved continuations, and quiet timer invocations. Returning data that resembles a control receipt is not a substitute for executing the authorized control operation.

## Open Questions

- **Retained TypeScript limitation:** its model-batch executor still reads internal control fields from object-shaped results without restricting that read to trusted control producers. Outbound MCP structured results can reach that boundary. The intended data/control separation above is not a claim that this path is already fenced; resolving it requires a runtime change, not a new return-value control protocol.

## Change and test entry points

- [Turn/dispatch ordering](../threads/message-processing-pipeline.md#d-pipeline-control-commands), [exec wrapper](../units/src-exec-manager.md), and [shared persistent exec](../units/shared-persistent-exec.md) locate cancellation, capture, registry and completion owners.
- `packages/shared/src/persistentExec.test.ts`, `src/tools/execToolMessages.test.ts`, `src/stopActiveTools.test.ts`, and `src/commands/stopCommand.test.ts` cover foreground handoff, settled receipts, cancellation and queue consequences. Provider uncertainty/capability tests are linked from [Node providers](../units/src-node-providers.md).
- `src/toolsSessionAgent/waitTool.test.ts`, `src/toolsSessionAgent/handoffWait.test.ts`, and `src/waitLiveness.test.ts` cover declaration, wake/barrier behavior, delivery races and quiescence. [Wait unit](../units/src-wait-tool.md) links detached-owner and timeout-persistence coverage.
- `packages/webui/test/mainHostHandoff.e2e.mjs`, `mainHostAgents.e2e.mjs`, and `mainHostWait.e2e.mjs` qualify original-App error-handling continuations after successful delivery or child creation with a sibling error. They retain complete ordered pairs and once-only effects, alongside all-success handoff waiting, real child reports, sidebar activity, Stop and Continue.
- [ToolScript and scheduled work](automation-and-scheduled-work.md#change-and-test-entry-points) locates program-value, continuation, nested-wait and timer regressions. `packages/shared/src/sessionContinuation.test.ts` covers exact Continue derivation. These are regression entry points, not a new blanket test gate.
