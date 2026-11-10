# Unit: Legacy isolation migration

Files: `dotnet/Foxwarm/Tools/Authorization/IsolationMigrationRules.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IsolationMigration.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IsolationStartup.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Migration.cs`

Mechanics of the [user-decided removal of legacy Agent isolation](../modules/tools-and-permissions.md#d-tools-legacy-isolation-deprecation). R1 added generic replacements and an explicit per-Agent migration while legacy isolation stayed enforced. R2 migrates every remaining isolated Agent at startup and stops enforcing legacy isolation. The generated layer is an ordinary [Agent-local layer](./tool-authorization.md#agent-local-authorization-layers).

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
   - `session` status of the current Session (generator 2);
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

**Downgrade grammar.** The layer uses only selectors the previous release parses. A downgraded Main must still read a migrated Agent's layer, and the layer of each of its creator descendants. In particular, Session-target matchers name only that release's resolver tools. Generator 1 (R1) therefore left `session` status unlimited and relied on the legacy check. Generator 2 (R2) adds `sessionId: {session: {self: true}}` to the status rules; R1 registered the `session` target resolver family for this, so R1 parses a generator 2 layer.

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

It refuses Agents that have local rules, inheritors, unacknowledged descendants or a blocker. Legacy `isolated`, `isolatedNode` and `toolRules` stay unchanged as the downgrade fence, so a release that still enforces legacy isolation applies it on top of the layer.

Afterwards, every Session of a bound Agent without a stored `currentNode` records the bound Node; the Session was already running there through the binding fallback. Sessions placed elsewhere and per-Session failures are reported.

Applying again to a migrated Agent reruns only this idempotent backfill and returns `applied: false`. This resumes an interrupted or partly failed apply.

The explicit routes remain in R2 for inventory and for rerunning the backfill.

## R2 startup migration

`SessionManager.MigrateLegacyIsolationCatalogAsync` runs in `LoadOwnersAsync` right after identity startup, before Main accepts work, as one atomic catalog write (`AgentCatalog.MigrateMetadataAsync`).

For each Agent still marked isolated without a `legacyIsolation` marker:
- it installs the generator 2 layer;
- when that is not safe it installs the fail-closed layer instead: one selector-free deny (`isolation-fail-closed`), which also denies the Agent's creator descendants. The cases are: the Agent already has local rules (kept in `legacyIsolation.previousRules` for a manual merge), a plan blocker such as a master binding or the retained-layout isolated `main`, and creator metadata that cannot be evaluated;
- it sets `inheritable: false` unless other Agents inherit from it (reported as `inheritors`);
- it sets `defaultNode` to the bound Node when unset; a different value is kept and reported;
- it records `legacyIsolation` with `node`, `migratedAt`, `generator`, `rulesDigest`, `automatic: true` and, for the fail-closed case, `failClosed` (the reason).

An Agent migrated by R1 (generator 1) is upgraded: its status rules gain the current-Session limit. Its digest is updated only when the layer was unchanged since migration; an edited layer is reported. Fail-closed markers are never upgraded.

Older releases still write the fence and the rules, so every startup also reconciles migrated rows with their fence (`ReconcileMigratedRow`). A formerly isolated Agent must never come out of startup less restricted than its last enforced state:
- A layer written by this release through `set_agent_rules` records `confirmedDigest` in the marker and is the administrator's; reconciliation keeps it.
- A layer edited elsewhere (an older release or by hand) that still ends in an unconditional deny on the Agent's creator chain is kept and reported once (`edited`), then confirmed. One that no longer restricts the Agent fails closed, with the edited rules in `previousRules`.
- `isolatedNode` differing from `marker.node` means an older release re-bound the Agent. An unchanged generated layer is regenerated for the new Node (`rebound`), and `defaultNode` follows when it still named the old Node. An edited layer fails closed.
- A cleared fence (`isolated: false`) keeps the layer and is reported once (`fenceCleared`); it never widens the Agent.

Catalog writes validate only the rows they change. A layer that does not parse elsewhere is written unchanged and reported as `unreadableRules`; only that Agent's calls fail, and Main starts.

After owner recovery, `MaterializeMigratedPlacementAsync` records the bound Node on every Session of a bound migrated Agent that has no `currentNode`, as the R1 apply did. It repeats at each startup until every Session succeeded once, then marks `placementSettled`.

Every outcome is written to the Main log (`MainLog.Diagnostic`; fail-closed and placement failures as failures). The report of the last startup is `StartupIsolationMigration`, returned as `startup` by the inventory route. The Agent registry reports `restricted` and an `isolationMigration` summary. `failClosed` is reported only while the stored layer still has the fail-closed digest, so replacing the rules clears it. The System view shows a `blocked` badge and notice for fail-closed Agents and a note for migrated ones.

Legacy `isolated`, `isolatedNode` and `toolRules` are never changed, so a downgraded R1 (0.9.4) enforces both legacy isolation and the layer. Releases before R1 cannot parse the generator 2 `session` target matcher, so every call by a migrated Agent and its creator descendants is refused there until the installation is upgraded again; layers parse per call, so Main still starts. `IsolatedToolCompatibility.Metadata` is their only reader. Nothing else enforces them, and no setter writes them.

Archive reads of cleared and deleted Sessions stay within the layer's same-Agent rule because the `archive` target resolver falls back to the requested ID's Agent ([tool authorization](./tool-authorization.md)).

### Channel guests

`ProvisionChannelGuestAsync` takes guest policy from `guestAgent.template`. The template must exist and have local rules on its creator chain. An inherited guest is created with the template as creator (bypassing the direct-child limit), inheriting memory from the configured Agent and using the configured Node as `defaultNode`. A single-mode guest Agent must be the template or a creator descendant of it, and its `defaultNode` must equal the configured Node. Without a template, provisioning refuses unless the configuration sets `isolated: false`. Existing guests were isolated Agents and migrate like any other.

## Installation reader level

`state/installation.json` may carry `minimumReaderVersion`. `AgentCatalog` refuses to load when that value exceeds its `ReaderVersion`, which is currently 1.

The marker is computed per level: each level counts only data that earlier readers would ignore.
- Level 1 is required by `legacyIsolation` markers and `inheritable: false`.
- Creator links and local rules do not raise it, because earlier binaries already enforce them.
- Node ancestry is not covered.

A catalog write raises the marker to the level its metadata requires before writing that metadata, and never lowers it. The R2 startup migration writes metadata through the same check. Binaries older than the marker ignore it, so it protects only later downgrades. Agents relying solely on local rules are not downgrade-supported.

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

`ToolAuthorizationEffectsTests.IsolationStartup.cs` covers the startup migration of a pre-R1 isolated Agent (layer, marker, retained fields, placement, report, idempotent restart), the generator 1 upgrade with edited and unedited layers, the fail-closed cases and their clearing by new rules, and global rules that name a migrated Agent. `ToolAuthorizationEffectsTests.IsolationReconcile.cs` covers reconciliation with the fence an older release left: an edited layer that no longer restricts the Agent, an edited layer that still ends in a deny, a re-bound Agent with an unchanged and an edited layer, a cleared fence, and an unreadable layer of another Agent during the startup write. `GuestTemplateTests` covers guest provisioning.

`IsolationMigrationHttpTests` covers the administrator routes. `mainHostIsolationMigration.e2e.mjs` starts a real host on a legacy catalog and checks the startup report, the registry, the recorded placement and a restart; it is part of the native smoke.
