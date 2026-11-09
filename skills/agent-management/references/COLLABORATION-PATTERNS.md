# Collaboration patterns for Agents and Sessions

Read this before writing memory for Agents whose Sessions delegate work, coordinate parallel work or inherit shared collaboration rules.

The framework prompt already teaches every Session the basics: delegating with `create_child_session`, Task completion as the report, `send_to_session` and its `afterSend` choice, `wait`, `ask_user` for user decisions, and where knowledge belongs. Do not copy those rules into Agent memory; copies drift as Foxwarm changes. Agent memory should record only the choices that differ for this installation or domain. [`coordination-base.md`](memory-templates/coordination-base.md) lists them.

Keep public or shared memory free of private paths, account details, credentials and one-off project history.

## Roles

The same Agent memory is visible to every Session of the Agent, so memory should not say "you are always the coordinator" or "you are always the worker". A Session can tell its role from what started it:

- A Session that starts with a session-boundary notice naming a parent Session, or with a Task assignment, is doing **delegated work**: it acts as an executor for that assignment and reports through the Task or to its parent.
- A Session handling a direct user request without such a handoff acts as the **coordinator** for that work.

Use the IDs the system gives the Session (its own, its parent's, the Task's). Do not hard-code Session IDs in memory.

## Coordinator and executor

**The coordinator** understands the request and resolves ambiguity with the user before delegating; decides what runs in parallel, what is serial and what depends on what; gives each mutable resource (files, branches, worktrees, services, Nodes, test targets, deployment targets) one owner; chooses fork, fresh child or reuse; writes complete handoffs; keeps final judgment instead of forwarding child reports; and makes user-facing decisions.

**An executor** stays within the assigned scope; inspects before editing; touches no unassigned resource; reports uncertainty, blockers and scope growth instead of silently expanding the task; validates its work and says exactly what was and was not checked; and reports facts, judgment, validation, outputs, risks and recommended next steps.

### Variants

- **Read-only investigation in parallel.** Several executors each take a distinct question or code area and do not write. The coordinator compares findings and picks a direction.
- **Implementer and reviewer.** One executor implements; another reviews or tests independently; the coordinator decides. Do not let both edit the same files or service.
- **Avoid fragmented pipelines.** "A investigates, B implements, C tests" loses context at every step. Prefer one executor carrying a coherent slice. If a pipeline is unavoidable, restate the current state, rationale, constraints and expected output at each stage.

## Fork, fresh child or reuse

**Fork** when the child needs the current conversation and restating it would be wasteful. A fork sees only the context at creation time; send later decisions explicitly.

**Fresh child** when the task is independent, the current context is noisy or misleading, or an older child is stale. Give it enough background to succeed without the parent conversation.

**Reuse** an existing child when it recently worked on the same subsystem or still owns the relevant workspace, branch, service or environment. Do not reuse a child only because it once touched the topic.

Choose the child's model with `create_child_session`'s `model` parameter, using a key from the available models in the Session's instructions. Omit it when the default fits.

## Plan before delegating

Decide, before creating or messaging children:

- what can run in parallel, what must be serial and what depends on earlier results;
- which Session owns each mutable workspace, branch, file set, service, Node, test target or deployment target;
- what each child must not touch;
- whether the child may edit, test, commit, push, restart services or deploy;
- which checks are expected and when the child should stop.

Only one Session should own a mutable environment at a time unless overlap is deliberate and stated. For untrusted or risky work, give each assignment its own environment, for example a disposable Node from the `node-setup` container Provider, and a restricted worker Agent (see [Restrict an Agent](OPERATIONS.md#restrict-an-agent)).

## Assigning work

Prefer Tasks for delegated work: create the Task, then `create_child_session` with its `taskId`. The child receives the Task description, and completing the Task notifies the creator, so no separate completion message is needed. Use `send_to_session` for work outside Tasks and for information a child needs mid-task.

A handoff for a fresh child contains:

- the user's request, quoted where the wording matters, and the coordinator's interpretation;
- the goal, scope and what is out of scope;
- the environment: Node, workspace, branch, services and their ownership;
- permissions: edit, test, commit, push, restart, deploy, create children;
- expected checks, stop conditions and report contents.

For a fork or a reused child, send only what changed: new constraints, changed decisions or success criteria, changed ownership, and the next action. Do not refer to "the previous option" without restating it.

## Questions and decisions

- A coordinator asks the user with `ask_user` when a choice or missing input blocks work.
- An executor asks its parent, not the user. A worker that can only use Tasks creates a Task owned by its parent Session that states the question, linked to its own Task with `parentTaskId`, and waits; the answer arrives when the parent completes it.
- Do not send acknowledgement-only messages between Sessions. A Session that has nothing to report ends its turn with `[NO_ACTION]`.

## Reports

Reports are easiest to use when they separate:

- what was done and the resulting outputs (files, commits, artifacts);
- judgment and interpretation;
- checks run and their results, and what was not checked;
- remaining uncommitted state, blockers and risks;
- recommended next steps.

Do not say "I continued" or "I started the next step" unless a Session was actually created, a message was actually sent or tool work actually began. When a direct user is waiting while work is delegated, give them a brief status first.

## Shared base Agents

To share collaboration choices across several Agents:

1. Create a base Agent whose memory holds only those choices, starting from [`coordination-base.md`](memory-templates/coordination-base.md).
2. Create domain Agents that inherit from it, such as development, research or operations Agents, starting from the matching template.
3. Keep only domain-specific memory in each domain Agent.

Inheritance changes do not rebuild existing Session prompts; see [inheritance](OPERATIONS.md#inheritance).

## Choices to make

These are the decisions `coordination-base.md` asks for:

- **Delegation autonomy:** executors only propose; executors edit, test and commit within scope; or executors may also push or operate test environments when allowed.
- **Parallelism:** one executor at a time; several only with separate workspaces and services; or read-only parallel investigation.
- **Workspace safety:** when a shared checkout is acceptable, when a dedicated worktree or Node is required, and which targets need explicit confirmation.
- **Environments for delegated work:** which worker Agent, Provider and profile to use, and who releases environments.
- **Reports:** how much detail the user wants relayed.
