using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// The mixed corpus: global and Agent-local layers with version-1 and operation rules, evaluated
// layer by layer as the dispatch gate combines them (any deny wins, then any ask; approval
// options over every asking layer). Each case names the readings it fixes.
public sealed partial class OperationRulesTests
{
    private sealed record MixedCase(
        string Name,
        string Global,
        string? Local,
        Func<ToolAuthorizationRequest> Request,
        ToolAuthorizationEffect Effect,
        string? Deciding = null,
        string[]? Approvers = null,
        long? Timeout = null
    );

    private static ToolAuthorizationRequest Exec(string command, string[] secrets, string[] owned) =>
        // A master exec states its cwd; without it the enforcement context supplies the Session's.
        Request(
            "node",
            "exec",
            $$"""{"command":"{{command}}","cwd":"/synthetic"}""",
            secrets: secrets,
            owned: owned,
            paths: [new AuthorizationPath("cwd", "/synthetic", "/synthetic")]
        );

    private static ToolAuthorizationRequest Copy(string source, string target) =>
        Request(
            "builtin",
            "copy_between_nodes",
            $$"""{"sourceNode":"master","sourcePath":"{{source}}","targetNode":"master","targetPath":"{{target}}"}""",
            paths:
            [
                new AuthorizationPath("sourcePath", source, "/synthetic/" + source),
                new AuthorizationPath("targetPath", target, "/synthetic/" + target),
            ]
        );

    private static readonly MixedCase[] Mixed =
    [
        new(
            "legs compose: read and write grants allow a copy",
            "defaultAction: deny\nrules:\n- {id: r, op: env.read, path: {within: /synthetic}, action: allow}\n- {id: w, op: env.write, path: {within: /synthetic/out}, action: allow}\n",
            null,
            () => Copy("in.txt", "out/x.txt"),
            ToolAuthorizationEffect.Allow
        ),
        new(
            "a write leg outside its grant falls to the default",
            "defaultAction: deny\nrules:\n- {id: r, op: env.read, path: {within: /synthetic}, action: allow}\n- {id: w, op: env.write, path: {within: /synthetic/out}, action: allow}\n",
            null,
            () => Copy("in.txt", "elsewhere.txt"),
            ToolAuthorizationEffect.Deny
        ),
        new(
            "a correlated version-1 rule keeps its whole-call meaning",
            "defaultAction: deny\nrules:\n- {id: pair, tool: {source: builtin, name: copy_between_nodes}, args: {targetPath: {equals: out.txt}}, action: allow}\n- {id: marker, op: model.request, action: deny}\n",
            null,
            () => Copy("in.txt", "out.txt"),
            ToolAuthorizationEffect.Allow,
            "pair"
        ),
        new(
            "first match: an op deny shadowed by a version-1 allow",
            "rules:\n- {id: v1, tool: {source: builtin, name: copy_between_nodes}, action: allow}\n- {id: no-writes, op: env.write, action: deny}\n",
            null,
            () => Copy("in.txt", "out.txt"),
            ToolAuthorizationEffect.Allow,
            "v1"
        ),
        new(
            "raw spelling: version-1 raw deny passes a variant, op deny stops it",
            "rules:\n- {id: raw, tool: {source: builtin, name: node}, args: {action: {equals: select}}, action: deny}\n- {id: op, op: node.select, action: ask}\n",
            null,
            () => Request("builtin", "node", """{"action":"SELECT","nodeId":"master"}"""),
            ToolAuthorizationEffect.Ask,
            "op"
        ),
        new(
            "whole-set version-1 secrets allow covering one of two names does not match",
            "defaultAction: deny\nrules:\n- {id: run, tool: {source: node, name: exec}, args: {command: {equals: go}}, action: allow}\n- {id: v1-a, tool: {source: node, name: exec}, secrets: {anyOf: a}, action: allow}\n",
            null,
            () => Exec("go", ["a", "b"], []),
            ToolAuthorizationEffect.Deny
        ),
        new(
            "an op grant for one name and a whole-set version-1 rule for the rest",
            "defaultAction: deny\nrules:\n- {id: run, tool: {source: node, name: exec}, args: {command: {equals: go}}, action: allow}\n- {id: op-a, op: secret.use, secret: {anyOf: a}, action: allow}\n- {id: v1-ab, tool: {source: node, name: exec}, secrets: {anyOf: [a, b]}, action: allow}\n",
            null,
            () => Exec("go", ["a", "b"], []),
            ToolAuthorizationEffect.Allow
        ),
        new(
            "a whole-set version-1 deny matching one name decides an unmatched name too",
            "rules:\n- {id: op-b, op: secret.use, secret: {anyOf: c}, action: allow}\n- {id: v1-deny-a, tool: {source: node, name: exec}, secrets: {anyOf: a}, action: deny}\n",
            null,
            () => Exec("go", ["a", "b"], []),
            ToolAuthorizationEffect.Deny,
            "v1-deny-a"
        ),
        new(
            "an owned name passes an ordinary terminal deny's secret domain",
            "rules:\n- {id: run, tool: {source: node, name: exec}, action: allow}\n- {id: marker, op: model.request, action: deny}\n- {id: rest, action: deny}\n",
            null,
            () => Exec("go", ["mine"], ["mine"]),
            ToolAuthorizationEffect.Allow
        ),
        new(
            "an explicit secret.use deny restricts an owned name",
            "rules:\n- {id: no-mine, op: secret.use, secret: {anyOf: mine}, action: deny}\n",
            null,
            () => Exec("go", ["mine"], ["mine"]),
            ToolAuthorizationEffect.Deny,
            "no-mine"
        ),
        new(
            "an argument-constrained master exec grant does not establish the fallback",
            "defaultAction: deny\nrules:\n- {id: run, tool: {source: node, name: exec}, args: {command: {equals: go}}, action: allow}\n- {id: marker, op: model.request, action: deny}\n",
            null,
            () => Exec("go", ["x"], []),
            ToolAuthorizationEffect.Deny
        ),
        new(
            "an unrestricted env.exec op grant on master establishes the fallback",
            "defaultAction: deny\nrules:\n- {id: exec, op: env.exec, node: {exact: master}, action: allow}\n",
            null,
            () => Exec("go", ["x"], []),
            ToolAuthorizationEffect.Allow
        ),
        new(
            "a wildcard op grant reaches the fallback but never names secret.use",
            "defaultAction: deny\nrules:\n- {id: all, op: \"*\", action: allow}\n",
            null,
            () => Exec("go", ["x"], []),
            ToolAuthorizationEffect.Allow
        ),
        new(
            "an asking default combines with an op ask: no scoped approver",
            "defaultAction: ask\nrules:\n- {id: confirm-reads, op: env.read, action: ask, approval: {approvers: [alice], timeoutSeconds: 90}}\n",
            null,
            () => Copy("in.txt", "out.txt"),
            ToolAuthorizationEffect.Ask,
            Approvers: [],
            Timeout: 90
        ),
        new(
            "ordinary and secret asks across layers intersect approvers and take the shortest timeout",
            "rules:\n- {id: g, op: env.exec, action: ask, approval: {approvers: [alice, bob], timeoutSeconds: 600}}\n",
            """[{"id":"l","op":"secret.use","secret":{"anyOf":"k"},"action":"ask","approval":{"approvers":["bob","carol"],"timeoutSeconds":60}}]""",
            () => Exec("go", ["k"], []),
            ToolAuthorizationEffect.Ask,
            Approvers: ["bob"],
            Timeout: 60
        ),
        new(
            "a denying layer suppresses approval",
            "rules:\n- {id: g, op: env.exec, action: ask}\n",
            """[{"id":"no-exec","op":"env.exec","action":"deny"}]""",
            () => Exec("go", [], []),
            ToolAuthorizationEffect.Deny,
            "no-exec"
        ),
        new(
            "a local layer's unmatched operation passes",
            "rules:\n- {id: marker, op: model.request, action: deny}\n",
            """[{"id":"reads","op":"env.read","path":{"within":"/elsewhere"},"action":"deny"}]""",
            () => Copy("in.txt", "out.txt"),
            ToolAuthorizationEffect.Allow
        ),
        new(
            "an explicit local terminal deny restricts unowned secrets despite a global grant",
            "rules:\n- {id: k, op: secret.use, secret: {anyOf: k}, action: allow}\n",
            """[{"id":"run","tool":{"source":"node","name":"exec"},"args":{"command":{"equals":"go"}},"action":"allow"},{"id":"marker","op":"model.request","action":"allow"},{"id":"rest","action":"deny"}]""",
            () => Exec("go", ["k"], []),
            ToolAuthorizationEffect.Deny,
            "rest"
        ),
        new(
            "external principals: ask is a deny and relations never match",
            "rules:\n- {id: confirm, op: node.list, action: ask}\n",
            null,
            () => Request("builtin", "node", """{"action":"list"}""", "external"),
            ToolAuthorizationEffect.Deny,
            "confirm"
        ),
    ];

    [Fact]
    public void Mixed_corpus_decides_every_case_across_layers()
    {
        foreach (var item in Mixed)
        {
            var layers = new List<(string?, ToolAuthorizationPolicy)> { (null, Yaml(item.Global)) };
            if (item.Local is not null)
                layers.Add(("alpha", AgentRulePolicy.Parse(JsonNode.Parse(item.Local))));
            var request = item.Request();
            var decisions = layers
                .Select(layer => new AuthorizationLayerDecision(layer.Item1, layer.Item2, Decide(layer.Item2, request)))
                .ToArray();
            var assessment = new AuthorizationAssessment(request, decisions);
            Assert.True(item.Effect == assessment.Effect, $"{item.Name}: {assessment.Effect}");
            var deciding =
                assessment.Denied ?? assessment.Asking.FirstOrDefault() ?? decisions[0];
            if (item.Deciding is not null)
                Assert.True(
                    item.Deciding == SessionWaitText(deciding?.Decision.Rule?["id"]),
                    $"{item.Name}: deciding {SessionWaitText(deciding?.Decision.Rule?["id"])}"
                );
            if (item.Approvers is not null)
                Assert.True(
                    item.Approvers.SequenceEqual(assessment.Approval.Approvers),
                    $"{item.Name}: approvers {string.Join(",", assessment.Approval.Approvers)}"
                );
            if (item.Timeout is not null)
                Assert.Equal(item.Timeout, assessment.Approval.TimeoutSeconds);
            // External callers cannot wait: their consumers read only Allowed.
            if (request.Principal != "internal")
                Assert.False(decisions[0].Decision.Allowed);
        }
    }

    private static string? SessionWaitText(JsonNode? node) => Foxwarm.Sessions.SessionWait.Text(node);
}
