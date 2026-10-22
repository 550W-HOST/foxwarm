using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class AgentSnapshotParityTests
{
    [Fact]
    public async Task Registered_refresh_preserves_virtual_deferral_and_a_recorded_concrete_identity_without_selecting_a_route()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "one", "a", "", "", 713);
        var models = HostModels.Parse(JsonNode.Parse("""
            {"default":"a/one","providers":{
              "a":{"providerType":"openai-responses","models":["one"]},
              "b":{"providerType":"openai-responses","models":["two"]},
              "v":{"providerType":"session-hash","targets":["a/one","b/two"]}
            }}
            """)!.AsObject(), new JsonObject());
        await using var manager = new SessionManager(Path.Combine(temp.Path, "data"), work, options, models);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "virtual-owner", null, new JsonObject { ["modelId"] = "v" });
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in AgentToolDefinitions.Definitions())
            definitions.Add(definition.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, manager.OutboundMcp, _ => work);
        var executor = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        executor.BeginTurn();
        var memory = Path.Combine(manager.AgentDirectory("main"), "memory", "REFRESH.md");
        Directory.CreateDirectory(Path.GetDirectoryName(memory)!);
        await File.WriteAllTextAsync(memory, "fresh deferred content");
        var before = await File.ReadAllTextAsync(owner.AuthorityStore.AuthorityPath);
        var response = await executor.ExecuteAsync(new JsonObject
        {
            ["id"] = "refresh-deferred", ["name"] = "refresh_session_snapshot",
            ["args"] = new JsonObject { ["sessionId"] = owner.Id },
        }, default);
        Assert.Null(response!["error"]);
        Assert.Equal("", owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString());
        Assert.Equal(before, await File.ReadAllTextAsync(owner.AuthorityStore.AuthorityPath));
        // A previously materialized virtual owner keeps the last actual leaf identity on refresh.
        await owner.Entry.SaveLane.CommitMemorySnapshotAsync(ConditionalMemory.BuildCurrentModelSnapshot("b/two", "old content"));
        response = await executor.ExecuteAsync(new JsonObject
        {
            ["id"] = "refresh-materialized", ["name"] = "refresh_session_snapshot", ["args"] = new JsonObject(),
        }, default);
        Assert.Null(response!["error"]);
        var snapshot = owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString();
        Assert.Equal("b/two", ConditionalMemory.ReadCurrentModelSnapshotId(snapshot));
        Assert.Contains("fresh deferred content", snapshot);
        Assert.DoesNotContain("old content", snapshot);
        Assert.Equal("v", owner.Entry.Snapshot().AuthorityEnvelope["model"]!.ToString());
        Assert.Empty(owner.Entry.Snapshot().History);
    }
}
