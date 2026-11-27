using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task A_skill_copies_to_the_current_provider_Node_under_its_write_rules_and_never_to_master()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        var skill = Path.Combine(f.Manager.AgentDirectory("main"), "skills", "tools");
        Directory.CreateDirectory(Path.Combine(skill, "scripts"));
        await File.WriteAllTextAsync(Path.Combine(skill, "SKILL.md"), "---\ndescription: Tools.\n---\n");
        await File.WriteAllTextAsync(Path.Combine(skill, "scripts", "x.py"), "print('x')\n");
        // Current-Node tools and the skill tool only: no master read and no master write.
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: { current: true }\n- action: allow\n  match: { tool: { source: builtin, name: skill } }\n"
        );
        f.Manager.Authorization.Invalidate();
        var definitions = WorkspaceTools.Definitions();
        foreach (var item in KnowledgeToolDefinitions.Definitions().Concat(UnifiedToolDefinitions.All()))
            definitions.Add(item?.DeepClone());
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => f.Work, f.Manager.Nodes, f.Manager.NodeProviders);
        var tools = new SessionToolExecutor(new WorkspaceTools(f.Work), f.Owner, f.Manager, registry);
        tools.BeginTurn();
        async Task<JsonObject> Ctl(string command) =>
            (
                await tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "copy",
                        ["name"] = "ctl",
                        ["args"] = new JsonObject { ["command"] = command },
                    },
                    default
                )
            )!.AsObject();

        var copied = await Ctl("skill copy tools copied");
        Success(copied);
        Assert.Equal(f.Node, copied["node"]!.GetValue<string>());
        Assert.Equal(2, copied["files"]!.AsArray().Count);
        Assert.Equal("print('x')\n", await File.ReadAllTextAsync(f.FilePath("copied/scripts/x.py")));
        Assert.StartsWith("---\ndescription: Tools.", await File.ReadAllTextAsync(f.FilePath("copied/SKILL.md")));

        var before = (await f.Requests()).Length;
        var denied = await Ctl("skill copy tools copied-main --node master");
        Assert.NotNull(denied["error"]);
        Assert.Equal(before, (await f.Requests()).Length);
        Assert.False(Directory.Exists(Path.Combine(f.Manager.AgentDirectory("main"), "copied-main")));
        Assert.False(Directory.Exists(Path.Combine(f.Work, "copied-main")));
    }
}
