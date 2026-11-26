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
    string AppRole
)
{
    internal const string ModeVariable = "FOXWARM_MODE";
    internal const string DefaultTenant = "default";
    internal const string DefaultAppRole = "foxwarm_app";

    /// <summary>Whether the process environment selects hosted mode.</summary>
    internal static bool Selected(IDictionary? environment = null)
    {
        var mode = Read(environment ?? Environment.GetEnvironmentVariables(), ModeVariable);
        return mode switch
        {
            null or "" or "file" => false,
            "hosted" => true,
            _ => throw new HostedBootstrapException(
                $"{ModeVariable} must be `file` or `hosted`, not `{mode}`."
            ),
        };
    }

    internal static HostedBootstrap FromEnvironment(IDictionary? environment = null)
    {
        environment ??= Environment.GetEnvironmentVariables();
        return new(
            Secret(environment, "FOXWARM_DATABASE_URL"),
            Secret(environment, "FOXWARM_MIGRATE_DATABASE_URL"),
            Name(environment, "FOXWARM_TENANT", DefaultTenant),
            Name(environment, "FOXWARM_APP_ROLE", DefaultAppRole)
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
