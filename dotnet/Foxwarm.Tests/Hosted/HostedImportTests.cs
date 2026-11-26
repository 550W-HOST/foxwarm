using System.Text.Json.Nodes;
using Foxwarm.Hosted.Import;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Storage;
using Xunit;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// <c>foxwarm hosted import</c> end to end on a fresh database per test: a synthetic file
/// installation that fills every imported store (<see cref="ImportFixture"/>), every refusal,
/// dry run, fencing, C4, and an optional copy of a real installation.
/// </summary>
[Trait("Backend", "postgres")]
public sealed partial class HostedImportTests(ITestOutputHelper output)
{
    internal const string GoldenVariable = "FOXWARM_IMPORT_GOLDEN";

    internal sealed record Imported(int Exit, JsonObject Report, string ReportPath, string Stdout);

    internal static async Task<Imported> RunAsync(
        HostedTestDatabase database,
        string dataRoot,
        string tenant,
        string reportDirectory,
        Func<HostedImportOptions, HostedImportOptions>? configure = null,
        bool journal = true,
        bool dryRun = false,
        KeyEncryptionKey? kek = null
    )
    {
        var report = Path.Combine(reportDirectory, $"import-{tenant}-{Guid.NewGuid():N}.json");
        var options = new HostedImportOptions(dataRoot, tenant, journal, dryRun, report)
        {
            WorkParent = reportDirectory,
        };
        options = configure?.Invoke(options) ?? options;
        var stdout = new StringWriter();
        var exit = await HostedImport.RunAsync(
            options,
            new ImportDatabases(database.OpenApp(), database.OpenOwner(), kek ?? HostedTestBackend.Kek),
            stdout
        );
        var parsed = (JsonObject)JsonNode.Parse(await File.ReadAllTextAsync(report))!;
        return new Imported(exit, parsed, report, stdout.ToString());
    }

    [Fact]
    public async Task A_copy_of_a_real_installation_imports_with_a_clean_report()
    {
        var golden = Environment.GetEnvironmentVariable(GoldenVariable);
        if (string.IsNullOrEmpty(golden))
            return;
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var reports = Environment.GetEnvironmentVariable("FOXWARM_IMPORT_REPORT_DIR") ?? Path.GetTempPath();
        Directory.CreateDirectory(reports);
        var before = ImportFixture.TreeHashes(golden);
        var result = await RunAsync(
            database,
            golden,
            "golden",
            reports,
            options => options with { GenerateMissingSecretsKeyForTests = true }
        );
        output.WriteLine(result.Stdout);
        output.WriteLine("report: " + result.ReportPath);
        Assert.Equal(before, ImportFixture.TreeHashes(golden));
        Assert.Equal("imported", result.Report["outcome"]!.GetValue<string>());
        Assert.Equal(0, result.Exit);
        Assert.Empty(result.Report["verificationFailures"]!.AsArray());
    }
}
