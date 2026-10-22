# Behavior: persistence and recovery

For developers and Agents changing durable state, restart behavior, or failure handling. This page describes the current TypeScript Main and its optional Session-worker placement, not a blanket compatibility claim for another runtime. Persistence preserves particular committed records; it does not preserve every in-memory phase, prove external side effects, or make all stores one transaction.

## Identify the authority before interpreting a restart

| State | Durable meaning | What must not be inferred |
| --- | --- | --- |
| Per-Session JSON | Full semantic Session authority: active history, queue, wait/managed metadata, prompt/cache state, settings, provenance, and Worker mailbox cursor where present. | A catalog stub's empty history is an empty conversation, or Archive should be used to repair missing active authority. |
| Main catalog | Durable identity/topology/list state plus bounded Session presentation/projections and recovery indexes. | Every displayed phase is live execution, or the catalog is a second full semantic Session copy. |
| Archive and request journal | Historical originals/blocks and recorded canonical model requests/attempts, respectively. | Archive is the current model context, or an attempt-start row proves a request reached the provider. |
| Queue or Worker mailbox intent | Accepted input still to be applied/consumed at the relevant boundary. | The Agent answered it, a tool effect completed, or a recipient human saw output. |
| Wait and timeout timer | Persisted wait conditions; separately persisted scheduled wake where configured. | A model request remains open, or the waited-for dependency will necessarily finish. |
| Task store | Shared Task ownership, status, notes/results, and notification bookkeeping in its own database. | Task status is Session runtime state, or committing a Task mutation proves notification delivery. |
| ToolScript run/snapshot | Owner-scoped run record and, when saved at a supported pause, versioned VM continuation. | A `running` record is a continuously surviving interpreter or an automatically replayable external call. |
| Persistent exec registry/artifacts | Tracked execution identity, owner, backend observation, and available capture/status. | The OS process necessarily survived, or missing status means exit zero. |
| Active tool/model phase, stream draft, socket/cache reuse, failover health | Process-local working/presentation state. | These are a durable checkpoint or can be restored merely from an old UI view. |

[Conversation and history](conversation-and-history.md) owns the active/Archive/memory distinction. [Execution and waiting](execution-and-waiting.md) owns exec, wait, Continue, Stop, and ToolScript continuation semantics. Use those rules rather than redefining their complete lifecycles here.

## Restart resumes recorded work, not the last machine instruction

A normal Main-local restart examines indexed busy/queued/managed candidates and hydrates those exact authorities. A previously busy owner has stale busy fields cleared and receives a deduplicated `session-resumed` event so ordinary processing can reassess the interruption. Triggering queued work resumes through the normal runner. Passive-only queued input remains passive; its presence does not start work merely because the process restarted.

This is not a scan of historical error text. A Session already durably idle with no triggering queue does not become startup work just because an old tool or provider error remains in history. Nor is restart a regenerate action for a completed answer. [Session recovery](../units/src-session-manager.md#d-session-restart-recovery) and [active turn/restart](../threads/session-lifecycle.md#active-turn-and-restart) own candidate and event rules.

With Session workers enabled, the exact Worker owns semantic recovery. Main does not hydrate and execute residual local queues as a fallback. Startup ensures eligible pending-mailbox and stale-busy owners through the Worker path; per-Session recovery failures are logged and leave durable work available for a later attempt. Residual local queued/managed work can remain until later durable Worker ingress. Switching placement is therefore not a promise that every old local queue immediately executes.

Worker input processing commits full Session JSON, including the applied mailbox cursor, before acknowledging the prefix in the coordination database. Recovery can recognize JSON committed before a lost acknowledgement without applying that prefix again. This guards that internal handoff; it does not make provider requests, shell commands, or other external effects exactly once. A coordination cursor ahead of authoritative JSON fails closed rather than being copied into the authority as a repair. See [Session-state authority](../threads/process-topology-and-rpc.md#d-process-topology-session-state-authority).

The original “durable before Worker spawn/wake” ordering has a recorded implementation/intent discrepancy: ordinary ingress currently ensures the owner before appending its intent, while input remains durable before accepted-input processing. Do not turn either historical intent or this implementation ordering into an unqualified public guarantee; [Worker ingress durability ordering](../threads/process-topology-and-rpc.md#worker-ingress-durability-ordering) retains the unresolved question.

### Graceful shutdown and crash are not interchangeable

Current Main-local shutdown first closes turn admission and lets accepted owner work drain while dependencies remain available. A genuine final, terminal wait/handoff, or user Stop keeps normal idle finalization. An unfinished shutdown-owned yield retains the existing busy recovery checkpoint instead of appending a fake terminal model error. A bounded forced exit has crash-like semantics, not proof that every service child has acknowledged exit.

Session workers retain their separate generation/incarnation fencing and drain/handback protocol. Neither path promises that user subprocesses survive OS shutdown, Node loss, resource destruction, or external termination. The rationale and exact safe points remain in [local shutdown](../threads/session-lifecycle.md#d-lifecycle-main-local-shutdown); do not generalize its hooks to every placement.

## Recoverable pauses and independent work

| Interrupted state | Expected evidence after restart | Limit |
| --- | --- | --- |
| Explicit Session wait | Recognized persisted wait still derives a waiting state; its declared sources remain conditions for later activity. Timeout timers are reloaded by the timer subsystem. | A fallback wake asks the Agent to reassess, not declare the dependency successful. Stale timeout tokens cannot wake a replacement wait. |
| Persisted overdue one-shot timer | Scheduling makes it due for delivery; recurring timers resume scheduling. | There is no general exactly-once effect or full missed-cron-backlog replay promise. Delivery and timer bookkeeping have their own failure windows. |
| Task completed before notification failure | Task stays completed and the delivery warning/status is independent. | No background completion-notification retry runs, and repeating `complete` does not resend; terminal Tasks reject mutation. A lost response calls for inspection, not a second completion claim. |
| ToolScript paused for Agent input or safe timeout | A compatible saved snapshot can resume with the matching continuation under its owner Session. | Continuation resumes the snapshot, not current file source. Incompatible snapshots fail clearly while retaining historical evidence; an in-progress host effect is not a saved safe pause. |
| Persistent exec tracked at restart | Registry reconciliation observes the recorded backend and routes completion to its exact owner when supported. | Process survival, log availability, notification retention, and transport capabilities remain separate. Lost status produces an unknown outcome, not synthetic success. |

Timer semantics and persistence entry points are in [timers](../units/src-timers.md). Task commit/notification rules are in [Tasks](../units/src-tasks.md#actions). Compatible/incompatible VM snapshots and owner checks remain in [ToolScript](../units/src-toolscript.md#behavior). Exec's retention and uncertain-start boundaries remain in [persistent exec](../units/shared-persistent-exec.md#shared-tracking-and-provider-observations).

## Unknown outcomes require evidence, not automatic repetition

A lost reply can occur after an effect, after its state commit, or before either. Distinguish these cases instead of relabeling all of them as “failed, safe to retry.”

| Observation | Safe interpretation |
| --- | --- |
| Model attempt start exists but no settled result | Preparation/start was recorded. Send may have been prevented or the reply lost; this alone does not prove dispatch or success. |
| Provider generation succeeded, then result-record logging failed | The provider must not be called again merely to repair that result record. |
| Tool call was dispatched but its receipt was lost | Side effects may already exist. Inspect supported target/history/status evidence; do not assume rollback or replay authorization. |
| Continue/Stop owner response was lost | The control may have committed. Inspect canonical history/runtime state rather than automatically repeating the control. |
| Task/config state committed but postcommit notification/cleanup failed | The state change remains real. Report the incomplete follow-up separately. |
| External output delivery failed after history commit | Committed history remains; a failed transport is not proof that the model never answered. Existing delivery paths do not imply an outbox or automatic replay. |

For example, a restart after a command launch can leave a busy Session, a recoverable exec record, and no outer tool result. The resumed Agent should use that execution's recorded identity/status where available. Starting the same command again to “resume” it could repeat effects. An uncertain provider or remote tool call without such evidence remains uncertain; no global deduplication key is supplied by the Session ID or turn ID.

## Optional-service failure is not authoritative-storage failure

Configured Vector initialization failure is nonfatal to Main startup in local and child placement. Main retains the configured owner and its unavailable state, logs the failure, and continues nonsemantic work. Semantic operations report unavailability; they must not return a fabricated empty successful search, mark Vector disabled, repair/delete its files, or silently open a second owner. A child watchdog can retry only under its existing observed-exit fence; local placement gains no automatic retry scheduler. [Vector placement](../threads/process-topology-and-rpc.md#vector-placement) owns this degradation boundary.

Raw Archive, exact recall, and active Session authority are independent of semantic indexing. Asynchronous indexing can lag without erasing the underlying messages. This does not mean every derived artifact can be rebuilt identically: dedicated compact-fact indexing has its own disabled-period limitation documented in [optional Vector](../threads/archive-and-recall.md#d-context-optional-vector).

Catalog/Archive initialization, identity-recovery validation, and required data migrations are outside that optional boundary. Their failure can reject startup. Invalid Agent authorization metadata must not become an empty permissive map. Missing or malformed per-Session authority fails that semantic load rather than manufacturing empty history from a catalog/Archive fallback. Some older noncritical save paths still log errors best-effort; do not describe all existing writes as strictly acknowledged durable commits. Strict owner paths distinguish known precommit failure from authority committed but catalog/publication follow-up failed, retaining/resynchronizing committed state in the latter case. See [critical persistence](../units/src-session-manager.md#internal-sections) and [active-history authority](../threads/context-compaction-and-recall.md#d-context-active-history-authority).

## Code rollback is not state rollback

Replacing program code does not undo saved configuration, migrated schemas, Session history, Tasks, archived identities, provider billing, or external tool effects. An old binary must be a supported reader/writer of the retained state before it can safely resume that installation. A concrete boundary is Session-worker lineage: current code supports workers disabled, but pre-Worker code is not a supported writer after a nonzero mailbox cursor. Losing that JSON cursor while coordination acknowledgement survives causes a deliberate fail-closed mismatch, not automatic downgrade repair. [Worker downgrade](../threads/process-topology-and-rpc.md#d-process-topology-session-worker-downgrade) owns the compatibility decision.

A state restore is a separate, explicitly scoped operation. Individual JSON replacement and SQLite transaction boundaries do not create a global atomic backup across Session authorities, catalog, Archive, request journal, Task database, image blobs, timers, ToolScript records, exec artifacts, and external systems. Store-specific backup/fallback behavior is not universal: active Session authority does not rotate or silently load a backup, whereas some ancillary stores can load configured fallback files. An apparently newer catalog or Archive must not be used to guess missing semantic state.

Identity moves have their own pending recovery journal and committed ID-reservation ledger; startup follows recorded finish/rollback intent and rejects conflicting evidence. That scoped recovery is not a generic transaction manager or permission to rewrite unrelated data. See [identity reservations and move recovery](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation). A backup/restore design must account for the actual store dependencies and runtime compatibility rather than infer consistency from a code checkout or a copied directory name.

## Change entry points

- `src/sessionManager.ts`, `src/session/metadataStore.ts`, and [catalog storage](../threads/main-catalog-storage-and-indexed-queries.md) connect loading, authority commits, projections, and indexed recovery selection.
- `src/sessionWorkerIngress.ts` and `src/sessionWorkerPersistence.ts` implement pending-intent recovery and JSON-before-ack reconciliation; `src/sessionWorkerPersistence.test.ts` covers the commit/ack crash window and cursor failures.
- `src/index.ts` orders authoritative startup before optional Vector and establishes recovery callbacks; `src/vectorStartup.integration.test.ts` exercises optional initialization failure.
- `src/session/sessionResumeDedup.test.ts`, `src/toolscript.test.ts`, and `packages/shared/src/persistentExec.test.ts` locate restart-event, compatible-pause, and tracked-exec recovery regressions.
- [Configuration and activation](configuration-and-activation.md) owns saved/applied/restart distinctions; [models and requests](models-and-requests.md) owns routing, request identity, and provider-sensitive history.
