using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Runtimes;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// Coalesced activation, exact generations and idle release (plan §2.3),
// over the real lease rows with runtimes the test drives.
[Trait("Backend", "postgres")]
public sealed class TenantActivationsTests
{
    private const string Tenant = PostgresServer.Tenant;
    private const string Replica = "replica-a/0001";

    private sealed class FakeRuntime(ActivationContext context, Fixture owner) : IGenerationRuntime
    {
        internal ActivationContext Context { get; } = context;
        internal TaskCompletionSource Disposed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool Idle => owner.Idle;

        public async Task StartAsync(CancellationToken token)
        {
            owner.Events.Enqueue("start " + Context.Generation);
            Interlocked.Increment(ref owner.Starts);
            await owner.StartGate.Task.WaitAsync(token);
        }

        public async Task StopProducersAsync(CancellationToken token)
        {
            owner.Events.Enqueue("stop-producers");
            await owner.StopGate.Task.WaitAsync(token);
        }

        public Task SettleAsync(CancellationToken token)
        {
            owner.Events.Enqueue("settle");
            return Task.CompletedTask;
        }

        public Task<WakeupDue?> NextDueAsync(CancellationToken token)
        {
            owner.Events.Enqueue("next-due");
            return Task.FromResult(owner.NextDue);
        }

        public ValueTask DisposeAsync()
        {
            owner.Events.Enqueue("dispose " + Context.Generation);
            Disposed.TrySetResult();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal int Builds;
        internal int Starts;
        internal readonly ConcurrentQueue<string> Events = new();
        internal readonly List<FakeRuntime> Runtimes = [];
        internal TaskCompletionSource StartGate = Open();
        internal TaskCompletionSource StopGate = Open();
        internal TaskCompletionSource FactoryEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal bool Idle = true;
        internal WakeupDue? NextDue;
        internal Exception? BuildFailure;

        internal required HostedTestDatabase Database { get; init; }
        internal required TenantActivations Activations { get; set; }

        internal static TaskCompletionSource Open()
        {
            var source = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            source.SetResult();
            return source;
        }

        internal static TaskCompletionSource Closed() => new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal Task<IGenerationRuntime> BuildAsync(ActivationContext context, CancellationToken token)
        {
            Interlocked.Increment(ref Builds);
            FactoryEntered.TrySetResult();
            if (BuildFailure is { } failure)
                throw failure;
            var runtime = new FakeRuntime(context, this);
            lock (Runtimes)
                Runtimes.Add(runtime);
            return Task.FromResult<IGenerationRuntime>(runtime);
        }

        internal async Task<long> EpochAsync() => (long)(await Database.ScalarAsync("SELECT epoch FROM tenant_leases"))!;

        internal async Task<string> LeaseStateAsync() => (string)(await Database.ScalarAsync("SELECT state FROM tenant_leases"))!;

        public async ValueTask DisposeAsync()
        {
            await Activations.DisposeAsync();
            await Database.DisposeAsync();
        }
    }

    private static async Task<Fixture> CreateAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        Fixture? fixture = null;
        fixture = new Fixture
        {
            Database = database,
            Activations = null!,
        };
        fixture.Activations = new TenantActivations(
            database.OpenApp(),
            Replica,
            readerVersion: 2,
            LeaseTimings.Default,
            (context, token) => fixture.BuildAsync(context, token)
        );
        return fixture;
    }

    [Fact]
    public async Task SimultaneousActivationsAcquireOnceStartOnceAndNoFenceLandsOnTheReplacement()
    {
        await using var f = await CreateAsync();
        var before = await f.EpochAsync();
        f.StartGate = Fixture.Closed();
        // A local request, a mesh-style request, a wake-up and a waiter that gives up early.
        using var impatient = new CancellationTokenSource();
        var local = f.Activations.ActivateAsync(Tenant, ActivationCause.Request);
        var mesh = f.Activations.ActivateAsync(Tenant, ActivationCause.Request);
        var wake = f.Activations.ActivateAsync(Tenant, ActivationCause.Wakeup);
        var gaveUp = f.Activations.ActivateAsync(Tenant, ActivationCause.Request, impatient.Token);
        await f.FactoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        impatient.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => gaveUp);
        // Holding the lease isn't serving: nothing is published until the start completes.
        Assert.Null(f.Activations.Current(Tenant));
        f.StartGate.SetResult();
        var generations = await Task.WhenAll(local, mesh, wake);
        Assert.All(generations, item => Assert.Same(generations[0], item));
        var first = generations[0];
        Assert.Equal(1, f.Builds);
        Assert.Equal(1, f.Starts);
        Assert.Equal(before + 1, await f.EpochAsync());
        Assert.Equal(before + 1, first.Id.Epoch);
        Assert.NotNull(first.Gate.TryEnter());

        // A late activation of a live generation joins it: no second acquisition, no self-fence.
        Assert.Same(first, await f.Activations.ActivateAsync(Tenant, ActivationCause.Wakeup));
        Assert.Equal(before + 1, await f.EpochAsync());
        Assert.Equal(AdmissionLatch.None, first.Gate.Latched);

        // After a fence, the replacement takes the next epoch; late fences of the old generation
        // and its epoch don't land on it.
        Assert.True(await f.Activations.FenceAsync(first.Id));
        Assert.Equal(AdmissionLatch.Fence, first.Gate.Latched);
        await first.Disposed.WaitAsync(TimeSpan.FromSeconds(5));
        var replacement = await f.Activations.ActivateAsync(Tenant);
        Assert.Equal(before + 2, replacement.Id.Epoch);
        Assert.False(await f.Activations.FenceAsync(first.Id));
        await f.Activations.FenceGrantAsync(Tenant, first.Id.Epoch);
        Assert.Same(replacement, f.Activations.Current(Tenant));
        Assert.Equal(AdmissionLatch.None, replacement.Gate.Latched);
        Assert.Equal(2, f.Starts);
    }

    [Fact]
    public async Task ABuildThatFinishesAfterItsGrantWasLostIsDisposedNeverPublished()
    {
        await using var f = await CreateAsync();
        f.StartGate = Fixture.Closed();
        var activation = f.Activations.ActivateAsync(Tenant);
        await f.FactoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var epoch = await f.EpochAsync();
        await f.Activations.FenceGrantAsync(Tenant, epoch);
        f.StartGate.SetResult();
        await Assert.ThrowsAsync<TenantFencedException>(() => activation);
        Assert.Null(f.Activations.Current(Tenant));
        var late = Assert.Single(f.Runtimes);
        await late.Disposed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null(late.Context.Gate.TryEnter());
        // The next activation acquires anew.
        Assert.Equal(epoch + 1, (await f.Activations.ActivateAsync(Tenant)).Id.Epoch);
    }

    [Fact]
    public async Task AFailedStartReleasesTheLeaseWithABackoffAndATenantHeldElsewhereIsRefused()
    {
        await using var f = await CreateAsync();
        var tenantId = await f.Database.TenantIdAsync();
        f.BuildFailure = new InvalidOperationException("configuration refused");
        // A request that fails leaves no wake-up row behind.
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Activations.ActivateAsync(Tenant));
        Assert.Equal("released", await f.LeaseStateAsync());
        Assert.Null(await f.Database.ScalarAsync("SELECT 1 FROM tenant_wakeups"));
        // An autonomous activation that fails keeps a row with a backoff, so a scan retries.
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Activations.ActivateAsync(Tenant, ActivationCause.Recovery));
        Assert.Equal(1, await f.Database.ScalarAsync("SELECT attempts FROM tenant_wakeups"));
        Assert.Equal(true, await f.Database.ScalarAsync("SELECT next_attempt_at > now() FROM tenant_wakeups"));

        f.BuildFailure = null;
        await f.Database.TakeLeaseAsync(tenantId, "replica-b/0002");
        await Assert.ThrowsAsync<TenantHeldElsewhereException>(() => f.Activations.ActivateAsync(Tenant));
        Assert.Equal(2, f.Builds);
    }

    [Fact]
    public async Task IdleReleaseWritesTheWakeupAfterSettlingAndTheNextActivationCarriesIt()
    {
        await using var f = await CreateAsync();
        var first = await f.Activations.ActivateAsync(Tenant);
        var occurrence = new JsonObject { ["timer"] = "daily", ["at"] = "2026-11-28T09:00:00Z" };
        f.NextDue = new WakeupDue(new DateTimeOffset(2026, 11, 28, 8, 58, 0, TimeSpan.Zero), occurrence);

        // Not idle: admitted work, recent activity, or the runtime's own check.
        using (first.Gate.TryEnter())
            Assert.Equal(IdleReleaseOutcome.Busy, await f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero));
        Assert.Equal(IdleReleaseOutcome.Busy, await f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.FromHours(1)));
        f.Idle = false;
        Assert.Equal(IdleReleaseOutcome.Busy, await f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero));
        f.Idle = true;
        Assert.Equal(AdmissionLatch.None, first.Gate.Latched);

        Assert.Equal(IdleReleaseOutcome.Released, await f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero));
        Assert.Equal(
            ["start " + first.Id, "stop-producers", "settle", "next-due", "dispose " + first.Id],
            f.Events.ToArray()
        );
        Assert.Equal("released", await f.LeaseStateAsync());
        Assert.Equal(IdleReleaseOutcome.NotCurrent, await f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero));

        var second = await f.Activations.ActivateAsync(Tenant, ActivationCause.Wakeup);
        Assert.Equal(first.Id.Epoch + 1, second.Id.Epoch);
        var carried = f.Runtimes[^1].Context.Wakeup!;
        Assert.True(JsonNode.DeepEquals(occurrence, carried.Occurrence));
        // The row stays until the new generation replaces or clears it.
        Assert.Equal(1L, await f.Database.ScalarAsync("SELECT count(*) FROM tenant_wakeups"));
    }

    [Fact]
    public async Task WorkThatArrivesAfterTheLatchAbortsTheReleaseAndANewGenerationKeepsTheGrant()
    {
        await using var f = await CreateAsync();
        var first = await f.Activations.ActivateAsync(Tenant);
        f.StopGate = Fixture.Closed();
        var release = f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero);
        while (!f.Events.Contains("stop-producers"))
            await Task.Delay(10);
        // The latched gate refuses the work; it becomes demand and waits for the release.
        Assert.Null(first.Gate.TryEnter());
        var admit = f.Activations.AdmitAsync(Tenant);
        await Task.Delay(100);
        Assert.False(admit.IsCompleted);
        f.StopGate.SetResult();
        Assert.Equal(IdleReleaseOutcome.Aborted, await release);
        var (second, admission) = await admit.WaitAsync(TimeSpan.FromSeconds(10));
        using (admission)
        {
            Assert.Equal(first.Id.Epoch, second.Id.Epoch);
            Assert.Equal(first.Id.Number + 1, second.Id.Number);
            Assert.Equal("active", await f.LeaseStateAsync());
            Assert.Equal(first.Id.Epoch, await f.EpochAsync());
            Assert.Null(await f.Database.ScalarAsync("SELECT 1 FROM tenant_wakeups"));
            Assert.True(f.Runtimes[0].Disposed.Task.IsCompleted);
        }
    }

    [Fact]
    public async Task DisposingTheCoordinatorStopsEveryGenerationAndReleasesItsGrants()
    {
        await using var f = await CreateAsync();
        var generation = await f.Activations.ActivateAsync(Tenant);
        await f.Activations.DisposeAsync();
        Assert.Equal(AdmissionLatch.Stop, generation.Gate.Latched);
        await generation.Disposed.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("released", await f.LeaseStateAsync());
        await Assert.ThrowsAsync<ObjectDisposedException>(() => f.Activations.ActivateAsync(Tenant));
    }
}

public sealed class AdmissionGateTests
{
    [Fact]
    public void TheGateAdmitsOnlyBetweenPublicationAndItsLatch()
    {
        var gate = new AdmissionGate();
        Assert.Null(gate.TryEnter());
        gate.Open();
        var admission = gate.TryEnter();
        Assert.NotNull(admission);
        Assert.Equal(1, gate.InFlight);
        Assert.False(gate.TryLatchIdle(TimeSpan.Zero, () => true));
        var drained = gate.DrainedAsync();
        admission.Dispose();
        admission.Dispose();
        Assert.True(drained.IsCompleted);
        Assert.Equal(0, gate.InFlight);
        gate.Latch(AdmissionLatch.Drain);
        gate.Latch(AdmissionLatch.Fence);
        Assert.Equal(AdmissionLatch.Drain, gate.Latched);
        Assert.Null(gate.TryEnter());
        gate.Open();
        Assert.Null(gate.TryEnter());
    }

    [Fact]
    public async Task AnIdleLatchNeverRacesAnAdmission()
    {
        for (var round = 0; round < 200; round++)
        {
            var gate = new AdmissionGate();
            gate.Open();
            var latched = false;
            var violations = 0;
            var admitted = 0;
            using var stop = new CancellationTokenSource();
            var workers = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
            {
                while (!stop.IsCancellationRequested)
                    using (var admission = gate.TryEnter())
                        if (admission is not null)
                        {
                            Interlocked.Increment(ref admitted);
                            if (Volatile.Read(ref latched))
                                Interlocked.Increment(ref violations);
                        }
            })).ToArray();
            while (!gate.TryLatchIdle(TimeSpan.Zero, () => gate.InFlight == 0))
                await Task.Yield();
            Volatile.Write(ref latched, true);
            await Task.Delay(2);
            stop.Cancel();
            await Task.WhenAll(workers);
            Assert.Equal(0, violations);
            Assert.Equal(AdmissionLatch.IdleRelease, gate.Latched);
        }
    }
}
