using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class PassiveTaskInputTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_previous_owner_task_notice_is_durable_wait_neutral_deduped_and_explicitly_runnable(
        bool release
    )
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (_, stream, _) =>
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n"
                    )
                )
        );
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var creator = await manager.CreateNamedAsync("main", "creator", null, null);
        var owner = await manager.CreateNamedAsync("main", "owner", null, null);
        var next = await manager.CreateNamedAsync("main", "next", null, null);
        foreach (var session in new[] { creator, owner, next })
            session.Registry.TriggerOverride = _ => Task.CompletedTask;
        var created = await manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "owned passive fixture",
                ["ownerSessionId"] = owner.Id,
                ["notifySession"] = true,
            },
            creator.Id
        );
        var taskId = created.Payload["task"]!["id"]!.GetValue<string>();
        await owner.Registry.Runner.ProcessQueueAsync(owner.Id);
        Assert.Empty(owner.Entry.Snapshot().Queue);
        var waitId = await manager.DeclareWaitAsync(
            owner,
            new JsonObject
            {
                ["waitAllSessions"] = new JsonArray(creator.Id, next.Id),
                ["wakeIfNoActivityAfterSeconds"] = 3600,
            }
        );
        var assign = new JsonObject
        {
            ["action"] = "assign",
            ["taskId"] = taskId,
            ["ownerSessionId"] = release ? null : next.Id,
            ["notifySession"] = true,
        };
        await manager.Tasks.ExecuteAsync(assign, creator.Id);
        await manager.Tasks.ExecuteAsync(assign, creator.Id); // Existing notification receipt must prevent a duplicate.
        var snapshot = owner.Entry.Snapshot();
        Assert.Equal(waitId, SessionWait.Text(snapshot.Meta["wait"]?["id"]));
        Assert.Empty(snapshot.Meta["wait"]!["waitAll"]!["satisfiedSessions"]!.AsArray());
        Assert.Empty(snapshot.Meta["wait"]!["waitAll"]!["deferredQueue"]!.AsArray());
        Assert.False(Assert.Single(snapshot.Queue).Trigger);
        Assert.False(owner.Registry.HasRunnableWork(owner.Entry));
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(temp.Path, "data/state/sessions/owner.json"))
        )!;
        Assert.Equal(waitId, SessionWait.Text(persisted["meta"]?["wait"]?["id"]));
        Assert.False(persisted["queue"]![0]!["trigger"]!.GetValue<bool>());
        // A stale timeout is ignored without invalidating the original wait token.
        await manager.AdmitWaitEventAsync(
            owner.Id,
            SessionWait.Event(
                "wait-timeout",
                "stale",
                fields: new JsonObject { ["waitTimeoutId"] = "old" }
            )
        );
        Assert.Equal(waitId, SessionWait.Text(owner.Entry.Snapshot().Meta["wait"]?["id"]));
        Task? processing = null;
        var starts = 0;
        owner.Registry.TriggerOverride = id =>
        {
            starts++;
            return processing = owner.Registry.Runner.ProcessQueueAsync(id);
        };
        var dequeued = await owner.Registry.Control.DequeueAsync(owner.Id);
        Assert.Equal(1, dequeued.QueuedItems);
        Assert.False(dequeued.StoppedCurrent);
        Assert.NotNull(processing);
        await processing.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, starts);
        Assert.Null(owner.Entry.Snapshot().Meta["wait"]);
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.Equal(2, peer.RequestCount);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        await manager.ShutdownAsync();
    }

    [Fact]
    public async Task Public_ingress_cannot_supply_passive_trigger_authority()
    {
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, new FakeChatService());
        var entry = registry.Add("s");
        registry.TriggerOverride = _ => Task.CompletedTask;
        await entry.SaveLane.StartWaitAsync(
            new JsonObject
            {
                ["id"] = "current",
                ["startedAt"] = 1,
                ["waitForInput"] = true,
            }
        );
        await registry.Ingress.EnqueueAsync(
            "s",
            new QueueItem(
                QueueItemType.User,
                [new JsonObject { ["text"] = "ordinary" }],
                Trigger: false
            )
        );
        Assert.Null(entry.Snapshot().Meta["wait"]);
        Assert.True(Assert.Single(entry.Snapshot().Queue).Trigger);
    }
}
