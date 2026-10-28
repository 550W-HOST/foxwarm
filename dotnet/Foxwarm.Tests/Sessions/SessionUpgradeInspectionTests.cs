using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionUpgradeInspectionTests
{
    internal static async Task SourceFixture(string root, string state = "inactive")
    {
        var repository = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Owned Source checkout is required.");
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            ArgumentList = { Path.Combine(repository, "dotnet/Foxwarm.Tests/Fixtures/session-upgrade-fixture-ts.mjs"), root, state },
        };
        using var child = Process.Start(start)!;
        var stdout = child.StandardOutput.ReadToEndAsync();
        var stderr = child.StandardError.ReadToEndAsync();
        await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(child.ExitCode == 0, await stdout + await stderr);
    }

    private static string WorkerRows(string root)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(root, "state", "session-runtime.sqlite"), Mode = SqliteOpenMode.ReadOnly, Pooling = false,
        }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        var rows = new List<string>();
        foreach (var table in new[] { "session_worker_ownership", "session_worker_mailbox" })
        {
            command.CommandText = "SELECT * FROM " + table + " ORDER BY 1";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                rows.Add(System.Text.Json.JsonSerializer.Serialize(Enumerable.Range(0, reader.FieldCount).Select(reader.GetValue)));
        }
        return string.Join('\n', rows);
    }

    [Theory]
    [InlineData("inactive", true)]
    [InlineData("candidate", false)]
    public async Task Source_handback_cursor_and_retained_mailbox_are_inspected_without_replay_or_migration(string state, bool selectable)
    {
        using var temp = new TempDirectory();
        await SourceFixture(temp.Path, state);
        var path = Path.Combine(temp.Path, "state", "sessions", "retained.json");
        var authority = await File.ReadAllTextAsync(path);
        var workerRows = WorkerRows(temp.Path);
        using var catalog = new SessionCatalog(temp.Path);
        var before = catalog.ReadForInspection().Select(row => row.Main.ToJsonString()).ToArray();
        var report = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(temp.Path));
        Assert.Equal(selectable, report.CanSelect);
        Assert.Equal(1, report.Sessions);
        Assert.Equal(1, report.HistoricalCursors);
        var pending = Assert.Single(report.Issues, issue => issue.Category == "retained mailbox");
        Assert.False(pending.Blocking);
        Assert.Contains("kind=enqueue", pending.Detail);
        Assert.Contains("createdAt=", pending.Detail);
        Assert.DoesNotContain("Synthetic retained input", pending.Detail);
        Assert.Equal(state == "candidate" ? 1 : 0, report.Issues.Count(issue => issue.Category == "active Worker"));
        Assert.Equal(authority, await File.ReadAllTextAsync(path));
        Assert.Equal(workerRows, WorkerRows(temp.Path));
        Assert.Equal(before, catalog.ReadForInspection().Select(row => row.Main.ToJsonString()));
        Assert.False(File.Exists(Path.Combine(temp.Path, "state", "archive-store.sqlite")));
        Assert.False(File.Exists(Path.Combine(temp.Path, "state", "migrationVersion.json")));
        Assert.False(Directory.Exists(Path.Combine(temp.Path, "agents")));
        if (selectable)
        {
            var store = new PersistentSessionAuthorityStore(temp.Path, "retained");
            var snapshot = await store.LoadAsync("retained");
            await store.CommitAsync(snapshot!, SaveKind.Strict);
            Assert.Equal(1, JsonNode.Parse(await File.ReadAllTextAsync(path))!["lastAppliedMailboxId"]!.GetValue<int>());
            Assert.Equal(workerRows, WorkerRows(temp.Path));
        }
    }

    [Fact]
    public void Fresh_inspection_does_not_initialize_any_state()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "not-created");
        var report = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(root));
        Assert.True(report.CanSelect);
        Assert.Empty(report.Issues);
        Assert.False(Directory.Exists(root));
    }

    [Fact]
    public async Task Inspection_checks_all_cold_and_required_members_and_does_not_externalize_images()
    {
        using var temp = new TempDirectory();
        foreach (var id in new[] { "healthy", "cold", "required", "missing", "identity" })
            await SessionUpgradeCompatibilityTests.Seed(temp.Path, id, id == "required");
        var authorities = new Dictionary<string, string>();
        foreach (var id in new[] { "healthy", "cold", "required", "identity" })
        {
            var path = Path.Combine(temp.Path, "state", "sessions", id + ".json");
            var raw = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            if (id is "cold" or "required") raw["lastAppliedMailboxId"] = -1;
            if (id == "identity") raw["id"] = "foreign";
            if (id == "healthy")
            {
                raw["history"]!.AsArray().Add(new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["inlineData"] = new JsonObject { ["mimeType"] = "image/png", ["data"] = "c3ludGhldGlj" } }),
                    ["__meta"] = new JsonObject { ["seq"] = 1, ["timestamp"] = 1000 },
                });
                raw["meta"]!["messageCount"] = 1;
                raw["nextMessageSeq"] = 2;
            }
            authorities[id] = raw.ToJsonString();
            await File.WriteAllTextAsync(path, authorities[id]);
        }
        File.Delete(Path.Combine(temp.Path, "state", "sessions", "missing.json"));
        var report = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(temp.Path));
        Assert.Equal(5, report.Sessions);
        Assert.Equal(3, report.Issues.Count(issue => !issue.Blocking));
        Assert.Single(report.Issues, issue => issue.Blocking && issue.Category == "Session identity");
        foreach (var (id, original) in authorities)
            Assert.Equal(original, await File.ReadAllTextAsync(Path.Combine(temp.Path, "state", "sessions", id + ".json")));
        Assert.False(Directory.Exists(Path.Combine(temp.Path, "state", "images")));
        Assert.False(File.Exists(Path.Combine(temp.Path, "state", "migrationVersion.json")));
    }

    [Fact]
    public async Task Legacy_catalog_inspection_preserves_candidates_and_authorities()
    {
        using var temp = new TempDirectory();
        await SessionCatalogMigrationTests.Authority(temp.Path, "healthy");
        await SessionCatalogMigrationTests.Authority(temp.Path, "bad");
        var bad = Path.Combine(temp.Path, "state", "sessions", "bad.json");
        await File.WriteAllTextAsync(bad, "{malformed-secret-value");
        var catalog = Path.Combine(temp.Path, "state", "sessions.json");
        var selected = new JsonObject { ["sessions"] = new JsonObject
        {
            ["healthy"] = SessionCatalogTests.Row("healthy", 0),
            ["bad"] = SessionCatalogTests.Row("bad", 0),
        }}.ToJsonString();
        await File.WriteAllTextAsync(catalog, selected);
        var report = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(temp.Path));
        Assert.True(report.CanSelect);
        Assert.Equal(2, report.Sessions);
        Assert.Single(report.Issues);
        Assert.Equal(selected, await File.ReadAllTextAsync(catalog));
        Assert.False(File.Exists(Path.Combine(temp.Path, "state", "catalog.sqlite")));
        Assert.DoesNotContain("secret-value", report.Issues[0].Detail);
    }
}
