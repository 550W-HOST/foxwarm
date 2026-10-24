using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class LlmFailureStateTests
{
    [Fact]
    public async Task Cold_catalog_tools_controls_fork_and_clear_share_the_committed_outcome()
    {
        using var temp = new TempDirectory();
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, _) =>
            {
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    index != 1 ? 400 : 200,
                    index != 1 ? "application/json" : "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        index != 1
                            ? "{\"error\":{\"message\":\"owned terminal response\"}}"
                            : "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"recovered\"}]}]}}\n\n"
                    )
                );
            }
        );
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 713);
        var models = HostModels.ForTest(options);
        string id;
        await using (var first = new SessionManager(data, work, options, models))
        {
            await first.LoadAsync();
            var owner = await first.CreateNamedAsync("main", "failed", null, null);
            id = owner.Id;
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await owner.Registry.Ingress.EnqueueAsync(id, QueueItem.UserText("initial"));
            await owner.Registry.Runner.ProcessQueueAsync(id);
            Assert.Equal("llm-failed", State(owner));
            Assert.Empty(first.LocalProjections());
            Assert.True(first.Catalog.Get(id)!["meta"]!["llmFailed"]!.GetValue<bool>());
            await first.ShutdownAsync();
        }
        await using var manager = new SessionManager(data, work, options, models);
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        var runtime = new SessionRuntime(manager);
        var coldRow = Assert.Single(runtime.ListSessions());
        Assert.Equal("llm-failed", coldRow["runtimeState"]!["state"]!.GetValue<string>());
        Assert.False(coldRow["busy"]!.GetValue<bool>());
        Assert.Empty(manager.Owners());
        var owner2 = await manager.RequiredAsync(id);
        owner2.Registry.TriggerOverride = _ => Task.CompletedTask;
        Assert.Equal("llm-failed", State(owner2));
        var status = await manager.ObserveAsync(
            owner2,
            "session",
            new JsonObject { ["action"] = "status" }
        );
        Assert.Contains("llm-failed", status.ToJsonString());
        Assert.Equal(
            "llm-failed",
            WebUiContract.History(owner2.Entry.Snapshot(), models, false, false, null, null, null)[
                "session"
            ]!["runtimeState"]!["state"]!.GetValue<string>()
        );

        var router = new MessageRouter(runtime);
        var feedback = new List<SessionRuntimeEvent>();
        owner2.Changed += feedback.Add;
        async Task<string> Control(string command)
        {
            var result = await router.HandleMessageAsync(
                new(id, "webui"),
                new(command, null, ControlRequestId: command)
            );
            Assert.Equal(200, result.Status);
            return feedback
                .Last(value => SessionWait.Text(value.Data?["type"]) == "session-control-feedback")
                .Data!["feedback"]!["status"]!.GetValue<string>();
        }
        Assert.Equal("noop", await Control("/stop"));
        Assert.Equal("noop", await Control("/dequeue"));
        Assert.Equal("llm-failed", State(owner2));
        Assert.False(owner2.Entry.Snapshot().Stopping);
        var child = await manager.ForkAsync(owner2, "fresh");
        Assert.Equal("idle", State(child));
        Assert.Null(child.Entry.Snapshot().Meta["llmFailed"]);
        Assert.Equal("llm-failed", State(owner2));
        await runtime.UpdateSettingsAsync(id, new JsonObject { ["effort"] = "low" });
        Assert.Equal("llm-failed", State(owner2));
        Assert.Equal("accepted", await Control("/continue"));
        await owner2.DrainForegroundAsync();
        Assert.Equal("idle", State(owner2));
        Assert.Null(owner2.Entry.Snapshot().Meta["llmFailed"]);
        Assert.Equal("noop", await Control("/continue"));

        // A fresh real failure followed by Clear uses the existing lifecycle save and drops the fact.
        await owner2.Registry.Ingress.EnqueueAsync(id, QueueItem.UserText("fail again"));
        await owner2.Registry.Runner.ProcessQueueAsync(id);
        Assert.Equal("llm-failed", State(owner2));
        await runtime.ClearHistoryAsync(id);
        Assert.Equal("idle", State(owner2));
        Assert.Null(owner2.Entry.Snapshot().Meta["llmFailed"]);
        Assert.Null(manager.Catalog.Get(id)!["meta"]!["llmFailed"]);
        await manager.ShutdownAsync();
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Stop_or_run_queued_during_terminal_notice_keeps_its_control_outcome(
        bool runQueued,
        bool duringFailurePresentation
    )
    {
        using var fixture = new Provider(attempt => attempt == 1 ? Failure() : Success());
        var notice = Signal();
        var release = Signal();
        if (duringFailurePresentation)
        {
            var original = fixture.Owner.Registry.OnTurnFailure!;
            fixture.Owner.Registry.OnTurnFailure = async (error, durable) =>
            {
                await original(error, durable);
                notice.TrySetResult();
                await release.Task;
            };
        }
        else
            fixture.Owner.Entry.RetryPresented = async (retry, _, _) =>
            {
                if (retry.Final)
                {
                    notice.TrySetResult();
                    await release.Task;
                }
            };
        await fixture.Enqueue("first");
        var running = fixture.Run();
        try
        {
            await notice.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (runQueued)
            {
                await fixture.Enqueue("next");
                var control = await fixture.Owner.Registry.Control.DequeueAsync("s");
                Assert.Equal(!duringFailurePresentation, control.AbortedInFlight);
            }
            else
            {
                var control = await fixture.Owner.Registry.Control.StopAsync("s");
                Assert.Equal(!duringFailurePresentation, control.AbortedInFlight);
            }
        }
        finally
        {
            release.TrySetResult();
            await running;
        }
        Assert.Equal(runQueued ? 2 : 1, fixture.Attempts);
        Assert.Equal("idle", State(fixture.Owner));
        Assert.False(fixture.Owner.Entry.Snapshot().Stopping);
        Assert.Null(fixture.Owner.Entry.Snapshot().Meta["llmFailed"]);
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Passive_input_waits_for_explicit_run_queued_and_failed_busy_claim_restores_failure()
    {
        var failClaim = false;
        using var fixture = new Provider(
            attempt => attempt == 1 ? Failure() : Success(),
            (stage, _) =>
            {
                if (failClaim && stage == AtomicJsonWriteStage.BeforeRename)
                    throw new IOException("owned claim fault");
            }
        );
        await fixture.Enqueue("first");
        await fixture.Run();
        failClaim = true;
        await Assert.ThrowsAsync<IOException>(() =>
            fixture.Owner.Registry.HostFor("s").TryClaimBusyAsync()
        );
        Assert.Equal("llm-failed", State(fixture.Owner));
        failClaim = false;
        await fixture.Owner.Entry.SaveLane.CommitInterSessionAsync(
            new QueueItem(
                QueueItemType.Intersession,
                [new JsonObject { ["text"] = "passive" }],
                Trigger: false
            )
        );
        Assert.False(fixture.Owner.Registry.HasRunnableWork(fixture.Owner.Entry));
        Assert.Equal("llm-failed", State(fixture.Owner));
        Assert.Equal(1, fixture.Attempts);
        fixture.Owner.Registry.TriggerOverride = _ => fixture.Owner.StartProcessing();
        await fixture.Owner.Registry.Control.DequeueAsync("s");
        await fixture.Owner.DrainForegroundAsync();
        Assert.Equal("idle", State(fixture.Owner));
        Assert.Equal(2, fixture.Attempts);
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Maintenance_only_processor_preserves_failure_and_input_arriving_at_its_safe_point_starts_a_new_run()
    {
        using var fixture = new Provider(attempt => attempt == 1 ? Failure() : Success());
        await fixture.Enqueue("first");
        await fixture.Run();
        Assert.Equal("llm-failed", State(fixture.Owner));
        await fixture.Run(); // A compact-completion wake can have no ordinary input.
        Assert.Equal("llm-failed", State(fixture.Owner));
        Assert.True((await fixture.Store.LoadAsync("s"))!.Meta["llmFailed"]!.GetValue<bool>());
        var admitted = false;
        fixture.Owner.Registry.OnSafePoint = async _ =>
        {
            if (!admitted)
            {
                admitted = true;
                await fixture.Enqueue("late input");
            }
        };
        fixture.BeforeResponse = _ =>
        {
            Assert.Null(fixture.Owner.Entry.Snapshot().Meta["llmFailed"]);
            return Task.CompletedTask;
        };
        await fixture.Run();
        Assert.Equal(2, fixture.Attempts);
        Assert.Equal("idle", State(fixture.Owner));
        Assert.Null((await fixture.Store.LoadAsync("s"))!.Meta["llmFailed"]);
    }
}
