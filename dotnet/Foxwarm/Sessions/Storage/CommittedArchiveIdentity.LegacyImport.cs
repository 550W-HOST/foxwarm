using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class CommittedArchiveIdentity
{
    // The legacy bootstrap has no Session engine/catalog authority. Its aliases
    // come from the same persisted metadata snapshot as the Source importer.
    internal Dictionary<string, string> ReadLegacyMappings(SqliteConnection connection)
    {
        var mappings = ReadLedger(out var rewrite);
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT session_id,canonical_session_id FROM archive_session_id_reservations";
        using (var rows = command.ExecuteReader())
            while (rows.Read())
            {
                var id = rows.GetString(0);
                var canonical = rows.GetString(1);
                if (mappings.TryGetValue(id, out var existing) && existing != canonical)
                    throw new InvalidDataException("Archive identity ledger and SQLite have conflicting committed mappings.");
                if (mappings.TryAdd(id, canonical)) rewrite = true;
            }
        ValidateGraph(mappings);
        if (rewrite) WriteLedger(mappings);
        foreach (var (id, canonical) in mappings)
            UpsertLegacyMapping(connection, id, canonical);
        return mappings;
    }

    internal void AddLegacyMapping(SqliteConnection connection, Dictionary<string, string> mappings, string id, string canonical)
    {
        if (mappings.TryGetValue(id, out var previous))
        {
            if (previous != canonical && Resolve(mappings, id) != canonical)
                throw new InvalidDataException("Conflicting legacy Session alias: " + id);
            UpsertLegacyMapping(connection, id, previous);
            return;
        }
        mappings.Add(id, canonical);
        try
        {
            ValidateGraph(mappings);
            UpsertLegacyMapping(connection, id, canonical);
            WriteLedger(mappings);
        }
        catch
        {
            mappings.Remove(id);
            using var remove = connection.CreateCommand();
            remove.CommandText = "DELETE FROM archive_session_id_reservations WHERE session_id=$id";
            remove.Parameters.AddWithValue("$id", id);
            remove.ExecuteNonQuery();
            throw;
        }
    }

    private static void UpsertLegacyMapping(SqliteConnection connection, string id, string canonical)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO archive_session_id_reservations(session_id,canonical_session_id,created_at,updated_at) VALUES($id,$canonical,$at,$at) ON CONFLICT(session_id) DO UPDATE SET canonical_session_id=excluded.canonical_session_id,updated_at=excluded.updated_at";
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$canonical", canonical);
        command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        command.ExecuteNonQuery();
    }
}
