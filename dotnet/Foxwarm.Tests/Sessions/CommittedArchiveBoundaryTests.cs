using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class CommittedArchiveBoundaryTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static void Sql(string database, string text)
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = database,
                Mode = SqliteOpenMode.ReadWrite,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = text;
        command.ExecuteNonQuery();
    }

    [Fact]
    public async Task Fresh_and_noncompleted_predecessor_evidence_gets_authority_only_after_current_startup_migration()
    {
        foreach (var status in new[] { "absent", "completed_with_failures" })
        {
            using var temp = new TempDirectory();
            var data = Path.Combine(temp.Path, "data");
            var work = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(work);
            Directory.CreateDirectory(Path.Combine(data, "state"));
            if (status != "absent")
                await File.WriteAllTextAsync(
                    Path.Combine(data, "state", "migrationVersion.json"),
                    new JsonObject
                    {
                        ["v"] = 1,
                        ["migrations"] = new JsonObject
                        {
                            ["sqlite-only-large-archives-v1"] = new JsonObject
                            {
                                ["status"] = status,
                            },
                        },
                    }.ToJsonString()
                );
            await using var manager = new SessionManager(
                data,
                work,
                Options,
                HostModels.ForTest(Options)
            );
            Assert.False(
                await manager.Journal.File().HasSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId)
            );
            await manager.LoadMainHostAsync();
            await manager.CreateNamedAsync("main", "main", null, null);
            Assert.Equal("main", Assert.Single(manager.Owners()).Id);
            Assert.True(
                await manager.Journal.File().HasSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId)
            );
            var version = JsonNode.Parse(
                await File.ReadAllTextAsync(Path.Combine(data, "state/migrationVersion.json"))
            )!;
            Assert.Equal(
                "completed",
                version["migrations"]![LlmRequestJournalStore.MigrationId]![
                    "status"
                ]!.GetValue<string>()
            );
        }
    }
}
