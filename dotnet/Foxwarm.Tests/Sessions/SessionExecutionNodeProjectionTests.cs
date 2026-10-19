using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionExecutionNodeProjectionTests
{
    [Theory]
    [InlineData(false, null)]
    [InlineData(true, null)]
    [InlineData(true, "retained-remote")]
    public async Task Clearing_agent_binding_refreshes_admitted_placement_before_topology_notification(
        bool hasNode,
        string? storedNode
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(work, "agents", "other", "memory"));
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "agents.json"),
            new JsonObject
            {
                ["version"] = 2,
                ["agents"] = new JsonArray("other"),
                ["metadata"] = new JsonObject
                {
                    ["main"] = new JsonObject
                    {
                        ["isolated"] = true,
                        ["isolatedNode"] = "retained-bound",
                    },
                },
            }.ToJsonString()
        );
        var originals = new Dictionary<string, string>();
        var rows = new JsonObject();
        foreach (var id in new[] { "retained", "cold-bound", "other/live", "other/cold" })
        {
            await SessionCatalogMigrationTests.Authority(data, id);
            var file = Path.Combine(data, "state", "sessions", id + ".json");
            var authority = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
            var agent = id.StartsWith("other/") ? "other" : "main";
            authority["agent"] = agent;
            authority.Remove("currentNode");
            if (id == "retained" && hasNode)
                authority["currentNode"] = storedNode;
            authority["cwd"] = work;
            authority["stats"]!["totalInputTokens"] = 17;
            originals[id] = authority.ToJsonString();
            await File.WriteAllTextAsync(file, originals[id]);
            var row = SessionCatalogTests.Row(id, 0);
            row["agent"] = agent;
            rows[id] = row;
        }
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "sessions.json"),
            new JsonObject { ["sessions"] = rows }.ToJsonString()
        );
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        var models = HostModels.ForTest(options);
        await using var manager = new SessionManager(data, work, options, models);
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        var owner = await manager.RequiredAsync("retained");
        var unrelated = await manager.RequiredAsync("other/live");
        var runtime = new SessionRuntime(manager);
        var originalAuthority = owner.Entry.Snapshot().AuthorityEnvelope;
        var unrelatedProjection = runtime.Projection(unrelated.Id);
        AssertPlacement(storedNode ?? "retained-bound");
        string? announcedNode = null;
        manager.TopologyChanged += () =>
            announcedNode = runtime.Projection(owner.Id)!["currentNode"]!.GetValue<string>();

        await manager.SetAgentNodeAsync("main", null);

        Assert.False(manager.AgentIsolated("main"));
        Assert.Null(manager.RecordedIsolationNode("main"));
        Assert.Equal(storedNode ?? "master", announcedNode);
        AssertPlacement(storedNode ?? "master");
        Assert.True(
            JsonNode.DeepEquals(originalAuthority, owner.Entry.Snapshot().AuthorityEnvelope)
        );
        Assert.True(JsonNode.DeepEquals(unrelatedProjection, runtime.Projection(unrelated.Id)));
        Assert.Equal(
            new[] { "other/live", "retained" },
            manager.Owners().Select(value => value.Id).Order().ToArray()
        );
        foreach (var (id, bytes) in originals)
            Assert.Equal(
                bytes,
                await File.ReadAllTextAsync(Path.Combine(data, "state", "sessions", id + ".json"))
            );

        void AssertPlacement(string expected)
        {
            var snapshot = owner.Entry.Snapshot();
            Assert.Equal((expected, work), manager.ExecutionPlacement(owner));
            Assert.Equal(expected, owner.BuildDto()["currentNode"]!.GetValue<string>());
            var history = WebUiContract.History(
                snapshot,
                models,
                owner.ToolActive,
                owner.Compacting,
                null,
                null,
                null,
                owner.ExecutionNode(snapshot.AuthorityEnvelope)
            );
            Assert.Equal(expected, history["session"]!["currentNode"]!.GetValue<string>());
            var stateEvent = WebUiContract.Event(
                new SessionRuntimeEvent(owner.Id, SessionEventKind.StateChanged, null),
                runtime
            );
            Assert.Equal(expected, stateEvent["session"]!["currentNode"]!.GetValue<string>());
            var listed = runtime.Projection(owner.Id)!;
            Assert.Equal(expected, listed["currentNode"]!.GetValue<string>());
            Assert.Equal(work, listed["cwd"]!.GetValue<string>());
            Assert.Equal(work, history["session"]!["cwd"]!.GetValue<string>());
        }
    }

    [Theory]
    [InlineData(false, null, null, "master")]
    [InlineData(true, null, null, "master")]
    [InlineData(false, null, "retained-bound", "retained-bound")]
    [InlineData(true, null, "retained-bound", "retained-bound")]
    [InlineData(true, "retained-remote", null, "retained-remote")]
    public async Task Retained_authority_projects_effective_execution_placement_without_a_save(
        bool hasNode,
        string? storedNode,
        string? boundNode,
        string expected
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        Directory.CreateDirectory(Path.Combine(data, "state"));
        if (boundNode is not null)
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "agents.json"),
                new JsonObject
                {
                    ["version"] = 2,
                    ["agents"] = new JsonArray(),
                    ["metadata"] = new JsonObject
                    {
                        ["main"] = new JsonObject
                        {
                            ["isolated"] = true,
                            ["isolatedNode"] = boundNode,
                        },
                    },
                }.ToJsonString()
            );
        await SessionCatalogMigrationTests.Authority(data, "retained");
        var file = Path.Combine(data, "state", "sessions", "retained.json");
        var authority = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        authority.Remove("currentNode");
        if (hasNode)
            authority["currentNode"] = storedNode;
        authority["cwd"] = work;
        authority["stats"]!["totalInputTokens"] = 17;
        var original = authority.ToJsonString();
        await File.WriteAllTextAsync(file, original);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "sessions.json"),
            new JsonObject
            {
                ["sessions"] = new JsonObject
                {
                    ["retained"] = SessionCatalogTests.Row("retained", 0),
                },
            }.ToJsonString()
        );
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        var models = HostModels.ForTest(options);
        await using var manager = new SessionManager(data, work, options, models);
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        var owner = await manager.RequiredAsync("retained");
        var snapshot = owner.Entry.Snapshot();
        Assert.Equal(expected, manager.ExecutionPlacement(owner).Node);
        Assert.Equal(work, manager.ExecutionPlacement(owner).Cwd);
        var dto = owner.BuildDto();
        Assert.Equal(expected, dto["currentNode"]!.GetValue<string>());
        Assert.Equal(work, dto["cwd"]!.GetValue<string>());
        var history = WebUiContract.History(
            snapshot,
            models,
            owner.ToolActive,
            owner.Compacting,
            null,
            null,
            null,
            owner.ExecutionNode(snapshot.AuthorityEnvelope)
        );
        Assert.Equal(expected, history["session"]!["currentNode"]!.GetValue<string>());
        var stateEvent = WebUiContract.Event(
            new SessionRuntimeEvent(owner.Id, SessionEventKind.StateChanged, null),
            new SessionRuntime(manager)
        );
        Assert.Equal(expected, stateEvent["session"]!["currentNode"]!.GetValue<string>());
        var replies = new List<string>();
        var source = new Foxwarm.Channels.ExternalChannelContext(
            "webui", "webui", owner.Id, null, null,
            text =>
            {
                replies.Add(text);
                return Task.CompletedTask;
            }
        );
        await new MessageRouter(new SessionRuntime(manager)).HandleExternalCommandAsync(
            source, "/status", null, owner
        );
        Assert.Contains($"current node: `{expected}`", replies.Single());
        Assert.Contains("connected=" + (expected == "master" ? "true" : "false"), replies.Single());
        Assert.Equal(hasNode, snapshot.AuthorityEnvelope.ContainsKey("currentNode"));
        Assert.Equal(storedNode, SessionWait.Text(snapshot.AuthorityEnvelope["currentNode"]));
        Assert.Equal(original, await File.ReadAllTextAsync(file));
        Assert.True(
            JsonNode.DeepEquals(
                snapshot.AuthorityEnvelope,
                owner.Entry.Snapshot().AuthorityEnvelope
            )
        );
    }
}
