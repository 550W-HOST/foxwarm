using System.Collections;
using System.Text;

namespace Foxwarm.Hosted;

/// <summary>A hosted bootstrap setting is missing or invalid.</summary>
internal sealed class HostedBootstrapException(string message) : Exception(message);

/// <summary>
/// Process settings of hosted mode, read before any store opens. Values come from environment
/// variables; for secrets, <c>NAME_FILE</c> names a file (a mounted secret) holding the value.
/// A variable and its <c>_FILE</c> form together are an error.
/// </summary>
internal sealed record HostedBootstrap(
    string? DatabaseUrl,
    string? MigrateDatabaseUrl,
    string Tenant,
    string AppRole,
    string? ReplicaName = null,
    string? AdvertiseAddress = null,
    int HealthPort = HostedBootstrap.DefaultHealthPort,
    string? ScratchRoot = null
)
{
    internal const string DefaultTenant = "default";
    internal const string DefaultAppRole = "foxwarm_app";
    internal const int DefaultHealthPort = 3081;

    /// <summary>The replica's ephemeral local directory; never tenant state.</summary>
    internal string RequireScratchRoot() =>
        Path.GetFullPath(ScratchRoot ?? Path.Combine(Path.GetTempPath(), "foxwarm-replica"));

    internal static HostedBootstrap FromEnvironment(IDictionary? environment = null)
    {
        environment ??= Environment.GetEnvironmentVariables();
        var advertise = Read(environment, "FOXWARM_ADVERTISE_ADDRESS");
        if (!string.IsNullOrEmpty(advertise))
            try
            {
                StandbyForwarder.ParseAddress(advertise);
            }
            catch (FormatException error)
            {
                throw new HostedBootstrapException("FOXWARM_ADVERTISE_ADDRESS: " + error.Message);
            }
        var healthPort = Read(environment, "FOXWARM_HEALTH_PORT") is { Length: > 0 } port
            ? int.TryParse(port, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var number)
                && number is >= 1 and <= 65535
                ? number
                : throw new HostedBootstrapException("FOXWARM_HEALTH_PORT must be a port number.")
            : DefaultHealthPort;
        var replica = Read(environment, "FOXWARM_REPLICA_ID");
        return new(
            Secret(environment, "FOXWARM_DATABASE_URL"),
            Secret(environment, "FOXWARM_MIGRATE_DATABASE_URL"),
            Name(environment, "FOXWARM_TENANT", DefaultTenant),
            Name(environment, "FOXWARM_APP_ROLE", DefaultAppRole),
            string.IsNullOrEmpty(replica) ? null : Name(environment, "FOXWARM_REPLICA_ID", ""),
            string.IsNullOrEmpty(advertise) ? null : advertise,
            healthPort,
            Read(environment, "FOXWARM_SCRATCH_DIR") is { Length: > 0 } scratch ? scratch : null
        );
    }

    /// <summary>The runtime database URL; required by replicas.</summary>
    internal string RequireDatabaseUrl() =>
        DatabaseUrl
        ?? throw new HostedBootstrapException(
            "Hosted mode needs FOXWARM_DATABASE_URL or FOXWARM_DATABASE_URL_FILE."
        );

    /// <summary>The schema owner's URL for migrations, falling back to the runtime URL.</summary>
    internal string RequireMigrateDatabaseUrl() =>
        MigrateDatabaseUrl
        ?? DatabaseUrl
        ?? throw new HostedBootstrapException(
            "Migrations need FOXWARM_MIGRATE_DATABASE_URL (or FOXWARM_DATABASE_URL), or their _FILE forms."
        );

    private static string Name(IDictionary environment, string variable, string fallback)
    {
        var value = Read(environment, variable);
        if (string.IsNullOrEmpty(value))
            return fallback;
        foreach (var character in value)
            if (!(char.IsAsciiLetterOrDigit(character) || character is '_' or '-' or '.'))
                throw new HostedBootstrapException(
                    $"{variable} may contain only ASCII letters, digits, '_', '-' and '.'."
                );
        return value;
    }

    private static string? Secret(IDictionary environment, string variable)
    {
        var direct = Read(environment, variable);
        var file = Read(environment, variable + "_FILE");
        if (!string.IsNullOrEmpty(direct) && !string.IsNullOrEmpty(file))
            throw new HostedBootstrapException(
                $"Set either {variable} or {variable}_FILE, not both."
            );
        if (!string.IsNullOrEmpty(direct))
            return direct;
        if (string.IsNullOrEmpty(file))
            return null;
        string text;
        try
        {
            text = File.ReadAllText(file, new UTF8Encoding(false, true));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or DecoderFallbackException)
        {
            throw new HostedBootstrapException(
                $"{variable}_FILE can't be read: {error.Message}"
            );
        }
        text = text.Trim();
        return text.Length == 0
            ? throw new HostedBootstrapException($"{variable}_FILE names an empty file.")
            : text;
    }

    private static string? Read(IDictionary environment, string variable) =>
        environment[variable] as string;
}
