# Agent operations

Reference for the workflows listed in [the skill entry](../SKILL.md). Read the section you need; this is not a reading sequence.

## Tools and commands

Agents use tools and `ctl` commands. Run `ctl help` or `ctl <noun> --help` for the commands your policy may allow; `ctl tool search` finds any other builtin, MCP or Node tool.

| Tool or command | Use |
| --- | --- |
| `ctl agent create` (`create_agent`) | Create an Agent, optionally with initial local rules and placement defaults |
| `ctl agent set-rules` (`set_agent_rules`) | Replace the local rules of an Agent created from yours |
| `ctl agent inherit` (`set_agent_inherit`) | Set or clear memory inheritance |
| `ctl session create` (`create_session`) | Create a Session under an existing Agent |
| `create_child_session` | Create a child Session, also in another Agent, optionally assigned a Task (`taskId`) and placed on a Node (`node`) |
| `ctl session move` (`move_session`) | Rename a Session or move it to another Agent; the old ID remains an alias |
| `ctl session delete` (`delete_session`) | Delete another Session's live record; its archive is kept |
| `ctl agent list`, `ctl session list`, `ctl session status` | Inspect Agents and Sessions |
| `ctl session refresh-snapshot` | Rebuild one Session's system prompt now |
| `ctl memory read`, `write`, `edit`, `patch`, `delete` | The current Agent's memory |
| `task`, `ctl node ...` | Assignments and execution environments |

Policy rules name the builtin in parentheses, not the command.

Users have commands: `/agent list|create|delete|inherit`, `/session ...` (including `move`, `parent`, `unparent`, `delete` and `refresh-snapshot`) and `/node ...`. When a step needs a command, tell the user exactly what to run. Do not simulate a user request to run a command yourself.

## What an Agent's Sessions see

A Session works from a prompt snapshot assembled from:

1. the framework prompt;
2. memory of inherited Agents, then the Agent's own top-level `memory/*.md` files;
3. a catalog of available skills (name and description only);
4. runtime context such as the Agent directory.

`ctl skill load <name>` returns a skill's entry document and lists its resources; resources are read only when needed. Snapshots are cached per Session, so a changed memory file does not change an open Session's prompt until that snapshot is rebuilt.

## Where knowledge belongs

1. **Framework prompt:** rules for every Agent. Keep it small and generic.
2. **Agent memory:** what every Session of the Agent needs: stable rules, user preferences, environment facts, confirmed decisions and short pointers.
3. **Agent docs:** analysis, runbooks, history and deliverables, read when needed.
4. **Skills:** reusable procedures. Only the catalog entry is visible until the skill is loaded.
5. **Skill resources:** references, scripts and examples inside a skill directory, read only when the skill or task needs them.

Judge by relevance and reading cost, not line count. Session history, its summaries and `recall` already preserve progress, so memory is not a progress log. A directory containing `SKILL.md` is one skill; nested `SKILL.md` files inside its resources are not separate catalog entries.

### Framework prompt files

- The bundled `templates/agents/00_SYSTEM.md` is the base and changes with Foxwarm updates. Do not edit it for one installation.
- `agents/00_SYSTEM.local.md` is appended for all Agents of the installation. Put installation-wide instructions there.
- An edited legacy `agents/00_SYSTEM.md` (or `agents/main/memory/00_SYSTEM.md`) replaces the bundled base, so the installation stops receiving framework prompt updates. Unedited copies are removed at startup. To migrate, move the installation-specific parts to `00_SYSTEM.local.md` and delete the legacy file.

A `memory/00_SYSTEM.md` inside an ordinary Agent has no special effect. Use `MEMORY.md`, `SOUL.md`, `USER.md` or other clearly named files.

## Create an Agent

`create_agent` fields:

| Field | Meaning |
| --- | --- |
| `agentName` | Letters, digits, `-` and `_` |
| `createMainSession` | Also create `<agent>/main`; default true. Use false for worker Agents whose Sessions are created per assignment |
| `inherit` | Ongoing memory inheritance from another Agent |
| `inheritMemory` | One-time copy of the source Agent's memory files |
| `sourceSessionId` | Session whose model settings provide defaults; defaults to the caller. It transfers no history unless `convertSession` is set |
| `convertSession` | Turn the source Session into the new Agent's main Session |
| `rules` | Initial [local rule layer](#restrict-an-agent) |
| `defaultNode`, `defaultCwd` | [Placement](#placement) defaults for new Sessions |

Session names use ASCII letters, digits, `_` and `-`. Display names are separate.

**Creator authority.** An Agent created by a model records the calling Session's Agent as its creator; one created by an administrator is top-level. The creator chain is fixed and independent of memory inheritance and Session parents. It has these consequences:

- Only a model in an Agent strictly above it on the chain can replace its rules with `set_agent_rules`, and that caller's own authority is rechecked. No Agent can change its own or an ancestor's rules. Administrators can change any layer (`PUT /api/agents/<agent>` with `rules`).
- It may inherit memory only from Agents above it on the chain.
- Models in an Agent that has a creator may create Sessions, timers and parent links only in their own Agent or Agents created from it. They may convert only such Sessions; `inheritMemory` may also copy from ancestors.
- `agentTree.maxDepth` (default 16) and `agentTree.maxChildren` (default 128 direct children) limit the tree. Lowering a limit does not disable existing Agents.
- An Agent cannot be deleted while Agents created from it exist.

There is no tool to write another Agent's memory. After creating an Agent, write its memory files with ordinary file tools if your permissions allow, or ask the user. Agent folders are siblings, so the new Agent's memory is `<parent of your agent_folder>/<agent>/memory/MEMORY.md`. Use that absolute path, because a relative path resolves against your own Session or Agent directory, and read the file back once.

## Restrict an Agent

Restriction has two independent parts:

1. **A local rule layer** decides which tools the Agent's Sessions can use. The global policy decides first, then every layer from the top of the creator chain down to the Agent's own must pass. A call that matches no rule passes a layer, so a layer that ends with `{"action":"deny"}` is an allowlist. Syntax and evaluation: [access-control Agent-local layers](../../access-control/references/tool-policy.md#agent-local-layers).
2. **A Node** decides where its file and exec tools run. Containment, network access and resource limits come from that environment, for example a container from the [container Provider](../../node-setup/examples/container/README.md), a VM or a dedicated machine.

Create a restricted Agent with its rules in one call, so no Session runs without them:

```text
ctl agent create worker --no-create-main-session --rules @rules
  values: { "rules": <contents of restricted-worker.rules.json> }
```

Then write the matching memory template to the worker Agent's `memory/MEMORY.md` by its absolute path, as described above. The rules in the templates were reviewed for these hazards; keep them when adapting:

- **Scope environment allowances with `tool: {source: node}`.** A top-level `node` selector also matches the `node` tool's select, inspect and destroy targets and file-transfer endpoints. Without the tool scope, a worker could inspect or destroy its own environment.
- **Deny `master` first.** `node: {current: true}` matches `master` for a Session placed there.
- **Never reuse Node IDs.** `current` compares IDs, so a finished Session that still selects a reused ID would reach the next environment. Provision each assignment with `create` and a fresh ID (it refuses an ID that still exists), and delete finished worker Sessions.
- **Deny memory writes.** All Sessions of an Agent share its memory, so one compromised Session could change every later Session's instructions.
- **No `ask_user` and no MCP for workers.** Workers ask their parent through a parent-owned Task. MCP servers run on `master`.
- **The global policy must let the intended calls through.** A local allow only passes its own layer.
- **Copying out goes through the coordinator.** A worker's copy with a `master` endpoint is denied, so the coordinator collects results.
- **Agent rules govern Foxwarm tools only.** Web search or image generation built into a model are controlled by the model configuration, so give restricted Agents a model without them.

Check a candidate with `ctl config explain-auth` for a real Session of the Agent before relying on it. A worker Agent without a main Session has none until its first assignment; check that Session before it starts work.

### Restricted workers

Use one long-lived worker Agent for all assignments of a kind instead of one Agent per worker: rules apply to every Session of the Agent, while Agents cannot be deleted by models. Each assignment gets:

- a fresh Node: `ctl node create --provider-id sandbox --node-id sandbox/<assignment> --parameters '{"profile":"offline"}'`. Use `ensure` only as a deliberate reconnect to an environment that should still exist;
- a Task and a child Session on that Node: `create_child_session({agentName:"worker", suffix:"<assignment>", node:"sandbox/<assignment>", taskId:"<task>", …handoff fields})`. Task completion notifies the coordinator;
- an explicit release after review: `ctl session delete` for the worker, then `ctl node destroy` with its exact confirmation.

The [node-setup development workflow](../../node-setup/references/development-workflow.md) runs these steps with source transfer and delivery.

### Channel assistants

For an Agent that answers a chat channel, reserve one long-lived Node for it (an `ensure`d container or a paired machine), then create the Agent with `defaultNode` set to that Node and the rules from `channel-assistant.rules.json`. Channel Sessions start on the default Node. The template allows tools on the current Node, file delivery to the same conversation, its own history and skills.

Files people send to an Agent are saved on `master` in its directory under `.temp/channel-files`, not on its Node; the template's first rule allows reading only that directory there. All conversations of the Agent share its Node and these files. Use one Agent and Node per group of people who may see each other's material.

A channel's `guestAgent` configuration gives unknown users their own guest Agent, and `guestAgent.template` names the Agent whose rules apply to them. Create the template with local rules, for example from the channel-assistant template. In `inherited` mode, each guest Agent is created by the template, so its rules apply; it inherits memory from `agentId`, which must be the template or an Agent above it on its creator chain, and uses `node` as its `defaultNode`. In `single` mode, `agentId` must be the template or an Agent created by it, with `node` as its `defaultNode`. Without a template, new guests are refused unless the configuration sets `isolated: false` to allow unrestricted guests.

## Placement

A new Session's Node is, in order: the explicit `node` given at creation; for `create_child_session` in the same Agent, the parent's current Node; the Agent's `defaultNode`; the installation's `agentDefaultNode`; then `master`. `defaultCwd` applies only when the Session starts on that default Node.

Set defaults with `create_agent` or in the WebUI's Agent settings. Changing them does not move existing Sessions, and a default Node need not be online. Placement grants nothing: what a Session can do on a Node is decided by policy.

## Memory edits and snapshot refresh

Do not refresh a snapshot automatically after editing memory. Each Session keeps a composed system-prompt snapshot; replacing it loses prompt-cache reuse and makes the next request more expensive.

- **Edits made in this Session:** the change is already in this conversation. Continue with that context. Refresh only when the user asks or when testing snapshot assembly itself.
- **Another Session needs the change now:** send it a short `send_to_session` message with the file, the new rule and any action it should take. Only if it must use the complete rebuilt prompt immediately, refresh that exact Session: `refresh_session_snapshot({sessionId:"agent/session"})`. Omitting `sessionId` refreshes the caller. Users can run `/session refresh-snapshot <session-id>`.

New Sessions, and existing ones after their normal refresh, pick up saved memory automatically. Do not broadcast refreshes because a shared file changed.

## Inheritance

`set_agent_inherit` (or `/agent inherit <agent> <parent-agent|none>`) changes which Agent's memory appears in this Agent's prompts. By default it changes only metadata; existing snapshots keep their prompt. `refreshSnapshots:true` also refreshes affected Sessions active within the last hour; older ones refresh on their next turn. Inheritance does not copy files, grant authority or make one Agent report to another.

## Moves and migration

**Sessions.** `move_session` renames a Session or moves it to another Agent, optionally creating that Agent. The old ID remains an alias. Its parent link is kept and direct children are updated; pass `parentSessionId` only to assign a different existing parent. Users can run `/session move <new-id>|<agent>/<new-id> [--parent <parent-id>]`, and `/session unparent` detaches a Session. There is no recursive tree move. New names follow the Session name rule; legacy IDs remain readable and can be moved to a valid name.

**Agents.** There is no direct Agent rename: the name is part of paths, Session IDs, metadata and creator records. To replace an Agent:

1. create the new Agent with the intended settings and rules;
2. copy or rewrite the memory files you want;
3. move or recreate the Sessions you still need;
4. set inheritance and placement on the new Agent;
5. tell affected Sessions what changed; refresh only those that need it immediately;
6. only then consider deleting the old Agent.

Do not rename Agent directories or edit state files by hand.

## Deletion

**Sessions.** `delete_session` deletes another Session's live record and keeps its archive. Surviving children are detached. A busy Session receives a stop request; retry once it is idle. A Session cannot delete itself. Users can run `/session delete <session-id>`.

**Agents.** There is no model tool. Explain the effect and checks, then give the user the command:

```text
/agent delete <name> --confirm
```

It deletes all of the Agent's Sessions, its directory and memory. It is refused while Agents created from it exist. Before suggesting it:

1. migrate the memory and Sessions you still need;
2. confirm that no Agent created from it remains, and that no other Agent inherits its memory or relies on files in its directory;
3. tell surviving Sessions about the change.

A multi-step setup that fails partway is not rolled back. Report exactly which Agents, Sessions and Nodes exist, and clean up with the commands above rather than by removing directories.

## Legacy isolated Agents

Isolation is no longer enforced and can no longer be set. At startup, before it accepts work, Main migrates every Agent still marked isolated:

- it installs a generated local layer that reproduces the old limits: the bound Node, the Agent's own directory and memory on `master`, the old exact `toolRules`, and messages only to the Session itself, its parent and its children;
- it sets `defaultNode` to the bound Node when none is set, marks the Agent not inheritable, and records the bound Node on Sessions that had no Node;
- when it cannot do this safely, for example because the Agent already has local rules, it installs a layer that blocks every call instead.

The System view and the Main log list each migrated Agent. A blocked Agent stays blocked until an administrator replaces its rules. Review a generated layer like any other local layer; `explain_tool_authorization` shows which rule decided a call.

Inbound channel files now always land on `master` in the Agent's directory, and channel sends from migrated Agents are denied. Channel guests take their rules from `guestAgent.template`.

The retained `isolated`, `isolatedNode` and `toolRules` fields are no longer used except to keep older releases enforcing isolation after a downgrade. Foxwarm 0.9.4 enforces both those fields and the converted rules; earlier releases can't read the converted rules and refuse every call by these Agents and the Agents they created. Saved scripts or ToolScripts that call `set_agent_isolated` or pass `isolatedNode`/`toolRules` must switch to `set_agent_rules` plus `defaultNode`.
