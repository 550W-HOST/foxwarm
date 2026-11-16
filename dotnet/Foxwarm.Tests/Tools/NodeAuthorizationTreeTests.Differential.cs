using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;
using static Foxwarm.Tests.OperationEffectConformance;

namespace Foxwarm.Tests;

// Differential conformance (OperationEffectConformance) for Node trust capabilities.
public sealed partial class NodeAuthorizationTreeTests
{
    private static JsonObject PairingRequest(Fixture f, string name) =>
        f.Manager.Nodes.Registry.Request(
            new JsonObject
            {
                ["nodeType"] = "cli-node",
                ["requestedName"] = name,
                ["capabilities"] = new JsonObject { ["tools"] = new JsonArray() },
            },
            NodeConnectionHub.Protocol(new())
        );

    private static readonly Dictionary<string, Func<Fixture, Case>> NodeDifferentialCases = new()
    {
        ["node_pair_approve default ID"] = f =>
            new("", "node_pair_approve", new JsonObject { ["pendingId"] = PairingRequest(f, "d-paired")["id"]!.DeepClone() }),
        ["node_pair_approve suffixed default ID"] = f =>
        {
            f.Manager.Nodes.Registry.Create("d-taken");
            return new("", "node_pair_approve", new JsonObject { ["pendingId"] = PairingRequest(f, "d-taken")["id"]!.DeepClone() });
        },
        ["node_pair_approve explicit ID"] = f =>
            new(
                "",
                "node_pair_approve",
                new JsonObject { ["pendingId"] = PairingRequest(f, "d-ignored")["id"]!.DeepClone(), ["nodeId"] = "d-explicit" }
            ),
        ["node_remove leaf"] = f =>
        {
            f.Manager.Nodes.Registry.Create("d-leaf");
            return new("", "node_remove", Obj("""{"nodeId":"d-leaf"}"""));
        },
        ["node_remove cascade"] = f =>
        {
            f.Manager.Nodes.Registry.Create("d-root");
            f.Manager.Nodes.Registry.Create("d-child", "d-root");
            f.Manager.Nodes.Registry.Create("d-grandchild", "d-child");
            return new("", "node_remove", Obj("""{"nodeId":"d-root","cascade":true}"""));
        },
    };

    public static TheoryData<string> NodeDifferentialCaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in NodeDifferentialCases.Keys)
            data.Add(name);
        return data;
    }

    [Theory]
    [MemberData(nameof(NodeDifferentialCaseNames))]
    public async Task Node_operation_plans_match_what_handlers_do(string name)
    {
        await using var f = await Fixture.Create();
        var @case = NodeDifferentialCases[name](f) with { Name = name };
        await f.Policy(OperationEffectConformance.Policy);
        var files = new WorkspaceTools(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory);
        var problems = await Run(
            @case,
            f.Manager,
            f.Owner,
            (tool, args) => f.Manager.AssessToolAsync(f.Owner, f.Registry.Resolve(tool, args), files, default),
            (tool, args) => f.Call(tool, args),
            []
        );
        Assert.True(problems.Count == 0, name + ":\n" + string.Join("\n", problems));
    }
}
