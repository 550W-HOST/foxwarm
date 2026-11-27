using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// A Stop accepted while the Session reports busy, but after the running turn's last check for it
// (here: at the safe point before the turn ends its loop and releases busy), is seen by nothing. It must not leave a lasting stopping state that blocks later input.
public sealed partial class SessionCommandEffectsTests
{
    [Theory]
    [InlineData("slash", "message")]
    [InlineData("slash", "wait")]
    [InlineData("tool", "message")]
    [InlineData("tool", "task")]
    [InlineData("route", "message")]
    [InlineData("route", "timer")]
    public async Task Stop_accepted_after_the_turn_last_checked_it_does_not_block_later_input(
        string stop,
        string followUp
    )
    {
        await using var peer = new ConcurrentPeer(
            2,
            (index, stream, _) => SendAsync(stream, "answer " + index)
        );
        await using var f = await FixtureAsync(provider: peer.Uri);
        var owner = f.Owner;
        owner.Registry.TriggerOverride = _ => owner.StartProcessing();
        var finishing = Signal();
        var release = Signal();
        // The loop-top safe point after the answer: the turn has already checked stopping and,
        // with no further input, ends its loop without checking again.
        var safePoint = owner.Registry.OnSafePoint;
        var first = 0;
        owner.Registry.OnSafePoint = async entry =>
        {
            if (
                entry.WithState(state =>
                    state.History.Any(row => row.ToJson().ToJsonString().Contains("answer 0"))
                )
                && Interlocked.Exchange(ref first, 1) == 0
            )
            {
                finishing.TrySetResult();
                await release.Task;
            }
            if (safePoint is not null)
                await safePoint(entry);
        };
        var caller = await f.Manager.CreateNamedAsync("main", "caller", null, null);
        caller.Registry.TriggerOverride = _ => Task.CompletedTask;

        var replies = await CommandAsync(f, "first request");
        await finishing.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(owner.Metadata().Busy);
        Task stopping = Task.CompletedTask;
        switch (stop)
        {
            case "slash":
                replies.AddRange(await CommandAsync(f, "/stop"));
                break;
            case "tool":
                // The stop_session tool handler.
                var output = await ArchiveControlTools.StopAsync(
                    f.Manager,
                    caller,
                    new JsonObject { ["sessionId"] = owner.Id },
                    default
                );
                Assert.Contains("Stop signal sent", output["output"]?.ToString());
                break;
            case "route":
                // The WebUI Stop route's call after its busy check.
                stopping = new SessionRuntime(f.Manager).StopAsync(owner.Id);
                break;
        }
        release.TrySetResult();
        await stopping.WaitAsync(TimeSpan.FromSeconds(10));
        await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Single(peer.Requests);

        switch (followUp)
        {
            case "message":
                replies.AddRange(await CommandAsync(f, "follow-up input"));
                break;
            case "task":
                await f.Manager.SendTaskNotificationAsync(
                    null,
                    owner.Id,
                    "follow-up input",
                    true,
                    "task_idle_stop",
                    "assigned",
                    "owner"
                );
                break;
            case "timer":
                await owner.Registry.Ingress.EnqueueTimerAsync(
                    owner.Id,
                    new QueueItem(
                        QueueItemType.Background,
                        [new JsonObject { ["system"] = "follow-up input" }]
                    )
                );
                break;
            case "wait":
                await f.Manager.AdmitWaitEventAsync(
                    owner.Id,
                    SessionWait.Event("wait-timeout", "follow-up input")
                );
                break;
        }
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (peer.Requests.Count < 2 && DateTime.UtcNow < deadline)
            await Task.Delay(50);
        await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(10));

        var snapshot = owner.Entry.Snapshot();
        // Stopping without busy is rejected when the owner is loaded again, e.g. after restart.
        Assert.False((await owner.AuthorityStore.LoadAsync(owner.Id))!.Stopping);
        Assert.False(snapshot.Stopping);
        Assert.Empty(snapshot.Queue);
        Assert.Equal(2, peer.Requests.Count);
        Assert.Contains("follow-up input", peer.Requests.Last().ToJsonString());
    }

    // The server-side race behind the Stop entry points: their busy check passed, then the turn
    // ended before the Stop arrived. Nothing is left stopping; passive input stays queued and
    // later input runs.
    [Fact]
    public async Task Stop_on_an_idle_Session_leaves_no_stopping_state()
    {
        await using var peer = new ConcurrentPeer(
            1,
            (index, stream, _) => SendAsync(stream, "answer " + index)
        );
        await using var f = await FixtureAsync(provider: peer.Uri);
        var owner = f.Owner;
        owner.Registry.TriggerOverride = _ => owner.StartProcessing();
        await f.Manager.SendTaskNotificationAsync(
            null,
            owner.Id,
            "passive input",
            false,
            "task_idle_stop",
            "updated",
            "creator"
        );
        await f.Manager.DeclareWaitAsync(owner, new JsonObject { ["waitForInput"] = true });
        Assert.NotNull(owner.Entry.Snapshot().Meta["wait"]);

        var result = await owner.Registry.Control.StopAsync(owner.Id);

        Assert.False(result.AbortedInFlight);
        var snapshot = owner.Entry.Snapshot();
        Assert.False(snapshot.Stopping);
        Assert.Null(snapshot.Meta["wait"]);
        Assert.False(Assert.Single(snapshot.Queue).Trigger);
        Assert.DoesNotContain(
            owner.History(),
            row => row.ToJsonString().Contains("passive input")
        );
        Assert.False((await owner.AuthorityStore.LoadAsync(owner.Id))!.Stopping);

        await CommandAsync(f, "later input");
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (peer.Requests.IsEmpty && DateTime.UtcNow < deadline)
            await Task.Delay(50);
        await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("later input", Assert.Single(peer.Requests).ToJsonString());
    }
}
