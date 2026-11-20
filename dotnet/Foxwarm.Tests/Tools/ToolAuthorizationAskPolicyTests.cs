using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Grammar and evaluation of the ask action. Effects of an approval request are covered by the
// approval gate tests.
public sealed class ToolAuthorizationAskPolicyTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static ToolAuthorizationPolicy Yaml(string text) =>
        ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes(text));

    private static ToolAuthorizationRequest Request(
        string source = "node",
        string name = "exec",
        string principal = "internal",
        JsonObject? args = null,
        IReadOnlyList<string>? nodeTargets = null
    ) =>
        new(
            source,
            name,
            null,
            args ?? new JsonObject(),
            [],
            principal == "internal" ? "alpha" : null,
            principal == "internal" ? "alpha/main" : null,
            "master",
            "/synthetic",
            "/synthetic/alpha",
            "/synthetic/alpha/memory",
            Principal: principal,
            ExternalId: principal == "external" ? "remote" : null,
            NodeTargets: nodeTargets
        );

    [Fact]
    public void Ask_is_a_rule_and_default_action_with_normalized_approval_options()
    {
        var policy = Yaml(
            """
            version: 1
            defaultAction: ask
            rules:
              - id: confirm
                action: ask
                tool: {source: node, name: exec}
                approval:
                  timeoutSeconds: 1800
                  approvers: [ops-laptop, ops-laptop, reviewer.2]
              - id: plain
                action: ask
                tool: {source: node, name: write}
            """
        );
        Assert.Equal("ask", policy.Value["defaultAction"]!.GetValue<string>());
        var rule = policy.Value["rules"]![0]!;
        Assert.Equal("ask", rule["action"]!.GetValue<string>());
        Assert.Equal(1800, rule["approval"]!["timeoutSeconds"]!.GetValue<long>());
        Assert.Equal(
            ["ops-laptop", "reviewer.2"],
            rule["approval"]!["approvers"]!.AsArray().Select(value => value!.GetValue<string>())
        );
        Assert.Null(policy.Value["rules"]![1]!["approval"]);

        var agentLayer = AgentRulePolicy.Parse(
            JsonNode.Parse("""[{"action":"ask","tool":{"source":"node","name":"exec"}}]""")
        );
        Assert.Equal(
            ToolAuthorizationEffect.Ask,
            ToolAuthorizationEvaluation.Evaluate(agentLayer, Request()).Effect
        );
    }

    [Theory]
    [InlineData("rules: [{action: allow, approval: {timeoutSeconds: 60}}]")]
    [InlineData("rules: [{action: deny, approval: {}}]")]
    [InlineData("rules: [{action: ask, approval: {timeoutSeconds: 29}}]")]
    [InlineData("rules: [{action: ask, approval: {timeoutSeconds: 604801}}]")]
    [InlineData("rules: [{action: ask, approval: {timeoutSeconds: 60.5}}]")]
    [InlineData("rules: [{action: ask, approval: {timeoutSeconds: '60'}}]")]
    [InlineData("rules: [{action: ask, approval: {approvers: []}}]")]
    [InlineData("rules: [{action: ask, approval: {approvers: ['-bad']}}]")]
    [InlineData("rules: [{action: ask, approval: {approvers: ops}}]")]
    [InlineData("rules: [{action: ask, approval: {deadline: 60}}]")]
    [InlineData("rules: [{action: ask, approval: null}]")]
    [InlineData("rules: [{action: ask, externalId: remote}]")]
    [InlineData("rules: [{action: ask, match: {externalId: remote}}]")]
    [InlineData("rules: [{action: confirm}]")]
    [InlineData("defaultAction: confirm")]
    public void Invalid_ask_grammar_rejects_the_whole_policy(string body)
    {
        Assert.Throws<InvalidDataException>(() => Yaml("version: 1\n" + body));
    }

    [Fact]
    public void First_match_decides_and_external_principals_are_never_asked()
    {
        var policy = Yaml(
            """
            version: 1
            defaultAction: deny
            rules:
              - id: read-ok
                action: allow
                tool: {source: node, name: read}
              - id: confirm-all
                action: ask
              - id: never-reached
                action: allow
                tool: {source: node, name: exec}
            """
        );
        var read = ToolAuthorizationEvaluation.Evaluate(policy, Request(name: "read"));
        Assert.Equal(ToolAuthorizationEffect.Allow, read.Effect);
        var exec = ToolAuthorizationEvaluation.Evaluate(policy, Request());
        Assert.Equal(ToolAuthorizationEffect.Ask, exec.Effect);
        Assert.False(exec.Allowed);
        Assert.Equal("confirm-all", exec.Rule!["id"]!.GetValue<string>());

        // An identity-neutral ask rule denies an external caller in its first-match position.
        var external = ToolAuthorizationEvaluation.Evaluate(policy, Request(principal: "external"));
        Assert.Equal(ToolAuthorizationEffect.Deny, external.Effect);
        Assert.Equal("confirm-all", external.Rule!["id"]!.GetValue<string>());

        var askDefault = Yaml("version: 1\ndefaultAction: ask");
        Assert.Equal(
            ToolAuthorizationEffect.Ask,
            ToolAuthorizationEvaluation.Evaluate(askDefault, Request()).Effect
        );
        Assert.Equal(
            ToolAuthorizationEffect.Deny,
            ToolAuthorizationEvaluation.Evaluate(askDefault, Request(principal: "external")).Effect
        );
    }

    [Fact]
    public void Ask_keeps_tools_discoverable_for_internal_callers_only()
    {
        var unconditional = Yaml(
            "version: 1\ndefaultAction: deny\nrules: [{action: ask, tool: {source: node, name: exec}}]"
        );
        Assert.True(ToolAuthorizationEvaluation.Visible(unconditional, Request()));
        Assert.False(
            ToolAuthorizationEvaluation.Visible(unconditional, Request(principal: "external"))
        );
        var conditional = Yaml(
            "version: 1\ndefaultAction: deny\nrules: [{action: ask, tool: {source: node, name: exec}, args: {command: {exists: true}}}]"
        );
        Assert.True(ToolAuthorizationEvaluation.Visible(conditional, Request()));
        var askDefault = Yaml("version: 1\ndefaultAction: ask");
        Assert.True(ToolAuthorizationEvaluation.Visible(askDefault, Request()));
        Assert.False(
            ToolAuthorizationEvaluation.Visible(askDefault, Request(principal: "external"))
        );
    }

    [Fact]
    public void Ask_on_Node_targets_matches_when_any_target_matches()
    {
        var policy = Yaml(
            """
            version: 1
            rules:
              - action: ask
                node: {exact: master}
            """
        );
        var copy = Request(
            source: "builtin",
            name: "copy_between_nodes",
            nodeTargets: ["dev/one", "master"]
        );
        Assert.Equal(
            ToolAuthorizationEffect.Ask,
            ToolAuthorizationEvaluation.Evaluate(policy, copy).Effect
        );
        Assert.Equal(
            ToolAuthorizationEffect.Allow,
            ToolAuthorizationEvaluation
                .Evaluate(policy, copy with { NodeTargets = ["dev/one", "dev/two"] })
                .Effect
        );
    }

    [Fact]
    public void Layers_combine_deny_over_ask_over_allow_and_intersect_approval_options()
    {
        var request = Request();
        AuthorizationLayerDecision Layer(string? agent, string action, string? approval = null)
        {
            var policy = Yaml(
                $"version: 1\nrules: [{{id: {action}-{agent ?? "global"}, action: {action}{(approval is null ? "" : ", approval: " + approval)}}}]"
            );
            return new(agent, policy, ToolAuthorizationEvaluation.Evaluate(policy, request));
        }
        var asking = new AuthorizationAssessment(
            request,
            [
                Layer(null, "ask", "{timeoutSeconds: 600, approvers: [a, b]}"),
                Layer("alpha", "allow"),
                Layer("beta", "ask", "{timeoutSeconds: 120, approvers: [b, c]}"),
            ]
        );
        Assert.Equal(ToolAuthorizationEffect.Ask, asking.Effect);
        Assert.Null(asking.Denied);
        Assert.Equal(2, asking.Asking.Count);
        Assert.Equal(120, asking.Approval.TimeoutSeconds);
        Assert.Equal(["b"], asking.Approval.Approvers);

        // A layer without approvers admits only the administrator.
        var adminOnly = new AuthorizationAssessment(
            request,
            [Layer(null, "ask", "{approvers: [a]}"), Layer("alpha", "ask")]
        );
        Assert.Empty(adminOnly.Approval.Approvers);
        Assert.Null(adminOnly.Approval.TimeoutSeconds);

        var denied = new AuthorizationAssessment(
            request,
            [Layer(null, "ask"), Layer("alpha", "deny")]
        );
        Assert.Equal(ToolAuthorizationEffect.Deny, denied.Effect);
        Assert.Equal("alpha", denied.Denied!.Layer);

        var allowed = new AuthorizationAssessment(
            request,
            [Layer(null, "allow"), Layer("alpha", "allow")]
        );
        Assert.Equal(ToolAuthorizationEffect.Allow, allowed.Effect);
    }

    [Fact]
    public void Scheduled_creation_target_reports_ask_and_mixed_outcomes_as_indeterminate()
    {
        var request = Request(
            source: "builtin",
            name: "create_session",
            args: Obj("""{"agentName":"beta"}""")
        );
        CreationTargetDecision Decide(string rules, string defaultAction = "allow") =>
            ToolAuthorizationEvaluation.EvaluateCreationTarget(
                Yaml($"version: 1\ndefaultAction: {defaultAction}\nrules: {rules}"),
                request
            );
        Assert.Equal(
            CreationTargetDecision.Ask,
            Decide("[{action: ask, tool: {source: builtin, name: create_session}}]")
        );
        Assert.Equal(CreationTargetDecision.Ask, Decide("[]", "ask"));
        // Future names could select either outcome.
        Assert.Equal(
            CreationTargetDecision.Indeterminate,
            Decide(
                "[{action: allow, tool: {source: builtin, name: create_session}, args: {sessionName: {equals: x}}}, {action: ask}]"
            )
        );
        Assert.Equal(
            CreationTargetDecision.Indeterminate,
            Decide(
                "[{action: ask, tool: {source: builtin, name: create_session}, args: {sessionName: {equals: x}}}]"
            )
        );
        Assert.Equal(
            CreationTargetDecision.Deny,
            Decide(
                "[{action: ask, tool: {source: builtin, name: create_session}, args: {sessionName: {equals: x}}}, {action: deny}]"
            )
        );
    }
}
