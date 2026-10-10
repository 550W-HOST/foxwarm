---
name: agent-management
description: "Configure Foxwarm agents, inheritance, isolation, and memory layout; plan migration or cleanup. Use for snapshot or lifecycle guidance, not routine edits to a known memory file."
---

# Agent management

Use this entry to choose the relevant operation. Read only the linked section needed for that task; routine edits with known tools and ownership do not require the full lifecycle guide.

## Essential boundaries

- An **agent** owns a long-lived workspace, memory, inheritance, and optional isolation. A **session** is a conversation/runtime thread. Inheritance does not establish a reporting relationship.
- Use current tool schemas for agent-facing operations. Slash commands are user-facing; do not send command-shaped text as a substitute for a management tool.
- Memory is stable operating context, not a progress log. Put task-specific procedures and detailed references in docs or skills, with short pointers from memory where needed.
- Shared inheritance does not move files or private documents. Give another agent an accessible reference rather than assuming it has the source agent's files.
- Agent isolation and Session Node selection are different operations. A routing choice does not create a security boundary or authorize another environment.
- This skill owns Agent lifecycle, memory, inheritance, isolation, and Node binding. Entry identities, restricted WebUI Session scope, and generic MCP/internal tool policy belong to [access-control](../access-control/SKILL.md); access grants do not create or migrate Agents.
- Destructive cleanup needs an explicit target and authority. Check dependencies and the current delete contract before deleting an agent or its data.

## Choose a workflow

| Task | Read when needed |
| --- | --- |
| Understand what an agent sees | [Prompt and memory model](references/OPERATIONS.md#what-an-ordinary-agent-normally-sees) |
| Create an agent | [Creation workflow](references/OPERATIONS.md#common-workflow-create-a-new-agent) |
| Choose memory structure | [Knowledge placement](references/OPERATIONS.md#progressive-disclosure-where-knowledge-belongs) |
| Edit another agent's memory | [Memory tools and ownership](references/OPERATIONS.md#common-workflow-write-memory-for-an-agent) |
| Refresh an existing snapshot | [Refresh behavior](references/OPERATIONS.md#common-workflow-memory-edits-and-snapshot-refresh) |
| Change inheritance | [Inheritance workflow](references/OPERATIONS.md#common-workflow-set-or-clear-agent-inheritance) |
| Bind isolation to a Node | [Binding workflow](references/OPERATIONS.md#common-workflow-bind-or-unbind-an-agent-to-a-node) |
| Migrate agents or move sessions | [Migration boundaries](references/OPERATIONS.md#common-workflow-move-work-between-agentssessions) |
| Remove an agent | [Delete behavior](references/OPERATIONS.md#delete--cleanup) and [cleanup checks](references/OPERATIONS.md#safe-cleanup-checklist) |
| Design collaboration rules | [Collaboration patterns](references/COLLABORATION-PATTERNS.md) and the relevant [memory template](references/memory-templates/) |

The detailed [operations reference](references/OPERATIONS.md) also covers tool discovery, framework memory, isolation, and scenario examples. It is a reference, not a mandatory reading sequence.

## Routine memory edits

Use the memory tools for the current agent. For another agent, use the appropriate authorized management or filesystem operation.

An edit made in the current conversation normally needs no snapshot refresh: its content is already available here. If another Session needs a change immediately, send the necessary delta. Refresh that exact Session only when it needs a rebuilt snapshot or the user explicitly requests one; do not broadcast refreshes by default. Inheritance and isolation changes have their own effects, so inspect the operation result before adding a refresh.

## Related workflows

- Use [access-control](../access-control/SKILL.md) for `access.identities`, scoped WebUI access, concrete tool rules, and safe policy updates. Generic policy applies in addition to legacy Agent isolation; neither a browser binding nor a policy allow replaces it.
- Use [mcp-management](../mcp-management/SKILL.md) for outbound/inbound MCP connections and explicit replies between instances.
- Use `isolated-worker` for a temporary isolated worker on an existing Node or a configured provider-backed worktree Node.
- Use `node-setup` for connection, pairing, approval, and bootstrap work.
- Use `agent-skill-creator` when a reusable procedure belongs in a skill rather than always-loaded memory.
