using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed class ArchiveIdentityCommittedException(Exception inner)
    : IOException("Archive identity committed, but its final durability step failed.", inner);

internal sealed partial class CommittedArchiveIdentity
{
    private Dictionary<string, string> ReadCommittedMappings()
    {
        var mappings = ReadLedger(out _);
        if (File.Exists(DatabasePath))
        {
            using var db = Open(DatabasePath, SqliteOpenMode.ReadOnly);
            if (SqliteArchiveMessageStore.HasReservationTable(db))
            {
                using var command = db.CreateCommand();
                command.CommandText =
                    "SELECT session_id,canonical_session_id FROM archive_session_id_reservations";
                using var rows = command.ExecuteReader();
                while (rows.Read())
                {
                    var id = rows.GetString(0);
                    var target = rows.GetString(1);
                    if (mappings.TryGetValue(id, out var prior) && prior != target)
                        throw new InvalidDataException("Committed identity authorities conflict.");
                    mappings[id] = target;
                }
            }
        }
        ValidateGraph(mappings);
        return mappings;
    }

    internal void ValidateRename(string oldId, string newId)
    {
        var graph = ReadCommittedMappings();
        if (graph.TryGetValue(oldId, out var prior) && prior != newId)
            throw new InvalidDataException(
                "Source identity already has a different committed reservation."
            );
        graph[oldId] = newId;
        ValidateGraph(graph);
    }

    internal async Task CommitRenameAsync(string oldId, string newId)
    {
        await initialization.WaitAsync();
        try
        {
            var graph = ReadCommittedMappings();
            if (graph.TryGetValue(oldId, out var prior))
            {
                if (prior != newId)
                    throw new InvalidDataException(
                        "Source identity already has a different committed reservation."
                    );
                Mirror(new Dictionary<string, string>(StringComparer.Ordinal) { [oldId] = newId });
                WriteLedger(graph);
                reserved = graph.Keys.Concat(graph.Values).ToHashSet(StringComparer.Ordinal);
                return;
            }
            graph.Add(oldId, newId);
            ValidateGraph(graph);
            var renamed = false;
            Mirror(new Dictionary<string, string>(StringComparer.Ordinal) { [oldId] = newId });
            try
            {
                WriteLedger(graph, () => renamed = true);
            }
            catch (Exception error)
            {
                if (renamed)
                {
                    reserved = graph.Keys.Concat(graph.Values).ToHashSet(StringComparer.Ordinal);
                    throw new ArchiveIdentityCommittedException(error);
                }
                var receipt = await SqliteArchiveMessageStore.EnqueueWriteAsync(DatabasePath, (db, transaction) =>
                {
                using var command = db.CreateCommand();
                command.Transaction = transaction;
                command.CommandText =
                    "DELETE FROM archive_session_id_reservations WHERE session_id=$id AND canonical_session_id=$new";
                command.Parameters.AddWithValue("$id", oldId);
                command.Parameters.AddWithValue("$new", newId);
                command.ExecuteNonQuery();
                return true;
                }).ConfigureAwait(false);
                await receipt.Completion.ConfigureAwait(false);
                throw;
            }
            reserved = graph.Keys.Concat(graph.Values).ToHashSet(StringComparer.Ordinal);
        }
        finally
        {
            initialization.Release();
        }
    }
}
