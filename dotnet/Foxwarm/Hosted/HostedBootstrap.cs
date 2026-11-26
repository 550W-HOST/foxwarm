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
    string? ScratchRoot = null,
    string? DeploymentConfigPath = null,
    string? KekFile = null,
    string? KekPreviousFile = null,
    string? AgentsRoot = null
)
{
    internal const string DefaultTenant = "default";
    internal const string DefaultAppRole = "foxwarm_app";

    /// <summary>The replica's ephemeral local directory; never tenant state.</summary>
    internal string RequireScratchRoot() =>
        System.IO.Path.GetFullPath(
            ScratchRoot ?? System.IO.Path.Combine(System.IO.Path.GetTempPath(), "foxwarm-replica")
        );

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
        var replica = Read(environment, "FOXWARM_REPLICA_ID");
        return new(
            Secret(environment, "FOXWARM_DATABASE_URL"),
            Secret(environment, "FOXWARM_MIGRATE_DATABASE_URL"),
            Name(environment, "FOXWARM_TENANT", DefaultTenant),
            Name(environment, "FOXWARM_APP_ROLE", DefaultAppRole),
            string.IsNullOrEmpty(replica) ? null : Name(environment, "FOXWARM_REPLICA_ID", ""),
            string.IsNullOrEmpty(advertise) ? null : advertise,
            Path(environment, "FOXWARM_SCRATCH_DIR"),
            Path(environment, DeploymentConfiguration.Variable),
            Path(environment, "FOXWARM_KEK_FILE"),
            Path(environment, "FOXWARM_KEK_PREVIOUS_FILE"),
            Path(environment, "FOXWARM_AGENTS_DIR")
        );
    }

    /// <summary>The deployment configuration, read from <c>FOXWARM_DEPLOYMENT_CONFIG</c>.</summary>
    internal DeploymentConfiguration RequireDeployment() =>
        DeploymentConfiguration.Load(
            DeploymentConfigPath
                ?? throw new HostedBootstrapException(
                    $"Hosted mode needs {DeploymentConfiguration.Variable}, the path of the deployment configuration."
                )
        );

    /// <summary>The shared Agent folders (<c>FOXWARM_AGENTS_DIR</c>); required by an owner.</summary>
    internal string RequireAgentsRoot() =>
        System.IO.Path.GetFullPath(
            AgentsRoot
                ?? throw new HostedBootstrapException(
                    "Hosted mode needs FOXWARM_AGENTS_DIR, the shared volume of Agent folders."
                )
        );

    /// <summary>The current and previous key-encryption keys; the current one is required.</summary>
    internal (Postgres.KeyEncryptionKey Current, Postgres.KeyEncryptionKey? Previous) RequireKeks() =>
        (
            Kek(KekFile ?? throw new HostedBootstrapException(
                "Hosted mode needs FOXWARM_KEK_FILE, the key-encryption key file."
            ), "FOXWARM_KEK_FILE"),
            KekPreviousFile is null ? null : Kek(KekPreviousFile, "FOXWARM_KEK_PREVIOUS_FILE")
        );

    private static Postgres.KeyEncryptionKey Kek(string path, string variable)
    {
        try
        {
            return Postgres.KeyEncryptionKey.Load(path);
        }
        catch (Exception error)
            when (error is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            throw new HostedBootstrapException($"{variable} can't be used: {error.Message}");
        }
    }

    private static string? Path(IDictionary environment, string variable) =>
        Read(environment, variable) is { Length: > 0 } value ? value : null;

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
