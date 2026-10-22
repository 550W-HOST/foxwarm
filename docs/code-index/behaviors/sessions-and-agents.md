# Behavior: Sessions and Agents

For developers and Agents changing how work starts, is organized, or is retired. An Agent supplies a workspace and instruction sources; a Session owns a conversation and its work/settings. Opening a Chat, creating a Session, and creating an Agent are different actions. Neither Agent membership nor a parent link grants tool or environment authority.

## Use an existing lifetime, start fresh, or fork

Opening an existing Session selects its browser conversation; it does not allocate another Session or submit model work. Several Chats can observe the same backend lifetime. Browser tab/component behavior belongs to [Workbench and Chat](workbench-and-chat.md#tabs-select-surfaces-panes-arrange-them).

| Supported choice | Starting conversation and instructions | What starts work? |
| --- | --- | --- |
| New Session under an existing Agent | Fresh history and cache lineage, with that Agent's default memory sources unless an explicit source list is supplied. Recording a parent does not copy its history. | Creation alone does not submit an instruction. |
| Fresh child | Fresh history/cache lineage with the caller as actual parent. A same-Agent child retains the parent's custom memory-source selection, if any; a cross-Agent child uses the target Agent's default sources. | An initial message or Task assignment enters the child's queue; an unassigned child is not started by its creation receipt. |
| Fork | Copies the source's history and prompt snapshot at a point in time, with bounded Archive lineage and shared prefix/cache lineage. It does not share mutable history or receive later parent messages. | A manual fork without initial input is not a work assignment. A model-created child's supplied message/Task has its separate handoff effect. |
| New Agent with a main Session | Creates an independent Agent directory and, normally, a fresh main Session. Optional conversion instead moves an existing lifetime. One-time memory copying and ongoing inheritance are separate choices. | A newly created main Session does not run merely because its directory or creation receipt exists. |

Fresh means no copied transcript, not an absence of structured creation/identity notices. Fresh Agent creation with `createMainSession:false` creates no main Session lifetime; the directory is not evidence that such a target exists.

Cross-Agent forks are rejected. A fresh cross-Agent child requires an existing target Agent and retains its actual caller as parent. A user-created fork records context provenance, not a standing obligation to report to that parent. A later real handoff can establish that obligation normally. No creation path fabricates an assistant acknowledgement of understanding. Exact inherited tool-pair completion and manual-fork notices remain in [creation provenance](../threads/session-lifecycle.md#d-lifecycle-creation-origin).

[Collaboration and Tasks](collaboration-and-tasks.md) owns initial assignment delivery, reporting, and Task linkage. [Conversation and history](conversation-and-history.md#which-instructions-are-in-the-working-context) owns which instruction sources are selected and when they become the model's working context.

## Omitted creation settings do not have one universal source

The entry point matters where it changes actual defaults:

| Entry | Initial model/effort source | Initial execution Node source |
| --- | --- | --- |
| WebUI New Session | No current-Chat model/child policy is passed; unresolved selection uses the global model default. | A named/automatic non-main-Agent Session can follow that Agent's main Session Node. The ad-hoc `main` route starts through its separate empty-Session factory. |
| Model `create_session` or `/session create` | Resolves the caller's prospective child model/effort policy, with supported explicit overrides. | Passes the caller's Node unless overridden by the tool; target isolation still takes precedence. |
| Fresh child or fork | Resolves the source's prospective child model/effort policy, not necessarily its current displayed model. | Fresh child: target isolation binding, explicit Node, parent Node, then Main. Fork: explicit Node or source Node, then Main. |
| Source-based Agent-main creation | Explicit values over the source's current raw pair; it also retains the source's future-child defaults. A model tool's omitted source is its caller; WebUI creation does not supply that caller source. | Target isolation binding, explicit Node, source Node, then Main. |

For named creation without a binding or supplied Node, the current implementation looks up the non-main Agent's main Session before falling back to Main. The lookup's historical-alias behavior, `main`-Agent exception, and known Worker-owned stale-Node issue remain explicit at [named-session defaults and questions](../units/src-session-agent-ops.md#named-session-node-defaults). Do not infer a universal “inherit the selected Chat” rule from the UI's current selection.

### Prospective model and effort are a pair

[2026-08-13] Spawned children/forks resolve model from explicit override, source future-child model default, source current model, then global default. Effort resolves from explicit override, source future-child effort default, source raw effort, then unset. Unset stays unset so the selected concrete model or virtual leaf uses its own configured default; it is not frozen to the parent's current effective effort.

The resolved pair becomes the spawned Session's current settings. Its own future-child overrides start unset, so grandchildren normally follow that child's current pair. A one-time creation override therefore does not pin every later descendant. Existing stored future-child overrides remain effective until explicitly changed; equality with current settings does not implicitly clear them.

Newly explicit effort is validated against concrete capability or a virtual route's supported union. Stale inherited effort that no longer fits clears to unset instead of blocking creation. Source-based Agent creation is the distinct case above: it retains source future-child defaults. New-Session timers capture a prospective pair at registration and revalidate it when firing; [scheduled work](automation-and-scheduled-work.md#schedule-a-message-or-execute-a-quiet-script) owns that later-use boundary.

Creation sets prospective configuration, not the identity of a successful provider attempt. [Models and requests](models-and-requests.md#selection-is-not-execution-identity) owns selected versus attempted/adopted configuration, virtual routes, provider defaults, and later switching.

## Change a label, an identity, or a relationship

| Action | What changes | What does not follow from it |
| --- | --- | --- |
| Display-name update, WebUI Rename, `/session rename` | Human-readable label; clearing it retains the internal ID. | No new lifetime, Archive rename, Agent move, or parent change. |
| Reorder a Session in the sidebar | Browser-facing sibling order recorded in the catalog. | No history move, new context, or execution placement change. |
| Reparent, including a tree drag to another parent | Actual Session parent relation. Sidebar ordering may be changed separately. | No Agent membership, inherited memory, Task creator/owner, or copied conversation change. |
| `move_session` or `/session move` | Internal ID, optionally Agent membership, retained aliases, and associated history/attachment identity. Direct child references follow the new canonical ID. | Not the WebUI sidebar `/move` operation, a recursive tree move, or a copy of every Agent-owned file. |
| Change Agent memory inheritance | Sources used by later prompt materialization/refresh. | No parent/Task relation, permission inheritance, or default immediate rewrite of every Session snapshot. |

An identity move preserves the incoming parent when no parent override is supplied. An explicit parent override is a separate post-move relation update: failure can leave the identity move committed while the requested parent change is unconfirmed. The technical owner retains [identity-move relation and recovery rules](../threads/session-lifecycle.md#d-lifecycle-identity-move-relations).

Current cross-Agent identity moves reject isolated source or target Agents; the model move tool also rejects an isolated source. Internal-ID moves are unavailable under Session-worker placement. Do not infer these restrictions for ordinary display-name updates or administrator sidebar operations. [Node and permission boundaries](nodes-workspaces-and-permissions.md#authority-has-several-independent-boundaries) remain independent.

**Current implementation:** an identity move does not itself rebuild the retained prompt snapshot. Immediate adoption of the target Agent's memory is not an established guarantee; the normal [instruction adoption boundaries](conversation-and-history.md#when-do-changed-instructions-reach-the-model) still apply. History text and old file locators are not rewritten into new Agent-owned resources merely because membership changed.

An internal ID identifies one lifetime while its retained historical identity remains reserved. Explicit creation/move cannot reuse a deleted lifetime's retained ID; automatic allocation skips reserved IDs. Old committed move aliases resolve to the current live lifetime while it exists, and remain historical references after deletion. Display names are not reserved identities. Allocation serialization, exact legacy IDs, alias recovery, and failed unpublished creation compensation remain in [identity reservations](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).

## Put work aside, clear the conversation, or retire the lifetime

| Action | Observable consequence | Work/history that is not erased by that action |
| --- | --- | --- |
| Close Chat | Removes that browser view. | Backend Session, running turn, tools, timers, and background exec. |
| Archive a Session | Changes its list/presentation flag. Optional descendant archive is explicit and defaults off; unarchive is single-Session. | Active history and running work; this is not the immutable Archive store or a pause command. |
| Clear the Session | On successful clear, starts an empty active conversation within the existing Session identity. | Agent memory and retained historical originals. Busy admission and exact clear effects belong to [history actions](conversation-and-history.md#actions-and-consequences). |
| Delete the Session | Removes live access, detaches Channels, and retires current Session authority. Nonrecursive deletion detaches surviving direct children rather than deleting them. | Retained Archive/identity reservations and independent durable work records are not a global erasure target. |

Delete is coordinated, not an unconditional immediate UI removal. Non-WebUI Channel attachments can block it. A busy local target receives the existing stop/queue-clear retry outcome; a Worker target uses its owner teardown path. Recursive WebUI deletion is explicit and defaults off, derives the full descendant selection on the backend, and deletes deepest-first only after preparation. Unexpected failure reports partial progress, not invented rollback. Exact claim/revalidation and retained-store boundaries remain at [Session deletion](../threads/session-lifecycle.md#archive-and-deletion).

Neither archive nor closing a tab establishes that work completed. Returning to Chat reads the retained lifetime; it does not recreate its last browser component or replay an uncertain command. Restart recovery reassesses recorded busy/queued/waiting work rather than resuming the last machine instruction or regenerating a completed answer. Keep those consequences at [Workbench lifetimes](workbench-and-chat.md#mounted-visible-and-running-are-independent) and [persistence and recovery](persistence-and-recovery.md#restart-resumes-recorded-work-not-the-last-machine-instruction).

## Change and test entry points

- `packages/webui/src/components/AgentCreationMenu.tsx`, `packages/webui/src/App.tsx`, and `src/channels/webuiChannel.ts` connect UI creation, opening, label, tree, and lifecycle actions. `src/channels/webuiSessionsRoute.test.ts` covers actual creation/fork, label/settings, sidebar movement, and recursive archive/delete routes.
- `src/toolsSessionAgent/agents.ts`, `src/toolsSessionAgent/interSession.ts`, and `src/commands/sessionCmd.ts` expose the meaningful caller-default, child/handoff, and command-binding differences. [Agent operations](../units/src-session-agent-ops.md) and [Session lifecycle](../threads/session-lifecycle.md) locate construction and identity owners.
- `src/session/sessionIdAllocation.test.ts` covers retained-ID allocation, move/alias persistence, mixed-order topology preservation, and failed creation/move recovery. [Model/effort inheritance](../threads/session-lifecycle.md#d-lifecycle-model-effort-inheritance) locates normalization and regression evidence; [instruction sources](conversation-and-history.md#which-instructions-are-in-the-working-context) locates prompt/skill tests.
