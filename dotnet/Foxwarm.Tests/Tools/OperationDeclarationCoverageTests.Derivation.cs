using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class OperationDeclarationCoverageTests
{
    private static JsonNode Corpus() =>
        JsonNode.Parse(
            File.ReadAllText(
                Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", "operation-conformance.json")
            )
        )!;

    // The call a corpus case names: a ctl command (parsed as the model's ctl call would be) or a
    // tool ID with arguments.
    private static ResolvedTool CaseTool(JsonObject item)
    {
        var node = item["facts"]?["executionNode"]?.GetValue<string>() ?? "master";
        if (item["command"] is JsonNode command)
        {
            var args = new JsonObject { ["command"] = command.DeepClone() };
            if (item["values"] is JsonObject values)
                args["values"] = values.DeepClone();
            var parsed = CtlParser.Parse(args);
            var target = parsed as CtlTarget;
            Assert.True(target is not null, command + ": " + (parsed as CtlError)?.Message);
            return new ResolvedTool("ctl", target.Source, target.Name, target.Args, ExecutionNode: node)
            {
                Command = target.Command.Path,
            };
        }
        var id = item["toolId"]!.GetValue<string>();
        var colon = id.IndexOf(':');
        var source = id[..colon];
        var rest = id[(colon + 1)..];
        var slash = source == "builtin" ? -1 : source == "node" ? rest.LastIndexOf('/') : rest.IndexOf('/');
        var name = slash < 0 ? rest : rest[(slash + 1)..];
        return new(
            name,
            source,
            name,
            (JsonObject?)item["args"]?.DeepClone() ?? new JsonObject(),
            source == "mcp" ? rest[..slash] : null,
            source == "node" ? rest[..slash] : node
        );
    }

    private static ToolAuthorizationRequest CaseFacts(ResolvedTool tool, JsonObject? facts)
    {
        facts ??= new JsonObject();
        IReadOnlyList<string>? Strings(string key) =>
            facts[key] is JsonArray list ? list.Select(item => item!.GetValue<string>()).ToArray() : null;
        return new(
            tool.Source,
            tool.Name,
            tool.Server,
            tool.Args,
            (facts["paths"] as JsonArray ?? [])
                .Select(path => new AuthorizationPath(
                    path!["arg"]!.GetValue<string>(),
                    path["raw"]!.GetValue<string>(),
                    path["resolved"]?.GetValue<string>(),
                    path["node"]?.GetValue<string>() ?? "master"
                ))
                .ToArray(),
            facts["agent"]?.GetValue<string>() ?? "alpha",
            facts["session"]?.GetValue<string>() ?? "alpha-1",
            tool.ExecutionNode,
            "/workspace",
            "/workspace/alpha",
            "/workspace/alpha/memory",
            SessionTarget: facts["sessionTarget"]?.GetValue<string>() is { } target
                ? new AuthorizationTarget(target, "alpha", null)
                : null,
            NodeTargets: Strings("nodeTargets"),
            Secrets: Strings("secrets")
        );
    }

    private static PlanContext CaseContext(JsonObject? context)
    {
        context ??= new JsonObject();
        var subtree = context["subtree"] as JsonObject;
        var sessions = context["sessionExists"] as JsonObject;
        var cwdProbes = (context["defaultCwdProbe"] as JsonArray)
            ?.Select(item => item!.GetValue<string>())
            .ToHashSet();
        return new PlanContext(context["currentNode"]?.GetValue<string>() ?? "master")
        {
            PolicyPath = context["policyPath"]?.GetValue<string>(),
            Subtree = subtree is null
                ? null
                : id =>
                    subtree[id] is JsonArray members
                        ? members.Select(item => item!.GetValue<string>()).ToArray()
                        : null,
            SessionExists = sessions is null ? null : id => sessions[id]?.GetValue<bool>(),
            DefaultCwdProbe = cwdProbes is null ? null : cwdProbes.Contains,
            SecretsUnknown = context["secretsUnknown"]?.GetValue<bool>() == true,
            InstallDefaultNode = context["installDefaultNode"]?.GetValue<string>(),
            AgentDefaultNode = context["agentDefaultNode"] is JsonObject defaults
                ? agent => defaults[agent]?.GetValue<string>()
                : null,
            // Corpus channels deliver to their targets verbatim.
            ChannelTarget = (target, _) => target,
        };
    }

    // What a case checks: the plan without descriptions, plus the concrete identity of each
    // obligation the plan can evaluate.
    internal static JsonObject Projection(OperationPlan plan)
    {
        var json = plan.ToJson();
        json.Remove("arguments");
        json["normalized"] = plan.Normalized.DeepClone();
        foreach (var obligation in json["obligations"]!.AsArray().OfType<JsonObject>())
            obligation.Remove("description");
        var evaluated = new JsonObject();
        foreach (var obligation in plan.Obligations)
            evaluated[obligation.Id] =
                obligation.SameAsPrimary ? "primary"
                : obligation.Request is { } request
                    ? OperationPlan.CapabilityId(request) + " " + request.Args.ToJsonString()
                : obligation.CreationAgent is { } agent ? "creation-target " + agent
                : null;
        json["evaluated"] = evaluated;
        return json;
    }

    // Item 3: the derivation corpus. It extends the ctl conformance corpus with facts and the
    // expected effects, obligations, branches and subsumed work, and contains only supported
    // branches (or explicit unsupported spellings whose plan reports a gap).
    [Fact]
    public void Derivation_corpus_matches_the_plans()
    {
        var failures = new List<string>();
        var dump = new JsonArray();
        foreach (var item in Corpus()["cases"]!.AsArray().OfType<JsonObject>())
        {
            var tool = CaseTool(item);
            var plan = OperationPlan.Derive(
                tool,
                CaseFacts(tool, item["facts"] as JsonObject),
                CaseContext(item["context"] as JsonObject)
            );
            var actual = Projection(plan);
            var named = (JsonObject)item.DeepClone();
            named["expected"] = actual.DeepClone();
            dump.Add((JsonNode?)named);
            if (!JsonNode.DeepEquals(item["expected"], actual))
                failures.Add(item["name"] + ": " + actual.ToJsonString());
        }
        if (Environment.GetEnvironmentVariable("FOXWARM_OPERATION_CORPUS_DUMP") is { Length: > 0 } path)
            File.WriteAllText(path, new JsonObject { ["cases"] = dump }.ToJsonString(new() { WriteIndented = true }));
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    // Every case names a declared branch, except the explicit unsupported spellings.
    [Fact]
    public void Derivation_corpus_names_supported_branches()
    {
        foreach (var item in Corpus()["cases"]!.AsArray().OfType<JsonObject>())
        {
            var tool = CaseTool(item);
            var declaration = OperationDeclarations.Find(tool.Source, tool.Name)!;
            var branch = item["expected"]?["branch"]?.GetValue<string>();
            if (item["unsupported"]?.GetValue<bool>() == true)
                Assert.Null(branch);
            else
                Assert.Contains(declaration.Branches, candidate => candidate.Name == branch);
        }
    }
}
