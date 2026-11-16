using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;
using static Foxwarm.Tests.OperationEffectConformance;

namespace Foxwarm.Tests;

// Differential conformance (OperationEffectConformance) for secret writers, in the fixture that
// opens a secret store.
public sealed partial class AgentRulesTreeTests
{
    private static readonly Dictionary<string, Func<ExternalChannelFixture, Case>> SecretDifferentialCases = new()
    {
        ["add_secret value"] = _ =>
            new("", "add_secret", Obj("""{"name":"d-token","description":"Synthetic","value":"synthetic-differential-0303"}""")),
    };

    public static TheoryData<string> SecretDifferentialCaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in SecretDifferentialCases.Keys)
            data.Add(name);
        return data;
    }

    [Theory]
    [MemberData(nameof(SecretDifferentialCaseNames))]
    public async Task Secret_operation_plans_match_what_handlers_do(string name)
    {
        await using var f = await ConfigurationFixture();
        var @case = SecretDifferentialCases[name](f) with { Name = name };
        await f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(OperationEffectConformance.Policy), default);
        var files = new WorkspaceTools(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory);
        var problems = await Run(
            @case,
            f.Manager,
            f.Owner,
            (tool, args) => f.Manager.AssessToolAsync(f.Owner, f.Registry.Resolve(tool, args), files, default),
            (tool, args) => f.ToolAsync(tool, args),
            [],
            f.Configuration.Secrets.Store
        );
        Assert.True(problems.Count == 0, name + ":\n" + string.Join("\n", problems));
    }
}
