using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

public sealed partial class SqliteArchiveMessageStore
{
    internal static void InitializeReservations(
        SqliteConnection connection,
        SqliteTransaction? transaction = null
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS archive_session_id_reservations (
              session_id TEXT PRIMARY KEY,
              canonical_session_id TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_archive_session_id_reservations_canonical
              ON archive_session_id_reservations(canonical_session_id);
            """;
        command.ExecuteNonQuery();
        if (transaction is null)
            _ = HasReservationTable(connection);
    }

    internal static bool HasReservationTable(SqliteConnection connection)
    {
        if (!TableExists(connection, "archive_session_id_reservations"))
            return false;
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA table_info(archive_session_id_reservations)";
        using var reader = command.ExecuteReader();
        var actual = new List<(string, string, bool, string?, long)>();
        while (reader.Read())
            actual.Add(
                (
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetInt64(3) == 1,
                    reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.GetInt64(5)
                )
            );
        var expected = new[]
        {
            ("session_id", "TEXT", false, (string?)null, 1L),
            ("canonical_session_id", "TEXT", true, (string?)null, 0L),
            ("created_at", "INTEGER", true, (string?)null, 0L),
            ("updated_at", "INTEGER", true, (string?)null, 0L),
        };
        if (!actual.SequenceEqual(expected))
            throw new InvalidDataException(
                "Archive reservation schema does not match the source schema."
            );
        return true;
    }

    internal static string ResolveReadOnly(SqliteConnection connection, string id)
    {
        if (!HasReservationTable(connection))
            return id;
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT canonical_session_id FROM archive_session_id_reservations WHERE session_id=$id";
        command.Parameters.Add("$id", SqliteType.Text);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (seen.Add(id))
        {
            command.Parameters["$id"].Value = id;
            var value = command.ExecuteScalar();
            if (value is null)
                return id;
            if (value is not string next)
                throw new InvalidDataException(
                    "Archive committed identity must be an exact nonempty string."
                );
            CommittedArchiveIdentity.ValidateIdentity(next);
            if (next == id)
                return id;
            id = next;
        }
        throw new InvalidDataException("Archive committed identity mappings contain a cycle.");
    }

    private static void RequireWriteIdentity(SqliteConnection connection, string id)
    {
        if (ResolveReadOnly(connection, id) != id)
            throw new InvalidOperationException(
                "Historical Archive aliases are not writable Session bindings."
            );
    }

    private string CanonicalReadIdentity()
    {
        if (!File.Exists(databasePath))
            return sessionId;
        using var connection = OpenExistingReadOnly();
        return ResolveReadOnly(connection, sessionId);
    }
}
