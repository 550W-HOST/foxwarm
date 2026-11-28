using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Xunit;

namespace Foxwarm.Tests.Hosted;

public sealed class SchemaMigrationParseTests
{
    [Fact]
    public void EmbeddedMigrationsParseInOrderWithReaderFloors()
    {
        var migrations = SchemaMigrator.Embedded;
        Assert.NotEmpty(migrations);
        Assert.Equal(1, migrations[0].Version);
        Assert.Equal("foundation", migrations[0].Name);
        Assert.Equal(migrations[^1].Version, SchemaMigrator.BinaryLevel);
        Assert.All(migrations, migration => Assert.InRange(migration.ReaderFloor, 1, migration.Version));
    }

    [Theory]
    [InlineData("1_bad.sql", "-- reader-floor: 1\nSELECT 1;")]
    [InlineData("0002_Bad.sql", "-- reader-floor: 1\nSELECT 1;")]
    [InlineData("0002_ok.sql", "SELECT 1;\n-- reader-floor: 1")]
    [InlineData("0002_ok.sql", "-- reader-floor: 3\nSELECT 1;")]
    [InlineData("0002_ok.sql", "-- reader-floor: 0\nSELECT 1;")]
    public void MalformedMigrationsAreRejected(string file, string sql) =>
        Assert.Throws<InvalidDataException>(() => SchemaMigrator.Parse([(file, sql)]));

    [Fact]
    public void DuplicateVersionsAreRejected() =>
        Assert.Throws<InvalidDataException>(() =>
            SchemaMigrator.Parse(
                [("0002_a.sql", "-- reader-floor: 1\n"), ("0002_b.sql", "-- reader-floor: 1\n")]
            )
        );
}

[Trait("Backend", "postgres")]
public sealed class SchemaMigratorTests
{
    private static SchemaMigration Extra(int version, int floor, string sql = "SELECT 1;") =>
        SchemaMigrator.Parse([($"{version:D4}_extra.sql", $"-- reader-floor: {floor}\n{sql}")])[0];

    [Fact]
    public async Task MigrateCreatesTheSchemaOnceAndTheTenant()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync(migrated: false);
        var owner = database.OpenOwner();
        var first = await SchemaMigrator.MigrateAsync(owner, PostgresServer.AppRole, PostgresServer.OperatorRole, "alpha");
        Assert.Equal(SchemaMigrator.Embedded.Select(item => item.Version), first.Select(item => item.Version));
        var again = await SchemaMigrator.MigrateAsync(owner, PostgresServer.AppRole, PostgresServer.OperatorRole, "alpha");
        Assert.Empty(again);
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM tenants WHERE name = 'alpha'"));
        Assert.Equal(
            "released",
            await database.ScalarAsync(
                "SELECT tenant_leases.state FROM tenant_leases JOIN tenants USING (tenant_id) WHERE name = 'alpha'"
            )
        );
        var status = await SchemaMigrator.StatusAsync(database.OpenApp());
        Assert.Null(status.Refusal());
        Assert.Empty(status.Pending);
    }

    [Fact]
    public async Task ConcurrentMigrationsApplyEachVersionOnce()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync(migrated: false);
        var results = await Task.WhenAll(
            Enumerable
                .Range(0, 3)
                .Select(_ => SchemaMigrator.MigrateAsync(database.OpenOwner(), PostgresServer.AppRole, PostgresServer.OperatorRole, "default"))
        );
        Assert.Equal(SchemaMigrator.Embedded.Count, results.Sum(applied => applied.Count));
        Assert.Equal(
            (long)SchemaMigrator.Embedded.Count,
            await database.ScalarAsync("SELECT count(*) FROM schema_migrations")
        );
    }

    [Fact]
    public async Task ReplicasRefuseMissingChangedAndTooNewSchemas()
    {
        var server = await PostgresServer.SharedAsync();
        await using var empty = await server.CreateDatabaseAsync(migrated: false);
        var pending = await SchemaMigrator.StatusAsync(empty.OpenOwner());
        Assert.Contains("foxwarm db migrate", pending.Refusal());

        await using var database = await server.CreateDatabaseAsync();
        var owner = database.OpenOwner();
        var compatibleExpansion = Extra(9001, 1);
        await SchemaMigrator.MigrateAsync(
            owner,
            PostgresServer.AppRole,
            PostgresServer.OperatorRole,
            null,
            [.. SchemaMigrator.Embedded, compatibleExpansion]
        );
        // A newer, expand-only migration leaves older binaries able to run.
        await SchemaMigrator.RequireCompatibleAsync(database.OpenApp());

        var contract = Extra(9002, 9002);
        await SchemaMigrator.MigrateAsync(
            owner,
            PostgresServer.AppRole,
            PostgresServer.OperatorRole,
            null,
            [.. SchemaMigrator.Embedded, compatibleExpansion, contract]
        );
        var error = await Assert.ThrowsAsync<SchemaIncompatibleException>(() =>
            SchemaMigrator.RequireCompatibleAsync(database.OpenApp())
        );
        Assert.Contains("schema level 9002", error.Message);

        await database.ExecuteOwnerAsync("UPDATE schema_migrations SET sha256 = 'other' WHERE version = 1");
        var changed = await SchemaMigrator.StatusAsync(database.OpenApp());
        Assert.Contains("differ", changed.Refusal());
        await Assert.ThrowsAsync<SchemaIncompatibleException>(() =>
            SchemaMigrator.MigrateAsync(owner, PostgresServer.AppRole, PostgresServer.OperatorRole, null)
        );
    }

    [Fact]
    public async Task MigrateRefusesAnotherRuntimeRole()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var error = await Assert.ThrowsAsync<SchemaIncompatibleException>(() =>
            SchemaMigrator.MigrateAsync(database.OpenOwner(), PostgresServer.OwnerRole, PostgresServer.OperatorRole, null)
        );
        Assert.Contains(PostgresServer.AppRole, error.Message);
        var missing = await Assert.ThrowsAsync<SchemaIncompatibleException>(() =>
            SchemaMigrator.MigrateAsync(database.OpenOwner(), "foxwarm_no_such_role", PostgresServer.OperatorRole, null)
        );
        Assert.Contains("doesn't exist", missing.Message);
    }
}

[Trait("Backend", "postgres")]
public sealed class SchemaLintTests
{
    [Fact]
    public async Task EveryTableOfTheSchemaFollowsTheTenantRules()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        Assert.Empty(await SchemaLint.ProblemsAsync(database.OwnerConnectionString));
        // The helper migrations use produces a conforming table.
        await database.CreateTenantTableAsync("lint_conforming");
        Assert.Empty(await SchemaLint.ProblemsAsync(database.OwnerConnectionString));
    }

    [Fact]
    public async Task NonconformingTablesAreReported()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await database.ExecuteOwnerAsync(
            """
            CREATE TABLE lint_no_tenant (id bigint PRIMARY KEY);
            CREATE TABLE lint_plain (tenant_id integer NOT NULL, key text NOT NULL, PRIMARY KEY (tenant_id, key));
            CREATE TABLE lint_key_order (tenant_id integer NOT NULL, key text COLLATE "C" NOT NULL, PRIMARY KEY (key, tenant_id));
            CREATE TABLE lint_row_trigger (tenant_id integer NOT NULL DEFAULT current_setting('foxwarm.tenant')::integer,
                key text COLLATE "C" NOT NULL, PRIMARY KEY (tenant_id, key));
            ALTER TABLE lint_row_trigger ENABLE ROW LEVEL SECURITY;
            ALTER TABLE lint_row_trigger FORCE ROW LEVEL SECURITY;
            CREATE POLICY p ON lint_row_trigger USING (true);
            CREATE TRIGGER foxwarm_fence BEFORE INSERT OR UPDATE OR DELETE ON lint_row_trigger
                FOR EACH ROW EXECUTE FUNCTION foxwarm_fence();
            """
        );
        var problems = await SchemaLint.ProblemsAsync(database.OwnerConnectionString);
        Assert.Contains(problems, item => item.StartsWith("lint_no_tenant: no tenant_id", StringComparison.Ordinal));
        Assert.Contains("lint_plain: row-level security isn't enabled and forced", problems);
        Assert.Contains("lint_plain: no statement-level foxwarm_fence trigger on INSERT, UPDATE and DELETE", problems);
        Assert.Contains("lint_plain: tenant_id doesn't default to the transaction's tenant", problems);
        Assert.Contains("lint_plain.key: collation isn't \"C\"", problems);
        Assert.Contains("lint_key_order: primary key lint_key_order_pkey doesn't start with tenant_id", problems);
        Assert.Contains("lint_row_trigger: no statement-level foxwarm_fence trigger on INSERT, UPDATE and DELETE", problems);
        Assert.DoesNotContain(problems, item => item.StartsWith("lint_row_trigger: row-level", StringComparison.Ordinal));
    }
}

public sealed class HostedBootstrapTests
{
    [Fact]
    public void SecretsComeFromTheVariableOrItsFile()
    {
        using var directory = new TemporaryDirectory();
        var file = Path.Combine(directory.Path, "url");
        File.WriteAllText(file, "Host=db;Database=fox\n");
        var bootstrap = Foxwarm.Hosted.HostedBootstrap.FromEnvironment(
            new System.Collections.Hashtable { ["FOXWARM_DATABASE_URL_FILE"] = file }
        );
        Assert.Equal("Host=db;Database=fox", bootstrap.RequireDatabaseUrl());
        Assert.Equal("Host=db;Database=fox", bootstrap.RequireMigrateDatabaseUrl());
        Assert.Equal("default", bootstrap.Tenant);
        Assert.Equal("foxwarm_app", bootstrap.AppRole);
        Assert.Throws<Foxwarm.Hosted.HostedBootstrapException>(() =>
            Foxwarm.Hosted.HostedBootstrap.FromEnvironment(
                new System.Collections.Hashtable
                {
                    ["FOXWARM_DATABASE_URL"] = "Host=db",
                    ["FOXWARM_DATABASE_URL_FILE"] = file,
                }
            )
        );
        Assert.Throws<Foxwarm.Hosted.HostedBootstrapException>(() =>
            Foxwarm.Hosted.HostedBootstrap.FromEnvironment(
                new System.Collections.Hashtable { ["FOXWARM_TENANT"] = "a b" }
            )
        );
        Assert.Throws<Foxwarm.Hosted.HostedBootstrapException>(() =>
            Foxwarm.Hosted.HostedBootstrap.FromEnvironment(new System.Collections.Hashtable()).RequireDatabaseUrl()
        );
    }

    [Fact]
    public void TheReplicaRoleIsGeneralUnlessTheDeploymentSetsOne()
    {
        static string Role(string? value)
        {
            var environment = new System.Collections.Hashtable();
            if (value is not null)
                environment["FOXWARM_ROLE"] = value;
            if (value == "master-host")
                environment["FOXWARM_AGENTS_DIR"] = Path.GetTempPath();
            return Foxwarm.Hosted.HostedBootstrap.FromEnvironment(environment).Role;
        }
        Assert.Equal("general", Role(null));
        Assert.Equal("general", Role(""));
        Assert.Equal("master-host", Role("master-host"));
        Assert.Equal("operator", Role("operator"));
        Assert.Contains(
            "FOXWARM_ROLE must be general, master-host or operator.",
            Assert.Throws<Foxwarm.Hosted.HostedBootstrapException>(() => Role("Master-Host")).Message
        );
    }

    [Fact]
    public void PostgresUrlsBecomeKeywordConnectionStrings()
    {
        var settings = new Npgsql.NpgsqlConnectionStringBuilder(
            PgConnectionString.Normalize("postgresql://fox%40app:p%3Ass@db.internal:6432/fox%2Ddata?sslmode=require&application_name=x")
        );
        Assert.Equal("fox@app", settings.Username);
        Assert.Equal("p:ss", settings.Password);
        Assert.Equal("db.internal", settings.Host);
        Assert.Equal(6432, settings.Port);
        Assert.Equal("fox-data", settings.Database);
        Assert.Equal(Npgsql.SslMode.Require, settings.SslMode);
        Assert.Equal("Host=x;Database=y", PgConnectionString.Normalize(" Host=x;Database=y "));
        var socket = new Npgsql.NpgsqlConnectionStringBuilder(
            PgConnectionString.Normalize("postgres://app:pw@/fox?host=/run/postgresql&port=5433")
        );
        Assert.Equal("/run/postgresql", socket.Host);
        Assert.Equal(5433, socket.Port);
        Assert.Equal("fox", socket.Database);
        Assert.Equal("app", socket.Username);
        var multi = new Npgsql.NpgsqlConnectionStringBuilder(
            PgConnectionString.Normalize("postgresql://a:1,b:2/fox")
        );
        Assert.Equal("a:1,b:2", multi.Host);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        internal string Path { get; } = Directory.CreateTempSubdirectory("fw-bootstrap-").FullName;

        public void Dispose() => Directory.Delete(Path, true);
    }
}
