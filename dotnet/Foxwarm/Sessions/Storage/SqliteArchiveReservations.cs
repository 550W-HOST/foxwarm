using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

public sealed partial class SqliteArchiveMessageStore
{
    internal static bool HasReservationTable(SqliteConnection connection)
    {
        if (!TableExists(connection, "archive_session_id_reservations")) return false;
        using var command = connection.CreateCommand(); command.CommandText = "PRAGMA table_info(archive_session_id_reservations)";
        using var reader = command.ExecuteReader(); var actual = new List<(string, string, bool, string?, long)>();
        while (reader.Read()) actual.Add((reader.GetString(1), reader.GetString(2), reader.GetInt64(3) == 1, reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetInt64(5)));
        var expected = new[] { ("session_id", "TEXT", false, (string?)null, 1L), ("canonical_session_id", "TEXT", true, (string?)null, 0L),
            ("created_at", "INTEGER", true, (string?)null, 0L), ("updated_at", "INTEGER", true, (string?)null, 0L) };
        if (!actual.SequenceEqual(expected)) throw new InvalidDataException("Archive reservation schema does not match the source schema.");
        return true;
    }
    private static void ValidateLookupReservation(SqliteConnection connection, string id)
    {
        if (!HasReservationTable(connection)) return;
        using var command = connection.CreateCommand(); command.CommandText = "SELECT session_id,canonical_session_id,created_at,updated_at FROM archive_session_id_reservations WHERE session_id=$id";
        command.Parameters.AddWithValue("$id", id); using var reader = command.ExecuteReader();
        if (!reader.Read()) return;
        if (!SessionIdentity.IsValid(reader.GetString(0)) || !SessionIdentity.IsValid(reader.GetString(1)) || !double.IsFinite(reader.GetDouble(2)) || !double.IsFinite(reader.GetDouble(3)))
            throw new InvalidDataException("Archive reservation row is invalid.");
        if (reader.GetString(0) != reader.GetString(1)) throw new UnsupportedSessionAuthorityException("Archive canonical redirects are not supported.");
    }
}
