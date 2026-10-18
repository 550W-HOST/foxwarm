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

    [Theory]
    [InlineData("archive-missing")]
    [InlineData("journal-missing")]
    [InlineData("archive-marker")]
    [InlineData("journal-marker")]
    [InlineData("journal-wrong-marker")]
    [InlineData("pending")]
    public async Task Actual_completed_source_migration_evidence_or_pending_move_fails_before_empty_databases_catalog_or_main_are_created(
        string fault
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await CommittedArchiveIdentityTests.SourceFixture("seed", data);
        var state = Path.Combine(data, "state");
        var archive = Path.Combine(state, "archive-store.sqlite");
        var journal = Path.Combine(state, "llm-request-journal.sqlite");
        var file = fault.StartsWith("archive", StringComparison.Ordinal) ? archive : journal;
        if (fault.EndsWith("missing", StringComparison.Ordinal))
            foreach (var suffix in new[] { "", "-wal", "-shm" })
                File.Delete(file + suffix);
        else if (fault == "pending")
            await File.WriteAllTextAsync(
                Path.Combine(state, "session-id-move-pending.json"),
                "Uninterpreted pending direction; A does not recover it."
            );
        else
            Sql(
                file,
                fault.EndsWith("wrong-marker", StringComparison.Ordinal)
                    ? "UPDATE llm_journal_metadata SET value='other-migration' WHERE key='sqlite_authority_migration'"
                    : $"DELETE FROM {(fault.StartsWith("archive", StringComparison.Ordinal) ? "archive_store_metadata" : "llm_journal_metadata")} WHERE key='sqlite_authority_migration'"
            );
        // Force the real no-catalog startup path too: evidence must precede any legacy/fresh catalog publication.
        foreach (var suffix in new[] { "", "-wal", "-shm" })
            File.Delete(Path.Combine(state, "catalog.sqlite") + suffix);
        var ledger = await File.ReadAllBytesAsync(
            Path.Combine(state, "session-id-reservations.jsonl")
        );
        Assert.ThrowsAny<Exception>(() =>
            new SessionManager(data, work, Options, HostModels.ForTest(Options))
        );
        Assert.False(File.Exists(Path.Combine(state, "catalog.sqlite")));
        Assert.False(File.Exists(Path.Combine(state, "sessions", "main.json")));
        Assert.False(Directory.Exists(Path.Combine(work, "memory")));
        Assert.Equal(
            ledger,
            await File.ReadAllBytesAsync(Path.Combine(state, "session-id-reservations.jsonl"))
        );
        if (fault.EndsWith("missing", StringComparison.Ordinal))
            Assert.False(File.Exists(file));
        Assert.False(Directory.Exists(Path.Combine(state, "exec")));
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
            Assert.False(await manager.Journal.HasSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId));
            await manager.LoadMainHostAsync();
            await manager.CreateNamedAsync("main", "main", null, null);
            Assert.Equal("main", Assert.Single(manager.Owners()).Id);
            Assert.True(await manager.Journal.HasSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId));
            var version = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(data, "state/migrationVersion.json")))!;
            Assert.Equal("completed", version["migrations"]![LlmRequestJournalStore.MigrationId]!["status"]!.GetValue<string>());
        }
    }

    [Fact]
    public async Task Historical_alias_reads_never_redirect_writes_and_current_exact_inserts_and_rollback_preserve_previous_rows()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        await CommittedArchiveIdentityTests.SourceFixture("seed", data);
        var database = Path.Combine(data, "state", "archive-store.sqlite");
        var alias = new SqliteArchiveMessageStore(database, "archive_old");
        var message = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "New exact-bound writer." }),
            ["__meta"] = new JsonObject { ["seq"] = 1, ["timestamp"] = 7001 },
        };
        var historical = ArchiveMessageRecord.Create("archive_old", "main", 1, 7001, message);
        Assert.Throws<InvalidOperationException>(alias.Initialize);
        Assert.Throws<InvalidOperationException>(() => alias.WriteMessages([historical]));
        Assert.Throws<InvalidOperationException>(() =>
            alias.RollbackInsertedMessages([historical])
        );
        var current = new SqliteArchiveMessageStore(database, "writer");
        current.Initialize();
        current.EnsureBranch();
        var record = ArchiveMessageRecord.Create("writer", "main", 1, 7001, message);
        var inserted = current.WriteMessages([record]);
        Assert.Single(inserted);
        Assert.Empty(current.WriteMessages([record]));
        var changed = (JsonObject)message.DeepClone();
        changed["parts"] = new JsonArray(
            new JsonObject { ["text"] = "Conflicting immutable audit." }
        );
        Assert.Throws<InvalidDataException>(() =>
            current.WriteMessages([ArchiveMessageRecord.Create("writer", "main", 1, 7001, changed)])
        );
        var original = current.ReadMessages().Single().MessageJson;
        Assert.Throws<InvalidDataException>(() =>
            current.RollbackInsertedMessages([
                ArchiveMessageRecord.Create("writer", "main", 1, 7001, changed),
            ])
        );
        Assert.Equal(original, current.ReadMessages().Single().MessageJson);
        current.RollbackInsertedMessages(inserted);
        Assert.Empty(current.ReadMessages());
        var block = new ArchiveBlockRecord(
            "writer",
            "main",
            1,
            1,
            "message",
            1,
            1,
            null,
            1,
            1,
            7001,
            7001,
            "Owned summary.",
            null,
            7002
        );
        var blocks = current.WriteBlocks([block]);
        Assert.Single(blocks);
        Assert.Empty(current.WriteBlocks([block]));
        Assert.Throws<InvalidOperationException>(() =>
            alias.WriteBlocks([block with { SessionId = "archive_old" }])
        );
        current.RollbackInsertedBlocks(blocks);
        Assert.Empty(current.ReadBlocks());
        Assert.NotEmpty(alias.ReadMessages());
        Assert.NotEmpty(alias.ReadBlocks());
        Assert.DoesNotContain(current.ReadMessages(), row => row.SessionId == "archive_old");
    }

    [Fact]
    public async Task Valid_independent_file_and_sqlite_conflict_or_sqlite_cycle_fail_without_repairing_either_side()
    {
        foreach (var cycle in new[] { false, true })
        {
            using var temp = new TempDirectory();
            var data = Path.Combine(temp.Path, "data");
            await CommittedArchiveIdentityTests.SourceFixture("seed", data);
            var work = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(work);
            var database = Path.Combine(data, "state", "archive-store.sqlite");
            var ledger = Path.Combine(data, "state", "session-id-reservations.jsonl");
            var before = await File.ReadAllBytesAsync(ledger);
            Sql(
                database,
                cycle
                    ? "INSERT INTO archive_session_id_reservations VALUES('cycle-a','cycle-b',1,1),('cycle-b','cycle-a',1,1)"
                    : "UPDATE archive_session_id_reservations SET canonical_session_id='conflicting-other' WHERE session_id='archive_old'"
            );
            await using var manager = new SessionManager(
                data,
                work,
                Options,
                HostModels.ForTest(Options)
            );
            await Assert.ThrowsAsync<InvalidDataException>(manager.LoadMainHostAsync);
            Assert.Empty(manager.Owners());
            Assert.Equal(before, await File.ReadAllBytesAsync(ledger));
            if (cycle)
                Assert.Throws<InvalidDataException>(() =>
                    new SqliteArchiveMessageStore(database, "cycle-a").ReadMessages()
                );
        }
    }
}
