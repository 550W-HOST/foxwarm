using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AnthropicHostedSearchTests
{
    [Fact]
    public async Task Actual_model_switch_notice_abandons_search_and_later_local_work_can_compact()
    {
        SessionOwner? owner = null;
        var beforeCompact = 0;
        var failures = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(
            10,
            async (index, stream, request) =>
            {
                try
                {
                    var body = Obj(request.Body);
                    if (index == 0)
                    {
                        await Respond(
                            stream,
                            Reply("tool_use", Search("pending-before-switch"), LocalTask()),
                            false
                        );
                        return;
                    }
                    Assert.DoesNotContain("server_tool_use", body["messages"]!.ToJsonString());
                    if (index < 8)
                    {
                        Assert.Equal("other", body["model"]!.ToString());
                        Assert.Contains("session-settings-changed", request.Body);
                        await Respond(
                            stream,
                            Reply("tool_use", Text(new string('x', 3000)), LocalTask()),
                            false
                        );
                        return;
                    }
                    Assert.Equal("wire", body["model"]!.ToString());
                    if (index == 8)
                    {
                        // The old raw call remains stored. Switching back must not
                        // resurrect it after the production selection notice.
                        Assert.Contains(
                            owner!.History(),
                            row => row.ToJsonString().Contains("pending-before-switch")
                        );
                        beforeCompact = body["messages"]!.ToJsonString().Length;
                        var candidates = CompactCandidateBuilder
                            .Build(owner.History(), inContext: true)
                            .Items;
                        var plan = new JsonObject
                        {
                            ["inContext"] = true,
                            ["replaceAsBlocks"] = new JsonArray(
                                new JsonObject
                                {
                                    ["level"] = 1,
                                    ["sourceKind"] = "message",
                                    ["sourceStart"] = candidates[0].Start,
                                    ["sourceEnd"] = candidates[^1].End,
                                    ["summary"] = "Long autonomous work summarized.",
                                }
                            ),
                        };
                        await Respond(
                            stream,
                            Reply(
                                "tool_use",
                                new JsonObject
                                {
                                    ["type"] = "tool_use",
                                    ["id"] = "compact",
                                    ["name"] = "submit_compact_plan",
                                    ["input"] = plan,
                                }
                            ),
                            false
                        );
                        return;
                    }
                    Assert.Contains("Long autonomous work summarized.", request.Body);
                    Assert.True(body["messages"]!.ToJsonString().Length < beforeCompact / 2);
                    await Respond(stream, Reply("end_turn", Text("Complete.")), false);
                }
                catch (Exception error)
                {
                    failures.TrySetException(error);
                    throw;
                }
            }
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), "vector: false\n");
        var config = Obj(
            """{"default":"a/wire","providers":{"a":{"providerType":"anthropic","webSearch":true,"contextLimit":200000,"asyncCompact":false,"extraFields":{"stream":false},"models":["wire"]},"b":{"providerType":"anthropic","webSearch":true,"contextLimit":200000,"asyncCompact":false,"extraFields":{"stream":false},"models":["other"]}}}"""
        );
        foreach (var provider in config["providers"]!.AsObject())
            provider.Value!["baseUrl"] = new Uri(peer.BaseUri, "/").ToString();
        var models = HostModels.Parse(config, new JsonObject());
        await using var manager = new SessionManager(
            data,
            Path.Combine(temp.Path, "work"),
            new(peer.BaseUri, "wire", "a/wire", "", "", 1000),
            models
        );
        await manager.LoadMainHostAsync();
        owner = await manager.CreateNamedAsync("main", "switching", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var committed = 0;
        owner.Entry.AssistantCommitted = async _ =>
        {
            committed++;
            if (committed == 1)
                await owner.UpdateModelAsync(Obj("""{"model":"b/other"}"""));
            if (committed == 8)
                await owner.UpdateModelAsync(Obj("""{"model":"a/wire"}"""));
        };
        await owner.Registry.Ingress.EnqueueAsync(
            owner.Id,
            QueueItem.UserText("Perform autonomous work.")
        );
        var processing = owner.Registry.Runner.ProcessQueueAsync(owner.Id);
        await Task.WhenAny(processing, failures.Task).WaitAsync(TimeSpan.FromSeconds(15));
        if (failures.Task.IsCompleted)
            await failures.Task;
        await processing;
        Assert.Equal(10, peer.RequestCount);
        Assert.Equal(1, owner.Entry.Snapshot().HistoryVersion);
        Assert.Contains(
            owner.Archive.ReadMessages(),
            row => row.Message.ToJsonString().Contains("pending-before-switch")
        );
        await manager.ShutdownAsync();
    }
}
