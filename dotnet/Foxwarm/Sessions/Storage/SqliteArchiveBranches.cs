using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed record ArchiveBranch(
    string SessionId,
    string? ParentSessionId,
    long MessageCap,
    long BlockCap,
    long CreatedAt,
    long UpdatedAt
);

public sealed partial class SqliteArchiveMessageStore
{
    private static void InitializeBranches(SqliteConnection connection)
    {
        Execute(
            connection,
            """
            CREATE TABLE IF NOT EXISTS archive_branches (
              session_id TEXT PRIMARY KEY,
              parent_session_id TEXT,
              fork_message_seq INTEGER NOT NULL DEFAULT 0,
              fork_block_id INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_archive_branches_parent ON archive_branches(parent_session_id);
            """
        );
        using var schema = connection.CreateCommand();
        schema.CommandText = "PRAGMA table_info(archive_branches)";
        using var rows = schema.ExecuteReader();
        var actual = new List<(string, string, bool, string?, long)>();
        while (rows.Read())
            actual.Add(
                (
                    rows.GetString(1),
                    rows.GetString(2),
                    rows.GetInt64(3) == 1,
                    rows.IsDBNull(4) ? null : rows.GetString(4),
                    rows.GetInt64(5)
                )
            );
        var expected = new[]
        {
            ("session_id", "TEXT", false, (string?)null, 1L),
            ("parent_session_id", "TEXT", false, (string?)null, 0L),
            ("fork_message_seq", "INTEGER", true, (string?)"0", 0L),
            ("fork_block_id", "INTEGER", true, (string?)"0", 0L),
            ("created_at", "INTEGER", true, (string?)null, 0L),
            ("updated_at", "INTEGER", true, (string?)null, 0L),
        };
        if (!actual.SequenceEqual(expected))
            throw new InvalidDataException(
                "archive_branches schema does not match the source branch schema."
            );
    }

    internal ArchiveBranch? ReadBranch()
    {
        if (!File.Exists(databasePath))
            return null;
        using var connection = OpenExistingReadOnly();
        return ReadBranch(connection, null);
    }

    private ArchiveBranch? ReadBranch(SqliteConnection connection, SqliteTransaction? transaction)
    {
        var canonical = ResolveReadOnly(connection, sessionId);
        if (!TableExists(connection, "archive_branches"))
            return null;
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "SELECT parent_session_id,fork_message_seq,fork_block_id,created_at,updated_at FROM archive_branches WHERE session_id=$s";
        command.Parameters.AddWithValue("$s", canonical);
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
        if (
            branch.MessageCap < 0
            || branch.BlockCap < 0
            || branch.MessageCap > 9007199254740991
            || branch.BlockCap > 9007199254740991
        )
            throw new InvalidDataException("Archive branch has an invalid fork frontier.");
        return branch;
    }

    // Returns only a newly inserted row, for compensation owned by this creation.
    internal ArchiveBranch? EnsureBranch(
        string? parent = null,
        long messageCap = 0,
        long blockCap = 0
    )
    {
        return Write(
            (connection, transaction) =>
            {
                RequireWriteIdentity(connection, sessionId);
                var existing = ReadBranch(connection, transaction);
                if (existing is not null)
                {
                    if (
                        existing.ParentSessionId != parent
                        || existing.MessageCap != messageCap
                        || existing.BlockCap != blockCap
                    )
                        throw new InvalidDataException("Archive branch lineage is immutable.");
                    return (ArchiveBranch?)null;
                }
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText =
                    "INSERT INTO archive_branches(session_id,parent_session_id,fork_message_seq,fork_block_id,created_at,updated_at) VALUES($s,$p,$m,$b,$at,$at)";
                command.Parameters.AddWithValue("$s", sessionId);
                command.Parameters.AddWithValue("$p", (object?)parent ?? DBNull.Value);
                command.Parameters.AddWithValue("$m", messageCap);
                command.Parameters.AddWithValue("$b", blockCap);
                command.Parameters.AddWithValue("$at", now);
                command.ExecuteNonQuery();
                return new ArchiveBranch(sessionId, parent, messageCap, blockCap, now, now);
            }
        );
    }

    internal void RollbackInsertedBranch(ArchiveBranch? branch)
    {
        if (branch is null)
            return;
        Write(
            (connection, transaction) =>
            {
                RequireWriteIdentity(connection, sessionId);
                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText =
                    "DELETE FROM archive_branches WHERE session_id=$s AND parent_session_id IS $p AND fork_message_seq=$m AND fork_block_id=$b AND created_at=$at AND updated_at=$updated";
                command.Parameters.AddWithValue("$s", branch.SessionId);
                command.Parameters.AddWithValue(
                    "$p",
                    (object?)branch.ParentSessionId ?? DBNull.Value
                );
                command.Parameters.AddWithValue("$m", branch.MessageCap);
                command.Parameters.AddWithValue("$b", branch.BlockCap);
                command.Parameters.AddWithValue("$at", branch.CreatedAt);
                command.Parameters.AddWithValue("$updated", branch.UpdatedAt);
                if (command.ExecuteNonQuery() != 1)
                    throw new IOException("Owned Archive branch rollback conflict.");
                return true;
            }
        );
    }

    private IEnumerable<(SqliteArchiveMessageStore Store, long Messages, long Blocks)> Lineage()
    {
        var current = new SqliteArchiveMessageStore(databasePath, CanonicalReadIdentity());
        var messages = 9007199254740991L;
        var blocks = messages;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (seen.Add(current.sessionId))
        {
            yield return (current, messages, blocks);
            var branch = current.ReadBranch();
            if (branch?.ParentSessionId is not string parent)
                yield break;
            messages = Math.Min(messages, branch.MessageCap);
            blocks = Math.Min(blocks, branch.BlockCap);
            current = new SqliteArchiveMessageStore(databasePath, parent);
            current = new SqliteArchiveMessageStore(databasePath, current.CanonicalReadIdentity());
        }
    }

    internal IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesRange(
        long first,
        long last
    ) =>
        Lineage()
            .Where(part => part.Messages >= first)
            .SelectMany(part => part.Store.ReadMessagesRange(first, Math.Min(last, part.Messages)))
            .OrderBy(row => row.Seq)
            .ThenBy(row => row.Timestamp)
            .ToArray();

    internal IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesNumericRange(
        double? first,
        double? last
    ) =>
        Lineage()
            .SelectMany(part =>
                part.Store.ReadMessagesNumericRange(first, MinCap(last, part.Messages))
            )
            .OrderBy(row => row.Seq)
            .ThenBy(row => row.Timestamp)
            .ToArray();

    internal IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesPage(
        double? first,
        double? last,
        int limit,
        bool descending = false
    )
    {
        if (limit <= 0 || limit > 100)
            throw new ArgumentOutOfRangeException(nameof(limit));
        var rows = Lineage()
            .SelectMany(part =>
                part.Store.ReadMessagesNumericRange(
                    first,
                    MinCap(last, part.Messages),
                    limit,
                    descending
                )
            )
            .OrderBy(
                row => row.Seq,
                descending ? Comparer<long>.Create((a, b) => b.CompareTo(a)) : null
            )
            .ThenBy(row => row.Timestamp)
            .Take(limit)
            .ToArray();
        return rows;
    }

    internal IReadOnlyList<ArchiveBlockRecord> ReadEffectiveBlocksRange(long first, long last) =>
        Lineage()
            .Where(part => part.Blocks >= first)
            .SelectMany(part => part.Store.ReadBlocksRange(first, Math.Min(last, part.Blocks)))
            .OrderBy(row => row.Id)
            .ThenBy(row => row.CreatedAt)
            .ToArray();

    internal IReadOnlyList<ArchiveBlockRecord> ReadEffectiveBlocksNumericRange(
        double? first,
        double? last
    ) =>
        Lineage()
            .SelectMany(part => part.Store.ReadBlocksNumericRange(first, MinCap(last, part.Blocks)))
            .OrderBy(row => row.Id)
            .ThenBy(row => row.CreatedAt)
            .ToArray();

    private static double? MinCap(double? requested, long cap) =>
        requested is null ? cap : Math.Min(requested.Value, cap);

    internal ArchiveStats EffectiveMessageStats(long first = 1, long last = 9007199254740991)
    {
        var parts = Lineage()
            .Where(part => part.Messages >= first)
            .Select(part => part.Store.MessageStats(first, Math.Min(last, part.Messages)))
            .ToArray();
        var populated = parts.Where(part => part.Count > 0).ToArray();
        return new(
            parts.Sum(part => part.Count),
            populated.Length == 0 ? null : populated.Min(part => part.First),
            populated.Length == 0 ? null : populated.Max(part => part.Last)
        );
    }

    internal IReadOnlyList<ArchiveBlockTopology> EffectiveBlockTopology() =>
        Lineage()
            .SelectMany(part =>
                part.Store.BlockTopology()
                    .Where(row => row.Id <= part.Blocks)
                    .Select(row => row with { SourceSessionId = part.Store.sessionId })
            )
            .OrderBy(row => row.RawFirst)
            .ThenBy(row => row.RawLast)
            .ThenBy(row => row.StartTime ?? 0)
            .ThenBy(row => row.Id)
            .ToArray();

    internal long EffectiveBlockHighWater() =>
        Lineage()
            .Max(part =>
            {
                if (!File.Exists(databasePath) || part.Blocks == 0)
                    return 0L;
                using var connection = part.Store.OpenExistingReadOnly();
                using var command = connection.CreateCommand();
                command.CommandText =
                    "SELECT COALESCE(MAX(id),0) FROM archive_blocks WHERE session_id=$s AND id<=$cap";
                command.Parameters.AddWithValue("$s", part.Store.sessionId);
                command.Parameters.AddWithValue("$cap", part.Blocks);
                return Convert.ToInt64(
                    command.ExecuteScalar(),
                    System.Globalization.CultureInfo.InvariantCulture
                );
            });
}
