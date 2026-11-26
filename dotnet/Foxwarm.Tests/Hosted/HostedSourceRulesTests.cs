using System.Text.RegularExpressions;
using Xunit;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Keeps raw PostgreSQL access inside the transaction helper. Store code reaches the database
/// only through <c>TenantDb</c>, whose write transactions carry the lease epoch; the schema's
/// fence trigger is the guarantee, and this cheap scan keeps the helper the only path.
/// </summary>
public sealed partial class HostedSourceRulesTests
{
    // Files allowed to hold connections and transactions themselves.
    private static readonly string[] ConnectionOwners =
    [
        "Hosted/Postgres/PgDatabase.cs",
        "Hosted/Postgres/TenantDb.cs",
        "Hosted/Schema/SchemaMigrator.cs",
        "Hosted/Lease/TenantLease.cs",
        "Hosted/Lease/ReplicaRegistry.cs",
    ];

    [GeneratedRegex(
        @"\b(NpgsqlDataSource|NpgsqlSlimDataSourceBuilder|NpgsqlDataSourceBuilder|NpgsqlConnection|NpgsqlTransaction|BeginTransaction(?:Async)?|OpenConnection(?:Async)?)\b"
    )]
    private static partial Regex RawAccess();

    [GeneratedRegex(@"\bNpgsql\b")]
    private static partial Regex NpgsqlUse();

    [Fact]
    public void OnlyTheHelperOpensConnectionsAndTransactions()
    {
        var root = Path.Combine(
            Environment.GetEnvironmentVariable("FOXWARM_REPO_ROOT")
                ?? throw new InvalidOperationException("FOXWARM_REPO_ROOT is required."),
            "dotnet",
            "Foxwarm"
        );
        var violations = new List<string>();
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (relative.StartsWith("bin/", StringComparison.Ordinal) || relative.StartsWith("obj/", StringComparison.Ordinal))
                continue;
            var text = File.ReadAllText(file);
            if (!NpgsqlUse().IsMatch(text))
                continue;
            if (!relative.StartsWith("Hosted/", StringComparison.Ordinal))
            {
                violations.Add($"{relative}: Npgsql is used outside Hosted/");
                continue;
            }
            if (ConnectionOwners.Contains(relative))
                continue;
            foreach (Match match in RawAccess().Matches(text))
                violations.Add($"{relative}: {match.Value}");
        }
        Assert.Empty(violations);
    }
}
