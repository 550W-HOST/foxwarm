using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class UsageOverviewTests
{
    private const string PricedBody =
        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}],\"usage\":{\"input_tokens\":10,\"input_tokens_details\":{\"cached_tokens\":8},\"output_tokens\":5}}}\n\n";

    private static JsonObject Document(Uri uri) =>
        new()
        {
            ["default"] = "priced/wire",
            ["providers"] = new JsonObject
            {
                ["priced"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = uri.ToString(),
                    ["models"] = new JsonArray(
                        new JsonObject
                        {
                            ["id"] = "wire",
                            ["pricing"] = new JsonObject
                            {
                                ["cached"] = 1,
                                ["input"] = 2,
                                ["output"] = 3,
                            },
                        }
                    ),
                },
            },
        };

    private static JsonObject Group(JsonObject result, string kind, string? key) =>
        result["groups"]!
            .AsArray()
            .Select(row => row!.AsObject())
            .Single(row =>
                SessionCatalog.Text(row["kind"]) == kind && SessionCatalog.Text(row["key"]) == key
            );

    private static long Requests(JsonObject group) =>
        group["usage"]!["requests"]!.GetValue<long>();

    [Fact]
    public async Task Ledger_groups_live_requests_by_tree_session_agent_and_pools_deleted_sessions()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            10,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(PricedBody)
                )
        );
        using var temp = new TempDirectory();
        var config = new ModelConfiguration(HostPaths.ForDataRoot(temp.Path, environment: _ => null));
        await config.SaveAsync(new JsonObject { ["yaml"] = Document(peer.BaseUri).ToJsonString() });
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "priced/wire", "", "", 713);
        await using var manager = new SessionManager(
            temp.Path,
            Path.Combine(temp.Path, "work"),
            options,
            new HostModels(config)
        );
        await manager.LoadAsync();
        manager.Usage.ChangeDelay = TimeSpan.FromMilliseconds(10);
        var changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        manager.Usage.Changed += () => changed.TrySetResult();

        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var child = await manager.CreateNamedAsync(
            "main",
            "child",
            null,
            null,
            parentSessionId: parent.Id
        );
        var solo = await manager.CreateNamedAsync("main", "solo", null, null);
        foreach (var owner in new[] { parent, child, solo })
        {
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("next"));
            await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));
        }
        await changed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        long[] period = [0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000];

        var total = await manager.Usage.QueryAsync(period, null, null, 100);
        Assert.Equal(3, total["total"]!["requests"]!.GetValue<long>());
        Assert.Equal(0, total["total"]!["unpricedRequests"]!.GetValue<long>());
        Assert.Equal(3 * .000027, total["total"]!["cost"]!.GetValue<double>(), 10);
        Assert.Null(total["groups"]);

        var tree = await manager.Usage.QueryAsync(period, "tree", null, 100);
        Assert.Equal(2, Requests(Group(tree, "tree", parent.Id)));
        Assert.Equal("main", SessionCatalog.Text(Group(tree, "tree", parent.Id)["agent"]));
        Assert.Equal(1, Requests(Group(tree, "tree", solo.Id)));
        Assert.Equal(2, tree["groupCount"]!.GetValue<int>());
        // The largest groups carry a per-bucket series for the chart.
        Assert.Single(Group(tree, "tree", parent.Id)["buckets"]!.AsArray());

        var bySession = await manager.Usage.QueryAsync(period, "session", null, 100);
        Assert.Equal(3, bySession["groupCount"]!.GetValue<int>());
        var limited = await manager.Usage.QueryAsync(period, "session", null, 1);
        Assert.Single(limited["groups"]!.AsArray());
        Assert.Equal(3, limited["groupCount"]!.GetValue<int>());

        Assert.Equal(3, Requests(Group(await manager.Usage.QueryAsync(period, "agent", null, 100), "agent", "main")));
        Assert.Equal(3, Requests(Group(await manager.Usage.QueryAsync(period, "model", null, 100), "model", "priced/wire")));
        Assert.Equal(3, Requests(Group(await manager.Usage.QueryAsync(period, "provider", null, 100), "provider", "priced")));
        Assert.Equal(3, Requests(Group(await manager.Usage.QueryAsync(period, "purpose", null, 100), "purpose", "normal-turn")));
        Assert.Equal(0, (await manager.Usage.QueryAsync(period, null, "other", 100))["total"]!["requests"]!.GetValue<long>());

        // Deleting a Session keeps its recorded usage, pooled under the recorded Agent.
        await manager.DeleteAsync(child.Id);
        var afterDelete = await manager.Usage.QueryAsync(period, "session", null, 100);
        var deleted = Group(afterDelete, "deleted", "main");
        Assert.Equal(1, Requests(deleted));
        Assert.Equal("main", SessionCatalog.Text(deleted["agent"]));
        Assert.Equal(3, (await manager.Usage.QueryAsync(period, null, null, 100))["total"]!["requests"]!.GetValue<long>());
        // Historical attribution falls back to the retained Archive for deleted Sessions.
        var agents = manager.Usage.ResolveAgents([child.Id, parent.Id, "main/never-existed"]);
        Assert.Equal("main", agents[child.Id]);
        Assert.Equal("main", agents[parent.Id]);
        Assert.Null(agents["main/never-existed"]);

        manager.Usage.StartBackfill(CancellationToken.None);
        await manager.Usage.BackfillTask.WaitAsync(TimeSpan.FromSeconds(10));
        var coverage = (await manager.Usage.QueryAsync(period, null, null, 100))["coverage"]!;
        Assert.True(coverage["complete"]!.GetValue<bool>());
        Assert.Equal(3, (await manager.Usage.QueryAsync(period, null, null, 100))["total"]!["requests"]!.GetValue<long>());
    }
}
