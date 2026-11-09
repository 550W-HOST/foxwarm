# Unit: Legacy isolation migration

Files: `dotnet/Foxwarm/Tools/Authorization/IsolationMigrationRules.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IsolationMigration.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Migration.cs`

R1 of the [user-decided removal of legacy Agent isolation](../modules/tools-and-permissions.md#d-tools-legacy-isolation-deprecation). It adds generic replacements and an explicit per-Agent migration while legacy isolation stays enforced. The generated layer is an ordinary [Agent-local layer](./tool-authorization.md#agent-local-authorization-layers).

## Contract

### Generated layer

`IsolationMigrationRules.Generate` is the Main-owned generator. It reads the Agent's authoritative isolation metadata: the bound Node (or none, meaning master-only) and the exact `toolRules`. It emits one local layer whose rules appear in this order:

1. Translated exact denies.
2. An allow for `create_session` with `agentName: {agent: {sameAgent: true}}`. Timer creation targets reuse `create_session` policy, and legacy allowed new-Session timers in the Agent's own Agent. This rule also lets the Agent create Sessions in its own Agent directly once legacy isolation is gone, so it is reported as `widened`. The grammar accepts the Agent matcher only on `create_session`, so `create_child_session` stays structurally denied.
3. Structural denies:
   - Agent and Session management, including `view_session`;
   - master `exec`;
   - `node` with the action `select`, `create`, `ensure` or `destroy`.
4. The baseline:
   - all Node tools on the bound Node;
   - master `read`/`write`/`edit` within `${agent.dir}`;
   - memory tools within `${agent.memoryDir}`;
   - pairwise copies between master and the bound Node, with master legs in `${agent.dir}`;
   - bound-Node file delivery to the current Session;
   - send to self, parent or child;
   - same-Agent archives and exact recall;
   - current-Session vector recall;
   - the Agent's own skills;
   - `session` status;
   - own-Session timers, whose new-Session target is the Agent's own Agent (an update may omit `newSession`);
   - ToolScript, wait, ask and other local tools.
5. Translated exact allows.
6. A final selector-free deny.

How exact rules are translated:

| Exact allow | Result | Note |
|---|---|---|
| Covered by the baseline | Not emitted | `covered` |
| `session` | Not emitted | `narrowed`: legacy honored any action, the layer allows status only |
| Structural identity, `send_to_channel`, master `exec`, Node tool off the bound Node | Not emitted | `dropped` |
| `node` | Emitted for the `list` and `inspect` actions only | `narrowed`: policy matches arguments exactly and the handler normalizes the action |
| Master delivery builtin | Emitted, limited to `${agent.dir}` and the current Session | `translated` |
| Main path builtin | Emitted with `${agent.dir}` containment | `translated` |

Rule IDs are `isolation-<purpose>[-n]`. Every plan carries notes, each with one of the kinds `translated`, `covered`, `dropped`, `narrowed` or `widened`. These cases are blockers:
- the layer would exceed 256 rules;
- an isolated `main` in the retained shared-workspace layout, whose nested-Agent exclusion a local layer cannot express;
- a recorded isolation Node of `master`, which no supported setter writes and which would otherwise become a rule granting every master path.

**Downgrade grammar.** The layer uses only selectors the previous release parses. A downgraded Main must still read a migrated Agent's layer, and the layer of each of its creator descendants. In particular, Session-target matchers name only that release's resolver tools. `session` status is therefore not limited to the current Session by the layer. During R1, the retained legacy check enforces that limit.

**R2 additions.** When legacy isolation is retired, add `sessionId: {session: {self: true}}` to the status rules. R1 registers the `session` target resolver family for this.

### Creator descendants

The layer has no caller selectors, and local layers apply down the creator chain. It therefore also restricts every creator descendant of the Agent:
- the plan adds a `narrowed` note per descendant (subject `agent:<name>`);
- the inventory sets `acknowledgeDescendantsRequired`;
- apply refuses unless `acknowledgeDescendants` is true.

### Inventory and apply

`SessionManager.IsolationMigrationInventory` is read-only and never hydrates Sessions. For each isolated or migrated Agent it reports:
- the legacy state and the local rule count;
- `createdBy`, creator descendants and inheritors;
- Sessions whose catalog Node differs from the bound Node;
- stored timers of its Sessions;
- global rule IDs that name the Agent in `agent` selectors;
- the candidate layer, with its digest and notes;
- any `defaultNode` conflict, and the blockers.

For migrated Agents it adds `needsBackfill`. The catalog shows an unset Node as master, so `needsBackfill` may also count Sessions placed elsewhere. The inventory also lists channel guest configurations and the installation reader levels.

`ApplyIsolationMigrationAsync` is explicit and runs on one Agent.

For an Agent that has not been migrated, one catalog write:
- installs the layer;
- sets `inheritable: false`;
- sets `defaultNode` to the bound Node when it is unset (a different existing value is kept and reported);
- records `legacyIsolation` (`node`, `migratedAt`, `generator`, `rulesDigest`).

It refuses Agents that have local rules, inheritors, unacknowledged descendants or a blocker. Legacy `isolated`, `isolatedNode` and `toolRules` stay unchanged as the downgrade fence, so legacy checks keep applying on top of the layer.

Afterwards, every Session of a bound Agent without a stored `currentNode` records the bound Node; the Session was already running there through the binding fallback. Sessions placed elsewhere and per-Session failures are reported.

Applying again to a migrated Agent reruns only this idempotent backfill and returns `applied: false`. This resumes an interrupted or partly failed apply.

Automatic migration is not enabled in R1.

## Installation reader level

`state/installation.json` may carry `minimumReaderVersion`. `AgentCatalog` refuses to load when that value exceeds its `ReaderVersion`, which is currently 1.

The marker is computed per level: each level counts only data that earlier readers would ignore.
- Level 1 is required by `legacyIsolation` markers and `inheritable: false`.
- Creator links and local rules do not raise it, because earlier binaries already enforce them.
- Node ancestry is not covered.

A catalog write raises the marker to the level its metadata requires before writing that metadata, and never lowers it. Startup does not write the marker. Binaries older than the marker ignore it, so it protects only later downgrades. Agents relying solely on local rules are not downgrade-supported.

## Tests

`ToolAuthorizationEffectsTests.IsolationMigration.cs` covers:
- generator ordering and per-rule reports;
- authorization and timer parity between a legacy isolated Agent and both its migrated (dual) and layer-only forms;
- handler-local limits expressed as policy;
- MCP server prefiltering;
- inventory and apply;
- `inheritable`;
- the reader marker.

`ToolAuthorizationEffectsTests.IsolationMigrationReview.cs` covers:
- the previous-release selector allowlist;
- `node` action spellings;
- the master-binding blocker;
- the `session` narrowing note;
- descendant acknowledgement;
- the per-level reader marker;
- the resumable backfill.

`IsolationMigrationHttpTests` covers the administrator routes.
