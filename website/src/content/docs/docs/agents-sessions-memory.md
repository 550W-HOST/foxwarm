---
title: Agents, Sessions, and memory
description: Give an agent lasting instructions and knowledge, organize its conversations, and understand where context lives.
---

An **Agent** keeps what should last: instructions, project knowledge, Skills, rules and a default Node. Its **Sessions** are the individual conversations and tasks. Most people start with the built-in `main` Agent and add more when a role or project needs its own memory or permissions.

## Agent memory

Each Agent has a memory directory:

```text
agents/<agent>/memory/
```

Every Markdown file there is added to the prompt of the Agent's Sessions. Use it for things that should hold across conversations: preferences, conventions, project facts, confirmed decisions. Common file names are `MEMORY.md`, `SOUL.md` (personality and working style) and `USER.md` (about you), but any `.md` file works.

You can edit these files yourself or ask the agent to; it has dedicated memory tools. Keep routine progress in the conversation rather than in memory. Long conversations are [compacted and remain recallable](/docs/history-search/), so memory does not need to be a log.

A file can apply to only some Sessions with frontmatter:

```markdown
---
include-session: ['main/*']
exclude-session: main/experiments
---
Only for main Sessions, except the experiments thread.
```

Patterns match full Session IDs; `exclude-session` wins.

`agents/00_SYSTEM.md` is a framework-wide prompt added to every Agent. Put instructions for all agents of the instance there, not in a single Agent's memory.

### Sharing memory between Agents

An Agent can **inherit** another Agent's memory, for example a `reviewer` that inherits `main` so both share the same project knowledge:

```text
/agent inherit reviewer main
```

Inheritance only combines memory. It does not grant permissions and it is unrelated to which Session reports to which.

### When changes take effect

New Sessions, and existing Sessions at their next normal refresh, pick up memory changes. To apply a change to an existing Session right away, for example after editing memory from another Session:

```text
/session refresh-snapshot [session-id]
```

## Sessions

A **Session** is one conversation of an Agent. It has its own history, message queue, model choice and current [Node](/docs/nodes/). One Agent can have a main Session plus separate threads for reviews, experiments or recurring jobs, all sharing the Agent's memory.

Common commands:

| Command | Effect |
| --- | --- |
| `/session list` | List Sessions |
| `/session new` | Start a new Session in the current Agent |
| `/session fork [name]` | Start a new Session with the current visible context |
| `/session rename <name>` | Change the display name |
| `/session move --new-session-id <new-id>` | Rename the Session ID; add `--new-agent-name <agent>` to move it to another Agent |
| `/session set-parent <parent-id>` / `/session clear-parent` | Change where a Session sits in the tree |
| `/session archive` / `/session unarchive` | Hide or restore a finished Session; data is kept |
| `/session delete <id>` | Delete a Session |
| `/model [name\|default]` | Show or change the Session's model |
| `/node list` / `/node select <node-id>` | Show the Nodes or change the Session's current Node |

Session IDs use ASCII letters, digits, `_` and `-`. Display names can be anything.

## Choose an Agent or a Session

- **New Session:** same project knowledge and rules, separate conversation.
- **Fork:** a new thread that starts from what the current one can see.
- **New Agent:** separate memory, workspace, rules, default Node or role.
- **Archive:** finished work you want out of the list but not deleted.

## Agents that create Agents

An agent can create another Agent, for example a helper that should only work on one build server. Foxwarm records the creator. The new Agent's [rules](/docs/access-control/#rules-for-each-agent) apply on top of its creator's, and its creator's on top of theirs, so no Agent can do more than the Agents above it allow. Only an Agent's creators, or you as administrator, can change its rules.

An Agent can also have a **default Node**, where its new Sessions start. This only chooses placement; whether the Agent may use that Node is decided by its rules.

A created Agent can inherit memory only from its own creators. Agents with created Agents below them cannot be deleted until those are removed.

You can ask an agent to set this up in plain language:

```text
Create an agent called ci-runner that can only run commands on build-box and report back to this session.
```

The agent uses its `create_agent` tool with suitable rules and default Node. See [Delegate work](/docs/delegation/) for how Sessions in different Agents work together, and [Access control](/docs/access-control/) for the rule format.

## Where context lives

| Context | Use it for | Where it lives |
| --- | --- | --- |
| Agent memory | Long-lived instructions and knowledge | `agents/<agent>/memory/` |
| Session history | The current conversation and tool results | The Session timeline |
| Archive and recall | Earlier messages behind compacted summaries | Recall tools and expandable context blocks |
| Semantic search | Finding earlier context by topic | Optional [history search](/docs/history-search/) |
