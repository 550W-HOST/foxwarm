using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class AgentSnapshotParityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Failed_snapshot_write_blocks_a_changed_leaf_but_stale_refresh_keeps_the_previous_prompt(bool stale)
    {
        using var temp = new TempDirectory();
        await using var peer = await StreamingModelPeer.StartAsync(false, (context, _) => context.Send(
            JsonNode.Parse("""{"type":"response.completed","response":{"id":"snapshot-proof","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Snapshot policy observed."}]}],"usage":{"input_tokens":1,"output_tokens":1}}}""")!.AsObject()));
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var options = new ResponsesClientOptions(peer.Uri, "one", "a", "", "", 713);
        var models = HostModels.Parse(new JsonObject
        {
            ["default"] = "a",
            ["providers"] = new JsonObject
            {
                ["a"] = new JsonObject { ["providerType"] = "openai-responses", ["baseUrl"] = peer.Uri.ToString(), ["models"] = new JsonArray("one") },
                ["b"] = new JsonObject { ["providerType"] = "openai-responses", ["baseUrl"] = peer.Uri.ToString(), ["models"] = new JsonArray("two") },
            },
        }, new JsonObject());
        string authority;
        string memory;
        string previous;
        await using (var seed = new SessionManager(data, work, options, models))
        {
            await seed.LoadAsync();
            var owner = await seed.CreateNamedAsync("main", "turn", null, null);
            authority = owner.AuthorityStore.AuthorityPath;
            memory = Path.Combine(seed.MemoryDirectory("main"), "PROOF.md");
            Directory.CreateDirectory(Path.GetDirectoryName(memory)!);
            await File.WriteAllTextAsync(memory, "Previous committed prompt.");
            await seed.RefreshSnapshotAsync(owner);
            previous = owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.GetValue<string>();
        }
        // Persisted old recency is ordinary startup input; do not mutate a hot owner behind its lane.
        var document = JsonNode.Parse(await File.ReadAllTextAsync(authority))!;
        document["meta"]!["lastMessageTime"] = stale ? 1 : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await File.WriteAllTextAsync(authority, document.ToJsonString());
        await File.WriteAllTextAsync(memory, "Fresh uncommitted prompt.");
        var failures = 0;
        await using var manager = new SessionManager(data, work, options, models,
            authorityStageHook: (_, stage) =>
            {
                if (stage != AtomicJsonWriteStage.BeforeRename || failures != 0)
                    return;
                // Select the proposed snapshot contents at the actual atomic writer, without runtime operation tags.
                var candidate = Directory.GetFiles(Path.GetDirectoryName(authority)!, Path.GetFileName(authority) + ".tmp-*").Single();
                var payload = JsonNode.Parse(File.ReadAllText(candidate))!;
                if (payload["persistentMemorySnapshot"]!.GetValue<string>() == previous)
                    return;
                failures++;
                throw new IOException("Owned snapshot precommit failure.");
            });
        await manager.LoadAsync();
        var target = await manager.RequiredAsync("turn");
        if (!stale)
            await target.Entry.SaveLane.CommitSettingsAsync(new JsonObject { ["model"] = "b" }, models);
        await target.Registry.Ingress.EnqueueAsync(target.Id, QueueItem.UserText("Actual prompt dispatch."));
        await target.Registry.Runner.ProcessQueueAsync(target.Id);
        Assert.Equal(1, failures);
        Assert.Equal(stale ? 1 : 0, peer.Requests.Count);
        Assert.Equal(previous, target.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.GetValue<string>());
        Assert.Equal(previous, JsonNode.Parse(await File.ReadAllTextAsync(authority))!["persistentMemorySnapshot"]!.GetValue<string>());
        if (stale)
        {
            Assert.NotNull(target.SnapshotRefreshWarning);
            Assert.Contains("Previous committed prompt.", peer.Requests.Single().ToJsonString());
            Assert.DoesNotContain("Fresh uncommitted prompt.", peer.Requests.Single().ToJsonString());
        }
        else
            Assert.NotNull(target.Entry.LastBackgroundProcessorFailure);
    }

    [Fact]
    public async Task Registered_refresh_preserves_virtual_deferral_and_a_recorded_concrete_identity_without_selecting_a_route()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "one",
            "a",
            "",
            "",
            713
        );
        var models = HostModels.Parse(
            JsonNode
                .Parse(
                    """
                    {"default":"a/one","providers":{
                      "a":{"providerType":"openai-responses","models":["one"]},
                      "b":{"providerType":"openai-responses","models":["two"]},
                      "v":{"providerType":"session-hash","targets":["a/one","b/two"]}
                    }}
                    """
                )!
                .AsObject(),
            new JsonObject()
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            work,
            options,
            models
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync(
            "main",
            "virtual-owner",
            null,
            new JsonObject { ["modelId"] = "v" }
        );
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in AgentToolDefinitions.Definitions())
            definitions.Add(definition.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            manager.OutboundMcp,
            _ => work
        );
        var executor = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        executor.BeginTurn();
        var memory = Path.Combine(manager.AgentDirectory("main"), "memory", "REFRESH.md");
        Directory.CreateDirectory(Path.GetDirectoryName(memory)!);
        await File.WriteAllTextAsync(memory, "fresh deferred content");
        var before = await File.ReadAllTextAsync(owner.AuthorityStore.AuthorityPath);
        var response = await executor.ExecuteAsync(
            new JsonObject
            {
                ["id"] = "refresh-deferred",
                ["name"] = "refresh_session_snapshot",
                ["args"] = new JsonObject { ["sessionId"] = owner.Id },
            },
            default
        );
        Assert.Null(response!["error"]);
        Assert.Equal(
            "",
            owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString()
        );
        Assert.Equal(before, await File.ReadAllTextAsync(owner.AuthorityStore.AuthorityPath));
        // A previously materialized virtual owner keeps the last actual leaf identity on refresh.
        await owner.Entry.SaveLane.CommitMemorySnapshotAsync(
            ConditionalMemory.BuildCurrentModelSnapshot("b/two", "old content")
        );
        response = await executor.ExecuteAsync(
            new JsonObject
            {
                ["id"] = "refresh-materialized",
                ["name"] = "refresh_session_snapshot",
                ["args"] = new JsonObject(),
            },
            default
        );
        Assert.Null(response!["error"]);
        var snapshot = owner.Entry.Snapshot().AuthorityEnvelope[
            "persistentMemorySnapshot"
        ]!.ToString();
        Assert.Equal("b/two", ConditionalMemory.ReadCurrentModelSnapshotId(snapshot));
        Assert.Contains("fresh deferred content", snapshot);
        Assert.DoesNotContain("old content", snapshot);
        Assert.Equal("v", owner.Entry.Snapshot().AuthorityEnvelope["model"]!.ToString());
        Assert.Empty(owner.Entry.Snapshot().History);
    }
}
