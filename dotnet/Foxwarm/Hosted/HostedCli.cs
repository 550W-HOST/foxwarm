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

    internal static async Task<int> RunAsync(string[] args, TextWriter output, TextWriter error)
    {
        try
        {
            var bootstrap = HostedBootstrap.FromEnvironment();
            switch (args)
            {
                case ["db", "migrate", .. var options]:
                    return await MigrateAsync(bootstrap, options, output);
                case ["db", "status"]:
                    return await StatusAsync(bootstrap, output);
                default:
                    await error.WriteLineAsync(
                        "Usage: foxwarm db migrate [--app-role <role>] [--tenant <name>] | foxwarm db status"
                    );
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
        if (status.Refusal() is { } refusal)
        {
            await output.WriteLineAsync("Replicas of this build would refuse to start: " + refusal);
            return ConfigurationError;
        }
        await output.WriteLineAsync("Replicas of this build can run against this schema.");
        return 0;
    }
}
