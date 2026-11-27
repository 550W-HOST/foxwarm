using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Schema;
using Npgsql;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// Cluster tables of P2 (migration 0003): who may write them, the slug and state rules, and the
// lease-checked wake-up functions the runtime role writes its own row through.
[Trait("Backend", "postgres")]
public sealed class ClusterSchemaTests
{
    private static async Task<PostgresException> RefusedAsync(string connectionString, string sql)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        return await Assert.ThrowsAsync<PostgresException>(() => command.ExecuteNonQueryAsync());
    }

    private static async Task<object?> RunAsync(string connectionString, string sql)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        return await command.ExecuteScalarAsync();
    }

    [Fact]
    public async Task TheRuntimeRoleOnlyReadsClusterTablesAndTheOperatorRoleWritesThem()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var app = database.AppConnectionString;
        var tenant = await database.TenantIdAsync();
        foreach (var sql in new[]
        {
            "INSERT INTO tenants (name) VALUES ('intruder')",
            "UPDATE tenants SET state = 'suspended'",
            "UPDATE tenants SET settings = '{\"journal\": false}'",
            "DELETE FROM tenants",
            $"INSERT INTO tenant_hostnames (hostname, tenant_id, kind) VALUES ('evil.test', {tenant}, 'custom')",
            "UPDATE tenant_hostnames SET tenant_id = 0",
            "DELETE FROM tenant_hostnames",
            $"INSERT INTO tenant_wakeups (tenant_id, due_at) VALUES ({tenant}, now())",
            $"INSERT INTO provider_grants (tenant_id, provider_id) VALUES ({tenant}, 'p')",
            "INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling', '')",
            "SELECT count(*) FROM operator_credentials",
        })
            Assert.Equal("42501", (await RefusedAsync(app, sql)).SqlState);
        Assert.Equal(0L, await RunAsync(app, "SELECT count(*) FROM tenant_hostnames"));

        var operatorRole = database.OperatorConnectionString;
        var created = (int)(await RunAsync(operatorRole, "INSERT INTO tenants (name) VALUES ('beta') RETURNING tenant_id"))!;
        await RunAsync(operatorRole, $"INSERT INTO tenant_leases (tenant_id) VALUES ({created})");
        await RunAsync(operatorRole, $"INSERT INTO tenant_hostnames (hostname, tenant_id, kind) VALUES ('beta.example.test', {created}, 'primary')");
        await RunAsync(operatorRole, $"UPDATE tenants SET state = 'suspended', limits = '{{\"sessions\": 10}}' WHERE tenant_id = {created}");
        Assert.Equal("42501", (await RefusedAsync(operatorRole, "INSERT INTO operator_credentials (id, hash) VALUES ('op1', 'h')")).SqlState);
        Assert.Equal(1L, await RunAsync(app, "SELECT count(*) FROM tenant_hostnames"));
        // The operator role reaches no tenant data directly.
        Assert.Equal(
            "42501",
            (await RefusedAsync(
                operatorRole,
                $"SELECT set_config('foxwarm.tenant', '{tenant}', false); SELECT count(*) FROM state_documents"
            )).SqlState
        );
    }

    [Fact]
    public async Task SlugsAreImmutableDnsLabelsAndHostnamesHaveOnePrimary()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var owner = database.OwnerConnectionString;
        Assert.Equal("FW002", (await RefusedAsync(owner, "UPDATE tenants SET name = 'renamed'")).SqlState);
        Assert.Equal("23514", (await RefusedAsync(owner, "INSERT INTO tenants (name) VALUES ('Not_A_Label')")).SqlState);
        await RunAsync(owner, "UPDATE tenants SET state = 'deleting'");
        var tenant = await database.TenantIdAsync();
        Assert.Equal(
            "23514",
            (await RefusedAsync(owner, $"INSERT INTO tenant_hostnames VALUES ('Upper.test', {tenant}, 'primary')")).SqlState
        );
        await RunAsync(owner, $"INSERT INTO tenant_hostnames VALUES ('a.test', {tenant}, 'primary')");
        Assert.Equal(
            "23505",
            (await RefusedAsync(owner, $"INSERT INTO tenant_hostnames VALUES ('b.test', {tenant}, 'primary')")).SqlState
        );
        await RunAsync(owner, $"INSERT INTO tenant_hostnames VALUES ('b.test', {tenant}, 'custom')");
    }

    [Fact]
    public async Task HostnameAndTenantChangesSignalTheReplicas()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await using var listener = new NpgsqlConnection(database.AppConnectionString);
        await listener.OpenAsync();
        var received = new List<string>();
        listener.Notification += (_, args) => received.Add(args.Channel);
        await using (var listen = new NpgsqlCommand("LISTEN foxwarm_tenants; LISTEN foxwarm_operator", listener))
            await listen.ExecuteNonQueryAsync();
        var tenant = await database.TenantIdAsync();
        await RunAsync(database.OperatorConnectionString, $"INSERT INTO tenant_hostnames VALUES ('a.test', {tenant}, 'primary')");
        await RunAsync(database.OperatorConnectionString, "INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling', '')");
        while (received.Count < 2)
            Assert.True(await listener.WaitAsync(TimeSpan.FromSeconds(5)), "no notification");
        Assert.Equal(["foxwarm_tenants", "foxwarm_operator"], received);
    }

    [Fact]
    public async Task TheWakeupRowIsWrittenOnlyUnderTheCurrentLeaseAndKeptThroughActivation()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var app = database.OpenApp();
        var lease = new TenantLease(app, PostgresServer.Tenant, 2);
        var tenant = await database.TenantIdAsync();
        // Without the lease the function refuses.
        var refused = await RefusedAsync(
            database.AppConnectionString,
            $"SELECT set_config('foxwarm.tenant', '{tenant}', false), set_config('foxwarm.epoch', '0', false);"
                + " SELECT foxwarm_set_wakeup(now(), NULL)"
        );
        Assert.Equal("FW001", refused.SqlState);

        var occurrence = new JsonObject { ["timer"] = "daily", ["generation"] = 3, ["at"] = "2026-11-28T09:00:00Z" };
        var due = new DateTimeOffset(2026, 11, 28, 8, 58, 0, TimeSpan.Zero);
        var first = (await Acquire(lease))!;
        Assert.True(await lease.ReleaseWithWakeupAsync(first, new WakeupDue(due, occurrence), default));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        var row = (await lease.ReadWakeupAsync(tenant, default))!;
        Assert.Equal(due, row.DueAt);
        Assert.True(JsonNode.DeepEquals(occurrence, row.Occurrence));

        // A stale grant writes nothing.
        Assert.False(await lease.ReleaseWithWakeupAsync(first, null, default));
        Assert.NotNull(await lease.ReadWakeupAsync(tenant, default));

        // Activation keeps the row; a failed start backs off and keeps its due occurrence.
        var second = (await Acquire(lease))!;
        Assert.NotNull(await lease.ReadWakeupAsync(tenant, default));
        Assert.True(await lease.ReleaseAfterFailedStartAsync(second, TimeSpan.FromMinutes(1), create: false, default));
        row = (await lease.ReadWakeupAsync(tenant, default))!;
        Assert.Equal(due, row.DueAt);
        Assert.True(JsonNode.DeepEquals(occurrence, row.Occurrence));
        Assert.Equal(1, row.Attempts);
        Assert.InRange(row.NextAttemptAt!.Value, DateTimeOffset.UtcNow.AddSeconds(30), DateTimeOffset.UtcNow.AddSeconds(90));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));

        // A release with nothing due removes the row; a failed start without one creates it on request.
        var third = (await Acquire(lease))!;
        Assert.True(await lease.ReleaseWithWakeupAsync(third, null, default));
        Assert.Null(await lease.ReadWakeupAsync(tenant, default));
        var fourth = (await Acquire(lease))!;
        Assert.True(await lease.ReleaseAfterFailedStartAsync(fourth, TimeSpan.FromSeconds(5), create: false, default));
        Assert.Null(await lease.ReadWakeupAsync(tenant, default));
        var fifth = (await Acquire(lease))!;
        Assert.True(await lease.ReleaseAfterFailedStartAsync(fifth, TimeSpan.FromSeconds(5), create: true, default));
        Assert.Equal(1, (await lease.ReadWakeupAsync(tenant, default))!.Attempts);
    }

    private static Task<LeaseGrant?> Acquire(TenantLease lease) =>
        lease.TryAcquireAsync("r1/0001", TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(5), default);

    [Fact]
    public async Task TheLintReportsClusterTablesWithRowSecurityOrRuntimeWrites()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await database.ExecuteOwnerAsync(
            $"GRANT INSERT ON tenant_hostnames TO {PostgresServer.AppRole};"
                + $" GRANT SELECT ON operator_credentials TO {PostgresServer.AppRole};"
                + " ALTER TABLE provider_grants ENABLE ROW LEVEL SECURITY"
        );
        var problems = await SchemaLint.ProblemsAsync(database.OwnerConnectionString);
        Assert.Contains("tenant_hostnames: the runtime role has INSERT", problems);
        Assert.Contains("operator_credentials: the runtime role has SELECT", problems);
        Assert.Contains("provider_grants: cluster tables have no row-level security", problems);
    }

    [Fact]
    public async Task MigrateRecordsTheOperatorRoleOnceAndRefusesAnother()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var same = await Assert.ThrowsAsync<SchemaIncompatibleException>(() =>
            SchemaMigrator.MigrateAsync(database.OpenOwner(), PostgresServer.AppRole, PostgresServer.AppRole, null)
        );
        Assert.Contains("different", same.Message);
        var other = await Assert.ThrowsAsync<SchemaIncompatibleException>(() =>
            SchemaMigrator.MigrateAsync(database.OpenOwner(), PostgresServer.AppRole, PostgresServer.OwnerRole, null)
        );
        Assert.Contains(PostgresServer.OperatorRole, other.Message);
        // A database from before the operator role records it at its next migration.
        await database.ExecuteOwnerAsync("UPDATE schema_info SET operator_role = NULL");
        await SchemaMigrator.MigrateAsync(database.OpenOwner(), PostgresServer.AppRole, PostgresServer.OperatorRole, null);
        Assert.Equal(PostgresServer.OperatorRole, await database.ScalarAsync("SELECT operator_role FROM schema_info"));
    }
}
