using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;

namespace Foxwarm.Hosted;

/// <summary>
/// The hosted-mode operator commands: <c>db migrate</c>, <c>db status</c>, <c>hosted import</c>,
/// <c>hosted token</c> and <c>hosted health</c>. They run beside or before the replicas and never
/// start a runtime.
/// </summary>
internal static class HostedCli
{
    internal const int UsageError = 2;

    /// <summary>Configuration or schema refused (EX_CONFIG).</summary>
    internal const int ConfigurationError = 78;

    /// <summary>The probe of the replica's own health listener: no proxy, 3 s.</summary>
    internal static HttpClient HealthClient() =>
        Foxwarm.Net.EgressHttp.Client(
            Foxwarm.Net.EgressPolicy.Unguarded,
            Foxwarm.Net.EgressPurpose.Deployment,
            new Foxwarm.Net.EgressHandlerOptions { UseProxy = false },
            timeout: TimeSpan.FromSeconds(3)
        );

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
                case ["hosted", "agents", "import", .. var options]:
                    return await ImportAsync(bootstrap, options, output, error, agentsOnly: true);
                case ["hosted", "import", .. var options]:
                    return await ImportAsync(bootstrap, options, output, error);
                case ["hosted", "token", .. var options]:
                    return await TokenAsync(bootstrap, options, output, error);
                case ["hosted", "health", .. var options]:
                    return await HealthAsync(bootstrap, options, error);
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
        "Usage: foxwarm db migrate [--app-role <role>] [--operator-role <role>] [--tenant <name>] | foxwarm db status\n"
        + "       foxwarm hosted import --data-root <dir> [--agents-dir <path>] [--tenant <name>] [--journal] [--dry-run]\n"
        + "                              [--report <file>] [--deployment-config <file>]\n"
        + "       foxwarm hosted agents import --tenant <name> (--from <dir> | --abandon) [--report <file>] [--deployment-config <file>]\n"
        + "       foxwarm hosted token [--tenant <name>]\n"
        + "       foxwarm hosted health [--ready]";

    /// <summary>
    /// <c>foxwarm hosted token</c>: prints the tenant's sign-in token (the HTTP token instance
    /// credential) for the operator. It reads with the replica's environment (runtime database URL
    /// and key-encryption keys) and writes nothing: no lease, no data key creation or rewrap.
    /// Whoever holds the database URL and the KEK can already decrypt the tenant, so it exposes
    /// nothing new. Exit 1 while the tenant has no token yet: the first owner creates it.
    /// </summary>
    private static async Task<int> TokenAsync(
        HostedBootstrap bootstrap,
        string[] options,
        TextWriter output,
        TextWriter error
    )
    {
        var tenant = bootstrap.Tenant;
        for (var index = 0; index < options.Length; index++)
            switch (options[index])
            {
                case "--tenant" when index + 1 < options.Length:
                    tenant = options[++index];
                    break;
                default:
                    await error.WriteLineAsync("Unknown hosted token option: " + options[index]);
                    await error.WriteLineAsync(Usage);
                    return UsageError;
            }
        var (current, previous) = bootstrap.RequireKeks();
        await using var database = new PgDatabase(bootstrap.RequireDatabaseUrl(), "foxwarm-token");
        var tenantId = new TenantDb(database, 0, 0).Read(tx =>
            tx.Scalar("SELECT tenant_id FROM tenants WHERE name = $1", tenant) as int?
        ) ?? throw new HostedBootstrapException(
            $"Tenant {tenant} doesn't exist; `foxwarm db migrate --tenant {tenant}` creates it."
        );
        var tenantDb = new TenantDb(database, tenantId, 0);
        string? token;
        try
        {
            token = new HostedKeyRing(tenantDb, current, previous).OpenExisting() is { } keys
                ? new PgInstanceCredentials(tenantDb, () => keys).ReadLegacyHttpToken()
                : null;
        }
        catch (TenantKeysLockedException locked)
        {
            throw new HostedBootstrapException(locked.Message);
        }
        if (token is null)
        {
            await error.WriteLineAsync(
                $"Tenant {tenant} has no sign-in token yet; start a replica first, and its first owner creates it."
            );
            return 1;
        }
        await output.WriteLineAsync(token.Trim());
        return 0;
    }

    /// <summary>
    /// <c>foxwarm hosted health</c>: the container health check. It probes this replica's health
    /// listener, at <c>health.port</c> of the deployment configuration the replica reads, on the
    /// local host: <c>/livez</c> by default, so a working standby is healthy; <c>--ready</c> probes
    /// <c>/readyz</c>. Exit 0 when the endpoint answers 200, otherwise 1.
    /// </summary>
    private static async Task<int> HealthAsync(HostedBootstrap bootstrap, string[] options, TextWriter error)
    {
        var path = options switch
        {
            [] => "/livez",
            ["--ready"] => "/readyz",
            _ => null,
        };
        if (path is null)
        {
            await error.WriteLineAsync(Usage);
            return UsageError;
        }
        try
        {
            var endpoint = bootstrap.RequireDeployment().HealthEndpoint;
            var address = endpoint.Address.Equals(System.Net.IPAddress.Any)
                ? System.Net.IPAddress.Loopback
                : endpoint.Address.Equals(System.Net.IPAddress.IPv6Any)
                    ? System.Net.IPAddress.IPv6Loopback
                    : endpoint.Address;
            // The replica's own health listener: a local probe, not tenant egress.
            using var http = HealthClient();
            using var response = await http.GetAsync(
                new UriBuilder("http", address.ToString(), endpoint.Port, path).Uri
            );
            if (response.StatusCode == System.Net.HttpStatusCode.OK)
                return 0;
            await error.WriteLineAsync($"{path}: {(int)response.StatusCode}");
            return 1;
        }
        catch (Exception failure)
        {
            await error.WriteLineAsync($"{path}: {failure.Message}");
            return 1;
        }
    }

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
        TextWriter error,
        bool agentsOnly = false
    )
    {
        string? dataRoot = null;
        string? agentsDirectory = null;
        string? report = null;
        var deployment = bootstrap.DeploymentConfigPath;
        var tenant = agentsOnly ? null : bootstrap.Tenant;
        var abandon = false;
        var journal = false;
        var dryRun = false;
        for (var index = 0; index < options.Length; index++)
            switch (options[index])
            {
                case "--agents-dir" when !agentsOnly && index + 1 < options.Length:
                    agentsDirectory = options[++index];
                    break;
                case "--data-root" when !agentsOnly && index + 1 < options.Length:
                case "--from" when agentsOnly && index + 1 < options.Length:
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
                case "--abandon" when agentsOnly:
                    abandon = true;
                    break;
                case "--journal" when !agentsOnly:
                    journal = true;
                    break;
                case "--dry-run" when !agentsOnly:
                    dryRun = true;
                    break;
                default:
                    await error.WriteLineAsync("Unknown hosted import option: " + options[index]);
                    await error.WriteLineAsync(Usage);
                    return UsageError;
            }
        if ((dataRoot is null) != abandon || string.IsNullOrWhiteSpace(tenant))
        {
            await error.WriteLineAsync(Usage);
            return UsageError;
        }
        report ??= agentsOnly ? $"foxwarm-agents-import-{Guid.NewGuid():N}.json" : $"foxwarm-import-{tenant}-{DateTimeOffset.UtcNow:yyyyMMdd'T'HHmmss'Z'}.json";
        // The blobs go where the replicas will read them: the deployment configuration's
        // `blobs` block, or PostgreSQL without one.
        var blobs = deployment is null ? null : DeploymentConfiguration.Load(deployment).Blobs;
        await using var app = new PgDatabase(bootstrap.RequireDatabaseUrl(), "foxwarm-import");
        await using var owner = new PgDatabase(bootstrap.RequireMigrateDatabaseUrl(), "foxwarm-import-owner");
        if (agentsOnly)
            return await Import.HostedAgentImport.RunAsync(app, owner, tenant, dataRoot, abandon, report, blobs, output);
        var (kek, _) = bootstrap.RequireKeks();
        return await Import.HostedImport.RunAsync(
            new Import.HostedImportOptions(dataRoot!, tenant, journal, dryRun, report) { Blobs = blobs, AgentsDirectory = agentsDirectory },
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
        var operatorRole = bootstrap.OperatorRole;
        var tenant = bootstrap.Tenant;
        for (var index = 0; index < options.Length; index++)
            switch (options[index])
            {
                case "--app-role" when index + 1 < options.Length:
                    appRole = options[++index];
                    break;
                case "--operator-role" when index + 1 < options.Length:
                    operatorRole = options[++index];
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
        var applied = await SchemaMigrator.MigrateAsync(database, appRole, operatorRole, tenant);
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
