# Unit: Tool operation catalog

Files: `dotnet/Foxwarm/Tools/Authorization/OperationDeclarations.cs`, `dotnet/Foxwarm/Tools/Authorization/OperationDeclarations.Capabilities.cs`, `dotnet/Foxwarm/Tools/Authorization/OperationDeclarations.Inventory.cs`, `dotnet/Foxwarm.Tests/Tools/OperationDeclarationCoverageTests.cs`, `dotnet/Foxwarm.Tests/Tools/OperationDeclarationCoverageTests.Derivation.cs`, `dotnet/Foxwarm.Tests/Tools/Fixtures/operation-conformance.json`

Secondary files: `dotnet/Foxwarm/Tools/ToolRegistry.cs`, `dotnet/Foxwarm/Tools/Ctl/CtlCommands.json`, `dotnet/Foxwarm.Tests/Tools/Fixtures/ctl-conformance.json`

This is the reference table for [tool operation authorization](./tool-operation-authorization.md). It lists the operations, the effects and obligations of each registered capability, their action branches, and the coverage and conformance corpora. Contracts, decisions and phases are owned there. In phases 1 and 2 the declarations were diagnostic metadata only. From phase 3 they also give the operations operation rules decide, the Self branches that are not assessed, and the branches visibility enumerates ([operation rules](./tool-operation-rules.md)).

## Operations

`self`, `sameAgent`, `parent` and `child` are the existing Session relation facts. Agent matchers are `self`, `descendant` (creator descendant) and `id`. "Prospective" marks a fact for a row the call itself creates.

| Op | Resources (selector) | Attributes (`with`) | Derived from |
| --- | --- | --- | --- |
| `env.read` | Node (`node`), path (`path`) | — | the execution, delivery or source Node; `WorkspaceTools.AuthorizationFacts`, `CopyAuthorizationPaths`, `MemoryTools.AuthorizationFacts`; Agent memory directories (tree legs) for `create_agent` `inheritMemory` and `move_session` `createAgentInheritMemory` |
| `env.write` | Node, path | — | the same; one op per patch Add, Update or Delete header |
| `env.exec` | Node, cwd (`path`) | — | execution Node, `exec.cwd` |
| `env.browser` | Node | — | execution Node of `browser_*` |
| `env.tool` | Node, name (`nodeTool`) | — | custom Node tool identity |
| `node.list` | — | — | rows filtered by visibility |
| `node.view` | Node, or a Provider via `node: {provider}` | — | `node inspect`; `node status` of the calling Session's current Node, or of an inbound connection's selected Node |
| `node.select` | Node | — | `node select` (internal and external) |
| `node.lifecycle` | Node (fresh create: the Provider parent and the requested facts) | `action: create\|ensure\|destroy` | `NodeProviders.AuthorizationTargets` / `EnsureAuthorizationTargetsAsync` |
| `node.trust` | Node (credential parent, pairing target, revoked member; none for a root credential or the pending list) | `action: credential\|approve\|revoke\|pending` | token, pairing and removal builtins |
| `session.list` | — | `scope` | normalized scope |
| `session.view` | target Session (`targetSession`) | — | `session` family (an omitted target is the caller), `view_session`, external read, `create_agent` source defaults |
| `session.send` | target Session | — | send family: aliases, `<parent>`, `<main>`; external send (canonical) |
| `session.deliver` | target Session | — | file family: an omitted target is the caller when no channel target is given |
| `session.create` | target Agent (`targetAgent`), Node, parent (`parent`), prospective target (`targetSession`: its Agent, fixed ID when known, child relation) | `kind: session\|child\|timer\|source`, `placement: inherited\|explicit`, `runtime`, `fork` | `create_session`, `create_child_session`, a timer's creation-target probe (`kind: timer`), and `create_agent` main and missing-source Sessions |
| `session.control` | target Session | `change: stop\|rename\|archive\|compact\|snapshot\|settings` | the per-tool `sessionId` |
| `session.manage` | target Session, new parent, new Agent | `change: reparent\|move\|delete` | `update-parent`, `move_session`, `delete_session`, `create_agent` `convertSession` |
| `history.read` | target Session | `mode: exact\|vector` | archive tools, exact recall, Session-scoped vector recall |
| `history.search` | target Agent (always the caller's own) | — | vector `recall` with `scope: current-agent`; `recall` rejects `agentName` |
| `agent.list` | — | — | rows filtered |
| `agent.view` | target Agent | — | `skill` and `run_skill` (an omitted target is the caller's Agent); the inherited Agent of `create_agent` / `set_agent_inherit` |
| `agent.create` | prospective Agent | — | `create_agent`, `move_session(createAgent)` |
| `agent.manage` | target Agent | `change: rules\|inherit` | `set_agent_rules`, `set_agent_inherit` |
| `task.create` | — | `assigned` | normalized `task` action and owner presence |
| `task.list` | — | `scope` | normalized scope |
| `task.read`, `task.update`, `task.complete`, `task.cancel` | Task (`task: {owned\|created}`) | — | Task authority |
| `task.assign` | Task (absent on create), new owner (`targetSession`; the prospective child, in its Agent, for `create_child_session(taskId)`) | — | `ownerSessionId`; claim means the caller |
| `timer.manage` | owner Session | `change: create\|update\|delete\|list`, `kind: message\|script` | timer family; update uses the persisted candidate |
| `channel.send` | channel target as delivered (`channel`: instance and canonical conversation) | — | `send_to_channel`, `send_file.channelTargetId` |
| `user.ask` | — | `secret` | `ask_user` |
| `config.read` | — | `target: tool-rules` | `explain_tool_authorization` |
| `config.write` | — | `target: config\|models\|tool-rules` | `set_config`; `add_secret` `fromConfig` rewrites |
| `secret.use` | name (`secret: {anyOf, owned}`) | — | `SecretFactsAsync` (secret domain) |
| `secret.manage` | name | — | `add_secret.name`; each `ask_user` secret-question name |
| `secret.list` | — | — | `list_secrets` |
| `mcp.call` | server and tool (`mcp`) | — | MCP identity |
| `mcp.list` | — | — | `list_mcp_servers` |
| `mcp.manage` | server | — | `mcp_config`; `add_secret` `fromConfig` MCP rewrites |
| `mcp.subscribe` | server | `action: start\|stop\|status` | `mcp_notifications` |
| `image.generate` | model when configured (`model`) | — | `generate_image` |
| `model.request` | model catalog key (`model`) | — | ToolScript `request_model_without_context` |

## Selectors

An operation rule may use these selectors:
- `op`: an exact op, a list, a family pattern `family.*`, or `*`. No pattern includes `secret.use`.
- the caller selectors `agent`, `session` and `externalId`, on the global policy only, as today;
- `node`: the existing Node selector;
- `path`: `within` or `notWithin`, over the op's single path;
- `targetSession` and `parent`: `{session: {self|sameAgent|relation}}` or `{id: [...]}`;
- `targetAgent`: `{self}`, `{descendant}` or `{id: [...]}`;
- `task`: `{owned}` or `{created}`;
- `channel`, `secret` (`anyOf`, `owned`), `mcp` (`server`, `tool`), `nodeTool`, `model`;
- `with`: declared attribute values.

When a rule lists ops explicitly, each listed op must declare every selector the rule uses. With a pattern, a resource selector restricts the rule to the ops that declare that resource. Unknown names fail at load.

Granularity, as engineering choices:

- `env.*` and `node.*` are separate families, so an environment grant never reaches management.
- Deletion stays inside `env.write`.
- A copy has no op of its own: it is a read leg plus a write leg.
- `session.view` (live state) is separate from `history.read`.
- `session.control` (stop, rename, compaction, settings) is separate from `session.manage` (relations, Agent, deletion).
- Task ops follow the existing rights table.
- Browser tools share one `env.browser`.
- List ops stay authorizable, as today.

## Capabilities

Notation:

- `[x]` marks a conditional effect.
- Obligations use the kinds defined in [effects and obligations](./tool-operation-authorization.md#operations-effects-and-obligations): **P** primary request, **S** concrete sub-request (with its identity), **Pr** policy probe, **R** retained final request, **N** nested call.
- **Self** marks a call that is not authorizable (phase 3).

| Capability | Effects (operations) | Obligations; subsumed work |
| --- | --- | --- |
| `node:read` / `node:write` / `node:edit` | `env.read` / `env.write` / `env.write` per file | P |
| `node:exec` | `env.exec(node, cwd)`; `[secret.use]` per `secretEnv` | P |
| `node:browser_*`; custom Node tool; MCP tool | `env.browser`; `env.tool`; `mcp.call` | P |
| `run_script`, `start_toolscript_run` | from a file: `env.read(source)`; inline: **Self** | P; S `node:read` of the file source (master and remote); N each `call_tool`/`ctl()`; R `model-request`: `model.request` per host call, assessed as this invocation |
| `continue_script` | **Self** | N; R `model-request` |
| `run_skill` | `agent.view(skill-agent)`: the skill subsystem discloses the entry, or with `script` another ToolScript file of the skill, as `skill load` discloses `SKILL.md` | P; N each `call_tool`/`ctl()`; R `model-request`, assessed as this invocation (with `script` among its raw arguments). No source-read sub-request. |
| `list/get/cancel_toolscript_run`, `cancel_transfer`, `wait`, `image_crop` | **Self** (owner-scoped) | — |
| `submit_compact_plan` | **Self** | S `argsFilePath` read, invalid-plan save and repair edit as Node read/write/edit |
| `ctl` | front end | resolves to the target capability |
| `ask_user` | `user.ask[(secret)]`; `[secret.manage(name)]` per secret question; `[secret.use]` for referenced names | P. Answer-time storage happens after the invocation, without its scope. |
| `send_to_session` | `session.send` | P |
| `create_child_session` | `session.create(kind: child, parent: caller, targetAgent, node, prospective child)`; `[task.assign(task, prospective child)]` | P; Task-local rights; the final child ID is bound after allocation. Subsumed: initial message, fork. |
| `create_session` | `session.create(kind: session, …)`; its Session is the caller's child when `parentSessionId` resolves to the caller | P; S each prompt file as `node:master/read` |
| `task` (one branch per action) | `task.create(assigned)` with `[task.assign]` / `task.list` / `task.read` / `task.assign(caller)` for claim / `task.assign` / `task.update` / `task.complete` / `task.cancel` | P. Subsumed: notifications. |
| `session` (one branch per action) | status: `session.view` / list: `session.list` / rename: `session.control(rename)` / archive, unarchive: `session.control(archive)` / set-parent, clear-parent: `session.manage(reparent)` | P |
| `view_session` | `session.view` | P |
| `stop_session`, `compact_session`, `refresh_session_snapshot`, `set_session_model`, `set_session_child_model`, `set_session_compact_threshold` | `session.control(stop\|compact\|snapshot\|settings)` | P |
| `move_session` / `delete_session` | `session.manage(move)`, `[agent.create]`, `[env.read]`/`[env.write]` memory legs / `session.manage(delete)` | P |
| `recall` | `history.read(target, mode)`, or `history.search` for Agent scope | P |
| `get_archived_messages/blocks` | `history.read(exact)` | P |
| `list_agents` / `skill` | `agent.list` / `agent.view`; `skill` `copy`: `agent.view(skill-agent)` for the files the skill subsystem discloses | P; `skill` `copy`: S `target-write`, one `node:<node>/write` per destination file, checked as the target leg of `copy_between_nodes` before the first write ([skills](./skills.md#skill-access)) |
| `create_agent` | `agent.create`; `[agent.view(inherit)]`; `[session.create(kind: session)]` for the main Session (its ID, Node and runtime; none for `convertSession`); existing source: `[session.view(source)]`; missing source: `[session.create(kind: source)]` in its ID's Agent; tree `[env.read]` of the source Agent's and `[env.write]` of the new Agent's memory directory for `inheritMemory`; `[session.manage(move)]` of the source (default the caller) into the new Agent for `convertSession` | P. The missing-source creation without a main Session is a known defect; its fix updates the corpus. |
| `set_agent_rules` / `set_agent_inherit` | `agent.manage(rules)` / `agent.manage(inherit)`, `[agent.view(inherit)]` | P. Subsumed: the `refreshSnapshots` refresh of the target Agent and inheriting Agents. |
| `node` (one branch per action) | list: `node.list` / inspect: `node.view` / select: `node.select` / create, ensure, destroy: `node.lifecycle(action)` | P; S `node:<selected>/get_default_cwd` probe for a remote Node that advertises it (optional: a denial only omits the default cwd); R the final Node identity at the lifecycle effect (create: the Provider parent; ensure: the existing or parent identity; destroy: the Node) |
| `copy_between_nodes` | `env.read(source)`, `env.write(target)`, both tree legs | P; R the detached transfer recheck |
| `node_create_auth_token` / `node_bootstrap_info` | `node.trust(credential)`, `env.write(master, filePath)` | P |
| `node_pair_list` / `node_pair_approve` | `node.trust(pending)` / `node.trust(approve, node)`: the ID approval assigns | P |
| `node_remove` | `node.trust(revoke)` per subtree member | P; R one `node_remove` request per member, a clone of the arguments with that `nodeId`, assessed inside the registry mutation scope before any revocation |
| `read_memory` / other memory writers | `env.read(master)` / `env.write(master)` per file, under the memory directory of the Agent `agentName` names (the caller's when omitted; `MemoryTools.TargetAgent`, shared with the handler) | P. Padded `agentName` is rejected by the handler and its assessment (differential corpus). |
| `send_file` | `env.read(node, filePath)`; `channel.send` or `session.deliver` | P. Subsumed: staging. |
| `image_write_to_file` | `env.write(node, filePath)` | P |
| `generate_image` | `image.generate` | P |
| `artifact` | prepare and publish (a file source is required): `env.read(node, filePath)`; `get`: **Self** | P; S `node:read` of the source file |
| `send_to_channel` | `channel.send` | P |
| `create_timer`, `update_timer` | `timer.manage(owner, change, kind)` | P; Pr `create_session` creation target for new-Session timers (Agent and prefix known, future ID unknown; ask or indeterminate rejects). On update the probe uses the persisted candidate row, so a plan cannot construct it from the arguments |
| `delete_timer`, `list_timers` | `timer.manage` | P |
| `set_config` | `config.write(target)`; `[secret.use]` derived from the candidate | P; S candidate read as `node:master/read` (phase 2: stage A); R the configuration-lane recheck |
| `explain_tool_authorization` | `config.read(tool-rules)`; `[session.view(probe)]` | P; S policy and candidate reads; S `view_session` of each probed Session other than the caller |
| `add_secret` | `secret.manage(name)`; `[secret.use(name)]` when referenced; with `fromConfig`, `[config.write]` per rewritten configuration file and `[mcp.manage]` per rewritten MCP server | P; S `filePath` read on its Node; S `fromConfig` source reads; S `deleteFile` as `node:edit` with the delete patch on the file's Node |
| `list_secrets` / `list_mcp_servers` | `secret.list` / `mcp.list` | P |
| `mcp_config` | `mcp.manage(server)`, `[secret.use]` | P |
| `mcp_notifications` | `mcp.subscribe(server, action)` | P; R reception recheck |

## Inbound adapter mapping

From phase 3, inbound front ends map through the [adapter](./tool-operation-authorization.md#inbound-mcp-adapter); phase 1 maps none of them and only lists their enforcement sites (coverage item 2). Each external action keeps its current identity and raw arguments and gains these operations:

| Action | Operation |
| --- | --- |
| Session list | `session.list` |
| Session read | `session.view` (canonical ID) |
| Session send | `session.send` (canonical ID) |
| `node list` | `node.list` |
| `node status` | `node.view` of the caller's current Node (Session or inbound selection) |
| `node select` | `node.select`, with the optional `get_default_cwd` sub-request |
| Node tools, exec and exec result | `env.*` |
| pairing | `node.trust` |

## Coverage and conformance

Phase-1 tests, which add no production rejection:

1. **Registration coverage.** Every `ToolRegistry.Entries` item has a declaration, and **Self** is an explicit `None(reason)` naming its owner check. MCP and custom Node identities use the two opaque declarations.
2. **Obligation inventory.** The test enumerates every `AuthorizeToolAsync`, `AuthorizeNodeFileAsync`, `AssessToolAsync` and creation-target call site outside the dispatch gate. Each must map to a declared obligation, and each declared obligation to a call site. Assessments whose outcome is only reported (explain's probe evaluations, `list_secrets` `usable`) are listed as report-only, not as obligations; the gate and its wrappers are listed as plumbing. Inbound MCP checks (`authorization.Require` and `RequireAsync`) are listed separately with the capability each checks, and only the shared assessment, `EffectiveDecision` and the inbound check call the evaluator directly, so a new inbound check or direct evaluator call fails the test. External denials keep the generic `Tool action is not permitted.` with no attribution.
3. **Derivation corpus.** `operation-conformance.json` extends the `ctl` corpus with resolved facts and expected effects, obligations, branches and subsumed work. It contains only supported branches.
4. **Decision equality.** For global, local and external requests, attribution reports the same decision, deciding rule, secret outcome and approval options as the existing evaluator. The corpus includes:
   - correlated delivery: A → A allowed, A → B denied;
   - a conditional ask: ask for `command: safe`, deny otherwise;
   - two single-name secret allows: each name allowed alone, the pair denied;
   - an ordinary exec allow with an unowned secret: denied;
   - script and artifact source-read denials under an allowed primary;
   - a timer allowed with its `create_session` target denied;
   - a cascade allowed for the root with a member denied;
   - an asking default with no approvers;
   - external ask as deny.

Later-phase corpora:

5. **Normalizer parity (phase 3).** Spelling variants and omitted defaults produce the same normalized arguments through direct dispatch, `ctl tool call` and nested ToolScript.
6. **Derivation failure versus handler rejection (phase 3).** Each case expected to fail derivation is also rejected by the handler.
7. **Mixed corpus (phase 3).** The 27 hand-derived mixed cases from the second design review become executable, covering:
   - leg composition and first-match shadowing;
   - raw versus normalized spellings;
   - the original whole-set secret predicate deciding only unwon names;
   - owned, operation and wildcard master-exec fallbacks;
   - approver intersection with asking defaults;
   - local-layer intersection, external denial and the self result.
8. **Branches and visibility (phase 3).** Every branch has an unconditional template unless Self. Fixed `ctl` arguments select at least one branch. Native and search projection keeps noncanonical actions and omitted defaults possible.
9. **Inbound adapter (phase 3).** Each external action has its current identity and raw arguments, its operations and a fixture decision. This includes `node status`, `node select` with `get_default_cwd`, canonical Session IDs, `exec result` re-authorization and ask as deny.

## Phase-1 explanation and attribution

`OperationPlan.Derive` builds the plan from the resolved call, the facts of the probe's own assessment (with its Session target resolved from the catalog when no rule needed it) and in-memory catalog lookups; it never throws, and what it cannot establish goes to `incomplete`. Each probe adds `invocation`, `capability`, `arguments.raw` and `arguments.normalized`, `branch`, `self`, `operations`, `obligations`, `subsumed` and `incomplete`, after the earlier fields (including `changed`), which keep their order; each policy variant adds `obligations` after `facts`, one entry per planned obligation with the existing decision and per-layer rule, or `evaluated: false` with the reason. Obligations the plan cannot construct as a request are never assessed. Each policy variant gets the plan its own assessment's facts give (a candidate policy may allow the read that reveals secret facts); the probe shows the first variant's plan, and a variant whose plan differs carries its own as `plan`, noted in the probe's `incomplete`. Secret facts that could not be established (`AuthorizationAssessment.SecretsUnknown`) are unknown, never an empty set. An obligation is assessed only from facts already admitted: one whose Node target is a Provider Node not yet in the registry, whose path on master the probe's assessment did not resolve, or whose facts exist only at run time is `evaluated: false` with the reason; path facts the probe resolved are reused, not recomputed. Master path inspection follows the same rule: while the probe's own assessment runs, `AuthorizationPaths` records each path it canonicalizes (request paths and policy-selector roots), and while the additions run it answers only from that record, so a path it has not inspected stops the addition as unevaluated instead of being inspected. Any error in an addition is reported as that obligation's reason and never changes or fails the probe. A creation-target entry names, per layer, what its outcome is attributed to (`CreationContribution`s of `EvaluateCreationTargetOutcome`). When the rule (`rule: {index, id}`) or default (`rule: null` with `default`) where traversal stopped gives the outcome itself, the outcome is definite. Otherwise it is conservative (`conservative: true`): `rules` lists, with their actions, the rules (and `default`, the default action) that contributed its deny or ask, which depend on arguments known only when the Session is created; an allowing rule or default is never named. Compact rows list the contributing rule IDs the same way. A compact row leaves the plan out: `toolId` already names the capability, a command probe adds `invocation`, and each variant row adds `obligation` (`id`, `decision`, deciding rule ID or null) for the first check other than the call's own request that denies or is indeterminate, else the first that asks; a row whose other checks all allow, or were not evaluated, has none, so a tool-probe row is unchanged. `OperationAttributionTests.Attribution.cs` checks the attribution text and obligation matching, and `ToolAuthorizationEffectsTests.Operations.cs` drives both through real dispatch and `explain_tool_authorization`. `ToolAuthorizationEffectsTests.OperationBoundaries.cs` covers nested `ctl()` attribution, creation-target rules and external disclosure, and `.OperationFacts.cs` uninspected policy roots and the twelve-case future-Session creation-target matrix; `ProviderFileConsumerTests.OperationExplain.cs` and `NodeFileTransferTests.OperationExplain.cs` cover unadmitted Provider Nodes, per-policy plans and the default-cwd condition. `OperationAttribution.Denial` appends to the existing denial message the deciding rule (position and ID) or default, its layer, the denied obligation with its capability and the call it serves, and the command (`ctl <command>` or the tool name); a ToolScript `ctl()` call that runs as its concrete capability keeps the command path (`TurnToolInvocation.Command`). A refused timer creation target is attributed in the same form: definite outcomes say the rule or default denied it or requires approval for it, conservative ones that the contributing rules may deny it or require approval for it, depending on arguments known only when the Session is created. The scope's primary request (`ToolApprovalScope.Primary`) identifies the call; sub-requests are matched to declared obligations by capability.

## Notes for phase 2

The notes phase 1 found for phase 2, with their resolution, are in [approval staging](./tool-operation-approval-staging.md#catalog-notes).

## Visibility probe sets

These apply from phase 3.

- **Session list.** A row is listed when `session.view`, `session.send`, `session.control {change: stop|rename}`, `history.read` or `task.assign` is possible with the row as `targetSession`. Classes are memoized as today. Operation rules compare canonical IDs: the literals of `targetSession.id` and `parent.id` join the class key and the explicit set, and with an ID pattern the list scans its scope ([cost model](./session-list-visibility.md#cost-model)). Version-1 literal classes are unchanged.
- **Agent list.** A row is listed when `session.create`, `session.manage {change: move}`, `agent.view` or `agent.manage` is possible with the row as `targetAgent`. The structural filters and "owns a listed Session" also apply.
- **Node list.** A Node is listed when an `env.*` template with that Node known is possible: its advertised tools, or read, write and exec when none are advertised. Copy endpoints are the read and write templates. select, inspect and destroy are annotations ([Node list visibility](./node-list-visibility.md)).
- **Help and search.** A `ctl` command selects branches through its fixed arguments, and the parser's raw values are the known raw facts. `tool search` and native declarations use every branch, with raw fields unknown.
