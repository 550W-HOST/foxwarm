using Foxwarm.Hosted.Postgres;
using Npgsql;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class TenantDbTests
{
    private const string Table = "fence_probe";

    private static async Task<(HostedTestDatabase Database, int Tenant)> PrepareAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        await database.CreateTenantTableAsync(Table);
        return (database, await database.TenantIdAsync());
    }

    private static int Insert(PgTx tx, string key, string? value = null) =>
        tx.Execute($"INSERT INTO {Table} (key, value) VALUES ($1, $2)", key, value);

    private static long Count(TenantDb tenant, string? key = null) =>
        tenant.Read(tx =>
            (long)tx.Scalar(
                $"SELECT count(*) FROM {Table} WHERE $1::text IS NULL OR key = $1",
                key
            )!
        );

    [Fact]
    public async Task WritesNeedTheCurrentLeaseEpoch()
    {
        var (database, tenantId) = await PrepareAsync();
        await using var _ = database;
        var app = database.OpenApp();
        var fenced = new List<TenantFencedException>();

        // A released lease fences every epoch, including the default one.
        var unleased = new TenantDb(app, tenantId, 0);
        unleased.Fenced += fenced.Add;
        Assert.Throws<TenantFencedException>(() => unleased.Write(tx => Insert(tx, "a")));
        Assert.Single(fenced);

        var epoch = await database.TakeLeaseAsync(tenantId);
        var owner = new TenantDb(app, tenantId, epoch);
        Assert.Equal(1, owner.Write(tx => Insert(tx, "a", "first")));
        Assert.Equal(1L, Count(owner, "a"));

        // Takeover: the old epoch can no longer write, and nothing of its attempt remains.
        var next = await database.TakeLeaseAsync(tenantId, "other");
        owner.Fenced += fenced.Add;
        Assert.Throws<TenantFencedException>(() => owner.Write(tx => Insert(tx, "b")));
        Assert.Equal(2, fenced.Count);
        Assert.Equal(0L, Count(owner, "b"));
        Assert.Equal(1, new TenantDb(app, tenantId, next).Write(tx => Insert(tx, "b")));

        // Reads need no lease.
        Assert.Equal(2L, Count(unleased));
    }

    [Fact]
    public async Task AnExpiredLeaseFencesWithoutATakeover()
    {
        var (database, tenantId) = await PrepareAsync();
        await using var _ = database;
        var epoch = await database.TakeLeaseAsync(tenantId, ttl: TimeSpan.FromMilliseconds(300));
        var owner = new TenantDb(database.OpenApp(), tenantId, epoch);
        await Task.Delay(600);
        Assert.Throws<TenantFencedException>(() => owner.Write(tx => Insert(tx, "late")));
    }

    [Fact]
    public async Task TheTriggerFencesWritesThatBypassTheHelper()
    {
        var (database, tenantId) = await PrepareAsync();
        await using var _ = database;
        var epoch = await database.TakeLeaseAsync(tenantId);
        await using var connection = new NpgsqlConnection(database.AppConnectionString);
        await connection.OpenAsync();
        async Task<PostgresException> Attempt(string setup)
        {
            await using var transaction = await connection.BeginTransactionAsync();
            await using (var configure = new NpgsqlCommand(setup, connection, transaction))
                await configure.ExecuteNonQueryAsync();
            await using var insert = new NpgsqlCommand(
                $"INSERT INTO {Table} (tenant_id, key) VALUES ({tenantId}, 'raw')",
                connection,
                transaction
            );
            return await Assert.ThrowsAsync<PostgresException>(() => insert.ExecuteNonQueryAsync());
        }
        // No epoch at all, and an older epoch with the right tenant.
        Assert.Equal(TenantDb.FenceSqlState, (await Attempt("SELECT set_config('foxwarm.tenant', '" + tenantId + "', true)")).SqlState);
        Assert.Equal(
            TenantDb.FenceSqlState,
            (await Attempt($"SELECT set_config('foxwarm.tenant', '{tenantId}', true), set_config('foxwarm.epoch', '{epoch - 1}', true)")).SqlState
        );
        Assert.Equal(0L, await database.ScalarAsync($"SELECT count(*) FROM {Table}"));
    }

    [Fact]
    public async Task RowLevelSecuritySeparatesTenants()
    {
        var (database, alpha) = await PrepareAsync();
        await using var _ = database;
        await database.ExecuteOwnerAsync(
            "INSERT INTO tenants (name) VALUES ('beta');"
                + " INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = 'beta'"
        );
        var beta = await database.TenantIdAsync("beta");
        var app = database.OpenApp();
        var alphaDb = new TenantDb(app, alpha, await database.TakeLeaseAsync(alpha));
        var betaDb = new TenantDb(app, beta, await database.TakeLeaseAsync(beta));
        alphaDb.Write(tx => Insert(tx, "shared-key", "alpha"));
        betaDb.Write(tx => Insert(tx, "shared-key", "beta"));
        Assert.Equal("alpha", alphaDb.Read(tx => tx.Scalar($"SELECT value FROM {Table}")));
        Assert.Equal(1L, Count(betaDb));
        // Beta can neither change alpha's row nor write a row into alpha's tenant.
        Assert.Equal(0, betaDb.Write(tx => tx.Execute($"UPDATE {Table} SET value = 'x' WHERE tenant_id = $1", alpha)));
        var error = Assert.Throws<PostgresException>(() =>
            betaDb.Write(tx => tx.Execute($"INSERT INTO {Table} (tenant_id, key) VALUES ($1, 'k')", alpha))
        );
        Assert.Equal("42501", error.SqlState);
        Assert.Equal("alpha", alphaDb.Read(tx => tx.Scalar($"SELECT value FROM {Table}")));
    }

    [Fact]
    public async Task ATakeoverWaitsForInFlightWritersWhileRenewalDoesNot()
    {
        var (database, tenantId) = await PrepareAsync();
        await using var _ = database;
        var epoch = await database.TakeLeaseAsync(tenantId);
        var owner = new TenantDb(database.OpenApp(), tenantId, epoch);
        var inside = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var writer = owner.WriteAsync(
            async (tx, token) =>
            {
                await tx.ExecuteAsync($"INSERT INTO {Table} (key) VALUES ('old')", token);
                inside.SetResult();
                await release.Task;
                return 0;
            }
        );
        await inside.Task;

        // The owner's renewal is a non-key update and doesn't queue behind the writer.
        var renew = database.ScalarAsync(
            "UPDATE tenant_leases SET expires_at = now() + interval '1 hour'"
                + " WHERE tenant_id = $1 AND epoch = $2 RETURNING epoch",
            tenantId,
            epoch
        );
        Assert.Same(renew, await Task.WhenAny(renew, Task.Delay(TimeSpan.FromSeconds(10))));
        Assert.Equal(epoch, await renew);

        // A takeover locks the lease FOR UPDATE and waits for the writer of the old epoch.
        var takeover = database.TakeLeaseAsync(tenantId, "other");
        await WaitForLockWaitAsync(database);
        Assert.False(takeover.IsCompleted);
        release.SetResult();
        await writer;
        var next = await takeover;
        Assert.Equal(epoch + 1, next);
        Assert.Equal(1L, await database.ScalarAsync($"SELECT count(*) FROM {Table} WHERE key = 'old'"));
        await Assert.ThrowsAsync<TenantFencedException>(() =>
            owner.WriteAsync((tx, token) => tx.ExecuteAsync($"INSERT INTO {Table} (key) VALUES ('after')", token))
        );
    }

    [Fact]
    public async Task ALostCommitIsResolvedByVerification()
    {
        var (database, tenantId) = await PrepareAsync();
        await using var _ = database;
        var epoch = await database.TakeLeaseAsync(tenantId);
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Pooling = false,
            CommandTimeout = 3,
            Timeout = 5,
        }.ConnectionString;
        var owner = new TenantDb(database.OpenApp(routed), tenantId, epoch);
        bool Visible(PgTx tx, string key) =>
            (long)tx.Scalar($"SELECT count(*) FROM {Table} WHERE key = $1", key)! == 1;

        // COMMIT reaches the server, its reply doesn't: verification finds the row.
        var committed = owner.Write(
            tx =>
            {
                Insert(tx, "committed");
                proxy.HoldExisting(toServer: false, toClient: true);
                return "done";
            },
            new PgWriteOptions(Verify: tx => Visible(tx, "committed"))
        );
        Assert.Equal("done", committed);
        proxy.SeverAll();
        proxy.Heal();

        // COMMIT never reaches the server: verification finds nothing, the original failure surfaces.
        var lost = Assert.ThrowsAny<Exception>(() =>
            owner.Write(
                tx =>
                {
                    Insert(tx, "lost");
                    proxy.HoldExisting(toServer: true, toClient: false);
                    return 0;
                },
                new PgWriteOptions(Verify: tx => Visible(tx, "lost"))
            )
        );
        Assert.IsNotType<CommitOutcomeUnknownException>(lost);
        proxy.SeverAll();
        proxy.Heal();
        Assert.Equal(0L, await database.ScalarAsync($"SELECT count(*) FROM {Table} WHERE key = 'lost'"));

        // Without a verifier the outcome is reported as unknown.
        Assert.Throws<CommitOutcomeUnknownException>(() =>
            owner.Write(tx =>
            {
                Insert(tx, "unknown");
                proxy.HoldExisting(toServer: false, toClient: true);
                return 0;
            })
        );
        proxy.SeverAll();
        proxy.Heal();
    }

    [Fact]
    public async Task RetryableBodiesRunAgainAfterASerializationFailure()
    {
        var (database, tenantId) = await PrepareAsync();
        await using var _ = database;
        var owner = new TenantDb(database.OpenApp(), tenantId, await database.TakeLeaseAsync(tenantId));
        const string fail = "DO $$ BEGIN RAISE EXCEPTION 'conflict' USING ERRCODE = '40001'; END $$";
        var attempts = 0;
        var result = owner.Write(
            tx =>
            {
                attempts++;
                Insert(tx, "retried");
                if (attempts == 1)
                    tx.Execute(fail);
                return attempts;
            },
            new PgWriteOptions(Retryable: true)
        );
        Assert.Equal(2, result);
        Assert.Equal(1L, Count(owner, "retried"));
        var error = Assert.Throws<PostgresException>(() => owner.Write(tx => tx.Execute(fail)));
        Assert.Equal("40001", error.SqlState);
    }

    [Fact]
    public async Task ReadsAreReadOnlyAndAClosedRuntimeRefusesEverything()
    {
        var (database, tenantId) = await PrepareAsync();
        await using var _ = database;
        var owner = new TenantDb(database.OpenApp(), tenantId, await database.TakeLeaseAsync(tenantId), TimeSpan.FromSeconds(1));
        var readOnly = Assert.Throws<PostgresException>(() => owner.Read(tx => Insert(tx, "r")));
        Assert.Equal("25006", readOnly.SqlState);
        var timeout = Assert.Throws<PostgresException>(() => owner.Write(tx => tx.Scalar("SELECT pg_sleep(3)")));
        Assert.Equal("57014", timeout.SqlState);
        owner.Close();
        Assert.Throws<TenantFencedException>(() => owner.Write(tx => Insert(tx, "closed")));
        Assert.Throws<TenantFencedException>(() => Count(owner));
    }

    private static async Task WaitForLockWaitAsync(HostedTestDatabase database)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            if (
                (long)(await database.ScalarAsync(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
                        + " AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'"
                ))! > 0
            )
                return;
            await Task.Delay(50);
        }
        throw new TimeoutException("The takeover never waited for the lease lock.");
    }
}
