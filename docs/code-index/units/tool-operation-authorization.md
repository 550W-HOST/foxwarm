# Unit: Tool operation authorization

Files: `dotnet/Foxwarm/Tools/Authorization/OperationPlan.cs`, `dotnet/Foxwarm/Tools/Authorization/OperationAttribution.cs`, `dotnet/Foxwarm.Tests/Tools/OperationAttributionTests.cs`, `dotnet/Foxwarm.Tests/Tools/Fixtures/operation-decisions.json`

Secondary files: `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationEvaluation.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationToolDefinition.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Authorization.cs`, `dotnet/Foxwarm/Sessions/SessionManager.AuthorizationExplain.cs`

Operation rules let a tool authorization policy restrict or grant what a call does: read a path on a Node, send to a Session, select a Node. Today a rule can only name the capability that does it. This page owns that design and its delivery phases. Phase 1 (observational) is implemented; later phases are approved design. Declarations, the effect and obligation inventory and the conformance corpora are in the [operation catalog](./tool-operation-catalog.md). The evaluator, layers, secret facts and approvals described as "today" are owned by [tool authorization](./tool-authorization.md) and the [authorization thread](../threads/tool-dispatch-authorization.md).

## Design Decisions

### D-auth-operation-rules-mixed

**User decision (2026-11-15).**
- Version-1 rules stay supported for a long time, and policies are never converted automatically.
- Operation rules are added to existing global policies and Agent-local layers, in the same ordered list and under the same top-down first match. There are no separate documents and no new policy version.
- A rule's kind is decided per rule: a rule with `op` is an operation rule, and every other rule keeps its exact version-1 meaning.

Rationale: existing rules carry whole-call correlations, such as a delivery rule pairing one Node with one Session, that per-operation rules cannot express; translating them would lose them. Operation rules add what version 1 lacks: a grant or restriction across every capability that performs an operation.

### D-auth-operation-self-exempt

**User decision (2026-11-15).** Self-scoped operations are not authorizable. These are operations that act only on the caller's own turn, context, runs, transfers or history images. No rule, generated layer or fail-closed layer denies them.

Structural failures still reject them: an unavailable policy, an invalid creator chain or an unreadable layer.

The [legacy isolation](./isolation-migration.md) contract "not less restricted than its last enforced state" gains the exception "except for self-scoped operations" (**user decision, 2026-11-15**). Its owner is updated when phase 3 ships.

The exemption ships in phase 3, together with the ToolScript model-request gate ([model requests](#model-requests-from-scripts)). Exempting script containers without that gate would open an ungated provider call.

### D-auth-operation-copy-legs

**User decision (2026-11-15).** A copy is authorized as a read of its source and a write of its target. Operation allows for the two legs combine. Joint endpoint constraints remain expressible as version-1 rules on `copy_between_nodes`.

### D-auth-operation-secret-per-name

**User decision (2026-11-15).** `op: secret.use` allows compose per secret name. Two single-name allows together allow a call that uses both names. Version-1 secret rules keep their whole-set meaning, where one rule must cover every unowned secret of the call.

### D-auth-operation-generated-layers

**User decision (2026-11-15).** Unedited generated isolation layers may be regenerated automatically.

This design needs no regeneration: generated layers keep generator 2 and their version-1 rules (engineering choice). Reconciliation stays as [owned by isolation migration](./isolation-migration.md):
- a layer is Main-owned when its stored digest equals the marker's `rulesDigest`;
- it is regenerated when `CurrentDigest` differs from the current plan;
- adding an operation rule counts as an edit.

## Problem

Reproduced at the base commit, through direct dispatch, `ctl tool call` and nested ToolScript:

- **Raw spellings bypass denies.** A deny on builtin `node` `args.action: select` does not stop `"Select"` or `" select"`. Policy matches raw arguments, and the handler lowercases and trims them afterwards.
- **Defaults must be restated.** `session` with no `action` runs status, but an `action: status` rule does not match it.
- **Untyped Node selectors grant management.** `node: X` without a tool scope also allows `node` select and destroy of X, and `send_file` from X to any target.
- **Help filters by capability, not command.** Allowing `node` `action: list` advertises `node destroy`.

The last two are authoring hazards that version 1 can avoid with `tool: {source: node}`. What it cannot express is a compositional grant such as "every read of this resource, by any capability".

## Operations, effects and obligations

An **operation** is an `op` (dotted `family.verb`) with typed resources and declared enum attributes (`with`). The families are `env`, `node`, `session`, `history`, `agent`, `task`, `timer`, `channel`, `user`, `config`, `secret`, `mcp`, `image` and `model`; the [catalog](./tool-operation-catalog.md#operations) defines each op. Each op has one primary resource. A call has two decision domains:
- the **ordinary domain**: every op except `secret.use`;
- the **secret domain**: one `secret.use` per stored secret the call would send to a new destination. These are today's secret facts.

A declaration keeps two lists apart:

- **Physical effects**: the operations the capability performs, after normalization.
- **Authorization obligations**: every policy assessment the invocation must pass today. One effect may carry several obligations. Each obligation is a request with its own identity and raw arguments.

| Obligation kind | Examples | Evaluated as |
| --- | --- | --- |
| **Primary request** | the call's own `ToolAuthorizationRequest` | the call identity, with its effects as operations |
| **Concrete sub-request** | the script file source and artifact file source, each read as `node:read`; `create_session` prompt files as `node:master/read`; the `set_config` candidate; `add_secret` file sources and `deleteFile` (`node:edit` delete patch); compaction plan reads, saves and repair edits; explain policy reads and views of other probed Sessions; the optional `node select` `get_default_cwd` probe | its own identity, with the operations it guards |
| **Policy probe** | a new-Session timer's creation target: a `create_session` probe whose future facts are partly unknown; ask or an indeterminate outcome rejects registration | its own identity under unknown facts, never a match against the timer request |
| **Retained final request** | `node_remove` cascade members, each a clone of the arguments with that member's `nodeId`; the final Node identity of create, ensure and destroy; the detached copy transfer; the configuration-lane recheck; MCP notification reception | the same capability with its own raw arguments and current facts |
| **Nested call** | ToolScript `call_tool`/`ctl()`, timer slices | its own invocation and gate |

The obligation inventory is complete by construction. A coverage test enumerates every `AuthorizeToolAsync`, `AuthorizeNodeFileAsync`, `AssessToolAsync` and creation-target call site outside the dispatch gate, and fails when one has no declared obligation ([catalog coverage](./tool-operation-catalog.md#coverage-and-conformance)).

Subsumed internal work belongs to an effect's purpose and changes no further protected resource. The declaration names it, with no separate check. Examples: the snapshot refresh of `set_agent_inherit`, Task notifications, and the staging of `send_file`.

### Derivation

- **Normalizer.** A pure syntax normalizer canonicalizes actions, applies handler defaults and resolves aliases. Handlers consume its output (phase 3). Version-1 rules always see the original raw `args`; normalization never rewrites them.
- **Effect plan.** From normalized arguments, catalog facts and admitted inputs, the plan lists operations and obligations. It uses the existing fact owners (`ToolAuthorizationNodeEffects`, `WorkspaceTools.AuthorizationFacts`, `CopyAuthorizationPaths`, `MemoryTools.AuthorizationFacts`, `PopulateAuthorizationTargets`, Task authority, `SecretFactsAsync`).
- **Prospective facts** describe rows the call itself creates:
  - a new child: relation `child`, target Agent, placement. The final child ID is bound after allocation, which may add a collision suffix, and checked before creation and attachment;
  - Task assignment to that child;
  - a requested Session in a target Agent;
  - a new Agent as a creator descendant of the caller's Agent;
  - for a new-Session timer, an Agent and prefix with a future unknown ID.

  A fresh Provider create is authorized on its parent and the requested facts, never on a provider-generated ID that does not exist yet.
- **Unresolved resources.** From phase 3, an op whose required resource cannot be established fails derivation. The call is rejected before dispatch with `tool_authorization_unresolved`, and never reaches a default allow. Before phase 3, an incomplete plan is only reported.

### Model requests from scripts

ToolScript `request_model_without_context` calls a configured model directly, not through `call_tool`. From phase 3 it is the operation `model.request(model)`, with the resolved catalog key including the default selection. It is gated at the host call like a nested call: own approval scope, the run's unattended deadline and wait accounting, and never covered by an outer approval. Version-1 rules match it as the invocation that runs the slice: `run_script`, `start_toolscript_run` or `continue_script` with its raw arguments, or `run_script` with a timer's stored script arguments. Policies that deny that invocation therefore keep denying model requests.

## Evaluation

This section applies from phase 3. Until then the existing evaluator decides every request.

Each obligation request is evaluated per layer:

1. **Self.** A call with no ordinary operations and no secret names is not assessed (see the self-exempt decision).
2. **Ordinary domain.** Each ordinary operation is decided by the first enabled rule that is one of:
   - a version-1 rule without `secrets` whose whole-call predicate matches the request. This covers raw arguments, path all/any and Node endpoint "allow covers every endpoint, deny matches any";
   - an operation rule whose `op`, caller and resource selectors match the operation.

   With no match, the global policy applies `defaultAction` (deny for external principals), and an Agent-local layer passes.
3. **Secret domain** (internal principals). Each name is decided by the first enabled rule that is one of:
   - a version-1 `secrets` rule whose whole-set predicate matches the request and the **original complete** secret set. It decides only names without an earlier winner;
   - an operation rule naming `secret.use` exactly whose `secret` selector covers the name. `*` and family patterns never include `secret.use`.

   With no match:
   - an owned name is allowed;
   - an unowned name takes today's fallback: the decision for a synthetic unrestricted master exec. That decision comes from the first version-1 rule without `args` or `path`, or from an `env.exec` operation rule whose only conditions are callers and a `node` covering master. A rule with a path, argument, opaque-tool or other resource condition never establishes the fallback. An `op: "*"` grant of master exec does, by design, and explain shows that winner.
4. **Layer effect.** The strictest decision over all operations and names: deny, then ask, then allow. Layers combine as today.

**Approval options** come from the asking rules across every obligation, operation and layer, deduplicated by layer and rule: shortest timeout, intersection of approvers. An asking default is a rule-less entry with no named approvers. It is never dropped by deduplication, so a call it asks for can only be approved by the administrator, as today. Any deny prevents an approval request.

For layers containing only version-1 rules, every operation of a request stops at the same rule. The decision, deciding rule and approval options therefore equal today's ([version-1 exactness corpus](./tool-operation-catalog.md#coverage-and-conformance)).

Ordering among mixed rules is first match, never deny-wins:
- an operation deny placed below a broad version-1 allow is unreached for the calls that allow matches;
- an operation allow below a terminal deny grants nothing;
- a version-1 raw `action: select` deny keeps its raw meaning, so closing the spelling bypass needs `op: node.select` deny above it.

## Approval staging

This section applies from phase 2. Today a grant is bound to the fingerprint of the primary request. `ToolApprovalScope.Covers` compares the fingerprint only for that object. Every other check in the invocation, including detached work entered through `Detach`, is covered without comparison. Without a grant, an internal ask fails closed.

- **A. Protected inputs.** These are inputs that must be read before planning: the `set_config` candidate, explain policy and candidate files, `add_secret` sources and compaction plan files. They are assessed as their concrete sub-requests.
  - A deny stops the call.
  - Asks produce one input approval.
  - Admitted bytes are captured, and the effect consumes them. A required re-read with a different digest fails the call.
- **B. Plan assessment.** The plan is derived from normalized arguments, prospective facts and admitted inputs. Every obligation with known facts is assessed: the primary request, concrete sub-requests, policy probes, and retained final requests such as each cascade member.
  - One call approval lists every asking obligation and operation.
  - Its fingerprint binds the identities, raw and normalized arguments, operations and input digests.
- **C. Final requests.** Each owner boundary re-evaluates its retained requests against **current policy and current facts**, inside the existing registry, configuration and timer lanes. The grant is consulted only when that evaluation asks. It covers the ask only if B approved an identical request: same identity, raw arguments and facts.
  - A deny always stops, including a deny installed while the call waited.
  - A new or changed ask fails closed with `tool_approval_unavailable`, before the protected effect.
  - An unchanged operation never short-cuts current-policy evaluation. Effects that already completed are not rolled back.

Nested calls keep their own gates, and external principals cannot be asked, as today. Answer-time storage of an `ask_user` secret happens after the invocation, carries no tool approval scope, and keeps the existing rules for filling configured names.

## Visibility

This section applies from phase 3. Each declaration has **action branches**: the normalized constraints that select a branch, plus its operation templates. A template is unconditional or conditional, and its resources are known or unknown.

- A branch is possible when every unconditional template is possible in every layer. A capability is visible when any branch is possible. Conditional templates never hide a branch.
- **Raw facts are kept apart from branch constraints.** Version-1 rules are walked with today's `Visible` logic, against only the raw arguments an actual command supplies. `ctl session status` supplies `action: status`. Native declarations and `tool search` supply none, so every spelling- or default-sensitive raw field stays unknown there. Operation templates use the normalized branch constraints.
- For version-1-only policies, capability-level projection equals today's. Command-level help equals today's `Visible` with the command's fixed raw arguments, which is the help fix.
- Default declarations keep their fixed order and contract ([D-tools-node-independent-default-declarations](./tools-registry.md#d-tools-node-independent-default-declarations)). Their inputs are persisted policy and process-fixed definitions, never the current Node, Node inventory, connectivity or cwd. Help, explain and approval output are tool results. No operation content is added to requests, so request-prefix stability is unchanged.

## Explanation and denials

Phase 1:
- `config explain-auth` probes may be given as a `command` with `values`, resolved by the `ctl` parser.
- Each probe reports its invocation, capability, raw and normalized arguments, operations, obligations and, per obligation and policy, the existing decision, rule and layer; gaps are `incomplete`.
- Denials name the denied obligation, its rule, the capability and the command.
- Explanation adds no work to the probe's own assessment (no Provider discovery, path inspection or file reads); an obligation needing it is unevaluated ([fields](./tool-operation-catalog.md#phase-1-explanation-and-attribution)).

Phase 3:
- per operation, `{decision, rule, position, ruleKind}`, with version-1 winners marked `whole-call`;
- unreached rules;
- per-name secret decisions with `owned` or `fallback`;
- the `self` result;
- compare inputs: `layers: [{agent, filePath}]` for candidate Agent-local layers, and `external: [{externalId, …}]` for inbound identities.

Probes run at existing Sessions or external identities only.

## Inbound MCP adapter

Phase 3; phase 1 only inventories inbound enforcement sites. Inbound front ends build requests through `McpExternalAuthorization.Request`, not `ToolRegistry.Resolve`. An adapter keeps each external action's current identity and raw arguments and adds its operations ([adapter mapping](./tool-operation-catalog.md#inbound-adapter-mapping)), including the external-only `node status` as `node.view` of the selected Node. As today, ask is a deny, Session relations and Agent path variables never match, and Session IDs are canonical.

## Policy format and older readers

Operation rules are marked only by `op`, and the policy version stays 1. The maintained C# global and local parsers and the retained TypeScript parser reject `op` with `Unsupported policy field`, including on disabled rules. An older binary therefore makes the global policy unavailable, or refuses the affected Agent's layer. Agent-local layers stay JSON arrays.

Every catalog write that stores an operation rule first raises `installation.json` `minimumReaderVersion` to 2. This covers `set_agent_rules`, `create_agent` with initial rules and administrator routes. A failed marker write prevents the layer write. A later metadata failure may leave the higher marker. Raw external edits get no marker update, and older parsers still fail them closed. Rejection is tested for each frozen release that is declared downgrade-supported.

Selectors are listed in the [catalog](./tool-operation-catalog.md#selectors) and validated against the declarations at load. There is no `via` or `peer`: name-coupled and joint constraints are version-1 rules.

## Adoption

Adding an operation rule is an ordered edit. Before installation, explain compare shows the changed decisions, the rules the new rule shadows and the rules that shadow it. For a generated layer, insert exceptions before its terminal deny. A raw edit that appends after the deny leaves the layer without a terminal deny, and the existing safeguard fails it closed.

An optional converter (phase 4) may suggest operation rules. It converts exactly by default, and only when the rule's parsed tool selector matches exactly the capabilities that perform the op and every condition maps to that op's resources. Example: `tool: {source: builtin, name: node}` with `args: {action: select}` becomes `op: node.select`. A scalar such as `tool: builtin:node` is a literal tool name, not a source qualifier. Exact conversions report only normalization and canonical-ID differences.

The converter keeps the following as version-1 rules:
- correlated rules;
- rules with untranslatable conditions;
- dormant names;
- secret rules, unless per-name composition is requested.

It never widens an ask. A result over 256 rules or 256 KiB is a blocker, with no candidate produced. Templates keep their version-1 rules, and their `wait`/`submit_compact_plan` entries become inert once the exemption ships.

The only phase-3 change to generated-layer decisions is artifact `get`, which becomes self-scoped. Generated layers already allow every other self capability. Fail-closed layers newly allow every self capability; their obligations, nested calls and model requests stay denied.

## Delivery phases

| Phase | Scope | Behavior change |
| --- | --- | --- |
| **1. Observational** | Declarations, effect plans, obligation inventory and branches as metadata. Explain additions and denial attribution. Coverage tests. | None. The existing evaluator, assessment sequence, guards, approval scope, visibility, self restrictions and grammar stay authoritative. The plan cannot authorize, deny or read. |
| **2. Planning and staged approvals** | Protected-input capture, stages A–C, retained obligations, under version-1 rules | When input and sub-call asks can be answered. Changed final asks fail closed. |
| **3. Operation rules** | Parsing and writing `op` rules, reader marker 2, two-domain evaluator, handler-consumed normalizer, self exemption with the `model.request` gate, fail-closed derivation and mandatory declarations, operation-aware visibility | Operation rules, self exemption, unresolved rejection, per-command help |
| **4. Authoring aids** | Placement diagnostics and the optional converter | None to stored policies |

Acceptance tests by phase:

1. **Phase 1.**
   - Decisions, deciding rules, secret outcomes and approval options equal the existing evaluator for global, local and external requests.
   - Denied calls gain no protected effects, approvals or policy reads, and successful calls still succeed.
   - Script and artifact source reads, timer creation probes, cascade members, prompt files and compaction sub-calls appear as separate obligations.
   - Malformed and unresolved calls behave as before, and serialized default declarations are unchanged.
   - Coverage and classification tests add no production rejection.
2. **Phase 2.**
   - An asking candidate read followed by a discovered secret ask produces two approvals with the correct approver intersection. A denied read prevents derivation.
   - Changed candidate bytes, destination secrets, timer candidates or allocated child IDs are stopped at their boundary, with no unapproved effect.
   - A deny installed during approval stops execution. Cascade members keep their own outcomes.
   - Detached copies and MCP reception carry only the admitted plan. Nested calls stay separate.
   - Foreground, timer and webhook waits keep their deadlines, stop behavior and wait accounting.
3. **Phase 3.**
   - The version-1 corpus is unchanged except for the scheduled changes, and every obligation still runs.
   - The mixed corpus passes: original whole-set secret matching, owned and operation fallbacks, defaults, approver intersection, external denial.
   - Marker-before-metadata interruption tests cover the setter, creation with rules and administrator writes. Supported older readers reject `op`.
   - Self calls pass valid deny layers, and structural failures still reject. Script model requests stay denied where the slice identity is denied.
   - Generated-layer reconciliation and terminal-deny rules are preserved.
   - Native and search projection stays conservative for raw spellings, fixed commands narrow, and Node placement leaves serialized prefixes unchanged.
4. **Phase 4.**
   - Correlated, untranslatable, dormant and secret rules are retained, and asks are never widened.
   - Source selectors are parsed correctly, and overflow blocks without producing a candidate.
   - Normalization and composition differences are labeled, and unchanged rules are preserved on write.

## Tests

Phase 1 adds `OperationAttributionTests` (attribution and decision equality) and the [catalog coverage tests](./tool-operation-catalog.md#coverage-and-conformance).

## Open Questions

- Unconfirmed: whether a version-1 `ask` on a script invocation should ask again for each `model.request` (phase 3), or once per slice.
- Unconfirmed: whether templates gain operation rules, for example `op: node.select` deny for restricted workers, once phase 3 ships.
