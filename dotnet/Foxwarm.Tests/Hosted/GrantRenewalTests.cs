using System.Diagnostics;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Npgsql;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// Per-grant renewal over the reserved control data source, and the tenant statement cap
// (plan §3.2 and §7.2), against real lease rows.
[Trait("Backend", "postgres")]
public sealed class GrantRenewalTests
{
    private const string Replica = "replica-a/0001";
    private const string Table = "renewal_probe";

    private static readonly LeaseTimings Fast = new(
        TimeSpan.FromSeconds(3),
        TimeSpan.FromMilliseconds(400),
        TimeSpan.FromSeconds(2)
    );

    // The default tenant plus `extra` more, each with its lease row.
    private static async Task<(HostedTestDatabase Database, string[] Tenants)> PrepareAsync(int extra)
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenants = new List<string> { PostgresServer.Tenant };
        for (var index = 0; index < extra; index++)
        {
            var name = "tenant-" + index;
            await database.ExecuteOwnerAsync(
                $"INSERT INTO tenants (name) VALUES ('{name}');"
                    + $" INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = '{name}'"
            );
            tenants.Add(name);
        }
        await database.CreateTenantTableAsync(Table);
        return (database, [.. tenants]);
    }

    private static async Task<LeaseGrant> AcquireAsync(PgDatabase control, string tenant, LeaseTimings timings) =>
        (await new TenantLease(control, tenant, 2).TryAcquireAsync(Replica, timings.Ttl, timings.RenewInterval, CancellationToken.None))!;

    private static async Task<DateTime> ExpiresAsync(HostedTestDatabase database, int tenantId) =>
        (DateTime)(await database.ScalarAsync("SELECT expires_at FROM tenant_leases WHERE tenant_id = $1", tenantId))!;

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan limit, string what)
    {
        var deadline = Stopwatch.StartNew();
        while (!condition())
        {
            Assert.True(deadline.Elapsed < limit, what);
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task ARenewalNeverRevivesAnExpiredReleasedForeignOrInactiveRow()
    {
        var (database, tenants) = await PrepareAsync(4);
        await using var _ = database;
        var control = database.OpenApp();
        var grants = new List<LeaseGrant>();
        foreach (var tenant in tenants)
            grants.Add(await AcquireAsync(control, tenant, LeaseTimings.Default));
        var (live, expired, released, foreign, suspended) = (grants[0], grants[1], grants[2], grants[3], grants[4]);
        await database.ScalarAsync("UPDATE tenant_leases SET expires_at = now() - interval '1 second' WHERE tenant_id = $1", expired.TenantId);
        await database.ScalarAsync("UPDATE tenant_leases SET state = 'released' WHERE tenant_id = $1", released.TenantId);
        var taken = await database.TakeLeaseAsync(foreign.TenantId, "replica-b/0002");
        await database.ScalarAsync("UPDATE tenants SET state = 'suspended' WHERE tenant_id = $1", suspended.TenantId);
        var expiredAt = await ExpiresAsync(database, expired.TenantId);
        var liveBefore = await ExpiresAsync(database, live.TenantId);

        var outcomes = await TenantLease.RenewBatchAsync(
            control,
            Replica,
            [.. grants.Select(grant => (grant.TenantId, grant.Epoch))],
            LeaseTimings.Default.Ttl,
            TimeSpan.FromSeconds(1),
            skipLocked: true,
            CancellationToken.None
        );
        Assert.Equal(
            [RenewalOutcome.Renewed, RenewalOutcome.Lost, RenewalOutcome.Lost, RenewalOutcome.Lost, RenewalOutcome.Lost],
            outcomes
        );
        Assert.True(await ExpiresAsync(database, live.TenantId) > liveBefore);
        Assert.Equal(expiredAt, await ExpiresAsync(database, expired.TenantId));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases WHERE tenant_id = $1", released.TenantId));
        Assert.Equal("replica-b/0002", await database.ScalarAsync("SELECT owner_replica FROM tenant_leases WHERE tenant_id = $1", foreign.TenantId));
        Assert.Equal(taken, await database.ScalarAsync("SELECT epoch FROM tenant_leases WHERE tenant_id = $1", foreign.TenantId));

        // Through the renewer: the outcomes reach exactly the handles of the batch.
        await using var renewer = new GrantRenewer(control, Replica, LeaseTimings.Default);
        var lost = new List<string>();
        renewer.GrantLost += (handle, reason) =>
        {
            lock (lost)
                lost.Add(handle.Grant.Tenant);
        };
        var handles = grants.Select(renewer.Track).ToArray();
        var before = handles[0].Deadline;
        await renewer.RenewOnceAsync();
        Assert.True(handles[0].IsCurrent(Stopwatch.GetTimestamp()));
        Assert.True(handles[0].Deadline > before);
        Assert.All(handles[1..], handle => Assert.True(handle.Lost.IsCompleted));
        await WaitUntilAsync(() => { lock (lost) return lost.Count == 4; }, TimeSpan.FromSeconds(5), "four losses reported");
        Assert.Equal(1, renewer.Count);
    }

    [Fact]
    public async Task ALockedRowIsUnprovedAndFencedAtItsDeadlineWhileAnotherTenantKeepsCommitting()
    {
        var (database, tenants) = await PrepareAsync(1);
        await using var _ = database;
        var control = PgDatabase.Control(database.AppConnectionString);
        await using var controlOwned = control;
        var a = await AcquireAsync(control, tenants[0], Fast);
        var b = await AcquireAsync(control, tenants[1], Fast);
        await using var renewer = new GrantRenewer(control, Replica, Fast);
        var handleA = renewer.Track(a);
        var handleB = renewer.Track(b);
        renewer.Start();
        await Task.Delay(Fast.RenewInterval * 2);
        var aExpires = await ExpiresAsync(database, a.TenantId);

        // A takeover-style lock on A's row, held past A's deadline.
        await using var holder = new NpgsqlConnection(database.SuperuserConnectionString);
        await holder.OpenAsync();
        await using var hold = await holder.BeginTransactionAsync();
        await using (var locking = new NpgsqlCommand("SELECT 1 FROM tenant_leases WHERE tenant_id = $1 FOR UPDATE", holder, hold))
        {
            locking.Parameters.Add(new NpgsqlParameter<int> { TypedValue = a.TenantId });
            await locking.ExecuteScalarAsync();
        }
        var locked = Stopwatch.StartNew();

        // B keeps making fenced commits all along.
        var app = database.OpenApp();
        var tenantB = new TenantDb(app, b.TenantId, b.Epoch);
        var commits = 0;
        using var stopWriting = new CancellationTokenSource();
        var writer = Task.Run(async () =>
        {
            while (!stopWriting.IsCancellationRequested)
            {
                await tenantB.WriteAsync(
                    (tx, token) => tx.ExecuteAsync($"INSERT INTO {Table} (key, value) VALUES ($1, 'b')", token, Guid.NewGuid().ToString()),
                    token: CancellationToken.None
                );
                Interlocked.Increment(ref commits);
                await Task.Delay(50);
            }
        });

        var reason = await handleA.Lost.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("fence deadline", reason);
        Assert.InRange(locked.Elapsed, Fast.FenceAfter - Fast.RenewInterval * 3, Fast.FenceAfter + TimeSpan.FromSeconds(1));
        // B renews past A's deadline and its own original one.
        await Task.Delay(Fast.FenceAfter);
        Assert.True(handleB.IsCurrent(Stopwatch.GetTimestamp()));
        stopWriting.Cancel();
        await writer;
        Assert.True(commits > 20, $"B committed {commits} times");

        await hold.RollbackAsync();
        // A's row was never extended while locked, and a lost grant isn't renewed afterwards.
        await Task.Delay(Fast.RenewInterval * 3);
        Assert.Equal(aExpires, await ExpiresAsync(database, a.TenantId));
        Assert.Equal(1, renewer.Count);
    }

    [Fact]
    public async Task ADatabaseWidePartitionFencesEveryGrantAndALateCommitRevivesNone()
    {
        var (database, tenants) = await PrepareAsync(1);
        await using var _ = database;
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Timeout = 2,
            CommandTimeout = 2,
            CancellationTimeout = 500,
        }.ConnectionString;
        await using var control = PgDatabase.Control(routed);
        var grants = new[] { await AcquireAsync(control, tenants[0], Fast), await AcquireAsync(control, tenants[1], Fast) };
        await using var renewer = new GrantRenewer(control, Replica, Fast);
        var handles = grants.Select(renewer.Track).ToArray();
        renewer.Start();
        await Task.Delay(Fast.RenewInterval * 3);
        Assert.All(handles, handle => Assert.True(handle.IsCurrent(Stopwatch.GetTimestamp())));

        var partitioned = Stopwatch.StartNew();
        proxy.Partition();
        await Task.WhenAll(handles.Select(handle => handle.Lost)).WaitAsync(TimeSpan.FromSeconds(10));
        // Fenced from the last proof, so within the fence deadline of the partition and before the TTL.
        Assert.InRange(partitioned.Elapsed, Fast.FenceAfter - Fast.RenewInterval * 2, Fast.Ttl - TimeSpan.FromMilliseconds(300));

        proxy.Heal();
        await Task.Delay(Fast.RenewInterval * 3);
        Assert.All(handles, handle => Assert.False(handle.IsCurrent(Stopwatch.GetTimestamp())));
        Assert.Equal(0, renewer.Count);
    }

    [Fact]
    public async Task AGrantKeepsItsAcquisitionStampAndNoGrantsMeansNoCountdown()
    {
        var (database, tenants) = await PrepareAsync(0);
        await using var _ = database;
        var control = database.OpenApp();
        await using var renewer = new GrantRenewer(control, Replica, Fast);
        renewer.Start();
        // Nothing held: nothing to fence however long it runs.
        await Task.Delay(Fast.FenceAfter + Fast.RenewInterval);
        Assert.Equal(0, renewer.Count);

        // A grant whose acquisition began long ago keeps that stamp until a renewal proves it:
        // tracking it doesn't restart its clock. Here the stamp leaves 150 ms, and a held row
        // lock keeps every renewal from proving anything.
        var acquired = await AcquireAsync(control, tenants[0], Fast);
        var old = acquired with
        {
            AcquisitionStart = Stopwatch.GetTimestamp() - (long)((Fast.FenceAfter - TimeSpan.FromMilliseconds(150)).TotalSeconds * Stopwatch.Frequency),
        };
        await using var holder = new NpgsqlConnection(database.SuperuserConnectionString);
        await holder.OpenAsync();
        await using var hold = await holder.BeginTransactionAsync();
        await using (var locking = new NpgsqlCommand("SELECT 1 FROM tenant_leases WHERE tenant_id = $1 FOR UPDATE", holder, hold))
        {
            locking.Parameters.Add(new NpgsqlParameter<int> { TypedValue = acquired.TenantId });
            await locking.ExecuteScalarAsync();
        }
        await using var stamped = new GrantRenewer(control, Replica, Fast);
        var tracked = Stopwatch.StartNew();
        var handle = stamped.Track(old);
        stamped.Start();
        var lost = await handle.Lost.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains("fence deadline", lost);
        Assert.True(tracked.Elapsed < Fast.FenceAfter / 2, $"fenced {tracked.ElapsedMilliseconds} ms after tracking");
        await hold.RollbackAsync();
    }

    [Fact]
    public async Task LosingEveryGrantAtOnceExtendsNothing()
    {
        var (database, tenants) = await PrepareAsync(1);
        await using var _ = database;
        var control = database.OpenApp();
        await using var renewer = new GrantRenewer(control, Replica, LeaseTimings.Default);
        var handles = new[]
        {
            renewer.Track(await AcquireAsync(control, tenants[0], LeaseTimings.Default)),
            renewer.Track(await AcquireAsync(control, tenants[1], LeaseTimings.Default)),
        };
        renewer.LoseAll("database unreachable");
        Assert.All(handles, handle => Assert.Equal("database unreachable", handle.Lost.Result));
        await renewer.RenewOnceAsync();
        Assert.All(handles, handle => Assert.False(handle.IsCurrent(Stopwatch.GetTimestamp())));
    }

    [Fact]
    public async Task TheStatementCapBoundsATenantsTransactionsAndLeavesTheControlSourceFree()
    {
        var (database, tenants) = await PrepareAsync(0);
        await using var _ = database;
        // A shared pool the capped tenant could otherwise fill.
        var app = database.OpenApp(new NpgsqlConnectionStringBuilder(database.AppConnectionString) { MaxPoolSize = 3, Timeout = 2 }.ConnectionString);
        await using var control = PgDatabase.Control(database.AppConnectionString);
        var grant = await AcquireAsync(control, tenants[0], LeaseTimings.Default);
        var tenant = new TenantDb(app, grant.TenantId, grant.Epoch, maxInFlight: 2);

        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var peak = 0;
        var running = 0;
        var readers = Enumerable.Range(0, 6).Select(index => tenant.ReadAsync<int>(async (tx, token) =>
        {
            var now = Interlocked.Increment(ref running);
            InterlockedMax(ref peak, now);
            // A nested call from inside a transaction takes no second slot, so it can't deadlock.
            tenant.Read<object?>(inner => inner.Scalar("SELECT 1"));
            await release.Task;
            Interlocked.Decrement(ref running);
            return 0;
        })).ToArray();
        await WaitUntilAsync(() => Volatile.Read(ref running) == 2, TimeSpan.FromSeconds(5), "two transactions running");
        await Task.Delay(200);
        Assert.Equal(2, tenant.InFlight);
        Assert.Equal(2, Volatile.Read(ref running));

        // Renewal goes through the control source while the tenant holds its slots.
        await using var renewer = new GrantRenewer(control, Replica, LeaseTimings.Default);
        var handle = renewer.Track(grant);
        var deadline = handle.Deadline;
        await renewer.RenewOnceAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(handle.Deadline > deadline);

        release.SetResult();
        await Task.WhenAll(readers);
        Assert.Equal(2, peak);
        Assert.Equal(0, tenant.InFlight);
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int current;
        do
        {
            current = Volatile.Read(ref target);
            if (value <= current)
                return;
        } while (Interlocked.CompareExchange(ref target, value, current) != current);
    }
}
