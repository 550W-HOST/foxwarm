using Foxwarm.Models;
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
    public async Task ACommandReplyPinsTheResidentEmitterWithoutHydratingAColdOwner()
    {
        await using var f = await Fixture.Create(null);
        var owner = await f.Manager.CreateNamedAsync("main", "reply", null, null);
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        var releaseDuringEmission = -1;
        owner.Changed += value =>
        {
            if (value.Kind == SessionEventKind.CommandReply) releaseDuringEmission = f.Manager.ReleaseIdleOwners();
        };
        var replies = new List<SessionRuntimeEvent>();
        f.Manager.Changed += value => { if (value.Kind == SessionEventKind.CommandReply) replies.Add(value); };
        f.Manager.ReplyToCommand(owner.Id, "first");
        Assert.Equal(0, releaseDuringEmission);
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        f.Manager.ReplyToCommand(owner.Id, "second");
        Assert.Empty(f.Manager.Owners());
        Assert.Equal(new[] { "first", "second" }, replies.Select(value => value.Data!["parts"]![0]!["text"]!.GetValue<string>()));
    }

    [Fact]
    public async Task AnAcceptedCreationPublishingAfterBudgetClosureReturnsItsCharge()
    {
        var replica = new ReplicaLimits(long.MaxValue);
        await using var f = await Fixture.Create(Limits, replica);
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.BeforeCreationPublication = async _ => { reached.SetResult(); await resume.Task; };
        var creation = f.Manager.CreateNamedAsync("main", "late", null, null);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Manager.BeginShutdown();
        f.Manager.DisposeAdmission();
        resume.SetResult();
        Assert.Equal("late", (await creation).Id);
        Assert.Equal(0, f.Manager.Admission!.HotOwners.UsedBytes);
        Assert.Equal(0, replica.HotOwners.Used);
    }

    [Fact]
    public async Task ASubscriberInstalledDuringTheIdleCheckKeepsReceivingEvents()
    {
        await using var f = await Fixture.Create(null);
        var owner = await f.Manager.CreateNamedAsync("main", "stream", null, null);
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        (long Id, System.Threading.Channels.ChannelReader<SessionRuntimeEvent> Reader) subscribed = default;
        f.Manager.IdleReleaseChecked = current => subscribed = current.Subscribe();
        Assert.Equal(0, f.Manager.ReleaseIdleOwners());
        try
        {
            owner.PublishStateChanged();
            Assert.Equal(SessionEventKind.StateChanged, (await subscribed.Reader!.ReadAsync()).Kind);
        }
        finally { owner.Unsubscribe(subscribed.Id); }
    }

    [Fact]
    public async Task HostShutdownReturnsItsShareOfTheReplicaAfterAFailedSave()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), "vector: false\ndbWorkers: false\n");
        var host = await MainHost.CreateAsync([], data, work, new ModelConfiguration(data),
            await HttpServerSettings.CaptureDesktopAsync(data), null, capabilities: RuntimeCapabilities.File with { Limits = Limits });
        var owner = await host.Sessions.CreateNamedAsync("main", "failed-final-save", null, null);
        var path = ((PersistentSessionAuthorityStore)owner.AuthorityStore).AuthorityPath;
        File.Move(path, path + ".saved");
        Directory.CreateDirectory(path); // An atomic replacement of the file will fail.
        var budget = host.Sessions.Admission!.HotOwners;
        var pool = ReplicaLimits.Process.HotOwners;
        Assert.Contains(budget.Releaser, pool.Releasers());
        await Assert.ThrowsAnyAsync<Exception>(() => host.DisposeAsync().AsTask());
        Assert.DoesNotContain(budget.Releaser, pool.Releasers());
        Assert.Equal(0, budget.UsedBytes);
    }

    [Fact]
    public async Task AColdLoadReservesBeforeReadingAndTheGraceKeepsAJustPublishedOwner()
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
        // b was just published: within its grace, pressure leaves it resident.
        f.Manager.PressureGraceForTest = TimeSpan.FromHours(1);
        var load = f.Manager.GetExistingAsync(a.Id);
        await Task.Delay(400);
        Assert.False(load.IsCompleted);
        Assert.True(Resident(f.Manager, b.Id));
        // The waiting load holds no history.
        lock (reads)
            Assert.Empty(reads);
        // Past the grace, the next look releases b and the load reads a.
        f.Manager.PressureGraceForTest = TimeSpan.Zero;
        Assert.NotNull(await load.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(Resident(f.Manager, b.Id));
        lock (reads)
            Assert.Equal([a.Id], reads);
    }

    [Fact]
    public async Task LookupsOrderVictimsButDontKeepAnOwnerResident()
    {
        await using var f = await Fixture.Create(Limits with { HotOwnerBytes = OneOwner });
        var a = await f.Manager.CreateNamedAsync("main", "a", null, null);
        var b = await f.Manager.CreateNamedAsync("main", "b", null, null);
        Assert.False(Resident(f.Manager, a.Id));
        f.Manager.PressureGraceForTest = TimeSpan.FromMilliseconds(200);
        // Once publication grace expires, even an immediately preceding observation can't
        // protect b. Drive the same release operation that a blocked reservation uses.
        await Task.Delay(350);
        Assert.Same(b, await f.Manager.GetExistingAsync(b.Id));
        Assert.True(f.Manager.Admission!.HotOwners.Releaser.ReleaseOldestIdle());
        Assert.True(b.Entry.Retired);
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
