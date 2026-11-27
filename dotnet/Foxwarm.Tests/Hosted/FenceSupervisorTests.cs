using System.Diagnostics;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Runtimes;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// The grant clock and the supervisor's single deadline decision, without a database.
public sealed class FenceSupervisorTests
{
    private static readonly TimeSpan Bound = TimeSpan.FromMilliseconds(400);
    private static readonly TimeSpan Late = TimeSpan.FromMilliseconds(900);
    private static long Ticks(TimeSpan span) => (long)(span.TotalSeconds * Stopwatch.Frequency);

    private static LeaseGrant Grant() => new(1, "default", "replica-a/0001", 1);

    [Fact]
    public void AProofAfterTheDeadlineDoesntExtendItAndTheLossInstantIsTheDeadline()
    {
        var now = 1_000L;
        var handle = new GrantHandle(Grant(), deadline: 2_000, clock: () => now);
        Assert.True(handle.Prove(3_000));
        Assert.Equal(3_000, handle.Deadline);
        // An older proof never shortens a newer one.
        Assert.True(handle.Prove(2_500));
        Assert.Equal(3_000, handle.Deadline);
        // Paused past the deadline: the proof arrives late and changes nothing.
        now = 3_000;
        Assert.False(handle.Prove(9_000));
        Assert.False(handle.IsCurrent(now));
        // The loss decided later is recorded at the deadline, and the hard stop counts from it.
        now = 7_000;
        var hooked = 0;
        handle.OnLoss(_ => hooked++);
        Assert.True(handle.TryLose("expired"));
        Assert.Equal(3_000, handle.EndedAt(now));
        Assert.Equal(3_500, handle.HardStop(500));
        Assert.Equal(1, hooked);
        Assert.False(handle.TryLose("again"));
        // A release ends the grant without running loss hooks.
        var released = new GrantHandle(Grant(), deadline: 9_000, clock: () => now);
        released.OnLoss(_ => hooked++);
        Assert.True(released.TryRelease("released"));
        Assert.Equal(1, hooked);
        Assert.False(released.IsCurrent(now));
    }

    [Fact]
    public async Task TheExitWaitsForNoLoggerAndCountsFromTheHardStop()
    {
        var exited = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var blocked = new ManualResetEventSlim();
        var supervisor = new FenceSupervisor(
            LeaseTimings.Default,
            Bound,
            _ => exited.TrySetResult(Stopwatch.GetTimestamp()),
            // Output that never drains.
            _ => blocked.Wait()
        );
        var fencedAt = Stopwatch.GetTimestamp();
        var never = new TaskCompletionSource<StopResult>();
        var obligation = supervisor.Watch("tenant", () => fencedAt + supervisor.DrainTicks, never.Task);
        var at = await exited.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.InRange(Stopwatch.GetElapsedTime(fencedAt, at), Bound, Bound + Late);
        Assert.False(await obligation.Decided);
        blocked.Set();
    }

    [Fact]
    public async Task AConfirmationIsJudgedByItsOwnTimestampNotByWhenItIsSeen()
    {
        var exits = 0;
        var supervisor = new FenceSupervisor(LeaseTimings.Default, Bound, _ => Interlocked.Increment(ref exits));
        var hardStop = Stopwatch.GetTimestamp() + supervisor.DrainTicks;

        // Confirmed in time, but reported only after the hard stop: no exit.
        var timely = new TaskCompletionSource<StopResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = supervisor.Watch("timely", () => hardStop, timely.Task);
        // Confirmed after the hard stop (an overdue continuation): it never wins.
        var overdue = new TaskCompletionSource<StopResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = supervisor.Watch("overdue", () => hardStop, overdue.Task);
        timely.SetResult(new StopResult(true, hardStop - Ticks(TimeSpan.FromMilliseconds(100))));
        overdue.SetResult(new StopResult(true, hardStop + 1));
        Assert.True(await first.Decided.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.False(await second.Decided.WaitAsync(TimeSpan.FromSeconds(5)));
        var waited = Stopwatch.StartNew();
        while (Volatile.Read(ref exits) == 0 && waited.Elapsed < TimeSpan.FromSeconds(5))
            await Task.Delay(10);
        Assert.Equal(1, exits);
        // A cancelled or faulted stop never confirms.
        Assert.False((await StopResult.Of(Task.FromCanceled(new CancellationToken(true)))).Confirmed);
        Assert.False((await StopResult.Of(Task.FromException(new InvalidOperationException()))).Confirmed);
    }

    [Fact]
    public async Task AHardStopThatMovesBackIsDecidedWithoutWaitingForTheOldOne()
    {
        var exited = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        var supervisor = new FenceSupervisor(LeaseTimings.Default, Bound, _ => exited.TrySetResult(Stopwatch.GetTimestamp()));
        var handle = new GrantHandle(Grant(), Stopwatch.GetTimestamp() + Ticks(TimeSpan.FromSeconds(20)));
        supervisor.Watch("tenant", () => handle.HardStop(supervisor.DrainTicks), new TaskCompletionSource<StopResult>().Task);
        await Task.Delay(100);
        var lostAt = Stopwatch.GetTimestamp();
        handle.TryLose("taken over");
        supervisor.Wake();
        var at = await exited.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.InRange(Stopwatch.GetElapsedTime(lostAt, at), Bound - TimeSpan.FromMilliseconds(5), Bound + Late);
    }
}
