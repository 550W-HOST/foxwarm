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
        // Blocks the thread that calls DisposeAsync until set (a synchronous stall).
        internal ManualResetEventSlim? DisposeStall;
        internal Exception? StartFailure;
        internal TaskCompletionSource FactoryGate = Fixture.Open();
        internal bool StopIgnoresCancellation;
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
            if (Behavior.StartFailure is { } failure)
                throw failure;
        }

        public async Task StopProducersAsync(CancellationToken token)
        {
            owner.Events.Enqueue("stop-producers");
            if (Behavior.StopIgnoresCancellation)
                await owner.StopGate.Task;
            else
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
            behavior.DisposeStall?.Wait(TimeSpan.FromSeconds(20));
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

        internal async Task<IGenerationRuntime> BuildAsync(ActivationContext context, CancellationToken token)
        {
            Interlocked.Increment(ref Builds);
            FactoryEntered.TrySetResult();
            if (BuildFailure is { } failure)
                throw failure;
            // A factory that ignores cancellation, as a slow composition can.
            await For(context.Generation.Tenant).FactoryGate.Task;
            if (For(context.Generation.Tenant).OnLost is { } onLost)
                context.Fence.Lost.Register(onLost);
            var runtime = new FakeRuntime(context, this);
            lock (Runtimes)
                Runtimes.Add(runtime);
            return runtime;
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
                behavior.FactoryGate.TrySetResult();
                behavior.DisposeStall?.Set();
            }
            StopGate.TrySetResult();
            await Activations.DisposeAsync();
            await Renewer.DisposeAsync();
            await Database.DisposeAsync();
        }
    }

    [Fact]
    public async Task TheFirstObservationOfATrackedGrantIsNotLostBeforeRegistration()
    {
        await using var f=await CreateAsync();
        var entered=Fixture.Closed();
        var observed=Fixture.Closed();
        f.Activations.AfterTrack=grant=>
        {
            _=Task.Run(()=>
            {
                entered.SetResult();
                f.Activations.SettingsChanged(grant,false);
                observed.SetResult();
            });
            entered.Task.GetAwaiter().GetResult();
            // If slot ownership is unsynchronized the observation finishes here and is lost.
            observed.Task.Wait(TimeSpan.FromMilliseconds(200));
        };
        f.Activations.BeforeRegister=()=>observed.Task;
        await Assert.ThrowsAsync<LeaseRefusedException>(()=>f.Activations.ActivateAsync(Tenant));
        Assert.Null(f.Activations.Current(Tenant));
        Assert.Equal("released",await f.LeaseStateAsync());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AStaleBuildHasOneStopBoundAcrossStartAndDisposal(bool stuckInStart)
    {
        await using var f = await CreateAsync(drainBound:TimeSpan.FromMilliseconds(400));
        var behavior = f.For(Tenant);
        behavior.StartGate = Fixture.Closed();
        behavior.StartIgnoresCancellation = true;
        behavior.DisposeGate = Fixture.Closed();
        var starting = f.Activations.ActivateAsync(Tenant);
        await f.FactoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var grant=Assert.Single(f.Activations.Grants());
        f.Activations.SettingsChanged(grant,false);
        if (!stuckInStart) behavior.StartGate.TrySetResult();
        await f.Exited.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal("active",await f.LeaseStateAsync());
        behavior.StartGate.TrySetResult(); behavior.DisposeGate.TrySetResult();
        await Assert.ThrowsAnyAsync<Exception>(()=>starting);
    }

    private const string Second = "beta";

    private static async Task<Fixture> CreateAsync(
        TimeSpan? drainBound = null,
        bool second = false,
        TimeSpan? shutdownBound = null,
        LeaseTimings? leaseTimings = null,
        bool renewing = false
    )
    {
        var timings = leaseTimings ?? LeaseTimings.Default;
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        await database.RegisterBootsAsync(Replica);
        if (second)
            await database.ExecuteOwnerAsync(
                $"INSERT INTO tenants (name) VALUES ('{Second}');"
                    + $" INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = '{Second}'"
            );
        Fixture? fixture = null;
        var control = database.OpenApp();
        var renewer = new GrantRenewer(control, control, Replica, timings);
        if (renewing)
            renewer.Start();
        var supervisor = new FenceSupervisor(
            timings,
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
            timings,
            (context, token) => fixture.BuildAsync(context, token),
            renewer,
            supervisor
        )
        {
            ShutdownBound = shutdownBound ?? supervisor.DrainBound,
        };
        return fixture;
    }

    private static TimeSpan Since(long timestamp) => System.Diagnostics.Stopwatch.GetElapsedTime(timestamp);

    [Fact]
    public async Task ExactDispatchPinsOnlyTheNamedPublishedTenantBootAndEpoch()
    {
        await using var f = await CreateAsync(second: true);
        var owner = f.Activations;
        f.StartGate = Fixture.Closed();
        var starting = owner.ActivateAsync(Tenant);
        await f.FactoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var epoch = await f.EpochAsync();
        Assert.Null(owner.TryAdmitExact(Tenant, epoch, Replica));
        f.StartGate.SetResult();
        var generation = await starting;
        Assert.Null(owner.TryAdmitExact(Second, epoch, Replica));
        Assert.Null(owner.TryAdmitExact(Tenant, epoch, "another-boot"));
        Assert.Null(owner.TryAdmitExact(Tenant, epoch - 1, Replica));
        Assert.Null(owner.TryAdmitExact(Tenant, epoch + 1, Replica));
        Assert.Equal(0, generation.Gate.InFlight);
        var exact = owner.TryAdmitExact(Tenant, epoch, Replica);
        Assert.NotNull(exact);
        using (exact.Value.Admission)
        {
            Assert.Same(generation, exact.Value.Generation);
            Assert.Equal(1, generation.Gate.InFlight);
            generation.Gate.Latch(AdmissionLatch.Drain);
            Assert.Null(owner.TryAdmitExact(Tenant, epoch, Replica));
        }
        Assert.Equal(0, generation.Gate.InFlight);
        Assert.Equal(1, f.Builds);
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
        using (var admission = first.Gate.TryEnter())
            Assert.NotNull(admission);

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
        await using var f = await CreateAsync(Bound, second: true, shutdownBound: TimeSpan.FromSeconds(20));
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
    public async Task AFailedStopIsUnconfirmedReleasesNothingAndEndsTheProcessAtItsHardStop()
    {
        await using var f = await CreateAsync(Bound);
        f.For(Tenant).DisposeFailure = new InvalidOperationException("disposal failed");
        // An empty gate doesn't make a failed disposal harmless.
        var generation = await f.Activations.ActivateAsync(Tenant);
        var fencedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        Assert.False(await f.Activations.FenceAsync(generation.Id).WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.InRange(System.Diagnostics.Stopwatch.GetElapsedTime(fencedAt, await f.Exited.Task), Bound, Bound + Late);
        Assert.Equal("active", await f.LeaseStateAsync());
        // The tenant stays unavailable here: no new acquisition after an unconfirmed stop.
        await Assert.ThrowsAsync<TenantFencedException>(() => f.Activations.ActivateAsync(Tenant));
        Assert.Equal(generation.Id.Epoch, await f.EpochAsync());
    }

    [Fact]
    public async Task AStopIsConfirmedOnlyOnceAdmittedWorkHasEnded()
    {
        await using var f = await CreateAsync(Bound);
        var generation = await f.Activations.ActivateAsync(Tenant);
        var work = generation.Gate.TryEnter()!;
        var fence = f.Activations.FenceAsync(generation.Id);
        await generation.Disposed.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(Bound / 3);
        Assert.False(fence.IsCompleted);
        work.Dispose();
        Assert.True(await fence.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(0, f.Exits);
    }

    [Fact]
    public async Task AnIdleReleaseWhoseStopFailedReleasesNothingAndKeepsTheTenantUnavailable()
    {
        await using var f = await CreateAsync(Bound);
        var first = await f.Activations.ActivateAsync(Tenant);
        f.For(Tenant).DisposeFailure = new InvalidOperationException("disposal failed");
        var failedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        Assert.Equal(IdleReleaseOutcome.StopFailed, await f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero));
        Assert.Equal("active", await f.LeaseStateAsync());
        Assert.Null(await f.Database.ScalarAsync("SELECT 1 FROM tenant_wakeups"));
        Assert.True(first.Fence.IsClosed);
        // No self-reacquisition after an unconfirmed stop: the process ends at the hard stop.
        await Assert.ThrowsAsync<TenantFencedException>(() => f.Activations.ActivateAsync(Tenant));
        Assert.Equal(first.Id.Epoch, await f.EpochAsync());
        Assert.InRange(System.Diagnostics.Stopwatch.GetElapsedTime(failedAt, await f.Exited.Task.WaitAsync(TimeSpan.FromSeconds(5))), Bound, Bound + Late);
        await f.Activations.DisposeAsync();
        Assert.Equal("active", await f.LeaseStateAsync());
    }

    // ---- Retirement, confirmation and bounds (review of batch 3) ----

    private static readonly LeaseTimings Short = new(TimeSpan.FromSeconds(3), TimeSpan.FromMilliseconds(400), TimeSpan.FromMilliseconds(1200));

    [Fact]
    public async Task DemandWhileAFencedGenerationIsDisposingWaitsForItsConfirmedStop()
    {
        await using var f = await CreateAsync(TimeSpan.FromSeconds(5));
        var first = await f.Activations.ActivateAsync(Tenant);
        f.For(Tenant).DisposeGate = Fixture.Closed();
        var fence = f.Activations.FenceAsync(first.Id);
        await WaitForEventAsync(f, "dispose " + Tenant);
        var demand = f.Activations.ActivateAsync(Tenant);
        await Task.Delay(300);
        // No acquisition while the old generation may still run.
        Assert.False(demand.IsCompleted);
        Assert.Equal(first.Id.Epoch, await f.EpochAsync());
        Assert.Equal(1, f.Starts);
        f.For(Tenant).DisposeGate.SetResult();
        Assert.True(await fence.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(first.Id.Epoch + 1, (await demand.WaitAsync(TimeSpan.FromSeconds(5))).Id.Epoch);
    }

    [Fact]
    public async Task ALossInsideTheFactoryDisposesTheLateBuildWithoutStartingIt()
    {
        await using var f = await CreateAsync(TimeSpan.FromSeconds(5));
        f.For(Tenant).FactoryGate = Fixture.Closed();
        var activation = f.Activations.ActivateAsync(Tenant);
        await f.FactoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var epoch = await f.EpochAsync();
        var fence = f.Activations.FenceGrantAsync(Tenant, epoch);
        f.For(Tenant).FactoryGate.SetResult();
        await Assert.ThrowsAsync<TenantFencedException>(() => activation);
        await fence.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, f.Starts);
        Assert.True(f.RuntimeOf(Tenant).Disposed.Task.IsCompleted);
        Assert.Equal(0, f.Exits);
        Assert.Equal("active", await f.LeaseStateAsync());
    }

    [Fact]
    public async Task AFailedStartWhoseCleanupFailedReleasesNothingAndEndsTheProcess()
    {
        await using var f = await CreateAsync(Bound);
        f.For(Tenant).StartFailure = new InvalidOperationException("start refused");
        f.For(Tenant).DisposeFailure = new InvalidOperationException("cleanup failed");
        var failedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        await Assert.ThrowsAnyAsync<Exception>(() => f.Activations.ActivateAsync(Tenant));
        Assert.Equal("active", await f.LeaseStateAsync());
        Assert.Null(await f.Database.ScalarAsync("SELECT 1 FROM tenant_wakeups"));
        await Assert.ThrowsAsync<TenantFencedException>(() => f.Activations.ActivateAsync(Tenant));
        Assert.InRange(System.Diagnostics.Stopwatch.GetElapsedTime(failedAt, await f.Exited.Task.WaitAsync(TimeSpan.FromSeconds(5))), Bound, Bound + Late);
    }

    [Fact]
    public async Task AFactoryWhoseOwnCleanupFailedIsAnUnconfirmedStop()
    {
        await using var f = await CreateAsync(Bound);
        f.BuildFailure = new StartupCleanupFailedException(new InvalidOperationException("composition failed"), [new IOException("cleanup failed")]);
        await Assert.ThrowsAnyAsync<Exception>(() => f.Activations.ActivateAsync(Tenant));
        Assert.Equal("active", await f.LeaseStateAsync());
        await f.Exited.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task AnExpiredGrantAdmitsNothingAndItsHardStopNeedsNoLossHandler()
    {
        // No renewal and no watchdog: nothing decides the loss but the clock.
        await using var f = await CreateAsync(Bound, leaseTimings: Short);
        f.For(Tenant).DisposeGate = Fixture.Closed();
        var generation = await f.Activations.ActivateAsync(Tenant);
        var acquired = generation.Grant.AcquisitionStart;
        while (System.Diagnostics.Stopwatch.GetElapsedTime(acquired) < Short.FenceAfter)
        {
            using (var admission = generation.Gate.TryEnter())
                Assert.NotNull(admission);
            await Task.Delay(50);
        }
        Assert.Null(generation.Gate.TryEnter());
        Assert.Equal(AdmissionLatch.None, generation.Gate.Latched);
        // The pre-armed hard stop: the grant's deadline plus the drain bound, counted from the
        // acquisition, however late any thread runs.
        var exitedAt = await f.Exited.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.InRange(System.Diagnostics.Stopwatch.GetElapsedTime(acquired, exitedAt), Short.FenceAfter + Bound, Short.FenceAfter + Bound + Late);
    }

    [Fact]
    public async Task APublishedGenerationPastItsDeadlineIsntReturnedToAnActivation()
    {
        await using var f = await CreateAsync(Bound, leaseTimings: Short);
        var first = await f.Activations.ActivateAsync(Tenant);
        await Task.Delay(Short.FenceAfter + TimeSpan.FromMilliseconds(100));
        var second = await f.Activations.ActivateAsync(Tenant).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.NotSame(first, second);
        Assert.Equal(AdmissionLatch.Fence, first.Gate.Latched);
        Assert.True(first.Disposed.IsCompleted);
        Assert.Equal(first.Id.Epoch + 1, second.Id.Epoch);
    }

    [Fact]
    public async Task AStalledIdleReleaseIsBoundedAndHandedToTheSupervisedFence()
    {
        await using var f = await CreateAsync(Bound);
        var first = await f.Activations.ActivateAsync(Tenant);
        // Producers that stop only when cancelled: the fence cancels them, and the stop confirms.
        f.StopGate = Fixture.Closed();
        var started = System.Diagnostics.Stopwatch.StartNew();
        Assert.Equal(IdleReleaseOutcome.Overrun, await f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero).WaitAsync(TimeSpan.FromSeconds(10)));
        // The timer may fire a few milliseconds early.
        Assert.InRange(started.Elapsed, Bound - TimeSpan.FromMilliseconds(20), Bound * 2 + Late);
        Assert.Equal(0, f.Exits);
        Assert.True(first.Fence.IsClosed);
        Assert.True(first.Handle.Lost.IsCompleted);
        Assert.True(first.Disposed.IsCompleted);
        Assert.Equal("active", await f.LeaseStateAsync());
        f.StopGate = Fixture.Open();
        Assert.Equal(first.Id.Epoch + 1, (await f.Activations.ActivateAsync(Tenant)).Id.Epoch);
    }

    [Fact]
    public async Task AFenceDuringAnIdleReleaseJoinsItsStepsAndExitsWhenTheyNeverEnd()
    {
        await using var f = await CreateAsync(Bound);
        var first = await f.Activations.ActivateAsync(Tenant);
        f.StopGate = Fixture.Closed();
        f.For(Tenant).StopIgnoresCancellation = true;
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        var release = f.Activations.TryReleaseIdleAsync(first.Id, TimeSpan.Zero);
        await WaitForEventAsync(f, "stop-producers");
        var demand = f.Activations.AdmitAsync(Tenant);
        var exitedAt = await f.Exited.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // One drain bound for the release, then one from the loss: never the disposal alone.
        // Each Task.Delay is scheduled at millisecond granularity; the measured start may be
        // between ticks. This still distinguishes two drain bounds from a single one.
        Assert.InRange(System.Diagnostics.Stopwatch.GetElapsedTime(started, exitedAt), Bound * 2 - TimeSpan.FromMilliseconds(2), Bound * 2 + Late);
        Assert.False(first.Disposed.IsCompleted);
        Assert.Equal(IdleReleaseOutcome.Overrun, await release.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.False(demand.IsCompleted);
        Assert.Equal(first.Id.Epoch, await f.EpochAsync());
        Assert.Equal("active", await f.LeaseStateAsync());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AStuckTenantDoesntHoldAHealthySiblingsShutdownOrRelease(bool stuckFirst)
    {
        await using var f = await CreateAsync(TimeSpan.FromSeconds(5), second: true, shutdownBound: TimeSpan.FromSeconds(1));
        var (stuckTenant, healthyTenant) = stuckFirst ? (Tenant, Second) : (Second, Tenant);
        await f.Activations.ActivateAsync(stuckTenant);
        var healthy = await f.Activations.ActivateAsync(healthyTenant);
        // A synchronous stall in one tenant's disposal.
        using var stall = new ManualResetEventSlim();
        f.For(stuckTenant).DisposeStall = stall;
        var started = System.Diagnostics.Stopwatch.StartNew();
        var shutdown = f.Activations.ShutdownAsync();
        await healthy.Disposed.WaitAsync(TimeSpan.FromSeconds(5));
        while (await f.LeaseStateAsync(healthyTenant) != "released")
        {
            Assert.True(started.Elapsed < TimeSpan.FromMilliseconds(600), "the healthy tenant wasn't released promptly");
            await Task.Delay(20);
        }
        Assert.False(await shutdown.WaitAsync(TimeSpan.FromSeconds(5)));
        // The timer may fire a few milliseconds early.
        Assert.InRange(started.Elapsed, TimeSpan.FromMilliseconds(980), TimeSpan.FromSeconds(1) + Late);
        // The stuck tenant lost its grant at the bound, unreleased.
        Assert.Equal("active", await f.LeaseStateAsync(stuckTenant));
        stall.Set();
    }

    // ---- Shutdown accounting (review 4b #2) ----

    [Fact]
    public async Task AShutdownWithAnAcquisitionInFlightIsNotCleanAndAGrantAcknowledgedLaterIsHandedBack()
    {
        await using var f = await CreateAsync(shutdownBound: TimeSpan.FromSeconds(1));
        var tenant = await f.Database.TenantIdAsync();
        // Another transaction holds the lease row, so the acquisition waits on its lock.
        await using var holder = new Npgsql.NpgsqlConnection(f.Database.OwnerConnectionString);
        await holder.OpenAsync();
        await using var holding = await holder.BeginTransactionAsync();
        await using (var locking = new Npgsql.NpgsqlCommand($"SELECT 1 FROM tenant_leases WHERE tenant_id = {tenant} FOR UPDATE", holder, holding))
            await locking.ExecuteScalarAsync();
        var activation = f.Activations.ActivateAsync(Tenant);
        await Task.Delay(300);
        Assert.False(await f.Activations.ShutdownAsync(), "a shutdown with an unresolved acquisition counted as clean");
        // The acquisition commits after the shutdown's decision: its grant goes back at once.
        await holding.CommitAsync();
        await Assert.ThrowsAsync<TenantFencedException>(() => activation.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal("released", await f.LeaseStateAsync());
        Assert.Equal(1L, await f.EpochAsync());
        Assert.Equal(0, f.Builds);
    }

    [Fact]
    public async Task AShutdownDuringABuildWhoseCleanupFailsIsNotClean()
    {
        await using var f = await CreateAsync(shutdownBound: TimeSpan.FromSeconds(5));
        f.For(Tenant).FactoryGate = Fixture.Closed();
        var activation = f.Activations.ActivateAsync(Tenant);
        await f.FactoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var shutdown = f.Activations.ShutdownAsync();
        // The failed settlement's follow-up runs only after the shutdown decided: the decision
        // can't rely on it to find the failed stop.
        f.Activations.StopFollowUp = _ => shutdown.Wait(TimeSpan.FromSeconds(10));
        await Task.Delay(100);
        f.For(Tenant).FactoryGate.SetException(
            new StartupCleanupFailedException(new IOException("build failed"), [new IOException("cleanup failed")])
        );
        await Assert.ThrowsAnyAsync<Exception>(() => activation);
        Assert.False(await shutdown.WaitAsync(TimeSpan.FromSeconds(10)), "a failed build cleanup counted as a clean stop");
        Assert.Equal("active", await f.LeaseStateAsync());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShutdownSeesTheHandBackBeforeItsDatabaseCallStarts(bool placement)
    {
        await using var f = await CreateAsync(shutdownBound: TimeSpan.FromMilliseconds(400));
        var generation = await f.Activations.ActivateAsync(Tenant);
        var ready = Fixture.Closed();
        var proceed = Fixture.Closed();
        f.Activations.BeforeReleaseWrite = () =>
        {
            ready.TrySetResult();
            return proceed.Task;
        };
        Task retire = placement
            ? f.Activations.RetireForPlacementAsync(generation.Id, "placement changed")
            : f.Activations.TryReleaseIdleAsync(generation.Id, TimeSpan.Zero);
        try
        {
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True((await generation.Stopped).Confirmed);
            Assert.False(await f.Activations.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(5)),
                "Shutdown counted an outstanding hand-back as clean.");
            Assert.Equal("active", await f.LeaseStateAsync());
        }
        finally
        {
            proceed.TrySetResult();
            await retire.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.Equal("released", await f.LeaseStateAsync());
    }

    // ---- Placement proof and release outcomes (review 4c) ----

    private static async Task UntilAsync(Func<bool> condition, TimeSpan limit, string what)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (!condition())
        {
            Assert.True(watch.Elapsed < limit, what);
            await Task.Delay(20);
        }
    }

    // An edit committed while the factory runs, which no check sees: the published generation
    // stops renewing and is fenced within the TTL.
    [Fact]
    public async Task AnEditDuringAColdStartEndsRenewalAndFencesTheGenerationItBuilt()
    {
        await using var f = await CreateAsync(Bound, leaseTimings: Short, renewing: true);
        f.For(Tenant).FactoryGate = Fixture.Closed();
        var activation = f.Activations.ActivateAsync(Tenant);
        await f.FactoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await f.Database.ExecuteOwnerAsync($"UPDATE tenants SET profile = 'operator', pinned_role = 'master-host' WHERE name = '{Tenant}'");
        f.For(Tenant).FactoryGate.SetResult();
        TenantGeneration? generation = null;
        try
        {
            generation = await activation.WaitAsync(TimeSpan.FromSeconds(10));
        }
        catch (TenantFencedException) { }
        var runtime = f.RuntimeOf(Tenant);
        await UntilAsync(() => runtime.Disposed.Task.IsCompleted, Short.Ttl, "the old-profile runtime outlived its grant");
        Assert.True(generation?.IsFenced ?? true);
    }

    // A placement change with no notification at all (none is listened to here): renewal alone
    // ends the published generation.
    [Fact]
    public async Task APinChangeNoOneIsToldAboutEndsRenewalOfAPublishedGeneration()
    {
        await using var f = await CreateAsync(Bound, leaseTimings: Short, renewing: true);
        var generation = await f.Activations.ActivateAsync(Tenant);
        await Task.Delay(Short.RenewInterval * 2);
        Assert.False(generation.IsFenced);
        await f.Database.ExecuteOwnerAsync($"UPDATE tenants SET profile = 'operator', pinned_role = 'master-host' WHERE name = '{Tenant}'");
        await UntilAsync(() => generation.IsFenced, Short.Ttl, "the generation kept renewing under a pin its role doesn't allow");
    }

    // A grant without a generation at shutdown is released at once, and the shutdown is clean.
    [Fact]
    public async Task AGrantWithoutAGenerationAtShutdownIsReleasedAndTheShutdownIsClean()
    {
        await using var f = await CreateAsync(shutdownBound: TimeSpan.FromSeconds(5));
        var stored = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = Fixture.Closed();
        f.Activations.BeforeRegister = async () =>
        {
            stored.TrySetResult();
            await proceed.Task;
        };
        var activation = f.Activations.ActivateAsync(Tenant);
        await stored.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var shutdown = f.Activations.ShutdownAsync();
        // Released while the activation still waits to register.
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (await f.LeaseStateAsync() != "released")
        {
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(4), "the grant wasn't released during the shutdown");
            await Task.Delay(20);
        }
        proceed.SetResult();
        await Assert.ThrowsAnyAsync<Exception>(() => activation.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.True(await shutdown.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal(0, f.Builds);
    }

    // A grant without a generation at shutdown is handed back under the one deadline: when its
    // release can't take the row lock, the shutdown isn't clean and ends at the bound, not after
    // a further lock wait.
    [Fact]
    public async Task AGrantWithoutAGenerationAtShutdownIsReleasedUnderTheOneDeadline()
    {
        await using var f = await CreateAsync(shutdownBound: TimeSpan.FromSeconds(1));
        var stored = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = Fixture.Closed();
        f.Activations.BeforeRegister = async () =>
        {
            stored.TrySetResult();
            await proceed.Task;
        };
        var activation = f.Activations.ActivateAsync(Tenant);
        await stored.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var tenant = await f.Database.TenantIdAsync();
        await using var holder = new Npgsql.NpgsqlConnection(f.Database.OwnerConnectionString);
        await holder.OpenAsync();
        await using var holding = await holder.BeginTransactionAsync();
        await using (var locking = new Npgsql.NpgsqlCommand($"SELECT 1 FROM tenant_leases WHERE tenant_id = {tenant} FOR UPDATE", holder, holding))
            await locking.ExecuteScalarAsync();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        // The release's lock timeout is the renew interval (5 s), past the 1 s bound.
        Assert.False(await f.Activations.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(20)), "a shutdown with an unreleased grant counted as clean");
        Assert.InRange(watch.Elapsed, TimeSpan.Zero, TimeSpan.FromSeconds(2.5));
        // At the decision the row is still this replica's. The cancelled release's outcome is
        // unknown (it may still apply once the lock frees), which is why the shutdown is unclean.
        await using (var row = new Npgsql.NpgsqlCommand($"SELECT state FROM tenant_leases WHERE tenant_id = {tenant}", holder, holding))
            Assert.Equal("active", await row.ExecuteScalarAsync());
        proceed.SetResult();
        await Assert.ThrowsAnyAsync<Exception>(() => activation.WaitAsync(TimeSpan.FromSeconds(10)));
        await holding.RollbackAsync();
        Assert.Equal(0, f.Builds);
    }

    // ---- Placement at acquisition (batch 4) ----

    [Fact]
    public async Task TheRuntimeIsBuiltForTheProfileTheAcquisitionChecked()
    {
        await using var f = await CreateAsync(Bound);
        f.For(Tenant).FactoryGate = Fixture.Closed();
        var activation = f.Activations.ActivateAsync(Tenant);
        await f.FactoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // The profile changes after the acquisition, before the build reads anything.
        await f.Database.ExecuteOwnerAsync($"UPDATE tenants SET profile = 'operator', pinned_role = 'master-host' WHERE name = '{Tenant}'");
        f.For(Tenant).FactoryGate.SetResult();
        var generation = await activation.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(TenantProfile.Hosted, generation.Grant.Profile);
        Assert.Equal(TenantProfile.Hosted, f.RuntimeOf(Tenant).Context.Grant.Profile);
    }

    [Fact]
    public async Task AGeneralReplicaRefusesAnOperatorTenantWithoutTouchingItsLease()
    {
        await using var f = await CreateAsync(Bound);
        await f.Database.ExecuteOwnerAsync($"UPDATE tenants SET profile = 'operator', pinned_role = 'master-host' WHERE name = '{Tenant}'");
        var epoch = await f.EpochAsync();
        await Assert.ThrowsAsync<TenantNotEligibleException>(() => f.Activations.ActivateAsync(Tenant));
        Assert.Equal(epoch, await f.EpochAsync());
        Assert.Equal(0, f.Builds);
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
