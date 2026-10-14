using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionExecutionNodeProjectionTests
{
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
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
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
        Assert.Equal(hasNode, snapshot.AuthorityEnvelope.ContainsKey("currentNode"));
        Assert.Equal(storedNode, SessionWait.Text(snapshot.AuthorityEnvelope["currentNode"]));
        Assert.Equal(original, await File.ReadAllTextAsync(file));
        Assert.True(JsonNode.DeepEquals(snapshot.AuthorityEnvelope, owner.Entry.Snapshot().AuthorityEnvelope));
    }
}
