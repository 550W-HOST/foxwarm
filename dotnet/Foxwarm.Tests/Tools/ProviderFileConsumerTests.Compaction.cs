using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Compact_plan_files_use_selected_provider_cwd_and_remain_repairable_by_ordinary_tools()
    {
        await using var f = await Fixture.Create();
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        await f.Owner.UpdateCwdAsync("opaque://root/plans");
        var files = new CompactPlanFiles(
            f.Manager,
            f.Owner,
            f.Node,
            "opaque://root/plans",
            f.Manager.IdentityWorkspace(f.Owner)
        );
        var original = "{\n\"replaceAsBlocks\": [" + new string(' ', 80000);
        var path = await files.SaveAsync(original, default);
        Assert.StartsWith(".temp/compact-plan-", path);
        Assert.Equal(original, await files.ReadAsync(path, default));
        Success(
            await f.Call(
                "edit",
                new JsonObject
                {
                    ["filePath"] = path,
                    ["oldText"] = "[" + new string(' ', 80000),
                    ["newText"] = "[]}",
                }
            )
        );
        var parsed = CompactPlanInput.ParseFile(await files.ReadAsync(path, default));
        Assert.Empty(parsed["replaceAsBlocks"]!.AsArray());
        var requests = await f.Requests();
        Assert.All(
            requests.Where(call => call["request"]?["operation"] is not null),
            call =>
                Assert.Equal(
                    "opaque://root/plans",
                    SessionWait.Text(call["request"]?["context"]?["cwd"])
                )
        );
        Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp")));

        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: 1\nrules: [{id: deny-read, action: deny, match: {tool: {source: node, name: read}}}]\n"
        );
        f.Manager.Authorization.Invalidate();
        await Assert.ThrowsAsync<Foxwarm.Tools.ToolAuthorizationDeniedException>(() =>
            files.ReadAsync(path, default)
        );
    }
}
