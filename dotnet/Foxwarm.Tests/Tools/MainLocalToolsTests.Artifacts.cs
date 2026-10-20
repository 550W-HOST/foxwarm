using System.Text.Json.Nodes;
using Foxwarm.Artifacts;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class MainLocalToolsTests
{
    [Fact]
    public async Task Artifacts_use_captured_Main_cwd_and_natural_direct_unified_and_native_ToolScript_results()
    {
        await using var f = await Fixture.Create();
        var cwd = Path.Combine(f.Temp.Path, "source-cwd");
        Directory.CreateDirectory(cwd);
        await File.WriteAllTextAsync(Path.Combine(cwd, "manifest.json"), ArtifactStoreTests.Chart().ToJsonString());
        await f.Owner.UpdateCwdAsync(cwd);
        var prepared = await f.Call("artifact", new JsonObject { ["action"] = "prepare", ["filePath"] = "manifest.json" });
        Assert.Null(prepared["error"]);
        Assert.Null(prepared["artifact"]);
        Assert.True(ArtifactStore.ValidReceipt(prepared["preparedArtifact"]));
        var id = SessionWait.Text(prepared["preparedArtifact"]?["artifactId"])!;
        Assert.Contains(id, SessionWait.Text(prepared["marker"])!);
        var publish = await f.Call("call_tool", new JsonObject { ["toolId"] = "builtin:artifact", ["args"] = new JsonObject { ["action"] = "publish", ["filePath"] = "manifest.json", ["artifactId"] = id, ["expectedRevision"] = 1 } });
        Assert.Null(publish["error"]);
        Assert.True(ArtifactStore.ValidReceipt(publish["artifact"]));
        var script = await f.Call("run_script", new JsonObject { ["code"] = "return call_tool('artifact', {'action':'prepare','filePath':'manifest.json'})" });
        Assert.Null(script["error"]);
        Assert.Equal("completed", SessionWait.Text(script["status"]));
        Assert.True(ArtifactStore.ValidReceipt(script["result"]?["preparedArtifact"]));
        var get = await f.Call("artifact", new JsonObject { ["action"] = "get", ["artifactId"] = id, ["revision"] = 1 });
        Assert.Null(get["error"]);
        Assert.Null(get["artifact"]);
        Assert.Equal(1, SessionWait.Number(JsonNode.Parse(SessionWait.Text(get["output"])!)!["revision"]));
        // Generic file policy and independent concrete read policy are both required.
        var policy = Path.Combine(f.Temp.Path, "data", "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(policy, "version: 1\ndefaultAction: allow\nrules:\n- action: deny\n  tool: { source: node, name: read }\n");
        f.Manager.Authorization.Invalidate();
        var before = Directory.GetDirectories(Path.Combine(f.Temp.Path, "data", "state", "artifacts")).Length;
        Assert.NotNull((await f.Call("artifact", new JsonObject { ["action"] = "publish", ["filePath"] = "manifest.json" }))["error"]);
        Assert.Equal(before, Directory.GetDirectories(Path.Combine(f.Temp.Path, "data", "state", "artifacts")).Length);
        Assert.Null((await f.Call("artifact", new JsonObject { ["action"] = "get", ["artifactId"] = id }))["error"]);
        Assert.NotNull((await f.Call("artifact", new JsonObject { ["action"] = "get", ["artifactId"] = id, ["node"] = "master" }))["error"]);
    }

    [Fact]
    public async Task Main_source_limit_is_inclusive_and_over_limit_source_never_publishes()
    {
        await using var f = await Fixture.Create();
        var file = Path.Combine(f.Manager.AgentDirectory("main"), "bounded.json");
        var document = ArtifactStoreTests.Chart().ToJsonString();
        await File.WriteAllTextAsync(file, document + new string(' ', ArtifactStore.ManifestLimit - document.Length));
        var args = new JsonObject { ["action"] = "publish", ["filePath"] = file };
        Assert.Null((await f.Call("artifact", args))["error"]);
        await File.AppendAllTextAsync(file, " ");
        Assert.NotNull((await f.Call("artifact", args))["error"]);
        Assert.Single(Directory.GetDirectories(Path.Combine(f.Temp.Path, "data", "state", "artifacts")));
    }

    [Fact]
    public async Task Artifact_is_discoverable_but_not_injected_and_get_has_no_file_source()
    {
        using var temp = new TempDirectory();
        // Registration checks structure/placement, not the coordinator-owned editorial copy.
        await using var mcp = new Foxwarm.McpClient(temp.Path);
        var registry = SessionToolExecutor.CreateRegistry(new JsonArray(ArtifactToolDefinition.Definition()), mcp, _ => temp.Path);
        Assert.DoesNotContain(registry.ModelDefinitions(), value => SessionWait.Text(value?["name"]) == "artifact");
        Assert.Contains(registry.Entries, value => SessionWait.Text(value.Definition["name"]) == "artifact");
        Assert.Equal("master", registry.Resolve("artifact", new JsonObject { ["action"] = "get" }, "selected").ExecutionNode);
        Assert.Equal("selected", registry.Resolve("artifact", new JsonObject { ["action"] = "prepare" }, "selected").ExecutionNode);
        Assert.Equal("explicit/source", registry.Resolve("call_tool", new JsonObject { ["toolId"] = "builtin:artifact", ["args"] = new JsonObject { ["action"] = "publish", ["node"] = "explicit/source" } }, "selected").ExecutionNode);
    }
}
