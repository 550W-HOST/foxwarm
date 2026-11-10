# Unit: Session and Agent list visibility

Files: `dotnet/Foxwarm/Sessions/SessionManager.SessionVisibility.cs`

Secondary files: `dotnet/Foxwarm/Sessions/SessionObservation.cs`, `dotnet/Foxwarm/Sessions/AgentMemory.Manifest.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Rules.cs`

The model-facing `session(action:"list")`, the "Recent child sessions" of `session` status and `list_agents` use the projection below. It follows the [Node list visibility](./node-list-visibility.md) pattern and reuses its `ToolVisibilityContext` and the known-argument `Visible` overload in [tool authorization](./tool-authorization.md). The list scope contract is [D-session-tool-list-scope](./src-tools-session-agent.md#d-session-tool-list-scope).

## Contract

**User decision (2026-11-11, all design recommendations accepted).** A model's Session and Agent lists show only what its policy might let it use. Visibility never authorizes: every call on a listed Session or Agent keeps its strict per-call checks, and a listed target may still reject a call.

- **Sessions.** A Session is listed when one of these addressing capabilities might be allowed with it as the target:
  - `session` status or `update-display-name`;
  - `view_session`;
  - `recall`, `get_archived_messages` or `get_archived_blocks` with its `sessionId`;
  - `send_to_session`;
  - `stop_session`;
  - `task` create or assign with it as `ownerSessionId`.

  The caller's own Session is always listed. `send_file`, timers, compaction/snapshot/settings tools, `delete_session`, `move_session`, `update-parent` and `wait` don't admit a Session: they are routinely granted wholesale for the caller's own work, so counting them would list the whole catalog. A rule that allows `session` status for every Session lists every Session. Because the `session` resolver maps an omitted `sessionId` to the caller for every action, including `list`, a policy narrows the list with `args.sessionId: {session: {...}}`.
- **Agents.** An Agent is listed when it owns a listed Session, or when one of these might be allowed on it:
  - `create_session` or `create_child_session` with it as `agentName`;
  - `move_session` with it as `newAgentName`;
  - `skill` list or load with it as `agentName`;
  - `set_agent_inherit` or `set_agent_rules`.

  The structural limits of those actions apply: `AgentCatalog.SessionTargetAllowed`, the non-throwing form of `RequireSessionTarget`, for Session placement by delegated Agents, and `RulesTargetAllowed` (strict creator ancestors) for rule replacement. The caller's Agent is always listed. Row session counts are listed Sessions only; `inherits` and `created by` may name an Agent that is not listed.
- **Probe semantics.** Each probe is a builtin request with target `master` and no paths or Node targets, the same facts discovery builds for builtins. It carries the caller's Agent, Session, current Node and canonical parent (`SourceParent`) and the target's `AuthorizationTarget`. The target argument and, where the tool has one, `action` are known; every other argument stays conditional. Conditional possible allows and `ask` count as possible; a conditional deny alone hides nothing. Every policy layer must leave the probe possible, and external-runtime callers drop tools the runtime can't call.
- **Failure.** An unavailable global policy propagates (`TOOL_AUTH_POLICY_UNAVAILABLE`) and fails the list; there is no unfiltered fallback. An invalid Agent rule chain makes nothing visible except the caller's own Session and Agent.
- **Ordering and paging.** Filtering happens before `start`/`count`/`query`. Totals, ranges, next-page hints and `query` totals count listed Sessions only. `scope` keeps its meaning over the listed set. The model is not told how many Sessions or Agents were hidden.
- **Administrator surfaces stay unfiltered.** These include the WebUI sidebar and session-list API, the Agents panel, `AgentListEntries`, and the administrator-equivalent channel `/status` (`ObserveAsync(..., administrator: true)`). Inbound MCP `foxwarm_session list` and scoped WebUI identities keep their own scopes.
- **Not confidentiality.** Hiding is not confidentiality: Session IDs remain visible through Task and timer fields, handoff text, recall within the Agent, errors and `explain_tool_authorization`. To find out why a Session is missing, explain a concrete `view_session` or `send_to_session` call against it. Explain's own guard (`view_session` on another probed Session) means every Session it can address is also listed.

## Cost model

A probe's result depends on a few facts about the target:

- whether it is the caller's parent (`SourceParent`);
- whether its canonical parent is the caller;
- whether it belongs to the caller's Agent;
- which of its spellings (canonical ID, aliases, and for `send_to_session` the `<parent>`/`<main>` references) a rule names as a scalar literal on `sessionId` or `ownerSessionId`.

Caller selectors are constant. These builtins have no Node or path facts. Relationship and existence matchers behave alike for every spelling no rule names.

`SessionListVisibility` therefore:

1. Collects the literal set once per call from every policy layer.
2. Classifies each row in O(1).
3. Memoizes the probe result per class.

The constructor `memoize: false` mode evaluates every row with its real `AuthorizationTarget`, and tests compare the two modes.

The list chooses its candidates as follows:

- **Unfiltered.** `Covers(scope)` holds when the unrelated and child classes in scope are visible and every explicit row in scope is admitted. The existing indexed `CatalogMetadataOffset` page is then used unchanged.
- **Explicit.** When the unrelated classes are hidden (`!Broad(scope)`), only the explicit set is read: the caller, its parent, its children (indexed per-parent query plus unpersisted local children) and Sessions a rule names.
- **Agent-scoped.** When only the caller's Agent is broadly visible, the candidates are that Agent's rows plus the explicit set.
- **Scan.** Otherwise the scope is scanned like a keyword search (`ListPresentations`).

`ListedCount(agent, total)` uses the same split. Rows outside the explicit set share the Agent's unrelated class, so a count is either the catalog total minus hidden explicit rows, or the admitted explicit rows.

Measured in `SessionListVisibilityScaleTests` on 4,000 synthetic Sessions (development Provider, Debug build):

| Policy | Listed | Probes (class memo vs per row) | Class memo time | List call |
| --- | --- | --- | --- | --- |
| unrestricted | 4,001 | 5 vs 4,000 | about 15 ms | about 10 ms (indexed page) |
| mixed: same-Agent view, literal denies and allows, child ask, parent task | 1,261 | 77 vs about 34,000 | about 20 ms | about 75 ms (Agent-scoped candidates) |
| restricted: self recall and `<parent>` send | 2 | 45 vs about 43,000 | about 6 ms | about 37 ms (explicit set of about 570 children) |

## Tests

`AgentRulesTreeTests.ListVisibility.cs` covers:

- **Session list.** Relation, literal and alias admission; filtering before scope, `query` and paging. Wholesale `session` grants match the unfiltered output; `sameAgent`-scoped `session` grants; self-oriented, management and Task-own grants don't widen the list. `ask`, conditional versus unconditional denies, and Agent-local layers with a `<parent>` literal.
- **`list_agents`.** Listing through owned listed Sessions, `create_session` targets, strict-ancestor rule replacement and delegated creation limits, with listed counts.
- **Status children and failure.** Status children are filtered, while the administrator status is not; lists fail when policy is unavailable.

`SessionListVisibilityScaleTests` checks class-memo versus per-row equality, probe counts bounded by classes rather than rows, and list totals on a 4,000-Session catalog, and logs the timings above. `SessionListQueryTests` keeps the unrestricted keyword-list contract.
