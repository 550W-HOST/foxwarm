using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class StopWithoutRunningTurnTests
{
    // A Stop that lands while no turn holds busy (an idle Session, or a processor that has been
    // started but has not claimed busy yet) is finalized by the next processor. Before, every
    // processor was refused by Stopping and retriggered itself because input stayed runnable.
    [Fact]
    public async Task Processor_started_after_an_unobserved_stop_finalizes_it_instead_of_spinning()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        var owner = f.Owner;
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("stopped input"));
        var stop = await owner.Registry.Control.StopAsync(owner.Id);
        Assert.False(stop.AbortedInFlight);
        Assert.True(owner.Entry.WithState(state => state.Stopping));

        // The production trigger; the fixture disables it.
        owner.Registry.TriggerOverride = _ => owner.StartProcessing();
        _ = owner.StartProcessing();
        await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(20));

        var snapshot = owner.Entry.Snapshot();
        Assert.False(snapshot.Stopping);
        Assert.False(snapshot.Busy);
        Assert.Empty(snapshot.Queue);
        // Stop's contract for queued input: appended to history without being run.
        var history = owner.History();
        Assert.Contains(history, row => row.ToJsonString().Contains("stopped input"));
        Assert.DoesNotContain(history, row => row["role"]?.GetValue<string>() == "model");
    }
}
