using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Import;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;
using Foxwarm.Storage;
using Npgsql;
using Xunit;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedImportTests : IAsyncLifetime
{
    private readonly TempDirectory temp = new();
    private ImportFixture.Built fixture = null!;

    public async Task InitializeAsync() => fixture = await ImportFixture.BuildAsync(Path.Combine(temp.Path, "fixture"));

    public Task DisposeAsync()
    {
        temp.Dispose();
        return Task.CompletedTask;
    }

    private string Reports => Directory.CreateDirectory(Path.Combine(temp.Path, "reports")).FullName;

    private string CopyFixture(string name) => ImportFixture.Copy(fixture.DataRoot, Path.Combine(temp.Path, name));

    private static List<string> Texts(JsonNode? array, string field) =>
        array!.AsArray().Select(item => item![field]!.ToString()).ToList();

    [Fact]
    public async Task The_synthetic_installation_imports_with_a_clean_report_and_the_source_unchanged()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        const string cursor = """{"matrix":{"account":"matrix:homeserver:bot","next_batch":"offline"}}""";
        await File.WriteAllTextAsync(Path.Combine(fixture.DataRoot,"state","channel-cursors.json"), cursor);
        var before = ImportFixture.TreeHashes(fixture.DataRoot);

        var result = await RunAsync(database, fixture.DataRoot, "synthetic", Reports);

        output.WriteLine(result.Stdout);
        Assert.Equal(before, ImportFixture.TreeHashes(fixture.DataRoot));
        Assert.True(result.Exit == 0, result.Report.ToJsonString());
        Assert.Equal("imported", result.Report["outcome"]!.GetValue<string>());
        Assert.Empty(result.Report["verificationFailures"]!.AsArray());
        Assert.Equal("active", await TenantStateAsync(database, "synthetic"));
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(result.ReportPath));
        Assert.Contains("Report (owner-only)", result.Stdout);

        // Every store the fixture fills was imported and verified.
        var verification = result.Report["verification"]!;
        Assert.True(verification["sessions"]!["count"]!.GetValue<long>() >= 2);
        Assert.All(verification["sessions"]!["documents"]!.AsArray(), item => Assert.True(item!["equal"]!.GetValue<bool>()));
        Assert.All(verification["sessions"]!["documents"]!.AsArray(), item => Assert.Equal(item!["sha256"]!.ToString(), item["importedSha256"]!.ToString()));
        Assert.True(verification["catalog"]!["equal"]!.GetValue<bool>());
        Assert.True(verification["catalogLoads"]!["loaded"]!.GetValue<long>() >= 2);
        var tables = verification["tables"]!.AsArray().ToDictionary(item => item!["table"]!.ToString(), item => item!);
        foreach (var table in new[] { "archive_messages", "tasks", "task_notes", "archive_direct_effects", "llm_journal_requests", "llm_usage", "text_redaction_known" })
        {
            Assert.True(tables[table]["sourceRows"]!.GetValue<long>() > 0, table + " has no source rows");
            Assert.True(tables[table]["equal"]!.GetValue<bool>(), table);
        }
        Assert.Equal(1, verification["toolScriptRuns"]!["count"]!.GetValue<long>());
        Assert.Equal(2, verification["blobs"]!["sameHash"]!.GetValue<long>());
        Assert.Equal(2, (await RowCountsAsync(database, "synthetic"))["blob_objects"]);
        Assert.Contains("Nodes", Texts(verification["documents"], "document"));
        Assert.Contains("ChannelCursors", Texts(verification["documents"], "document"));
        Assert.Equal(cursor, await database.ScalarAsync("SELECT text FROM state_documents JOIN tenants USING(tenant_id) WHERE tenants.name='synthetic' AND state_documents.name='channel-cursors'"));
        Assert.Contains("McpOAuth", Texts(verification["documents"], "document"));

        // Configuration: comments stay in the tenant document; deployment blocks go to the draft;
        // refused settings are dropped and listed with their values.
        var tenantConfig = await ConfigDocumentAsync(database, "synthetic", "config");
        Assert.Contains("# Kept for the tenant.", tenantConfig);
        Assert.Contains("maxOutput: 4096 # trailing comment", tenantConfig);
        Assert.Contains("name: import-fixture", tenantConfig);
        Assert.DoesNotContain("httpPort", tenantConfig);
        Assert.DoesNotContain("asrService", tenantConfig);
        Assert.DoesNotContain("vector", tenantConfig);
        Assert.DoesNotContain("enableTUI", tenantConfig);
        var draft = await File.ReadAllTextAsync(result.Report["configuration"]!["deploymentDraft"]!.ToString());
        Assert.Contains("  httpPort: 3999", draft);
        Assert.Contains("# Listener port: a deployment setting.", draft);
        Assert.Contains("asrService:", draft);
        var dropped = result.Report["configuration"]!["droppedSettings"]!.AsArray();
        Assert.Equal(["bot.enableTUI", "vector", "mcp.servers.local"], Texts(dropped, "key"));
        Assert.Equal("false", dropped[0]!["value"]!.ToJsonString());
        Assert.DoesNotContain("stdio", await ConfigDocumentAsync(database, "synthetic", "mcp"));

        var importedFiles = verification["agentFiles"]!.AsArray();
        Assert.NotEmpty(importedFiles);
        Assert.All(importedFiles, file => Assert.True(file!["equal"]!.GetValue<bool>()));
        Assert.DoesNotContain(result.Report["notImported"]!.AsArray(), item => item?["what"]?.ToString()=="state/channel-cursors.json");
        var exec = result.Report["notImported"]!.AsArray().Single(item => item!["what"]!.ToString().StartsWith("exec registry", StringComparison.Ordinal));
        Assert.Equal(1, exec!["count"]!.GetValue<long>());
    }

    [Fact]
    public async Task C4_the_installation_key_becomes_the_tenant_key_and_secrets_and_placeholders_resolve_to_the_same_values()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var result = await RunAsync(database, fixture.DataRoot, "keys", Reports);
        Assert.True(result.Exit == 0, result.Report.ToJsonString());

        var sourceKeys = InstanceKeys.Read(InstanceKeys.DefaultPath(fixture.DataRoot));
        var sourceSecrets = File.ReadAllText(Path.Combine(fixture.DataRoot, "state", "secrets.json"));
        var tenantId = await database.TenantIdAsync("keys");
        var tenant = new TenantDb(database.OpenApp(), tenantId, await database.TakeLeaseAsync(tenantId));
        var context = new Foxwarm.Hosted.PostgresStorageContext(tenant, Path.Combine(temp.Path, "c4-scratch"))
        {
            KeyRing = new HostedKeyRing(tenant, HostedTestBackend.Kek),
        };
        // Copied byte for byte: no re-encryption.
        Assert.Equal(sourceSecrets, context.Documents.Open(StateDocumentName.Secrets).ReadText());
        Assert.Equal(sourceKeys.KeyId, context.KeyRing.OpenOrCreate().KeyId);
        using var hosted = new InstanceSecrets(
            Path.Combine(temp.Path, "c4-scratch"),
            keyRing: context.KeyRing,
            documents: context.Documents,
            openTextRedaction: key => context.OpenTextRedaction(key)
        );
        Assert.Equal(ImportFixture.SecretValue, hosted.Store.Resolve(ImportFixture.SecretName));

        using var source = new InstanceSecrets(fixture.DataRoot);
        var expected = source.TextRedactor().Placeholder(Encoding.UTF8.GetBytes(ImportFixture.RedactedOriginal));
        hosted.SetTextRedactionKnownLabels(Foxwarm.Models.TextRedactionKnownLabels.All);
        var redactor = hosted.TextRedactor();
        Assert.Equal(expected, redactor.Placeholder(Encoding.UTF8.GetBytes(ImportFixture.RedactedOriginal)));
        Assert.Equal(1, redactor.KnownCount);
        using var store = context.OpenTextRedaction(context.KeyRing.OpenOrCreate().Derive(InstanceKeys.TextRedactionStorePurpose, 64));
        Assert.Contains(store!.ReadKnown(), item => item.Original == ImportFixture.RedactedOriginal);
    }

    [Fact]
    public async Task A_dry_run_writes_nothing()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var before = await RowCountsAsync(database);

        var result = await RunAsync(database, fixture.DataRoot, "dry", Reports, dryRun: true);

        Assert.Equal(0, result.Exit);
        Assert.Equal("dry-run", result.Report["outcome"]!.GetValue<string>());
        Assert.Equal(before, await RowCountsAsync(database));
        Assert.Null(await TenantStateAsync(database, "dry"));
        Assert.True(result.Report["plan"]!["sessionDocuments"]!.GetValue<long>() >= 2);
        Assert.NotEmpty(result.Report["configuration"]!["droppedSettings"]!.AsArray());
        Assert.True(File.Exists(result.Report["configuration"]!["deploymentDraft"]!.ToString()));
    }

    [Fact]
    public async Task An_import_refuses_while_Main_holds_the_installation_lock()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var held = InstallationLock.Acquire(fixture.DataRoot);
        var result = await RunAsync(database, fixture.DataRoot, "locked", Reports);
        Assert.Equal(HostedImport.Refused, result.Exit);
        Assert.Contains("Stop Main", result.Report["refusals"]!.ToJsonString());
        Assert.Null(await TenantStateAsync(database, "locked"));
    }

    [Fact]
    public async Task An_import_refuses_a_pending_identity_move_an_unsupported_version_and_a_missing_key()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var pending = CopyFixture("pending");
        await File.WriteAllTextAsync(Path.Combine(pending, "state", "session-id-move-pending.json"), "{}");
        var newer = CopyFixture("newer");
        var installation = Path.Combine(newer, "state", "installation.json");
        var document = File.Exists(installation) ? (JsonObject)JsonNode.Parse(File.ReadAllText(installation))! : new JsonObject();
        document["minimumReaderVersion"] = 99;
        await File.WriteAllTextAsync(installation, document.ToJsonString());
        var keyless = CopyFixture("keyless");
        File.Delete(InstanceKeys.DefaultPath(keyless));
        var unlocked = CopyFixture("unlocked");
        File.Delete(InstallationLock.PathFor(unlocked));

        foreach (var (root, tenant, expected) in new[]
        {
            (pending, "pending", "identity move is pending"),
            (newer, "newer", "installation level 99"),
            (keyless, "keyless", "keys/secrets.key is missing"),
            (unlocked, "unlocked", "main.lock is missing"),
        })
        {
            var result = await RunAsync(database, root, tenant, Reports);
            Assert.Equal(HostedImport.Refused, result.Exit);
            Assert.Contains(expected, result.Report["refusals"]!.ToJsonString());
            Assert.Null(await TenantStateAsync(database, tenant));
        }
    }

    [Fact]
    public async Task An_import_refuses_a_tenant_that_holds_rows_and_a_failed_import_is_retried_under_a_new_name()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        // `db migrate` creates the configured tenant empty; an import may fill it.
        var first = await RunAsync(database, fixture.DataRoot, PostgresServer.Tenant, Reports);
        Assert.True(first.Exit == 0, first.Report.ToJsonString());

        var again = await RunAsync(database, fixture.DataRoot, PostgresServer.Tenant, Reports);
        Assert.Equal(HostedImport.Refused, again.Exit);
        Assert.Contains("already holds data", again.Report["refusals"]!.ToJsonString());
        Assert.Contains("new --tenant name", again.Report["refusals"]!.ToJsonString());
        Assert.Equal("active", await TenantStateAsync(database, PostgresServer.Tenant));
    }

    [Fact]
    public async Task An_import_whose_lease_is_taken_over_stops_writing_and_leaves_the_tenant_importing()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var tookOver = false;
        var result = await RunAsync(
            database,
            fixture.DataRoot,
            "fenced",
            Reports,
            options => options with
            {
                BeforePhase = async phase =>
                {
                    if (phase != "tasks")
                        return;
                    await database.TakeLeaseAsync(await database.TenantIdAsync("fenced"), "intruder");
                    tookOver = true;
                },
            }
        );
        Assert.True(tookOver);
        Assert.Equal(HostedImport.Fenced, result.Exit);
        Assert.Equal("fenced", result.Report["outcome"]!.GetValue<string>());
        Assert.Equal("importing", await TenantStateAsync(database, "fenced"));
        var counts = await RowCountsAsync(database, "fenced");
        Assert.True(counts["archive_messages"] > 0);
        foreach (var later in new[] { "tasks", "task_notes", "toolscript_runs", "llm_usage", "config_documents", "text_redaction_known" })
            Assert.Equal(0, counts[later]);
        // A replica never acquires an importing tenant; a new import refuses it and names the retry.
        var retry = await RunAsync(database, fixture.DataRoot, "fenced", Reports);
        Assert.Equal(HostedImport.Refused, retry.Exit);
        Assert.Contains("failed import", retry.Report["refusals"]!.ToJsonString());
    }

    internal static async Task<string?> TenantStateAsync(HostedTestDatabase database, string tenant)
    {
        await using var connection = new NpgsqlConnection(database.SuperuserConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("SELECT state FROM tenants WHERE name = $1", connection);
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = tenant });
        return await command.ExecuteScalarAsync() as string;
    }

    private static async Task<string> ConfigDocumentAsync(HostedTestDatabase database, string tenant, string name)
    {
        await using var connection = new NpgsqlConnection(database.SuperuserConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(
            "SELECT d.text FROM config_documents d JOIN tenants t USING (tenant_id) WHERE t.name = $1 AND d.name = $2",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = tenant });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = name });
        return (string)(await command.ExecuteScalarAsync())!;
    }

    /// <summary>Rows per tenant table (one tenant, or all), read as the superuser past row-level security.</summary>
    internal static async Task<SortedDictionary<string, long>> RowCountsAsync(HostedTestDatabase database, string? tenant = null)
    {
        await using var connection = new NpgsqlConnection(database.SuperuserConnectionString);
        await connection.OpenAsync();
        var tables = new List<string>();
        await using (var list = new NpgsqlCommand(
            "SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
                + " WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1",
            connection
        ))
        await using (var reader = await list.ExecuteReaderAsync())
            while (await reader.ReadAsync())
                tables.Add(reader.GetString(0));
        var counts = new SortedDictionary<string, long>(StringComparer.Ordinal);
        foreach (var table in tables)
        {
            await using var has = new NpgsqlCommand(
                "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'",
                connection
            );
            has.Parameters.Add(new NpgsqlParameter<string> { TypedValue = table });
            var scoped = tenant is not null && table != "tenants" && await has.ExecuteScalarAsync() is not null;
            await using var count = new NpgsqlCommand(
                $"SELECT count(*) FROM \"{table}\"" + (scoped ? " WHERE tenant_id = (SELECT tenant_id FROM tenants WHERE name = $1)" : ""),
                connection
            );
            if (scoped)
                count.Parameters.Add(new NpgsqlParameter<string> { TypedValue = tenant! });
            counts[table] = (long)(await count.ExecuteScalarAsync())!;
        }
        return counts;
    }
}
