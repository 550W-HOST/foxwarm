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

    private static async Task<HostedTestDatabase> PrepareAsync(bool register = true)
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        if (register) await database.RegisterBootsAsync("a","b","c","owner","standby");
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
        await using var database = await PrepareAsync(register:false);
        var app = database.OpenApp();
        var registry = new ReplicaRegistry(app);
        var a = ReplicaRegistry.NewReplicaId("pod-a");
        var b = ReplicaRegistry.NewReplicaId("pod-a");
        Assert.StartsWith("pod-a/", a);
        Assert.NotEqual(a, b);
        await registry.RegisterAsync(a, "10.0.0.1:3001", Foxwarm.Hosted.Schema.SchemaMigrator.BinaryLevel, 2, CancellationToken.None);
        await registry.RegisterAsync(b, null, Foxwarm.Hosted.Schema.SchemaMigrator.BinaryLevel, 2, CancellationToken.None);
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

    // ---- Placement proof, import lock order, 0004 binding (review 4c) ----

    private static async Task<long> LockWaitersAsync(HostedTestDatabase database) =>
        (long)(await database.ScalarAsync(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
        ))!;

    private static async Task UntilLockWaitersAsync(HostedTestDatabase database, long count)
    {
        var watch = Stopwatch.StartNew();
        while (await LockWaitersAsync(database) < count)
        {
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), $"fewer than {count} lock waiters");
            await Task.Delay(20);
        }
    }

    private static async Task<(Npgsql.NpgsqlConnection Connection, Npgsql.NpgsqlTransaction Transaction)> HoldLeaseRowAsync(
        HostedTestDatabase database,
        int tenant
    )
    {
        var connection = new Npgsql.NpgsqlConnection(database.OwnerConnectionString);
        await connection.OpenAsync();
        var transaction = await connection.BeginTransactionAsync();
        await using var command = new Npgsql.NpgsqlCommand($"SELECT 1 FROM tenant_leases WHERE tenant_id = {tenant} FOR UPDATE", connection, transaction);
        await command.ExecuteScalarAsync();
        return (connection, transaction);
    }

    private static async Task OperatorAsync(HostedTestDatabase database, string sql)
    {
        await using var connection = new Npgsql.NpgsqlConnection(database.OperatorConnectionString);
        await connection.OpenAsync();
        await using var command = new Npgsql.NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    [Fact]
    public async Task RenewalProvesTheGrantsPlacementAndAnImportRenewsOnTheLeaseAlone()
    {
        await using var database = await PrepareAsync();
        await using var control = database.OpenApp();
        var lease = Lease(control);
        var grant = (await TryAcquire(lease, "a", Slow))!;
        Assert.Equal(ReplicaRoles.General, grant.Role);
        async Task<(bool Single, RenewalOutcome Batch)> RenewAsync(LeaseGrant renewed) =>
            (
                await lease.RenewAsync(renewed, Slow.Ttl, CancellationToken.None),
                (await TenantLease.RenewBatchAsync(control, renewed.Replica, [renewed], Slow.Ttl, TimeSpan.FromSeconds(5), false, CancellationToken.None))[0]
            );
        Assert.Equal((true, RenewalOutcome.Renewed), await RenewAsync(grant));
        // A pin the role doesn't allow, then a changed profile: neither renews, both report loss.
        await database.ExecuteOwnerAsync("UPDATE tenants SET pinned_role = 'master-host'");
        Assert.Equal((false, RenewalOutcome.Lost), await RenewAsync(grant));
        await database.ExecuteOwnerAsync("UPDATE tenants SET pinned_role = NULL");
        Assert.Equal((true, RenewalOutcome.Renewed), await RenewAsync(grant));
        await database.ExecuteOwnerAsync("UPDATE tenants SET profile = 'operator'");
        Assert.Equal((false, RenewalOutcome.Lost), await RenewAsync(grant));

        // An import serves nothing: its grant has no role and renews on the lease alone.
        await lease.ReleaseAsync(grant, CancellationToken.None);
        await database.ExecuteOwnerAsync("UPDATE tenants SET profile = 'hosted'");
        var importing = new TenantLease(database.OpenOwner(), PostgresServer.Tenant, 2);
        var import = (await importing.TryAcquireForImportAsync("import:1", grant.Epoch, Slow.Ttl, TimeSpan.FromSeconds(5), CancellationToken.None))!;
        Assert.Null(import.Role);
        Assert.True(await importing.RenewAsync(import, Slow.Ttl, CancellationToken.None));
    }

    // An import's finalization and an operator's placement edit take the tenant row, then the
    // lease row; with the lease row held elsewhere, both wait and both then commit.
    [Fact]
    public async Task ImportFinalizationOverlappingAPlacementEditCommitsBoth()
    {
        await using var database = await PrepareAsync();
        await using var owner = database.OpenOwner();
        var lease = new TenantLease(owner, PostgresServer.Tenant, 2);
        var import = (await lease.TryAcquireForImportAsync("import:1", 0, Slow.Ttl, TimeSpan.FromSeconds(5), CancellationToken.None))!;
        var (holder, holding) = await HoldLeaseRowAsync(database, import.TenantId);
        await using (holder)
        {
            var finalize = lease.ActivateImportAsync(import, CancellationToken.None);
            await UntilLockWaitersAsync(database, 1);
            var edit = OperatorAsync(database, $"UPDATE tenants SET profile = 'operator' WHERE tenant_id = {import.TenantId}");
            await UntilLockWaitersAsync(database, 2);
            await holding.CommitAsync();
            await finalize.WaitAsync(TimeSpan.FromSeconds(30));
            await edit.WaitAsync(TimeSpan.FromSeconds(30));
        }
        Assert.Equal("active", await database.ScalarAsync("SELECT state FROM tenants"));
        Assert.Equal("operator", await database.ScalarAsync("SELECT profile FROM tenants"));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
    }

    // 0004's lock runs with the editor's rights on the installation's lease table: a temporary
    // table of the same name in the editor's session doesn't stand in for it.
    [Fact]
    public async Task ThePlacementLockTakesTheInstallationsLeaseRowWithTheEditorsRights()
    {
        await using var database = await PrepareAsync();
        Assert.Equal(false, await database.ScalarAsync("SELECT prosecdef FROM pg_proc WHERE proname = 'foxwarm_lock_lease_for_placement'"));
        var tenant = await database.TenantIdAsync();
        var (holder, holding) = await HoldLeaseRowAsync(database, tenant);
        await using (holder)
        {
            await using var editor = new Npgsql.NpgsqlConnection(database.OperatorConnectionString);
            await editor.OpenAsync();
            await using (var shadow = new Npgsql.NpgsqlCommand(
                $"CREATE TEMP TABLE tenant_leases (tenant_id integer); INSERT INTO tenant_leases VALUES ({tenant})",
                editor
            ))
                await shadow.ExecuteNonQueryAsync();
            await using var update = new Npgsql.NpgsqlCommand($"UPDATE tenants SET profile = 'operator' WHERE tenant_id = {tenant}", editor);
            var edit = update.ExecuteNonQueryAsync();
            await Task.Delay(500);
            Assert.False(edit.IsCompleted, "the edit didn't wait for the held lease row");
            Assert.Equal(1L, await LockWaitersAsync(database));
            await holding.CommitAsync();
            Assert.Equal(1, await edit.WaitAsync(TimeSpan.FromSeconds(30)));
        }
    }

    // A role mismatch seen without the lock is provisional: an edit toward eligibility still in
    // flight is waited for and its result decides. Under the lock a mismatch is a refusal;
    // while another replica holds the lease it's only a retry.
    [Fact]
    public async Task ARoleMismatchSeenBeforeTheLockWaitsForAnEditInFlight()
    {
        await using var database = await PrepareAsync();
        await database.ExecuteOwnerAsync("UPDATE tenants SET profile = 'operator'");
        var lease = Lease(database.OpenApp());
        await Assert.ThrowsAsync<TenantNotEligibleException>(() => TryAcquire(lease, "a", Slow));

        await using (var editor = new Npgsql.NpgsqlConnection(database.OperatorConnectionString))
        {
            await editor.OpenAsync();
            await using var editing = await editor.BeginTransactionAsync();
            await using (var edit = new Npgsql.NpgsqlCommand("UPDATE tenants SET profile = 'hosted'", editor, editing))
                await edit.ExecuteNonQueryAsync();
            var acquisition = TryAcquire(lease, "a", Slow);
            await UntilLockWaitersAsync(database, 1);
            await editing.CommitAsync();
            var grant = await acquisition.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotNull(grant);
            Assert.Equal(TenantProfile.Hosted, grant.Profile);
        }

        // Held by another replica while the stored placement excludes this role: a retry.
        await database.ExecuteOwnerAsync("UPDATE tenants SET profile = 'operator'");
        Assert.Null(await TryAcquire(new TenantLease(database.OpenApp(), PostgresServer.Tenant, 2), "b", Slow));
    }
}
