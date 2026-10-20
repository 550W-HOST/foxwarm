using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Artifacts;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Artifact_selected_and_explicit_sources_keep_target_cwd_exact_qualified_identity_and_Main_metadata()
    {
        if (!OperatingSystem.IsLinux()) return;
        await using var f = await Fixture.Create(maximumId: true);
        await f.Seed("nested/chart.json", Encoding.UTF8.GetBytes(ArtifactStoreTests.Chart().ToJsonString()));
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        await f.Owner.UpdateCwdAsync("opaque://root/nested");
        var prepared = await f.Call("artifact", new JsonObject { ["action"] = "prepare", ["filePath"] = "chart.json" });
        Success(prepared);
        var id = SessionWait.Text(prepared["preparedArtifact"]?["artifactId"])!;
        Assert.All((await f.Requests()).Where(call => call["operation"]?.ToString() == "filesystem"), call =>
        {
            Assert.Equal("chart.json", SessionWait.Text(call["request"]?["path"]));
            Assert.Equal("opaque://root/nested", SessionWait.Text(call["request"]?["context"]?["cwd"]));
        });
        await f.Manager.SelectNodeAsync(f.Owner, "master");
        var before = (await f.Requests()).Length;
        Success(await f.Call("artifact", new JsonObject { ["action"] = "get", ["artifactId"] = id }));
        Assert.Equal(before, (await f.Requests()).Length);
        Success(await f.Call("call_tool", new JsonObject { ["toolId"] = "builtin:artifact", ["args"] = new JsonObject { ["action"] = "publish", ["node"] = f.Node, ["filePath"] = "nested/chart.json" } }));
        Assert.All((await f.Requests()).Skip(before).Where(call => call["operation"]?.ToString() == "filesystem"), call => Assert.Empty(call["request"]!["context"]!.AsObject()));
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(policy, "version: 1\ndefaultAction: allow\nrules:\n- action: deny\n  tool: {source: node, name: read}\n");
        f.Manager.Authorization.Invalidate();
        before = (await f.Requests()).Length;
        Assert.NotNull((await f.Call("artifact", new JsonObject { ["action"] = "publish", ["node"] = f.Node, ["filePath"] = "nested/chart.json" }))["error"]);
        Assert.DoesNotContain((await f.Requests()).Skip(before), call => call["operation"]?.ToString() == "filesystem");
        Assert.Equal(193, f.Node.Length);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Artifact_oversized_stat_rejects_before_any_primitive_read(bool image)
    {
        if (!OperatingSystem.IsLinux()) return;
        await using var f = await Fixture.Create();
        await f.Seed("oversized", new byte[image ? 16 * 1024 * 1024 : 8 * 1024 * 1024]);
        var args = new JsonObject { ["action"] = "publish", ["node"] = f.Node, ["filePath"] = "oversized" };
        if (image) args["type"] = "image";
        Assert.NotNull((await f.Call("artifact", args))["error"]);
        Assert.DoesNotContain(await f.Requests(), call => SessionWait.Text(call["request"]?["operation"]) == "read");
        Assert.False(Directory.Exists(Path.Combine(f.Data, "state", "artifacts")));
    }

    [Theory]
    [InlineData("normal", true)]
    [InlineData("snapshot-append", false)]
    public async Task Artifact_primitive_snapshot_preserves_initial_stat_equality_and_caps_total_requested_bytes(string mode, bool success)
    {
        if (!OperatingSystem.IsLinux()) return;
        await using var f = await Fixture.Create(mode);
        var json = ArtifactStoreTests.Chart().ToJsonString();
        await f.Seed("bounded.json", Encoding.UTF8.GetBytes(json + new string(' ', ArtifactStore.ManifestLimit - json.Length)));
        var result = await f.Call("artifact", new JsonObject { ["action"] = "publish", ["node"] = f.Node, ["filePath"] = "bounded.json" });
        Assert.Equal(success, result["error"] is null);
        var reads = (await f.Requests()).Where(call => SessionWait.Text(call["request"]?["operation"]) == "read").ToArray();
        Assert.Equal(ArtifactStore.ManifestLimit + 1, reads.Sum(call => call["request"]!["count"]!.GetValue<int>()));
        Assert.Equal(1, reads[^1]["request"]!["count"]!.GetValue<int>());
        if (!success) Assert.False(Directory.Exists(Path.Combine(f.Data, "state", "artifacts")));
    }
}
