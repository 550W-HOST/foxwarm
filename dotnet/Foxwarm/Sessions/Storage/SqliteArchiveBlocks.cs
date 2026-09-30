using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

public sealed record ArchiveBlockRecord(
    string SessionId, string Agent, long Id, int Level, string SourceKind, long SourceStart,
    long SourceEnd, JsonArray? SourceBlockIds, long RawStartSeq, long RawEndSeq,
    double? RawStartTimestamp, double? RawEndTimestamp, string Summary, JsonArray? MemoryFacts, long CreatedAt)
{
    public static string LocalTimestamp(double stamp)
    {
        var time = DateTimeOffset.FromUnixTimeMilliseconds(checked((long)stamp)).ToLocalTime();
        return time.ToString("yyyy-MM-dd HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture)
            + " " + time.ToString("zzz", System.Globalization.CultureInfo.InvariantCulture).Replace(":", "", StringComparison.Ordinal);
    }

    private string TimeRange()
    {
        if (RawStartTimestamp is null && RawEndTimestamp is null) return "";
        var first = LocalTimestamp(RawStartTimestamp ?? RawEndTimestamp!.Value);
        var last = LocalTimestamp(RawEndTimestamp ?? RawStartTimestamp!.Value);
        return " time " + (first == last ? first : first + " -> " + last);
    }

    public string? SourceBlockIdsJson => SourceBlockIds is { Count: > 0 } ? EcmaJson.Stringify(SourceBlockIds) : null;
    public string? MemoryFactsJson => MemoryFacts is { Count: > 0 } ? EcmaJson.Stringify(MemoryFacts) : null;

    public JsonObject ToContextMeta()
    {
        var result = new JsonObject
        {
            ["id"] = Id, ["level"] = Level, ["sourceKind"] = SourceKind,
            ["sourceStart"] = SourceStart, ["sourceEnd"] = SourceEnd,
            ["rawStartSeq"] = RawStartSeq, ["rawEndSeq"] = RawEndSeq,
            ["createdAt"] = CreatedAt
        };
        if (SourceBlockIds is { Count: > 0 }) result["sourceBlockIds"] = SourceBlockIds.DeepClone();
        if (RawStartTimestamp is not null) result["rawStartTimestamp"] = RawStartTimestamp;
        if (RawEndTimestamp is not null) result["rawEndTimestamp"] = RawEndTimestamp;
        return result;
    }

    public JsonObject ToMessage() => new()
    {
        ["role"] = "model",
        ["parts"] = new JsonArray(new JsonObject
        {
            ["text"] = $"[CTX-BLOCK L{Level} B#{Id} raw#{RawStartSeq}{(RawStartSeq == RawEndSeq ? "" : $"-#{RawEndSeq}")}{TimeRange()}] {Summary}"
        }),
        ["__meta"] = new JsonObject { ["timestamp"] = CreatedAt, ["contextBlock"] = ToContextMeta() }
    };
}

public sealed partial class SqliteArchiveMessageStore
{
    private static void InitializeBlocks(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS archive_blocks (
              session_id TEXT NOT NULL,
              agent TEXT NOT NULL DEFAULT 'main',
              id INTEGER NOT NULL,
              level INTEGER NOT NULL,
              source_kind TEXT NOT NULL,
              source_start INTEGER NOT NULL,
              source_end INTEGER NOT NULL,
              source_block_ids_json TEXT,
              raw_start_seq INTEGER NOT NULL,
              raw_end_seq INTEGER NOT NULL,
              raw_start_timestamp INTEGER,
              raw_end_timestamp INTEGER,
              summary TEXT NOT NULL,
              memory_facts_json TEXT,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (session_id, id)
            )
            """);
        using var schema = connection.CreateCommand();
        schema.CommandText = "PRAGMA table_info(archive_blocks)";
        using var rows = schema.ExecuteReader();
        var actual = new List<(string, string, bool, string?, long)>();
        while (rows.Read()) actual.Add((rows.GetString(1), rows.GetString(2), rows.GetInt64(3) == 1,
            rows.IsDBNull(4) ? null : rows.GetString(4), rows.GetInt64(5)));
        var expected = new[]
        {
            ("session_id", "TEXT", true, (string?)null, 1L),
            ("agent", "TEXT", true, (string?)"'main'", 0L),
            ("id", "INTEGER", true, (string?)null, 2L),
            ("level", "INTEGER", true, (string?)null, 0L),
            ("source_kind", "TEXT", true, (string?)null, 0L),
            ("source_start", "INTEGER", true, (string?)null, 0L),
            ("source_end", "INTEGER", true, (string?)null, 0L),
            ("source_block_ids_json", "TEXT", false, (string?)null, 0L),
            ("raw_start_seq", "INTEGER", true, (string?)null, 0L),
            ("raw_end_seq", "INTEGER", true, (string?)null, 0L),
            ("raw_start_timestamp", "INTEGER", false, (string?)null, 0L),
            ("raw_end_timestamp", "INTEGER", false, (string?)null, 0L),
            ("summary", "TEXT", true, (string?)null, 0L),
            ("memory_facts_json", "TEXT", false, (string?)null, 0L),
            ("created_at", "INTEGER", true, (string?)null, 0L)
        };
        if (!actual.SequenceEqual(expected)) throw new InvalidDataException("archive_blocks does not match the current TypeScript schema.");
    }

    private void ValidateBlock(ArchiveBlockRecord block)
    {
        if (block.SessionId != sessionId || block.Agent.Length == 0 || block.Id <= 0 || block.Level <= 0
            || block.SourceStart <= 0 || block.SourceEnd <= 0 || block.RawStartSeq <= 0 || block.RawEndSeq < block.RawStartSeq
            || block.Summary.Trim().Length == 0 || block.CreatedAt <= 0
            || block.SourceKind is not ("message" or "block")
            || block.SourceKind == "message" && (block.Level != 1 || block.SourceStart != block.RawStartSeq || block.SourceEnd != block.RawEndSeq)
            || block.SourceKind == "block" && (block.Level <= 1 || block.SourceBlockIds is not { Count: > 0 })
            || block.RawStartTimestamp is double start && !double.IsFinite(start)
            || block.RawEndTimestamp is double end && !double.IsFinite(end))
            throw new InvalidDataException("Archive block is outside supported current shape.");
    }

    public IReadOnlyList<ArchiveBlockRecord> WriteBlocks(IReadOnlyList<ArchiveBlockRecord> records)
    {
        if (records.Count == 0) return [];
        foreach (var block in records) ValidateBlock(block);
        using var connection = OpenConfigured();
        using var tx = connection.BeginTransaction(deferred: false);
        var inserted = new List<ArchiveBlockRecord>();
        foreach (var block in records)
        {
            using var lookup = connection.CreateCommand();
            lookup.Transaction = tx;
            lookup.CommandText = "SELECT agent,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,created_at FROM archive_blocks WHERE session_id=$s AND id=$id";
            lookup.Parameters.AddWithValue("$s", block.SessionId);
            lookup.Parameters.AddWithValue("$id", block.Id);
            using (var reader = lookup.ExecuteReader())
            {
                if (reader.Read())
                {
                    if (reader.GetString(0) == block.Agent && reader.GetInt32(1) == block.Level && reader.GetString(2) == block.SourceKind
                        && reader.GetInt64(3) == block.SourceStart && reader.GetInt64(4) == block.SourceEnd
                        && NullableText(reader, 5) == block.SourceBlockIdsJson && reader.GetInt64(6) == block.RawStartSeq
                        && reader.GetInt64(7) == block.RawEndSeq && NullableNumber(reader, 8) == block.RawStartTimestamp
                        && NullableNumber(reader, 9) == block.RawEndTimestamp && reader.GetString(10) == block.Summary
                        && NullableText(reader, 11) == block.MemoryFactsJson && reader.GetInt64(12) == block.CreatedAt) continue;
                    throw new InvalidDataException($"Immutable archive block conflict for {sessionId} B#{block.Id}.");
                }
            }
            using var insert = connection.CreateCommand();
            insert.Transaction = tx;
            insert.CommandText = """
                INSERT INTO archive_blocks(session_id,agent,id,level,source_kind,source_start,source_end,source_block_ids_json,
                  raw_start_seq,raw_end_seq,raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,created_at)
                VALUES($s,$agent,$id,$level,$kind,$first,$last,$ids,$rawFirst,$rawLast,$start,$end,$summary,$facts,$at)
                """;
            insert.Parameters.AddWithValue("$s", block.SessionId);
            insert.Parameters.AddWithValue("$agent", block.Agent);
            insert.Parameters.AddWithValue("$id", block.Id);
            insert.Parameters.AddWithValue("$level", block.Level);
            insert.Parameters.AddWithValue("$kind", block.SourceKind);
            insert.Parameters.AddWithValue("$first", block.SourceStart);
            insert.Parameters.AddWithValue("$last", block.SourceEnd);
            insert.Parameters.AddWithValue("$ids", (object?)block.SourceBlockIdsJson ?? DBNull.Value);
            insert.Parameters.AddWithValue("$rawFirst", block.RawStartSeq);
            insert.Parameters.AddWithValue("$rawLast", block.RawEndSeq);
            insert.Parameters.AddWithValue("$start", (object?)block.RawStartTimestamp ?? DBNull.Value);
            insert.Parameters.AddWithValue("$end", (object?)block.RawEndTimestamp ?? DBNull.Value);
            insert.Parameters.AddWithValue("$summary", block.Summary);
            insert.Parameters.AddWithValue("$facts", (object?)block.MemoryFactsJson ?? DBNull.Value);
            insert.Parameters.AddWithValue("$at", block.CreatedAt);
            if (insert.ExecuteNonQuery() != 1) throw new IOException("Archive block insert did not affect one row.");
            inserted.Add(block);
        }
        tx.Commit();
        return inserted;
    }

    public IReadOnlyList<ArchiveBlockRecord> ReadBlocks() => ReadBlocksRange(1, 9007199254740991);

    public IReadOnlyList<ArchiveBlockRecord> ReadBlocksRange(long first, long last)
    {
        if (first <= 0 || last < first || last > 9007199254740991L) throw new ArgumentOutOfRangeException(nameof(first));
        if (!File.Exists(databasePath)) return [];
        using var connection = OpenExistingReadOnly();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT agent,id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,created_at FROM archive_blocks WHERE session_id=$s AND id BETWEEN $first AND $last ORDER BY id";
        command.Parameters.AddWithValue("$s", sessionId);
        command.Parameters.AddWithValue("$first", first); command.Parameters.AddWithValue("$last", last);
        using var reader = command.ExecuteReader();
        var blocks = new List<ArchiveBlockRecord>();
        while (reader.Read())
        {
            var block = new ArchiveBlockRecord(sessionId, reader.GetString(0), reader.GetInt64(1), reader.GetInt32(2),
                reader.GetString(3), reader.GetInt64(4), reader.GetInt64(5),
                NullableText(reader, 6) is string ids ? JsonNode.Parse(ids) as JsonArray : null,
                reader.GetInt64(7), reader.GetInt64(8), NullableNumber(reader, 9), NullableNumber(reader, 10),
                reader.GetString(11), NullableText(reader, 12) is string facts ? JsonNode.Parse(facts) as JsonArray : null,
                reader.GetInt64(13));
            ValidateBlock(block);
            blocks.Add(block);
        }
        return blocks;
    }

    public void RollbackInsertedBlocks(IReadOnlyList<ArchiveBlockRecord> blocks)
    {
        if (blocks.Count == 0) return;
        using var connection = OpenConfigured();
        using var tx = connection.BeginTransaction(deferred: false);
        foreach (var block in blocks)
        {
            ValidateBlock(block);
            using var command = connection.CreateCommand();
            command.Transaction = tx;
            command.CommandText = """
                DELETE FROM archive_blocks WHERE session_id=$s AND id=$id AND agent=$agent AND level=$level
                AND source_kind=$kind AND source_start=$first AND source_end=$last AND source_block_ids_json IS $ids
                AND raw_start_seq=$rawFirst AND raw_end_seq=$rawLast AND raw_start_timestamp IS $start
                AND raw_end_timestamp IS $end AND summary=$summary AND memory_facts_json IS $facts AND created_at=$at
                """;
            command.Parameters.AddWithValue("$s", sessionId);
            command.Parameters.AddWithValue("$id", block.Id);
            command.Parameters.AddWithValue("$agent", block.Agent);
            command.Parameters.AddWithValue("$level", block.Level);
            command.Parameters.AddWithValue("$kind", block.SourceKind);
            command.Parameters.AddWithValue("$first", block.SourceStart);
            command.Parameters.AddWithValue("$last", block.SourceEnd);
            command.Parameters.AddWithValue("$ids", (object?)block.SourceBlockIdsJson ?? DBNull.Value);
            command.Parameters.AddWithValue("$rawFirst", block.RawStartSeq);
            command.Parameters.AddWithValue("$rawLast", block.RawEndSeq);
            command.Parameters.AddWithValue("$start", (object?)block.RawStartTimestamp ?? DBNull.Value);
            command.Parameters.AddWithValue("$end", (object?)block.RawEndTimestamp ?? DBNull.Value);
            command.Parameters.AddWithValue("$summary", block.Summary);
            command.Parameters.AddWithValue("$facts", (object?)block.MemoryFactsJson ?? DBNull.Value);
            command.Parameters.AddWithValue("$at", block.CreatedAt);
            if (command.ExecuteNonQuery() != 1) throw new IOException($"Archive block rollback conflict for {sessionId} B#{block.Id}.");
        }
        tx.Commit();
    }

    private static string? NullableText(SqliteDataReader reader, int column) => reader.IsDBNull(column) ? null : reader.GetString(column);
    private static double? NullableNumber(SqliteDataReader reader, int column) => reader.IsDBNull(column) ? null : reader.GetDouble(column);
}
