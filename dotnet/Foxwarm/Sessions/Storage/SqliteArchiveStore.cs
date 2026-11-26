using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>File-mode Archive: <c>state/archive-store.sqlite</c> under the data root.</summary>
internal sealed class SqliteArchiveStore(string dataRoot) : IArchiveStore
{
    internal string DatabasePath { get; } =
        Path.Combine(Path.GetFullPath(dataRoot), "state", "archive-store.sqlite");

    public IArchiveSession ForSession(string sessionId) =>
        new SqliteArchiveMessageStore(DatabasePath, sessionId);

    public IAsyncDisposable AcquireWriter() => SqliteArchiveMessageStore.AcquireWriter(DatabasePath);

    public string? ResolveCommittedIdentity(string sessionId)
    {
        if (!File.Exists(DatabasePath))
            return null;
        using var db = OpenReadOnly();
        return SqliteArchiveMessageStore.ResolveReadOnly(db, sessionId);
    }

    public async Task<bool> HasLifetimeRowsAsync(string id)
    {
        var archive = DatabasePath;
        if (!File.Exists(archive))
            return false;
        await using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = archive,
                Mode = SqliteOpenMode.ReadOnly,
                // A pool's prune timer would capture this caller's async context.
                Pooling = false,
            }.ToString()
        );
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_branches'";
        var hasBranches = await command.ExecuteScalarAsync() is not null;
        var hasReservations = SqliteArchiveMessageStore.HasReservationTable(connection);
        command.CommandText =
            "SELECT 1 FROM archive_messages WHERE session_id=$id UNION SELECT 1 FROM archive_blocks WHERE session_id=$id"
            + (hasBranches ? " UNION SELECT 1 FROM archive_branches WHERE session_id=$id" : "")
            + (
                hasReservations
                    ? " UNION SELECT 1 FROM archive_session_id_reservations WHERE session_id=$id OR canonical_session_id=$id"
                    : ""
            )
            + " LIMIT 1";
        command.Parameters.AddWithValue("$id", id);
        return await command.ExecuteScalarAsync() is not null;
    }

    // Count is the Session's own messages (a fork's after its fork point); Latest is the seq of
    // its newest message, inherited history included.
    public Dictionary<string, (long Count, long Latest)> SequenceCounts(string[] ids)
    {
        var result = new Dictionary<string, (long Count, long Latest)>(StringComparer.Ordinal);
        var file = DatabasePath;
        if (!File.Exists(file))
            return result;
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = file,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        foreach (var chunk in ids.Chunk(200))
        {
            using var command = connection.CreateCommand();
            var parameters = Enumerable
                .Range(0, chunk.Length)
                .Select(index => "$id" + index)
                .ToArray();
            for (var index = 0; index < chunk.Length; index++)
                command.Parameters.AddWithValue(parameters[index], chunk[index]);
            command.CommandText = $"""
WITH requested(session_id) AS (VALUES {string.Join(
                    ',',
                    parameters.Select(parameter => "(" + parameter + ")")
                )}),
local_max AS (SELECT messages.session_id,MAX(messages.seq) max_seq FROM archive_messages messages INNER JOIN requested ON requested.session_id=messages.session_id GROUP BY messages.session_id)
SELECT requested.session_id,COALESCE(local_max.max_seq,0),branches.parent_session_id,branches.fork_message_seq
FROM requested LEFT JOIN local_max ON local_max.session_id=requested.session_id LEFT JOIN archive_branches branches ON branches.session_id=requested.session_id
""";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                result[reader.GetString(0)] = reader.IsDBNull(2)
                    ? (reader.GetInt64(1), reader.GetInt64(1))
                    : (
                        Math.Max(0, reader.GetInt64(1) - reader.GetInt64(3)),
                        Math.Max(reader.GetInt64(1), reader.GetInt64(3))
                    );
        }
        return result;
    }

    public void RenameIdentity(string fromId, string toId) =>
        SqliteArchiveIdentityMove.Rename(DatabasePath, fromId, toId);

    public IArchiveIdentityReader? OpenIdentityReader() =>
        File.Exists(DatabasePath) ? new IdentityReader(OpenReadOnly()) : null;

    public IArchiveSequenceReader? OpenSequenceReader() =>
        SqliteArchiveSequence.Open(DatabasePath) is { } connection
            ? new SequenceReader(connection, DatabasePath)
            : null;

    public async Task RecordDirectEffectAsync(ToolEffectRow row, CancellationToken token = default)
    {
        var receipt = await SqliteArchiveMessageStore
            .EnqueueWriteAsync(
                DatabasePath,
                (connection, transaction) =>
                {
                    ArchiveToolEffects.InitializeSchema(connection, transaction);
                    ArchiveToolEffects.InsertDirect(connection, transaction, row);
                    return true;
                },
                token
            )
            .ConfigureAwait(false);
        await receipt.Completion.ConfigureAwait(false);
    }

    private SqliteConnection OpenReadOnly()
    {
        var db = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = DatabasePath,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        db.Open();
        return db;
    }

    private sealed class IdentityReader(SqliteConnection connection) : IArchiveIdentityReader
    {
        public string Resolve(string sessionId) =>
            SqliteArchiveMessageStore.ResolveReadOnly(connection, sessionId);

        public (long? Start, string? Agent)? FirstMessage(string canonical)
        {
            using var command = connection.CreateCommand();
            command.CommandText =
                "SELECT timestamp,agent FROM archive_messages WHERE session_id=$id ORDER BY seq LIMIT 1";
            command.Parameters.AddWithValue("$id", canonical);
            using var reader = command.ExecuteReader();
            if (!reader.Read())
                return null;
            var found = (
                (long?)Math.Floor(reader.GetDouble(0)),
                reader.IsDBNull(1) || reader.GetString(1).Length == 0 ? null : reader.GetString(1)
            );
            return found;
        }

        public void Dispose() => connection.Dispose();
    }

    private sealed class SequenceReader(SqliteConnection connection, string databasePath)
        : IArchiveSequenceReader
    {
        public ArchiveSpan? Span(SessionCatalog.SequenceSession session) =>
            SqliteArchiveSequence.Span(connection, databasePath, session);

        public long SeqBefore(string sessionId, ArchiveSpan span, ArchiveSequenceCursor? cursor) =>
            SqliteArchiveSequence.SeqBefore(connection, sessionId, span, cursor);

        public List<(long Seq, double Timestamp)> Positions(ArchiveSpan span, long high, int count) =>
            SqliteArchiveSequence.Positions(connection, span, high, count);

        public ArchiveSequencePage ReadRange(
            string sessionId,
            ArchiveSpan span,
            long low,
            long high
        ) => SqliteArchiveSequence.ReadRange(connection, sessionId, span, low, high);

        public ArchiveSequencePage ReadAfter(
            string sessionId,
            ArchiveSpan span,
            long? afterSeq,
            double since,
            int limit
        ) => SqliteArchiveSequence.ReadAfter(connection, sessionId, span, afterSeq, since, limit);

        public void Dispose() => connection.Dispose();
    }
}
