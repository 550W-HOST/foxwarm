using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Npgsql;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// The operator ceiling documents in operator_documents, as a tenant runtime reads them.
[Trait("Backend", "postgres")]
public sealed class OperatorCeilingDocumentsTests
{
    private static async Task<object?> RunAsync(string connectionString, string sql, params object?[] parameters)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var value in parameters)
            command.Parameters.Add(PgTx.Parameter(value));
        return await command.ExecuteScalarAsync();
    }

    private const string Hosted = "version: 1\nrules:\n  - id: hosted-rule\n    tool: {source: node, name: exec}\n    action: deny\n";
    private const string Operator = "version: 1\nrules:\n  - id: operator-rule\n    tool: {source: node, name: exec}\n    action: ask\n";
    private const string Override = "version: 1\nrules:\n  - id: tenant-rule\n    tool: {source: builtin, name: add_secret}\n    action: deny\n";

    [Fact]
    public async Task ATenantReadsItsOverrideElseItsProfilesDocumentAndNeverAnotherTenants()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        var tenant = new TenantDb(database.OpenApp(), tenantId, epoch);
        var operatorRole = database.OperatorConnectionString;
        var hosted = new OperatorCeilingDocuments(tenant, TenantProfile.Hosted);
        var operatorProfile = new OperatorCeilingDocuments(tenant, TenantProfile.Operator);

        Assert.Null(hosted.Read());
        await RunAsync(operatorRole, "INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling.hosted', $1)", Hosted);
        await RunAsync(operatorRole, "INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling.operator', $1)", Operator);
        Assert.Equal(new("profile:hosted", Hosted), hosted.Read());
        Assert.Equal(new("profile:operator", Operator), operatorProfile.Read());

        // Another tenant's override isn't this tenant's.
        var other = (int)(await RunAsync(operatorRole, "INSERT INTO tenants (name) VALUES ('other') RETURNING tenant_id"))!;
        await RunAsync(operatorRole, "INSERT INTO operator_documents (scope, tenant_id, name, text) VALUES ('tenant', $1, 'ceiling', $2)", other, Override);
        Assert.Equal(new("profile:hosted", Hosted), hosted.Read());

        // The tenant's own override replaces its profile's document.
        await RunAsync(operatorRole, "INSERT INTO operator_documents (scope, tenant_id, name, text) VALUES ('tenant', $1, 'ceiling', $2)", tenantId, Override);
        Assert.Equal(new("tenant", Override), hosted.Read());
        Assert.Equal(new("tenant", Override), operatorProfile.Read());
        Assert.Equal(
            "tenant-rule",
            Foxwarm.Tools.OperatorCeiling.Parse(hosted.Read()!.Text).Value["rules"]![0]!["id"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task AChangeToTheDocumentsSignalsTheReplicas()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await using var listener = new NpgsqlConnection(database.AppConnectionString);
        await listener.OpenAsync();
        var received = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        listener.Notification += (_, args) => received.TrySetResult(args.Channel);
        await using (var listen = new NpgsqlCommand("LISTEN foxwarm_operator", listener))
            await listen.ExecuteNonQueryAsync();
        await RunAsync(
            database.OperatorConnectionString,
            "INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling.hosted', $1)",
            Hosted
        );
        var wait = listener.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("foxwarm_operator", await received.Task.WaitAsync(TimeSpan.FromSeconds(10)));
        await wait;
    }
}
