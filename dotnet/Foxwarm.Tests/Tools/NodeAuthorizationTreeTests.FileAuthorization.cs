using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class NodeAuthorizationTreeTests
{
    private static async Task<JsonObject[]> ProviderRequests(Fixture fixture)
    {
        var path = Path.Combine(fixture.Target, "calls.jsonl");
        return File.Exists(path) ? (await File.ReadAllLinesAsync(path)).Select(Obj).ToArray() : [];
    }

    private static async Task NoProviderFileEffects(Fixture fixture) =>
        Assert.DoesNotContain(
            await ProviderRequests(fixture),
            call => call["operation"]!.GetValue<string>() == "filesystem"
        );

    [Fact]
    public async Task Cold_compound_copy_target_obeys_global_ancestor_deny_before_writing_and_keeps_compound_only_permission()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var caller = await f.Child();
        const string contents = "owned-cold-inventory-copy-proof";
        var source = Path.Combine(f.Work, "source.txt");
        await File.WriteAllTextAsync(source, contents);
        JsonObject Copy(string target) =>
            new()
            {
                ["sourceNode"] = "master",
                ["sourcePath"] = source,
                ["targetNode"] = "fixture/target",
                ["targetPath"] = target,
            };
        await f.Policy(
            "version: 1\nrules: [{tool: copy_between_nodes, node: parent, action: deny}]\n"
        );
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/target"));
        Denied(await f.Call("copy_between_nodes", Copy("cold.txt"), caller));
        Assert.Equal("parent", f.Manager.Nodes.Registry.Forest().Parent("fixture/target"));
        Assert.False(File.Exists(Path.Combine(f.Target, "fs", "root", "cold.txt")));
        await NoProviderFileEffects(f);
        Denied(await f.Call("copy_between_nodes", Copy("warm-denied.txt"), caller));
        await NoProviderFileEffects(f);
        // The compound builtin grant covers both endpoints in one rule; ordinary read/write
        // remain denied and are not substituted for this operation's permission.
        await f.Policy(
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: copy_between_nodes, node: [master, parent], action: allow}
            """
        );
        Success(await f.Call("copy_between_nodes", Copy("permitted.txt"), caller));
        Assert.Equal(
            contents,
            await File.ReadAllTextAsync(Path.Combine(f.Target, "fs", "root", "permitted.txt"))
        );
        Assert.Contains(
            await ProviderRequests(f),
            call => call["request"]?["operation"]?.GetValue<string>() == "write"
        );
    }

    [Fact]
    public async Task Cold_compound_copy_source_obeys_ancestor_Agent_deny_before_any_provider_read()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var caller = await f.Child();
        const string contents = "owned-protected-source-proof";
        var root = Path.Combine(f.Target, "fs", "root");
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, "source.txt"), contents);
        JsonObject Copy(string target) =>
            new()
            {
                ["sourceNode"] = "fixture/target",
                ["sourcePath"] = "source.txt",
                ["targetNode"] = "master",
                ["targetPath"] = Path.Combine(f.Work, target),
            };
        await f.Manager.SetAgentRulesAsync(
            "main",
            Rules("""[{"tool":"copy_between_nodes","node":"parent","action":"deny"}]""")
        );
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/target"));
        Denied(await f.Call("copy_between_nodes", Copy("cold.txt"), caller));
        Assert.False(File.Exists(Path.Combine(f.Work, "cold.txt")));
        await NoProviderFileEffects(f);
        Denied(await f.Call("copy_between_nodes", Copy("warm-denied.txt"), caller));
        await NoProviderFileEffects(f);
        await f.Manager.SetAgentRulesAsync("main", new JsonArray());
        Success(await f.Call("copy_between_nodes", Copy("permitted.txt"), caller));
        Assert.Equal(contents, await File.ReadAllTextAsync(Path.Combine(f.Work, "permitted.txt")));
        Assert.Contains(
            await ProviderRequests(f),
            call => call["request"]?["operation"]?.GetValue<string>() == "read"
        );
    }

    [Fact]
    public async Task Cold_image_export_applies_its_builtin_ancestor_policy_before_provider_write()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var caller = await f.Child();
        var bytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png);
        var image = await f.Manager.Images.PutAsync(bytes, "image/png", "owned-export-image");
        await ForkClearLifecycleTests.AppendAsync(
            caller,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["inlineDataRef"] = image }),
            }
        );
        JsonObject Export(string path) =>
            new()
            {
                ["id"] = "owned-export-image",
                ["filePath"] = path,
                ["node"] = "fixture/target",
            };
        await f.Policy(
            "version: 1\nrules: [{tool: image_write_to_file, node: parent, action: deny}]\n"
        );
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/target"));
        Denied(await f.Call("image_write_to_file", Export("cold.png"), caller));
        Assert.False(File.Exists(Path.Combine(f.Target, "fs", "root", "cold.png")));
        await NoProviderFileEffects(f);
        Denied(await f.Call("image_write_to_file", Export("warm-denied.png"), caller));
        await NoProviderFileEffects(f);
        await f.Policy("version: 1\nrules: []\n");
        Success(await f.Call("image_write_to_file", Export("permitted.png"), caller));
        Assert.Equal(
            bytes,
            await File.ReadAllBytesAsync(Path.Combine(f.Target, "fs", "root", "permitted.png"))
        );
    }

    [Fact]
    public async Task Cold_file_backed_ToolScript_read_denial_prevents_source_reads_and_interpreter_effects()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var caller = await f.Child();
        var root = Path.Combine(f.Target, "fs", "root");
        Directory.CreateDirectory(root);
        var marker = Path.Combine(f.Work, "evaluated.txt");
        var source =
            "call_tool('node:master/write', {'filePath': "
            + JsonSerializer.Serialize(marker)
            + ", 'content': 'evaluated'})\nreturn 'owned-protected-source-proof'";
        await File.WriteAllTextAsync(Path.Combine(root, "source.py"), source);
        var args = Obj("""{"filePath":"source.py","node":"fixture/target"}""");
        await f.Policy("version: 1\nrules: [{tool: read, node: parent, action: deny}]\n");
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/target"));
        var cold = await f.Call("run_script", args, caller);
        Denied(cold);
        Assert.DoesNotContain("owned-protected-source-proof", cold!.ToJsonString());
        Assert.False(File.Exists(marker));
        await NoProviderFileEffects(f);
        Denied(await f.Call("run_script", args, caller));
        Assert.False(File.Exists(marker));
        await NoProviderFileEffects(f);
        await f.Policy("version: 1\nrules: []\n");
        var permitted = await f.Call("run_script", args, caller);
        Success(permitted);
        Assert.Equal("completed", permitted!["status"]!.GetValue<string>());
        Assert.Contains("owned-protected-source-proof", permitted.ToJsonString());
        Assert.Equal("evaluated", await File.ReadAllTextAsync(marker));
        Assert.Contains(
            await ProviderRequests(f),
            call => call["request"]?["operation"]?.GetValue<string>() == "read"
        );
    }
}
