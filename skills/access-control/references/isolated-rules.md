# Generate an isolated-like tool allowlist

Use [the offline generator](../scripts/generate-isolated-rules.mjs) to prepare a conservative, caller-scoped baseline for migration away from [deprecated legacy Agent isolation](../../../docs/code-index/modules/tools-and-permissions.md#d-tools-legacy-isolation-deprecation), using the existing version-1 policy engine. It produces a **rules fragment**, not an installed policy, an Agent configuration, or a complete replacement for isolation. The differences below inform migration decisions; they do not require every old restriction to be preserved or a permanent two-layer authorization system.

**Do not disable isolation merely because this fragment parses.** Removing the flag removes separate tool-local and relationship guards. In particular, caller-only rules do not preserve the incoming restriction that prevents unrelated Sessions from contacting an isolated target. Other callers need a separate policy review. Permitted `exec` also retains full access to the selected environment's files, commands, credentials, and network. Tool authorization is not an operating-system or network sandbox.

## Run offline

Requires Node.js and Foxwarm's existing `js-yaml` dependency; no new package is needed. Run from a checkout/installation where those dependencies are available. Use ordinary authorized shell execution, not the Python-subset ToolScript interpreter.

Create a private JSON mapping, for example:

```json
{
  "reviewer": "node-a",
  "writer": null
}
```

Keys are exact caller Agent names. Values are exact permitted Node IDs; `null` or `"master"` selects master-only operation. These are declarations, not verified topology: the generator does not read Agents, Node bindings, Session placement, existing policy, or credentials. It does not create or bind anything. Node IDs and Agent names must be non-empty, without surrounding whitespace, and fit the policy's 512-byte matcher limit.

From the repository root:

```bash
node skills/access-control/scripts/generate-isolated-rules.mjs mapping.json > rules-fragment.yaml
```

When using a loaded skill, resolve the script from the returned skill directory instead of assuming the repository cwd. `--help` prints usage. The only generated document is `{ rules: [...] }` on stdout; stderr contains a short review reminder. Invalid input fails with no fragment. The generator never installs policy, merges files, changes isolation, or overwrites an output file itself. Shell redirection has its ordinary file-write behavior; choose a new private destination, never the live authority.

Agents are sorted before generation; rule IDs use `isolated-basic-<ordinal>-<purpose>`. Review ID collisions when combining fragments or replacing an older generated block. Output exceeding 256 rules is rejected; existing rules also count toward the complete candidate's limit. Validate the **complete** candidate with the current parser or installer rather than treating the generator as another policy validator.

## Generated capabilities

Each Agent receives its own allow rules followed by a deny-all for that caller. Agents absent from the mapping receive no rules. The generator does not choose `defaultAction`.

| Capability | Allowed scope |
| --- | --- |
| Node tools | Any concrete Node capability on the declared non-master Node, subject to its advertised capabilities and normal tool validation. No master `exec`, including with a `"master"` mapping. |
| Master files | Node-source `read`, `write`, `edit`, `apply_patch`; every selected path must be inside `${agent.dir}`. Patch containment covers all operations. |
| Memory | Builtin memory CRUD and `apply_patch_memory`; every path inside `${agent.memoryDir}`. |
| Copy | Explicit master/master, master/declared-Node, declared-Node/master, declared-Node/declared-Node pairs. Each master leg must stay inside `${agent.dir}`. Remote legs do not use host containment. |
| File delivery | Current Session attachments only, using the tool's default target or canonical self/alias. `channelTargetId` must be absent. File paths must be own-Agent on master, or use the declared Node. |
| Image save/crop | Save to own-Agent master paths or the declared Node; crop existing Session images. |
| Session messaging | Direct parent or child, including cross-Agent delegation reports. Siblings are not included, even within the same Agent. Self-send remains rejected by the handler. |
| Archive reads | Registered archive tools and non-vector `recall` target same-Agent Sessions, including default self. No `get_session_messages` grant. |
| Vector recall | Canonical self only; an omitted `sessionId` requires `scope: current-session`. Explicit self/alias already selects Session scope. `agentName` is absent or exactly the caller Agent. |
| Session status | `sessionId` absent, with `action` absent or exactly `status`. No list, display-name change, or parent change. |
| Skills | Exactly `action: list` or `load`; `agentName` absent or exactly the caller Agent. Inherited/global skill discovery still uses the normal skill resolver. |
| Timers | Own Session CRUD, with the explicit creation/update choices below. |
| Local control/discovery | `wait`, `submit_compact_plan`, `search_tools`; their normal handler checks still apply. |

No MCP, Agent/Node lifecycle administration, child creation, `task`, or `run_script` grant is generated. `call_tool` is the permission-neutral dispatcher: nested calls authorize the concrete tool rather than needing a wrapper allow. Do not infer that `search_tools` or every ToolScript host operation is permission-neutral.

### Timer calls

- `create_timer`: for the current Session, omit `newSession` or set it to `false`, with `agentName` and `sessionPrefix` absent. Alternatively set `newSession: true`, with `agentName` absent or exactly the caller Agent; a new-session prefix may be supplied.
- `update_timer`: set `newSession: false`, with `agentName` and `sessionPrefix` absent, to deliver to the owner Session and clear new-session settings. To retain new-session delivery, set both `newSession: true` and `agentName` to the caller Agent explicitly.
- `list_timers` and `delete_timer`: target canonical self, including the default target.

The explicit update fields are a **more conservative calling requirement**, not a claim that legacy isolation prohibited own-Agent new-session timers. Timer updates can inherit stored target fields when omitted; authorization rules see call arguments, not that persisted target. Requiring an explicit mode/Agent avoids carrying an unknown stored target through an allowed update. Before any migration, separately review existing timers and their scheduled effects: installed tool rules do not reauthorize every already-scheduled trigger.

## Differences from legacy isolation

This baseline is intentionally narrower in some places and cannot express other boundaries:

- No attached-channel matcher exists. Direct `send_to_channel` and channel-target `send_file` are omitted; normal replies and self-target file delivery still use current attachments.
- The mapping fixes one non-master Node per Agent. It does not follow binding changes or admit every future Session `currentNode`. Regenerate/review when routing changes; a stale mapping is still an authorization grant to its declared Node.
- The `session` builtin has no registered relationship matcher. Safe default-self status is allowed, but even an explicit self ID/alias is omitted. Scalar arguments are not normalized by policy into all spellings accepted by handlers, so use the documented exact forms.
- Legacy isolated vector recall forces current-Session scope even when callers omit scope or request a broader one. The generated policy instead requires a resolvable self target; default vector search needs `scope: current-session`.
- Caller rules do not protect the mapped Agent against other callers. Legacy messaging checks both ends; disabling the target's isolated flag removes its incoming guard. Review all sending callers, existing broad rules, external entry identities, and cross-Agent relationships separately.
- Custom legacy exact `toolRules` are not imported. Review them independently rather than assuming this baseline reproduces configured additions or denials.
- Existing timer triggers, Session placement, Node services, and actual environment isolation are not changed by this script.

For host files, the generic engine's canonical path facts also detect static symlink escapes. Remote namespaces are opaque: `allWithin` a host base cannot prove remote containment. This policy is not a promise against concurrent symlink replacement or arbitrary effects of permitted shell execution.

## Merge and assess

Follow [safe policy updates](policy-updates.md) to read the entire active policy, merge a complete candidate, validate and exercise representative allowed/denied cases, retain a recovery path, and install through `set_config` with `target: tool-rules` only when authorized. Do not blindly append or prepend the fragment: an earlier broad allow can bypass its deny-all, while new allows placed ahead of existing denies can expand access. Preserve unrelated caller rules and the existing default.

Any decision to remove legacy isolation is a separate lifecycle/migration action governed by [agent-management](../../agent-management/SKILL.md). Assess lost guards and existing persisted automation before authorizing that action. Successfully generating a fragment is not migration approval.

Canonical implementation contracts: [generic policy](../../../docs/code-index/units/src-tool-authorization.md), [legacy isolation checks](../../../docs/code-index/units/src-isolated-check.md), and [tools and permissions](../../../docs/code-index/modules/tools-and-permissions.md). Those references describe the framework; this skill supplies the review and generation workflow.
