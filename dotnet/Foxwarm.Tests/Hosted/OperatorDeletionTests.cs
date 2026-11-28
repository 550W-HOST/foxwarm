using System.Diagnostics;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Operator;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;
using Npgsql;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class OperatorDeletionTests
{
    private sealed class Fixture(HostedTestDatabase db, TempDirectory scratch) : IAsyncDisposable
    {
        internal HostedTestDatabase Db => db;
        internal PgDatabase Operator { get; } =
            new(db.OperatorConnectionString, "deletion-operator");
        internal OperatorStore Store =>
            new(
                Operator,
                KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(scratch.Path, "kek")))
            );

        internal static async Task<Fixture> Create() =>
            new(await (await PostgresServer.SharedAsync()).CreateDatabaseAsync(), new());

        public async ValueTask DisposeAsync()
        {
            await Operator.DisposeAsync();
            await db.DisposeAsync();
            scratch.Dispose();
        }
    }

    private static async Task Until(Func<Task<bool>> check)
    {
        var clock = Stopwatch.StartNew();
        while (!await check())
        {
            Assert.True(clock.Elapsed < TimeSpan.FromSeconds(30));
            await Task.Delay(50);
        }
    }

    [Theory]
    [InlineData("importing")]
    [InlineData("importing-agents")]
    [InlineData("deleting")]
    public async Task A_profile_edit_cannot_change_the_Agent_store_of_an_offline_tenant(
        string state
    )
    {
        await using var f = await Fixture.Create();
        if (state == "deleting")
        {
            await f.Store.SuspendAsync(PostgresServer.Tenant, default);
            await f.Store.DeleteAsync(PostgresServer.Tenant, default);
        }
        else
        {
            await f
                .Db.OpenOwner()
                .ClusterAsync(
                    (tx, ct) =>
                        tx.ExecuteAsync(
                            "UPDATE tenants SET state=$1 WHERE name=$2",
                            ct,
                            state,
                            PostgresServer.Tenant
                        ),
                    default
                );
        }
        var patch = new System.Text.Json.Nodes.JsonObject { ["profile"] = "operator" };
        var conflict = await Assert.ThrowsAsync<OperatorProblem>(() =>
            f.Store.UpdateAsync(PostgresServer.Tenant, patch, default)
        );
        Assert.Equal(409, conflict.Status);
        Assert.Equal(
            "hosted",
            await f.Db.ScalarAsync(
                "SELECT profile FROM tenants WHERE name=$1",
                PostgresServer.Tenant
            )
        );
    }

    [Fact]
    public async Task Suspension_stops_serving_renewals_and_fences_an_owner_that_does_not_release()
    {
        await using var f = await Fixture.Create();
        var db = f.Db;
        await db.RegisterBootsAsync("serving");
        var lease = new TenantLease(db.OpenApp(), PostgresServer.Tenant, 2);
        var grant = Assert.IsType<LeaseGrant>(
            await lease.TryAcquireAsync(
                "serving",
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(1),
                default
            )
        );
        var suspend = f.Store.SuspendAsync(PostgresServer.Tenant, default);
        await Until(async () =>
            await db.ScalarAsync(
                "SELECT t.state='suspended' AND l.draining_since IS NOT NULL FROM tenants t JOIN tenant_leases l USING(tenant_id) WHERE t.tenant_id=$1",
                grant.TenantId
            )
                is true
        );
        Assert.False(await lease.RenewAsync(grant, TimeSpan.FromSeconds(30), default));
        await db.ExecuteOwnerAsync(
            "UPDATE tenant_leases SET draining_since=now()-interval '10 seconds'"
        );
        await suspend.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(
            grant.Epoch + 1,
            await db.ScalarAsync(
                "SELECT epoch FROM tenant_leases WHERE tenant_id=$1 AND state='released'",
                grant.TenantId
            )
        );
        await f.Store.ResumeAsync(PostgresServer.Tenant, default);
        var after = Assert.IsType<LeaseGrant>(
            await lease.TryAcquireAsync(
                "serving",
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(1),
                default
            )
        );
        Assert.True(after.Epoch > grant.Epoch);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task An_import_can_renew_but_cannot_be_suspended_or_deleted(bool agentsOnly)
    {
        await using var f = await Fixture.Create();
        var lease = new TenantLease(f.Db.OpenOwner(), PostgresServer.Tenant, 2);
        var grant = Assert.IsType<LeaseGrant>(
            await lease.TryAcquireForImportAsync(
                "import",
                0,
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(1),
                default,
                agentsOnly ? ImportKind.Agents : ImportKind.Full,
                agentsOnly ? "{}" : null
            )
        );
        Assert.True(await lease.RenewAsync(grant, TimeSpan.FromSeconds(30), default));
        Assert.Equal(
            409,
            (
                await Assert.ThrowsAsync<OperatorProblem>(() =>
                    f.Store.SuspendAsync(PostgresServer.Tenant, default)
                )
            ).Status
        );
        Assert.Equal(
            409,
            (
                await Assert.ThrowsAsync<OperatorProblem>(() =>
                    f.Store.DeleteAsync(PostgresServer.Tenant, default)
                )
            ).Status
        );
        Assert.True(await lease.RenewAsync(grant, TimeSpan.FromSeconds(30), default));
    }

    [Fact]
    public async Task Concurrent_resume_and_delete_have_one_winner()
    {
        await using var f = await Fixture.Create();
        await f.Store.SuspendAsync(PostgresServer.Tenant, default);
        async Task<bool> Applied(Func<Task> operation)
        {
            try
            {
                await operation();
                return true;
            }
            catch (OperatorProblem conflict) when (conflict.Status == 409)
            {
                return false;
            }
        }
        var results = await Task.WhenAll(
            Applied(() => f.Store.ResumeAsync(PostgresServer.Tenant, default)),
            Applied(() => f.Store.DeleteAsync(PostgresServer.Tenant, default))
        );
        Assert.NotEqual(results[0], results[1]);
        Assert.Equal(
            results[0] ? "active" : "deleting",
            await f.Db.ScalarAsync("SELECT state FROM tenants WHERE name='default'")
        );
    }

    [Fact]
    public async Task A_deleting_new_style_tenant_is_cleaned_in_fenced_chunks_after_restart()
    {
        await using var f = await Fixture.Create();
        var store = f.Store;
        await store.CreateAsync("dos", "hosted", "dos.test", default);
        var id = await f.Db.TenantIdAsync("dos");
        var epoch = await f.Db.TakeLeaseAsync(id);
        await new TenantDb(f.Db.OpenApp(), id, epoch).WriteAsync(
            (tx, ct) =>
                tx.ExecuteAsync(
                    "INSERT INTO state_documents(name,text) SELECT 'doc'||n,'{}' FROM generate_series(1,600)n",
                    ct
                )
        );
        await f.Db.ExecuteOwnerAsync(
            $"UPDATE tenant_leases SET state='released' WHERE tenant_id={id}"
        );
        await store.SuspendAsync("dos", default);
        await Task.WhenAll(store.DeleteAsync("dos", default), store.DeleteAsync("dos", default));
        var deletion = (long)
            (
                await f.Db.ScalarAsync(
                    "SELECT deletion_epoch FROM tenant_leases WHERE tenant_id=$1",
                    id
                )
            )!;
        Assert.Equal(epoch + 1, deletion);
        Assert.Equal(
            409,
            (
                await Assert.ThrowsAsync<OperatorProblem>(() => store.ResumeAsync("dos", default))
            ).Status
        );
        Assert.True(
            await f.Db.ScalarAsync(
                "SELECT credential_version>0 FROM tenants WHERE tenant_id=$1",
                id
            )
                is true
        );
        Assert.False(
            (bool)
                (
                    await f.Db.ScalarAsync(
                        "SELECT has_function_privilege(app_role,'foxwarm_operator_delete_chunk(integer,bigint,text,integer)','EXECUTE') FROM schema_info"
                    )
                )!
        );
        // A trigger rejects the real cleanup statement after it has deleted a row. The entire
        // chunk, including its ownerless maintenance lease, must roll back.
        await f.Db.ExecuteOwnerAsync(
            "CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER reject_cleanup AFTER DELETE ON state_documents FOR EACH ROW EXECUTE FUNCTION reject_cleanup()"
        );
        Task<int> Chunk(long expected) =>
            f.Operator.ClusterAsync(
                (tx, ct) =>
                    Task.FromResult(
                        (int)
                            tx.Scalar(
                                "SELECT foxwarm_operator_delete_chunk($1,$2,'state_documents',256)",
                                id,
                                expected
                            )!
                    ),
                default
            );
        Assert.Equal(
            "P0001",
            (await Assert.ThrowsAsync<PostgresException>(() => Chunk(deletion))).SqlState
        );
        Assert.Equal(
            "released",
            await f.Db.ScalarAsync("SELECT state FROM tenant_leases WHERE tenant_id=$1", id)
        );
        Assert.Equal(
            600L,
            await f.Db.ScalarAsync("SELECT count(*) FROM state_documents WHERE tenant_id=$1", id)
        );
        await f.Db.ExecuteOwnerAsync("DROP TRIGGER reject_cleanup ON state_documents");
        Assert.Equal(256, await Chunk(deletion));
        Assert.Equal(
            344L,
            await f.Db.ScalarAsync("SELECT count(*) FROM state_documents WHERE tenant_id=$1", id)
        );
        // A process starting after this completed chunk recovers the remaining rows without
        // a second DELETE request. Another worker may join the same durable deletion.
        using var stop = new CancellationTokenSource();
        var workers = Task.WhenAll(
            f.Store.RunDeletionLoopAsync(stop.Token),
            f.Store.RunDeletionLoopAsync(stop.Token)
        );
        try
        {
            await Until(async () =>
                await f.Db.ScalarAsync("SELECT 1 FROM tenants WHERE tenant_id=$1", id) is null
            );
        }
        finally
        {
            stop.Cancel();
            await workers;
        }
        Assert.Equal(
            0L,
            await f.Db.ScalarAsync("SELECT count(*) FROM tenant_keys WHERE tenant_id=$1", id)
        );
        Assert.Equal(
            1L,
            await f.Db.ScalarAsync("SELECT count(*) FROM tenants WHERE name='default'")
        );
    }

    [Fact]
    public async Task Acquisition_waits_for_the_lease_lock_and_then_declines_a_terminal_tenant()
    {
        await using var f = await Fixture.Create();
        var db = f.Db;
        await db.RegisterBootsAsync("standby");
        await using var connection = new NpgsqlConnection(db.OwnerConnectionString);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        var id = await db.TenantIdAsync();
        await using var transition = new NpgsqlCommand(
            $"SELECT 1 FROM tenant_leases WHERE tenant_id={id} FOR UPDATE; UPDATE tenants SET state='deleting' WHERE tenant_id={id}; UPDATE tenant_leases SET epoch=epoch+1,deletion_epoch=epoch+1,state='released',draining_since=now() WHERE tenant_id={id}",
            connection,
            transaction
        );
        await transition.ExecuteNonQueryAsync();
        var acquire = new TenantLease(db.OpenApp(), PostgresServer.Tenant, 2).TryAcquireAsync(
            "standby",
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(5),
            default
        );
        await Until(async () =>
            await db.ScalarAsync(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF l%')"
            )
                is true
        );
        Assert.False(acquire.IsCompleted);
        await transaction.CommitAsync();
        Assert.Null(await acquire);
        // Same shape as a migration-role abandoned import, with no operator progress yet.
        using var stop = new CancellationTokenSource();
        var run = f.Store.RunDeletionLoopAsync(stop.Token);
        try
        {
            await Until(async () =>
                await db.ScalarAsync("SELECT 1 FROM tenants WHERE tenant_id=$1", id) is null
            );
        }
        finally
        {
            stop.Cancel();
            await run;
        }
    }
}
