using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class CommittedArchiveIdentity
{
    private const string MigrationId = "sqlite-only-large-archives-v1";
    internal static void ValidateStartupEvidence(string root, bool allowPendingIdentityRecovery = false)
    {
        var state = Path.Combine(root, "state");
        try
        {
            _ = File.GetAttributes(Path.Combine(state, "session-id-move-pending.json"));
            if (!allowPendingIdentityRecovery) throw new UnsupportedSessionAuthorityException("Pending Session identity move recovery is not supported by this host.");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        JsonObject? migration;
        try { migration = JsonNode.Parse(File.ReadAllText(Path.Combine(state, "migrationVersion.json"))) as JsonObject; }
        catch (FileNotFoundException) { return; }
        catch (DirectoryNotFoundException) { return; }
        catch (System.Text.Json.JsonException) { return; } // Source migration-state normalization has no completed evidence here.
        if (migration?["migrations"] is not JsonObject migrations || migrations[MigrationId] is not JsonObject entry
            || SessionCatalog.Text(entry["status"]) != "completed") return;
        foreach (var (file, table) in new[] { ("archive-store.sqlite", "archive_store_metadata"), ("llm-request-journal.sqlite", "llm_journal_metadata") })
        {
            var path = Path.Combine(state, file);
            if (!File.Exists(path)) throw new InvalidDataException("Completed SQLite-only source migration is missing an authoritative database; restore the data backup.");
            using var connection = Open(path, SqliteOpenMode.ReadOnly);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$table";
            command.Parameters.AddWithValue("$table", table);
            if (command.ExecuteScalar() is null) throw new InvalidDataException("Completed SQLite-only source migration is missing an authority marker.");
            command.Parameters.Clear();
            command.CommandText = $"SELECT value FROM {table} WHERE key='sqlite_authority_migration'";
            if (command.ExecuteScalar() as string != MigrationId) throw new InvalidDataException("Completed SQLite-only source migration has no matching authority marker.");
        }
    }
}
