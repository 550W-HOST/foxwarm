using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;
using static Foxwarm.Tests.OperationEffectConformance;

namespace Foxwarm.Tests;

// Differential conformance (OperationEffectConformance) for secret and MCP configuration writers,
// in the fixture that opens a secret store.
public sealed partial class AgentRulesTreeTests
{
    private static readonly Dictionary<string, Func<ExternalChannelFixture, Case>> SecretDifferentialCases = new()
    {
        ["add_secret value"] = _ =>
            new("", "add_secret", Obj("""{"name":"d-token","description":"Synthetic","value":"synthetic-differential-0303"}""")),
        ["mcp_config"] = _ =>
            new("", "mcp_config", Obj("""{"name":"d-server","url":"http://127.0.0.1:1/mcp","enable":false}""")),
    };

    public static TheoryData<string> SecretDifferentialCaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in SecretDifferentialCases.Keys)
            data.Add(name);
        return data;
    }

    // Each case, then each whitespace-padded variant of its identifier arguments, each in a
    // fresh fixture.
    [Theory]
    [MemberData(nameof(SecretDifferentialCaseNames))]
    public async Task Secret_operation_plans_match_what_handlers_do(string name)
    {
        var (problems, built) = await RunSecretDifferential(name, @case => @case);
        for (var index = 0; index < Padded(built).Count(); index++)
        {
            var variant = index;
            var (variantProblems, _) = await RunSecretDifferential(name, @case => Padded(@case).ElementAt(variant));
            problems.AddRange(variantProblems);
        }
        Assert.True(problems.Count == 0, name + ":\n" + string.Join("\n", problems));
    }

    private static async Task<(List<string>, Case)> RunSecretDifferential(string name, Func<Case, Case> transform)
    {
        await using var f = await ConfigurationFixture();
        var @case = transform(SecretDifferentialCases[name](f) with { Name = name });
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
        return (problems.Select(problem => "[" + @case.Name + "] " + problem).ToList(), @case);
    }
}
