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

    // How one tenant's fake runtimes behave.
    private sealed class Behavior
    {
        internal TaskCompletionSource StartGate = Fixture.Open();
        internal bool StartIgnoresCancellation;
        internal Action? OnLost;
        internal TaskCompletionSource DisposeGate = Fixture.Open();
        internal Exception? DisposeFailure;
    }

    private sealed class FakeRuntime(ActivationContext context, Fixture owner) : IGenerationRuntime
    {
        internal ActivationContext Context { get; } = context;
        internal TaskCompletionSource Disposed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        private Behavior Behavior => owner.For(Context.Generation.Tenant);

        public bool Idle => owner.Idle;

        public async Task StartAsync(CancellationToken token)
        {
            owner.Events.Enqueue("start " + Context.Generation);
            Interlocked.Increment(ref owner.Starts);
            if (Behavior.StartIgnoresCancellation)
                await Behavior.StartGate.Task;
            else
                await Behavior.StartGate.Task.WaitAsync(token);
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

        public async ValueTask DisposeAsync()
        {
            owner.Events.Enqueue("dispose " + Context.Generation);
            var behavior = Behavior;
            await behavior.DisposeGate.Task;
            Disposed.TrySetResult();
            if (behavior.DisposeFailure is { } failure)
                throw failure;
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal int Builds;
        internal int Starts;
        internal readonly ConcurrentQueue<string> Events = new();
        internal readonly List<FakeRuntime> Runtimes = [];
        internal readonly ConcurrentDictionary<string, Behavior> Behaviors = new(StringComparer.Ordinal);
        internal TaskCompletionSource StopGate = Open();
        internal TaskCompletionSource FactoryEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal bool Idle = true;
        internal WakeupDue? NextDue;
        internal Exception? BuildFailure;
        internal readonly TaskCompletionSource<long> Exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal int Exits;

        internal required HostedTestDatabase Database { get; init; }
        internal required TenantActivations Activations { get; set; }
        internal required GrantRenewer Renewer { get; set; }
        internal required FenceSupervisor Supervisor { get; set; }

        internal Behavior For(string tenant) => Behaviors.GetOrAdd(tenant, _ => new Behavior());

        // The default tenant's start gate, as the coalescing tests use it.
        internal TaskCompletionSource StartGate
        {
            get => For(Tenant).StartGate;
            set => For(Tenant).StartGate = value;
        }

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
            if (For(context.Generation.Tenant).OnLost is { } onLost)
                context.Fence.Lost.Register(onLost);
            var runtime = new FakeRuntime(context, this);
            lock (Runtimes)
                Runtimes.Add(runtime);
            return Task.FromResult<IGenerationRuntime>(runtime);
        }

        internal FakeRuntime RuntimeOf(string tenant)
        {
            lock (Runtimes)
                return Runtimes.Last(runtime => runtime.Context.Generation.Tenant == tenant);
        }

        internal async Task<long> EpochAsync(string tenant = Tenant) =>
            (long)(await Database.ScalarAsync("SELECT l.epoch FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = $1", tenant))!;

        internal async Task<string> LeaseStateAsync(string tenant = Tenant) =>
            (string)(await Database.ScalarAsync("SELECT l.state FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = $1", tenant))!;

        public async ValueTask DisposeAsync()
        {
            // Unblock whatever a test left stalled, so the coordinator can finish.
            foreach (var behavior in Behaviors.Values)
            {
                behavior.StartGate.TrySetResult();
                behavior.DisposeGate.TrySetResult();
            }
            await Activations.DisposeAsync();
            await Renewer.DisposeAsync();
            await Database.DisposeAsync();
        }
    }

    private const string Second = "beta";

    private static async Task<Fixture> CreateAsync(TimeSpan? drainBound = null, bool second = false)
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        if (second)
            await database.ExecuteOwnerAsync(
                $"INSERT INTO tenants (name) VALUES ('{Second}');"
                    + $" INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = '{Second}'"
            );
        Fixture? fixture = null;
        var control = database.OpenApp();
        var renewer = new GrantRenewer(control, Replica, LeaseTimings.Default);
        var supervisor = new FenceSupervisor(
            LeaseTimings.Default,
            drainBound ?? TimeSpan.FromSeconds(8),
            code =>
            {
                Interlocked.Increment(ref fixture!.Exits);
                fixture.Exited.TrySetResult(System.Diagnostics.Stopwatch.GetTimestamp());
            }
        );
        fixture = new Fixture
        {
            Database = database,
            Activations = null!,
            Renewer = renewer,
            Supervisor = supervisor,
        };
        fixture.Activations = new TenantActivations(
            control,
            Replica,
            readerVersion: 2,
            LeaseTimings.Default,
            (context, token) => fixture.BuildAsync(context, token),
            renewer,
            supervisor
        );
        return fixture;
    }

    private static TimeSpan Since(long timestamp) => System.Diagnostics.Stopwatch.GetElapsedTime(timestamp);

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

    // ---- Supervised fences (plan §2.3) ----

    private static readonly TimeSpan Bound = TimeSpan.FromMilliseconds(600);

    // Slack for the exit thread's wake-up on a loaded runner; the lower bound is exact.
    private static readonly TimeSpan Late = TimeSpan.FromMilliseconds(900);

    private static async Task WaitForEventAsync(Fixture f, string prefix)
    {
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        while (!f.Events.Any(item => item.StartsWith(prefix, StringComparison.Ordinal)))
        {
            Assert.True(deadline.Elapsed < TimeSpan.FromSeconds(10), "No event " + prefix);
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task AFenceDuringAGatedStartCancelsItClosesItsDatabaseAndReleasesNothingWhileAnotherTenantServes()
    {
        await using var f = await CreateAsync(Bound, second: true);
        var other = await f.Activations.ActivateAsync(Second);
        f.StartGate = Fixture.Closed();
        var activation = f.Activations.ActivateAsync(Tenant);
        await WaitForEventAsync(f, "start " + Tenant);
        var epoch = await f.EpochAsync();
        await f.Activations.FenceGrantAsync(Tenant, epoch).WaitAsync(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<TenantFencedException>(() => activation);
        var fenced = f.RuntimeOf(Tenant);
        Assert.True(fenced.Disposed.Task.IsCompleted);
        Assert.True(fenced.Context.Fence.IsClosed);
        Assert.True(fenced.Context.Fence.Lost.IsCancellationRequested);
        Assert.Null(fenced.Context.Gate.TryEnter());
        // A lost grant isn't released: the row expires, or the next acquisition raises the epoch.
        Assert.Equal("active", await f.LeaseStateAsync());
        Assert.Equal(epoch, await f.EpochAsync());
        Assert.Same(other, f.Activations.Current(Second));
        using (var admission = other.Gate.TryEnter())
            Assert.NotNull(admission);
        Assert.Equal(0, f.Exits);
        f.StartGate.SetResult();
        Assert.Equal(epoch + 1, (await f.Activations.ActivateAsync(Tenant)).Id.Epoch);
    }

    [Fact]
    public async Task AStalledCancellationCallbackEndsTheProcessAtTheDeadlineWhileAnotherTenantServes()
    {
        await using var f = await CreateAsync(Bound, second: true);
        var other = await f.Activations.ActivateAsync(Second);
        using var unstall = new ManualResetEventSlim();
        var behavior = f.For(Tenant);
        behavior.StartGate = Fixture.Closed();
        behavior.StartIgnoresCancellation = true;
        // Blocks the thread that cancels the generation's token.
        behavior.OnLost = () => unstall.Wait(TimeSpan.FromSeconds(10));
        var activation = f.Activations.ActivateAsync(Tenant);
        await WaitForEventAsync(f, "start " + Tenant);
        var epoch = await f.EpochAsync();

        var fencedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        var fence = f.Activations.FenceGrantAsync(Tenant, epoch);
        var exitedAt = await f.Exited.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var elapsed = System.Diagnostics.Stopwatch.GetElapsedTime(fencedAt, exitedAt);
        Assert.InRange(elapsed, Bound, Bound + Late);
        Assert.Equal(1, f.Exits);
        await fence.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(f.RuntimeOf(Tenant).Context.Fence.IsClosed);
        Assert.Same(other, f.Activations.Current(Second));
        using (var admission = other.Gate.TryEnter())
            Assert.NotNull(admission);

        unstall.Set();
        behavior.StartGate.SetResult();
        await Assert.ThrowsAsync<TenantFencedException>(() => activation);
    }

    [Fact]
    public async Task AnOverrunningStopEndsTheProcessAtTheDeadlineCountedFromTheFence()
    {
        await using var f = await CreateAsync(Bound);
        var generation = await f.Activations.ActivateAsync(Tenant);
        f.For(Tenant).DisposeGate = Fixture.Closed();
        var fencedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        Assert.False(await f.Activations.FenceAsync(generation.Id).WaitAsync(TimeSpan.FromSeconds(10)));
        var elapsed = System.Diagnostics.Stopwatch.GetElapsedTime(fencedAt, await f.Exited.Task);
        Assert.InRange(elapsed, Bound, Bound + Late);
        // Latched, renewal stopped and the database closed before the stop was joined.
        Assert.Equal(AdmissionLatch.Fence, generation.Gate.Latched);
        Assert.True(generation.Handle.Lost.IsCompleted);
        Assert.True(generation.Fence.IsClosed);
        Assert.Equal("active", await f.LeaseStateAsync());
    }

    [Fact]
    public async Task AFenceDuringGracefulShutdownEndsTheProcessAtItsDeadlineWithoutWaitingForOtherDrains()
    {
        await using var f = await CreateAsync(Bound, second: true);
        await f.Activations.ActivateAsync(Tenant);
        await f.Activations.ActivateAsync(Second);
        var epoch = await f.EpochAsync();
        f.For(Tenant).DisposeGate = Fixture.Closed();
        f.For(Second).DisposeGate = Fixture.Closed();
        var shutdown = f.Activations.DisposeAsync().AsTask();
        await WaitForEventAsync(f, "dispose " + Tenant);
        await WaitForEventAsync(f, "dispose " + Second);

        var fencedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        _ = f.Activations.FenceGrantAsync(Tenant, epoch);
        var elapsed = System.Diagnostics.Stopwatch.GetElapsedTime(fencedAt, await f.Exited.Task.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.InRange(elapsed, Bound, Bound + Late);
        // The other tenant's drain is still running; the exit didn't wait for it.
        Assert.False(shutdown.IsCompleted);
        Assert.True(f.RuntimeOf(Tenant).Context.Fence.IsClosed);

        f.For(Tenant).DisposeGate.SetResult();
        f.For(Second).DisposeGate.SetResult();
        await shutdown.WaitAsync(TimeSpan.FromSeconds(10));
        // The fenced grant isn't released; the other one, which stopped cleanly, is.
        Assert.Equal("active", await f.LeaseStateAsync());
        Assert.Equal("released", await f.LeaseStateAsync(Second));
    }

    [Fact]
    public async Task AFailedStopEndsTheProcessOnlyWithAdmittedWorkAndNeverReleasesTheGrant()
    {
        await using var f = await CreateAsync(Bound);
        f.For(Tenant).DisposeFailure = new InvalidOperationException("disposal failed");

        // Nothing admitted: the failure is logged, the grant dropped without a release.
        var quiet = await f.Activations.ActivateAsync(Tenant);
        Assert.True(await f.Activations.FenceAsync(quiet.Id));
        Assert.Equal(0, f.Exits);
        Assert.Equal("active", await f.LeaseStateAsync());

        // Work still admitted when the stop fails: the process ends at the deadline.
        var busy = await f.Activations.ActivateAsync(Tenant);
        Assert.Equal(quiet.Id.Epoch + 1, busy.Id.Epoch);
        using var work = busy.Gate.TryEnter();
        var fencedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        Assert.False(await f.Activations.FenceAsync(busy.Id).WaitAsync(TimeSpan.FromSeconds(10)));
        var elapsed = System.Diagnostics.Stopwatch.GetElapsedTime(fencedAt, await f.Exited.Task);
        Assert.InRange(elapsed, Bound, Bound + Late);
    }

    [Fact]
    public async Task AnIdleReleaseOrAShutdownWhoseStopFailedReleasesNothing()
    {
        await using var f = await CreateAsync(Bound);
        var first = await f.Activations.ActivateAsync(Tenant);
        f.For(Tenant).DisposeFailure = new InvalidOperationException("disposal failed");
        Assert.Equal(IdleReleaseOutcome.StopFailed, await f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero));
        Assert.Equal("active", await f.LeaseStateAsync());
        Assert.Null(await f.Database.ScalarAsync("SELECT 1 FROM tenant_wakeups"));
        Assert.True(first.Fence.IsClosed);
        // The dropped grant is never reused: the next generation acquires anew.
        var second = await f.Activations.ActivateAsync(Tenant);
        Assert.Equal(first.Id.Epoch + 1, second.Id.Epoch);
        await f.Activations.DisposeAsync();
        Assert.Equal("active", await f.LeaseStateAsync());
        Assert.Equal(second.Id.Epoch, await f.EpochAsync());
        Assert.Equal(0, f.Exits);
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
