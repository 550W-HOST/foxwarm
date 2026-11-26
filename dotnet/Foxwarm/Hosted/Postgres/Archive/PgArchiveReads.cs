using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Npgsql;

namespace Foxwarm.Hosted.Postgres.Archive;

/// <summary>Row reads of one canonical identity inside a read transaction.</summary>
internal static class PgArchiveReads
{
    internal const long MaxSeq = 9007199254740991L;

    private const string MessageColumns = "agent, seq, timestamp, role, message_json";

    private const string BlockColumns =
        "agent, id, level, source_kind, source_start, source_end, source_block_ids_json, raw_start_seq, raw_end_seq,"
        + " raw_start_timestamp, raw_end_timestamp, summary, memory_facts_json, created_at, friction_score";

    internal static NpgsqlParameter Number(double? value) => new NpgsqlParameter<double?> { TypedValue = value };

    internal static NpgsqlParameter Number(long? value) => new NpgsqlParameter<long?> { TypedValue = value };

    internal static List<ArchiveMessageRecord> Messages(
        PgTx tx,
        string canonical,
        string where,
        string order,
        params object?[] parameters
    )
    {
        using var command = tx.Command(
            $"SELECT {MessageColumns} FROM archive_messages WHERE session_id = $1{where} ORDER BY {order}",
            [canonical, .. parameters]
        );
        using var reader = command.ExecuteReader();
        var records = new List<ArchiveMessageRecord>();
        while (reader.Read())
            records.Add(
                ArchiveMessageRecord.FromStored(
                    canonical,
                    reader.GetString(0),
                    reader.GetInt64(1),
                    reader.GetDouble(2),
                    reader.GetString(3),
                    reader.GetString(4)
                )
            );
        return records;
    }

    /// <summary>Own messages in a numeric range, as the file store's numeric reader selects them.</summary>
    internal static List<ArchiveMessageRecord> MessagesNumeric(
        PgTx tx,
        string canonical,
        double? first,
        double? last,
        int? limit = null,
        bool descending = false,
        bool substantiveWindow = false,
        long? startTime = null,
        long? endTime = null
    ) =>
        Messages(
            tx,
            canonical,
            " AND ($2::float8 IS NULL OR seq >= $2) AND ($3::float8 IS NULL OR seq <= $3)"
                + (substantiveWindow ? " AND role IN ('user', 'model') AND coalesce(model_visible, true)" : "")
                + " AND ($4::bigint IS NULL OR timestamp >= $4) AND ($5::bigint IS NULL OR timestamp < $5)",
            "seq " + (descending ? "DESC" : "ASC") + (limit is int bound ? " LIMIT " + bound.ToString(System.Globalization.CultureInfo.InvariantCulture) : ""),
            Number(first),
            Number(last),
            Number(startTime),
            Number(endTime)
        );

    internal static List<ArchiveBlockRecord> Blocks(
        PgTx tx,
        string canonical,
        string where,
        string order,
        params object?[] parameters
    )
    {
        using var command = tx.Command(
            $"SELECT {BlockColumns} FROM archive_blocks b WHERE session_id = $1{where} ORDER BY {order}",
            [canonical, .. parameters]
        );
        using var reader = command.ExecuteReader();
        var blocks = new List<ArchiveBlockRecord>();
        while (reader.Read())
        {
            var block = new ArchiveBlockRecord(
                canonical,
                reader.GetString(0),
                reader.GetInt64(1),
                reader.GetInt32(2),
                reader.GetString(3),
                reader.GetInt64(4),
                reader.GetInt64(5),
                Text(reader, 6) is string ids
                    ? JsonNode.Parse(ids) as JsonArray
                        ?? throw new InvalidDataException("Archive source block ids must be an array.")
                    : null,
                reader.GetInt64(7),
                reader.GetInt64(8),
                reader.IsDBNull(9) ? null : reader.GetDouble(9),
                reader.IsDBNull(10) ? null : reader.GetDouble(10),
                reader.GetString(11),
                Text(reader, 12) is string facts ? JsonNode.Parse(facts) as JsonArray : null,
                reader.GetInt64(13),
                reader.IsDBNull(14) ? null : reader.GetInt32(14)
            );
            ArchiveRowAdmission.Block(block, canonical);
            blocks.Add(block);
        }
        return blocks;
    }

    internal static ArchiveStats MessageStats(PgTx tx, string canonical, long first, long last)
    {
        using var command = tx.Command(
            "SELECT count(*), min(seq), max(seq) FROM archive_messages WHERE session_id = $1 AND seq BETWEEN $2 AND $3",
            canonical,
            first,
            last
        );
        using var reader = command.ExecuteReader();
        reader.Read();
        return new(
            reader.GetInt64(0),
            reader.IsDBNull(1) ? null : reader.GetInt64(1),
            reader.IsDBNull(2) ? null : reader.GetInt64(2)
        );
    }

    internal static List<ArchiveBlockTopology> Topology(PgTx tx, string canonical)
    {
        using var command = tx.Command(
            "SELECT id, level, source_kind, source_start, source_end, source_block_ids_json, raw_start_seq, raw_end_seq,"
                + " raw_start_timestamp FROM archive_blocks WHERE session_id = $1"
                + " ORDER BY raw_start_seq, raw_end_seq, coalesce(raw_start_timestamp, 0), id",
            canonical
        );
        using var reader = command.ExecuteReader();
        var result = new List<ArchiveBlockTopology>();
        while (reader.Read())
            result.Add(
                new(
                    reader.GetInt64(0),
                    reader.GetInt32(1),
                    reader.GetString(2),
                    reader.GetInt64(3),
                    reader.GetInt64(4),
                    reader.IsDBNull(5)
                        ? []
                        : (JsonNode.Parse(reader.GetString(5)) as JsonArray)
                            ?.Select(value => value!.GetValue<long>())
                            .ToArray()
                            ?? [],
                    reader.GetInt64(6),
                    reader.GetInt64(7),
                    reader.IsDBNull(8) ? null : reader.GetDouble(8)
                )
            );
        return result;
    }

    /// <summary>The branch of a Session, resolved through the reservation graph.</summary>
    internal static ArchiveBranch? Branch(PgTx tx, string sessionId)
    {
        var canonical = PgArchiveRows.Resolve(tx, sessionId);
        using var command = tx.Command(
            "SELECT parent_session_id, fork_message_seq, fork_block_id, created_at, updated_at FROM archive_branches WHERE session_id = $1",
            canonical
        );
        using var row = command.ExecuteReader();
        if (!row.Read())
            return null;
        var branch = new ArchiveBranch(
            canonical,
            row.IsDBNull(0) ? null : row.GetString(0),
            row.GetInt64(1),
            row.GetInt64(2),
            row.GetInt64(3),
            row.GetInt64(4)
        );
        if (branch.MessageCap is < 0 or > MaxSeq || branch.BlockCap is < 0 or > MaxSeq)
            throw new InvalidDataException("Archive branch has an invalid fork frontier.");
        return branch;
    }

    /// <summary>
    /// The lineage of a Session: itself, then each parent, with the cumulative message and block
    /// caps that bound what each part contributes.
    /// </summary>
    internal static List<(string SessionId, long Messages, long Blocks)> Lineage(PgTx tx, string sessionId)
    {
        var result = new List<(string, long, long)>();
        var current = PgArchiveRows.Resolve(tx, sessionId);
        long messages = MaxSeq,
            blocks = MaxSeq;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (seen.Add(current))
        {
            result.Add((current, messages, blocks));
            var branch = Branch(tx, current);
            if (branch?.ParentSessionId is not string parent)
                break;
            messages = Math.Min(messages, branch.MessageCap);
            blocks = Math.Min(blocks, branch.BlockCap);
            current = PgArchiveRows.Resolve(tx, parent);
        }
        return result;
    }

    private static string? Text(NpgsqlDataReader reader, int column) =>
        reader.IsDBNull(column) ? null : reader.GetString(column);
}
