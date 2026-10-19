using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AgentDeletionTests
{
    [Theory]
    [InlineData("normal")]
    [InlineData("session-delete")]
    [InlineData("agent-claim")]
    [InlineData("agent-finalizing")]
    public async Task Real_model_created_timer_delivers_normally_but_cannot_inherit_foreground_settlement_during_deletion(
        string scenario
    )
    {
        using var temp = new TempDirectory();
        var command = scenario.StartsWith("agent-", StringComparison.Ordinal);
        var deleting = scenario != "normal";
        var timerReached = Signal();
        var timerRelease = Signal();
        var providerReached = Signal();
        var providerRelease = Signal();
        var prepareReached = Signal();
        var prepareRelease = Signal();
        var finalizingReached = Signal();
        var finalizingRelease = Signal();
        var rejectedDelivery = new TaskCompletionSource<Exception>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
            {
                if (index != 0)
                {
                    providerReached.TrySetResult();
                    await providerRelease.Task;
                    return;
                }
                var call = new JsonObject
                {
                    ["type"] = "function_call",
                    ["call_id"] = "create-timer",
                    ["name"] = "create_timer",
                    ["arguments"] = new JsonObject
                    {
                        ["afterSeconds"] = 0.01,
                        ["message"] = "independent scheduled input",
                    }.ToJsonString(),
                };
                var response = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "timer-response",
                        ["output"] = new JsonArray(call),
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + response.ToJsonString() + "\n\n")
                );
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "", "", "", 1024);
        await using var manager = new SessionManager(
            Data(temp.Path),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadMainHostAsync();
        await manager.CreateAgentAsync("target");
        var target = await manager.RequiredAsync("target/main");
        manager.Timers.BeforeDelivery = async _ =>
        {
            timerReached.TrySetResult();
            await timerRelease.Task;
        };
        manager.Timers.Diagnostic = (_, error) =>
        {
            if (error is not null)
                rejectedDelivery.TrySetResult(error);
        };
        manager.BeforeDeleteStage = async (stage, _) =>
        {
            if (stage == "prepare")
            {
                prepareReached.TrySetResult();
                await prepareRelease.Task;
            }
        };
        var originalFinalizing = target.Registry.OnProcessorFinalizing;
        if (scenario == "agent-finalizing")
            target.Registry.OnProcessorFinalizing = async (entry, error, interrupted, suspended) =>
            {
                if (originalFinalizing is not null)
                    await originalFinalizing(entry, error, interrupted, suspended);
                finalizingReached.TrySetResult();
                await finalizingRelease.Task;
            };
        Task? deletion = null;
        try
        {
            await target.Registry.Ingress.EnqueueAsync(
                target.Id,
                QueueItem.UserText("create timer then remain in the provider request")
            );
            await providerReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await timerReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(target.Metadata().Busy);
            Assert.Contains(
                target.History(),
                row =>
                    row["role"]!.ToString() == "tool"
                    && row.ToJsonString()
                        .Contains("independent scheduled input", StringComparison.Ordinal)
            );
            // Hold the next provider request: the creating tool has returned, but
            // its foreground turn is still live when the independent clock fires.
            target.Registry.TriggerOverride = _ => Task.CompletedTask;
            if (deleting)
            {
                deletion = command
                    ? manager.DeleteAgentFromCommandAsync("target")
                    : manager.DeleteAsync(target.Id);
                await prepareReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
                var direct = await Assert.ThrowsAsync<SessionDeletionException>(() =>
                    target.Registry.Ingress.EnqueueAsync(
                        target.Id,
                        QueueItem.UserText("unrelated direct input")
                    )
                );
                Assert.Equal("SESSION_DELETE_IN_PROGRESS", direct.Code);
                if (scenario == "agent-finalizing")
                {
                    prepareRelease.TrySetResult();
                    await finalizingReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
                    Assert.False(target.Metadata().Busy);
                    Assert.True(target.Processing);
                    Assert.False(deletion.IsCompleted);
                }
            }
            timerRelease.TrySetResult();
            await TelegramChannelTests.Until(() => manager.Timers.List(target.Id).Count == 0);
            var queue = target.Entry.Snapshot().Queue;
            if (deleting)
            {
                Assert.Empty(queue);
                var error = Assert.IsType<SessionDeletionException>(
                    await rejectedDelivery.Task.WaitAsync(TimeSpan.FromSeconds(10))
                );
                Assert.Equal("SESSION_DELETE_IN_PROGRESS", error.Code);
                prepareRelease.TrySetResult();
                finalizingRelease.TrySetResult();
                await deletion!.WaitAsync(TimeSpan.FromSeconds(10));
                if (command)
                {
                    Assert.Null(manager.Catalog.Get(target.Id));
                    Assert.True(target.Entry.Retired);
                    Assert.False(target.Processing);
                    Assert.False(File.Exists(Authority(temp.Path, target.Id)));
                    Assert.False(
                        Directory.Exists(Path.Combine(temp.Path, "work", "agents", "target"))
                    );
                }
                else
                {
                    Assert.NotNull(manager.Catalog.Get(target.Id));
                    Assert.False(target.Entry.Retired);
                }
            }
            else
            {
                Assert.Single(queue);
                Assert.Contains(
                    "independent scheduled input",
                    System.Text.Json.JsonSerializer.Serialize(queue[0])
                );
                Assert.False(rejectedDelivery.Task.IsCompleted);
            }
        }
        finally
        {
            timerRelease.TrySetResult();
            prepareRelease.TrySetResult();
            finalizingRelease.TrySetResult();
            providerRelease.TrySetResult();
            if (deletion is not null)
                await deletion.WaitAsync(TimeSpan.FromSeconds(10));
        }
    }
}
