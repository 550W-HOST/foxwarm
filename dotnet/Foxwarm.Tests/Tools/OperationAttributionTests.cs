using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// Decision equality for operation authorization phase 1. This part uses only the existing
// evaluator, so the same file runs unchanged at the base revision: the corpus states what the
// evaluator decides for global, local and external requests, before and after phase 1.
// OperationAttributionTests.Attribution.cs checks that attribution reports the same.
public sealed partial class OperationAttributionTests
{
    internal static JsonArray Cases() =>
        JsonNode
            .Parse(
                File.ReadAllText(
                    Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", "operation-decisions.json")
                )
            )!["cases"]!
            .AsArray();

    private static IReadOnlyList<string>? Strings(JsonNode? value) =>
        value is JsonArray list ? list.Select(item => item!.GetValue<string>()).ToArray() : null;

    internal static ToolAuthorizationRequest Request(JsonObject item)
    {
        var request = item["request"]!.AsObject();
        var external = request["principal"]?.GetValue<string>() == "external";
        var target = request["sessionTarget"] as JsonObject;
        var forest = request["forest"] as JsonObject;
        return new(
            request["source"]!.GetValue<string>(),
            request["name"]!.GetValue<string>(),
            request["server"]?.GetValue<string>(),
            request["args"]!.AsObject(),
            (request["paths"] as JsonArray ?? [])
                .Select(path => new AuthorizationPath(
                    path!["arg"]!.GetValue<string>(),
                    path["raw"]!.GetValue<string>(),
                    path["resolved"]?.GetValue<string>(),
                    path["node"]?.GetValue<string>() ?? "master"
                ))
                .ToArray(),
            external ? null : "alpha",
            external ? "ext-context" : "alpha-1",
            request["targetNode"]?.GetValue<string>() ?? (external ? null : "master"),
            "/w",
            external ? null : "/w/alpha",
            external ? null : "/w/alpha/memory",
            SessionTarget: target is null
                ? null
                : new AuthorizationTarget(
                    target["id"]!.GetValue<string>(),
                    target["agent"]!.GetValue<string>(),
                    target["parent"]?.GetValue<string>()
                ),
            Principal: external ? "external" : "internal",
            ExternalId: request["externalId"]?.GetValue<string>(),
            NodeTargets: Strings(request["nodeTargets"]),
            CurrentNode: external ? null : "master",
            NodeForest: forest is null
                ? null
                : new Foxwarm.Nodes.NodeAuthorizationForest(
                    forest.ToDictionary(pair => pair.Key, pair => pair.Value?.GetValue<string>())
                ),
            Secrets: Strings(request["secrets"]),
            OwnedSecrets: Strings(request["ownedSecrets"])
        );
    }

    internal static IReadOnlyList<(string? Layer, ToolAuthorizationPolicy Policy)> Layers(JsonObject item)
    {
        var layers = new List<(string?, ToolAuthorizationPolicy)>
        {
            (null, ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes(item["global"]!.GetValue<string>()))),
        };
        foreach (var local in item["local"] as JsonArray ?? [])
            layers.Add((local!["agent"]!.GetValue<string>(), AgentRulePolicy.Parse(local["rules"])));
        return layers;
    }

    internal static AuthorizationAssessment Assess(JsonObject item)
    {
        var request = Request(item);
        return new(
            request,
            Layers(item)
                .Select(layer => new AuthorizationLayerDecision(
                    layer.Layer,
                    layer.Policy,
                    ToolAuthorizationEvaluation.Evaluate(layer.Policy, request)
                ))
                .ToArray()
        );
    }

    private static string? Id(JsonObject? rule) => rule?["id"]?.GetValue<string>();

    // What the existing evaluator decides, in the corpus's expected shape.
    internal static JsonObject EvaluatorView(JsonObject item)
    {
        if (item["kind"]?.GetValue<string>() == "creation-target")
        {
            var probe = Request(item);
            var decisions = Layers(item)
                .Select(layer =>
                    (layer.Layer, Decision: ToolAuthorizationEvaluation.EvaluateCreationTarget(layer.Policy, probe))
                )
                .ToArray();
            var all = decisions.Select(item => item.Decision).ToArray();
            return new JsonObject
            {
                ["decision"] =
                    all.Contains(CreationTargetDecision.Deny) ? "deny"
                    : all.Contains(CreationTargetDecision.Indeterminate) ? "indeterminate"
                    : all.Contains(CreationTargetDecision.Ask) ? "ask"
                    : "allow",
                ["layers"] = new JsonArray(
                    decisions
                        .Select(layer =>
                            (JsonNode?)
                                new JsonObject
                                {
                                    ["layer"] = layer.Layer is null ? "global" : "agent:" + layer.Layer,
                                    ["decision"] = layer.Decision.ToString().ToLowerInvariant(),
                                }
                        )
                        .ToArray()
                ),
            };
        }
        var assessment = Assess(item);
        var view = new JsonObject
        {
            ["decision"] = AuthorizationDecision.Name(assessment.Effect),
            ["layers"] = new JsonArray(
                assessment
                    .Layers.Select(layer =>
                    {
                        var entry = new JsonObject
                        {
                            ["layer"] = layer.Layer is null ? "global" : "agent:" + layer.Layer,
                            ["decision"] = AuthorizationDecision.Name(layer.Decision.Effect),
                            ["rule"] = Id(layer.Decision.Rule),
                        };
                        if (layer.Decision.Secrets is { } secrets)
                            entry["secrets"] = new JsonObject
                            {
                                ["decision"] = AuthorizationDecision.Name(secrets.Effect),
                                ["source"] =
                                    secrets.Owned ? "owned"
                                    : secrets.Fallback is not null ? "fallback"
                                    : "rule",
                                ["rule"] = Id(secrets.Rule ?? secrets.Fallback?.Rule),
                            };
                        return (JsonNode?)entry;
                    })
                    .ToArray()
            ),
        };
        if (assessment.Effect == ToolAuthorizationEffect.Ask)
            view["approval"] = assessment.Approval.ToJson();
        return view;
    }

    [Fact]
    public void Decision_corpus_matches_the_existing_evaluator()
    {
        var failures = new List<string>();
        foreach (var item in Cases().OfType<JsonObject>())
        {
            var actual = EvaluatorView(item);
            if (!JsonNode.DeepEquals(item["expected"], actual))
                failures.Add(item["name"] + ": " + actual.ToJsonString());
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    // Writes the evaluator's decisions and the serialized default declarations, so the base and
    // the phase-1 revision can be compared byte for byte. Runs only when asked to.
    [Fact]
    public async Task Evidence_of_decisions_and_default_declarations_is_written_on_request()
    {
        if (Environment.GetEnvironmentVariable("FOXWARM_OPERATION_EVIDENCE") is not { Length: > 0 } path)
            return;
        var decisions = new JsonArray();
        foreach (var item in Cases().OfType<JsonObject>())
            decisions.Add(
                (JsonNode?)new JsonObject { ["name"] = item["name"]!.DeepClone(), ["view"] = EvaluatorView(item) }
            );
        await using var f = await ScriptFixture.Create();
        var evidence = new JsonObject
        {
            ["decisions"] = decisions,
            ["defaultDeclarations"] = f.Manager.ModelDefinitions(f.Owner),
        };
        await File.WriteAllTextAsync(path, evidence.ToJsonString(new() { WriteIndented = true }));
    }
}
