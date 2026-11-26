using System.Diagnostics;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Npgsql;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class TenantLeaseTests
{
    private const string Table = "lease_probe";
    private static readonly LeaseTimings Slow = new(
        TimeSpan.FromSeconds(60),
        TimeSpan.FromSeconds(20),
        TimeSpan.FromSeconds(40)
    );
    private static readonly LeaseTimings Fast = new(
        TimeSpan.FromSeconds(3),
        TimeSpan.FromMilliseconds(400),
        TimeSpan.FromSeconds(2)
    );

    private static async Task<HostedTestDatabase> PrepareAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        await database.CreateTenantTableAsync(Table);
        return database;
    }

    private static TenantLease Lease(PgDatabase database, int readerVersion = 2) =>
        new(database, PostgresServer.Tenant, readerVersion);

    private static Task<LeaseGrant?> TryAcquire(TenantLease lease, string replica, LeaseTimings timings) =>
        lease.TryAcquireAsync(replica, timings.Ttl, TimeSpan.FromSeconds(5), CancellationToken.None);

    [Fact]
    public async Task OneReplicaHoldsTheLeaseAndAReleaseWakesAStandby()
    {
        await using var database = await PrepareAsync();
        var lease = Lease(database.OpenApp());
        var first = await TryAcquire(lease, "a", Slow);
        Assert.NotNull(first);
        Assert.Equal(await database.TenantIdAsync(), first.TenantId);
        Assert.Null(await TryAcquire(lease, "b", Slow));

        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var standby = lease.AcquireAsync("b", Slow, null, cancel.Token);
        await Task.Delay(500);
        Assert.False(standby.IsCompleted);
        var released = Stopwatch.StartNew();
        await lease.ReleaseAsync(first, CancellationToken.None);
        var second = await standby;
        // Woken by the notification, well before the 20 s poll.
        Assert.InRange(released.Elapsed, TimeSpan.Zero, TimeSpan.FromSeconds(5));
        Assert.Equal("b", second.Replica);
        Assert.Equal(first.Epoch + 1, second.Epoch);
        // Releasing an old grant changes nothing.
        await lease.ReleaseAsync(first, CancellationToken.None);
        Assert.Null(await TryAcquire(lease, "c", Slow));
        Assert.False(await lease.RenewAsync(first, Slow.Ttl, CancellationToken.None));
        Assert.True(await lease.RenewAsync(second, Slow.Ttl, CancellationToken.None));
    }

    [Fact]
    public async Task TheRegistryResolvesTheCurrentOwnersAddressOnly()
    {
        await using var database = await PrepareAsync();
        var app = database.OpenApp();
        var registry = new ReplicaRegistry(app);
        var a = ReplicaRegistry.NewReplicaId("pod-a");
        var b = ReplicaRegistry.NewReplicaId("pod-a");
        Assert.StartsWith("pod-a/", a);
        Assert.NotEqual(a, b);
        await registry.RegisterAsync(a, "10.0.0.1:3001", 2, 2, CancellationToken.None);
        await registry.RegisterAsync(b, null, 2, 2, CancellationToken.None);
        await registry.HeartbeatAsync(a, CancellationToken.None);
        Assert.Null(await registry.OwnerAddressAsync(PostgresServer.Tenant, CancellationToken.None));
        var lease = Lease(app);
        var grant = (await TryAcquire(lease, a, Slow))!;
        Assert.Equal("10.0.0.1:3001", await registry.OwnerAddressAsync(PostgresServer.Tenant, CancellationToken.None));
        await lease.ReleaseAsync(grant, CancellationToken.None);
        Assert.Null(await registry.OwnerAddressAsync(PostgresServer.Tenant, CancellationToken.None));
        await registry.RemoveAsync(a, CancellationToken.None);
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM replicas"));
    }

    [Fact]
    public async Task AnExpiredLeaseCanBeTakenAndItsOwnerCanNoLongerRenew()
    {
        await using var database = await PrepareAsync();
        var lease = Lease(database.OpenApp());
        var owner = (await TryAcquire(lease, "a", Fast))!;
        Assert.Null(await TryAcquire(lease, "b", Fast));
        await Task.Delay(Fast.Ttl + TimeSpan.FromMilliseconds(300));
        var next = await TryAcquire(lease, "b", Fast);
        Assert.NotNull(next);
        Assert.False(await lease.RenewAsync(owner, Fast.Ttl, CancellationToken.None));
    }

    [Fact]
    public async Task AnOlderReaderCannotTakeATenantMarkedForANewerOne()
    {
        await using var database = await PrepareAsync();
        await database.ExecuteOwnerAsync("UPDATE tenants SET min_reader_version = 3");
        var error = await Assert.ThrowsAsync<LeaseRefusedException>(() =>
            TryAcquire(Lease(database.OpenApp(), readerVersion: 2), "a", Slow)
        );
        Assert.Contains("installation level 3", error.Message);
        Assert.NotNull(await TryAcquire(Lease(database.OpenApp(), readerVersion: 3), "a", Slow));
        await Assert.ThrowsAsync<LeaseRefusedException>(() =>
            new TenantLease(database.OpenApp(), "missing", 2).TenantIdAsync(CancellationToken.None)
        );
    }

    [Fact]
    public async Task TheMonitorKeepsTheLeaseAndFencesOnTakeover()
    {
        await using var database = await PrepareAsync();
        var app = database.OpenApp();
        var lease = Lease(app);
        var grant = (await TryAcquire(lease, "a", Fast))!;
        await using var monitor = new LeaseMonitor(lease, grant, Fast);
        var tenant = new TenantDb(app, grant.TenantId, grant.Epoch);
        monitor.Attach(tenant);
        monitor.Start();
        // Several TTLs pass; renewals keep the lease and writes keep working.
        await Task.Delay(Fast.Ttl * 2);
        Assert.False(monitor.Fenced.IsCompleted);
        tenant.Write(tx => tx.Execute($"INSERT INTO {Table} (key) VALUES ('kept')"));
        Assert.InRange(monitor.SinceRenewal, TimeSpan.Zero, Fast.FenceAfter);

        await database.TakeLeaseAsync(grant.TenantId, "other");
        var reason = await monitor.Fenced.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains("taken over", reason);
        Assert.True(monitor.Lost.IsCancellationRequested);
        Assert.Throws<TenantFencedException>(() => tenant.Write(tx => tx.Execute($"INSERT INTO {Table} (key) VALUES ('late')")));
    }

    [Fact]
    public async Task ARefusedWriteFencesTheRuntimeAtOnce()
    {
        await using var database = await PrepareAsync();
        var app = database.OpenApp();
        var lease = Lease(app);
        var grant = (await TryAcquire(lease, "a", Slow))!;
        await using var monitor = new LeaseMonitor(lease, grant, Slow);
        var tenant = new TenantDb(app, grant.TenantId, grant.Epoch);
        monitor.Attach(tenant);
        monitor.Start();
        await database.TakeLeaseAsync(grant.TenantId, "other");
        Assert.Throws<TenantFencedException>(() => tenant.Write(tx => tx.Execute($"INSERT INTO {Table} (key) VALUES ('x')")));
        Assert.Contains("refused", await monitor.Fenced.WaitAsync(TimeSpan.FromSeconds(1)));
        // Every later transaction is refused locally, reads included.
        Assert.Throws<TenantFencedException>(() => tenant.Read(tx => tx.Scalar("SELECT 1")));
    }

    [Fact]
    public async Task APartitionedOwnerFencesItselfBeforeAStandbyCanAcquire()
    {
        await using var database = await PrepareAsync();
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Timeout = 2,
            CommandTimeout = 2,
            CancellationTimeout = 500,
        }.ConnectionString;
        var ownerDatabase = database.OpenApp(routed);
        var ownerLease = Lease(ownerDatabase);
        var grant = (await TryAcquire(ownerLease, "owner", Fast))!;
        await using var monitor = new LeaseMonitor(ownerLease, grant, Fast);
        monitor.Start();
        await Task.Delay(Fast.RenewInterval * 2);

        var partitioned = Stopwatch.StartNew();
        proxy.Partition();
        var standbyLease = Lease(database.OpenApp());
        LeaseGrant? taken = null;
        var takenAt = TimeSpan.Zero;
        var deadline = Stopwatch.StartNew();
        while (taken is null && deadline.Elapsed < TimeSpan.FromSeconds(15))
        {
            taken = await TryAcquire(standbyLease, "standby", Fast);
            takenAt = partitioned.Elapsed;
            if (taken is null)
                await Task.Delay(100);
        }
        Assert.NotNull(taken);
        Assert.True(monitor.Fenced.IsCompleted, "The owner hadn't fenced itself when the standby acquired.");
        Assert.Contains("No lease renewal succeeded", await monitor.Fenced);
        // Self-fencing happens before the fence deadline ends; acquisition only after the TTL.
        Assert.InRange(takenAt, Fast.Ttl - Fast.RenewInterval - TimeSpan.FromMilliseconds(500), TimeSpan.FromSeconds(10));
        Assert.Equal(grant.Epoch + 1, taken.Epoch);
        proxy.Heal();
    }

    [Fact]
    public async Task TheFenceClockStartsBeforeTheAcquisitionWhenNoRenewalEverSucceeds()
    {
        await using var database = await PrepareAsync();
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Timeout = 2,
            CommandTimeout = 2,
            CancellationTimeout = 500,
        }.ConnectionString;
        var ownerLease = Lease(database.OpenApp(routed));
        var beforeAcquisition = Stopwatch.GetTimestamp();
        var grant = (await TryAcquire(ownerLease, "owner", Fast))!;
        Assert.InRange(grant.AcquisitionStart, beforeAcquisition, Stopwatch.GetTimestamp());
        // Cut off at once, and the monitor starts late (a slow handover): its first renewal
        // never completes, and the deadline counts from the acquisition, not from the monitor.
        proxy.Partition();
        await Task.Delay(TimeSpan.FromSeconds(1));
        await using var monitor = new LeaseMonitor(ownerLease, grant, Fast);
        Assert.Equal(grant.AcquisitionStart, monitor.RenewalStart);
        monitor.Start();
        Assert.Contains("No lease renewal succeeded", await monitor.Fenced.WaitAsync(TimeSpan.FromSeconds(10)));
        var atFence = Stopwatch.GetElapsedTime(grant.AcquisitionStart);
        Assert.InRange(atFence, Fast.FenceAfter, Fast.FenceAfter + TimeSpan.FromMilliseconds(500));
        Assert.True(atFence < Fast.Ttl, "the owner fenced only after its lease could expire");
        proxy.Heal();
    }

    [Fact]
    public async Task ATakeoverIsNotBlockedForeverByAPartitionedOwnersOpenTransaction()
    {
        await using var database = await PrepareAsync();
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Pooling = false,
            Timeout = 2,
        }.ConnectionString;
        var lease = Lease(database.OpenApp());
        var grant = (await TryAcquire(lease, "owner", Fast))!;
        var owner = new TenantDb(
            database.OpenApp(routed),
            grant.TenantId,
            grant.Epoch,
            statementTimeout: TimeSpan.FromSeconds(2),
            idleTimeout: TimeSpan.FromSeconds(1)
        );
        var inside = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var abandon = new CancellationTokenSource();
        var writer = owner.WriteAsync(
            async (tx, token) =>
            {
                await tx.ExecuteAsync($"INSERT INTO {Table} (key) VALUES ('orphan')", token);
                proxy.Partition();
                inside.SetResult();
                await Task.Delay(Timeout.Infinite, token);
                return 0;
            },
            token: abandon.Token
        );
        await inside.Task;
        // The owner's transaction holds the lease row FOR KEY SHARE and its connection is gone
        // from the owner's point of view. The server ends it after the idle timeout, so a
        // takeover after expiry gets the lock.
        await Task.Delay(Fast.Ttl);
        var acquired = Stopwatch.StartNew();
        var taken = await lease.TryAcquireAsync("standby", Fast.Ttl, TimeSpan.FromSeconds(10), CancellationToken.None);
        Assert.NotNull(taken);
        Assert.InRange(acquired.Elapsed, TimeSpan.Zero, TimeSpan.FromSeconds(5));
        Assert.Equal(0L, await database.ScalarAsync($"SELECT count(*) FROM {Table}"));
        proxy.SeverAll();
        abandon.Cancel();
        await Assert.ThrowsAnyAsync<Exception>(() => writer);
    }
}
