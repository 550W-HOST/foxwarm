using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;

namespace Foxwarm.Hosted;

/// <summary>
/// The hosted-mode operator commands: <c>db migrate</c> and <c>db status</c>. They run beside
/// or before the replicas and never start a runtime.
/// </summary>
internal static class HostedCli
{
    internal const int UsageError = 2;

    /// <summary>Configuration or schema refused (EX_CONFIG).</summary>
    internal const int ConfigurationError = 78;

    internal static async Task<int> RunAsync(
        string[] args,
        TextWriter output,
        TextWriter error,
        System.Collections.IDictionary? environment = null
    )
    {
        try
        {
            var bootstrap = HostedBootstrap.FromEnvironment(environment);
            switch (args)
            {
                case ["db", "migrate", .. var options]:
                    return await MigrateAsync(bootstrap, options, output);
                case ["db", "status"]:
                    return await StatusAsync(bootstrap, output);
                case ["hosted", "import", .. var options]:
                    return await ImportAsync(bootstrap, options, output, error);
                default:
                    await error.WriteLineAsync(Usage);
                    return UsageError;
            }
        }
        catch (Exception failure) when (failure is HostedBootstrapException or SchemaIncompatibleException)
        {
            await error.WriteLineAsync("Error: " + failure.Message);
            return ConfigurationError;
        }
        catch (Exception failure)
        {
            await error.WriteLineAsync("Error: " + failure.Message);
            return 1;
        }
    }

    internal const string Usage =
        "Usage: foxwarm db migrate [--app-role <role>] [--tenant <name>] | foxwarm db status\n"
        + "       foxwarm hosted import --data-root <dir> [--tenant <name>] [--journal] [--dry-run]\n"
        + "                              [--report <file>] [--deployment-config <file>]";

    /// <summary>
    /// <c>foxwarm hosted import</c> (<see cref="Import.HostedImport"/>). Tenant rows are written
    /// through FOXWARM_DATABASE_URL (the runtime role, as a replica writes them); the tenant's
    /// state and identity sequences through FOXWARM_MIGRATE_DATABASE_URL. The data key is
    /// wrapped under FOXWARM_KEK_FILE.
    /// </summary>
    private static async Task<int> ImportAsync(
        HostedBootstrap bootstrap,
        string[] options,
        TextWriter output,
        TextWriter error
    )
    {
        string? dataRoot = null;
        string? report = null;
        var deployment = bootstrap.DeploymentConfigPath;
        var tenant = bootstrap.Tenant;
        var journal = false;
        var dryRun = false;
        for (var index = 0; index < options.Length; index++)
            switch (options[index])
            {
                case "--data-root" when index + 1 < options.Length:
                    dataRoot = options[++index];
                    break;
                case "--tenant" when index + 1 < options.Length:
                    tenant = options[++index];
                    break;
                case "--report" when index + 1 < options.Length:
                    report = options[++index];
                    break;
                case "--deployment-config" when index + 1 < options.Length:
                    deployment = options[++index];
                    break;
                case "--journal":
                    journal = true;
                    break;
                case "--dry-run":
                    dryRun = true;
                    break;
                default:
                    await error.WriteLineAsync("Unknown hosted import option: " + options[index]);
                    await error.WriteLineAsync(Usage);
                    return UsageError;
            }
        if (dataRoot is null || string.IsNullOrWhiteSpace(tenant))
        {
            await error.WriteLineAsync(Usage);
            return UsageError;
        }
        report ??= $"foxwarm-import-{tenant}-{DateTimeOffset.UtcNow:yyyyMMdd'T'HHmmss'Z'}.json";
        var (kek, _) = bootstrap.RequireKeks();
        // The blobs go where the replicas will read them: the deployment configuration's
        // `blobs` block, or PostgreSQL without one.
        var blobs = deployment is null ? null : DeploymentConfiguration.Load(deployment).Blobs;
        await using var app = new PgDatabase(bootstrap.RequireDatabaseUrl(), "foxwarm-import");
        await using var owner = new PgDatabase(bootstrap.RequireMigrateDatabaseUrl(), "foxwarm-import-owner");
        return await Import.HostedImport.RunAsync(
            new Import.HostedImportOptions(dataRoot, tenant, journal, dryRun, report) { Blobs = blobs },
            new Import.ImportDatabases(app, owner, kek),
            output
        );
    }

    private static async Task<int> MigrateAsync(
        HostedBootstrap bootstrap,
        string[] options,
        TextWriter output
    )
    {
        var appRole = bootstrap.AppRole;
        var tenant = bootstrap.Tenant;
        for (var index = 0; index < options.Length; index++)
            switch (options[index])
            {
                case "--app-role" when index + 1 < options.Length:
                    appRole = options[++index];
                    break;
                case "--tenant" when index + 1 < options.Length:
                    tenant = options[++index];
                    break;
                default:
                    throw new HostedBootstrapException("Unknown db migrate option: " + options[index]);
            }
        await using var database = new PgDatabase(
            bootstrap.RequireMigrateDatabaseUrl(),
            "foxwarm-migrate"
        );
        var applied = await SchemaMigrator.MigrateAsync(database, appRole, tenant);
        foreach (var migration in applied)
            await output.WriteLineAsync(
                "Applied " + SchemaStatus.Label(migration.Version, migration.Name)
            );
        await output.WriteLineAsync(
            $"Schema is at level {SchemaMigrator.BinaryLevel}; tenant {tenant} is present."
        );
        return 0;
    }

    private static async Task<int> StatusAsync(HostedBootstrap bootstrap, TextWriter output)
    {
        await using var database = new PgDatabase(
            bootstrap.RequireMigrateDatabaseUrl(),
            "foxwarm-status"
        );
        var status = await SchemaMigrator.StatusAsync(database);
        await output.WriteLineAsync($"Build schema level: {status.BinaryLevel}");
        foreach (var item in status.Applied)
            await output.WriteLineAsync(
                $"applied  {SchemaStatus.Label(item.Version, item.Name)} (reader floor {item.ReaderFloor})"
            );
        foreach (var item in status.Pending)
            await output.WriteLineAsync($"pending  {SchemaStatus.Label(item.Version, item.Name)}");
        foreach (var item in status.Unknown)
            await output.WriteLineAsync(
                $"unknown  {SchemaStatus.Label(item.Version, item.Name)} (reader floor {item.ReaderFloor})"
            );
        if (status.Unknown.Count == 0 && status.Pending.Count == 0)
            await TenantKeysAsync(database, output);
        if (status.Refusal() is { } refusal)
        {
            await output.WriteLineAsync("Replicas of this build would refuse to start: " + refusal);
            return ConfigurationError;
        }
        await output.WriteLineAsync("Replicas of this build can run against this schema.");
        return 0;
    }

    // Which key-encryption key wraps each tenant's data key: after a KEK rotation, every tenant
    // should name the new KEK before the previous one is removed. Each tenant is read under its
    // own row-level security setting.
    private static async Task TenantKeysAsync(PgDatabase database, TextWriter output)
    {
        var tenants = new TenantDb(database, 0, 0).Read(tx =>
        {
            using var command = tx.Command("SELECT tenant_id, name FROM tenants ORDER BY name COLLATE \"C\"");
            using var reader = command.ExecuteReader();
            var rows = new List<(int Id, string Name)>();
            while (reader.Read())
                rows.Add((reader.GetInt32(0), reader.GetString(1)));
            return rows;
        });
        foreach (var (id, name) in tenants)
        {
            var key = new TenantDb(database, id, 0).Read(tx =>
            {
                using var command = tx.Command("SELECT key_id, kek_id FROM tenant_keys");
                using var reader = command.ExecuteReader();
                return reader.Read() ? (reader.GetString(0), reader.GetString(1)) : ((string, string)?)null;
            });
            await output.WriteLineAsync(
                key is var (keyId, kekId)
                    ? $"tenant  {name}: data key {keyId} wrapped by key-encryption key {kekId}"
                    : $"tenant  {name}: no data key yet"
            );
        }
    }
}
