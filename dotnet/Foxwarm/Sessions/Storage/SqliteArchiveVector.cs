using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed record ArchiveVectorCheckpoint(
    long RawLastIndexedSeq = 0,
    long RawTailStartSeq = 0,
    long LastIndexedBlockId = 0,
    long UpdatedAt = 0
);

internal sealed record ArchiveVectorMaxima(
    string SessionId,
    string Agent,
    long MessageSeq,
    long BlockId,
    string? ParentSessionId
);

internal sealed record ArchiveVectorScope(
    string SessionId,
    long? MaxMessageSeq = null,
    long? MaxBlockId = null
);

public sealed partial class SqliteArchiveMessageStore
{
    private static void InitializeVectorCheckpoints(SqliteConnection connection) =>
        Execute(
            connection,
            """
            CREATE TABLE IF NOT EXISTS archive_checkpoints (
              session_id TEXT PRIMARY KEY,
              raw_last_indexed_seq INTEGER NOT NULL DEFAULT 0,
              raw_tail_start_seq INTEGER NOT NULL DEFAULT 0,
              last_indexed_block_id INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL
            );
            """
        );

    // Checkpoints are derived progress, deliberately keyed by the supplied identity, not a read alias.
    internal ArchiveVectorCheckpoint VectorCheckpoint()
    {
        if (!File.Exists(databasePath))
            return new();
        using var connection = OpenExistingReadOnly();
        return VectorCheckpoint(connection, null);
    }

    private ArchiveVectorCheckpoint VectorCheckpoint(
        SqliteConnection connection,
        SqliteTransaction? transaction
    )
    {
        if (!TableExists(connection, "archive_checkpoints"))
            return new();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "SELECT raw_last_indexed_seq,raw_tail_start_seq,last_indexed_block_id,updated_at FROM archive_checkpoints WHERE session_id=$s";
        command.Parameters.AddWithValue("$s", sessionId);
        using var row = command.ExecuteReader();
        return row.Read()
            ? new(row.GetInt64(0), row.GetInt64(1), row.GetInt64(2), row.GetInt64(3))
            : new();
    }

    internal ArchiveVectorCheckpoint SetVectorCheckpoint(
        long? raw = null,
        long? tail = null,
        long? block = null
    ) =>
        Write(
            (connection, transaction) =>
            {
                var current = VectorCheckpoint(connection, transaction);
                var next = new ArchiveVectorCheckpoint(
                    raw ?? current.RawLastIndexedSeq,
                    tail ?? current.RawTailStartSeq,
                    block ?? current.LastIndexedBlockId,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                );
                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = """
                    INSERT INTO archive_checkpoints(session_id,raw_last_indexed_seq,raw_tail_start_seq,last_indexed_block_id,updated_at)
                    VALUES($s,$r,$t,$b,$at) ON CONFLICT(session_id) DO UPDATE SET
                    raw_last_indexed_seq=excluded.raw_last_indexed_seq,raw_tail_start_seq=excluded.raw_tail_start_seq,
                    last_indexed_block_id=excluded.last_indexed_block_id,updated_at=excluded.updated_at
                    """;
                command.Parameters.AddWithValue("$s", sessionId);
                command.Parameters.AddWithValue("$r", next.RawLastIndexedSeq);
                command.Parameters.AddWithValue("$t", next.RawTailStartSeq);
                command.Parameters.AddWithValue("$b", next.LastIndexedBlockId);
                command.Parameters.AddWithValue("$at", next.UpdatedAt);
                command.ExecuteNonQuery();
                return next;
            }
        );

    internal IReadOnlyList<ArchiveVectorScope> VectorLineage() =>
        Lineage()
            .Select(part => new ArchiveVectorScope(
                part.Store.sessionId,
                part.Messages == 9007199254740991L ? null : part.Messages,
                part.Blocks == 9007199254740991L ? null : part.Blocks
            ))
            .ToArray();

    internal IReadOnlyList<ArchiveVectorMaxima> LocalVectorMaxima()
    {
        if (!File.Exists(databasePath))
            return [];
        using var connection = OpenExistingReadOnly();
        using var command = connection.CreateCommand();
        command.CommandText = """
            WITH message_max AS (SELECT session_id, MAX(agent) AS agent, MAX(seq) AS max_seq FROM archive_messages GROUP BY session_id),
            block_max AS (SELECT session_id, MAX(agent) AS agent, MAX(id) AS max_id FROM archive_blocks GROUP BY session_id)
            SELECT b.session_id, COALESCE(m.agent, bl.agent, 'main'),
              COALESCE(m.max_seq, 0), COALESCE(bl.max_id, 0), b.parent_session_id
            FROM archive_branches b
            LEFT JOIN message_max m ON m.session_id = b.session_id
            LEFT JOIN block_max bl ON bl.session_id = b.session_id
            ORDER BY b.session_id
            """;
        using var rows = command.ExecuteReader();
        var result = new List<ArchiveVectorMaxima>();
        while (rows.Read())
            result.Add(
                new(
                    rows.GetString(0),
                    rows.GetString(1),
                    rows.GetInt64(2),
                    rows.GetInt64(3),
                    rows.IsDBNull(4) ? null : rows.GetString(4)
                )
            );
        return result;
    }

    internal (long Count, long MinSeq, long MaxSeq, long MaxBlockId) LocalVectorStats()
    {
        if (!File.Exists(databasePath))
            return (0, 0, 0, 0);
        using var connection = OpenExistingReadOnly();
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT count(*),coalesce(min(seq),0),coalesce(max(seq),0),(SELECT coalesce(max(id),0) FROM archive_blocks WHERE session_id=$s) FROM archive_messages WHERE session_id=$s";
        command.Parameters.AddWithValue("$s", CanonicalReadIdentity());
        using var row = command.ExecuteReader();
        row.Read();
        return (row.GetInt64(0), row.GetInt64(1), row.GetInt64(2), row.GetInt64(3));
    }
}
