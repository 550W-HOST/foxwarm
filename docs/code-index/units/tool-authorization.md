# Unit: Tool authorization and isolation compatibility

Files: `dotnet/Foxwarm/Tools/Authorization/IsolatedToolCompatibility.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationAuthority.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationEvaluation.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationPolicy.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationToolDefinition.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationYaml.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationYamlGraph.cs`

## Purpose

Loads the authority YAML/graph, evaluates allow/deny effects and path scopes, emits authorization tool definitions, and preserves compatibility with isolated Node/tool policies.

## Stable methods and callers

`ToolAuthorizationAuthority.Load/Reload` parses the canonical authority graph; `ToolAuthorizationPolicy` resolves tool/path/effect matches; `ToolAuthorizationEvaluation` returns the decision, matched rule, scope, and explanation used by `ToolRegistry`/`SessionToolExecutor`; YAML graph types preserve inheritance/agent/tool rule edges. `IsolatedToolCompatibility` translates only the supported remote/isolation shape.

## Contract and side effects

Every executable local/MCP/Node capability enters authorization before dispatch. Rules provide tool authorization, not OS/network sandboxing; a remote Node's protocol capability still requires an allowed Main-side boundary. Deny/ambiguous/invalid graphs fail closed, while read-only definition discovery may report unavailable tools without invoking them.

File transfer consumers retain their actual builtin identities. Copy supplies separate `sourcePath`/`targetPath` facts with each endpoint's Node; Main paths resolve from that Agent directory and remote facts stay unresolved. Copy/image/send do not require additional ordinary Node read/write grants. Remote ToolScript source retains its existing concrete Node read authorization. Isolated copy permits only Main own-Agent paths and its bound/current Node; explicit builtin grants do not bypass Main path, unrelated-Node or destination-Session checks. Canonical consumer contract: [External Node files](./external-node-files.md).

The hidden `node_create_auth_token` builtin uses absolute Main `filePath` facts, including when execution placement is remote. Existing generic path policy and the independent isolated-Agent own-directory boundary apply; an exact builtin grant does not authorize unrelated Main paths or require a remote write grant.

The non-default setter is `set_config` with required `target` (`config`, `models`, or `tool-rules`) and `filePath`. There is no obsolete `set_tool_rules` command alias. Persisted generic policies that explicitly name that removed builtin fail validation with migration guidance toward deliberate `set_config` target restrictions; exact isolated metadata receives explicit migration guidance rather than an unconstrained replacement. The new setter retains the independent isolation/path/authority boundaries.

The captured `${workspace}` base is the configured Agents directory for canonical installs. Retained main-at-workspace callers keep their original policy scope. The isolated-main nested `agents` exclusion applies only to that retained layout, where it protects sibling Agent directories; a canonical main Agent may use an ordinary `main/agents` subdirectory. Generic path rules, physical resolution and isolated own-directory checks remain independent of membership and startup layout.

The [Main browser boundary](./dotnet-main-browser.md#exact-isolated-agent-compatibility) preserves Source's exact isolated master capability opt-in for the five `browse_*` tools only. Generic denial still wins. This includes the raw slash-prefixed screenshot write without ordinary file-path facts; it is not constrained by the normal own-Agent file resolver. Unrelated bound-Node, exec, selection and structural guards remain unchanged.

The hidden Archive message and block tools retain an independent same-Agent read guard for isolated callers, in addition to generic policy. The shared handler resolves live catalog identity and aliases first; absent live membership uses Source's requested-ID Agent fallback. It checks before reading retained Archive data, without hydrating a target owner or requiring its Node to be online. Clear/deletion retain Archive records and do not relax this boundary; an exact capability allow cannot bypass it. Nonisolated callers retain selected-target reads, and missing permitted targets remain pure empty reads.

## Policy selectors and authoritative facts

Version-1 rules accept either legacy `match` or top-level selectors, never both. Omitted IDs become position-based `rule-N` diagnostics. Top-level Session/Node identity selectors use bounded literal `*` patterns; legacy `match.session`, scalar/argument matchers, ordered first-match evaluation and external-default-deny remain unchanged. Node selectors also accept caller-current or exact Provider IDs: native Main is `master`, authenticated native remotes are `authenticated-remote`. The matcher syntax does not create a Provider backend or widen native Node registration.

`ToolAuthorizationNodeEffects.Resolve` registers actual Node effects separately from legacy `TargetNode` and exact caller `CurrentNode`. Node capabilities and file/image delivery contribute one endpoint; copy contributes both; concrete builtin Node select/inspect contributes its argument target. Unrelated Main/MCP tools, arbitrary `nodeId` arguments and the ToolScript VM/source placement do not acquire Node facts. Allow requires all actual endpoints; deny matches any. Unknown builtin endpoint selectors remain conditional in discovery without inventory enumeration. Session and inbound external MCP callers construct facts through their existing authority owners; external contexts never become internal/current-Node principals.

The exact builtin `task` selector may use `args.taskId: {task: {owned: true}}`. `SessionManager.AuthorizeToolAsync` resolves current canonical ownership through `TaskService.OwnerSessionId`/`TaskStore.OwnerSessionId`, then the Session catalog, on each real evaluation. Proposed owner arguments never establish ownership. Missing/unowned/other-owned Tasks and external principals do not match. This optional policy fact does not change shared Task get/description/note authority or introduce a new mutation transaction.

## Tests

`dotnet/Foxwarm.Tests/Tools/ToolAuthorizationEffectsTests.cs`; `ToolAuthorizationPathTests.cs`; `ToolAuthorizationSourceTests.cs` and `.Current.cs` compare normalization, ordered evaluation, visibility, ownership needs and registered effects against frozen actual TypeScript Source. `ToolAuthorizationEffectsTests.Current.cs` exercises real Task authority and direct/resolved/native ToolScript calls. `NodePolicyCliTests.cs` uses an official authenticated CLI client and inbound MCP SDK caller for endpoint policy, copy/image/send, selected versus source Node, exact input cwd and completion ownership. Existing isolation, path, cache and fail-closed tests remain in the same corpus.
