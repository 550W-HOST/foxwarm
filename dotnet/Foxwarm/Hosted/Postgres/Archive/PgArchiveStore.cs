using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres.Archive;

/// <summary>
/// The tenant's Archive in PostgreSQL (<see cref="IArchiveStore"/>). The tenant lease makes this
/// replica the only writer, so <see cref="AcquireWriter"/> holds nothing. The Archive always
/// exists here: where the file store answers "no Archive yet" (null readers, a null committed
/// identity), this store answers from empty tables.
/// </summary>
internal sealed partial class PgArchiveStore(TenantDb database) : IArchiveStore
{
    // Sequence spans per Session ID; see SqliteArchiveSequence.CachedSpan.
    private readonly ConcurrentDictionary<string, SqliteArchiveSequence.SpanEntry> spans = new(StringComparer.Ordinal);

    public IArchiveSession ForSession(string sessionId)
    {
        ArgumentException.ThrowIfNullOrEmpty(sessionId);
        return new PgArchiveSession(database, sessionId);
    }

    public IAsyncDisposable AcquireWriter() => NoWriter.Instance;

    public string? ResolveCommittedIdentity(string sessionId) =>
        database.Read(tx => PgArchiveRows.Resolve(tx, sessionId));

    public Task<bool> HasLifetimeRowsAsync(string sessionId) =>
        database.ReadAsync(
            async (tx, token) =>
            {
                await using var command = tx.Command(
                    "SELECT 1 WHERE EXISTS (SELECT 1 FROM archive_messages WHERE session_id = $1)"
                        + " OR EXISTS (SELECT 1 FROM archive_blocks WHERE session_id = $1)"
                        + " OR EXISTS (SELECT 1 FROM archive_branches WHERE session_id = $1)"
                        + " OR EXISTS (SELECT 1 FROM session_id_reservations WHERE session_id = $1 OR canonical_session_id = $1)",
                    sessionId
                );
                return await command.ExecuteScalarAsync(token).ConfigureAwait(false) is not null;
            }
        );

    public Dictionary<string, (long Count, long Latest)> SequenceCounts(string[] ids) =>
        database.ReadOrJoin(tx =>
        {
            var result = new Dictionary<string, (long Count, long Latest)>(StringComparer.Ordinal);
            foreach (var chunk in ids.Chunk(1000))
            {
                using var command = tx.Command(
                    "WITH requested(session_id) AS (SELECT DISTINCT unnest($1::text[]))"
                        + " SELECT r.session_id, coalesce((SELECT max(m.seq) FROM archive_messages m WHERE m.session_id = r.session_id), 0),"
                        + " b.parent_session_id, b.fork_message_seq"
                        + " FROM requested r LEFT JOIN archive_branches b ON b.session_id = r.session_id",
                    new object?[] { chunk }
                );
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
        });

    public void RenameIdentity(string fromId, string toId)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        database.Write(
            tx =>
            {
                tx.Execute("UPDATE archive_messages SET session_id = $2 WHERE session_id = $1", fromId, toId);
                tx.Execute("UPDATE archive_blocks SET session_id = $2 WHERE session_id = $1", fromId, toId);
                tx.Execute(
                    "UPDATE archive_branches SET session_id = $2, updated_at = $3 WHERE session_id = $1",
                    fromId,
                    toId,
                    now
                );
                tx.Execute("UPDATE archive_branches SET parent_session_id = $2 WHERE parent_session_id = $1", fromId, toId);
                RenameDirectEffects(tx, fromId, toId);
                // Reservation edges are independent committed identity authority, not audit ownership.
                return true;
            },
            new PgWriteOptions(Verify: tx =>
                tx.Scalar(
                    "SELECT 1 WHERE EXISTS (SELECT 1 FROM archive_messages WHERE session_id = $1)"
                        + " OR EXISTS (SELECT 1 FROM archive_blocks WHERE session_id = $1)"
                        + " OR EXISTS (SELECT 1 FROM archive_branches WHERE session_id = $1 OR parent_session_id = $1)",
                    fromId
                )
                    is null
            )
        );
    }

    static partial void RenameDirectEffects(PgTx tx, string fromId, string toId);

    public IArchiveIdentityReader? OpenIdentityReader() => new IdentityReader(database);

    public IArchiveSequenceReader? OpenSequenceReader() => new SequenceReader(database, spans);

    private sealed class NoWriter : IAsyncDisposable
    {
        internal static readonly NoWriter Instance = new();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class IdentityReader(TenantDb database) : IArchiveIdentityReader
    {
        public string Resolve(string sessionId) => database.Read(tx => PgArchiveRows.Resolve(tx, sessionId));

        public (long? Start, string? Agent)? FirstMessage(string canonicalSessionId) =>
            database.Read<(long? Start, string? Agent)?>(tx =>
            {
                using var command = tx.Command(
                    "SELECT timestamp, agent FROM archive_messages WHERE session_id = $1 ORDER BY seq LIMIT 1",
                    canonicalSessionId
                );
                using var reader = command.ExecuteReader();
                if (!reader.Read())
                    return null;
                return (
                    (long?)Math.Floor(reader.GetDouble(0)),
                    reader.GetString(1).Length == 0 ? null : reader.GetString(1)
                );
            });

        public void Dispose() { }
    }

    private sealed class SequenceReader(
        TenantDb database,
        ConcurrentDictionary<string, SqliteArchiveSequence.SpanEntry> spans
    ) : IArchiveSequenceReader
    {
        private const string Select = "SELECT seq, timestamp, role, sequence_data FROM archive_messages";

        public ArchiveSpan? Span(SessionCatalog.SequenceSession session) =>
            database.Read(tx =>
                SqliteArchiveSequence.CachedSpan(
                    spans,
                    session.Id,
                    session,
                    () => PgArchiveRows.Resolve(tx, session.Id),
                    (canonical, last) => Edge(tx, canonical, last)
                )
            );

        private static (long Seq, double Timestamp)? Edge(PgTx tx, string canonical, bool last)
        {
            using var command = tx.Command(
                "SELECT seq, timestamp FROM archive_messages WHERE session_id = $1 ORDER BY seq "
                    + (last ? "DESC" : "ASC")
                    + " LIMIT 1",
                canonical
            );
            using var reader = command.ExecuteReader();
            return reader.Read() ? (reader.GetInt64(0), reader.GetDouble(1)) : null;
        }

        private static long WindowStart(PgTx tx, string canonical, double since, long min, long max)
        {
            using var probe = tx.Command(
                "SELECT seq, timestamp FROM archive_messages WHERE session_id = $1 AND seq >= $2 ORDER BY seq LIMIT 1",
                canonical,
                0L
            );
            return SqliteArchiveSequence.WindowStart(
                position =>
                {
                    probe.Parameters[1].Value = position;
                    using var reader = probe.ExecuteReader();
                    return reader.Read() ? (reader.GetInt64(0), reader.GetDouble(1)) : null;
                },
                since,
                min,
                max
            );
        }

        public long SeqBefore(string sessionId, ArchiveSpan span, ArchiveSequenceCursor? cursor) =>
            database.Read(
                tx =>
                    SqliteArchiveSequence.SeqBefore(
                        sessionId,
                        span,
                        cursor,
                        since => WindowStart(tx, span.Canonical, since, span.FirstSeq, span.LastSeq)
                    ),
                snapshot: true
            );

        public List<(long Seq, double Timestamp)> Positions(ArchiveSpan span, long high, int count) =>
            database.Read(tx =>
            {
                using var command = tx.Command(
                    "SELECT seq, timestamp FROM archive_messages WHERE session_id = $1 AND seq <= $2 ORDER BY seq DESC LIMIT $3",
                    span.Canonical,
                    high,
                    (long)count
                );
                using var reader = command.ExecuteReader();
                var rows = new List<(long, double)>(count);
                while (reader.Read())
                    rows.Add((reader.GetInt64(0), reader.GetDouble(1)));
                return rows;
            });

        public ArchiveSequencePage ReadRange(string sessionId, ArchiveSpan span, long low, long high) =>
            database.Read(
                tx =>
                {
                    var rows = Rows(
                        tx,
                        Select + " WHERE session_id = $1 AND seq >= $2 AND seq <= $3 ORDER BY seq ASC",
                        span.Canonical,
                        low,
                        high
                    );
                    return new ArchiveSequencePage(sessionId, rows, span.LastSeq, false, false, Context(tx, span.Canonical, rows));
                },
                snapshot: true
            );

        public ArchiveSequencePage ReadAfter(
            string sessionId,
            ArchiveSpan span,
            long? afterSeq,
            double since,
            int limit
        ) =>
            database.Read(
                tx =>
                {
                    var start = afterSeq is long cursor
                        ? cursor + 1
                        : WindowStart(tx, span.Canonical, since, span.FirstSeq, span.LastSeq);
                    if (start > span.LastSeq)
                        return new ArchiveSequencePage(sessionId, [], span.LastSeq, false, false);
                    var rows = Rows(
                        tx,
                        Select + " WHERE session_id = $1 AND seq >= $2 ORDER BY seq ASC LIMIT $3",
                        span.Canonical,
                        start,
                        (long)limit + 1
                    );
                    var overflow = rows.Count > limit;
                    if (overflow)
                        rows.RemoveAt(rows.Count - 1);
                    return new ArchiveSequencePage(sessionId, rows, span.LastSeq, false, overflow, Context(tx, span.Canonical, rows));
                },
                snapshot: true
            );

        private static List<ArchiveSequenceRow> Rows(PgTx tx, string sql, params object?[] parameters)
        {
            using var command = tx.Command(sql, parameters);
            using var reader = command.ExecuteReader();
            var rows = new List<ArchiveSequenceRow>();
            while (reader.Read())
                rows.Add(
                    new(
                        reader.GetInt64(0),
                        reader.GetDouble(1),
                        reader.GetString(2),
                        JsonNode.Parse(reader.GetString(3)) as JsonObject ?? new JsonObject()
                    )
                );
            return rows;
        }

        // A leading tool row needs its calling model message to recover call positions.
        private static ArchiveSequenceRow? Context(PgTx tx, string canonical, IReadOnlyList<ArchiveSequenceRow> rows)
        {
            if (rows.Count == 0 || rows[0].Role != "tool")
                return null;
            var found = Rows(
                tx,
                Select + " WHERE session_id = $1 AND seq < $2 AND role = 'model' ORDER BY seq DESC LIMIT 1",
                canonical,
                rows[0].Seq
            );
            return found.Count > 0 ? found[0] : null;
        }

        public void Dispose() { }
    }
}
