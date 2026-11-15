# Unit: Tool operation rules

Files: `dotnet/Foxwarm/Tools/Authorization/OperationRules.cs`, `dotnet/Foxwarm/Tools/Authorization/OperationEvaluation.cs`, `dotnet/Foxwarm/Sessions/SessionManager.OperationRules.cs`, `dotnet/Foxwarm.Tests/Tools/OperationRulesTests.cs`, `dotnet/Foxwarm.Tests/Tools/OperationRulesTests.MixedCorpus.cs`, `dotnet/Foxwarm.Tests/Tools/ToolAuthorizationEffectsTests.OperationRules.cs`, `dotnet/Foxwarm.Tests/Tools/ToolAuthorizationEffectsTests.Version1Equality.cs`, `dotnet/Foxwarm.Tests/Tools/Fixtures/version1-equality.json`, `dotnet/Foxwarm.Tests/Mcp/InboundMcpOperationRulesTests.cs`

Secondary files: `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationPolicy.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationYaml.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationEvaluation.cs`, `dotnet/Foxwarm/Tools/Authorization/OperationPlan.cs`, `dotnet/Foxwarm/Sessions/SessionManager.NodeVisibility.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.ToolScript.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Migration.cs`

Phase 3 of [tool operation authorization](./tool-operation-authorization.md): rules with `op` in the same ordered lists as version-1 rules, the two-domain evaluator, the self exemption, the ToolScript model-request gate, unresolved rejection, operation-aware visibility and the reader marker. Decisions, derivation, explanation, the inbound adapter, adoption and phases are owned by the design unit; operations, selectors and capabilities by the [catalog](./tool-operation-catalog.md).

## Grammar

A rule is an operation rule exactly when it has `op`; every other rule keeps its version-1 meaning. Operation rules accept `id`, `enabled`, `action`, `reason`, `approval` and the [catalog selectors](./tool-operation-catalog.md#selectors); version-1 fields (`tool`, `args`, `match`, `secrets`, `targetNode`) are unsupported fields on them. `OperationRules.Normalize` stores `op` as a list, the caller selectors under `match` (as version-1 rules store them, so caller matching is shared), resource selectors under `resources` and attributes under `with`. Load-time validation, against `OperationDeclarations.Operations`:

- unknown ops and families fail;
- each explicitly listed op must declare every resource and `with` attribute the rule uses; a pattern must cover at least one op that declares them all;
- `secret.use` stands alone, and `secret` applies only to `secret.use` and `secret.manage`;
- `ask` cannot select `externalId`, and `secret.use` rules cannot select external callers (as version-1 `secrets` rules);
- Agent-local layers reject caller selectors on either kind (`AgentRulePolicy`).

The policy version stays 1 and Agent-local layers stay JSON arrays. `ToolAuthorizationPolicy.HasOperationRules` (any rule with `op`, disabled ones included) selects the evaluator.

## Evaluation

A layer without operation rules is decided by the version-1 evaluator exactly as before. A layer with one is decided by `OperationEvaluation.Evaluate`:

1. **Self.** `AssessToolAsync` does not evaluate a call whose branch is Self (`OperationPlan.SelfReason`): every layer returns allow, and the assessment carries `Self`. The global policy is still loaded and `EffectiveLayers` still reads the creator chain and every layer, so an unavailable policy, an invalid chain or an unreadable layer rejects it. Operations a host call states (a model request) are never Self.
2. **Ordinary domain.** The request's operations come from the assessment (`SessionManager.AuthorizationOperations`, derived once when some layer has operation rules) or, for inbound and visibility requests, from the request itself. Each operation is decided by the first enabled rule that is a version-1 rule without `secrets` matching the whole call (`ToolAuthorizationEvaluation.MatchesCall`), or an operation rule whose `op`, caller and resource selectors match the operation (`OperationRules.Match`). With no match, the layer's default applies (`defaultAction` for the global policy, deny for external principals; an Agent-local layer passes).
3. **Secret domain** (internal principals). Each name is decided by the first enabled rule that is a version-1 `secrets` rule whose whole-set predicate matches the original complete set (`MatchesSecrets`), or an operation rule naming `secret.use` whose `secret` selector covers the name. Otherwise an owned name is allowed, and an unowned one takes the unrestricted master exec fallback: the first version-1 rule without `args` or `path` matching exec on master, or the first `env.exec` operation rule with no `with` and no resource other than a `node` covering master; else the default.
4. **Layer effect.** The strictest over operations and names. The decision keeps `Operations` (per operation: effect, rule, `Unresolved`, later matching rules as `Unreached`), `SecretNames`, `Call`, `Secrets` and `Asking` (every asking rule once, a rule-less entry for an asking default), from which approval options are combined as before.

### Unresolved operations

Derivation keeps what it cannot establish instead of dropping it: a template whose condition or per-item facts are unknown yields its op with every resource null, and a call without a declared branch (or whose arguments fail normalization) yields one underivable stand-in. Facts operation rules read beyond the request (`AuthorizationOperation`): the resolved target and parent Sessions, Agent creator ancestry, Task owner and creator, and secret ownership, from catalog and store lookups only. In a layer with operation rules, an operation rule whose tested resource or attribute is unknown decides deny, and an operation with an unknown resource never reaches the default; a version-1 rule matching the whole call still decides it. The denial is `ToolAuthorizationUnresolvedException` (`tool_authorization_unresolved`), raised by the gate before dispatch; activity records count it as denied. Version-1-only layers never reject for unresolved facts. Inbound requests have no Session target fact; the adapter passes canonical Session IDs, which `target-session` then uses.

### Prospective Sessions

`targetSession` of a Session the call creates is a prospective marker. An `id` selector covers every ID it could receive for a deny or ask and none for an allow; `self` never matches; `sameAgent` matches when its target Agent is the caller's; `relation: child` matches only a child the call creates. The timer creation-target probe evaluates `session.create(kind: timer)` with the target Agent known and Node, parent, placement and runtime unknown; an operation rule that reaches an unknown is conditional, as version-1 rules are there.

## Model requests

`request_model_without_context` resolves its catalog key (the named model, else the Session's selection when cataloged, else the default; an unknown name is authorized under that name, then fails) and is gated at the host call (`AuthorizeModelRequestAsync`) as the invocation that runs the slice (`TurnToolInvocation.Resolved`, the call the dispatch gate authorized), with the stated operation `model.request(model)`. The gate has its own approval scope with the slice as primary, keeps the run's deadline and wait accounting, and is never covered by an outer approval, except as the [ask-once decision](./tool-operation-authorization.md#d-auth-operation-script-ask-once) requires: when every asking rule is a version-1 rule, an approval of the slice's invocation (its fingerprint without operations), or of an earlier model request of the slice, answers the ask. An operation `ask` on `model.request` asks for each request. Any deny always applies. The fingerprint binds the stated operation. Its obligation is `model-request` (retained, the same capability) in the [catalog](./tool-operation-catalog.md).

## Visibility

`ToolAuthorizationEvaluation.Visible` keeps its version-1 walk for layers without operation rules. For a layer with them, `OperationEvaluation.Visible` enumerates the declaration's branches (`OperationPlan.BranchOperations`; only the known action selects them) and shows the capability when some branch has every unconditional operation possible; a Self branch is always possible, so `ToolVisible` lists any capability that can take one when the caller's layers are valid. Version-1 rules are walked with the raw arguments the caller states; operation rules see the operation's known resources, and an unknown one leaves the rule conditional. Each layer is projected separately (`ToolVisibilityContext.Policies.All`), so two layers may each admit a different branch; the design states one branch possible in every layer, and this projection only lists more.

- **Commands.** `ctl` help passes a command's fixed arguments as known raw facts (`fixedArgs`), so a command is listed only when its capability might be allowed with them. This is the help fix and applies to version-1 policies too. Native declarations and `tool search` pass none.
- **Request-prefix stability.** In declarations, a builtin capability's `node` resources are always unknown, so a Node-scoped operation rule never hides a builtin and default declarations do not depend on the current Node, Node inventory or placement. Only a Node tool listed for an explicit Node knows its Node.
- **Probe sets.** Session, Agent and Node lists keep their tool-based probes; under operation rules those probes are decided through their operations.

## Reader marker

`AgentCatalog.RequiredReaderLevel` is 2 when any Agent row's stored `rules` contain an operation rule, and `ReaderVersion` is 2. Every catalog index write raises `installation.json` `minimumReaderVersion` first (`EnsureReaderVersion` in `AtomicIndexWrite`), which covers `set_agent_rules`, `create_agent` with initial rules and the administrator routes. A failed marker write prevents the metadata write; a later metadata failure leaves the higher marker. Older readers reject `op`: the phase-2 C# global YAML reader with `Unknown or oversized policy mapping.`, its Agent-local reader with `Unsupported policy field.`, and the retained TypeScript reader with `unsupported field: op`, including on disabled rules.

## Generated layers

Generated layers keep generator 2 and their version-1 rules. Adding an operation rule changes the stored digest, so the layer counts as edited. `IsolationMigrationRules.EndsInDeny` never accepts an operation rule as the terminal deny, so an op rule appended after it leaves the layer without one and the existing safeguard fails it closed.

## Tests

- `OperationRulesTests`: grammar and validation, first match among mixed rules, spelling and default bypasses, legs, secret composition and fallbacks, approval options, external principals, unresolved operations, version-1 exactness of the two-domain path, builtin projection independent of the current Node, branch templates and terminal deny. `.MixedCorpus.cs` evaluates global and local layers together.
- `ToolAuthorizationEffectsTests.OperationRules.cs`: self calls and structural failures, the model-request gate and ask-once, real calls with attribution, help, staging and explain, unresolved rejection, derivation failures the handler also rejects, and marker ordering for the setter, creation and administrator writes.
- `ToolAuthorizationEffectsTests.Version1Equality.cs`: real calls, visibility and help under version-1 policies against outcomes recorded at the phase-2 base; `version1-equality.json` lists each scheduled change with its reason.
- `InboundMcpOperationRulesTests`: external actions under operation rules keep the fixed denial.
