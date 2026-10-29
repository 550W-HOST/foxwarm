# Behavior: collaboration and Tasks

For developers and Agents changing delegation, shared Tasks, or inter-session communication. A child Session is an execution/conversation lifetime, a Task is a shared work record, and a message is delivered input. None automatically stands in for the other two. This page explains the observable choices and outcomes; exact schemas and storage mechanics remain at the linked owners.

## Do I need a child, a Task, or a message?

**Governing product distinction; directly selected.** Track work with lightweight Tasks, use Sessions for conversations/execution, and use messages for communication. Assignment must not silently create a scheduling, approval or workspace-management platform. The stores and handoff transitions below are derived mechanisms for that scope.

| Action | Creates or changes | Does not imply |
| --- | --- | --- |
| Create a fresh child | A new Session with the caller as its actual parent, fresh conversation context, and an optional initial assignment/message. | A new Agent, a Task, an isolated execution environment, or permission to use every tool. |
| Fork a child | A same-Agent child with the parent's copied model-visible prefix and bounded history lineage. | Shared mutable history or access to the parent's later messages. |
| Create a Task | A persistent work record with creator, optional owner, status, description, and notes/result. | A Session, a running executor, a scheduler, or workspace/review integration. |
| Assign a Task to an existing Session | Ownership/status change; optional notification can start that Session's normal queue processing. | A parent link, a fresh context, or cancellation of the previous owner's active work. |
| Send to another Session | A source-labelled input admitted to that target's ordinary queue. | Task completion, parent reassignment, immediate model consumption, or a synchronous answer. |
| Ordinary assistant reply | Output to the current conversation and its eligible Channel delivery path. | An inter-session report or a Task mutation. |

A child with no initial message or Task is created but not started merely by the creation acknowledgement. A non-fork child still receives its creation/identity context; “fresh” does not mean it has no prompt or lifecycle notice. With a non-task initial message and default `afterSend`, delivery is asynchronous after creation; creation success is not a receipt that the child has consumed its assignment. Terminal handoff modes await initial delivery. See [child tools](../units/src-tools-session-agent.md) and [Session lifecycle](../threads/session-lifecycle.md#child-and-fork-lifecycle).

### Parent, Agent, and Task relations are independent

The Session's actual `parentSessionId` owns its direct reporting/topology relation. Agent membership selects the Agent workspace and prompt/memory context. Agent inheritance selects reusable memory; it does not establish a parent, dispatcher, Task owner, or completion destination. Same-Agent Sessions are not automatically parent/child, and a child created under another existing Agent still has the caller as its actual parent.

[Sessions and Agents](sessions-and-agents.md#use-an-existing-lifetime-start-fresh-or-fork) owns fresh/fork/cross-Agent context and meaningful creation-default differences, including Agent-main versus spawned-child settings. [Working instructions](conversation-and-history.md#which-instructions-are-in-the-working-context) owns memory copying versus ongoing inheritance and snapshot adoption; none of those operations creates a reporting relation by itself.

Reparenting changes the relation, not Agent membership, inherited memory, historical text, or Task creator/owner. A Task's immutable `parentTaskId` is another relation: it groups records, does not make Session parents, join child results, cascade completion, or schedule dependent work. [Session relations](../units/src-session-misc.md) and [Tasks](../units/src-tasks.md) locate these owners.

Tool authorization still applies to each action. When either Session is isolated, communication is limited to self/direct parent/child relations; sibling, unrelated, or same-Agent status is not enough. A direct relation does not grant filesystem, Node, or tool permissions. The canonical exception is [isolated Session relations](../modules/session-core.md#d-session-core-isolated-relations).

## Who is acting on a Task?

For model tools, the current ToolContext supplies the actor and records the creator of new Tasks. `ownerSessionId` selects an assignee; it cannot identify or impersonate the caller. Creating with an existing owner commits an active assignment immediately. Omitted/null owner creates an open unowned Task. `claim` takes an unowned Task for the current Session; it cannot take one from another owner.

The supported Session-actor rights for a nonterminal Task are:

| Intended change | Required relationship, in addition to tool permission |
| --- | --- |
| Replace title/description and/or append a note, without a status change | Any permitted Session, including another Agent's Session. |
| Set status to open/active | Current owner, or creator when unowned. |
| Complete with a result | Current owner, or creator when unowned. |
| Assign, transfer, release ownership, or cancel | Creator or current owner. |

A mixed update containing `status` must satisfy status authority for the whole operation; shared title/description/note access does not bypass it. Setting status to open does not release the owner. Use assignment with null to release. Parent-Task linkage is immutable. A supplied update title uses the same nonempty string and 200 UTF-16-code-unit limit as creation. Renaming a Task preserves its identity, ownership and attached Session; it does not rename that Session. Completed/cancelled Tasks reject model-facing mutations, including repeated completion or reopening. Authenticated user comments are a separate current exception: they can append a note to a terminal Task without reopening it.

Task identity/ownership comparisons resolve known Session aliases. List scope is filtering, not a permission grant: the default includes Tasks created by or assigned to the caller; owned/current-Agent/all select different result sets. Current-Agent membership comes from the catalog, not parsing an ID. Generic tool authorization can further restrict an action or resolved Task; see [Task contracts](../units/src-tasks.md) and [tool authorization](../threads/tool-dispatch-authorization.md#d-dispatch-generic-tool-authorization).

### A user-selected Session is not the user actor

The authenticated Tasks WebUI has explicit user-authored create, comment, and assign/release actions. They record a user actor instead of attributing the action to the currently selected Session or owner. The Session selector chooses the recipient. A user-created Task has no fabricated Session creator to notify on completion.

The existing WebUI claim/update/complete/cancel routes retain explicit Session-targeted management semantics. This does not impose a selected-Session impersonation restriction on the full-access administrator surface. Access at the WebUI boundary and model tool authorization are distinct; details remain in [Tasks WebUI](../units/webui-tasks.md) and [the Task service](../units/src-tasks.md#child-attachment-and-webui).

## When does a Task change notify or start a Session?

A committed Task record and a successful notification are separate outcomes:

| Operation | Notification behavior |
| --- | --- |
| Model create-with-owner or assign/transfer/release | `notifySession:true` opts in. A different new owner receives the full assignment normally; a different previous owner receives a brief passive transfer/release notice. Omission/false saves silently. |
| Model update with a note | Only explicit `notifySession:true` notifies a different current owner. Self-authored notes and unowned Tasks have no recipient. |
| Title/description-only update | Never notifies, even with `notifySession:true`. Add an opted-in note when the owner needs to act on a metadata change. |
| Completion | Attempts one normal Task notification to a different Session creator, including the full accepted result. Self completion or a user-created Task has no Session recipient and is skipped. |
| User create/assign | Uses the same delivery rules; the user mutation service defaults notification on when omitted. User comments notify only when explicitly opted in; the WebUI sends its checkbox value. |
| Claim, ordinary status-only update, or cancellation | No automatic assignment/completion notification is generated by these actions. |

New-owner and completion notifications are normal queue input: they can wake an idle Session and are deferred normally while it is busy. Previous-owner transfer/release notices persist without triggering a model turn, clearing a wait, or satisfying a wait-all dependency. They can be consumed during existing work or on a later real wake. Transfer does **not** stop the old Session's provider request, tools, shell process, or other work. [Passive ingress](../threads/message-processing-pipeline.md#d-pipeline-passive-task-notification) owns that distinction.

All notification attempts occur after the Task mutation commits. [Persistence and recovery](persistence-and-recovery.md#unknown-outcomes-require-evidence-not-automatic-repetition) owns how to interpret independent commits and lost receipts. Delivery failure warns without undoing assignment, a note, or completion. Assignment recipients have independent recorded delivery state; explicitly repeating a failed assignment notification can retry that recipient, but pending/sent deliveries are not resent. Completion is terminal: repeating `complete` is not a notification retry, and there is no background completion-notification retry service. An acceptance receipt is not proof that a recipient model read the notice or finished work.

The accepted completion result delivered to the creator is not the bounded list/child-summary preview. [Task storage and output](../units/src-tasks.md#storage-and-output) owns accepted sizes and those projections. Mutation tool receipts are deliberately short: Task ID, status, owner, successful notification count, and any real warning. `sentNotifications` counts successful awaited deliveries in this operation, not notification intent or lifetime totals. `get` is the full-detail path for description/result and bounded notes/children. Task records/notes are not conversation history; delivered notices are ordinary Session input. Request-only task reminders do not copy the Task store into history or establish completion; their owner is [task context](../units/src-session-task-context.md).

## How does linking a new child to a Task change the handoff?

`create_child_session(taskId:...)` uses the existing Task and assigns/transfers it to the actual newly created child. It rejects missing, terminal, or unauthorized Tasks before creating the Session. It does not require the caller to create an unowned duplicate Task, create the child, and separately claim it.

The child receives the full stored description plus any additional message as **one Task assignment**, not a duplicate inter-agent directive. Completion through the Task tool sends the result to the Task's Session creator automatically. A separate routine parent report is not needed. Actual parent and Task creator can differ; completion of the recorded attached Task resolves the child's routine-handoff reminder without pretending it sent a message to its parent. `task complete` does not itself stop the caller's turn; it returns through the ordinary tool loop. Actionable errors or further coordination remain separate messages when needed.

Child creation/assignment can succeed while notification delivery fails. The receipt reports that distinction and does not roll back the child or Task ownership. A failed assignment delivery does not apply a requested terminal `afterSend` action. Do not respond by blindly creating another child; inspect the existing child/Task and delivery warning. The source owner is [Task child attachment](../units/src-tasks.md#child-attachment-and-webui).

## Is sending a report the same as ending the current turn?

No. `send_to_session` and child creation distinguish delivery from the caller's next action:

- Default `afterSend:"continue"` delivers and lets the caller keep working.
- `afterSend:"finish"` ends the current turn idle after success, without a wait. It does not finish the target Session or complete a Task.
- `afterSend:"wait"` ends the current turn and arms an ordinary activity wait for later input from the resolved target set. It is not a blocking RPC that returns the answer inside the send result, and unrelated ordinary input can still wake it.

The canonical post-batch ordering, fast-reply races, sibling errors, and explicit-wait interaction stay in [handoff/wait mechanics](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait) and [execution and waiting](./execution-and-waiting.md#explicit-wait-ends-an-otherwise-finished-turn). The maintained runtime suppresses terminal handoff controls when the complete batch has a tool error, under the linked execution contract. Failed sends do not establish a successful handoff.

`<parent>` resolves the actual direct parent; `<main>` resolves the current Agent's main Session, not a universal coordinator. Ordinary direct self-send is rejected; real ToolScript execution can queue a self-notification through the existing authorized path. To answer the current human, use ordinary assistant text rather than sending to the current Session. When handoff review is enabled, the caller supplies a brief recollection and honest review; the review must end with the required consent sentence before delivery or child creation can proceed. These fields are locally validated and not delivered as the recipient's message; see [tool-call controls](../threads/tool-dispatch-authorization.md#d-dispatch-model-tool-cancellation-and-handoff-confirmation).

### Why might a child be reminded to report?

Non-task delegation uses an explicit persisted handoff boundary, not a scan for old report-looking prose. Direct-user input establishes a no-report boundary. Input from a direct child is transparent; ordinary inter-session input from the current parent or another non-child establishes an unresolved report-required boundary. Task notices and maintenance do not establish that peer-directive relation.

A successful send to the actual parent, completion of the recorded attached Task, or an eligible terminal response ending in `[NO_ACTION]` can resolve the boundary. Merely mentioning a tool call, failing a send, sending elsewhere, or finishing assistant prose does not prove the report was delivered. The marker resolves reminder intent; it is not a Task completion action or a promise of hidden Channel text. Current Sessions without explicit boundary state do not reconstruct it from historical wording. Canonical details: [persisted child handoff](../threads/message-processing-pipeline.md#d-pipeline-persisted-child-handoff-boundary).

## What should a human see in Chat?

Inter-session sends are communication, not the current assistant's human-facing answer. Conversation shows supported successful outgoing and structured incoming messages as To/From cards in order. Its browser-local inter-agent-message switch folds them into Activity without deleting or changing delivery. Task notices remain Task system-like cards, not ordinary inter-agent directives. Older scripted stdout or authored claims of success are not reconstructed as delivered communications. Exact evidence/projection bounds and Search behavior belong to [communication presentation](../threads/session-communication-presentation.md) and [conversation and history](./conversation-and-history.md).

## Change and test entry points

- `src/toolsSessionAgent/interSession.ts`, `src/session/relations.ts`, and [Session tools](../units/src-tools-session-agent.md) locate real sends, target resolution, child creation, and post-send controls.
- `src/taskStore.ts`, `src/taskService.ts`, `src/tools/taskTools.ts`, and `src/channels/webuiTasks.ts` own Task rights, mutations, delivery, short receipts, and user/Session actor separation. [Tasks](../units/src-tasks.md) links bounded storage/output details.
- `src/taskStore.test.ts` and `src/taskService.test.ts` cover rights, terminal behavior, notifications, aliases, and assignment races; `src/tools/taskTools.test.ts` covers tool authorization, child attachment, completion signals, and receipts.
- `src/toolsSessionAgent/handoffWait.test.ts`, `src/session/childHandoffState.test.ts`, and `src/sessionQueueOptions.test.ts` cover handoff controls, explicit reminder state, and passive notices. Communication-card tests are linked from their presentation owner.
