using System.Text.Json.Nodes;
using Foxwarm.Limits;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Limits;

// Hot-owner admission: cold loads, the use lease, hydrations, fairness of waits and the end
// of a runtime's admission.
public sealed partial class TenantLimitAdmissionTests
{
    // Two empty owners don't fit; one does.
    private static long OneOwner => HotOwnerBudget.Estimate(0) * 3 / 2;

    [Fact]
    public async Task AColdLoadReservesBeforeReadingAndTheUseLeaseKeepsAJustUsedOwner()
    {
        await using var f = await Fixture.Create(Limits with { HotOwnerBytes = OneOwner });
        var a = await f.Manager.CreateNamedAsync("main", "a", null, null);
        var b = await f.Manager.CreateNamedAsync("main", "b", null, null);
        Assert.False(Resident(f.Manager, a.Id));
        var reads = new List<string>();
        f.Manager.HistoryReadStarting = id =>
        {
            lock (reads)
                reads.Add(id);
        };
        // b was just used: within its lease, pressure leaves it resident.
        f.Manager.PressureUseLeaseForTest = TimeSpan.FromHours(1);
        var load = f.Manager.GetExistingAsync(a.Id);
        await Task.Delay(400);
        Assert.False(load.IsCompleted);
        Assert.True(Resident(f.Manager, b.Id));
        // The waiting load holds no history.
        lock (reads)
            Assert.Empty(reads);
        // Past the lease, the next look releases b and the load reads a.
        f.Manager.PressureUseLeaseForTest = TimeSpan.Zero;
        Assert.NotNull(await load.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(Resident(f.Manager, b.Id));
        lock (reads)
            Assert.Equal([a.Id], reads);
    }

    [Fact]
    public async Task ConcurrentLookupsShareOneLoadAndHydrationsAreBounded()
    {
        await using var f = await Fixture.Create(Limits);
        var ids = new List<string>();
        for (var index = 0; index < TenantAdmission.HydrationSlots + 2; index++)
            ids.Add((await f.Manager.CreateNamedAsync("main", "cold-" + index, null, null)).Id);
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        Assert.Equal(ids.Count, f.Manager.ReleaseIdleOwners());
        var started = 0;
        using var gate = new ManualResetEventSlim();
        f.Manager.HistoryReadStarting = _ =>
        {
            Interlocked.Increment(ref started);
            gate.Wait(TimeSpan.FromSeconds(20));
        };
        var lookups = ids.Select(id => Task.Run(() => f.Manager.GetExistingAsync(id))).ToList();
        lookups.Add(Task.Run(() => f.Manager.GetExistingAsync(ids[0])));
        await WaitForAsync(() => Volatile.Read(ref started) == TenantAdmission.HydrationSlots);
        await Task.Delay(300);
        Assert.Equal(TenantAdmission.HydrationSlots, Volatile.Read(ref started));
        gate.Set();
        var owners = await Task.WhenAll(lookups).WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(ids.Count, Volatile.Read(ref started));
        Assert.Same(owners[0], owners[^1]);
    }

    // An owner releaser driven by the test.
    private sealed class FakeReleaser : IHotOwnerReleaser
    {
        internal Func<bool> Release = () => false;
        internal long? Idle;
        internal int Releases;

        public long? OldestIdle() => Idle;

        public bool ReleaseOldestIdle()
        {
            Interlocked.Increment(ref Releases);
            return Release();
        }
    }

    [Fact]
    public async Task AWaitingLoadLooksAgainWhenAnOwnerMayHaveBecomeIdle()
    {
        var releaser = new FakeReleaser();
        using var budget = new HotOwnerBudget(100, null, releaser, TimeSpan.FromSeconds(20));
        var resident = budget.Force(80);
        var waiting = budget.ReserveAsync(50);
        await Task.Delay(150);
        Assert.False(waiting.IsCompleted);
        // The owner's turn ended: it can go now.
        releaser.Release = () =>
        {
            resident.Dispose();
            return true;
        };
        releaser.Idle = 1;
        budget.OwnerMayBeIdle();
        using var charge = await waiting.WaitAsync(HotOwnerBudget.RecheckInterval * 0.7);
        Assert.Equal(50, budget.UsedBytes);
    }

    [Fact]
    public async Task TheDeadlineAndCancellationHoldWhenReleasesFreeNothing()
    {
        // Every release reports success but frees nothing.
        var releaser = new FakeReleaser { Idle = 1, Release = () => true };
        using var budget = new HotOwnerBudget(100, null, releaser, TimeSpan.FromMilliseconds(200));
        using var resident = budget.Force(80);
        var exhausted = await Assert.ThrowsAsync<TenantLimitException>(() =>
            Task.Run(() => budget.ReserveAsync(50)).WaitAsync(TimeSpan.FromSeconds(10))
        );
        Assert.Equal("hotOwnerBytes", exhausted.Limit);
        using var patient = new HotOwnerBudget(100, null, releaser, TimeSpan.FromSeconds(30));
        using var held = patient.Force(80);
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Task.Run(() => patient.ReserveAsync(50, cancel.Token)).WaitAsync(TimeSpan.FromSeconds(10))
        );
    }

    [Fact]
    public async Task ATenantsOwnDeficitDoesntReleaseAnotherTenantsOwner()
    {
        var pool = new HotOwnerPool(130);
        var own = new FakeReleaser();
        var other = new FakeReleaser { Idle = 1, Release = () => true };
        using var tenant = new HotOwnerBudget(100, pool, own, TimeSpan.FromMilliseconds(200));
        using var neighbour = new HotOwnerBudget(100, pool, other);
        using var resident = tenant.Force(80);
        using var neighbours = neighbour.Force(40);
        // Over its own budget and the replica's: releasing the neighbour can't make room.
        await Assert.ThrowsAsync<TenantLimitException>(() =>
            Task.Run(() => tenant.ReserveAsync(50)).WaitAsync(TimeSpan.FromSeconds(10))
        );
        Assert.Equal(0, other.Releases);
    }

    [Fact]
    public async Task PressureDoesntWaitForARunningIdleSweep()
    {
        await using var f = await Fixture.Create(Limits with { HotOwnerBytes = OneOwner });
        var a = await f.Manager.CreateNamedAsync("main", "a", null, null);
        using var entered = new ManualResetEventSlim();
        using var gate = new ManualResetEventSlim();
        f.Manager.IdleReleaseChecked = owner =>
        {
            if (owner.Id != a.Id)
                return;
            entered.Set();
            gate.Wait(TimeSpan.FromSeconds(20));
        };
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        var sweep = Task.Run(() => f.Manager.ReleaseIdleOwners());
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
        // A created owner is admitted while the sweep holds its gate.
        var created = await Task.Run(() => f.Manager.CreateNamedAsync("main", "b", null, null))
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(Resident(f.Manager, created.Id));
        gate.Set();
        await sweep.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public async Task ARuntimeLeavesTheReplicasBudgetEvenWhenItsFinalSaveFails()
    {
        var replica = new ReplicaLimits(long.MaxValue);
        var failSaves = false;
        var failing = await Fixture.Create(
            Limits,
            replica,
            stage: (_, _) =>
            {
                if (Volatile.Read(ref failSaves))
                    throw new IOException("final save failure");
            }
        );
        await using var other = await Fixture.Create(Limits, replica);
        await failing.Manager.CreateNamedAsync("main", "kept", null, null);
        await other.Manager.CreateNamedAsync("main", "neighbour", null, null);
        Assert.Equal(2, replica.HotOwners.Releasers().Length);
        Volatile.Write(ref failSaves, true);
        await Assert.ThrowsAnyAsync<Exception>(() => failing.Manager.DisposeAsync().AsTask());
        failing.Temp.Dispose();
        // Only the other runtime's owner and releaser remain.
        Assert.Single(replica.HotOwners.Releasers());
        Assert.InRange(replica.HotOwners.UsedBytes, HotOwnerBudget.OwnerFloorBytes, OneOwner);
    }

    [Fact]
    public async Task AFailedLoadReturnsItsReservation()
    {
        await using var f = await Fixture.Create(Limits);
        var owner = await f.Manager.CreateNamedAsync("main", "broken", null, null);
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        Assert.Equal(0, f.Manager.Admission!.HotOwners.UsedBytes);
        await File.WriteAllTextAsync(Path.Combine(f.Data, "state", "sessions", owner.Id + ".json"), "{broken");
        await Assert.ThrowsAnyAsync<Exception>(() => f.Manager.GetExistingAsync(owner.Id));
        Assert.Equal(0, f.Manager.Admission.HotOwners.UsedBytes);
    }
}
