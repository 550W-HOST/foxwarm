# Unit: Legacy isolation migration

Files: `dotnet/Foxwarm/Tools/Authorization/IsolationMigrationRules.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IsolationMigration.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IsolationStartup.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Migration.cs`

Mechanics of the [user-decided removal of legacy Agent isolation](#d-tools-legacy-isolation-deprecation). R1 added generic replacements and an explicit per-Agent migration while legacy isolation stayed enforced. R2 migrates every remaining isolated Agent at startup and stops enforcing legacy isolation. The generated layer is an ordinary [Agent-local layer](./tool-authorization.md#agent-local-authorization-layers).

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
   - the Agent's own skills: list, load and copy, and `run_skill` (generator 3), after a `run_skill` deny for `advisor` placed with the structural denies (the advisor forks its Session, which `create_child_session` in the structural deny already refuses);
   - `session` status of the current Session (generator 2);
   - own-Session timers, whose new-Session target is the Agent's own Agent (an update may omit `newSession`);
   - ToolScript, wait, ask and other local tools. Layers generated before the `ctl` front end also listed the retired `search_tools`; a stored layer that differs from the current generation only by that name counts as current and is kept as stored ([D-ctl-command-registry](./ctl-command-registry.md#d-ctl-command-registry)).
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

**Downgrade grammar.** The layer uses only selectors the previous release parses. A downgraded Main must still read a migrated Agent's layer, and the layer of each of its creator descendants. In particular, Session-target matchers name only that release's resolver tools. Generator 1 (R1) therefore left `session` status unlimited and relied on the legacy check. Generator 2 (R2) adds `sessionId: {session: {self: true}}` to the status rules; R1 registered the `session` target resolver family for this, so R1 parses a generator 2 layer. Generator 3 adds only argument values and a builtin name (`action: copy`, `run_skill` with `skillName` and `agentName`), which every earlier release parses.

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
- it installs the current (generator 3) layer;
- when that is not safe it installs the fail-closed layer instead: one selector-free deny (`isolation-fail-closed`), which also denies the Agent's creator descendants. The cases are: the Agent already has local rules (kept in `legacyIsolation.previousRules` for a manual merge), a plan blocker such as a master binding or the retained-layout isolated `main`, and creator metadata that cannot be evaluated;
- it sets `inheritable: false` unless other Agents inherit from it (reported as `inheritors`);
- it sets `defaultNode` to the bound Node when unset; a different value is kept and reported;
- it records `legacyIsolation` with `node`, `migratedAt`, `generator`, `rulesDigest`, `automatic: true` and, for the fail-closed case, `failClosed` (the reason).

An Agent migrated by R1 (generator 1) is upgraded: its status rules gain the current-Session limit. Its digest is updated only when the layer was unchanged since migration; an edited layer is reported. Fail-closed markers are never upgraded.

Older releases still write the fence (`isolated`, `isolatedNode`, `toolRules`) and the rules, so every startup also reconciles migrated rows with it (`ReconcileMigratedRow`). A formerly isolated Agent must never come out of startup less restricted than its last enforced state, except for self-scoped operations ([user decision, 2026-11-15](./tool-operation-authorization.md#d-auth-operation-self-exempt)): since operation-authorization phase 3 no generated or fail-closed layer denies them. **Second exception (user decision, 2026-11-25, U2):** an Agent may read, copy and run the skills it may already load. The baseline `skill` rule (`agentName` absent or the Agent itself) covered `skill load <name> <path>` without a generator change; generator 3 adds `copy` to its actions and a `run_skill` allow with the same `agentName` limit. The files have the author and trust of the `SKILL.md` the Agent could already read, no Node read is granted, a copy's destinations meet the layer's own write rules (the bound Node and `${agent.dir}` on master), and a skill run's nested calls meet the layer, while its model requests are allowed ([skill access](./skills.md#skill-access)). Its plan notes this as `widened` for `builtin:skill,run_skill`. At startup an unedited generated layer of generator 1 or 2 is generated again (outcome `regenerated`, with a reason naming the earlier release), and its marker records generator 3 and the new digest; an edited generator 2 layer is kept as stored, its marker records generator 3, and the report (`upgraded`) says the skill rules were not added; an edited generator 1 layer gets only the status limit, as before. The marker records `fenceDigest`, a digest of the fence, whenever a layer is generated, accepted or written by `set_agent_rules`:
- A layer whose own rules do not parse already fails every call; the row is left unchanged and reported as `unreadableRules`. The same applies when only a creator's layer does not parse, for migrated and not yet migrated rows alike: the row reconciles normally once the creator is repaired. A creator cycle is a plan blocker and fails closed.
- A cleared fence (`isolated: false`) keeps the layer and is reported once (`fenceCleared`); it never widens the Agent.
- An unchanged generated layer always follows the current fence, and accepting it records the current `fenceDigest` even when regeneration yields the same layer: it is regenerated from the fence, as `rebound` when the Node changed and `regenerated` when only `toolRules` did. `defaultNode` follows a Node change when it still named the old Node.
- Otherwise a changed fence fails closed. A marker without `fenceDigest` (R1) can show only a Node change.
- A layer written by this release through `set_agent_rules` records `confirmedDigest` and is the administrator's.
- A layer edited elsewhere (an older release or by hand) is kept only when the Agent's own layer, as the policy parses it, ends in an enabled deny without selectors; it is reported once (`edited`) and confirmed. A creator's layer does not count, because its allows still reach the Agent. Otherwise the Agent fails closed with the edited rules in `previousRules`.

The registry `restricted` flag uses the same parsed check; a layer that does not parse counts as restricted.

Catalog writes validate only the rows they change. A layer that does not parse elsewhere is written unchanged and reported as `unreadableRules`; only that Agent's calls fail, and Main starts.

After owner recovery, `MaterializeMigratedPlacementAsync` records the bound Node on every Session of a bound migrated Agent that has no `currentNode`, as the R1 apply did. It repeats at each startup until every Session succeeded once, then marks `placementSettled`.

Every outcome is written to the Main log (`MainLog.Diagnostic`; fail-closed and placement failures as failures). The report of the last startup is `StartupIsolationMigration`, returned as `startup` by the inventory route. The Agent registry reports `restricted` and an `isolationMigration` summary. `failClosed` is reported only while the stored layer still has the fail-closed digest, so replacing the rules clears it. The System view shows a `blocked` badge and notice for fail-closed Agents and a note for migrated ones.

Legacy `isolated`, `isolatedNode` and `toolRules` are never changed, so a downgraded R1 (0.9.4) enforces both legacy isolation and the layer. Releases before R1 cannot parse the generator 2 `session` target matcher, so every call by a migrated Agent and its creator descendants is refused there until the installation is upgraded again; layers parse per call, so Main still starts. `IsolatedToolCompatibility.Metadata` is their only reader. Nothing else enforces them, and no setter writes them.

Archive reads of cleared and deleted Sessions stay within the layer's same-Agent rule because the `archive` target resolver falls back to the requested ID's Agent ([tool authorization](./tool-authorization.md)).

### Channel guests

`ProvisionChannelGuestAsync` takes guest policy from `guestAgent.template`. The template must exist and have local rules on its creator chain. An inherited guest is created with the template as creator (bypassing the direct-child limit), inheriting memory from the configured Agent and using the configured Node as `defaultNode`. A single-mode guest Agent must be the template or a creator descendant of it, and its `defaultNode` must equal the configured Node. Without a template, provisioning refuses unless the configuration sets `isolated: false`. Existing guests were isolated Agents and migrate like any other.

## Installation reader level

`state/installation.json` may carry `minimumReaderVersion`. `AgentCatalog` refuses to load when that value exceeds its `ReaderVersion`, which is currently 3.

The marker is computed per level: each level counts only data that earlier readers would ignore.
- Level 1 is required by `legacyIsolation` markers and `inheritable: false`.
- Level 2 is required by Agent-local rules containing operation (`op`) rules ([reader marker](./tool-operation-rules.md#reader-marker)).
- Level 3 is required by Agent-local rules stored in the scripted `{ script, data? }` object form ([policy scripts](./tool-authorization.md#policy-scripts)).
- Creator links and plain version-1 rule arrays do not raise it, because earlier binaries already enforce them.
- Node ancestry is not covered.

A catalog write raises the marker to the level its metadata requires before writing that metadata, and never lowers it. The R2 startup migration writes metadata through the same check. Binaries older than the marker ignore it, so it protects only later downgrades. Agents relying solely on local rules are not downgrade-supported.

## Design decisions

### D-session-core-isolated-relations

Historical until R2: explicit direct parent/child relations were the only inter-session targets of an isolated sender, including within its own Agent. This exception does not grant tool, filesystem, or node permissions.

[2026-11-09] User decision: only the outgoing direction remains a legacy isolation boundary. Delivery and wait dependencies from an isolated Agent's Session are limited to itself and its direct parent or child; the maintained C# Main enforces this in `SessionManager.SendAsync` (every sender path, including Task notifications) and `ValidateWait`. The incoming guard is retired: whether another Session may message, wait on, or view an isolated Agent's Sessions is decided by that caller's own policy. Removal of the outgoing check follows the [legacy isolation migration](#d-tools-legacy-isolation-deprecation).

[2026-11-10] R2 retires the remaining guard. The generated local layer of each migrated Agent allows `send_to_session` only to itself, its parent or its children (`session.self` / `relation` matchers), which covers direct, unified and ToolScript sends. Notifications produced by other tools, such as Task completion, follow the policy of the tool that produces them. The wait-dependency guard is retired without a replacement (coordinator decision for R2). `SessionManager.SendAsync` and `ValidateWait` no longer check isolation.

### D-tools-legacy-isolation-deprecation

**Directly selected migration direction; removal completed in R2 except fence cleanup.** Generic policy must eventually separate tool authorization from [environment isolation](../behaviors/nodes-workspaces-and-permissions.md#authority-has-several-independent-boundaries). Current guards remain operative until their replacement/retirement is decided; implementation history does not make every legacy guard a permanent product constraint.

[2026-10-10] The legacy Agent `isolated` authorization mode is deprecated and planned for removal. At that point the invariants above described implemented behavior, and deprecation did not itself disable guards or migrate an installation; R2 (below) did both. Generic tool authorization is the migration direction, not a permanent second layer alongside legacy isolation.

The generated layer provides a conservative migration baseline, not a requirement to reproduce every legacy behavior. During removal, remaining differences require explicit decisions: express a boundary through generic policy, retain an independent invariant, or retire the old restriction. No removal date or complete migration contract is established by this decision.

[2026-11-09] **User decisions for the removal.** Removal runs in two releases. R1 adds the generic replacements and an explicit, per-Agent migration while legacy isolation stays enforced (dual enforcement); R2, one release later, migrates remaining isolated Agents automatically and fails closed, then retires the legacy checks. Accepted choices: a generic `inheritable: false` Agent flag replaces the isolated-source inheritance ban; the bound Node becomes a soft `defaultNode` placement, not an access boundary; migrated Agents cannot send to channels directly (replies and own-Session file delivery remain); inbound channel files go to Main Agent storage; the generated layer includes the legacy-parity baseline (ToolScript run family, `ask_user`, `cancel_transfer`, `image_crop`, default-self status); channel guest policy comes from a creator-template Agent; Agents that rely only on local rules are not downgrade-supported, and an installation `minimumReaderVersion` marker refuses newer data in older readers that understand it. Of the Session relation guards only the outgoing one is kept ([D-session-core-isolated-relations](#d-session-core-isolated-relations)). The R1 mechanics are in [legacy isolation migration]().

[2026-11-10] **R2: legacy isolation is no longer enforced.** User decisions for this release:
- At startup, before Main accepts work, every Agent still marked isolated without a migration marker is migrated automatically. When that cannot be done safely the Agent receives a fail-closed layer that denies every call until an administrator replaces its rules. Results are logged and shown in the System view ([R2 startup migration](#r2-startup-migration)).
- The legacy setters are removed without aliases: `set_agent_isolated`, `create_agent` `isolatedNode`/`toolRules`, `/agent isolated`, `/agent create --isolated` and the WebUI isolation field. The remaining surface is `set_agent_rules`, `defaultNode` and the restricted-worker template.
- Persisted `isolated`, `isolatedNode` and `toolRules` stay written and are read only by the startup migration and by older releases after a downgrade, which keep enforcing them. Removing them is R3.
- Migrated Agents cannot use `send_to_channel` or channel-target `send_file`; there is no attached-channel matcher.
- Inbound channel and WebUI files are stored on master in the Agent directory.
- Channel guests take their policy from `guestAgent.template`; a guest configuration without a template refuses to provision new guests unless it sets `isolated: false`. Existing guests migrate like other isolated Agents.
- `inheritable: false` stays on migrated Agents. New restricted Agents get no legacy fence, and the installation reader-level marker is unchanged.
- The wait-dependency relation guard retires; `send_to_session` limits are expressed by the generated layer ([D-session-core-isolated-relations](#d-session-core-isolated-relations)).

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

`ToolAuthorizationEffectsTests.IsolationStartup.cs` covers the startup migration of a pre-R1 isolated Agent (layer, marker, retained fields, placement, report, idempotent restart), the generator 1 upgrade with edited and unedited layers, the generator 2 to 3 regeneration of an unedited layer (skill copy and runs allowed for the Agent's own skills, not for another Agent's, `advisor` runs and forks denied) and the edited layer kept, the fail-closed cases and their clearing by new rules, and global rules that name a migrated Agent. `ToolAuthorizationEffectsTests.IsolationFence.cs` covers the parsed restriction check (disabled, shorthand and creator denies), the registry label, real R1-written data with unchanged and changed `toolRules`, a later fence change after an accepted edit, an unreadable migrated layer, an unreadable creator layer before and after repair, and the fence recorded for an accepted unedited layer. `ToolAuthorizationEffectsTests.IsolationReconcile.cs` covers reconciliation with the fence an older release left: an edited layer that no longer restricts the Agent, an edited layer that still ends in a deny, a re-bound Agent with an unchanged and an edited layer, a cleared fence, and an unreadable layer of another Agent during the startup write. `GuestTemplateTests` covers guest provisioning.

`IsolationMigrationHttpTests` covers the administrator routes. `mainHostIsolationMigration.e2e.mjs` starts a real host on a legacy catalog and checks the startup report, the registry, the recorded placement and a restart; it is part of the native smoke.
