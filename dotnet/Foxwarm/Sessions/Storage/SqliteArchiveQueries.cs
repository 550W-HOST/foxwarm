using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record ArchiveStats(long Count, long? First, long? Last);
internal sealed record ArchiveBlockTopology(long Id, int Level, string Kind, long First, long Last,
    long[] Children, long RawFirst, long RawLast, double? StartTime, string? SourceSessionId = null);

public sealed partial class SqliteArchiveMessageStore
{
    internal ArchiveStats MessageStats(long first = 1, long last = 9007199254740991)
    {
        if (!File.Exists(databasePath)) return new(0, null, null);
        using var connection = OpenExistingReadOnly(); var canonical = ResolveReadOnly(connection, sessionId); using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*),MIN(seq),MAX(seq) FROM archive_messages WHERE session_id=$s AND seq BETWEEN $first AND $last";
        command.Parameters.AddWithValue("$s", canonical); command.Parameters.AddWithValue("$first", first); command.Parameters.AddWithValue("$last", last);
        using var reader = command.ExecuteReader(); reader.Read();
        return new(reader.GetInt64(0), reader.IsDBNull(1) ? null : reader.GetInt64(1), reader.IsDBNull(2) ? null : reader.GetInt64(2));
    }
    internal IReadOnlyList<ArchiveBlockTopology> BlockTopology()
    {
        if (!File.Exists(databasePath)) return [];
        using var connection = OpenExistingReadOnly(); var canonical = ResolveReadOnly(connection, sessionId); using var command = connection.CreateCommand();
        command.CommandText = "SELECT id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,raw_start_timestamp FROM archive_blocks WHERE session_id=$s ORDER BY raw_start_seq,raw_end_seq,COALESCE(raw_start_timestamp,0),id";
        command.Parameters.AddWithValue("$s", canonical); using var reader = command.ExecuteReader();
        var result = new List<ArchiveBlockTopology>();
        while (reader.Read()) result.Add(new(reader.GetInt64(0), reader.GetInt32(1), reader.GetString(2), reader.GetInt64(3), reader.GetInt64(4),
            reader.IsDBNull(5) ? [] : (JsonNode.Parse(reader.GetString(5)) as JsonArray)?.Select(value => value!.GetValue<long>()).ToArray() ?? [],
            reader.GetInt64(6), reader.GetInt64(7), reader.IsDBNull(8) ? null : reader.GetDouble(8)));
        return result;
    }
}
