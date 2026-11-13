using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Canonical_declarations_do_not_grant_missing_or_denied_Node_effects()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var canonical = f.Manager.ModelDefinitions(f.Owner).ToJsonString();
        await f.Manager.SelectNodeAsync(f.Owner, "fixture/readonly");
        Assert.Equal(canonical, f.Manager.ModelDefinitions(f.Owner).ToJsonString());
        var discovery = await f.Call(
            "ctl",
            CtlTestArgs.Search(new JsonObject { ["sources"] = new JsonArray("node"), ["includeSchema"] = true })
        );
        Assert.Contains(
            "--name \"read\" --node-id \"fixture/readonly\"",
            discovery["output"]!.GetValue<string>()
        );
        Assert.DoesNotContain("--name \"write\"", discovery["output"]!.GetValue<string>());
        var args = new JsonObject { ["filePath"] = "no-effect.txt", ["content"] = "forbidden" };
        var missing = await f.Call("write", args);
        Assert.Contains("Node file capability is unavailable", missing.ToJsonString());

        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: 1\nrules:\n- action: deny\n  tool: {source: node, name: write}\n  node: {provider: fixture}\n"
        );
        f.Manager.Authorization.Invalidate();
        Assert.Equal(canonical, f.Manager.ModelDefinitions(f.Owner).ToJsonString());
        discovery = await f.Call(
            "ctl",
            CtlTestArgs.Search(new JsonObject { ["sources"] = new JsonArray("node"), ["includeSchema"] = true })
        );
        Assert.DoesNotContain("--name \"write\"", discovery["output"]!.GetValue<string>());
        var before = (await f.Requests()).Length;
        var direct = await f.Call("write", args);
        Assert.Equal("tool_authorization_denied", direct["error"]!["type"]!.GetValue<string>());
        var unified = await f.Call(
            "ctl",
            CtlTestArgs.Unified(new JsonObject { ["toolId"] = "node:" + f.Node + "/write", ["args"] = args.DeepClone() })
        );
        Assert.Equal("tool_authorization_denied", unified["error"]!["type"]!.GetValue<string>());
        var script = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('write', {'filePath':'no-effect.txt','content':'forbidden'})",
            }
        );
        Assert.Equal("failed", script["status"]!.GetValue<string>());
        Assert.Contains("denies node capability", script.ToJsonString());
        Assert.DoesNotContain(
            (await f.Requests()).Skip(before),
            call => call["operation"]!.GetValue<string>() == "filesystem"
        );
        Assert.False(File.Exists(f.FilePath("no-effect.txt")));
        Assert.False(File.Exists(Path.Combine(f.Work, "no-effect.txt")));
    }
}
