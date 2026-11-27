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
        await using var renewer = new GrantRenewer(control, control, Replica, LeaseTimings.Default);
        var lost = new List<string>();
        var handles = grants.Select(renewer.Track).ToArray();
        foreach (var tracked in handles)
            tracked.OnLoss(handle =>
            {
                lock (lost)
                    lost.Add(handle.Grant.Tenant);
            });
        var before = handles[0].Deadline;
        await renewer.RenewOnceAsync();
        Assert.True(handles[0].IsCurrent(Stopwatch.GetTimestamp()));
        Assert.True(handles[0].Deadline > before);
        Assert.All(handles[1..], handle => Assert.True(handle.Lost.IsCompleted));
        await WaitUntilAsync(() => { lock (lost) return lost.Count == 4; }, TimeSpan.FromSeconds(5), "four losses reported");
        Assert.Equal(1, renewer.Count);
    }

    // Runs the batch renewal statement inside a transaction the test opened earlier: the
    // interleavings a delayed send or a lock wait produce.
    private static async Task<(bool Renewed, bool Matched)> RenewInOpenTransactionAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        LeaseGrant grant,
        TimeSpan ttl
    )
    {
        await using var renew = new NpgsqlCommand(TenantLease.RenewBatchSql(skipLocked: true), connection, transaction);
        renew.Parameters.Add(new NpgsqlParameter<int[]> { TypedValue = [grant.TenantId] });
        renew.Parameters.Add(new NpgsqlParameter<long[]> { TypedValue = [grant.Epoch] });
        renew.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Replica });
        renew.Parameters.Add(new NpgsqlParameter<double> { TypedValue = ttl.TotalSeconds });
        await using var reader = await renew.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        return (reader.GetBoolean(0), reader.GetBoolean(1));
    }

    private static async Task<(NpgsqlConnection, NpgsqlTransaction)> BeginAsync(HostedTestDatabase database)
    {
        var connection = new NpgsqlConnection(database.AppConnectionString);
        await connection.OpenAsync();
        var transaction = await connection.BeginTransactionAsync();
        // The transaction's start time (now()) is fixed from its first statement.
        await using (var first = new NpgsqlCommand("SELECT now()", connection, transaction))
            await first.ExecuteScalarAsync();
        return (connection, transaction);
    }

    [Fact]
    public async Task ARenewalThatRunsAfterTheRowExpiredInsideItsTransactionDoesntReviveIt()
    {
        var (database, tenants) = await PrepareAsync(0);
        await using var _ = database;
        var control = database.OpenApp();
        var grant = await AcquireAsync(control, tenants[0], LeaseTimings.Default);
        await database.ScalarAsync("UPDATE tenant_leases SET expires_at = clock_timestamp() + interval '700 milliseconds' WHERE tenant_id = $1", grant.TenantId);
        var (connection, transaction) = await BeginAsync(database);
        await using (connection)
        await using (transaction)
        {
            // The row expires between the transaction's start and the renewal statement.
            await Task.Delay(1200);
            Assert.Equal(true, await database.ScalarAsync("SELECT expires_at < clock_timestamp() FROM tenant_leases WHERE tenant_id = $1", grant.TenantId));
            var (renewed, _) = await RenewInOpenTransactionAsync(connection, transaction, grant, LeaseTimings.Default.Ttl);
            await transaction.CommitAsync();
            Assert.False(renewed, "an expired row was renewed at its old epoch");
        }
        Assert.Equal(true, await database.ScalarAsync("SELECT expires_at < clock_timestamp() FROM tenant_leases WHERE tenant_id = $1", grant.TenantId));
    }

    [Fact]
    public async Task ARowThatExpiresWhileItsRenewalWaitsForTheLockIsntRenewed()
    {
        var (database, tenants) = await PrepareAsync(0);
        await using var _ = database;
        var control = database.OpenApp();
        var grant = await AcquireAsync(control, tenants[0], LeaseTimings.Default);
        await database.ScalarAsync("UPDATE tenant_leases SET expires_at = clock_timestamp() + interval '700 milliseconds' WHERE tenant_id = $1", grant.TenantId);
        var (holder, hold) = await LockRowsAsync(database, grant.TenantId);
        await using (holder)
        await using (hold)
        {
            // The retry lane's form: it waits for the lock, here past the row's expiry.
            var renewal = TenantLease.RenewBatchAsync(control, Replica, [(grant.TenantId, grant.Epoch)], LeaseTimings.Default.Ttl, TimeSpan.FromSeconds(10), skipLocked: false, CancellationToken.None);
            await Task.Delay(1200);
            Assert.False(renewal.IsCompleted);
            await hold.RollbackAsync();
            Assert.Equal([RenewalOutcome.Lost], await renewal.WaitAsync(TimeSpan.FromSeconds(5)));
        }
        Assert.Equal(true, await database.ScalarAsync("SELECT expires_at < clock_timestamp() FROM tenant_leases WHERE tenant_id = $1", grant.TenantId));
    }

    [Fact]
    public async Task AnOlderRenewalNeverMovesANewerExpiryBack()
    {
        var (database, tenants) = await PrepareAsync(0);
        await using var _ = database;
        var control = database.OpenApp();
        var grant = await AcquireAsync(control, tenants[0], LeaseTimings.Default);
        var (connection, transaction) = await BeginAsync(database);
        await using (connection)
        await using (transaction)
        {
            await Task.Delay(1500);
            // A newer renewal commits first.
            var outcomes = await TenantLease.RenewBatchAsync(control, Replica, [(grant.TenantId, grant.Epoch)], LeaseTimings.Default.Ttl, TimeSpan.FromSeconds(1), skipLocked: true, CancellationToken.None);
            Assert.Equal([RenewalOutcome.Renewed], outcomes);
            var newer = await ExpiresAsync(database, grant.TenantId);
            // Then the older transaction renews. Its statement runs later, so only a shorter
            // TTL (a replica with other timings during a rollout) could compute an earlier
            // expiry; the stored one never moves back.
            await RenewInOpenTransactionAsync(connection, transaction, grant, LeaseTimings.Default.Ttl / 3);
            await transaction.CommitAsync();
            var after = await ExpiresAsync(database, grant.TenantId);
            Assert.True(after >= newer, $"the expiry moved back by {(newer - after).TotalMilliseconds} ms");
        }
    }

    // Holds the lease rows of `tenantIds` FOR UPDATE until disposed.
    private static async Task<(NpgsqlConnection, NpgsqlTransaction)> LockRowsAsync(HostedTestDatabase database, params int[] tenantIds)
    {
        var holder = new NpgsqlConnection(database.SuperuserConnectionString);
        await holder.OpenAsync();
        var hold = await holder.BeginTransactionAsync();
        await using var locking = new NpgsqlCommand("SELECT 1 FROM tenant_leases WHERE tenant_id = ANY($1) FOR UPDATE", holder, hold);
        locking.Parameters.Add(new NpgsqlParameter<int[]> { TypedValue = tenantIds });
        await locking.ExecuteNonQueryAsync();
        return (holder, hold);
    }

    [Fact]
    public async Task ControlTrafficWaitingOnLocksCantDelayThePeriodicRenewal()
    {
        var (database, tenants) = await PrepareAsync(2);
        await using var _ = database;
        await using var control = PgDatabase.Control(database.AppConnectionString);
        await using var batches = PgDatabase.Renewal(database.AppConnectionString);
        var grants = new List<LeaseGrant>();
        foreach (var tenant in tenants)
            grants.Add(await AcquireAsync(control, tenant, LeaseTimings.Default));
        // Two releases wait behind conflicting locks and hold both control connections.
        var (holder, hold) = await LockRowsAsync(database, grants[1].TenantId, grants[2].TenantId);
        await using (holder)
        await using (hold)
        {
            var releases = grants.Skip(1)
                .Select(grant => new TenantLease(control, grant.Tenant, 2) { LockTimeout = TimeSpan.FromSeconds(20) }
                    .ReleaseAsync(grant, CancellationToken.None))
                .ToArray();
            await Task.Delay(300);
            Assert.All(releases, release => Assert.False(release.IsCompleted));
            // B's renewal still goes through at once on the batch's own connection.
            await using var renewer = new GrantRenewer(batches, control, Replica, LeaseTimings.Default);
            var handle = renewer.Track(grants[0]);
            var before = await ExpiresAsync(database, grants[0].TenantId);
            var renewing = Stopwatch.StartNew();
            await renewer.RenewOnceAsync().WaitAsync(TimeSpan.FromSeconds(3));
            Assert.True(renewing.Elapsed < TimeSpan.FromSeconds(2));
            Assert.True(await ExpiresAsync(database, grants[0].TenantId) > before);
            await hold.RollbackAsync();
            await Task.WhenAll(releases).WaitAsync(TimeSpan.FromSeconds(10));
        }
    }

    [Fact]
    public async Task AReleaseGivesUpAtItsLockTimeoutInsteadOfHoldingAControlConnection()
    {
        var (database, tenants) = await PrepareAsync(0);
        await using var _ = database;
        await using var control = PgDatabase.Control(database.AppConnectionString);
        var grant = await AcquireAsync(control, tenants[0], LeaseTimings.Default);
        var (holder, hold) = await LockRowsAsync(database, grant.TenantId);
        await using (holder)
        await using (hold)
        {
            var lease = new TenantLease(control, grant.Tenant, 2) { LockTimeout = TimeSpan.FromMilliseconds(300) };
            var started = Stopwatch.StartNew();
            Assert.False(await lease.ReleaseWithWakeupAsync(grant, null, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.True(started.Elapsed < TimeSpan.FromSeconds(2));
            var error = await Assert.ThrowsAsync<PostgresException>(() => lease.ReleaseAsync(grant, CancellationToken.None));
            Assert.Equal("55P03", error.SqlState);
        }
        Assert.Equal("active", await database.ScalarAsync("SELECT state FROM tenant_leases WHERE tenant_id = $1", grant.TenantId));
    }

    [Fact]
    public async Task ARetryQueuedForTheLaneIsDroppedWhenItsGrantIsLost()
    {
        var (database, tenants) = await PrepareAsync(1);
        await using var _ = database;
        await using var control = PgDatabase.Control(database.AppConnectionString);
        var a = await AcquireAsync(control, tenants[0], LeaseTimings.Default);
        var c = await AcquireAsync(control, tenants[1], LeaseTimings.Default);
        await using var renewer = new GrantRenewer(control, control, Replica, LeaseTimings.Default);
        var handleA = renewer.Track(a);
        var handleC = renewer.Track(c);
        // C's row is locked: its retry takes the lane and waits for the lock.
        var (holderC, holdC) = await LockRowsAsync(database, c.TenantId);
        await using (holderC)
        await using (holdC)
        {
            await renewer.RenewOnceAsync();
            await Task.Delay(200);
            // Then A's row: its retry queues for the lane behind C's.
            var (holderA, holdA) = await LockRowsAsync(database, a.TenantId);
            await using (holderA)
            await using (holdA)
            {
                await renewer.RenewOnceAsync();
                var aBefore = await ExpiresAsync(database, a.TenantId);
                // Lost while queued (a refused write, or the replica-wide decision).
                renewer.Lose(handleA, "refused");
                await holdA.RollbackAsync();
                await holdC.RollbackAsync();
                await WaitUntilAsync(() => handleC.Deadline > a.AcquisitionStart + (long)(LeaseTimings.Default.FenceAfter.TotalSeconds * Stopwatch.Frequency) + 1, TimeSpan.FromSeconds(10), "C renewed by its retry");
                await Task.Delay(500);
                Assert.Equal(aBefore, await ExpiresAsync(database, a.TenantId));
            }
        }
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
        await using var renewer = new GrantRenewer(control, control, Replica, Fast);
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
        await using var renewer = new GrantRenewer(control, control, Replica, Fast);
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
        await using var renewer = new GrantRenewer(control, control, Replica, Fast);
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
        await using var stamped = new GrantRenewer(control, control, Replica, Fast);
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
        await using var renewer = new GrantRenewer(control, control, Replica, LeaseTimings.Default);
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
    public async Task TheStatementCapCountsPhysicalTransactionsWithAPoolNoLargerThanTheCap()
    {
        var (database, tenants) = await PrepareAsync(0);
        await using var _ = database;
        // The shared pool is exactly the cap: any second connection a body opened would wait
        // for a connection its own transaction holds.
        var app = database.OpenApp(new NpgsqlConnectionStringBuilder(database.AppConnectionString) { MaxPoolSize = 2, Timeout = 3 }.ConnectionString);
        await using var control = PgDatabase.Control(database.AppConnectionString);
        await using var batches = PgDatabase.Renewal(database.AppConnectionString);
        var grant = await AcquireAsync(control, tenants[0], LeaseTimings.Default);
        var tenant = new TenantDb(app, grant.TenantId, grant.Epoch, maxInFlight: 2);

        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var peak = 0;
        var running = 0;
        var children = new List<Task<int>>();
        var readers = Enumerable.Range(0, 6).Select(index => tenant.ReadAsync<int>(async (tx, token) =>
        {
            InterlockedMax(ref peak, Interlocked.Increment(ref running));
            // A lookup another store makes from inside this body joins this transaction.
            Assert.Equal(1, tenant.ReadOrJoin(inner => Convert.ToInt32(inner.Scalar("SELECT 1"))));
            // A second transaction from inside a body is refused, not left to starve the pool.
            Assert.Throws<InvalidOperationException>(() => tenant.Read(inner => inner.Scalar("SELECT 1")));
            // Work the body starts and leaves running is outside it once the body ends.
            var ended = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (children)
                children.Add(Task.Run(async () =>
                {
                    await ended.Task;
                    return await tenant.ReadAsync<int>((inner, _) => Task.FromResult(1));
                }));
            await release.Task;
            Interlocked.Decrement(ref running);
            var ending = Task.Delay(50).ContinueWith(delay => ended.SetResult());
            return 0;
        })).ToArray();
        await WaitUntilAsync(() => Volatile.Read(ref running) == 2, TimeSpan.FromSeconds(5), "two transactions running");
        await Task.Delay(200);
        Assert.Equal(2, tenant.InFlight);
        Assert.Equal(2, Volatile.Read(ref running));

        // Renewal goes through its own source while the tenant holds the whole pool.
        await using var renewer = new GrantRenewer(batches, control, Replica, LeaseTimings.Default);
        var handle = renewer.Track(grant);
        var deadline = handle.Deadline;
        await renewer.RenewOnceAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(handle.Deadline > deadline);

        release.SetResult();
        await Task.WhenAll(readers).WaitAsync(TimeSpan.FromSeconds(20));
        Task<int>[] started;
        lock (children)
            started = [.. children];
        Assert.All(await Task.WhenAll(started).WaitAsync(TimeSpan.FromSeconds(20)), value => Assert.Equal(1, value));
        Assert.Equal(2, peak);
        Assert.Equal(0, tenant.InFlight);
    }

    [Fact]
    public async Task ALostCommitIsVerifiedAfterTheTransactionsSlotAndConnectionAreReturned()
    {
        var (database, tenants) = await PrepareAsync(0);
        await using var _ = database;
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        // One connection and one slot: verifying inside the failed transaction's slot, or on a
        // second connection while it holds the first, would wait until the pool timeout.
        var app = database.OpenApp(new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            MaxPoolSize = 1,
            CommandTimeout = 3,
            Timeout = 5,
        }.ConnectionString);
        await using var control = PgDatabase.Control(database.AppConnectionString);
        var grant = await AcquireAsync(control, tenants[0], LeaseTimings.Default);
        var tenant = new TenantDb(app, grant.TenantId, grant.Epoch, maxInFlight: 1);
        var competitorDone = false;
        var competitorDoneAtVerify = false;
        Task? competitor = null;
        var result = tenant.Write(
            tx =>
            {
                tx.Execute($"INSERT INTO {Table} (key, value) VALUES ('lost', 'commit')");
                // Waits for the only slot, which this transaction holds.
                // Another flow's transaction (not this body's), an async waiter: a released slot
                // is handed to it before any later caller.
                using (ExecutionContext.SuppressFlow())
                    competitor = Task.Run(async () =>
                    {
                        await tenant.ReadAsync<object?>((inner, token) => Task.FromResult(inner.Scalar("SELECT 1")));
                        Volatile.Write(ref competitorDone, true);
                    });
                Thread.Sleep(200);
                // COMMIT reaches the server, its reply doesn't.
                proxy.HoldExisting(toServer: false, toClient: true);
                return 7;
            },
            new PgWriteOptions(Verify: tx =>
            {
                competitorDoneAtVerify = Volatile.Read(ref competitorDone);
                return true;
            })
        );
        Assert.Equal(7, result);
        await competitor!;
        // The verification is a transaction of its own, queued for the slot after the waiting
        // one: the failed transaction gave its slot and connection back first.
        Assert.True(competitorDoneAtVerify);
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
