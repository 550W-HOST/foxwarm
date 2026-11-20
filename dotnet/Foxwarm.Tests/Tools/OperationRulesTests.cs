using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Operation rules (operation authorization phase 3): grammar, the two-domain evaluator, first
// match among mixed rules, secret composition and fallbacks, approval options, external
// principals and unresolved operations. Pure evaluator tests over synthetic requests.
public sealed partial class OperationRulesTests
{
    private static ToolAuthorizationPolicy Yaml(string text) =>
        ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes("version: 1\n" + text));

    private static JsonObject Obj(string value) => JsonNode.Parse(value)!.AsObject();

    private static ToolAuthorizationRequest Request(
        string source,
        string name,
        string args = "{}",
        string principal = "internal",
        IReadOnlyList<string>? secrets = null,
        IReadOnlyList<string>? owned = null,
        IReadOnlyList<AuthorizationPath>? paths = null,
        string? targetNode = "master",
        AuthorizationTarget? target = null
    ) =>
        new(
            source,
            name,
            null,
            Obj(args),
            paths ?? [],
            principal == "internal" ? "alpha" : null,
            principal == "internal" ? "alpha-main" : null,
            targetNode,
            "/synthetic",
            "/synthetic/alpha",
            "/synthetic/alpha/memory",
            SessionTarget: target,
            Principal: principal,
            ExternalId: principal == "external" ? "remote" : null,
            NodeTargets: targetNode is null ? null : [targetNode],
            CurrentNode: "master",
            Secrets: secrets,
            OwnedSecrets: owned
        );

    private static AuthorizationDecision Decide(ToolAuthorizationPolicy policy, ToolAuthorizationRequest request) =>
        ToolAuthorizationEvaluation.Evaluate(policy, request);

    private static string? RuleId(AuthorizationDecision decision) =>
        decision.Rule?["id"]?.GetValue<string>();

    [Fact]
    public void Op_rules_parse_beside_version1_rules_and_validate_against_declarations()
    {
        var policy = Yaml(
            """
            rules:
            - {id: no-select, op: node.select, action: deny}
            - {id: reads, op: [env.read], node: {exact: master}, path: {within: "${workspace}"}, action: allow}
            - {id: v1, tool: {source: builtin, name: node}, action: allow}
            - {id: secrets, op: secret.use, secret: {anyOf: [api-*]}, action: allow}
            - {id: family, op: "session.*", targetSession: {session: {self: true}}, action: allow}
            """
        );
        Assert.True(policy.HasOperationRules);
        Assert.False(Yaml("rules:\n- {id: v1, tool: {source: builtin, name: node}, action: deny}\n").HasOperationRules);
        var rules = policy.Value["rules"]!.AsArray();
        Assert.Equal("""["node.select"]""", rules[0]!["op"]!.ToJsonString());
        Assert.Equal("master", rules[1]!["resources"]!["node"]!["exact"]!.GetValue<string>());

        foreach (
            var (text, message) in new[]
            {
                ("- {op: node.teleport, action: deny}", "unknown operation `node.teleport`"),
                ("- {op: node.select, path: {within: /x}, action: deny}", "operation `node.select` has no `path` resource"),
                ("- {op: [secret.use, env.read], action: deny}", "`secret.use` must be the only operation"),
                ("- {op: node.lifecycle, with: {kind: x}, action: deny}", "has no `with.kind` attribute"),
                ("- {op: \"task.*\", path: {within: /x}, action: deny}", "no operation of `task.*` declares every selector"),
                ("- {op: node.select, tool: {source: builtin}, action: deny}", "Unknown or oversized policy mapping"),
                ("- {op: node.select, externalId: remote, action: ask}", "cannot select external callers"),
                ("- {op: secret.use, externalId: remote, action: deny}", "Secrets selectors cannot select external callers"),
                ("- {op: node.select, action: allow, approval: {timeoutSeconds: 60}}", "approval options require action ask"),
            }
        )
        {
            var error = Assert.Throws<InvalidDataException>(() => Yaml("rules:\n" + text + "\n"));
            Assert.Contains(message, error.Message);
        }
        // Agent-local layers are JSON; a version-1 selector on an op rule is an unsupported field.
        Assert.Contains(
            "Unsupported policy field",
            Assert.Throws<InvalidDataException>(() =>
                AgentRulePolicy.Parse(JsonNode.Parse("""[{"op":"node.select","tool":"node","action":"deny"}]"""))
            ).Message
        );
    }

    [Fact]
    public void Deny_and_ask_rules_naming_only_self_scoped_builtins_load_with_a_warning()
    {
        var policy = Yaml(
            """
            rules:
            - {id: no-crop, tool: {source: builtin, name: [image_crop, node]}, action: deny}
            - {id: ask-runs, tool: {name: {oneOf: [list_toolscript_runs]}}, action: ask}
            - {id: allow-wait, tool: {source: builtin, name: wait}, action: allow}
            - {id: scripts, tool: {source: builtin, name: run_script}, action: deny}
            - {id: node-wait, tool: {source: node, name: wait}, action: deny}
            """
        );
        Assert.Equal(2, policy.Warnings.Count);
        Assert.Contains(policy.Warnings, warning => warning.Contains("`no-crop`") && warning.Contains("image_crop"));
        Assert.DoesNotContain(policy.Warnings, warning => warning.Contains("builtin `node`"));
        Assert.Contains(policy.Warnings, warning => warning.Contains("`ask-runs`") && warning.Contains("list_toolscript_runs"));
        // The rule still loads and keeps deciding the capabilities it can decide.
        Assert.Equal("no-crop", RuleId(Decide(policy, Request("builtin", "node", """{"action":"list"}"""))));
        var layer = AgentRulePolicy.Parse(
            JsonNode.Parse("""[{"id":"no-wait","tool":{"source":"builtin","name":"wait"},"action":"deny"}]""")
        );
        Assert.Contains(layer.Warnings, warning => warning.Contains("`no-wait`") && warning.Contains("wait"));
    }

    [Fact]
    public void Agent_local_layers_accept_op_rules_as_json_arrays()
    {
        var layer = AgentRulePolicy.Parse(
            JsonNode.Parse("""[{"id":"no-select","op":"node.select","action":"deny"},{"id":"rest","tool":{"source":"builtin","name":"node"},"action":"allow"}]""")
        );
        Assert.True(layer.HasOperationRules);
        var decision = Decide(layer, Request("builtin", "node", """{"action":" Select","nodeId":"master"}"""));
        Assert.Equal(ToolAuthorizationEffect.Deny, decision.Effect);
        Assert.Equal("no-select", RuleId(decision));
    }

    [Fact]
    public void An_op_deny_closes_raw_spelling_and_default_bypasses_a_version1_deny_leaves_open()
    {
        var version1 = Yaml("rules:\n- {id: raw, tool: {source: builtin, name: node}, args: {action: {equals: select}}, action: deny}\n");
        var operation = Yaml("rules:\n- {id: op, op: node.select, action: deny}\n");
        foreach (var spelling in new[] { "select", "Select", " select" })
        {
            var request = Request("builtin", "node", $$"""{"action":"{{spelling}}","nodeId":"master"}""");
            Assert.Equal(
                spelling == "select" ? ToolAuthorizationEffect.Deny : ToolAuthorizationEffect.Allow,
                Decide(version1, request).Effect
            );
            Assert.Equal(ToolAuthorizationEffect.Deny, Decide(operation, request).Effect);
        }
        // `session` with no action runs status: the op rule matches the handler default.
        var target = new AuthorizationTarget("alpha-main", "alpha", null);
        var status = Yaml("rules:\n- {id: no-status, op: session.view, action: deny}\n");
        Assert.Equal(
            ToolAuthorizationEffect.Deny,
            Decide(status, Request("builtin", "session", "{}", target: target)).Effect
        );
        Assert.Equal(
            ToolAuthorizationEffect.Allow,
            Decide(Yaml("rules:\n- {id: s, tool: {source: builtin, name: session}, args: {action: {equals: status}}, action: deny}\n"), Request("builtin", "session", "{}", target: target)).Effect
        );
    }

    [Fact]
    public void Mixed_rules_are_first_match_never_deny_wins()
    {
        var request = Request("builtin", "node", """{"action":"select","nodeId":"master"}""");
        // A broad version-1 allow above an op deny wins; the deny is reported unreached.
        var allowFirst = Yaml(
            "rules:\n- {id: v1-allow, tool: {source: builtin, name: node}, action: allow}\n- {id: op-deny, op: node.select, action: deny}\n"
        );
        var decision = Decide(allowFirst, request);
        Assert.Equal(ToolAuthorizationEffect.Allow, decision.Effect);
        var only = Assert.Single(decision.Operations!);
        Assert.Equal("v1-allow", only.Rule!["id"]!.GetValue<string>());
        Assert.Equal("op-deny", Assert.Single(only.Unreached)["id"]!.GetValue<string>());
        // The op deny placed first wins.
        var denyFirst = Yaml(
            "rules:\n- {id: op-deny, op: node.select, action: deny}\n- {id: v1-allow, tool: {source: builtin, name: node}, action: allow}\n"
        );
        Assert.Equal("op-deny", RuleId(Decide(denyFirst, request)));
        // An op allow below a terminal deny grants nothing.
        var terminal = Yaml(
            "defaultAction: allow\nrules:\n- {id: all, action: deny}\n- {id: op-allow, op: node.select, action: allow}\n"
        );
        Assert.Equal("all", RuleId(Decide(terminal, request)));
    }

    [Fact]
    public void Each_ordinary_operation_is_decided_separately_with_the_strictest_layer_effect()
    {
        // copy: a read of the source and a write of the target; operation allows combine.
        var paths = new[]
        {
            new AuthorizationPath("sourcePath", "in.txt", "/synthetic/in.txt"),
            new AuthorizationPath("targetPath", "out.txt", "/synthetic/out.txt"),
        };
        var copy = Request(
            "builtin",
            "copy_between_nodes",
            """{"sourceNode":"master","sourcePath":"in.txt","targetNode":"master","targetPath":"out.txt"}""",
            paths: paths
        );
        var policy = Yaml(
            "defaultAction: deny\nrules:\n- {id: reads, op: env.read, path: {within: /synthetic}, action: allow}\n- {id: writes, op: env.write, path: {within: /synthetic}, action: allow}\n"
        );
        var decision = Decide(policy, copy);
        Assert.Equal(ToolAuthorizationEffect.Allow, decision.Effect);
        Assert.Equal(["reads", "writes"], decision.Operations!.Select(item => item.Rule!["id"]!.GetValue<string>()));
        // Without the write grant, the default denies the write leg only.
        var readOnly = Yaml("defaultAction: deny\nrules:\n- {id: reads, op: env.read, path: {within: /synthetic}, action: allow}\n");
        decision = Decide(readOnly, copy);
        Assert.Equal(ToolAuthorizationEffect.Deny, decision.Effect);
        Assert.Null(decision.Rule);
        Assert.Equal(ToolAuthorizationEffect.Allow, decision.Operations![0].Effect);
        Assert.Equal(ToolAuthorizationEffect.Deny, decision.Operations[1].Effect);
        // An Agent-local layer passes what no rule matches.
        var local = AgentRulePolicy.Parse(JsonNode.Parse("""[{"id":"reads","op":"env.read","action":"allow"}]"""));
        Assert.Equal(ToolAuthorizationEffect.Allow, Decide(local, copy).Effect);
    }

    [Fact]
    public void Secret_domain_keeps_whole_set_version1_matching_and_composes_op_grants_per_name()
    {
        var exec = Request("node", "exec", """{"command":"true"}""", secrets: ["api-a", "api-b"], owned: []);
        // Two single-name op allows together allow a call that uses both names.
        var perName = Yaml(
            "defaultAction: deny\nrules:\n- {id: exec, tool: {source: node, name: exec}, action: allow}\n- {id: a, op: secret.use, secret: {anyOf: api-a}, action: allow}\n- {id: b, op: secret.use, secret: {anyOf: api-b}, action: allow}\n"
        );
        var decision = Decide(perName, exec);
        Assert.Equal(ToolAuthorizationEffect.Allow, decision.Effect);
        Assert.Equal(["a", "b"], decision.SecretNames!.Select(item => item.Rule!["id"]!.GetValue<string>()));
        // A version-1 secrets allow must cover the original complete set: one name is not enough,
        // so the unmatched name falls to the unrestricted master exec fallback (here: default deny).
        var wholeSet = Yaml(
            "defaultAction: deny\nrules:\n- {id: exec, tool: {source: node, name: exec}, args: {command: {equals: \"true\"}}, action: allow}\n- {id: v1-a, tool: {source: node, name: exec}, secrets: {anyOf: api-a}, action: allow}\n- {id: b, op: secret.use, secret: {anyOf: api-b}, action: allow}\n"
        );
        decision = Decide(wholeSet, exec);
        var names = decision.SecretNames!.ToDictionary(item => item.Name);
        Assert.NotNull(names["api-a"].Fallback);
        Assert.Equal(ToolAuthorizationEffect.Deny, names["api-a"].Effect);
        Assert.Equal("b", names["api-b"].Rule!["id"]!.GetValue<string>());
        Assert.Equal(ToolAuthorizationEffect.Deny, decision.Effect);
        // A version-1 secrets rule matching the whole set decides every name without an earlier
        // winner.
        var v1Covers = Yaml(
            "defaultAction: deny\nrules:\n- {id: exec, tool: {source: node, name: exec}, args: {command: {equals: \"true\"}}, action: allow}\n- {id: a, op: secret.use, secret: {anyOf: api-a}, action: ask}\n- {id: v1-all, tool: {source: node, name: exec}, secrets: {anyOf: \"api-*\"}, action: allow}\n"
        );
        decision = Decide(v1Covers, exec);
        names = decision.SecretNames!.ToDictionary(item => item.Name);
        Assert.Equal("a", names["api-a"].Rule!["id"]!.GetValue<string>());
        Assert.Equal("v1-all", names["api-b"].Rule!["id"]!.GetValue<string>());
        Assert.Equal(ToolAuthorizationEffect.Ask, decision.Effect);
        // Patterns never include secret.use.
        var star = Yaml("defaultAction: deny\nrules:\n- {id: exec, tool: {source: node, name: exec}, args: {command: {equals: \"true\"}}, action: allow}\n- {id: star, op: \"*\", node: {exact: other}, action: allow}\n");
        Assert.All(Decide(star, exec).SecretNames!, item => Assert.Null(item.Rule));
    }

    [Fact]
    public void Owned_names_are_allowed_and_unowned_ones_take_the_operation_aware_exec_fallback()
    {
        var exec = Request("node", "exec", """{"command":"true"}""", secrets: ["mine", "theirs"], owned: ["mine"]);
        // An env.exec rule whose only conditions are callers and a Node covering master
        // establishes the fallback.
        var fallback = Yaml("defaultAction: deny\nrules:\n- {id: exec, op: env.exec, node: master, action: allow}\n- {id: marker, op: node.list, action: allow}\n");
        var decision = Decide(fallback, exec);
        var names = decision.SecretNames!.ToDictionary(item => item.Name);
        Assert.True(names["mine"].Owned);
        Assert.Equal("exec", names["theirs"].Fallback!.Rule!["id"]!.GetValue<string>());
        Assert.Equal(ToolAuthorizationEffect.Allow, decision.Effect);
        // A path condition never establishes it; the next candidate (the default) does.
        var pathed = Yaml(
            "defaultAction: deny\nrules:\n- {id: exec, op: env.exec, path: {within: /synthetic}, action: allow}\n- {id: run, tool: {source: node, name: exec}, args: {command: {equals: \"true\"}}, action: allow}\n"
        );
        names = Decide(pathed, exec).SecretNames!.ToDictionary(item => item.Name);
        Assert.Null(names["theirs"].Fallback!.Rule);
        Assert.Equal(ToolAuthorizationEffect.Deny, names["theirs"].Effect);
        // An `op: "*"` grant of master exec establishes it by design.
        var star = Yaml("defaultAction: deny\nrules:\n- {id: star, op: \"*\", action: allow}\n");
        Assert.Equal(
            "star",
            Decide(star, exec).SecretNames!.Single(item => item.Name == "theirs").Fallback!.Rule!["id"]!.GetValue<string>()
        );
    }

    [Fact]
    public void Approval_options_intersect_across_operations_and_names_and_keep_an_asking_default()
    {
        var exec = Request("node", "exec", """{"command":"true"}""", secrets: ["api-a"], owned: []);
        var policy = Yaml(
            """
            defaultAction: deny
            rules:
            - {id: exec, op: env.exec, action: ask, approval: {timeoutSeconds: 600, approvers: [alice, bob]}}
            - {id: a, op: secret.use, secret: {anyOf: api-a}, action: ask, approval: {timeoutSeconds: 120, approvers: [bob, carol]}}
            """
        );
        var decision = Decide(policy, exec);
        Assert.Equal(ToolAuthorizationEffect.Ask, decision.Effect);
        var options = ToolApprovalOptions.Combine([new AuthorizationLayerDecision(null, policy, decision)]);
        Assert.Equal(120, options.TimeoutSeconds);
        Assert.Equal(["bob"], options.Approvers);
        // An asking default is a rule-less entry: only the administrator may approve.
        var defaulted = Yaml("defaultAction: ask\nrules:\n- {id: exec, op: env.exec, action: ask, approval: {approvers: [alice]}}\n- {id: other, op: node.list, action: allow}\n");
        var copy = Request(
            "builtin",
            "copy_between_nodes",
            """{"sourceNode":"master","sourcePath":"in.txt","targetNode":"master","targetPath":"out.txt"}""",
            paths:
            [
                new AuthorizationPath("sourcePath", "in.txt", "/synthetic/in.txt"),
                new AuthorizationPath("targetPath", "out.txt", "/synthetic/out.txt"),
            ]
        );
        decision = Decide(defaulted, copy);
        Assert.Equal(ToolAuthorizationEffect.Ask, decision.Effect);
        Assert.Contains(null, decision.AskingRules);
        Assert.Empty(ToolApprovalOptions.Combine([new AuthorizationLayerDecision(null, defaulted, decision)]).Approvers);
    }

    [Fact]
    public void External_principals_get_no_relation_or_owned_match_and_default_deny()
    {
        var policy = Yaml(
            """
            defaultAction: allow
            rules:
            - {id: own-sessions, op: session.view, targetSession: {session: {self: true}}, action: allow}
            - {id: remote-list, op: node.list, externalId: remote, action: allow}
            - {id: no-view, op: session.view, action: deny}
            """
        );
        var target = new AuthorizationTarget("alpha-main", "alpha", null);
        var external = Request("builtin", "view_session", """{"sessionId":"alpha-main"}""", "external", target: target);
        var decision = Decide(policy, external);
        Assert.Equal(ToolAuthorizationEffect.Deny, decision.Effect);
        Assert.Equal("no-view", RuleId(decision));
        Assert.Equal(
            ToolAuthorizationEffect.Allow,
            Decide(policy, Request("builtin", "view_session", """{"sessionId":"alpha-main"}""", target: target)).Effect
        );
        Assert.Equal(ToolAuthorizationEffect.Allow, Decide(policy, Request("builtin", "node", """{"action":"list"}""", "external")).Effect);
        // The external default is deny regardless of defaultAction.
        var empty = Yaml("defaultAction: allow\nrules:\n- {id: marker, op: model.request, action: allow}\n");
        Assert.Equal(ToolAuthorizationEffect.Deny, Decide(empty, Request("builtin", "node", """{"action":"select","nodeId":"master"}""", "external")).Effect);
        // An external request never carries secret decisions.
        Assert.Null(Decide(empty, Request("node", "exec", "{}", "external", secrets: ["x"])).SecretNames);
    }

    [Fact]
    public void Unresolved_resources_never_reach_an_allow_they_cannot_decide()
    {
        // The Session target does not exist: a rule testing it cannot decide, and no default
        // allow is reached.
        var policy = Yaml("rules:\n- {id: own, op: session.view, targetSession: {session: {self: true}}, action: allow}\n");
        var decision = Decide(policy, Request("builtin", "view_session", """{"sessionId":"ghost"}"""));
        Assert.Equal(ToolAuthorizationEffect.Deny, decision.Effect);
        Assert.NotNull(decision.Unresolved);
        Assert.Equal("own", decision.Unresolved!.Rule!["id"]!.GetValue<string>());
        // A rule that does not test the unknown resource still decides.
        var plain = Yaml("rules:\n- {id: views, op: session.view, action: allow}\n");
        Assert.Equal(ToolAuthorizationEffect.Allow, Decide(plain, Request("builtin", "view_session", """{"sessionId":"ghost"}""")).Effect);
        // A version-1 rule decides the whole call as before.
        var whole = Yaml("rules:\n- {id: v1, tool: {source: builtin, name: view_session}, action: allow}\n- {id: marker, op: node.list, action: deny}\n");
        Assert.Equal(ToolAuthorizationEffect.Allow, Decide(whole, Request("builtin", "view_session", """{"sessionId":"ghost"}""")).Effect);
        // A capability without a branch for its action is underivable and rejected.
        var node = Decide(plain, Request("builtin", "node", """{"action":"teleport"}"""));
        Assert.Equal(ToolAuthorizationEffect.Deny, node.Effect);
        Assert.NotNull(node.Unresolved!.Operation.Underivable);
        // Version-1-only policies never reject for unresolved resources.
        var version1 = Yaml("rules: []\n");
        Assert.Equal(ToolAuthorizationEffect.Allow, Decide(version1, Request("builtin", "node", """{"action":"teleport"}""")).Effect);
    }

    [Fact]
    public void Version1_only_policies_decide_exactly_as_the_version1_evaluator()
    {
        // The evaluator dispatches to the two-domain path only for policies with an op rule; a
        // disabled op rule still selects it, and every operation then stops at the version-1 rule.
        var request = Request("builtin", "node", """{"action":"select","nodeId":"master"}""");
        var version1 = Yaml("rules:\n- {id: v1, tool: {source: builtin, name: node}, action: ask, approval: {approvers: [alice]}}\n");
        var mixed = Yaml("rules:\n- {id: v1, tool: {source: builtin, name: node}, action: ask, approval: {approvers: [alice]}}\n- {id: dormant, op: node.select, action: deny, enabled: false}\n");
        var plain = Decide(version1, request);
        var twoDomain = Decide(mixed, request);
        Assert.Null(plain.Operations);
        Assert.NotNull(twoDomain.Operations);
        Assert.Equal(plain.Effect, twoDomain.Effect);
        Assert.Equal(RuleId(plain), RuleId(twoDomain));
        Assert.Equal(
            ToolApprovalOptions.Combine([new(null, version1, plain)]),
            ToolApprovalOptions.Combine([new(null, mixed, twoDomain)]),
            new ApprovalComparer()
        );
    }

    private sealed class ApprovalComparer : IEqualityComparer<ToolApprovalOptions>
    {
        public bool Equals(ToolApprovalOptions? x, ToolApprovalOptions? y) =>
            x!.TimeoutSeconds == y!.TimeoutSeconds && x.Approvers.SequenceEqual(y.Approvers);

        public int GetHashCode(ToolApprovalOptions obj) => 0;
    }

    [Fact]
    public void Builtin_projection_does_not_depend_on_the_current_node_and_stays_conservative()
    {
        // A Node-scoped op deny can never hide a builtin capability: its Node is unknown in
        // declarations, so the projection is the same whatever Node the Session is on.
        var policy = Yaml(
            "rules:\n- {id: no-box-sessions, op: session.create, node: {exact: box}, action: deny}\n- {id: no-select, op: node.select, action: deny}\n"
        );
        foreach (var current in new[] { "master", "box" })
        {
            var create = Request("builtin", "create_session", targetNode: "master") with { CurrentNode = current };
            Assert.True(ToolAuthorizationEvaluation.Visible(policy, create));
            // node stays visible: list and the other branches remain possible.
            var node = Request("builtin", "node", targetNode: null) with { CurrentNode = current };
            Assert.True(ToolAuthorizationEvaluation.Visible(policy, node, unknownNodeTargets: true));
        }
        // With the command's fixed action, the denied branch is hidden.
        var select = Request("builtin", "node", """{"action":"select"}""", targetNode: null);
        Assert.False(
            ToolAuthorizationEvaluation.Visible(
                policy,
                select,
                unknownNodeTargets: true,
                knownArgs: new HashSet<string> { "action" }
            )
        );
        // A raw spelling is never assumed: without a known action the version-1 walk keeps the
        // capability visible.
        var raw = Yaml(
            "rules:\n- {id: v1, tool: {source: builtin, name: node}, args: {action: {equals: list}}, action: allow}\n- {id: rest, tool: {source: builtin, name: node}, action: deny}\n- {id: marker, op: model.request, action: allow}\n"
        );
        Assert.True(
            ToolAuthorizationEvaluation.Visible(raw, Request("builtin", "node", targetNode: null), unknownNodeTargets: true)
        );
    }

    [Fact]
    public void Every_branch_has_an_unconditional_operation_unless_self()
    {
        foreach (var declaration in OperationDeclarations.Capabilities)
        {
            if (declaration.FrontEnd is not null)
                continue;
            foreach (var branch in declaration.Branches)
                Assert.True(
                    branch.Self is not null || branch.Operations.Any(item => !item.Conditional),
                    $"{declaration.Source}:{declaration.Name} branch {branch.Name}"
                );
        }
    }

    [Fact]
    public void Generated_layer_terminal_deny_is_not_satisfied_by_an_op_rule()
    {
        Assert.True(
            IsolationMigrationRules.EndsInDeny(JsonNode.Parse("""[{"id":"x","op":"node.list","action":"allow"},{"id":"rest","action":"deny"}]""")!.AsArray())
        );
        // A raw edit that appends an op rule after the deny leaves no terminal deny.
        Assert.False(
            IsolationMigrationRules.EndsInDeny(JsonNode.Parse("""[{"id":"rest","action":"deny"},{"id":"x","op":"node.list","action":"deny"}]""")!.AsArray())
        );
    }
}
